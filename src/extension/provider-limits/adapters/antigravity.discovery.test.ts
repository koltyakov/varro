import { createServer } from 'http';
import type { RequestListener, Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ChildProcessModule from 'child_process';
import type { ProviderMetadata } from '../../util/provider-limit';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, default: { ...actual, execFile }, execFile };
});

const { createAntigravityAdapter } = await import('./antigravity');

const adapter = createAntigravityAdapter();
const provider: ProviderMetadata = { id: 'antigravity', models: {} };

const QUOTA_PAYLOAD = {
  userStatus: {
    cascadeModelConfigData: {
      clientModelConfigs: [
        {
          label: 'Claude Sonnet (thinking)',
          modelOrAlias: { model: 'claude-4-5-sonnet' },
          quotaInfo: { remainingFraction: 0.5, resetTime: '2026-05-02T12:00:00.000Z' },
        },
      ],
    },
  },
};

const originalPlatform = process.platform;
const servers: Server[] = [];

/** Stdout for a mocked `command args...` invocation, keyed by the command name. */
type CommandOutput = { ps?: string; lsof?: string | Error };

function mockCommands({ ps, lsof }: CommandOutput) {
  execFile.mockImplementation(
    (
      command: string,
      _args: string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      if (command === 'ps') {
        if (ps === undefined) callback(new Error('ps unavailable'), '', '');
        else callback(null, ps, '');
        return;
      }
      if (command === 'lsof') {
        if (lsof === undefined) callback(new Error('lsof unavailable'), '', '');
        else if (lsof instanceof Error) callback(lsof, '', '');
        else callback(null, lsof, '');
        return;
      }
      callback(new Error(`unexpected command: ${command}`), '', '');
    }
  );
}

