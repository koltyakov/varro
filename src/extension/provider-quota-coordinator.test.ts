/* oxlint-disable anti-slop/no-module-mocking -- Isolate the real adapter from the user's auth store while exercising real private files. */
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import type * as OsModule from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLimitStatus } from '../shared/protocol';
import type * as ProviderLimitModule from './util/provider-limit';
import type { ProviderMetadata } from './util/provider-limit';
import { ProviderLimitService } from './provider-limit-service';
import { ProviderQuotaCoordinator } from './provider-quota-coordinator';
import { createAnthropicAdapter } from './provider-limits/adapters/anthropic';
import type { OpenCodeServer } from './server';

const auth = vi.hoisted(() => ({ path: '', home: '' }));
vi.mock('os', async () => ({
  ...(await vi.importActual<typeof OsModule>('os')),
  default: { ...(await vi.importActual<typeof OsModule>('os')), homedir: () => auth.home },
  homedir: () => auth.home,
}));
vi.mock('./util/provider-limit', async () => ({
  ...(await vi.importActual<typeof ProviderLimitModule>('./util/provider-limit')),
  getOpenCodeAuthFilePath: () => auth.path,
}));

let root: string;
let now: number;
function available(remaining = 5): ProviderLimitStatus {
  return {
    providerID: 'openrouter',
    modelID: null,
    source: 'provider',
    status: 'available',
    checkedAt: now,
    note: 'secret raw note',
    windows: [{ id: 'spend', label: 'Spend', unit: 'usd', remaining, limit: 10, resetAt: null }],
  };
}
function limited(): ProviderLimitStatus {
  return {
    providerID: 'openrouter',
    source: 'provider',
    status: 'error',
    checkedAt: now,
    note: '429 secret raw error',
  };
}
async function accountDirectory() {
  const entries = await fs.readdir(root);
  return join(
    root,
    entries.find((entry) => /^[a-f0-9]{64}$/.test(entry))!
  );
}
function server() {
  return {
    request: vi.fn(
      async (
        _method: string,
        _path: string,
        _body?: Parameters<OpenCodeServer['request']>[2],
        options?: { directory?: string }
      ) => ({
        providers: [
          {
            id: 'openrouter',
            options: { apiKey: options?.directory === '/other' ? 'other-secret' : 'same-secret' },
            models: {},
          },
        ],
      })
    ),
  };
}

