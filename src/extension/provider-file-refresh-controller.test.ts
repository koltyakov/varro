/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- These tests verify watcher integration with partial VS Code events and controlled private controller state. */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeModelRouting } from '../shared/opencode-types';
import type { ServerStatus } from '../shared/protocol';

type WatcherMock = {
  onDidCreate: ReturnType<typeof vi.fn>;
  onDidChange: ReturnType<typeof vi.fn>;
  onDidDelete: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

const { loggerMock, vscodeMock, configPathsMock, authFilePathMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  vscodeMock: {
    workspace: {
      createFileSystemWatcher: vi.fn(),
    },
    RelativePattern: class RelativePattern {
      constructor(
        public readonly base: unknown,
        public readonly pattern: string
      ) {}
    },
    Uri: {
      file: vi.fn((fsPath: string) => ({ fsPath })),
    },
  },
  configPathsMock: vi.fn((): string[] => []),
  authFilePathMock: vi.fn((): string => ''),
}));

vi.mock('vscode', () => vscodeMock);
vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('./open-code-process', () => ({ getOpenCodeConfigPaths: configPathsMock }));
vi.mock('./util/provider-limit', () => ({ getOpenCodeAuthFilePath: authFilePathMock }));

import { ProviderFileRefreshController } from './provider-file-refresh-controller';

const CONFIG_PATHS = [
  '/home/tester/.config/opencode/config.json',
  '/home/tester/.config/opencode/opencode.json',
  '/home/tester/.config/opencode/opencode.jsonc',
] as const;
const AUTH_PATH = '/home/tester/.local/share/opencode/auth.json';
const PENDING_STATE_KEY = 'varro.providerRefresh.pending';
const DEBOUNCE_MS = 250;
const RETRY_MS = 1_000;

type TestFileStats = {
  size: number;
  mtimeMs: number;
  ino: number;
  isFile(): boolean;
};

function enoent(): Error {
  return Object.assign(new Error('missing file'), { code: 'ENOENT' });
}

function createFileSystemMock(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const stat = vi.fn((path: string): Promise<TestFileStats> => {
    const content = files.get(path);
    if (content === undefined) return Promise.reject(enoent());
    return Promise.resolve({ size: content.length, mtimeMs: 1, ino: 1, isFile: () => true });
  });
  const readFile = vi.fn((path: string): Promise<Uint8Array> => {
    const content = files.get(path);
    if (content === undefined) return Promise.reject(enoent());
    return Promise.resolve(new Uint8Array(Buffer.from(content)));
  });
  return { files, stat, readFile };
}

