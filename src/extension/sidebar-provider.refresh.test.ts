import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachTestView,
  createServer,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';

const vscodeMock = getVscodeMock();

type ProviderRefreshAccess = {
  refreshProviderState(): Promise<void>;
  setProviderWatchActive(active: boolean): void;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('SidebarProvider provider refresh', () => {
  it('watches every global config candidate and coalesces unchanged events', async () => {
    vi.useFakeTimers();
    const server = createServer();
    const { provider } = await createSidebarProviderInstance({ server });
    (provider as unknown as ProviderRefreshAccess).setProviderWatchActive(true);

    expect(vscodeMock.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(4);
    const patterns = vscodeMock.workspace.createFileSystemWatcher.mock.calls.map(
      ([pattern]: [{ pattern: string }]) => pattern.pattern
    );
    expect(patterns).toEqual(['config.json', 'opencode.json', 'opencode.jsonc', 'auth.json']);

    for (const result of vscodeMock.workspace.createFileSystemWatcher.mock.results.slice(0, 3)) {
      const watcher = result.value as { onDidChange: ReturnType<typeof vi.fn> };
      watcher.onDidChange.mock.calls[0]?.[0]();
    }
    await vi.advanceTimersByTimeAsync(300);

    expect(server.restart).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('refreshes the UI immediately and defers a managed restart until work is idle', async () => {
    vi.useFakeTimers();
    let statusRequestCount = 0;
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/question') return [];
        if (path === '/session/status') {
          statusRequestCount += 1;
          return statusRequestCount <= 6 ? { active: { type: 'busy' } } : {};
        }
        return undefined;
      }),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);
    posted.length = 0;

    await access.refreshProviderState();

    expect(server.restart).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/refresh' });

    await vi.advanceTimersByTimeAsync(6_000);

    expect(server.restart).toHaveBeenCalledOnce();
    expect(
      posted.filter(
        (message) =>
          !!message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'providers/refresh'
      )
    ).toHaveLength(2);
    await provider.dispose();
  });

  it('never restarts an unmanaged server during provider refresh', async () => {
    const server = createServer({
      readServerInfo: vi.fn(async () => ({ managedProcess: false })),
      request: vi.fn(),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);

    await (provider as unknown as ProviderRefreshAccess).refreshProviderState();

    expect(server.request).not.toHaveBeenCalled();
    expect(server.restart).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/refresh' });
    await provider.dispose();
  });

  it('keeps waiting while normal server startup exceeds the bounded retry window', async () => {
    vi.useFakeTimers();
    const server = createServer({
      status: { state: 'starting' },
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/status' ? {} : []
      ),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);

    await access.refreshProviderState();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(server.readServerInfo).not.toHaveBeenCalled();
    expect(server.restart).not.toHaveBeenCalled();

    server.status = { state: 'running', url: 'http://127.0.0.1:4096' };
    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.restart).toHaveBeenCalledOnce();
    await provider.dispose();
  });

  it('cancels a startup wait when provider watching is deactivated', async () => {
    vi.useFakeTimers();
    const server = createServer({ status: { state: 'starting' } });
    const { provider } = await createSidebarProviderInstance({ server });
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);

    await access.refreshProviderState();
    access.setProviderWatchActive(false);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(server.readServerInfo).not.toHaveBeenCalled();
    expect(server.restart).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('bounds retries when server ownership cannot be determined', async () => {
    vi.useFakeTimers();
    const server = createServer({
      readServerInfo: vi.fn(() => Promise.reject(new Error('unavailable'))),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);

    await access.refreshProviderState();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(server.readServerInfo).toHaveBeenCalledTimes(6);
    expect(server.restart).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('shuts down Ralph before completing provider disposal', async () => {
    const { provider } = await createSidebarProviderInstance();
    const ralphHost = (provider as unknown as { ralphHost: { dispose(): Promise<void> } })
      .ralphHost;
    const serverEventBridge = (
      provider as unknown as { serverEventBridge: { dispose(): Promise<void> } }
    ).serverEventBridge;
    const dispose = vi.spyOn(ralphHost, 'dispose');
    const disposeBridge = vi.spyOn(serverEventBridge, 'dispose');

    await provider.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
      disposeBridge.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
  });
});
