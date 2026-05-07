import { describe, expect, it, vi } from 'vitest';
import type { MockedObject } from 'vitest';
import type * as StateModule from '../lib/state';

const {
  serverEventsOn,
  addPermission,
  clearStreamingState,
  markSessionSeen,
  removePermission,
  removeMessagePart,
  removeQuestion,
  replaceMessages,
  setSessionCompactingStore,
  setSessionFailed,
  setSessionUsageLimit,
  startLoading,
  stopLoading,
  upsertMessageInfo,
  upsertPart,
  upsertQuestion,
  applyMessagePartDelta,
  markLoadingActivity,
  setState,
  getPermissionModeForSession,
  state,
} = vi.hoisted(() => ({
  serverEventsOn: vi.fn(),
  addPermission: vi.fn(),
  clearStreamingState: vi.fn(),
  markSessionSeen: vi.fn(),
  removePermission: vi.fn(),
  removeMessagePart: vi.fn(),
  removeQuestion: vi.fn(),
  replaceMessages: vi.fn(),
  setSessionCompactingStore: vi.fn(),
  setSessionFailed: vi.fn(),
  setSessionUsageLimit: vi.fn(),
  startLoading: vi.fn(),
  stopLoading: vi.fn(),
  upsertMessageInfo: vi.fn(),
  upsertPart: vi.fn(),
  upsertQuestion: vi.fn(),
  applyMessagePartDelta: vi.fn(),
  markLoadingActivity: vi.fn(),
  setState: vi.fn(),
  getPermissionModeForSession: vi.fn(),
  state: {
    activeSessionId: null,
    messages: [],
  },
}));

vi.mock('../lib/client', () => ({
  serverEvents: {
    on: serverEventsOn,
  },
}));

vi.mock('../lib/state', async () => {
  const actual = (await vi.importActual('../lib/state')) as MockedObject<typeof StateModule>;
  return {
    ...actual,
    clearStreamingState,
    markSessionSeen,
    removeMessagePart,
    removeQuestion,
    replaceMessages,
    state,
    setSessionCompacting: setSessionCompactingStore,
    setSessionFailed,
    setSessionUsageLimit,
    addPermission,
    getPermissionModeForSession,
    removePermission,
    setState,
    startLoading,
    stopLoading,
    upsertQuestion,
  };
});

vi.mock('../lib/stores/session-store', async () => {
  const actual = await vi.importActual('../lib/stores/session-store');
  return {
    ...(actual as object),
    sessionStore: {
      ...(actual as { sessionStore: object }).sessionStore,
      clearStreamingState,
      markSessionSeen,
      removeMessagePart,
      replaceMessages,
      setSessionCompacting: setSessionCompactingStore,
      setSessionFailed,
      setSessionUsageLimit,
      upsertMessageInfo,
      upsertPart,
      applyMessagePartDelta,
    },
  };
});

vi.mock('../lib/stores/ui-store', async () => {
  const actual = await vi.importActual('../lib/stores/ui-store');
  return {
    ...(actual as object),
    uiStore: {
      ...(actual as { uiStore: object }).uiStore,
      markLoadingActivity,
      startLoading,
      stopLoading,
    },
  };
});

import {
  registerSessionEventHandlers,
  SessionEventHandlerOperations,
} from './session/session-event-handlers';

type EventData = { properties?: Record<string, unknown> };

function installHandlers() {
  const handlers = new Map<string, (data: EventData) => void>();
  serverEventsOn.mockReset();
  serverEventsOn.mockImplementation((event, handler) => {
    handlers.set(event as string, handler as (data: EventData) => void);
    return () => {
      handlers.delete(event as string);
    };
  });
  return handlers;
}

