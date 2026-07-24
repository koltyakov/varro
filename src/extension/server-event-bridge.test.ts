import { describe, expect, it, vi } from 'vitest';
import type { ServerStatus } from '../shared/protocol';

const mocks = vi.hoisted(() => ({
  createStatusBarItem: vi.fn(() => ({
    name: '',
    command: '',
    dispose: vi.fn(),
  })),
  parseServerEvent: vi.fn(),
  getSessionIdsForEvent: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: { createStatusBarItem: mocks.createStatusBarItem },
  StatusBarAlignment: { Left: 1 },
}));

vi.mock('../shared/protocol', () => ({
  parseServerEvent: mocks.parseServerEvent,
}));

vi.mock('./sidebar-provider-utils', () => ({
  getSessionIdsForEvent: mocks.getSessionIdsForEvent,
}));

vi.mock('./logger', () => ({
  logger: { warn: mocks.loggerWarn },
}));

import { ServerEventBridge } from './server-event-bridge';
import { HiddenSessionManager } from './hidden-session-manager';

interface CapturedHandlers {
  status: ((status: ServerStatus) => void) | undefined;
  event: ((event: unknown) => void) | undefined;
}

function createMocks(options?: {
  workspacePath?: string | null;
  isSessionInWorkspace?: (sessionID: string, workspacePath: string | null | undefined) => boolean;
  getSessionWorkspaceMatch?: (
    sessionID: string,
    workspacePath: string | null | undefined
  ) => boolean | undefined;
  hiddenSessions?: HiddenSessionManager;
}) {
  const handlers: CapturedHandlers = { status: undefined, event: undefined };
  const server = {
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      if (event === 'status') handlers.status = handler;
      if (event === 'event') handlers.event = handler;
    }),
    off: vi.fn(),
  };
  const sessionState = {
    handleServerEvent: vi.fn(),
    isSessionInWorkspace: vi.fn(options?.isSessionInWorkspace || (() => true)),
    getSessionWorkspaceMatch: vi.fn(
      options?.getSessionWorkspaceMatch || options?.isSessionInWorkspace || (() => true)
    ),
    persist: vi.fn(() => Promise.resolve()),
    flush: vi.fn(() => Promise.resolve()),
  };
  const sessionTrash = { isHidden: vi.fn(() => false) };
  const hiddenSessions = options?.hiddenSessions ?? sessionTrash;
  const providerLimitService = {
    shouldClearCache: vi.fn(() => false),
    clearCache: vi.fn(),
  };
  const post = vi.fn();
  const updateStatusBarItem = vi.fn();
  const bridge = new ServerEventBridge(
    server as never,
    sessionState as never,
    hiddenSessions as never,
    providerLimitService as never,
    post,
    updateStatusBarItem,
    options && 'workspacePath' in options ? { getPath: () => options.workspacePath } : undefined
  );
  return {
    handlers,
    server,
    sessionState,
    sessionTrash,
    providerLimitService,
    post,
    updateStatusBarItem,
    bridge,
  };
}

const RUNNING_STATUS: ServerStatus = { state: 'running', url: 'http://localhost:3000' };
const STARTING_STATUS: ServerStatus = { state: 'starting' };
const ERROR_STATUS: ServerStatus = { state: 'error', message: 'fail' };