async function startLanguageServer(handler?: RequestListener) {
  const seen: Array<{ url: string; csrf: string | undefined }> = [];
  const server = createServer((request, response) => {
    seen.push({
      url: request.url ?? '',
      csrf: request.headers['x-codeium-csrf-token'] as string | undefined,
    });
    if (handler) {
      handler(request, response);
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(QUOTA_PAYLOAD));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  return { port: typeof address === 'object' && address ? address.port : 0, seen };
}

function psLine(pid: number, commandLine: string) {
  return `  ${pid} ${commandLine}`;
}

function lsofOutput(port: number) {
  return [
    'COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
    `language_ 900  user   21u  IPv4 0x1234      0t0  TCP 127.0.0.1:${port} (LISTEN)`,
  ].join('\n');
}

function fetchLimits(modelID: string | null = 'claude-4-5-sonnet') {
  return adapter.fetch({ provider, authStore: {}, modelID, checkedAt: 1_000 });
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.stubEnv('ANTIGRAVITY_BASE_URL', '');
  vi.stubEnv('ANTIGRAVITY_CSRF_TOKEN', '');
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  vi.unstubAllEnvs();
  execFile.mockReset();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe('antigravity language-server discovery', () => {
  it('probes the --extension_server_port ahead of any port lsof reports', async () => {
    const { port, seen } = await startLanguageServer();
    const decoy = await startLanguageServer((_request, response) => {
      response.statusCode = 500;
      response.end();
    });
    mockCommands({
      ps: psLine(
        4242,
        `/Applications/Antigravity.app/Contents/language_server_macos --csrf_token=csrf-abc --extension_server_port=${port}`
      ),
      lsof: lsofOutput(decoy.port),
    });

    const status = await fetchLimits();

    expect(status).toMatchObject({ status: 'available', providerID: 'antigravity' });
    expect(seen.map((entry) => entry.csrf)).toEqual(['csrf-abc', 'csrf-abc']);
    expect(seen[0]!.url).toContain('GetUnleashData');
    expect(seen[1]!.url).toContain('GetUserStatus');
    expect(decoy.seen).toEqual([]);
    // The advertised port wins, but `lsof` is still spawned to build the candidate list.
    expect(execFile.mock.calls.map((call) => call[0])).toEqual(['ps', 'lsof']);
  });

  it('does not probe the same port twice when lsof repeats the advertised port', async () => {
    const { port, seen } = await startLanguageServer();
    mockCommands({
      ps: psLine(900, `/opt/antigravity/language_server --extension_server_port=${port}`),
      lsof: [lsofOutput(port), lsofOutput(port)].join('\n'),
    });

    await expect(fetchLimits()).resolves.toMatchObject({ status: 'available' });
    expect(seen.filter((entry) => entry.url.includes('GetUnleashData'))).toHaveLength(1);
  });

  it('falls back to lsof when the command line has no extension_server_port', async () => {
    const { port } = await startLanguageServer();
    mockCommands({
      ps: psLine(900, '/opt/antigravity/language-server --csrf_token=csrf-xyz'),
      lsof: lsofOutput(port),
    });

    await expect(fetchLimits()).resolves.toMatchObject({ status: 'available' });
    expect(execFile.mock.calls.map((call) => call[0])).toEqual(['ps', 'lsof']);
  });

  it('reads a csrf token given as a separate quoted argument', async () => {
    const { port, seen } = await startLanguageServer();
    mockCommands({
      ps: psLine(
        900,
        `/opt/antigravity/language_server --csrf_token "csrf spaced" --extension_server_port ${port}`
      ),
    });

    await expect(fetchLimits()).resolves.toMatchObject({ status: 'available' });
    expect(seen[0]!.csrf).toBe('csrf spaced');
  });

  it('prefers the real language server over other antigravity processes', async () => {
    const { port, seen } = await startLanguageServer();
    const decoy = await startLanguageServer((_request, response) => {
      response.statusCode = 500;
      response.end();
    });

    mockCommands({
      ps: [
        psLine(
          100,
          `/Applications/Antigravity.app/Contents/MacOS/antigravity --lsp --csrf_token=decoy-token`
        ),
        psLine(
          200,
          `/Applications/Antigravity.app/Contents/language_server_macos --csrf_token=real-token --extension_server_port=${port}`
        ),
        psLine(300, `/Applications/Antigravity.app/Contents/MacOS/antigravity --lsp`),
      ].join('\n'),
      lsof: lsofOutput(decoy.port),
    });

    await expect(fetchLimits()).resolves.toMatchObject({ status: 'available' });
    expect(seen[0]!.csrf).toBe('real-token');
  });

  it('skips antigravity processes that are not the language server', async () => {
    mockCommands({
      ps: [
        psLine(100, '/Applications/Antigravity.app/Contents/MacOS/Antigravity'),
        psLine(101, '/bin/sh /tmp/antigravity server installation script --csrf_token=nope'),
        psLine(102, '/usr/bin/grep antigravity'),
        psLine(103, 'not-a-pid antigravity language-server'),
        psLine(104, ''),
      ].join('\n'),
    });

    await expect(fetchLimits()).resolves.toMatchObject({
      status: 'unsupported',
      note: 'Antigravity language server is not running or could not be detected',
    });
  });

  it('reports unsupported when no listening port answers the probe', async () => {
    const { port } = await startLanguageServer((_request, response) => {
      response.statusCode = 500;
      response.end();
    });
    mockCommands({
      ps: psLine(900, `/opt/antigravity/language_server --extension_server_port=${port}`),
    });

    await expect(fetchLimits()).resolves.toMatchObject({ status: 'unsupported' });
  });

  it('treats a 401 probe response as a live server', async () => {
    const { port } = await startLanguageServer((request, response) => {
      response.statusCode = request.url?.endsWith('GetUnleashData') ? 401 : 403;
      response.end();
    });
    mockCommands({
      ps: psLine(900, `/opt/antigravity/language_server --extension_server_port=${port}`),
    });

    await expect(fetchLimits()).resolves.toMatchObject({
      status: 'unsupported',
      note: 'Antigravity language server rejected the local session (403)',
    });
  });

  it('reports unsupported when ps is unavailable', async () => {
    mockCommands({});

    await expect(fetchLimits()).resolves.toMatchObject({ status: 'unsupported' });
  });

  it('reports unsupported when lsof fails and no port is advertised', async () => {
    mockCommands({
      ps: psLine(900, '/opt/antigravity/language_server --csrf_token=csrf-abc'),
      lsof: new Error('lsof: command not found'),
    });

    await expect(fetchLimits()).resolves.toMatchObject({ status: 'unsupported' });
  });

  it('does not probe processes on unsupported platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockCommands({ ps: psLine(900, '/opt/antigravity/language_server --extension_server_port=1') });

    await expect(fetchLimits()).resolves.toMatchObject({ status: 'unsupported' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('prefers an explicit ANTIGRAVITY_BASE_URL over process discovery', async () => {
    const { port, seen } = await startLanguageServer();
    vi.stubEnv('ANTIGRAVITY_BASE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('ANTIGRAVITY_CSRF_TOKEN', 'env-token');
    mockCommands({ ps: psLine(900, '/opt/antigravity/language_server') });

    await expect(fetchLimits()).resolves.toMatchObject({ status: 'available' });
    expect(execFile).not.toHaveBeenCalled();
    expect(seen).toEqual([expect.objectContaining({ csrf: 'env-token' })]);
  });

  it('ignores a malformed or non-http ANTIGRAVITY_BASE_URL and falls back to discovery', async () => {
    for (const baseURL of ['not a url', 'ftp://127.0.0.1:9999']) {
      vi.stubEnv('ANTIGRAVITY_BASE_URL', baseURL);
      mockCommands({});

      await expect(fetchLimits()).resolves.toMatchObject({ status: 'unsupported' });
      expect(execFile).toHaveBeenCalledWith('ps', expect.anything(), expect.anything());
      execFile.mockReset();
    }
  });
});