function createDefaultDeps(
  overrides: Partial<Parameters<typeof registerSessionEventHandlers>[0]> = {}
): Parameters<typeof registerSessionEventHandlers>[0] {
  return {
    getActiveSessionId: () => null,
    getMessages: () => [],
    handoffTodosToMessages: vi.fn().mockReturnValue(true),
    upsertSession: vi.fn(),
    setSessionCompacting: vi.fn(),
    removeDeletedSessionTree: vi.fn(),
    shouldIgnorePendingAbortStatus: () => false,
    hasPendingAbort: () => false,
    markPendingAbort: vi.fn(),
    clearPendingAbort: vi.fn(),
    setSessionStatusEntry: vi.fn(),
    clearUsageLimitOnResumedProgress: vi.fn(),
    updateUsageLimitState: vi.fn(),
    syncSession: vi.fn().mockResolvedValue(undefined),
    shouldResyncSessionAfterIdle: () => false,
    syncSessionMessages: vi.fn().mockResolvedValue(undefined),
    applyUsageLimitNotice: vi.fn(),
    syncTodosFromMessages: vi.fn(),
    shouldAutoApprovePermissions: () => false,
    respondPermission: vi.fn().mockResolvedValue(undefined),
    setDiffs: vi.fn(),
    abortRemoteSession: vi.fn().mockResolvedValue(true),
    logError: vi.fn(),
    ...overrides,
  };
}

function createAssistantEntry(overrides: Record<string, unknown> = {}) {
  return {
    info: {
      id: 'assistant-1',
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: 1 },
      parentID: 'user-1',
      modelID: 'gpt-4o',
      providerID: 'openai',
      mode: 'default',
      path: { cwd: '/repo', root: '/repo' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      ...overrides,
    },
    parts: [],
  };
}

function createUserEntry(overrides: Record<string, unknown> = {}) {
  return {
    info: {
      id: 'user-1',
      sessionID: 'session-1',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-4o' },
      ...overrides,
    },
    parts: [],
  };
}