describe('ServerEventBridge', () => {
  it('creates a status bar item on construction', () => {
    createMocks();
    expect(mocks.createStatusBarItem).toHaveBeenCalledWith('varro.session-status', 1, 1000);
  });

  it('returns default status { state: "stopped" }', () => {
    const { bridge } = createMocks();
    expect(bridge.getStatus()).toEqual({ state: 'stopped' });
  });

  it('getStatusBarItem returns the created item', () => {
    const { bridge } = createMocks();
    const item = bridge.getStatusBarItem();
    const lastResult = mocks.createStatusBarItem.mock.results.at(-1)!.value;
    expect(item).toBe(lastResult);
  });

  it('attach registers server handlers and calls updateStatusBarItem', () => {
    const { bridge, server, updateStatusBarItem } = createMocks();
    bridge.attach();
    expect(server.on).toHaveBeenCalledWith('status', expect.any(Function));
    expect(server.on).toHaveBeenCalledWith('event', expect.any(Function));
    expect(updateStatusBarItem).toHaveBeenCalledOnce();
  });

  it('status handler updates status and posts server/status', () => {
    const { bridge, handlers, post } = createMocks();
    bridge.attach();
    handlers.status!(RUNNING_STATUS);
    expect(bridge.getStatus()).toBe(RUNNING_STATUS);
    expect(post).toHaveBeenCalledWith({ type: 'server/status', payload: RUNNING_STATUS });
  });

  it('status handler clears provider limit cache when shouldClearCache returns true', () => {
    const { bridge, handlers, providerLimitService } = createMocks();
    providerLimitService.shouldClearCache.mockReturnValue(true);
    bridge.attach();
    handlers.status!(RUNNING_STATUS);
    expect(providerLimitService.shouldClearCache).toHaveBeenCalledWith(
      { state: 'stopped' },
      RUNNING_STATUS
    );
    expect(providerLimitService.clearCache).toHaveBeenCalledOnce();
  });

  it('status handler does not clear cache when shouldClearCache returns false', () => {
    const { bridge, handlers, providerLimitService } = createMocks();
    bridge.attach();
    handlers.status!(RUNNING_STATUS);
    expect(providerLimitService.clearCache).not.toHaveBeenCalled();
  });

  it('status handler tracks previous status across multiple updates', () => {
    const { bridge, handlers, providerLimitService } = createMocks();
    bridge.attach();
    handlers.status!(STARTING_STATUS);
    handlers.status!(RUNNING_STATUS);
    expect(providerLimitService.shouldClearCache).toHaveBeenLastCalledWith(
      STARTING_STATUS,
      RUNNING_STATUS
    );
  });

  it('event handler posts parsed event and calls handleServerEvent', () => {
    const { bridge, handlers, post, sessionState } = createMocks();
    const parsed = { type: 'session.created' as const };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue([]);
    bridge.attach();
    handlers.event!({ type: 'session.created' });
    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: parsed });
  });

  it('event handler skips null parse results', () => {
    const { bridge, handlers, post, sessionState } = createMocks();
    mocks.parseServerEvent.mockReturnValue(null);
    bridge.attach();
    handlers.event!({ bogus: true });
    expect(sessionState.handleServerEvent).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('logs unknown event types at most once per minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'));
    const { bridge, handlers } = createMocks();
    mocks.parseServerEvent.mockReturnValue(null);
    bridge.attach();

    handlers.event!({ payload: { type: 'future.event' } });
    handlers.event!({ payload: { type: 'future.event' } });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Ignoring unknown OpenCode event type: future.event'
    );

    vi.advanceTimersByTime(60_000);
    handlers.event!({ payload: { type: 'future.event' } });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not log malformed values without an event discriminator', () => {
    mocks.loggerWarn.mockClear();
    const { bridge, handlers } = createMocks();
    mocks.parseServerEvent.mockReturnValue(null);
    bridge.attach();
    handlers.event!({ bogus: true });
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('event handler suppresses events for hidden sessions', () => {
    const { bridge, handlers, post, sessionState, sessionTrash } = createMocks();
    const parsed = { type: 'session.updated' as const };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['hidden-session']);
    sessionTrash.isHidden.mockReturnValue(true);
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('observes and suppresses a pending-title session.created with a real manager', () => {
    const hiddenSessions = new HiddenSessionManager();
    hiddenSessions.registerPendingTitle('Internal session');
    const { bridge, handlers, post, sessionState } = createMocks({ hiddenSessions });
    const parsed = {
      type: 'session.created' as const,
      properties: {
        info: { id: 'internal-session', title: 'Internal session' },
      },
    };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['internal-session']);

    bridge.attach();
    handlers.event!({});

    expect(hiddenSessions.isHidden('internal-session')).toBe(true);
    expect(sessionState.handleServerEvent).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('event handler suppresses session updates from nested workspace directories', () => {
    const { bridge, handlers, post, sessionState } = createMocks({ workspacePath: '/repo' });
    const parsed = {
      type: 'session.updated' as const,
      properties: { info: { id: 'nested-session', directory: '/repo/project-a' } },
    };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['nested-session']);
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('accepts UNC session metadata with equivalent casing and separators', () => {
    const { bridge, handlers, post, sessionState } = createMocks({
      workspacePath: '\\\\BuildServer\\Projects\\Varro',
    });
    const parsed = {
      type: 'session.updated' as const,
      properties: { info: { id: 'unc-session', directory: '//buildserver/PROJECTS/varro/' } },
    };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['unc-session']);
    bridge.attach();
    handlers.event!({});

    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: parsed });
  });

  it('event handler suppresses non-metadata events for sessions outside the workspace', () => {
    const { bridge, handlers, post, sessionState } = createMocks({
      workspacePath: '/repo',
      isSessionInWorkspace: () => false,
    });
    const parsed = { type: 'permission.asked' as const, properties: { sessionID: 'session-1' } };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['session-1']);
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('does not treat an unknown session directory as a foreign workspace', () => {
    const { bridge, handlers, post, sessionState } = createMocks({
      workspacePath: '/repo',
      getSessionWorkspaceMatch: () => undefined,
    });
    const parsed = { type: 'session.status' as const, properties: { sessionID: 'session-1' } };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['session-1']);

    bridge.attach();
    handlers.event!({});

    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: parsed });
  });

  it('event handler does not suppress when session is not hidden', () => {
    const { bridge, handlers, post, sessionState, sessionTrash } = createMocks();
    const parsed = { type: 'session.updated' as const };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['visible-session']);
    sessionTrash.isHidden.mockReturnValue(false);
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: parsed });
  });

  it('event handler does not suppress when event has no session IDs', () => {
    const { bridge, handlers, sessionState } = createMocks();
    const parsed = { type: 'mcp.tools.changed' as const };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue([]);
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
  });

  it('dispose persists session state', async () => {
    const { bridge, sessionState } = createMocks();
    bridge.attach();
    await bridge.dispose();
    expect(sessionState.persist).toHaveBeenCalledOnce();
    expect(sessionState.flush).toHaveBeenCalledOnce();
  });

  it('dispose waits for the latest queued session-state write', async () => {
    const { bridge, sessionState } = createMocks();
    let releaseFlush: (() => void) | undefined;
    sessionState.flush.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        })
    );
    const item = bridge.getStatusBarItem();
    bridge.attach();

    const disposing = bridge.dispose();
    await vi.waitFor(() => expect(sessionState.flush).toHaveBeenCalledOnce());
    expect(item.dispose).not.toHaveBeenCalled();
    releaseFlush?.();
    await disposing;

    expect(item.dispose).toHaveBeenCalledOnce();
  });

  it('dispose unregisters both server handlers', async () => {
    const { bridge, server } = createMocks();
    bridge.attach();
    await bridge.dispose();
    expect(server.off).toHaveBeenCalledWith('status', expect.any(Function));
    expect(server.off).toHaveBeenCalledWith('event', expect.any(Function));
  });

  it('dispose disposes the status bar item', async () => {
    const { bridge } = createMocks();
    const item = bridge.getStatusBarItem();
    bridge.attach();
    await bridge.dispose();
    expect(item.dispose).toHaveBeenCalled();
  });

  it('dispose clears handler references', async () => {
    const { bridge, server } = createMocks();
    bridge.attach();
    await bridge.dispose();
    const offCalls = server.off.mock.calls;
    const statusHandler = offCalls.find((c: unknown[]) => (c as string[])[0] === 'status')?.[1];
    const eventHandler = offCalls.find((c: unknown[]) => (c as string[])[0] === 'event')?.[1];
    expect(statusHandler).toBeDefined();
    expect(eventHandler).toBeDefined();
  });

  it('status handler works with error status', () => {
    const { bridge, handlers, post } = createMocks();
    bridge.attach();
    handlers.status!(ERROR_STATUS);
    expect(bridge.getStatus()).toBe(ERROR_STATUS);
    expect(post).toHaveBeenCalledWith({ type: 'server/status', payload: ERROR_STATUS });
  });

  it('event handler handles event with multiple session IDs where some are hidden', () => {
    const { bridge, handlers, sessionState, sessionTrash } = createMocks();
    const parsed = { type: 'session.updated' as const };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['visible', 'hidden']);
    (sessionTrash.isHidden as ReturnType<typeof vi.fn>).mockImplementation(
      (id: unknown) => id === 'hidden'
    );
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).not.toHaveBeenCalled();
  });
});
