/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- These refresh tests inspect controlled provider internals and model opaque server and filesystem results. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeModelRouting } from '../shared/opencode-types';
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
  providerFileRefresh: {
    readFilesSignature(): Promise<string>;
    refreshState(generation?: number, requireSignatureChange?: boolean): Promise<void>;
  };
  providerLimitService: { clearCache(): void };
  refreshOpenCodeWorkspaceState(
    previousRouting?: OpenCodeModelRouting,
    currentRouting?: OpenCodeModelRouting
  ): Promise<void>;
  sessionState: { markSessionBusy(sessionID: string): unknown };
  setProviderWatchActive(active: boolean): void;
  startProviderFileObservation(): void;
  providerAuthChanged(): Promise<void>;
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

  it('refreshes providers after an auth change without opening the Models view', async () => {
    vi.useFakeTimers();
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/status' ? {} : []
      ),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);

    (provider as unknown as ProviderRefreshAccess).startProviderFileObservation();
    await vi.advanceTimersByTimeAsync(0);

    expect(vscodeMock.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(4);
    expect(vscodeMock.workspace.createFileSystemWatcher.mock.calls).toEqual([
      [expect.objectContaining({ pattern: 'config.json' })],
      [expect.objectContaining({ pattern: 'opencode.json' })],
      [expect.objectContaining({ pattern: 'opencode.jsonc' })],
      [expect.objectContaining({ pattern: 'auth.json' })],
    ]);

    posted.length = 0;
    providerFileSystem.stat.mockResolvedValue({
      ino: 1,
      isFile: () => true,
      mtimeMs: 1,
      size: 6,
    });
    providerFileSystem.readFile.mockResolvedValue(Buffer.from('logout'));
    const authWatcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[3]?.value as
      | { onDidChange: ReturnType<typeof vi.fn> }
      | undefined;
    authWatcher?.onDidChange.mock.calls[0]?.[0]();
    await vi.advanceTimersByTimeAsync(300);

    expect(server.request).toHaveBeenCalledWith('POST', '/global/dispose');
    expect(server.restart).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/refresh' });
    expect(posted).toContainEqual({ type: 'providers/refresh' });
    await provider.dispose();
  });

  it('reloads only the provider catalog when requested by the webview', async () => {
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question') return [];
        return undefined;
      }),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const access = provider as unknown as ProviderRefreshAccess;
    const clearCache = vi.spyOn(access.providerLimitService, 'clearCache');
    const refreshState = vi.spyOn(access.providerFileRefresh, 'refreshState');

    await provider.handleMessage({ type: 'providers/refresh' });

    expect(clearCache).toHaveBeenCalledOnce();
    expect(refreshState).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/refresh' });
    await provider.dispose();
  });

  it('acknowledges embedded reauthentication without restarting OpenCode', async () => {
    vi.useFakeTimers();
    const server = createServer();
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const access = provider as unknown as ProviderRefreshAccess;

    access.startProviderFileObservation();
    await vi.advanceTimersByTimeAsync(0);
    posted.length = 0;
    providerFileSystem.stat.mockResolvedValue({
      ino: 1,
      isFile: () => true,
      mtimeMs: 2,
      size: 6,
    });
    providerFileSystem.readFile.mockResolvedValue(Buffer.from('reauth'));
    const authWatcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[3]?.value as
      | { onDidChange: ReturnType<typeof vi.fn> }
      | undefined;
    authWatcher?.onDidChange.mock.calls[0]?.[0]();

    await provider.handleMessage({ type: 'providers/auth-changed' });
    await vi.advanceTimersByTimeAsync(300);

    expect(server.restart).not.toHaveBeenCalled();
    expect(server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
    expect(server.request).not.toHaveBeenCalledWith('POST', '/instance/dispose');
    expect(posted).toContainEqual({ type: 'providers/refresh' });
    await provider.dispose();
  });

  it('cancels a deferred auth-file restart after embedded reauthentication', async () => {
    vi.useFakeTimers();
    let idle = false;
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/question' || path === '/permission') return [];
        if (path === '/session/status') return idle ? {} : { active: { type: 'busy' } };
        return undefined;
      }),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const access = provider as unknown as ProviderRefreshAccess;

    access.startProviderFileObservation();
    await vi.advanceTimersByTimeAsync(0);
    posted.length = 0;
    providerFileSystem.stat.mockResolvedValue({
      ino: 1,
      isFile: () => true,
      mtimeMs: 2,
      size: 6,
    });
    providerFileSystem.readFile.mockResolvedValue(Buffer.from('reauth'));
    const authWatcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[3]?.value as
      | { onDidChange: ReturnType<typeof vi.fn> }
      | undefined;
    authWatcher?.onDidChange.mock.calls[0]?.[0]();
    await vi.advanceTimersByTimeAsync(300);

    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: true } });

    await provider.handleMessage({ type: 'providers/auth-changed' });
    idle = true;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.restart).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: false } });
    expect(posted).toContainEqual({ type: 'providers/refresh' });
    await provider.dispose();
  });

  it('cancels a restored deferred auth-only restart after embedded reauthentication', async () => {
    vi.useFakeTimers();
    const values = new Map<string, unknown>([
      [
        'varro.providerRefresh.pending',
        {
          version: 3,
          scope: 'global',
          revalidateAuth: true,
          source: 'auth',
        },
      ],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) =>
        values.has(key) ? values.get(key) : fallback
      ),
      update: vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) values.delete(key);
        else values.set(key, value);
      }),
    };
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/status' ? { active: { type: 'busy' } } : []
      ),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({
      server,
      workspaceState: workspaceState as never,
    });
    const { posted } = attachTestView(provider);

    await provider.handleMessage({ type: 'providers/auth-changed' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.restart).not.toHaveBeenCalled();
    expect(values.has('varro.providerRefresh.pending')).toBe(false);
    expect(posted).toContainEqual({ type: 'providers/refresh' });
    await provider.dispose();
  });

  it('preserves a concurrent config refresh after embedded reauthentication', async () => {
    vi.useFakeTimers();
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/status' ? {} : []
      ),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const access = provider as unknown as ProviderRefreshAccess;

    access.startProviderFileObservation();
    await vi.advanceTimersByTimeAsync(0);
    providerFileSystem.stat.mockResolvedValue({
      ino: 1,
      isFile: () => true,
      mtimeMs: 2,
      size: 6,
    });
    providerFileSystem.readFile.mockResolvedValue(Buffer.from('changed'));
    const authWatcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[3]?.value as
      | { onDidChange: ReturnType<typeof vi.fn> }
      | undefined;
    const configWatcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]?.value as
      | { onDidChange: ReturnType<typeof vi.fn> }
      | undefined;
    authWatcher?.onDidChange.mock.calls[0]?.[0]();
    configWatcher?.onDidChange.mock.calls[0]?.[0]();

    await provider.handleMessage({ type: 'providers/auth-changed' });

    expect(server.request).toHaveBeenCalledWith('POST', '/global/dispose');
    expect(server.restart).not.toHaveBeenCalled();
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

    const first = await access.providerFileRefresh.readFilesSignature();
    await access.initializeProviderFileSignature();
    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);
    posted.length = 0;

    mtimeMs = 20;
    const second = await access.providerFileRefresh.readFilesSignature();
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
    expect(vscodeMock.workspace.createFileSystemWatcher.mock.calls).toEqual([
      [expect.objectContaining({ pattern: 'config.json' })],
      [expect.objectContaining({ pattern: 'opencode.json' })],
      [expect.objectContaining({ pattern: 'opencode.jsonc' })],
      [expect.objectContaining({ pattern: 'auth.json' })],
    ]);

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

    await (provider as unknown as ProviderRefreshAccess).providerFileRefresh.refreshState(
      undefined,
      true
    );

    expect(server.request).toHaveBeenCalledWith('POST', '/global/dispose');
    expect(server.restart).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('refreshes the UI immediately and defers managed invalidation until work is idle', async () => {
    vi.useFakeTimers();
    let statusRequestCount = 0;
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/question' || path === '/permission') return [];
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

    await access.providerFileRefresh.refreshState();

    expect(server.restart).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/refresh' });
    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: true } });

    await vi.advanceTimersByTimeAsync(6_000);

    expect(server.request).toHaveBeenCalledWith('POST', '/global/dispose');
    expect(server.restart).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: false } });
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

  it('queues a workspace config reload until active work is idle', async () => {
    vi.useFakeTimers();
    let idle = false;
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/question' || path === '/permission') return [];
        if (path === '/session/status') return idle ? {} : { active: { type: 'busy' } };
        return true;
      }),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);
    posted.length = 0;

    await access.refreshOpenCodeWorkspaceState();

    expect(server.request).not.toHaveBeenCalledWith('POST', '/instance/dispose');
    expect(server.restart).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: true } });

    idle = true;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.request).toHaveBeenCalledWith('POST', '/instance/dispose');
    expect(server.restart).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: false } });
    await provider.dispose();
  });

  it('cancels a queued workspace reload when model routing is reverted', async () => {
    vi.useFakeTimers();
    let idle = false;
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/question' || path === '/permission') return [];
        if (path === '/session/status') return idle ? {} : { active: { type: 'busy' } };
        return true;
      }),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);
    posted.length = 0;
    const original = {
      smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
      agentModels: {},
      commitMessageModel: null,
      autoApproveModel: null,
    } satisfies OpenCodeModelRouting;
    const changed = {
      ...original,
      smallModel: { providerID: 'openai', modelID: 'gpt-5-nano' },
    } satisfies OpenCodeModelRouting;

    await access.refreshOpenCodeWorkspaceState(original, changed);
    await access.refreshOpenCodeWorkspaceState(changed, original);

    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: true } });
    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: false } });
    idle = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.request).not.toHaveBeenCalledWith('POST', '/instance/dispose');
    expect(server.restart).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('reloads immediately when only stale local busy state remains', async () => {
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question' || path === '/permission') return [];
        return true;
      }),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const access = provider as unknown as ProviderRefreshAccess;
    access.sessionState.markSessionBusy('stale-session');

    await access.refreshOpenCodeWorkspaceState();

    expect(server.request).toHaveBeenCalledWith('POST', '/instance/dispose');
    expect(posted).not.toContainEqual({
      type: 'providers/status',
      payload: { pending: true },
    });
    await provider.dispose();
  });

  it('replays a deferred provider refresh after the webview reloads', async () => {
    vi.useFakeTimers();
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/status' ? { active: { type: 'busy' } } : []
      ),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);
    posted.length = 0;

    await access.providerFileRefresh.refreshState();
    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: true } });

    posted.length = 0;
    await provider.handleMessage({ type: 'ready' });

    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: true } });
    await provider.dispose();
  });

  it('restores and completes a deferred provider refresh after a window reload', async () => {
    vi.useFakeTimers();
    const values = new Map<string, unknown>();
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) =>
        values.has(key) ? values.get(key) : fallback
      ),
      update: vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) values.delete(key);
        else values.set(key, value);
      }),
    };
    const busyServer = createServer({
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/status' ? { active: { type: 'busy' } } : []
      ),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const first = await createSidebarProviderInstance({
      server: busyServer,
      workspaceState: workspaceState as never,
    });
    const firstAccess = first.provider as unknown as ProviderRefreshAccess;
    firstAccess.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);

    await firstAccess.providerFileRefresh.refreshState();
    expect(values.get('varro.providerRefresh.pending')).toEqual({
      version: 3,
      scope: 'global',
      revalidateAuth: false,
      source: 'config',
    });
    await first.provider.dispose();

    let idle = false;
    const restoredServer = createServer({
      status: { state: 'stopped' },
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/question' || path === '/permission') return [];
        if (path === '/session/status') return idle ? {} : { active: { type: 'busy' } };
        return undefined;
      }),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const second = await createSidebarProviderInstance({
      server: restoredServer,
      workspaceState: workspaceState as never,
    });
    const { posted } = attachTestView(second.provider);
    const secondAccess = second.provider as unknown as ProviderRefreshAccess;
    secondAccess.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);

    await second.provider.handleMessage({ type: 'ready' });
    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: true } });

    restoredServer.status = { state: 'running', url: 'http://127.0.0.1:4096' };
    for (const [, listener] of restoredServer.on.mock.calls.filter(
      ([event]) => event === 'status'
    )) {
      listener(restoredServer.status);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(restoredServer.restart).not.toHaveBeenCalled();

    idle = true;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(restoredServer.request).toHaveBeenCalledWith('POST', '/global/dispose');
    expect(restoredServer.restart).not.toHaveBeenCalled();
    expect(values.has('varro.providerRefresh.pending')).toBe(false);
    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: false } });
    await second.provider.dispose();
  });

  it('invalidates an unmanaged server without restarting during provider refresh', async () => {
    const server = createServer({
      readServerInfo: vi.fn(async () => ({ managedProcess: false })),
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question' || path === '/permission') return [];
        return true;
      }),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);

    await (provider as unknown as ProviderRefreshAccess).providerFileRefresh.refreshState();

    expect(server.request).toHaveBeenCalledWith('POST', '/global/dispose');
    expect(server.restart).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'providers/refresh' });

    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(server.readServerInfo).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('invalidates a stale unmanaged server when provider watching opens', async () => {
    const server = createServer({
      readServerInfo: vi.fn(async () => ({ managedProcess: false })),
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question' || path === '/permission') return [];
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

  it('resumes pending managed invalidation when provider watching is reopened', async () => {
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
        if (path === '/question' || path === '/permission') return [];
        if (path === '/session/status') return idle ? {} : { active: { type: 'busy' } };
        return undefined;
      }),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);

    await access.providerFileRefresh.refreshState();
    expect(server.restart).not.toHaveBeenCalled();

    access.setProviderWatchActive(false);
    idle = true;
    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(server.request).toHaveBeenCalledWith('POST', '/global/dispose');
    expect(server.restart).not.toHaveBeenCalled();

    access.setProviderWatchActive(false);
    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.request.mock.calls.filter(([, path]) => path === '/global/dispose')).toHaveLength(
      1
    );
    expect(server.restart).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('clears a queued notice without invalidating again when watching toggles during disposal', async () => {
    vi.useFakeTimers();
    let resolveDispose!: (value: boolean) => void;
    let idle = false;
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/session/status') return idle ? {} : { active: { type: 'busy' } };
        if (path === '/global/dispose') {
          return new Promise<boolean>((resolve) => {
            resolveDispose = resolve;
          });
        }
        return [];
      }),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);

    await access.providerFileRefresh.refreshState();
    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: true } });

    idle = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.request.mock.calls.filter(([, path]) => path === '/global/dispose')).toHaveLength(
      1
    );

    access.setProviderWatchActive(false);
    resolveDispose(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(posted).toContainEqual({ type: 'providers/status', payload: { pending: false } });

    access.setProviderWatchActive(true);
    await vi.advanceTimersByTimeAsync(50);

    expect(server.request.mock.calls.filter(([, path]) => path === '/global/dispose')).toHaveLength(
      1
    );
    expect(server.restart).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('preserves a newer file change while global disposal is in flight', async () => {
    vi.useFakeTimers();
    let content = 'initial';
    let resolveFirstDispose!: (value: boolean) => void;
    let disposeCount = 0;
    providerFileSystem.stat.mockImplementation(async () => ({
      ino: 1,
      isFile: () => true,
      mtimeMs: 1,
      size: content.length,
    }));
    providerFileSystem.readFile.mockImplementation(async () => Buffer.from(content));
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question' || path === '/permission') return [];
        if (path === '/global/dispose') {
          disposeCount += 1;
          if (disposeCount === 1) {
            return new Promise<boolean>((resolve) => {
              resolveFirstDispose = resolve;
            });
          }
          return true;
        }
        return undefined;
      }),
      readServerInfo: vi.fn(async () => ({ managedProcess: true })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const access = provider as unknown as ProviderRefreshAccess;
    access.startProviderFileObservation();
    await vi.advanceTimersByTimeAsync(0);
    const configWatcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]?.value as
      | { onDidChange: ReturnType<typeof vi.fn> }
      | undefined;

    content = 'first';
    configWatcher?.onDidChange.mock.calls[0]?.[0]();
    await vi.advanceTimersByTimeAsync(300);
    expect(disposeCount).toBe(1);

    content = 'second';
    configWatcher?.onDidChange.mock.calls[0]?.[0]();
    await vi.advanceTimersByTimeAsync(300);
    expect(disposeCount).toBe(1);

    resolveFirstDispose(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(disposeCount).toBe(2);
    expect(server.restart).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('does not continue toward restart fallback after disposal during an ownership check', async () => {
    let resolveOwnership!: (value: { managedProcess: boolean }) => void;
    const ownership = new Promise<{ managedProcess: boolean }>((resolve) => {
      resolveOwnership = resolve;
    });
    const server = createServer({
      readServerInfo: vi.fn(() => ownership),
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question' || path === '/permission') return [];
        if (path === '/global/dispose') throw new Error('dispose failed');
        return undefined;
      }),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const refresh = (
      provider as unknown as ProviderRefreshAccess
    ).providerFileRefresh.refreshState();
    await vi.waitFor(() => expect(server.readServerInfo).toHaveBeenCalledOnce());

    const dispose = provider.dispose();
    resolveOwnership({ managedProcess: true });
    await Promise.all([refresh, dispose]);

    expect(server.request).toHaveBeenCalledWith('POST', '/global/dispose');
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

    await access.providerFileRefresh.refreshState();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(server.readServerInfo).not.toHaveBeenCalled();
    expect(server.restart).not.toHaveBeenCalled();

    server.status = { state: 'running', url: 'http://127.0.0.1:4096' };
    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.request).toHaveBeenCalledWith('POST', '/global/dispose');
    expect(server.restart).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('cancels a startup wait when provider watching is deactivated', async () => {
    vi.useFakeTimers();
    const server = createServer({ status: { state: 'starting' } });
    const { provider } = await createSidebarProviderInstance({ server });
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);

    await access.providerFileRefresh.refreshState();
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
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question' || path === '/permission') return [];
        if (path === '/global/dispose') throw new Error('dispose unavailable');
        return undefined;
      }),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const access = provider as unknown as ProviderRefreshAccess;
    access.setProviderWatchActive(true);

    await access.providerFileRefresh.refreshState();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(server.readServerInfo).toHaveBeenCalledTimes(6);
    expect(server.request.mock.calls.filter(([, path]) => path === '/global/dispose')).toHaveLength(
      6
    );
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