function createHarness(
  options: {
    files?: Record<string, string>;
    managedProcess?: boolean;
    persisted?: unknown;
    workspaceDirectories?: string[];
  } = {}
) {
  const fileSystem = createFileSystemMock(options.files);
  let idle = true;
  const server = {
    status: { state: 'running', url: 'http://127.0.0.1:4096' } as ServerStatus,
    on: vi.fn(),
    off: vi.fn(),
    restart: vi.fn(async () => 'http://127.0.0.1:4096'),
    readRestartBlockers: vi.fn(
      async (): Promise<{
        totalSessionCount: number;
        directories: Array<{ directory: string | null; sessionCount: number }>;
      }> =>
        idle
          ? { totalSessionCount: 0, directories: [] }
          : {
              totalSessionCount: 1,
              directories: [{ directory: '/repo', sessionCount: 1 }],
            }
    ),
    readServerInfo: vi.fn(async () => ({ managedProcess: options.managedProcess ?? true })),
    request: vi.fn(async (_method: string, path: string) => {
      if (path === '/session/status') return idle ? {} : { active: { type: 'busy' } };
      if (path === '/question' || path === '/permission') return [];
      return undefined;
    }),
  };
  const values = new Map<string, unknown>();
  if (options.persisted !== undefined) values.set(PENDING_STATE_KEY, options.persisted);
  const persistence = {
    get: vi.fn((key: string) => values.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    remove: vi.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
  };
  const clearProviderLimitCache = vi.fn();
  const postRefresh = vi.fn((_options?: { revalidateAuth: true }) => {});
  const postPendingStatus = vi.fn((_pending: boolean) => {});
  const controller = new ProviderFileRefreshController(
    {
      server: server as never,
      persistence: persistence as never,
      clearProviderLimitCache,
      postRefresh,
      postPendingStatus,
      getWorkspaceDirectories: () => options.workspaceDirectories ?? [],
    },
    fileSystem
  );
  return {
    controller,
    fileSystem,
    server,
    persistence,
    values,
    clearProviderLimitCache,
    postRefresh,
    postPendingStatus,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

function fireWatcherEvent(
  index: number,
  kind: 'onDidCreate' | 'onDidChange' | 'onDidDelete' = 'onDidChange'
) {
  const watcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[index]?.value as
    | WatcherMock
    | undefined;
  watcher?.[kind].mock.calls[0]?.[0]();
}

function emitStatusEvent(server: { on: ReturnType<typeof vi.fn> }, status: ServerStatus) {
  for (const call of server.on.mock.calls) {
    if (call[0] === 'status') (call[1] as (value: ServerStatus) => void)(status);
  }
}

function routing(modelID: string): OpenCodeModelRouting {
  return {
    smallModel: { providerID: 'openai', modelID },
    agentModels: {},
    commitMessageModel: null,
    autoApproveModel: null,
  };
}

async function activateWatching(h: Harness) {
  await h.controller.initializeSignature();
  h.controller.setActive(true);
  await vi.advanceTimersByTimeAsync(0);
}

function resetCalls(h: Harness) {
  h.server.restart.mockClear();
  h.server.readRestartBlockers.mockClear();
  h.server.request.mockClear();
  h.server.readServerInfo.mockClear();
  h.persistence.set.mockClear();
  h.persistence.remove.mockClear();
  h.clearProviderLimitCache.mockClear();
  h.postRefresh.mockClear();
  h.postPendingStatus.mockClear();
}

function watcherMocks(): WatcherMock[] {
  return vscodeMock.workspace.createFileSystemWatcher.mock.results.map(
    (result) => result.value as WatcherMock
  );
}

function globalDisposeCallCount(h: Harness) {
  return h.server.request.mock.calls.filter(([, path]) => path === '/global/dispose').length;
}

describe('ProviderFileRefreshController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vscodeMock.workspace.createFileSystemWatcher.mockImplementation(() => ({
      onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
    }));
    configPathsMock.mockReturnValue([...CONFIG_PATHS]);
    authFilePathMock.mockReturnValue(AUTH_PATH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction and persisted state', () => {
    it('subscribes to server status without touching provider files', () => {
      const h = createHarness();

      expect(h.server.on).toHaveBeenCalledWith('status', expect.any(Function));
      expect(h.persistence.get).toHaveBeenCalledWith(PENDING_STATE_KEY);
      expect(h.fileSystem.stat).not.toHaveBeenCalled();
    });

    it('restores a v3 auth-sourced pending refresh and reloads it on embedded auth change', async () => {
      const h = createHarness({
        persisted: { version: 3, scope: 'global', revalidateAuth: true, source: 'auth' },
      });

      h.controller.postStatus();
      expect(h.postPendingStatus).toHaveBeenCalledWith(true);

      await h.controller.acknowledgeEmbeddedAuthChange();

      expect(h.persistence.remove).toHaveBeenCalledWith(PENDING_STATE_KEY);
      expect(h.postPendingStatus).toHaveBeenCalledWith(false);
      expect(h.postRefresh).toHaveBeenLastCalledWith({ revalidateAuth: true });
      expect(h.server.restart).toHaveBeenCalledOnce();
      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
    });

    it('restores the workspace directory for a pending scoped refresh', async () => {
      const h = createHarness({
        persisted: {
          version: 4,
          scope: 'workspace',
          revalidateAuth: false,
          source: 'config',
          workspaceDirectories: ['/repo-b'],
        },
      });

      emitStatusEvent(h.server, { state: 'running', url: 'http://127.0.0.1:4096' });
      await vi.advanceTimersByTimeAsync(0);

      expect(h.server.request).toHaveBeenCalledWith('POST', '/instance/dispose', undefined, {
        directory: '/repo-b',
      });
    });

    it('completes a restored v1 pending refresh when the server reaches running state', async () => {
      const h = createHarness({ persisted: { version: 1, revalidateAuth: true } });

      h.controller.postStatus();
      expect(h.postPendingStatus).toHaveBeenCalledWith(true);

      emitStatusEvent(h.server, { state: 'stopped' });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.server.restart).not.toHaveBeenCalled();

      emitStatusEvent(h.server, { state: 'running', url: 'http://127.0.0.1:4096' });
      await vi.advanceTimersByTimeAsync(0);

      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).toHaveBeenCalledOnce();
      expect(h.persistence.remove).toHaveBeenCalledWith(PENDING_STATE_KEY);
      expect(h.postPendingStatus).toHaveBeenCalledWith(false);
    });

    it('ignores malformed persisted pending state', async () => {
      const h = createHarness({
        persisted: { version: 2, scope: 'galactic', revalidateAuth: true },
      });

      h.controller.postStatus();
      expect(h.postPendingStatus).toHaveBeenCalledWith(false);

      emitStatusEvent(h.server, { state: 'running', url: 'http://127.0.0.1:4096' });
      await vi.advanceTimersByTimeAsync(0);

      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.persistence.set).not.toHaveBeenCalled();
    });
  });

  describe('activation and watching', () => {
    it('creates one watcher per config candidate plus the auth file, idempotently', () => {
      const h = createHarness();
      h.controller.setActive(true);

      expect(vscodeMock.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(4);
      expect(vscodeMock.workspace.createFileSystemWatcher.mock.calls).toEqual([
        [
          expect.objectContaining({
            base: { fsPath: '/home/tester/.config/opencode' },
            pattern: 'config.json',
          }),
        ],
        [
          expect.objectContaining({
            base: { fsPath: '/home/tester/.config/opencode' },
            pattern: 'opencode.json',
          }),
        ],
        [
          expect.objectContaining({
            base: { fsPath: '/home/tester/.config/opencode' },
            pattern: 'opencode.jsonc',
          }),
        ],
        [
          expect.objectContaining({
            base: { fsPath: '/home/tester/.local/share/opencode' },
            pattern: 'auth.json',
          }),
        ],
      ]);

      h.controller.setActive(true);
      expect(vscodeMock.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(4);
    });

    it('activates without invalidation when the signature is unchanged and the server is managed', async () => {
      const h = createHarness();

      await activateWatching(h);

      expect(h.postRefresh).toHaveBeenCalledTimes(1);
      expect(h.server.readServerInfo).toHaveBeenCalledOnce();
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.persistence.set).not.toHaveBeenCalled();
    });

    it('invalidates a stale unmanaged server when watching opens', async () => {
      const h = createHarness({ managedProcess: false });

      await activateWatching(h);

      expect(h.server.request).toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.persistence.set).toHaveBeenCalledWith(PENDING_STATE_KEY, {
        version: 3,
        scope: 'global',
        revalidateAuth: false,
        source: 'config',
      });
      expect(h.persistence.remove).toHaveBeenCalledWith(PENDING_STATE_KEY);
      expect(h.postRefresh).toHaveBeenCalledTimes(2);
    });

    it('marks a pending refresh when files changed while watching was inactive', async () => {
      const h = createHarness({ files: { [AUTH_PATH]: 'v1' } });
      await h.controller.initializeSignature();
      h.fileSystem.files.set(AUTH_PATH, 'v2');

      h.controller.setActive(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.server.request).toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.persistence.set).toHaveBeenCalledWith(
        PENDING_STATE_KEY,
        expect.objectContaining({ scope: 'global' })
      );
    });

    it('logs a warning when activation cannot read provider files', async () => {
      const h = createHarness();
      configPathsMock
        .mockImplementationOnce(() => [...CONFIG_PATHS])
        .mockImplementation(() => {
          throw new Error('config paths unavailable');
        });

      h.controller.setActive(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Failed to activate provider file observation: config paths unavailable'
      );
    });

    it('deactivating disposes watchers and stops deferred restart retries', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await activateWatching(h);
      resetCalls(h);
      h.setIdle(false);
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');
      fireWatcherEvent(0);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(h.postPendingStatus).toHaveBeenCalledWith(true);
      expect(h.server.restart).not.toHaveBeenCalled();

      const watchers = watcherMocks();
      h.controller.setActive(false);
      for (const watcher of watchers) expect(watcher.dispose).toHaveBeenCalledOnce();
      expect(vscodeMock.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(4);

      h.setIdle(true);
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      expect(h.server.restart).not.toHaveBeenCalled();
    });
  });

  describe('watcher event handling', () => {
    it('debounces watcher events before refreshing', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await activateWatching(h);
      resetCalls(h);
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');
      fireWatcherEvent(0);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.postRefresh).not.toHaveBeenCalled();
      expect(h.clearProviderLimitCache).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(h.server.request).toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.clearProviderLimitCache).toHaveBeenCalled();
      expect(h.postRefresh).toHaveBeenCalled();
      expect(h.persistence.set).toHaveBeenCalledWith(PENDING_STATE_KEY, {
        version: 3,
        scope: 'global',
        revalidateAuth: false,
        source: 'config',
      });
    });

    it('coalesces rapid changes into a single refresh', async () => {
      const h = createHarness({ files: { [AUTH_PATH]: 'a1', [CONFIG_PATHS[0]]: 'c1' } });
      await activateWatching(h);
      resetCalls(h);
      h.fileSystem.files.set(AUTH_PATH, 'a2');
      h.fileSystem.files.set(CONFIG_PATHS[0], 'c2');
      fireWatcherEvent(0);
      fireWatcherEvent(1);
      fireWatcherEvent(2);
      fireWatcherEvent(3);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(globalDisposeCallCount(h)).toBe(0);
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.persistence.set).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(h.server.restart).toHaveBeenCalledOnce();
    });

    it('ignores events when the signature is unchanged', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await activateWatching(h);
      resetCalls(h);
      fireWatcherEvent(0);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);

      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.postRefresh).not.toHaveBeenCalled();
      expect(h.persistence.set).not.toHaveBeenCalled();
      expect(h.clearProviderLimitCache).not.toHaveBeenCalled();
    });

    it('handles create and delete events like changes', async () => {
      const h = createHarness({
        files: { [CONFIG_PATHS[1]]: 'v1', [AUTH_PATH]: 'a1' },
      });
      await activateWatching(h);
      resetCalls(h);

      h.fileSystem.files.set(CONFIG_PATHS[1], 'v2');
      fireWatcherEvent(1, 'onDidCreate');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(globalDisposeCallCount(h)).toBe(1);
      expect(h.server.restart).not.toHaveBeenCalled();

      h.fileSystem.files.delete(AUTH_PATH);
      fireWatcherEvent(3, 'onDidDelete');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(globalDisposeCallCount(h)).toBe(1);

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(globalDisposeCallCount(h)).toBe(1);
      expect(h.server.restart).toHaveBeenCalledOnce();
    });

    it('revalidates auth after an auth-only change', async () => {
      const h = createHarness({ files: { [AUTH_PATH]: 'a1' } });
      await activateWatching(h);
      resetCalls(h);
      h.fileSystem.files.set(AUTH_PATH, 'a2');
      fireWatcherEvent(3);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.postPendingStatus).toHaveBeenCalledWith(true);

      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).toHaveBeenCalledOnce();
      expect(h.persistence.set).toHaveBeenCalledWith(PENDING_STATE_KEY, {
        version: 3,
        scope: 'global',
        revalidateAuth: true,
        source: 'auth',
      });
      expect(h.postRefresh).toHaveBeenLastCalledWith({ revalidateAuth: true });
    });

    it('uses global dispose for an unmanaged auth change', async () => {
      const h = createHarness({ files: { [AUTH_PATH]: 'a1' }, managedProcess: false });
      await activateWatching(h);
      resetCalls(h);
      h.fileSystem.files.set(AUTH_PATH, 'a2');
      fireWatcherEvent(3);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + RETRY_MS);

      expect(h.server.request).toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.postRefresh).toHaveBeenLastCalledWith({ revalidateAuth: true });
    });

    it('does not invalidate during a transient idle gap after an auth change', async () => {
      const h = createHarness({ files: { [AUTH_PATH]: 'a1' } });
      await activateWatching(h);
      resetCalls(h);
      let statusCheck = 0;
      h.server.request.mockImplementation(async (_method: string, path: string) => {
        if (path === '/session/status') {
          statusCheck += 1;
          return statusCheck === 1 ? {} : { active: { type: 'busy' } };
        }
        if (path === '/question' || path === '/permission') return [];
        return undefined;
      });
      h.fileSystem.files.set(AUTH_PATH, 'a2');
      fireWatcherEvent(3);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + RETRY_MS);

      expect(statusCheck).toBe(2);
      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.values.has(PENDING_STATE_KEY)).toBe(true);
    });

    it('waits for every workspace to become idle before restarting for an auth change', async () => {
      const h = createHarness({
        files: { [AUTH_PATH]: 'a1' },
        workspaceDirectories: ['/repo-a', '/repo-b'],
      });
      await activateWatching(h);
      resetCalls(h);
      let siblingBusy = true;
      h.server.request.mockImplementation(
        async (
          _method: string,
          path: string,
          _body?: unknown,
          options?: { directory?: string }
        ) => {
          if (path === '/session/status') {
            return options?.directory === '/repo-b' && siblingBusy
              ? { active: { type: 'busy' } }
              : {};
          }
          if (path === '/question' || path === '/permission') return [];
          return undefined;
        }
      );
      h.fileSystem.files.set(AUTH_PATH, 'a2');
      fireWatcherEvent(3);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + RETRY_MS);

      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.server.request).toHaveBeenCalledWith('GET', '/session/status', undefined, {
        directory: '/repo-a',
      });
      expect(h.server.request).toHaveBeenCalledWith('GET', '/session/status', undefined, {
        directory: '/repo-b',
      });

      siblingBusy = false;
      await vi.advanceTimersByTimeAsync(2 * RETRY_MS);

      expect(h.server.restart).toHaveBeenCalledOnce();
    });

    it('treats combined auth and config changes as config-sourced', async () => {
      const h = createHarness({ files: { [AUTH_PATH]: 'a1', [CONFIG_PATHS[0]]: 'c1' } });
      await activateWatching(h);
      resetCalls(h);
      h.fileSystem.files.set(AUTH_PATH, 'a2');
      h.fileSystem.files.set(CONFIG_PATHS[0], 'c2');
      fireWatcherEvent(3);
      fireWatcherEvent(0);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(h.persistence.set).toHaveBeenCalledWith(PENDING_STATE_KEY, {
        version: 3,
        scope: 'global',
        revalidateAuth: true,
        source: 'config',
      });
      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(h.server.restart).toHaveBeenCalledOnce();
      expect(h.postRefresh).toHaveBeenLastCalledWith({ revalidateAuth: true });
    });

    it('invalidates immediately when a watcher event wins the initial signature race', async () => {
      const h = createHarness();

      await h.controller.refreshState(undefined, true);

      expect(h.persistence.set).toHaveBeenCalledWith(
        PENDING_STATE_KEY,
        expect.objectContaining({ scope: 'global' })
      );
      expect(h.server.request).toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.postRefresh).toHaveBeenCalled();
    });

    it('preserves a concurrent config change while global dispose is in flight', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'c1' } });
      await activateWatching(h);
      resetCalls(h);
      let resolveFirstDispose!: () => void;
      h.server.request.mockImplementation(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question' || path === '/permission') return [];
        if (path === '/global/dispose' && globalDisposeCallCount(h) === 1) {
          return new Promise<undefined>((resolve) => {
            resolveFirstDispose = () => resolve(undefined);
          });
        }
        return undefined;
      });

      h.fileSystem.files.set(CONFIG_PATHS[0], 'c2');
      fireWatcherEvent(0);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(globalDisposeCallCount(h)).toBe(1);

      h.fileSystem.files.set(CONFIG_PATHS[0], 'c3');
      fireWatcherEvent(0);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(globalDisposeCallCount(h)).toBe(1);
      expect(h.persistence.set).toHaveBeenCalledTimes(2);
      expect(h.persistence.remove).not.toHaveBeenCalled();

      resolveFirstDispose();
      await vi.advanceTimersByTimeAsync(0);

      expect(globalDisposeCallCount(h)).toBe(2);
      expect(h.persistence.remove).toHaveBeenCalledOnce();
      expect(h.values.has(PENDING_STATE_KEY)).toBe(false);
      expect(h.server.restart).not.toHaveBeenCalled();
    });
  });

  describe('invalidation scheduling', () => {
    it('does not globally invalidate while a nested OpenCode instance is busy', async () => {
      const h = createHarness({
        files: { [CONFIG_PATHS[0]]: 'v1' },
        workspaceDirectories: ['/repo'],
      });
      await h.controller.initializeSignature();
      h.server.readRestartBlockers.mockResolvedValue({
        totalSessionCount: 1,
        directories: [{ directory: '/repo/packages/app', sessionCount: 1 }],
      });
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');

      await h.controller.refreshState();

      expect(h.server.readRestartBlockers).toHaveBeenCalledOnce();
      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.values.has(PENDING_STATE_KEY)).toBe(true);
    });

    it('refreshes the UI immediately and defers invalidation until the server is idle', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await activateWatching(h);
      resetCalls(h);
      h.setIdle(false);
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');
      fireWatcherEvent(0);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(h.postRefresh).toHaveBeenCalled();
      expect(h.postPendingStatus).toHaveBeenCalledWith(true);
      expect(h.server.restart).not.toHaveBeenCalled();

      h.setIdle(true);
      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(h.server.request).toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.postPendingStatus).toHaveBeenCalledWith(false);
      expect(h.persistence.remove).toHaveBeenCalledWith(PENDING_STATE_KEY);
    });

    it('waits while the server is starting and invalidates once it is running', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await activateWatching(h);
      resetCalls(h);
      h.server.status = { state: 'starting' };
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');

      await h.controller.refreshState();
      await vi.advanceTimersByTimeAsync(2 * RETRY_MS);

      expect(h.server.readServerInfo).not.toHaveBeenCalled();
      expect(h.server.restart).not.toHaveBeenCalled();

      h.server.status = { state: 'running', url: 'http://127.0.0.1:4096' };
      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(h.server.request).toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
    });

    it('does not schedule retries while the server is stopped', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await h.controller.initializeSignature();
      h.server.status = { state: 'stopped' };
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');

      await h.controller.refreshState();
      await vi.advanceTimersByTimeAsync(5 * RETRY_MS);

      expect(h.server.readServerInfo).not.toHaveBeenCalled();
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.server.request).not.toHaveBeenCalled();
      expect(h.postRefresh).toHaveBeenCalled();
    });

    it('bounds retries when server ownership cannot be determined', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await activateWatching(h);
      resetCalls(h);
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');
      h.server.readServerInfo.mockRejectedValue(new Error('unavailable'));
      h.server.request.mockImplementation(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question' || path === '/permission') return [];
        if (path === '/global/dispose') throw new Error('dispose unavailable');
        return undefined;
      });

      await h.controller.refreshState();
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);

      expect(h.server.readServerInfo).toHaveBeenCalledTimes(6);
      expect(globalDisposeCallCount(h)).toBe(6);
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.values.has(PENDING_STATE_KEY)).toBe(true);
      expect(loggerMock.info).toHaveBeenCalledWith(
        'Provider refresh invalidation remained deferred after bounded retries'
      );
    });

    it('restarts a managed server when global dispose fails', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await h.controller.initializeSignature();
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');
      h.server.request.mockImplementation(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question' || path === '/permission') return [];
        if (path === '/global/dispose') throw new Error('dispose failed');
        return undefined;
      });

      await h.controller.refreshState();

      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Provider global dispose failed; restarting managed server: dispose failed'
      );
      expect(h.server.readServerInfo).toHaveBeenCalledOnce();
      expect(
        h.server.request.mock.invocationCallOrder.find(
          (_, index) => h.server.request.mock.calls[index]?.[1] === '/global/dispose'
        )
      ).toBeLessThan(
        h.server.readServerInfo.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
      );
      expect(h.server.restart).toHaveBeenCalledOnce();
      expect(h.persistence.remove).toHaveBeenCalledWith(PENDING_STATE_KEY);
    });

    it('keeps an unmanaged failed dispose pending without restarting', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await activateWatching(h);
      resetCalls(h);
      h.server.readServerInfo.mockResolvedValue({ managedProcess: false });
      h.server.request.mockImplementation(async (_method: string, path: string) => {
        if (path === '/session/status') return {};
        if (path === '/question' || path === '/permission') return [];
        if (path === '/global/dispose') throw new Error('dispose failed');
        return undefined;
      });
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');

      await h.controller.refreshState();

      expect(globalDisposeCallCount(h)).toBe(1);
      expect(h.server.readServerInfo).toHaveBeenCalledOnce();
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.values.has(PENDING_STATE_KEY)).toBe(true);

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(globalDisposeCallCount(h)).toBe(2);
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.values.has(PENDING_STATE_KEY)).toBe(true);
    });

    it('invalidates a managed server through global dispose without restarting', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' }, managedProcess: true });
      await h.controller.initializeSignature();
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');

      await h.controller.refreshState();
      await vi.advanceTimersByTimeAsync(0);

      expect(h.server.request.mock.calls.slice(0, 4).map(([, path]) => path)).toEqual([
        '/session/status',
        '/question',
        '/permission',
        '/global/dispose',
      ]);
      expect(h.server.request).toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.readServerInfo).not.toHaveBeenCalled();
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.persistence.remove).toHaveBeenCalledWith(PENDING_STATE_KEY);
      expect(h.postRefresh).toHaveBeenCalled();
    });

    it('continues the refresh flow when persisting the pending state fails', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await h.controller.initializeSignature();
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');
      h.persistence.set.mockRejectedValueOnce(new Error('disk full'));

      await h.controller.refreshState();
      await vi.advanceTimersByTimeAsync(0);

      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Failed to persist provider refresh state: disk full'
      );
      expect(h.server.request).toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.postRefresh).toHaveBeenCalled();
    });

    it('continues the refresh flow when clearing the persisted state fails', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await h.controller.initializeSignature();
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');
      h.persistence.remove.mockRejectedValueOnce(new Error('locked'));

      await h.controller.refreshState();
      await vi.advanceTimersByTimeAsync(0);

      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Failed to clear provider refresh state: locked'
      );
      expect(h.server.request).toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.postRefresh).toHaveBeenCalled();
    });
  });

  describe('workspace refresh', () => {
    it('disposes the workspace instance whose config changed', async () => {
      const h = createHarness();
      await activateWatching(h);
      resetCalls(h);

      await h.controller.refreshWorkspaceState(
        routing('gpt-5-mini'),
        routing('gpt-5-nano'),
        '/repo-b'
      );

      expect(h.server.request).toHaveBeenCalledWith('POST', '/instance/dispose', undefined, {
        directory: '/repo-b',
      });
    });

    it('queues a workspace reload until the server is idle', async () => {
      const h = createHarness();
      await activateWatching(h);
      resetCalls(h);
      h.setIdle(false);

      await h.controller.refreshWorkspaceState(routing('gpt-5-mini'), routing('gpt-5-nano'));

      expect(h.persistence.set).toHaveBeenCalledWith(PENDING_STATE_KEY, {
        version: 3,
        scope: 'workspace',
        revalidateAuth: false,
        source: 'config',
      });
      expect(h.postRefresh).toHaveBeenCalled();
      expect(h.postPendingStatus).toHaveBeenCalledWith(true);
      expect(h.server.readServerInfo).not.toHaveBeenCalled();
      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/instance/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();

      h.setIdle(true);
      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(h.server.request).toHaveBeenCalledWith('POST', '/instance/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.postPendingStatus).toHaveBeenCalledWith(false);
      expect(h.persistence.remove).toHaveBeenCalledWith(PENDING_STATE_KEY);
    });

    it('cancels a queued workspace reload when routing is reverted', async () => {
      const h = createHarness();
      await activateWatching(h);
      resetCalls(h);
      h.setIdle(false);
      const original = routing('gpt-5-mini');
      const changed = routing('gpt-5-nano');

      await h.controller.refreshWorkspaceState(original, changed);
      await h.controller.refreshWorkspaceState(changed, original);

      expect(h.persistence.remove).toHaveBeenCalledWith(PENDING_STATE_KEY);
      expect(h.postPendingStatus).toHaveBeenCalledWith(false);

      h.setIdle(true);
      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/instance/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
    });

    it('cancels a scoped workspace reload when that folder routing is reverted', async () => {
      const h = createHarness();
      await activateWatching(h);
      resetCalls(h);
      h.setIdle(false);
      const original = routing('gpt-5-mini');
      const changed = routing('gpt-5-nano');

      await h.controller.refreshWorkspaceState(original, changed, '/repo-a');
      await h.controller.refreshWorkspaceState(changed, original, '/repo-a');

      expect(h.persistence.remove).toHaveBeenCalledWith(PENDING_STATE_KEY);
      expect(h.postPendingStatus).toHaveBeenCalledWith(false);

      h.setIdle(true);
      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/instance/dispose', undefined, {
        directory: '/repo-a',
      });
    });

    it('does not supersede a pending workspace refresh with an unchanged sibling update', async () => {
      const h = createHarness();
      await activateWatching(h);
      resetCalls(h);
      h.setIdle(false);

      await h.controller.refreshWorkspaceState(
        routing('gpt-5-mini'),
        routing('gpt-5-nano'),
        '/repo-a'
      );
      await h.controller.refreshWorkspaceState(
        routing('gpt-5-mini'),
        routing('gpt-5-mini'),
        '/repo-b'
      );
      h.setIdle(true);
      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(h.server.request).toHaveBeenCalledWith('POST', '/instance/dispose', undefined, {
        directory: '/repo-a',
      });
    });

    it('skips pending work when routing is unchanged', async () => {
      const h = createHarness();
      await activateWatching(h);
      resetCalls(h);
      const same = routing('gpt-5-mini');

      await h.controller.refreshWorkspaceState(same, same);

      expect(h.persistence.set).not.toHaveBeenCalled();
      expect(h.postRefresh).toHaveBeenCalledOnce();
      expect(h.postPendingStatus).not.toHaveBeenCalled();
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.server.request).not.toHaveBeenCalled();
    });
  });

  describe('embedded auth changes', () => {
    it('keeps a deferred auth-only invalidation until the server is idle', async () => {
      const h = createHarness({ files: { [AUTH_PATH]: 'a1' } });
      await activateWatching(h);
      resetCalls(h);
      h.setIdle(false);
      h.fileSystem.files.set(AUTH_PATH, 'a2');
      fireWatcherEvent(3);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(h.postPendingStatus).toHaveBeenCalledWith(true);
      expect(h.server.restart).not.toHaveBeenCalled();

      await h.controller.acknowledgeEmbeddedAuthChange();

      expect(h.persistence.remove).not.toHaveBeenCalledWith(PENDING_STATE_KEY);
      expect(h.postRefresh).toHaveBeenCalled();
      expect(h.server.restart).not.toHaveBeenCalled();

      h.setIdle(true);
      await vi.advanceTimersByTimeAsync(2 * RETRY_MS);
      expect(h.server.restart).toHaveBeenCalledOnce();
      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/instance/dispose');
      expect(h.persistence.remove).toHaveBeenCalledWith(PENDING_STATE_KEY);
      expect(h.postPendingStatus).toHaveBeenCalledWith(false);
      expect(h.postRefresh).toHaveBeenLastCalledWith({ revalidateAuth: true });
    });

    it('coalesces a late auth watcher event after embedded acknowledgement', async () => {
      const h = createHarness({ files: { [AUTH_PATH]: 'a1' } });
      await activateWatching(h);
      h.fileSystem.files.set(AUTH_PATH, 'a2');

      await h.controller.acknowledgeEmbeddedAuthChange();
      resetCalls(h);
      fireWatcherEvent(3);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(h.persistence.set).not.toHaveBeenCalled();
      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.postRefresh).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).toHaveBeenCalledOnce();
      expect(h.postRefresh).toHaveBeenLastCalledWith({ revalidateAuth: true });
    });

    it('preserves a concurrent config change across embedded acknowledgement', async () => {
      const h = createHarness({ files: { [AUTH_PATH]: 'a1', [CONFIG_PATHS[0]]: 'c1' } });
      await activateWatching(h);
      resetCalls(h);
      h.fileSystem.files.set(AUTH_PATH, 'a2');
      h.fileSystem.files.set(CONFIG_PATHS[0], 'c2');
      fireWatcherEvent(3);
      fireWatcherEvent(0);

      await h.controller.acknowledgeEmbeddedAuthChange();

      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(h.server.request).not.toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).toHaveBeenCalledOnce();
      expect(h.persistence.set).toHaveBeenCalledWith(
        PENDING_STATE_KEY,
        expect.objectContaining({ scope: 'global' })
      );
      expect(h.postRefresh).toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('stops watching, clears timers, and unsubscribes from status events', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await activateWatching(h);
      resetCalls(h);
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');
      fireWatcherEvent(0);

      const registered = h.server.on.mock.calls.find(([event]) => event === 'status');
      h.controller.dispose();

      for (const watcher of watcherMocks()) expect(watcher.dispose).toHaveBeenCalledOnce();
      expect(h.server.off).toHaveBeenCalledWith('status', registered?.[1]);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + RETRY_MS);

      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.postRefresh).not.toHaveBeenCalled();
      expect(h.clearProviderLimitCache).not.toHaveBeenCalled();
    });

    it('beginDispose cancels a scheduled refresh', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      await activateWatching(h);
      resetCalls(h);
      h.fileSystem.files.set(CONFIG_PATHS[0], 'v2');
      fireWatcherEvent(0);

      h.controller.beginDispose();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + RETRY_MS);

      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.postRefresh).not.toHaveBeenCalled();
      expect(h.clearProviderLimitCache).not.toHaveBeenCalled();
    });
  });

  describe('file signatures', () => {
    it('hashes file contents into a joined signature', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'config', [AUTH_PATH]: 'auth' } });

      const signature = await h.controller.readFilesSignature();

      const expected = [
        `${CONFIG_PATHS[0]}:${createHash('sha256').update('config').digest('hex')}`,
        `${CONFIG_PATHS[1]}:missing`,
        `${CONFIG_PATHS[2]}:missing`,
        `${AUTH_PATH}:${createHash('sha256').update('auth').digest('hex')}`,
      ].join('|');
      expect(signature).toBe(expected);
    });

    it('distinguishes unavailable files from missing and non-regular files', async () => {
      const h = createHarness();
      h.fileSystem.stat.mockImplementation(async (path: string) => {
        if (path === CONFIG_PATHS[0]) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return { size: 0, mtimeMs: 0, ino: 0, isFile: () => false };
      });

      const signature = await h.controller.readFilesSignature();

      expect(signature).toBe(
        [
          `${CONFIG_PATHS[0]}:unavailable`,
          `${CONFIG_PATHS[1]}:ignored`,
          `${CONFIG_PATHS[2]}:ignored`,
          `${AUTH_PATH}:ignored`,
        ].join('|')
      );
    });

    it('skips content reads for non-regular files', async () => {
      const h = createHarness({ files: { [CONFIG_PATHS[0]]: 'v1' } });
      h.fileSystem.stat.mockImplementation(async () => ({
        size: 4,
        mtimeMs: 5,
        ino: 6,
        isFile: () => false,
      }));

      const signature = await h.controller.readFilesSignature();

      expect(signature).toBe(
        [
          `${CONFIG_PATHS[0]}:ignored`,
          `${CONFIG_PATHS[1]}:ignored`,
          `${CONFIG_PATHS[2]}:ignored`,
          `${AUTH_PATH}:ignored`,
        ].join('|')
      );
      expect(h.fileSystem.readFile).not.toHaveBeenCalled();
    });

    it('signatures oversized files from metadata without reading content', async () => {
      const h = createHarness();
      h.fileSystem.stat.mockImplementation(async (path: string) => {
        if (path === CONFIG_PATHS[0]) {
          return { size: 1024 * 1024 + 1, mtimeMs: 10, ino: 42, isFile: () => true };
        }
        throw enoent();
      });

      const signature = await h.controller.readFilesSignature();

      expect(signature).toBe(
        [
          `${CONFIG_PATHS[0]}:oversized:size=1048577:mtime=10:ino=42`,
          `${CONFIG_PATHS[1]}:missing`,
          `${CONFIG_PATHS[2]}:missing`,
          `${AUTH_PATH}:missing`,
        ].join('|')
      );
      expect(h.fileSystem.readFile).not.toHaveBeenCalled();
    });

    it('flags content that exceeds the size cap after stat', async () => {
      const h = createHarness();
      h.fileSystem.stat.mockImplementation(async (path: string) => {
        if (path === AUTH_PATH) {
          return { size: 5, mtimeMs: 1, ino: 1, isFile: () => true };
        }
        throw enoent();
      });
      h.fileSystem.readFile.mockImplementation(async (path: string) => {
        if (path === AUTH_PATH) return Buffer.alloc(1024 * 1024 + 1);
        throw enoent();
      });

      const signature = await h.controller.readFilesSignature();

      expect(signature).toBe(
        [
          `${CONFIG_PATHS[0]}:missing`,
          `${CONFIG_PATHS[1]}:missing`,
          `${CONFIG_PATHS[2]}:missing`,
          `${AUTH_PATH}:oversized:size=1048577:mtime=1:ino=1`,
        ].join('|')
      );
    });

    it('times out slow signature reads', async () => {
      const h = createHarness();
      h.fileSystem.stat.mockImplementation((path: string) => {
        if (path === AUTH_PATH) return new Promise<TestFileStats>(() => {});
        return Promise.reject(enoent());
      });

      const pending = h.controller.readFilesSignature();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toBe(
        [
          `${CONFIG_PATHS[0]}:missing`,
          `${CONFIG_PATHS[1]}:missing`,
          `${CONFIG_PATHS[2]}:missing`,
          `${AUTH_PATH}:unavailable`,
        ].join('|')
      );
    });

    it('captures the initial signature only once', async () => {
      const h = createHarness({ files: { [AUTH_PATH]: 'v1' } });
      await h.controller.initializeSignature();
      h.fileSystem.files.set(AUTH_PATH, 'v2');
      await h.controller.initializeSignature();

      h.controller.setActive(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.server.request).toHaveBeenCalledWith('POST', '/global/dispose');
      expect(h.server.restart).not.toHaveBeenCalled();
      expect(h.persistence.set).toHaveBeenCalledWith(
        PENDING_STATE_KEY,
        expect.objectContaining({ scope: 'global' })
      );
    });

    it('ignores signature reads that complete after disposal', async () => {
      const h = createHarness();
      let resolveStat!: (stats: TestFileStats) => void;
      h.fileSystem.stat.mockImplementation((path: string) => {
        if (path === AUTH_PATH) {
          return new Promise<TestFileStats>((resolve) => {
            resolveStat = resolve;
          });
        }
        return Promise.reject(enoent());
      });

      const initialized = h.controller.initializeSignature();
      h.controller.beginDispose();
      resolveStat({ size: 1, mtimeMs: 1, ino: 1, isFile: () => true });
      await initialized;

      expect(
        (h.controller as unknown as { observedFilesSignature: string | null })
          .observedFilesSignature
      ).toBe(null);
    });
  });
});
