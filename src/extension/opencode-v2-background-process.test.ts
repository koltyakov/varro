import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShellInfo } from '@opencode/client';
import { BACKGROUND_OUTPUT_CHUNK_BYTES } from '../shared/background-process';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';
import { OpenCodeV2SessionState } from './opencode-v2-session-state';

/* oxlint-disable anti-slop/no-module-mocking -- The HTTP adapter tests do not have a VS Code host output channel. */
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let stateDirectory: string;
beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'varro-process-test-'));
  vi.stubEnv('VARRO_TEST_STATE_ROOT', stateDirectory);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(stateDirectory, { recursive: true, force: true });
});

function shell(id: string, sessionID: string): ShellInfo {
  return {
    id,
    status: 'running',
    command: 'npm test',
    cwd: '/repo',
    shell: 'zsh',
    file: '/private/log',
    pid: 42,
    metadata: { sessionID, secret: 'not for the webview' },
    time: { started: 100 },
  };
}

describe('v2 background process inspection', () => {
  it.each(['active', 'waiting'])(
    'omits absent service counts from %s status snapshots',
    async (mode) => {
      const wire = vi.fn(async (_method: string, path: string) => ({
        data:
          path === '/api/session/active'
            ? mode === 'active'
              ? { ses_own: { type: 'running' } }
              : {}
            : mode === 'waiting'
              ? [shell('own', 'ses_own')]
              : [],
      }));
      const adapter = new OpenCodeV2Adapter(wire);
      try {
        expect(await adapter.request('GET', '/session/status', undefined)).toStrictEqual({
          ses_own:
            mode === 'active'
              ? { type: 'busy' }
              : {
                  type: 'busy',
                  background: true,
                  backgroundStartedAt: 100,
                  backgroundCommand: 'npm test',
                },
        });
      } finally {
        adapter.reset();
      }
    }
  );

  it('reviews automatic choices at 5, 10, 20, 30 minutes and then every 30 minutes', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const own = { ...shell('own', 'ses_own'), time: { started } };
    const wire = vi.fn(async (_method: string, path: string) => ({
      data: path === '/api/session/active' ? {} : [own],
    }));
    let service = false;
    const classify = vi.fn(async () => {
      service = !service;
      return service;
    });
    const adapter = new OpenCodeV2Adapter(wire, undefined, undefined, undefined, classify);
    await adapter.request('GET', '/session/status', undefined);
    await vi.waitFor(() => expect(adapter.eventContext('ses_own')?.backgroundServices).toBe(1));
    for (const [index, minute] of [5, 10, 20, 30, 60].entries()) {
      await vi.advanceTimersByTimeAsync(started + minute * 60_000 - Date.now() - 1);
      expect(classify).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() =>
        expect(adapter.eventContext('ses_own')?.backgroundServices).toBe(index % 2 === 0 ? 0 : 1)
      );
      expect(classify).toHaveBeenCalledTimes(index + 2);
    }
    adapter.reset();
  });

  it.each([true, false])(
    'never reviews a manual service=%s choice, including after reload',
    async (service) => {
      vi.useFakeTimers();
      const own = { ...shell('own', 'ses_own'), time: { started: Date.now() } };
      const wire = vi.fn(async (_method: string, path: string) => ({
        data: path === '/api/session/active' ? {} : path === '/api/shell/own' ? own : [own],
      }));
      const classify = vi.fn(async () => true);
      const adapter = new OpenCodeV2Adapter(wire, undefined, undefined, undefined, classify);
      await adapter.request('GET', '/session/status', undefined);
      await vi.waitFor(() => expect(adapter.eventContext('ses_own')?.backgroundServices).toBe(1));
      await adapter.request('PATCH', '/session/ses_own/background-process/own', { service });
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(classify).toHaveBeenCalledTimes(1);
      const reloaded = new OpenCodeV2Adapter(wire, undefined, undefined, undefined, classify);
      await reloaded.request('GET', '/session/status', undefined);
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(classify).toHaveBeenCalledTimes(1);
      adapter.reset();
      reloaded.reset();
    }
  );

  it('restores the persisted next automatic review after reload', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const own = { ...shell('own', 'ses_own'), time: { started } };
    const wire = vi.fn(async (_method: string, path: string) => ({
      data: path === '/api/session/active' ? {} : [own],
    }));
    const classify = vi.fn(async () => true);
    const adapter = new OpenCodeV2Adapter(wire, undefined, undefined, undefined, classify);
    await adapter.request('GET', '/session/status', undefined);
    await vi.waitFor(() => expect(adapter.eventContext('ses_own')?.backgroundServices).toBe(1));
    adapter.reset();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const restoredJudge = vi.fn(async () => false);
    const restored = new OpenCodeV2Adapter(wire, undefined, undefined, undefined, restoredJudge);
    await restored.request('GET', '/session/status', undefined);
    expect(restored.eventContext('ses_own')?.backgroundServices).toBe(1);
    await vi.advanceTimersByTimeAsync(started + 5 * 60_000 - Date.now() - 1);
    expect(restoredJudge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(restored.eventContext('ses_own')?.backgroundServices).toBe(0));
    expect(restoredJudge).toHaveBeenCalledTimes(1);
    restored.reset();
  });

  it.each(['shell.exited', 'shell.deleted'])('cancels future reviews on %s', async (event) => {
    vi.useFakeTimers();
    const own = { ...shell('own', 'ses_own'), time: { started: Date.now() } };
    const wire = vi.fn(async (_method: string, path: string) => ({
      data: path === '/api/session/active' ? {} : [own],
    }));
    const classify = vi.fn(async () => true);
    const adapter = new OpenCodeV2Adapter(wire, undefined, undefined, undefined, classify);
    await adapter.request('GET', '/session/status', undefined);
    await vi.waitFor(() => expect(adapter.eventContext('ses_own')?.backgroundServices).toBe(1));
    adapter.observe(event, { id: own.id });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(classify).toHaveBeenCalledTimes(1);
    adapter.reset();
  });
  it('automatically detaches a judged service without delaying snapshots, and persists the verdict', async () => {
    const own = shell('own', 'ses_own');
    const wire = vi.fn(async (_method: string, path: string) => ({
      data: path === '/api/session/active' ? {} : [own],
    }));
    let resolve!: (service: boolean | null) => void;
    const classify = vi.fn(
      () =>
        new Promise<boolean | null>((done) => {
          resolve = done;
        })
    );
    const adapter = new OpenCodeV2Adapter(wire, undefined, undefined, undefined, classify);
    expect(await adapter.request('GET', '/session/status', undefined)).toMatchObject({
      ses_own: { type: 'busy', background: true },
    });
    await adapter.request('GET', '/session/status', undefined);
    expect(classify).toHaveBeenCalledTimes(1);
    resolve(true);
    await vi.waitFor(() => expect(adapter.eventContext('ses_own')?.backgroundServices).toBe(1));
    expect(await adapter.request('GET', '/session/status', undefined)).toEqual({
      ses_own: { type: 'idle', backgroundServices: 1 },
    });
    const reloadedJudge = vi.fn(async () => false);
    const reloaded = new OpenCodeV2Adapter(wire, undefined, undefined, undefined, reloadedJudge);
    expect(await reloaded.request('GET', '/session/status', undefined)).toEqual({
      ses_own: { type: 'idle', backgroundServices: 1 },
    });
    expect(reloadedJudge).not.toHaveBeenCalled();
  });

  it('does not overwrite an explicit choice with a late automatic verdict, even from another adapter', async () => {
    const read = vi.spyOn(OpenCodeV2SessionState.prototype, 'read');
    const own = shell('own', 'ses_own');
    const wire = vi.fn(async (_method: string, path: string) => ({
      data: path === '/api/session/active' ? {} : path === '/api/shell/own' ? own : [own],
    }));
    let resolve!: (service: boolean | null) => void;
    const classify = vi.fn(
      () =>
        new Promise<boolean | null>((done) => {
          resolve = done;
        })
    );
    const adapter = new OpenCodeV2Adapter(wire, undefined, undefined, undefined, classify);
    await adapter.request('GET', '/session/status', undefined);
    const other = new OpenCodeV2Adapter(wire);
    await other.request('PATCH', '/session/ses_own/background-process/own', { service: false });
    const readsBeforeVerdict = read.mock.calls.length;
    resolve(true);
    // Wait for both the guarded write's read and the judgment's final ownership read.
    await vi.waitFor(() =>
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(readsBeforeVerdict + 2)
    );
    await read.mock.results.at(-1)?.value;
    expect(adapter.eventContext('ses_own')?.backgroundServices).toBe(0);
    expect(await adapter.request('GET', '/session/status', undefined)).toMatchObject({
      ses_own: { type: 'busy', background: true },
    });
    expect(
      await other.request('GET', '/session/ses_own/background-process', undefined)
    ).toMatchObject([{ service: undefined }]);
    adapter.reset();
    other.reset();
  });

  it('retains blocking work after an unavailable judge and cancels judgment on reset', async () => {
    const read = vi.spyOn(OpenCodeV2SessionState.prototype, 'read');
    const own = shell('own', 'ses_own');
    const wire = vi.fn(async (_method: string, path: string) => ({
      data: path === '/api/session/active' ? {} : [own],
    }));
    const classify = vi.fn(async () => {
      throw new Error('Model unavailable');
    });
    const adapter = new OpenCodeV2Adapter(wire, undefined, undefined, undefined, classify);
    await adapter.request('GET', '/session/status', undefined);
    expect(await adapter.request('GET', '/session/status', undefined)).toMatchObject({
      ses_own: { type: 'busy', background: true },
    });
    expect(classify).toHaveBeenCalledTimes(1);
    // Initial snapshot, scheduling write, second snapshot, and final judgment read.
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    await read.mock.results.at(-1)?.value;
    adapter.reset();
    let signal: AbortSignal | undefined;
    const pending = new OpenCodeV2Adapter(
      async (_method, path) => ({
        data: path === '/api/session/active' ? {} : [shell('pending', 'ses_pending')],
      }),
      undefined,
      undefined,
      undefined,
      async (_shell, _directory, candidateSignal) => {
        signal = candidateSignal;
        return new Promise(() => {});
      }
    );
    await pending.request('GET', '/session/status', undefined);
    pending.reset();
    expect(signal?.aborted).toBe(true);
  });
  it('persists a service choice across adapter reloads without mutating the server process', async () => {
    const own = { ...shell('own', 'ses_own'), command: 'python3 tools/serve.py 18765' };
    const wire = vi.fn(async (_method: string, path: string) => ({
      data: path === '/api/session/active' ? {} : path.startsWith('/api/shell/own') ? own : [own],
    }));
    const adapter = new OpenCodeV2Adapter(wire);
    expect(await adapter.request('GET', '/session/status', undefined)).toMatchObject({
      ses_own: { type: 'busy', background: true },
    });
    await adapter.request('PATCH', '/session/ses_own/background-process/own', { service: true });
    expect(adapter.eventContext('ses_own')).toMatchObject({
      backgroundPending: false,
      backgroundServices: 1,
    });
    const reloaded = new OpenCodeV2Adapter(wire);
    expect(await reloaded.request('GET', '/session/status', undefined)).toEqual({
      ses_own: { type: 'idle', backgroundServices: 1 },
    });
    expect(
      await reloaded.request('GET', '/session/ses_own/background-process', undefined)
    ).toMatchObject([{ service: true, command: own.command }]);
    expect(wire.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    await reloaded.request('PATCH', '/session/ses_own/background-process/own', { service: false });
    expect(await reloaded.request('GET', '/session/status', undefined)).toMatchObject({
      ses_own: { type: 'busy', background: true },
    });
  });

  it('does not hide active model execution behind a running service', async () => {
    const own = shell('own', 'ses_own');
    const adapter = new OpenCodeV2Adapter(async (_method, path) => ({
      data:
        path === '/api/session/active'
          ? { ses_own: { type: 'running' } }
          : path.startsWith('/api/shell/own')
            ? own
            : [own],
    }));
    await adapter.request('PATCH', '/session/ses_own/background-process/own', { service: true });
    expect(await adapter.request('GET', '/session/status', undefined)).toEqual({
      ses_own: { type: 'busy', backgroundServices: 1 },
    });
  });

  it.each(['PATCH', 'DELETE'])(
    'refuses %s for another session before changing anything',
    async (method) => {
      const wire = vi.fn(async () => ({ data: shell('other', 'ses_other') }));
      const adapter = new OpenCodeV2Adapter(wire);
      await expect(
        adapter.request(method, '/session/ses_own/background-process/other', { service: true })
      ).rejects.toThrow('Background process not found');
      expect(wire).toHaveBeenCalledTimes(1);
      expect(wire).toHaveBeenCalledWith('GET', '/api/shell/other', undefined, expect.anything());
    }
  );

  it('rejects invalid choices and completed processes', async () => {
    const wire = vi.fn(async () => ({ data: { ...shell('own', 'ses_own'), status: 'exited' } }));
    const adapter = new OpenCodeV2Adapter(wire);
    await expect(
      adapter.request('PATCH', '/session/ses_own/background-process/own', { service: 'true' })
    ).rejects.toThrow('must be a boolean');
    expect(wire).not.toHaveBeenCalled();
    await expect(
      adapter.request('PATCH', '/session/ses_own/background-process/own', { service: true })
    ).rejects.toThrow('no longer running');
  });

  it('stops only the selected owned process and retains tracking on a failed stop', async () => {
    const own = shell('own', 'ses_own');
    const wire = vi.fn(async (method: string) => {
      if (method === 'DELETE') throw new Error('Stop failed');
      return { data: own };
    });
    const adapter = new OpenCodeV2Adapter(wire);
    await adapter.request('PATCH', '/session/ses_own/background-process/own', { service: true });
    await expect(
      adapter.request('DELETE', '/session/ses_own/background-process/own', undefined)
    ).rejects.toThrow('Stop failed');
    expect(adapter.eventContext('ses_own')?.backgroundServices).toBe(1);
    wire.mockImplementation(async () => ({ data: own }));
    await adapter.request('DELETE', '/session/ses_own/background-process/own', undefined, {
      directory: '/repo',
    });
    expect(wire).toHaveBeenLastCalledWith(
      'DELETE',
      '/api/shell/own?location%5Bdirectory%5D=%2Frepo',
      undefined,
      expect.anything()
    );
    expect(adapter.eventContext('ses_own')?.backgroundServices).toBe(0);
  });
  it('lists only session-owned processes and excludes private metadata and log paths', async () => {
    const wire = vi.fn(async () => ({
      data: [shell('own', 'ses_own'), shell('other', 'ses_other')],
    }));
    const adapter = new OpenCodeV2Adapter(wire);
    await expect(
      adapter.request('GET', '/session/ses_own/background-process', undefined, {
        directory: '/repo',
      })
    ).resolves.toEqual([
      {
        id: 'own',
        status: 'running',
        command: 'npm test',
        cwd: '/repo',
        pid: 42,
        time: { started: 100 },
      },
    ]);
    expect(wire).toHaveBeenCalledWith(
      'GET',
      '/api/shell?location%5Bdirectory%5D=%2Frepo',
      undefined,
      expect.anything()
    );
  });

  it('reads only the bounded tail on first open', async () => {
    const wire = vi.fn(async (_method: string, path: string) => {
      const url = new URL(path, 'http://localhost');
      if (url.pathname === '/api/shell/own') return { data: shell('own', 'ses_own') };
      const probe = url.searchParams.get('limit') === '1';
      return {
        data: {
          output: probe ? 'a' : 'tail',
          cursor: probe ? 1 : 200_000,
          size: 200_000,
          truncated: false,
        },
      };
    });
    const adapter = new OpenCodeV2Adapter(wire);
    await expect(
      adapter.request('GET', '/session/ses_own/background-process/own/output', undefined, {
        directory: '/repo',
      })
    ).resolves.toEqual({ output: 'tail', cursor: 200_000, size: 200_000, truncated: true });
    const targets = wire.mock.calls.map(([, path]) => new URL(path, 'http://localhost'));
    expect(targets[1]?.searchParams.get('limit')).toBe('1');
    expect(targets[2]?.searchParams.get('cursor')).toBe(
      String(200_000 - BACKGROUND_OUTPUT_CHUNK_BYTES)
    );
    expect(targets[2]?.searchParams.get('limit')).toBe(String(BACKGROUND_OUTPUT_CHUNK_BYTES));
    expect(targets.every((url) => url.searchParams.get('location[directory]') === '/repo')).toBe(
      true
    );
    expect(wire.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it('continues from a byte cursor without probing the log again', async () => {
    const wire = vi.fn(async (_method: string, path: string) => ({
      data: path.includes('/output')
        ? { output: 'next', cursor: 104, size: 104, truncated: false }
        : shell('own', 'ses_own'),
    }));
    const adapter = new OpenCodeV2Adapter(wire);
    await expect(
      adapter.request('GET', '/session/ses_own/background-process/own/output?cursor=100', undefined)
    ).resolves.toEqual({ output: 'next', cursor: 104, size: 104, truncated: false });
    expect(wire).toHaveBeenCalledTimes(2);
    expect(wire.mock.calls[1]?.[1]).toBe(
      `/api/shell/own/output?cursor=100&limit=${BACKGROUND_OUTPUT_CHUNK_BYTES}`
    );
  });

  it('refuses output from another session before reading its log', async () => {
    const wire = vi.fn(async (_method: string) => ({ data: shell('other', 'ses_other') }));
    const adapter = new OpenCodeV2Adapter(wire);
    await expect(
      adapter.request('GET', '/session/ses_own/background-process/other/output', undefined)
    ).rejects.toThrow('Background process not found');
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it.each(['-1', 'NaN', '0.5', '9007199254740992'])('rejects invalid cursor %s', async (cursor) => {
    const wire = vi.fn(async () => ({ data: shell('own', 'ses_own') }));
    const adapter = new OpenCodeV2Adapter(wire);
    await expect(
      adapter.request(
        'GET',
        `/session/ses_own/background-process/own/output?cursor=${cursor}`,
        undefined
      )
    ).rejects.toThrow('Invalid background output cursor');
    expect(wire).toHaveBeenCalledTimes(1);
  });
});
