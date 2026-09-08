/* oxlint-disable anti-slop/no-module-mocking -- Use private fixture credentials with the real coordinator and adapter. */
import * as fs from 'fs/promises';
import type * as OsModule from 'os';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLimitStatus } from '../shared/protocol';
import type * as ProviderLimitModule from './util/provider-limit';
import { ProviderLimitService } from './provider-limit-service';
import { ProviderQuotaCoordinator } from './provider-quota-coordinator';

const auth = vi.hoisted(() => ({ path: '', home: '' }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof OsModule>('os');
  return { ...actual, homedir: () => auth.home, default: { ...actual, homedir: () => auth.home } };
});
vi.mock('./util/provider-limit', async () => ({
  ...(await vi.importActual<typeof ProviderLimitModule>('./util/provider-limit')),
  getOpenCodeAuthFilePath: () => auth.path,
}));

describe.skipIf(process.platform === 'win32')('shared quota observation', () => {
  let root: string;
  let now: number;
  const services: ProviderLimitService[] = [];
  const owners: Array<{ coordinator: ProviderQuotaCoordinator; owner: symbol }> = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'varro-quota-observation-'));
    auth.path = join(root, 'auth.json');
    auth.home = root;
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    for (const instance of services.splice(0)) instance.dispose();
    for (const { coordinator, owner } of owners.splice(0)) coordinator.clearObservations(owner);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  function available(remaining: number): ProviderLimitStatus {
    return {
      providerID: 'openrouter',
      modelID: 'a',
      source: 'provider',
      status: 'available',
      checkedAt: now,
      windows: [{ id: 'spend', label: 'Spend', unit: 'usd', remaining, limit: 10, resetAt: null }],
    };
  }

  function service(
    onUpdate?: ConstructorParameters<typeof ProviderLimitService>[3],
    providerID = 'openrouter',
    coordinator = new ProviderQuotaCoordinator(root)
  ) {
    const server = {
      request: vi.fn(async () => ({
        providers: [
          { id: providerID, models: {}, options: { apiKey: 'opencode-oauth-dummy-key' } },
        ],
      })),
    };
    const result = new ProviderLimitService(server, coordinator, undefined, onUpdate);
    services.push(result);
    return { service: result, server };
  }

  it('does not publish or observe a changed Anthropic identity under the old token', async () => {
    await fs.mkdir(join(root, '.claude'));
    const path = join(root, '.claude', '.credentials.json');
    await fs.writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: 'account-a' } }));
    const coordinator = new ProviderQuotaCoordinator(root);
    const get = coordinator.get.bind(coordinator);
    vi.spyOn(coordinator, 'get').mockImplementationOnce(async (...args) => {
      await fs.writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: 'account-b' } }));
      return get(...args);
    });
    const observe = vi.spyOn(coordinator, 'observe');
    const fetchMock = vi.fn(async () => Response.json({ five_hour: { utilization: 70 } }));
    vi.stubGlobal('fetch', fetchMock);
    const first = service(vi.fn(), 'anthropic', coordinator);
    expect((await first.service.get('anthropic', 'a')).status).toBe('unsupported');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    const oldKey = createHash('sha256')
      .update('anthropic\0')
      .update(JSON.stringify(['https://api.anthropic.com/api/oauth/usage', 'account-a']))
      .digest('hex');
    await expect(fs.stat(join(root, oldKey, 'snapshot.json'))).rejects.toThrow();
    expect(await first.service.get('anthropic', 'a')).toMatchObject({
      status: 'available',
    });
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0]?.[2]).toContain('account-b');
    const oldPoll = vi.fn(async () => ({ ...available(9), providerID: 'anthropic' }));
    await get(
      JSON.stringify(['https://api.anthropic.com/api/oauth/usage', 'account-a']),
      'a',
      oldPoll,
      'anthropic'
    );
    expect(oldPoll).toHaveBeenCalledOnce();
  });

  it.each(['openai', 'anthropic'])(
    'validates external %s credentials at notification delivery without network',
    async (providerID) => {
      const directory = join(root, providerID === 'openai' ? '.codex' : '.claude');
      await fs.mkdir(directory);
      vi.stubEnv('CODEX_HOME', join(root, '.codex'));
      const path = join(directory, providerID === 'openai' ? 'auth.json' : '.credentials.json');
      const credentials = (account: string) =>
        JSON.stringify(
          providerID === 'openai'
            ? { tokens: { access_token: 'same-token', account_id: account } }
            : { claudeAiOauth: { accessToken: account } }
        );
      await fs.writeFile(path, credentials('account-a'));
      const fetchMock = vi.fn(async () =>
        Response.json(
          providerID === 'openai'
            ? { rate_limit: { primary_window: { used_percent: 20 } } }
            : { five_hour: { utilization: 20 } }
        )
      );
      vi.stubGlobal('fetch', fetchMock);
      const notify = vi.fn();
      const first = service(notify, providerID);
      const second = service(undefined, providerID);
      await first.service.get(providerID, 'a');
      now += 30_001;
      await second.service.get(providerID, 'remote');
      await fs.writeFile(path, credentials('account-b'));
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      expect(notify).not.toHaveBeenCalled();
      // The same observation still delivers when its actual credential scope is restored.
      await fs.writeFile(path, credentials('account-a'));
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(first.server.request).toHaveBeenCalledOnce();
    }
  );

  it('drops raw API observation when Anthropic starts merging a local statusline', async () => {
    await fs.writeFile(
      auth.path,
      JSON.stringify({ anthropic: { type: 'oauth', access: 'account-a' } })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ five_hour: { utilization: 20 } }))
    );
    const notify = vi.fn();
    const first = service(notify, 'anthropic');
    await first.service.get('anthropic', 'a');
    expect(vi.getTimerCount()).toBe(1);
    await fs.mkdir(join(root, '.onwatch', 'data'), { recursive: true });
    await fs.writeFile(
      join(root, '.onwatch', 'data', 'anthropic-statusline.json'),
      JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 80 } },
      })
    );
    const merged = await first.service.get('anthropic', 'a');
    expect(merged).toMatchObject({ windows: [expect.objectContaining({ percent: 80 })] });
    expect(vi.getTimerCount()).toBe(0);
    now += 30_001;
    await service(undefined, 'anthropic').service.get('anthropic', 'remote');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(notify).not.toHaveBeenCalled();
  });

  it('pushes another host snapshot only for requested workspace/model scopes without network reads', async () => {
    await fs.writeFile(
      auth.path,
      JSON.stringify({ openrouter: { type: 'api', key: 'account-a' } })
    );
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: { limit: 10, usage: 2 } }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const notify = vi.fn();
    const first = service(notify);
    const second = service();
    await first.service.get('openrouter', 'a', '/repo');
    await first.service.get('openrouter', 'b', '/other');
    expect(vi.getTimerCount()).toBe(1);
    now += 30_001;
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { limit: 10, usage: 7 } }))
    );
    await second.service.get('openrouter', 'remote', '/repo');
    const requests = first.server.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(notify.mock.calls.map(([update]) => update)).toEqual([
      {
        directory: '/repo',
        status: expect.objectContaining({
          providerID: 'openrouter',
          modelID: 'a',
          windows: [expect.objectContaining({ remaining: 3 })],
        }),
      },
      {
        directory: '/other',
        status: expect.objectContaining({
          providerID: 'openrouter',
          modelID: 'b',
          windows: [expect.objectContaining({ remaining: 3 })],
        }),
      },
    ]);
    expect(first.server.request).toHaveBeenCalledTimes(requests);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(notify).toHaveBeenCalledTimes(2);
    first.service.clearCache();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suppresses old account snapshots after credentials change, even before cache invalidation', async () => {
    await fs.writeFile(
      auth.path,
      JSON.stringify({ openrouter: { type: 'api', key: 'account-a' } })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { limit: 10, usage: 2 } })))
    );
    const notify = vi.fn();
    const first = service(notify);
    const second = service();
    await first.service.get('openrouter', 'a', '/repo');
    now += 30_001;
    await second.service.get('openrouter', 'remote', '/repo');
    await fs.writeFile(
      auth.path,
      JSON.stringify({ openrouter: { type: 'api', key: 'account-b' } })
    );
    await vi.advanceTimersByTimeAsync(2_000);
    // Wait for a full reconciliation, including the asynchronous credential read.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    expect(notify).not.toHaveBeenCalled();
    first.service.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds scopes, expires idle observations, and does not start timers for unrequested scopes', async () => {
    const coordinator = new ProviderQuotaCoordinator(root);
    const owner = Symbol();
    owners.push({ coordinator, owner });
    const notify = vi.fn(async () => true);
    expect(vi.getTimerCount()).toBe(0);
    for (let index = 0; index < 140; index++) {
      coordinator.observe(owner, String(index), 'token', available(5), notify);
    }
    expect(vi.getTimerCount()).toBe(1);
    await coordinator.get('token', 'a', async () => available(3));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(128));
    now += 5 * 60_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(128);
  });

  it('does not deliver a snapshot older than the last publication it observed', async () => {
    const coordinator = new ProviderQuotaCoordinator(root);
    const owner = Symbol();
    owners.push({ coordinator, owner });
    const initial = await coordinator.get('token', 'a', async () => available(5));
    const [directory] = await fs.readdir(root);
    const snapshotPath = join(root, directory!, 'snapshot.json');
    const previous = await fs.readFile(snapshotPath, 'utf8');
    const notify = vi.fn(async () => true);
    coordinator.observe(owner, 'scope', 'token', initial, notify);
    now += 30_001;
    await coordinator.get('token', 'a', async () => available(3));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    await fs.writeFile(snapshotPath, previous);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    expect(notify).toHaveBeenCalledOnce();
  });

  it('retries delivery rejected during an account check on the next reconciliation', async () => {
    const coordinator = new ProviderQuotaCoordinator(root);
    const owner = Symbol();
    owners.push({ coordinator, owner });
    const initial = await coordinator.get('token', 'a', async () => available(5));
    const notify = vi.fn(async () => true).mockResolvedValueOnce(false);
    coordinator.observe(owner, 'scope', 'token', initial, notify);
    now += 30_001;
    await coordinator.get('token', 'a', async () => available(3));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
  });

  it.each(['clearCache', 'dispose'] as const)(
    'does not register late requests after %s',
    async (operation) => {
      await fs.writeFile(
        auth.path,
        JSON.stringify({ openrouter: { type: 'api', key: 'account-a' } })
      );
      let release!: (response: Response) => void;
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      );
      vi.stubGlobal('fetch', fetchMock);
      const notify = vi.fn();
      const first = service(notify);
      const pending = first.service.get('openrouter', 'a', '/repo');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      first.service[operation]();
      release(new Response(JSON.stringify({ data: { limit: 10, usage: 2 } })));
      await pending;
      expect(vi.getTimerCount()).toBe(0);
      expect(notify).not.toHaveBeenCalled();
    }
  );

  it('invalidates asynchronous notifications when a scope is replaced or cleared', async () => {
    const coordinator = new ProviderQuotaCoordinator(root);
    const owner = Symbol();
    owners.push({ coordinator, owner });
    const initial = await coordinator.get('token', 'a', async () => available(5));
    let current: (() => boolean) | undefined;
    const notify = vi.fn(async (_status: ProviderLimitStatus, isCurrent: () => boolean) => {
      current = isCurrent;
      return true;
    });
    coordinator.observe(owner, 'scope', 'token', initial, notify);
    now += 30_001;
    await new ProviderQuotaCoordinator(root).get('token', 'a', async () => available(3));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(current?.()).toBe(true);
    coordinator.observe(owner, 'scope', 'new-account', initial, notify);
    expect(current?.()).toBe(false);
    coordinator.clearObservations(owner);
    expect(vi.getTimerCount()).toBe(0);
  });
});
