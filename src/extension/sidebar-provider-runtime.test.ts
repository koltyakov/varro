import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  errorHub: {
    report: vi.fn(),
    reportCliMissing: vi.fn(),
  },
  logger: {
    error: vi.fn(),
  },
}));

vi.mock('./error-hub', () => ({ errorHub: mocks.errorHub }));
vi.mock('./logger', () => ({ logger: mocks.logger }));

import type { RecycleBinEntry, ServerEvent, ServerStatus } from '../shared/protocol';
import { SidebarProviderRuntime } from './sidebar-provider-runtime';

const RUNNING_STATUS: ServerStatus = { state: 'running', url: 'http://127.0.0.1:4096' };

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRecycleBinEntry(rootID: string, sessionIDs: string[]): RecycleBinEntry {
  return {
    rootID,
    deletedAt: 1,
    expiresAt: 2,
    root: {
      id: rootID,
      projectID: 'project-1',
      directory: '/repo',
      title: rootID,
      version: '1',
      time: { created: 1, updated: 2 },
    },
    sessions: sessionIDs.map((id) => ({
      id,
      projectID: 'project-1',
      directory: '/repo',
      title: id,
      version: '1',
      time: { created: 1, updated: 2 },
    })),
  };
}

function createRuntime(options?: {
  serverStatus?: ServerStatus;
  cleanupExpired?: (
    callback: (sessionID: string) => Promise<unknown>
  ) => Promise<RecycleBinEntry[]>;
  isHidden?: (sessionID: string) => boolean;
  start?: () => Promise<string>;
}) {
  const server = {
    request: vi.fn(() => Promise.resolve(undefined)),
    start: vi.fn(options?.start ?? (() => Promise.resolve('http://127.0.0.1:4096'))),
    status: options?.serverStatus ?? ({ state: 'stopped' } satisfies ServerStatus),
  };
  const sessionState = {
    removeSessions: vi.fn(),
  };
  const sessionTrash = {
    cleanupExpired: vi.fn(options?.cleanupExpired ?? (() => Promise.resolve([]))),
    isHidden: vi.fn(options?.isHidden ?? (() => false)),
    list: vi.fn(),
  };

  return {
    runtime: new SidebarProviderRuntime(server, sessionState, sessionTrash, 1_000),
    server,
    sessionState,
    sessionTrash,
  };
}

describe('SidebarProviderRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the running server url without restarting and resets repeated error state after success', async () => {
    const startError = new Error('socket busy');
    const { runtime, server } = createRuntime({
      start: vi.fn(() => Promise.reject(startError)),
    });

    await expect(runtime.ensureServerStarted()).rejects.toThrow(startError.message);
    expect(mocks.errorHub.report).toHaveBeenCalledWith({
      code: 'server-start',
      message: 'Failed to start OpenCode server: socket busy',
    });

    server.status = RUNNING_STATUS;
    await expect(runtime.ensureServerStarted()).resolves.toBe(RUNNING_STATUS.url);
    expect(server.start).toHaveBeenCalledTimes(1);

    server.status = { state: 'stopped' };
    await expect(runtime.ensureServerStarted()).rejects.toThrow(startError.message);
    expect(mocks.errorHub.report).toHaveBeenCalledTimes(2);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('reuses the in-flight start while the server is starting', async () => {
    const { runtime, server } = createRuntime({
      serverStatus: { state: 'starting' },
    });

    await expect(runtime.ensureServerStarted()).resolves.toBe('http://127.0.0.1:4096');

    expect(server.start).toHaveBeenCalledOnce();
    expect(mocks.errorHub.report).not.toHaveBeenCalled();
  });

  it('reports cli-missing failures once and logs repeated identical failures', async () => {
    const startError = new Error('OpenCode CLI not found in PATH');
    const { runtime } = createRuntime({
      start: vi.fn(() => Promise.reject(startError)),
    });

    await expect(runtime.ensureServerStarted()).rejects.toThrow(startError.message);
    await expect(runtime.ensureServerStarted()).rejects.toThrow(startError.message);

    expect(mocks.errorHub.reportCliMissing).toHaveBeenCalledOnce();
    expect(mocks.errorHub.reportCliMissing).toHaveBeenCalledWith(startError.message);
    expect(mocks.errorHub.report).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Failed to start OpenCode server: OpenCode CLI not found in PATH'
    );
  });

  it('cleans up expired recycle-bin sessions once per interval and ignores overlapping runs', async () => {
    const cleanup = createDeferred<RecycleBinEntry[]>();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(2_000);

    const { runtime, server, sessionState, sessionTrash } = createRuntime({
      cleanupExpired: vi.fn(async (removeSession) => {
        await removeSession('session one');
        return cleanup.promise;
      }),
    });

    const firstRun = runtime.cleanupExpiredRecycleBin(RUNNING_STATUS);
    const overlappingRun = runtime.cleanupExpiredRecycleBin(RUNNING_STATUS);

    expect(sessionTrash.cleanupExpired).toHaveBeenCalledTimes(1);
    expect(server.request).toHaveBeenCalledWith('DELETE', '/session/session%20one');

    cleanup.resolve([
      createRecycleBinEntry('root-1', ['session-1', 'session-2']),
      createRecycleBinEntry('root-2', ['session-3']),
    ]);
    await Promise.all([firstRun, overlappingRun]);

    expect(sessionState.removeSessions).toHaveBeenCalledWith([
      'session-1',
      'session-2',
      'session-3',
    ]);

    now.mockReturnValue(2_500);
    await runtime.cleanupExpiredRecycleBin(RUNNING_STATUS);
    expect(sessionTrash.cleanupExpired).toHaveBeenCalledTimes(1);

    now.mockReturnValue(3_500);
    await runtime.cleanupExpiredRecycleBin({ state: 'stopped' });
    expect(sessionTrash.cleanupExpired).toHaveBeenCalledTimes(1);
  });

  it('suppresses events for hidden sessions discovered anywhere in the payload', () => {
    const { runtime, sessionTrash } = createRuntime({
      isHidden: (sessionID) => sessionID === 'session-hidden',
    });
    const event: ServerEvent = {
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-visible',
        info: { id: 'message-1', sessionID: 'session-hidden' },
        part: { sessionID: 'session-part' },
      },
    };

    expect(runtime.shouldSuppressServerEvent(event)).toBe(true);
    expect(sessionTrash.isHidden).toHaveBeenCalledWith('session-visible');
    expect(sessionTrash.isHidden).toHaveBeenCalledWith('message-1');
    expect(sessionTrash.isHidden).toHaveBeenCalledWith('session-hidden');
  });
});