describe('registerSessionEventHandlers', () => {
  it('restores the permission prompt when auto-approval fails', async () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const respondPermission = vi
      .fn()
      .mockRejectedValue(new Error('Permission backend unavailable'));

    registerSessionEventHandlers({
      getActiveSessionId: () => null,
      getMessages: () => [],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => true,
      respondPermission,
      setDiffs: vi.fn(),
    });

    handlers.get('permission.asked')?.({
      properties: {
        id: 'perm-1',
        sessionID: 'session-1',
        permission: 'bash',
        title: 'Run Bash command',
      },
    });

    await vi.waitFor(() => {
      expect(respondPermission).toHaveBeenCalledWith('session-1', 'perm-1', 'always', {
        rethrow: true,
      });
      expect(addPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'perm-1',
          sessionID: 'session-1',
          title: 'bash',
        })
      );
    });
  });

  it('removes permissions when a reply only includes id', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    registerSessionEventHandlers({
      getActiveSessionId: () => null,
      getMessages: () => [],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('permission.replied')?.({
      properties: {
        id: 'perm-1',
        sessionID: 'session-1',
      },
    });

    expect(removePermission).toHaveBeenCalledWith('perm-1');
  });

  it('binds event handlers to shared state-backed dependencies', async () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    getPermissionModeForSession.mockReturnValue('full');
    state.activeSessionId = 'session-1';
    state.messages = [];
    const respondPermission = vi.fn().mockResolvedValue(undefined);
    const handoffTodosToMessages = vi.fn().mockReturnValue(true);
    const syncTodosFromMessages = vi.fn();

    const operations = new SessionEventHandlerOperations({
      todoSyncOperations: {
        handoffTodosToMessages,
        syncTodosFromMessages,
      },
      sessionLifecycleOperations: {
        upsertSession: vi.fn(),
        removeDeletedSessionTree: vi.fn(),
      },
      sessionStatusOperations: {
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        clearPendingAbort: vi.fn(),
        clearUsageLimitOnResumedProgress: vi.fn(),
        updateUsageLimitState: vi.fn(),
        applyUsageLimitNotice: vi.fn(),
      },
      sessionSyncOperations: {
        syncSession: vi.fn().mockResolvedValue(undefined),
        syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      },
      sessionApprovalOperations: {
        respondPermission,
      },
    });

    operations.registerSessionEventHandlers();

    handlers.get('permission.asked')?.({
      properties: {
        id: 'perm-2',
        sessionID: 'session-1',
        permission: 'edit',
        title: 'Edit file',
      },
    });
    handlers.get('session.status')?.({
      properties: {
        sessionID: 'session-1',
        status: { type: 'busy' },
      },
    });

    await vi.waitFor(() => {
      expect(respondPermission).toHaveBeenCalledWith('session-1', 'perm-2', 'always', {
        rethrow: true,
      });
    });
    expect(setState).toHaveBeenCalledWith('sessionStatus', expect.any(Function));
  });

  it('ignores partial message.updated payloads for message state', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const handoffTodosToMessages = vi.fn().mockReturnValue(true);
    const applyUsageLimitNotice = vi.fn();
    const clearUsageLimitOnResumedProgress = vi.fn();
    const updateUsageLimitState = vi.fn();

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [],
      handoffTodosToMessages,
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress,
      updateUsageLimitState,
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice,
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    upsertMessageInfo.mockClear();
    markLoadingActivity.mockClear();

    handlers.get('message.updated')?.({
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          error: { name: 'rate_limit_exceeded', data: { message: '429 usage limit reached' } },
        },
      },
    });

    expect(handoffTodosToMessages).not.toHaveBeenCalled();
    expect(applyUsageLimitNotice).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        source: 'message',
        sessionID: 'session-1',
        message: '429 usage limit reached',
      })
    );
    expect(clearUsageLimitOnResumedProgress).not.toHaveBeenCalled();
  });

  it('rejects malformed user message.updated payloads with parent ids', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('message.updated')?.({
      properties: {
        info: {
          id: 'user-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-4o' },
          parentID: 'assistant-1',
        },
      },
    });

    expect(setState).not.toHaveBeenCalledWith('messages', expect.any(Function));
  });

  it('ignores partial message.part.updated payloads for message state', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const syncTodosFromMessages = vi.fn();

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages,
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('message.part.updated')?.({
      properties: {
        part: {
          sessionID: 'session-1',
          type: 'tool',
        },
      },
    });

    expect(syncTodosFromMessages).not.toHaveBeenCalled();
  });

  it('applies child-session message updates when they belong to the active session tree', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const handoffTodosToMessages = vi.fn().mockReturnValue(true);

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-parent',
      isSessionInActiveTree: (sessionId) =>
        sessionId === 'session-parent' || sessionId === 'session-child',
      getMessages: () => [],
      handoffTodosToMessages,
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    setState.mockClear();

    handlers.get('message.updated')?.({
      properties: {
        info: {
          id: 'assistant-child-1',
          sessionID: 'session-child',
          role: 'assistant',
          parentID: 'assistant-parent-1',
          modelID: 'glm-5.1',
          providerID: 'z-ai',
          mode: 'subagent',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: { created: 1, completed: 2 },
        },
      },
    });

    expect(markLoadingActivity).toHaveBeenCalled();
    expect(upsertMessageInfo).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'assistant-child-1', sessionID: 'session-child' })
    );
    expect(handoffTodosToMessages).toHaveBeenCalledTimes(1);
  });

  it('applies child-session tool part updates when they belong to the active session tree', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const syncTodosFromMessages = vi.fn();

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-parent',
      isSessionInActiveTree: (sessionId) =>
        sessionId === 'session-parent' || sessionId === 'session-child',
      getMessages: () => [],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages,
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    upsertPart.mockClear();
    markLoadingActivity.mockClear();

    handlers.get('message.part.updated')?.({
      properties: {
        part: {
          id: 'tool-1',
          sessionID: 'session-child',
          messageID: 'assistant-child-1',
          type: 'tool',
          callID: 'call-1',
          tool: 'task',
          state: {
            status: 'running',
            input: { subagent_type: 'explore', prompt: 'Inspect the repo' },
            title: 'Inspect the repo',
            metadata: {},
            time: { start: 1 },
          },
        },
      },
    });

    expect(markLoadingActivity).toHaveBeenCalledTimes(1);
    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tool-1', sessionID: 'session-child', type: 'tool' })
    );
    expect(syncTodosFromMessages).toHaveBeenCalledTimes(1);
  });

  it('applies child-session part deltas when they belong to the active session tree', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-parent',
      isSessionInActiveTree: (sessionId) =>
        sessionId === 'session-parent' || sessionId === 'session-child',
      getMessages: () => [],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    applyMessagePartDelta.mockClear();
    markLoadingActivity.mockClear();

    handlers.get('message.part.delta')?.({
      properties: {
        sessionID: 'session-child',
        messageID: 'assistant-child-1',
        partID: 'reasoning-1',
        delta: 'Planning',
        field: 'text',
      },
    });

    expect(markLoadingActivity).toHaveBeenCalledTimes(1);
    expect(applyMessagePartDelta).toHaveBeenCalledWith(
      'assistant-child-1',
      'reasoning-1',
      'Planning',
      'session-child',
      'text'
    );
  });

  it('re-syncs todos from messages when todo.updated arrives for an active reply', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const syncTodosFromMessages = vi.fn();

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        {
          info: {
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 0 },
            parentID: 'user-1',
            modelID: 'model-1',
            providerID: 'provider-1',
            mode: 'default',
            path: { cwd: '/', root: '/' },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [],
        },
      ],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages,
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('todo.updated')?.({
      properties: {
        sessionID: 'session-1',
        todos: [{ id: 'todo-1', content: 'sync me', status: 'pending', priority: 'medium' }],
      },
    });

    expect(syncTodosFromMessages).toHaveBeenCalledTimes(1);
  });

  it('marks the session idle and resyncs messages when the active reply still looks unfinished', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const setSessionStatusEntry = vi.fn();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    const handoffTodosToMessages = vi.fn().mockReturnValue(true);

    markSessionSeen.mockClear();

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        {
          info: {
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 1 },
            parentID: 'user-1',
            modelID: 'gpt-4o',
            providerID: 'openai',
            mode: 'default',
            path: { cwd: '/repo', root: '/repo' },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [],
        },
      ],
      handoffTodosToMessages,
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry,
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => true,
      syncSessionMessages,
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(markSessionSeen).toHaveBeenCalledWith('session-1');
    expect(handoffTodosToMessages).toHaveBeenCalledTimes(1);
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });

  it('does not resync messages on idle when the active session already looks settled', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        {
          info: {
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 1, completed: 2 },
            parentID: 'user-1',
            modelID: 'gpt-4o',
            providerID: 'openai',
            mode: 'default',
            path: { cwd: '/repo', root: '/repo' },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [],
        },
      ],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => true,
      syncSessionMessages,
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

    expect(syncSessionMessages).not.toHaveBeenCalled();
  });

  it('resyncs messages on idle when todo handoff cannot reconcile local state', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        {
          info: {
            id: 'user-1',
            sessionID: 'session-1',
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-4o' },
          },
          parts: [],
        },
      ],
      handoffTodosToMessages: vi.fn().mockReturnValue(false),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => true,
      syncSessionMessages,
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });

  it('tracks session lifecycle events and active status transitions', () => {
    const handlers = installHandlers();
    const upsertSession = vi.fn();
    const removeDeletedSessionTree = vi.fn();
    const setSessionCompacting = vi.fn();
    const setSessionStatusEntry = vi.fn();
    const clearUsageLimitOnResumedProgress = vi.fn();
    const updateUsageLimitState = vi.fn();
    const clearPendingAbort = vi.fn();

    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        upsertSession,
        setSessionCompacting,
        removeDeletedSessionTree,
        setSessionStatusEntry,
        clearUsageLimitOnResumedProgress,
        updateUsageLimitState,
        hasPendingAbort: (sessionId) => sessionId === 'session-1',
        clearPendingAbort,
      })
    );

    handlers.get('session.created')?.({
      properties: { info: { id: 'session-1', time: { compacting: true } } },
    });
    handlers.get('session.updated')?.({
      properties: { info: { id: 'session-1', time: { compacting: false } } },
    });
    handlers.get('session.deleted')?.({ properties: { info: { id: 'session-1' } } });
    handlers.get('session.status')?.({
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    handlers.get('session.status')?.({
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });

    expect(upsertSession).toHaveBeenCalledTimes(2);
    expect(setSessionCompacting).toHaveBeenCalledWith('session-1', false);
    expect(removeDeletedSessionTree).toHaveBeenCalledWith('session-1');
    expect(setSessionStatusEntry).toHaveBeenNthCalledWith(1, 'session-1', { type: 'busy' });
    expect(setSessionStatusEntry).toHaveBeenNthCalledWith(2, 'session-1', { type: 'idle' });
    expect(clearUsageLimitOnResumedProgress).toHaveBeenCalledWith('session-1', { type: 'busy' });
    expect(updateUsageLimitState).toHaveBeenCalledTimes(1);
    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(clearPendingAbort).toHaveBeenCalledWith('session-1');
    expect(stopLoading).toHaveBeenCalledTimes(1);
  });

  it('ignores pending-abort status events before mutating state', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    const updateUsageLimitState = vi.fn();

    startLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        shouldIgnorePendingAbortStatus: () => true,
        setSessionStatusEntry,
        updateUsageLimitState,
      })
    );

    handlers.get('session.status')?.({
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });

    expect(setSessionStatusEntry).not.toHaveBeenCalled();
    expect(updateUsageLimitState).not.toHaveBeenCalled();
    expect(startLoading).not.toHaveBeenCalled();
  });

  it('aborts late-created child sessions when their parent is already stopping', async () => {
    const handlers = installHandlers();
    const upsertSession = vi.fn();
    const markPendingAbort = vi.fn();
    const setSessionStatusEntry = vi.fn();
    const abortRemoteSession = vi.fn(async () => true);

    registerSessionEventHandlers(
      createDefaultDeps({
        upsertSession,
        hasPendingAbort: (sessionId) => sessionId === 'session-1',
        markPendingAbort,
        setSessionStatusEntry,
        abortRemoteSession,
      })
    );

    handlers.get('session.created')?.({
      properties: {
        info: {
          id: 'child-1',
          projectID: 'project-1',
          directory: '/repo',
          parentID: 'session-1',
          title: 'Child',
          version: '1',
          time: { created: 0, updated: 0 },
        },
      },
    });

    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'child-1', parentID: 'session-1' })
    );
    expect(markPendingAbort).toHaveBeenCalledWith('child-1');
    expect(setSessionStatusEntry).toHaveBeenCalledWith('child-1', { type: 'idle' });
    expect(abortRemoteSession).toHaveBeenCalledWith('child-1');
  });

  it('clears session usage-limit state for non-limit errors and resumed assistant progress', () => {
    const handlers = installHandlers();
    const clearUsageLimitOnResumedProgress = vi.fn();
    const applyUsageLimitNotice = vi.fn();

    setSessionFailed.mockClear();
    setSessionUsageLimit.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        clearUsageLimitOnResumedProgress,
        applyUsageLimitNotice,
      })
    );

    handlers.get('message.updated')?.({
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          error: { name: 'UnexpectedFailure' },
        },
      },
    });
    handlers.get('message.updated')?.({
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
        },
      },
    });

    expect(setSessionFailed).toHaveBeenNthCalledWith(1, 'session-1', true);
    expect(setSessionFailed).toHaveBeenNthCalledWith(2, 'session-1', false);
    expect(setSessionUsageLimit).toHaveBeenCalledWith('session-1', null);
    expect(clearUsageLimitOnResumedProgress).toHaveBeenCalledWith('session-1');
    expect(applyUsageLimitNotice).not.toHaveBeenCalled();
  });

  it('removes active-tree parts and messages and re-syncs todos from remaining messages', () => {
    const handlers = installHandlers();
    const remainingMessage = createUserEntry({ id: 'keep-message' });
    const removedMessage = createAssistantEntry({ id: 'remove-message' });
    const syncTodosFromMessages = vi.fn();

    clearStreamingState.mockClear();
    removeMessagePart.mockClear();
    replaceMessages.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [remainingMessage, removedMessage],
        syncTodosFromMessages,
      })
    );

    handlers.get('message.part.removed')?.({
      properties: { sessionID: 'session-1', messageID: 'remove-message', partID: 'part-1' },
    });
    handlers.get('message.removed')?.({
      properties: { sessionID: 'session-1', messageID: 'remove-message' },
    });

    expect(removeMessagePart).toHaveBeenCalledWith('session-1', 'remove-message', 'part-1');
    expect(clearStreamingState).toHaveBeenCalledTimes(1);
    expect(replaceMessages).toHaveBeenCalledWith([remainingMessage]);
    expect(syncTodosFromMessages).toHaveBeenCalledTimes(2);
    expect(syncTodosFromMessages).toHaveBeenLastCalledWith([remainingMessage]);
  });

  it('normalizes fallback permission ids and tracks question lifecycle updates', () => {
    const handlers = installHandlers();
    const question = {
      id: 'question-1',
      sessionID: 'session-1',
      questions: [
        {
          question: 'Continue?',
          header: 'Confirm',
          options: [{ label: 'Yes', description: 'Proceed' }],
        },
      ],
    };

    addPermission.mockClear();
    removePermission.mockClear();
    upsertQuestion.mockClear();
    removeQuestion.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        shouldAutoApprovePermissions: () => false,
      })
    );

    handlers.get('permission.updated')?.({
      properties: {
        permissionID: 'perm-fallback',
        sessionID: 'session-1',
        permission: 'edit',
        patterns: ['src/app.ts'],
        tool: { messageID: 'msg-1', callID: 'call-1' },
      },
    });
    handlers.get('permission.replied')?.({ properties: { requestID: 'perm-fallback' } });
    handlers.get('question.asked')?.({ properties: question });
    handlers.get('question.replied')?.({ properties: { requestID: 'question-1' } });
    handlers.get('question.rejected')?.({ properties: { requestID: 'question-2' } });

    expect(addPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'perm-fallback',
        sessionID: 'session-1',
        title: 'edit src/app.ts',
        messageID: 'msg-1',
      })
    );
    expect(removePermission).toHaveBeenCalledWith('perm-fallback');
    expect(upsertQuestion).toHaveBeenCalledWith(question);
    expect(removeQuestion).toHaveBeenNthCalledWith(1, 'question-1');
    expect(removeQuestion).toHaveBeenNthCalledWith(2, 'question-2');
  });

  it('ignores settled todo updates and filters session diffs to the active tree', () => {
    const handlers = installHandlers();
    const syncTodosFromMessages = vi.fn();
    const setDiffs = vi.fn();
    const diff = {
      file: 'src/app.ts',
      before: 'before',
      after: 'after',
      additions: 1,
      deletions: 0,
    };

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-parent',
        isSessionInActiveTree: (sessionId) =>
          sessionId === 'session-parent' || sessionId === 'session-child',
        getMessages: () => [
          createAssistantEntry({
            sessionID: 'session-child',
            time: { created: 1, completed: 2 },
          }),
        ],
        syncTodosFromMessages,
        setDiffs,
      })
    );

    handlers.get('todo.updated')?.({ properties: { sessionID: 'session-child', todos: [] } });
    handlers.get('session.diff')?.({
      properties: { sessionID: 'session-child', diff: [diff] },
    });
    handlers.get('session.diff')?.({
      properties: { sessionID: 'session-other', diff: [{ ...diff, file: 'src/other.ts' }] },
    });

    expect(syncTodosFromMessages).not.toHaveBeenCalled();
    expect(setDiffs).toHaveBeenCalledTimes(1);
    expect(setDiffs).toHaveBeenCalledWith([diff]);
  });
});