describe.skipIf(process.platform === 'win32')('ProviderQuotaCoordinator', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'varro-quota-'));
    auth.path = join(root, 'absent-auth.json');
    auth.home = root;
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('single-flights two independent services across models and reads the latest shared snapshot', async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      )
      .mockImplementation(
        async () => new Response(JSON.stringify({ data: { limit: 10, usage: 7 } }))
      );
    vi.stubGlobal('fetch', fetchMock);
    const first = new ProviderLimitService(server(), new ProviderQuotaCoordinator(root));
    const second = new ProviderLimitService(server(), new ProviderQuotaCoordinator(root));
    const a = first.get('openrouter', 'model-a', '/repo');
    const b = second.get('openrouter', 'model-b', '/repo');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(new Response(JSON.stringify({ data: { limit: 10, usage: 2 } })));
    expect(await a).toMatchObject({ modelID: 'model-a', windows: [{ remaining: 8 }] });
    expect(await b).toMatchObject({ modelID: 'model-b', windows: [{ remaining: 8 }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 30_000;
    await second.get('openrouter', 'model-b', '/repo');
    expect(await first.get('openrouter', 'model-a', '/repo')).toMatchObject({
      windows: [{ remaining: 3 }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares exponential cooldown across independent services and cache clearing', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = new ProviderLimitService(server(), new ProviderQuotaCoordinator(root));
    const second = new ProviderLimitService(server(), new ProviderQuotaCoordinator(root));
    await Promise.all([first.get('openrouter', 'a'), second.get('openrouter', 'b')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 60_000;
    await second.get('openrouter', 'b');
    first.clearCache();
    now += 119_999;
    await first.get('openrouter', 'a');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += 1;
    await first.get('openrouter', 'a');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['openai', 'anthropic', 'claude-code'])(
    'shares %s subscription windows across models and isolates credential rotation',
    async (providerID) => {
      const provider: ProviderMetadata = {
        id: providerID,
        models: {},
        options: {
          'claude-code': {
            providerLimits: {
              schemaVersion: 1,
              transport: 'http',
              url: 'http://127.0.0.1:43127/provider-limit',
              token: 'ipc-secret',
            },
          },
        },
      };
      const store = {
        [providerID]: { type: 'oauth' as const, access: 'oauth-secret', accountId: 'account-a' },
      };
      await fs.writeFile(auth.path, JSON.stringify(store));
      const backend = { request: vi.fn(async () => ({ providers: [provider] })) };
      const payload =
        providerID === 'openai'
          ? {
              plan_type: 'pro',
              rate_limit: {
                primary_window: { used_percent: 20 },
                secondary_window: { used_percent: 30 },
              },
            }
          : providerID === 'anthropic'
            ? { five_hour: { utilization: 20 }, seven_day: { utilization: 30 } }
            : {
                schemaVersion: 1,
                providerLimit: {
                  providerID,
                  modelID: null,
                  source: 'provider',
                  status: 'available',
                  checkedAt: now,
                  note: 'secret note',
                  windows: [
                    {
                      id: 'five_hour',
                      label: 'secret label',
                      remaining: 80,
                      limit: 100,
                      unit: 'unknown',
                      percent: 20,
                      resetAt: null,
                    },
                    {
                      id: 'seven_day',
                      label: 'secret label',
                      remaining: 70,
                      limit: 100,
                      unit: 'unknown',
                      percent: 30,
                      resetAt: null,
                    },
                  ],
                },
              };
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload)));
      vi.stubGlobal('fetch', fetchMock);
      const first = new ProviderLimitService(backend, new ProviderQuotaCoordinator(root));
      const second = new ProviderLimitService(backend, new ProviderQuotaCoordinator(root));
      const results = await Promise.all([
        first.get(providerID, 'model-a'),
        second.get(providerID, 'model-b'),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results[0]).toMatchObject({
        providerID,
        modelID: 'model-a',
        windows: [
          { id: 'five_hour', remaining: 80 },
          { id: 'seven_day', remaining: 70 },
        ],
      });
      expect(results[1]).toMatchObject({ providerID, modelID: 'model-b', checkedAt: now });
      const text = await fs.readFile(join(await accountDirectory(), 'snapshot.json'), 'utf8');
      expect(text).not.toContain('secret');
      expect(text).not.toContain('account-a');
      expect(text).not.toContain('127.0.0.1');

      if (providerID === 'claude-code') {
        provider.options = {
          'claude-code': {
            providerLimits: {
              schemaVersion: 1,
              transport: 'http',
              url: 'http://127.0.0.1:43128/provider-limit',
              token: 'ipc-secret',
            },
          },
        };
      } else {
        store[providerID] = { type: 'oauth', access: 'rotated-secret', accountId: 'account-a' };
        await fs.writeFile(auth.path, JSON.stringify(store));
      }
      await first.get(providerID, 'model-a');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      if (providerID === 'openai') {
        store.openai = { type: 'oauth', access: 'rotated-secret', accountId: 'account-b' };
        await fs.writeFile(auth.path, JSON.stringify(store));
        await second.get(providerID, 'model-b');
        expect(fetchMock).toHaveBeenCalledTimes(3);
      }
    }
  );

  it('refreshes Claude file credentials once under coordination and preserves unrelated fields', async () => {
    await fs.mkdir(join(root, '.claude'));
    const credentialsPath = join(root, '.claude', '.credentials.json');
    await fs.writeFile(
      credentialsPath,
      JSON.stringify({
        theme: 'dark',
        claudeAiOauth: { accessToken: 'old', refreshToken: 'refresh-secret', scopes: ['openid'] },
      })
    );
    const refresh = vi.fn(() => Response.json({ access_token: 'new', refresh_token: 'rotated' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/oauth/token')) return refresh();
        if (new Headers(init?.headers).get('Authorization') === 'Bearer old')
          return new Response('', { status: 401 });
        return Response.json({ five_hour: { utilization: 20 } });
      })
    );
    const adapter = createAnthropicAdapter();
    const run = (modelID: string) =>
      adapter.fetch({
        provider: { id: 'anthropic', models: {} },
        authStore: {},
        modelID,
        checkedAt: now,
        coordinate: (identity, poll) =>
          new ProviderQuotaCoordinator(root).get(
            JSON.stringify(identity),
            modelID,
            poll,
            'anthropic'
          ),
      });
    const statuses = await Promise.all([run('a'), run('b')]);
    expect(statuses).toEqual([
      expect.objectContaining({ status: 'available' }),
      expect.objectContaining({ status: 'available' }),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(credentialsPath, 'utf8'))).toEqual({
      theme: 'dark',
      claudeAiOauth: { accessToken: 'new', refreshToken: 'rotated', scopes: ['openid'] },
    });
  });

  it('isolates workspace configs and follows the adapter auth-store precedence and rotation', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: { limit: 10, usage: 2 } }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const backend = server();
    const service = new ProviderLimitService(backend, new ProviderQuotaCoordinator(root));
    await service.get('openrouter', 'a', '/repo');
    await service.get('openrouter', 'a', '/other');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(backend.request).toHaveBeenCalledWith('GET', '/config/providers', undefined, {
      directory: '/other',
    });
    await fs.writeFile(
      auth.path,
      JSON.stringify({ openrouter: { type: 'api', key: 'store-secret' } })
    );
    await service.get('openrouter', 'a', '/repo');
    await service.get('openrouter', 'b', '/other');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://openrouter.ai/api/v1/auth/key',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer store-secret' }),
      })
    );
    await fs.writeFile(
      auth.path,
      JSON.stringify({ openrouter: { type: 'oauth', access: 'rotated-secret' } })
    );
    await service.get('openrouter', 'a', '/repo');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('preserves last-good time, bounds stale serving and never persists raw text or secrets', async () => {
    const first = new ProviderQuotaCoordinator(root);
    const second = new ProviderQuotaCoordinator(root);
    const checkedAt = now;
    await first.get('secret-token', null, async () => available());
    now += 30_000;
    const poll = vi.fn(async () => limited());
    expect(await second.get('secret-token', null, poll)).toMatchObject({
      status: 'available',
      checkedAt,
    });
    expect(await first.get('secret-token', null, poll)).toMatchObject({
      status: 'available',
      checkedAt,
    });
    expect(poll).toHaveBeenCalledTimes(1);
    const directory = await accountDirectory();
    const text = await fs.readFile(join(directory, 'snapshot.json'), 'utf8');
    expect(text).not.toContain('secret');
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(directory, 'snapshot.json'))).mode & 0o777).toBe(0o600);
    now += 15 * 60_000;
    expect(await second.get('secret-token', null, poll)).toMatchObject({ status: 'error' });
  });

  it('keeps reset counts and expirations but never persists arbitrary titles or plan names', async () => {
    const poll = vi.fn(async (): Promise<ProviderLimitStatus> => ({
      ...available(),
      status: 'available',
      windows: [
        {
          id: 'five_hour',
          label: 'secret label',
          unit: 'unknown',
          remaining: 80,
          limit: 100,
          percent: 20,
          resetAt: now + 10_000,
        },
      ],
      planName: 'secret account plan',
      usageLimitResets: {
        availableCount: 2,
        credits: [
          { title: 'secret credit', expiresAt: now + 20_000 },
          { title: 'another secret', expiresAt: null },
        ],
      },
    }));
    const first = new ProviderQuotaCoordinator(root);
    const status = await first.get('secret identity', 'model-a', poll, 'openai');
    expect(status).toMatchObject({
      providerID: 'openai',
      usageLimitResets: {
        availableCount: 2,
        credits: [
          { title: 'Full reset', expiresAt: now + 20_000 },
          { title: 'Full reset', expiresAt: null },
        ],
      },
    });
    expect(status).not.toHaveProperty('planName');
    expect(
      await new ProviderQuotaCoordinator(root).get('secret identity', 'model-a', poll, 'openai')
    ).toEqual(status);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(
      await fs.readFile(join(await accountDirectory(), 'snapshot.json'), 'utf8')
    ).not.toContain('secret');
  });

  it('returns unknown quota windows live without persisting arbitrary IDs', async () => {
    const result: ProviderLimitStatus = {
      ...available(),
      status: 'available',
      windows: [
        {
          id: 'unreviewed-secret-id',
          label: 'Unknown',
          unit: 'unknown',
          remaining: 10,
          limit: 100,
          resetAt: null,
        },
      ],
    };
    const coordinator = new ProviderQuotaCoordinator(root);
    const poll = vi.fn(async () => result);
    expect(await coordinator.get('token', null, poll, 'claude-code')).toEqual(result);
    expect(await fs.readdir(await accountDirectory())).toEqual([]);
    expect(await coordinator.get('token', null, poll, 'claude-code')).toEqual(result);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('uses the service local cache on Windows rather than disabling limits', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: { limit: 10, usage: 2 } }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new ProviderLimitService(server(), new ProviderQuotaCoordinator(root));
    expect(await service.get('openrouter', 'model-a')).toMatchObject({ status: 'available' });
    expect(await service.get('openrouter', 'model-a')).toMatchObject({ status: 'available' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('shares thrown failures and resets rate-limit backoff after success', async () => {
    const first = new ProviderQuotaCoordinator(root);
    const second = new ProviderQuotaCoordinator(root);
    await first.get('token', null, async () => limited());
    now += 60_000;
    await second.get('token', null, async () => available());
    now += 30_000;
    await first.get('token', null, async () => limited());
    now += 60_000;
    const poll = vi.fn(async () => {
      throw new Error('secret');
    });
    await second.get('token', null, poll);
    await first.get('token', null, poll);
    expect(poll).toHaveBeenCalledTimes(1);
    now += 15_000;
    await first.get('token', null, poll);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('falls back locally for unsafe directories and symlink snapshots without modifying them', async () => {
    const coordinator = new ProviderQuotaCoordinator(root);
    const poll = vi.fn(async () => available());
    await fs.chmod(root, 0o755);
    expect(await coordinator.get('token', null, poll)).toMatchObject({ status: 'available' });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual([]);
    await fs.chmod(root, 0o700);
    await coordinator.get('token', null, poll);
    const path = join(await accountDirectory(), 'snapshot.json');
    await fs.unlink(path);
    await fs.symlink(auth.path, path);
    expect(await coordinator.get('token', null, poll)).toMatchObject({ status: 'available' });
    expect(poll).toHaveBeenCalledTimes(2);
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
  });

  it('replaces malformed snapshots only under the shared lock', async () => {
    const first = new ProviderQuotaCoordinator(root);
    await first.get('token', null, async () => available());
    await fs.writeFile(join(await accountDirectory(), 'snapshot.json'), '{invalid');
    const poll = vi.fn(async () => available());
    await Promise.all([
      first.get('token', null, poll),
      new ProviderQuotaCoordinator(root).get('token', null, poll),
    ]);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('single-flights local storage fallback across coordinators and shares its 429 cooldown', async () => {
    await fs.chmod(root, 0o755);
    const poll = vi.fn(async () => limited());
    const first = new ProviderQuotaCoordinator(root);
    const second = new ProviderQuotaCoordinator(root);
    const statuses = await Promise.all([
      first.get('token', 'a', poll),
      second.get('token', 'b', poll),
    ]);
    expect(statuses.map((status) => status.modelID)).toEqual(['a', 'b']);
    expect(poll).toHaveBeenCalledTimes(1);
    now += 59_999;
    await second.get('token', 'b', poll);
    expect(poll).toHaveBeenCalledTimes(1);
    now += 1;
    await second.get('token', 'b', poll);
    expect(poll).toHaveBeenCalledTimes(2);
    now += 119_999;
    await first.get('token', 'a', poll);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('rejects unsafe file modes and hardlinked snapshots', async () => {
    const coordinator = new ProviderQuotaCoordinator(root);
    const poll = vi.fn(async () => available());
    await coordinator.get('token', null, poll);
    const path = join(await accountDirectory(), 'snapshot.json');
    await fs.chmod(path, 0o644);
    expect(await coordinator.get('token', null, poll)).toMatchObject({ status: 'available' });
    await fs.chmod(path, 0o600);
    await fs.link(path, join(root, 'linked.json'));
    expect(await coordinator.get('token', null, poll)).toMatchObject({ status: 'available' });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it.each(['live', 'malformed'])(
    'does not steal a %s lock even after its wait expires',
    async (kind) => {
      const coordinator = new ProviderQuotaCoordinator(root);
      await coordinator.get('token', null, async () => available());
      now += 30_000;
      const lock = join(await accountDirectory(), 'lock');
      await fs.mkdir(lock, { mode: 0o700 });
      if (kind !== 'empty') {
        await fs.writeFile(
          join(
            lock,
            kind === 'live' ? `${process.pid}-00000000-0000-0000-0000-000000000000` : 'invalid'
          ),
          '',
          { mode: 0o600 }
        );
      }
      const poll = vi.fn(async () => available());
      vi.mocked(Date.now).mockImplementation(() => {
        now += 10_000;
        return now;
      });
      await coordinator.get('token', null, poll);
      expect(poll).not.toHaveBeenCalled();
      expect((await fs.stat(lock)).isDirectory()).toBe(true);
    }
  );

  it('recovers an empty release lock without duplicate polling', async () => {
    const first = new ProviderQuotaCoordinator(root);
    await first.get('token', null, async () => available());
    now += 30_000;
    await fs.mkdir(join(await accountDirectory(), 'lock'), { mode: 0o700 });
    const poll = vi.fn(async () => available());
    await Promise.all([
      first.get('token', null, poll),
      new ProviderQuotaCoordinator(root).get('token', null, poll),
    ]);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('fetches locally on Windows without creating shared files', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const poll = vi.fn(async () => available());
    expect(await new ProviderQuotaCoordinator(root).get('secret', null, poll)).toMatchObject({
      status: 'available',
    });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('recovers a confirmed dead owner without duplicate polling', async () => {
    const first = new ProviderQuotaCoordinator(root);
    await first.get('token', null, async () => available());
    now += 30_000;
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid!;
    await new Promise((resolve) => child.once('exit', resolve));
    const lock = join(await accountDirectory(), 'lock');
    await fs.mkdir(lock, { mode: 0o700 });
    await fs.writeFile(join(lock, `${pid}-00000000-0000-0000-0000-000000000000`), '', {
      mode: 0o600,
    });
    const poll = vi.fn(async () => available());
    const results = await Promise.all([
      first.get('token', null, poll),
      new ProviderQuotaCoordinator(root).get('token', null, poll),
    ]);
    expect(results.every((result) => result.status === 'available')).toBe(true);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('retains the lock until a non-abortable poll settles, even after a contender times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: (status: ProviderLimitStatus) => void;
    const poll = vi.fn(
      () =>
        new Promise<ProviderLimitStatus>((resolve) => {
          release = resolve;
        })
    );
    const first = new ProviderQuotaCoordinator(root).get('token', null, poll);
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    now += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await fs.readdir(join(await accountDirectory(), 'lock'))).toHaveLength(1);
    vi.useRealTimers();
    const second = new ProviderQuotaCoordinator(root);
    const successorPoll = vi.fn(async () => available(2));
    vi.mocked(Date.now).mockImplementation(() => {
      now += 10_000;
      return now;
    });
    const contender = second.get('token', null, successorPoll);
    expect(await contender).toMatchObject({ status: 'error' });
    expect(successorPoll).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockImplementation(() => now);
    release(available(9));
    expect(await first).toMatchObject({ windows: [{ remaining: 9 }] });
    expect(await second.get('token', null, async () => available(9))).toMatchObject({
      windows: [{ remaining: 9 }],
    });
  });
});
