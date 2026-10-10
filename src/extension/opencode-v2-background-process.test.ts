import { describe, expect, it, vi } from 'vitest';
import type { ShellInfo } from '@opencode/client';
import { BACKGROUND_OUTPUT_CHUNK_BYTES } from '../shared/background-process';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';

/* oxlint-disable anti-slop/no-module-mocking -- The HTTP adapter tests do not have a VS Code host output channel. */
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

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
    const wire = vi.fn(async () => ({ data: shell('other', 'ses_other') }));
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
