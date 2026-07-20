import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachTestView,
  createServer,
  createSidebarProviderInstance,
  getLoggerMock,
  getProviderSignatureFileSystemMock,
  getVscodeMock,
} from './sidebar-provider.test-support';

const vscodeMock = getVscodeMock();
const loggerMock = getLoggerMock();
const providerFileSystem = getProviderSignatureFileSystemMock();

type ProviderRefreshAccess = {
  initializeProviderFileSignature(): Promise<void>;
  readProviderFilesSignature(): Promise<string>;
  refreshProviderState(generation?: number, requireSignatureChange?: boolean): Promise<void>;
  setProviderWatchActive(active: boolean): void;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('SidebarProvider provider refresh', () => {
  it('does not read provider files synchronously during construction', async () => {
    const { provider } = await createSidebarProviderInstance();

    expect(providerFileSystem.stat).not.toHaveBeenCalled();
    expect(providerFileSystem.readFile).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('does not read provider signature content from non-regular files', async () => {
    providerFileSystem.stat.mockResolvedValue({
      ino: 1,
      isFile: () => false,
      mtimeMs: 1,
      size: 0,
    });
    const { provider } = await createSidebarProviderInstance();

    await (provider as unknown as ProviderRefreshAccess).initializeProviderFileSignature();

    expect(providerFileSystem.stat).toHaveBeenCalledTimes(4);
    expect(providerFileSystem.readFile).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('reads regular targets reached through known symlink paths', async () => {
    providerFileSystem.stat.mockResolvedValue({
      ino: 42,
      isFile: () => true,
      mtimeMs: 10,
      size: 6,
    });
    providerFileSystem.readFile.mockResolvedValue(Buffer.from('config'));
    const { provider } = await createSidebarProviderInstance();

    await (provider as unknown as ProviderRefreshAccess).initializeProviderFileSignature();

    expect(providerFileSystem.stat).toHaveBeenCalledTimes(4);
    expect(providerFileSystem.readFile).toHaveBeenCalledTimes(4);
    await provider.dispose();
  });

  it('changes oversized signatures when target metadata changes without reading content', async () => {
    vi.useFakeTimers();
    let mtimeMs = 10;
    providerFileSystem.stat.mockImplementation(async () => ({
      ino: 42,
      isFile: () => true,
      mtimeMs,
      size: 1024 * 1024 + 1,
    }));
    const server = createServer({
      readServerInfo: vi.fn(async () => ({ managedProcess: false })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const access = provider as unknown as ProviderRefreshAccess;

    const first = await access.readProviderFilesSignature();
    await access.initializeProviderFileSignature();
    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);
    posted.length = 0;

    mtimeMs = 20;
    const second = await access.readProviderFilesSignature();
    const watcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]?.value as
      | { onDidChange: ReturnType<typeof vi.fn> }
      | undefined;
    watcher?.onDidChange.mock.calls[0]?.[0]();
    await vi.advanceTimersByTimeAsync(300);

    expect(first).toContain('oversized:size=1048577:mtime=10:ino=42');
    expect(second).toContain('oversized:size=1048577:mtime=20:ino=42');
    expect(second).not.toBe(first);
    expect(providerFileSystem.readFile).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/refresh' });
    await provider.dispose();
  });

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

  it('invalidates when a watcher event wins the initial signature race', async () => {
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/status' ? {} : []
      ),
    });
    const { provider } = await createSidebarProviderInstance({ server });

    await (provider as unknown as ProviderRefreshAccess).refreshProviderState(undefined, true);

    expect(server.restart).toHaveBeenCalledOnce();
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

  it('invalidates an unmanaged server without restarting during provider refresh', async () => {
    const server = createServer({
      readServerInfo: vi.fn(async () => ({ managedProcess: false })),
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question') return [];
        return true;
      }),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);

    await (provider as unknown as ProviderRefreshAccess).refreshProviderState();

    expect(server.request).toHaveBeenCalledWith('POST', '/global/dispose');
    expect(server.restart).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/refresh' });

    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(server.readServerInfo).toHaveBeenCalledTimes(2);
    await provider.dispose();
  });

  it('invalidates a stale unmanaged server when provider watching opens', async () => {
    const server = createServer({
      readServerInfo: vi.fn(async () => ({ managedProcess: false })),
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question') return [];
        return true;
      }),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const access = provider as unknown as ProviderRefreshAccess;
    await access.initializeProviderFileSignature();

    access.setProviderWatchActive(true);

    await vi.waitFor(() => expect(server.request).toHaveBeenCalledWith('POST', '/global/dispose'));
    expect(server.restart).not.toHaveBeenCalled();

    access.setProviderWatchActive(false);
    access.setProviderWatchActive(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(server.request.mock.calls.filter(([, path]) => path === '/global/dispose')).toHaveLength(
      1
    );
    await provider.dispose();
  });

  it('resumes a pending managed restart when provider watching is reopened', async () => {
    vi.useFakeTimers();
    let idle = false;
    providerFileSystem.stat.mockResolvedValue({
      ino: 1,
      isFile: () => true,
      mtimeMs: 1,
      size: 6,
    });
    providerFileSystem.readFile.mockResolvedValue(Buffer.from('config'));
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/question') return [];
        return idle ? {} : { active: { type: 'busy' } };
      }),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);

    await access.refreshProviderState();
    expect(server.restart).not.toHaveBeenCalled();

    access.setProviderWatchActive(false);
    idle = true;
    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(server.restart).toHaveBeenCalledOnce();

    access.setProviderWatchActive(false);
    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.restart).toHaveBeenCalledOnce();
    await provider.dispose();
  });

  it('does not restart again when provider watching toggles during an in-flight restart', async () => {
    let resolveRestart!: (url: string) => void;
    const server = createServer({
      restart: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveRestart = resolve;
          })
      ),
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/status' ? {} : []
      ),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);

    const refresh = access.refreshProviderState();
    await vi.waitFor(() => expect(server.restart).toHaveBeenCalledOnce());

    access.setProviderWatchActive(false);
    resolveRestart('http://127.0.0.1:4096');
    await refresh;

    access.setProviderWatchActive(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.restart).toHaveBeenCalledOnce();
    await provider.dispose();
  });

  it('does not continue toward a restart after disposal during an ownership check', async () => {
    let resolveOwnership!: (value: { managedProcess: boolean }) => void;
    const ownership = new Promise<{ managedProcess: boolean }>((resolve) => {
      resolveOwnership = resolve;
    });
    const server = createServer({
      readServerInfo: vi.fn(() => ownership),
      request: vi.fn(),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const refresh = (provider as unknown as ProviderRefreshAccess).refreshProviderState();
    await vi.waitFor(() => expect(server.readServerInfo).toHaveBeenCalledOnce());

    const dispose = provider.dispose();
    resolveOwnership({ managedProcess: true });
    await Promise.all([refresh, dispose]);

    expect(server.request).not.toHaveBeenCalled();
    expect(server.restart).not.toHaveBeenCalled();
  });

  it('returns and catches resolver failures with the webview fallback', async () => {
    const { provider } = await createSidebarProviderInstance();
    const { view } = attachTestView(provider);
    const webviewSession = (
      provider as unknown as { webviewSession: { resolve: ReturnType<typeof vi.fn> } }
    ).webviewSession;
    vi.spyOn(webviewSession, 'resolve').mockRejectedValueOnce(new Error('resolver failed'));

    await provider.resolveWebviewView(view as never, {} as never, {} as never);

    expect(view.webview.html).toBe('<p>Failed to load Varro webview. Please reload.</p>');
    expect(loggerMock.error).toHaveBeenCalledWith('resolveWebviewView failed: resolver failed');
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
