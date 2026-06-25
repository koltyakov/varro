import { describe, expect, it, vi } from 'vitest';
import type { MockedObject } from 'vitest';
import type * as StateModule from '../lib/state';
import type { Message, Part } from '../types';

const {
  serverEventsOn,
  addPermission,
  clearStreamingState,
  finishMessageStreaming,
  markSessionSeen,
  markSessionResponseCompleted,
  removePermission,
  removeMessagePart,
  removeQuestion,
  replaceMessages,
  setSessionCompactingStore,
  setSessionFailed,
  setSessionUsageLimit,
  startLoading,
  stopLoading,
  loadingStartedAt,
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
  finishMessageStreaming: vi.fn(),
  markSessionSeen: vi.fn(),
  markSessionResponseCompleted: vi.fn(),
  removePermission: vi.fn(),
  removeMessagePart: vi.fn(),
  removeQuestion: vi.fn(),
  replaceMessages: vi.fn(),
  setSessionCompactingStore: vi.fn(),
  setSessionFailed: vi.fn(),
  setSessionUsageLimit: vi.fn(),
  startLoading: vi.fn(),
  stopLoading: vi.fn(),
  loadingStartedAt: vi.fn(() => null as number | null),
  upsertMessageInfo: vi.fn(),
  upsertPart: vi.fn(),
  upsertQuestion: vi.fn(),
  applyMessagePartDelta: vi.fn(),
  markLoadingActivity: vi.fn(),
  setState: vi.fn(),
  getPermissionModeForSession: vi.fn(),
  state: {
    activeSessionId: null,
    completedSessionResponses: {},
    failedSessionIds: [],
    lastSeenSessions: {},
    messages: [],
    permissions: [],
    questions: [],
    sessions: [],
    sessionStatus: {},
    sessionUsageLimits: {},
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
      finishMessageStreaming,
      markSessionSeen,
      markSessionResponseCompleted,
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
      loadingStartedAt,
      startLoading,
      stopLoading,
    },
  };
});

import {
  registerSessionEventHandlers,
  SessionEventHandlerOperations,
} from './session/session-event-handlers';
import { setShowSessionPicker } from '../lib/state';

type EventData = { properties?: Record<string, unknown>; seq?: number };

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
    recheckSessionStatus: vi.fn().mockResolvedValue(undefined),
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

function createCompletedAssistantEntry(
  created: number,
  completed: number
): { info: Message; parts: Part[] } {
  return createAssistantEntry({ time: { created, completed } }) as {
    info: Message;
    parts: Part[];
  };
}

describe('registerSessionEventHandlers', () => {
  it('judges auto-approve permissions without showing a prompt', async () => {
    addPermission.mockClear();
    const handlers = installHandlers();
    const judgePermission = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers(
      createDefaultDeps({
        shouldAutoJudgePermissions: () => true,
        judgePermission,
      })
    );

    const payload = {
      id: 'perm-auto',
      sessionID: 'session-1',
      permission: 'bash',
      title: 'Run git status',
    };
    handlers.get('permission.asked')?.({ properties: payload });
    handlers.get('permission.updated')?.({ properties: payload });

    await vi.waitFor(() => {
      expect(judgePermission).toHaveBeenCalledOnce();
      expect(judgePermission).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'perm-auto', sessionID: 'session-1', type: 'bash' })
      );
    });
    expect(addPermission).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'perm-auto' }));
  });

  it('shows auto-approve permissions when judging fails', async () => {
    addPermission.mockClear();
    const handlers = installHandlers();
    const judgePermission = vi.fn().mockRejectedValue(new Error('judge failed'));

    registerSessionEventHandlers(
      createDefaultDeps({
        shouldAutoJudgePermissions: () => true,
        judgePermission,
      })
    );

    handlers.get('permission.asked')?.({
      properties: {
        id: 'perm-auto-failed',
        sessionID: 'session-1',
        permission: 'bash',
        title: 'Run git status',
      },
    });

    await vi.waitFor(() => {
      expect(addPermission).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'perm-auto-failed', sessionID: 'session-1' })
      );
    });
  });

  it('keeps full-access permission prompts hidden when auto-approval races or fails', async () => {
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
    });
    expect(addPermission).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'perm-1' }));
  });

  it('restores the permission prompt when auto-approval fails after leaving full access', async () => {
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

    let fullAccess = true;
    const respondPermission = vi.fn().mockImplementation(async () => {
      fullAccess = false;
      throw new Error('Permission backend unavailable');
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
      shouldAutoApprovePermissions: () => fullAccess,
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
      expect(addPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'perm-1',
          sessionID: 'session-1',
          title: 'Run Bash command',
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

  it('handles v2 permission ask and reply events', () => {
    addPermission.mockClear();
    removePermission.mockClear();
    const handlers = installHandlers();

    registerSessionEventHandlers(createDefaultDeps());

    handlers.get('permission.v2.asked')?.({
      properties: {
        id: 'perm-v2',
        sessionID: 'session-1',
        action: 'edit',
        resources: ['src/app.ts'],
        source: { type: 'tool', messageID: 'msg-1', callID: 'call-1' },
      },
    });
    handlers.get('permission.v2.replied')?.({
      properties: {
        sessionID: 'session-1',
        requestID: 'perm-v2',
        reply: 'once',
      },
    });

    expect(addPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'perm-v2',
        sessionID: 'session-1',
        type: 'edit',
        pattern: ['src/app.ts'],
        messageID: 'msg-1',
        callID: 'call-1',
      })
    );
    expect(removePermission).toHaveBeenCalledWith('perm-v2');
  });

  it('handles v2 question ask and completion events', () => {
    upsertQuestion.mockClear();
    removeQuestion.mockClear();
    const handlers = installHandlers();

    registerSessionEventHandlers(createDefaultDeps());

    const question = {
      id: 'question-v2',
      sessionID: 'session-1',
      questions: [
        {
          question: 'Choose one',
          header: 'Choice',
          options: [{ label: 'Yes', description: 'Proceed' }],
        },
      ],
    };
    handlers.get('question.v2.asked')?.({ properties: question });
    handlers.get('question.v2.replied')?.({
      properties: { sessionID: 'session-1', requestID: 'question-v2', answers: [] },
    });
    handlers.get('question.v2.rejected')?.({
      properties: { sessionID: 'session-1', requestID: 'question-v3' },
    });

    expect(upsertQuestion).toHaveBeenCalledWith(question);
    expect(removeQuestion).toHaveBeenNthCalledWith(1, 'question-v2');
    expect(removeQuestion).toHaveBeenNthCalledWith(2, 'question-v3');
  });

  it('syncs pending permissions after shell progress events in case permission events were missed', () => {
    const handlers = installHandlers();
    const syncPendingPermissions = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        syncPendingPermissions,
      })
    );

    handlers.get('session.next.shell.started')?.({
      properties: { sessionID: 'session-1' },
    });

    expect(syncPendingPermissions).toHaveBeenCalledTimes(1);
  });

  it('marks session.error events failed and stops active loading', () => {
    const handlers = installHandlers();
    const deps = createDefaultDeps({ getActiveSessionId: () => 'session-1' });

    setSessionFailed.mockClear();
    setSessionUsageLimit.mockClear();
    stopLoading.mockClear();
    registerSessionEventHandlers(deps);

    handlers.get('session.error')?.({
      properties: {
        sessionID: 'session-1',
        error: { name: 'UnknownError', data: { message: 'Command failed' } },
      },
    });

    expect(deps.setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(deps.clearPendingAbort).toHaveBeenCalledWith('session-1');
    expect(setSessionFailed).toHaveBeenCalledWith('session-1', true);
    expect(setSessionUsageLimit).toHaveBeenCalledWith('session-1', null);
    expect(stopLoading).toHaveBeenCalledTimes(1);
    expect(deps.syncSession).toHaveBeenCalledWith('session-1');
    expect(deps.syncSessionMessages).toHaveBeenCalledWith('session-1');
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

  it('resyncs active messages for partial message.updated payloads', () => {
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
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [],
      handoffTodosToMessages,
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      markPendingAbort: vi.fn(),
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress,
      updateUsageLimitState,
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages,
      applyUsageLimitNotice,
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
      abortRemoteSession: vi.fn().mockResolvedValue(true),
      logError: vi.fn(),
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
    expect(upsertMessageInfo).not.toHaveBeenCalled();
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
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

  it('resyncs completed active assistant messages when local parts are missing', () => {
    const handlers = installHandlers();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [],
        syncSessionMessages,
      })
    );

    upsertMessageInfo.mockClear();

    handlers.get('message.updated')?.({
      properties: {
        info: createAssistantEntry({ time: { created: 1, completed: 2 } }).info,
      },
    });

    expect(upsertMessageInfo).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'assistant-1', sessionID: 'session-1' })
    );
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });

  it('finishes streaming for partial active assistant completion updates without marking idle', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();

    finishMessageStreaming.mockClear();
    upsertMessageInfo.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [createAssistantEntry() as { info: Message; parts: Part[] }],
        setSessionStatusEntry,
      })
    );

    handlers.get('message.updated')?.({
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          time: { completed: 2 },
        },
      },
    });

    expect(upsertMessageInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'assistant-1',
        time: expect.objectContaining({ completed: 2 }),
      })
    );
    expect(finishMessageStreaming).toHaveBeenCalledWith('assistant-1');
    expect(setSessionStatusEntry).not.toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(stopLoading).not.toHaveBeenCalled();
  });

  it('resyncs active messages for partial message.part.updated payloads', () => {
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
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
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
      syncSessionMessages,
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages,
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
      abortRemoteSession: vi.fn().mockResolvedValue(true),
      logError: vi.fn(),
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
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });

  it('resyncs before applying complete part updates when the parent message is missing', async () => {
    const handlers = installHandlers();
    const assistantEntry = createAssistantEntry({ id: 'assistant-2' }) as {
      info: Message;
      parts: Part[];
    };
    let messages: Array<{ info: Message; parts: Part[] }> = [
      createUserEntry({ id: 'user-2' }) as { info: Message; parts: Part[] },
    ];
    const syncSessionMessages = vi.fn(async () => {
      messages = [...messages, assistantEntry];
    });

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => messages,
        syncSessionMessages,
      })
    );

    upsertPart.mockClear();

    handlers.get('message.part.updated')?.({
      properties: {
        part: {
          id: 'part-1',
          sessionID: 'session-1',
          messageID: 'assistant-2',
          type: 'text',
          text: 'No action taken.',
        },
      },
    });

    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
    expect(upsertPart).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(upsertPart).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'part-1', messageID: 'assistant-2' })
      );
    });
  });

  it('uses tool execution event timestamps when applying completed tool parts', () => {
    const handlers = installHandlers();
    const assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
      })
    );

    upsertPart.mockClear();

    handlers.get('session.next.shell.started')?.({
      properties: { sessionID: 'session-1', callID: 'call-1', timestamp: 1_000 },
    });
    handlers.get('session.next.shell.ended')?.({
      properties: { sessionID: 'session-1', callID: 'call-1', timestamp: 12_380 },
    });
    handlers.get('message.part.updated')?.({
      properties: {
        part: {
          id: 'tool-1',
          sessionID: 'session-1',
          messageID: 'assistant-1',
          type: 'tool',
          callID: 'call-1',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'rtk npm run test' },
            output: '> vitest run\nDuration 11.38s\n',
            title: 'Runs Vitest unit test suite',
            metadata: {},
            time: { start: 10_000, end: 10_005 },
          },
        },
      },
    });

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool-1',
        state: expect.objectContaining({ time: { start: 1_000, end: 12_380 } }),
      })
    );
  });

  it('updates existing completed tool parts when execution end events arrive later', () => {
    const handlers = installHandlers();
    const toolPart: Part = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'assistant-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'rtk npm run test' },
        output: '> vitest run\nDuration 11.38s\n',
        title: 'Runs Vitest unit test suite',
        metadata: {},
        time: { start: 10_000, end: 10_005 },
      },
    };
    const assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };
    assistantEntry.parts = [toolPart];

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
      })
    );

    upsertPart.mockClear();

    handlers.get('session.next.shell.started')?.({
      properties: { sessionID: 'session-1', callID: 'call-1', timestamp: 1_000 },
    });
    handlers.get('session.next.shell.ended')?.({
      properties: { sessionID: 'session-1', callID: 'call-1', timestamp: 12_380 },
    });

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool-1',
        state: expect.objectContaining({ time: { start: 1_000, end: 12_380 } }),
      })
    );
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
    expect(finishMessageStreaming).toHaveBeenCalledWith('assistant-child-1');
    expect(handoffTodosToMessages).toHaveBeenCalledTimes(1);
  });

  it('marks completed inactive assistant messages idle without stopping active loading', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    const handoffTodosToMessages = vi.fn().mockReturnValue(true);

    stopLoading.mockClear();
    markSessionResponseCompleted.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-2',
        setSessionStatusEntry,
        handoffTodosToMessages,
      })
    );

    handlers.get('message.updated')?.({
      properties: {
        info: {
          ...createAssistantEntry({ time: { created: 1, completed: 2 } }).info,
          sessionID: 'session-1',
        },
      },
    });

    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(markSessionResponseCompleted).toHaveBeenCalledWith('session-1', 2);
    expect(handoffTodosToMessages).not.toHaveBeenCalled();
    expect(stopLoading).not.toHaveBeenCalled();
  });

  it('marks partial inactive assistant completion updates idle without stopping active loading', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();

    stopLoading.mockClear();
    markSessionResponseCompleted.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-2',
        setSessionStatusEntry,
      })
    );

    handlers.get('session.status')?.({
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    handlers.get('message.updated')?.({
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          time: { completed: 2 },
        },
      },
    });

    expect(setSessionStatusEntry).toHaveBeenLastCalledWith('session-1', { type: 'idle' });
    expect(markSessionResponseCompleted).toHaveBeenCalledWith('session-1', 2);
    expect(stopLoading).not.toHaveBeenCalled();
  });

  it('merges partial session title updates and partial completion updates for inactive sessions', () => {
    const handlers = installHandlers();
    const upsertSession = vi.fn();
    const setSessionStatusEntry = vi.fn();

    state.sessions = [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'New Chat',
        version: '1',
        time: { created: 1, updated: 1 },
      },
      {
        id: 'session-2',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Active Chat',
        version: '1',
        time: { created: 2, updated: 2 },
      },
    ];
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-2',
        upsertSession,
        setSessionStatusEntry,
      })
    );

    handlers.get('session.status')?.({
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    handlers.get('session.updated')?.({
      properties: {
        info: {
          id: 'session-1',
          title: 'Test message in Chat A',
          time: { updated: 3 },
        },
      },
    });
    handlers.get('message.updated')?.({
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          time: { completed: 4 },
        },
      },
    });

    expect(upsertSession).toHaveBeenCalledWith({
      id: 'session-1',
      projectID: 'project-1',
      directory: '/repo',
      title: 'Test message in Chat A',
      version: '1',
      time: { created: 1, updated: 3 },
    });
    expect(setSessionStatusEntry).toHaveBeenLastCalledWith('session-1', { type: 'idle' });
    expect(stopLoading).not.toHaveBeenCalled();
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
      getMessages: () => [
        createAssistantEntry({ id: 'assistant-child-1', sessionID: 'session-child' }) as {
          info: Message;
          parts: Part[];
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

    upsertPart.mockClear();
    markLoadingActivity.mockClear();
    startLoading.mockClear();

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

    expect(startLoading).toHaveBeenCalledTimes(1);
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
      getMessages: () => [
        {
          info: createAssistantEntry({ id: 'assistant-child-1', sessionID: 'session-child' }).info,
          parts: [{ id: 'reasoning-1' }],
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
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    applyMessagePartDelta.mockClear();
    markLoadingActivity.mockClear();
    startLoading.mockClear();

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
    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(applyMessagePartDelta).toHaveBeenCalledWith(
      'assistant-child-1',
      'reasoning-1',
      'Planning',
      'session-child',
      'text'
    );
  });

  it('resyncs active messages before applying deltas for missing parts', async () => {
    const handlers = installHandlers();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [],
        syncSessionMessages,
        logError,
      })
    );

    applyMessagePartDelta.mockClear();

    handlers.get('message.part.delta')?.({
      properties: {
        sessionID: 'session-1',
        messageID: 'assistant-1',
        partID: 'part-1',
        delta: 'still working',
        field: 'text',
      },
    });

    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
    expect(applyMessagePartDelta).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(applyMessagePartDelta).toHaveBeenCalledWith(
      'assistant-1',
      'part-1',
      'still working',
      'session-1',
      'text'
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it('queues missing-part deltas and replays them in event order after sync', async () => {
    const handlers = installHandlers();
    let resolveSync: (() => void) | undefined;
    const syncSessionMessages = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        })
    );
    const messages = [
      {
        info: createAssistantEntry({ id: 'assistant-1', sessionID: 'session-1' }).info,
        parts: [] as Part[],
      },
    ];

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => messages,
        syncSessionMessages,
      })
    );

    applyMessagePartDelta.mockClear();

    handlers.get('message.part.delta')?.({
      properties: {
        sessionID: 'session-1',
        messageID: 'assistant-1',
        partID: 'part-1',
        delta: 'first ',
        field: 'text',
      },
    });
    messages[0]!.parts = [
      {
        id: 'part-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'text',
        text: '',
      } as Part,
    ];
    handlers.get('message.part.delta')?.({
      properties: {
        sessionID: 'session-1',
        messageID: 'assistant-1',
        partID: 'part-1',
        delta: 'second',
        field: 'text',
      },
    });

    expect(syncSessionMessages).toHaveBeenCalledTimes(1);
    expect(applyMessagePartDelta).not.toHaveBeenCalled();

    resolveSync?.();
    await Promise.resolve();

    expect(applyMessagePartDelta).toHaveBeenNthCalledWith(
      1,
      'assistant-1',
      'part-1',
      'first ',
      'session-1',
      'text'
    );
    expect(applyMessagePartDelta).toHaveBeenNthCalledWith(
      2,
      'assistant-1',
      'part-1',
      'second',
      'session-1',
      'text'
    );
  });

  it('creates and streams reasoning parts from session.next reasoning events', () => {
    const handlers = installHandlers();
    state.messages = [createAssistantEntry({ id: 'assistant-2', sessionID: 'session-1' })];

    upsertPart.mockClear();
    applyMessagePartDelta.mockClear();
    markLoadingActivity.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => state.messages,
      })
    );

    handlers.get('session.next.reasoning.delta')?.({
      properties: {
        sessionID: 'session-1',
        reasoningID: 'reason-1',
        delta: 'Thinking through the change',
      },
    });

    expect(markLoadingActivity).toHaveBeenCalledTimes(1);
    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reason-1',
        sessionID: 'session-1',
        messageID: 'assistant-2',
        type: 'reasoning',
        text: '',
      })
    );
    expect(applyMessagePartDelta).toHaveBeenCalledWith(
      'assistant-2',
      'reason-1',
      'Thinking through the change',
      'session-1',
      'text'
    );
  });

  it('attaches reasoning to the message named by assistantMessageID, not just the latest active assistant', () => {
    const handlers = installHandlers();
    state.messages = [
      createAssistantEntry({ id: 'assistant-early', sessionID: 'session-1' }),
      createAssistantEntry({ id: 'assistant-late', sessionID: 'session-1' }),
    ];

    upsertPart.mockClear();
    applyMessagePartDelta.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => state.messages,
      })
    );

    handlers.get('session.next.reasoning.delta')?.({
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'assistant-early',
        reasoningID: 'reason-early',
        delta: 'Reasoning for the earlier step',
      },
    });

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reason-early',
        messageID: 'assistant-early',
        type: 'reasoning',
      })
    );
    expect(applyMessagePartDelta).toHaveBeenCalledWith(
      'assistant-early',
      'reason-early',
      'Reasoning for the earlier step',
      'session-1',
      'text'
    );
  });

  it('syncs messages before applying session.next reasoning when no active assistant is loaded', async () => {
    const handlers = installHandlers();
    const syncSessionMessages = vi.fn(async () => {
      state.messages = [createAssistantEntry({ id: 'assistant-3', sessionID: 'session-1' })];
    });
    state.messages = [
      createAssistantEntry({
        id: 'assistant-old',
        sessionID: 'session-1',
        time: { created: 1, completed: 2 },
      }),
    ];

    upsertPart.mockClear();
    applyMessagePartDelta.mockClear();
    loadingStartedAt.mockReturnValueOnce(3);

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => state.messages,
        syncSessionMessages,
      })
    );

    handlers.get('session.next.reasoning.delta')?.({
      properties: {
        sessionID: 'session-1',
        reasoningID: 'reason-2',
        delta: 'New thinking',
      },
    });

    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
    expect(applyMessagePartDelta).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'reason-2', messageID: 'assistant-3', type: 'reasoning' })
    );
    expect(applyMessagePartDelta).toHaveBeenCalledWith(
      'assistant-3',
      'reason-2',
      'New thinking',
      'session-1',
      'text'
    );
  });

  it('marks progress without resyncing active messages from session.next text progress events', () => {
    const handlers = installHandlers();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    const assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };
    const setSessionStatusEntry = vi.fn();
    const clearUsageLimitOnResumedProgress = vi.fn();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
        syncSessionMessages,
        setSessionStatusEntry,
        clearUsageLimitOnResumedProgress,
      })
    );

    markLoadingActivity.mockClear();
    startLoading.mockClear();

    handlers.get('session.next.text.delta')?.({
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'assistant-1',
        textID: 'text-1',
        delta: 'streaming response',
      },
    });

    expect(markLoadingActivity).toHaveBeenCalledTimes(1);
    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'busy' });
    expect(clearUsageLimitOnResumedProgress).toHaveBeenCalledWith('session-1', { type: 'busy' });
    expect(syncSessionMessages).not.toHaveBeenCalled();
  });

  it('starts loading for progress events from child sessions in the active tree', () => {
    const handlers = installHandlers();
    const assistantEntry = createAssistantEntry({
      id: 'assistant-child-1',
      sessionID: 'session-child',
    }) as { info: Message; parts: Part[] };

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-parent',
        isSessionInActiveTree: (sessionId) =>
          sessionId === 'session-parent' || sessionId === 'session-child',
        getMessages: () => [assistantEntry],
      })
    );

    startLoading.mockClear();
    markLoadingActivity.mockClear();

    handlers.get('session.next.tool.called')?.({
      properties: {
        sessionID: 'session-child',
        assistantMessageID: 'assistant-child-1',
        callID: 'call-1',
        tool: 'bash',
      },
      seq: 1,
    });

    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(markLoadingActivity).toHaveBeenCalledTimes(1);
  });

  it('skips the defensive active-message resync for in-order v2 progress events (seq present)', () => {
    const handlers = installHandlers();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    const assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
        syncSessionMessages,
      })
    );

    handlers.get('session.next.tool.called')?.({
      properties: { sessionID: 'session-1', assistantMessageID: 'assistant-1', callID: 'call-1' },
      seq: 1,
    });
    handlers.get('session.next.tool.called')?.({
      properties: { sessionID: 'session-1', assistantMessageID: 'assistant-1', callID: 'call-2' },
      seq: 2,
    });

    expect(syncSessionMessages).not.toHaveBeenCalled();
  });

  it('resyncs active messages when a v2 sequence gap reveals a missed event', () => {
    const handlers = installHandlers();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    const assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
        syncSessionMessages,
      })
    );

    handlers.get('session.next.tool.called')?.({
      properties: { sessionID: 'session-1', assistantMessageID: 'assistant-1', callID: 'call-1' },
      seq: 1,
    });
    // seq jumps from 1 to 3 - event 2 was missed, so a targeted resync is expected.
    handlers.get('session.next.tool.called')?.({
      properties: { sessionID: 'session-1', assistantMessageID: 'assistant-1', callID: 'call-3' },
      seq: 3,
    });

    expect(syncSessionMessages).toHaveBeenCalledTimes(1);
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });

  it('keeps the defensive resync for ephemeral progress events that carry no seq', () => {
    const handlers = installHandlers();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        syncSessionMessages,
      })
    );

    // Ephemeral streaming fragments (e.g. tool input deltas) carry no seq, so we cannot
    // reason about gaps and keep the defensive resync.
    handlers.get('session.next.tool.input.delta')?.({
      properties: { sessionID: 'session-1', callID: 'call-1', delta: '{' },
    });

    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });

  it('projects v2 text deltas without defensive message resync when the assistant exists', () => {
    const handlers = installHandlers();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    const assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
        syncSessionMessages,
      })
    );

    upsertPart.mockClear();
    applyMessagePartDelta.mockClear();

    handlers.get('session.next.text.delta')?.({
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'assistant-1',
        textID: 'text-1',
        delta: 'Hello',
      },
    });

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'text-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'text',
        text: '',
      })
    );
    expect(applyMessagePartDelta).toHaveBeenCalledWith(
      'assistant-1',
      'text-1',
      'Hello',
      'session-1',
      'text'
    );
    expect(syncSessionMessages).not.toHaveBeenCalled();
  });

  it('projects v2 tool calls without defensive message resync when the assistant exists', () => {
    const handlers = installHandlers();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    const assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
        syncSessionMessages,
      })
    );

    upsertPart.mockClear();

    handlers.get('session.next.tool.called')?.({
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'assistant-1',
        callID: 'call-1',
        tool: 'bash',
        input: { command: 'npm test' },
        timestamp: 10,
      },
    });

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'call-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'tool',
        callID: 'call-1',
        tool: 'bash',
        state: expect.objectContaining({
          status: 'running',
          input: { command: 'npm test' },
          time: { start: 10 },
        }),
      })
    );
    expect(syncSessionMessages).not.toHaveBeenCalled();
  });

  it('ignores stale active progress events after the assistant already completed', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    const clearUsageLimitOnResumedProgress = vi.fn();

    loadingStartedAt.mockReturnValue(null);
    markLoadingActivity.mockClear();
    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [createCompletedAssistantEntry(1, 2)],
        setSessionStatusEntry,
        clearUsageLimitOnResumedProgress,
      })
    );

    handlers.get('session.next.text.ended')?.({
      properties: { sessionID: 'session-1' },
    });

    expect(setSessionStatusEntry).not.toHaveBeenCalled();
    expect(clearUsageLimitOnResumedProgress).not.toHaveBeenCalled();
    expect(markLoadingActivity).not.toHaveBeenCalled();
    expect(startLoading).not.toHaveBeenCalled();
    expect(stopLoading).toHaveBeenCalledTimes(1);
  });

  it('keeps the session idle on a trailing busy status after the reply already completed', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();

    loadingStartedAt.mockReturnValue(1);
    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [createCompletedAssistantEntry(1, 2)],
        setSessionStatusEntry,
      })
    );

    handlers.get('session.status')?.({
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });

    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(setSessionStatusEntry).not.toHaveBeenCalledWith('session-1', { type: 'busy' });
    expect(startLoading).not.toHaveBeenCalled();
    expect(stopLoading).toHaveBeenCalledTimes(1);

    loadingStartedAt.mockReturnValue(null);
  });

  it('marks the session busy on a fresh busy status before the reply has finished', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();

    loadingStartedAt.mockReturnValue(5);
    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        // Latest assistant finished at t=2, before the current loading window (t=5):
        // a genuinely new turn, so the busy status must stand.
        getMessages: () => [createCompletedAssistantEntry(1, 2)],
        setSessionStatusEntry,
      })
    );

    handlers.get('session.status')?.({
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });

    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'busy' });
    expect(startLoading).toHaveBeenCalledTimes(1);

    loadingStartedAt.mockReturnValue(null);
  });

  it('rechecks status after the final text quiets without clearing active loading', () => {
    vi.useFakeTimers();
    try {
      const handlers = installHandlers();
      const setSessionStatusEntry = vi.fn();
      const recheckSessionStatus = vi.fn().mockResolvedValue(undefined);
      let assistantEntry = {
        ...(createAssistantEntry() as { info: Message; parts: Part[] }),
        parts: [
          {
            id: 'text-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'text',
            text: 'Hello there',
          },
        ] as Part[],
      };

      upsertMessageInfo.mockClear();
      upsertMessageInfo.mockImplementation((info: Message) => {
        assistantEntry = { ...assistantEntry, info };
      });
      finishMessageStreaming.mockClear();
      startLoading.mockClear();
      stopLoading.mockClear();

      registerSessionEventHandlers(
        createDefaultDeps({
          getActiveSessionId: () => 'session-1',
          getMessages: () => [assistantEntry],
          setSessionStatusEntry,
          recheckSessionStatus,
        })
      );

      handlers.get('session.next.text.ended')?.({
        properties: { sessionID: 'session-1' },
      });

      // Nothing rechecks until the quiet window elapses.
      expect(finishMessageStreaming).not.toHaveBeenCalled();
      expect(recheckSessionStatus).not.toHaveBeenCalled();
      setSessionStatusEntry.mockClear();
      startLoading.mockClear();

      vi.advanceTimersByTime(600);

      expect(finishMessageStreaming).not.toHaveBeenCalled();
      expect(setSessionStatusEntry).not.toHaveBeenCalledWith('session-1', { type: 'idle' });
      expect(stopLoading).not.toHaveBeenCalled();
      expect(recheckSessionStatus).toHaveBeenCalledWith('session-1');

      handlers.get('session.next.tool.called')?.({
        properties: { sessionID: 'session-1', assistantMessageID: 'assistant-1', callID: 'call-1' },
      });

      expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'busy' });
      expect(startLoading).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the streamed-completion recheck when a tool starts after the text', () => {
    vi.useFakeTimers();
    try {
      const handlers = installHandlers();
      const recheckSessionStatus = vi.fn().mockResolvedValue(undefined);
      const assistantEntry = {
        ...(createAssistantEntry() as { info: Message; parts: Part[] }),
        parts: [
          {
            id: 'text-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'text',
            text: 'Working on it',
          },
        ] as Part[],
      };

      finishMessageStreaming.mockClear();

      registerSessionEventHandlers(
        createDefaultDeps({
          getActiveSessionId: () => 'session-1',
          getMessages: () => [assistantEntry],
          recheckSessionStatus,
        })
      );

      handlers.get('session.next.text.ended')?.({
        properties: { sessionID: 'session-1' },
      });
      // A tool call arrives before the quiet window elapses — the turn is not done.
      handlers.get('session.next.tool.called')?.({
        properties: { sessionID: 'session-1', assistantMessageID: 'assistant-1', callID: 'call-1' },
      });

      vi.advanceTimersByTime(600);

      expect(finishMessageStreaming).not.toHaveBeenCalled();
      expect(recheckSessionStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a terminal v2 step end when no idle event arrives', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    const updateUsageLimitState = vi.fn();
    const clearPendingAbort = vi.fn();
    const syncSession = vi.fn().mockResolvedValue(undefined);
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    let assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };

    upsertMessageInfo.mockClear();
    upsertMessageInfo.mockImplementation((info: Message) => {
      assistantEntry = { ...assistantEntry, info };
    });
    finishMessageStreaming.mockClear();
    markLoadingActivity.mockClear();
    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
        setSessionStatusEntry,
        updateUsageLimitState,
        clearPendingAbort,
        syncSession,
        shouldResyncSessionAfterIdle: () => true,
        syncSessionMessages,
      })
    );

    handlers.get('session.next.step.ended')?.({
      seq: 1,
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'assistant-1',
        finish: 'stop',
        timestamp: 3,
      },
    });

    expect(upsertMessageInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'assistant-1',
        time: { created: 1, completed: 3 },
      })
    );
    expect(finishMessageStreaming).toHaveBeenCalledWith('assistant-1');
    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(clearPendingAbort).toHaveBeenCalledWith('session-1');
    expect(updateUsageLimitState).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(syncSession).toHaveBeenCalledWith('session-1');
    expect(syncSessionMessages).not.toHaveBeenCalled();
    expect(markLoadingActivity).not.toHaveBeenCalled();
    expect(startLoading).not.toHaveBeenCalled();
    expect(stopLoading).toHaveBeenCalledTimes(1);

    upsertMessageInfo.mockReset();
  });

  it('settles a terminal step-finish part when no idle event arrives', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    const updateUsageLimitState = vi.fn();
    const clearPendingAbort = vi.fn();
    const syncSession = vi.fn().mockResolvedValue(undefined);
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    let assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };

    upsertMessageInfo.mockClear();
    upsertMessageInfo.mockImplementation((info: Message) => {
      assistantEntry = { ...assistantEntry, info };
    });
    upsertPart.mockClear();
    finishMessageStreaming.mockClear();
    markLoadingActivity.mockClear();
    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
        setSessionStatusEntry,
        updateUsageLimitState,
        clearPendingAbort,
        syncSession,
        shouldResyncSessionAfterIdle: () => true,
        syncSessionMessages,
      })
    );

    handlers.get('message.part.updated')?.({
      properties: {
        timestamp: 3,
        part: {
          id: 'step-finish-1',
          sessionID: 'session-1',
          messageID: 'assistant-1',
          type: 'step-finish',
          reason: 'stop',
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    });

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'step-finish-1',
        type: 'step-finish',
        reason: 'stop',
      })
    );
    expect(upsertMessageInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'assistant-1',
        time: { created: 1, completed: 3 },
      })
    );
    expect(finishMessageStreaming).toHaveBeenCalledWith('assistant-1');
    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(clearPendingAbort).toHaveBeenCalledWith('session-1');
    expect(updateUsageLimitState).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(syncSession).toHaveBeenCalledWith('session-1');
    expect(syncSessionMessages).not.toHaveBeenCalled();
    expect(startLoading).not.toHaveBeenCalled();
    expect(stopLoading).toHaveBeenCalledTimes(1);

    upsertMessageInfo.mockReset();
  });

  it('keeps tool-call step-finish parts in progress', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    let assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };

    upsertMessageInfo.mockClear();
    upsertMessageInfo.mockImplementation((info: Message) => {
      assistantEntry = { ...assistantEntry, info };
    });
    upsertPart.mockClear();
    finishMessageStreaming.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
        setSessionStatusEntry,
      })
    );

    handlers.get('message.part.updated')?.({
      properties: {
        part: {
          id: 'step-finish-1',
          sessionID: 'session-1',
          messageID: 'assistant-1',
          type: 'step-finish',
          reason: 'tool-calls',
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    });

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'step-finish-1',
        type: 'step-finish',
        reason: 'tool-calls',
      })
    );
    expect(upsertMessageInfo).not.toHaveBeenCalled();
    expect(finishMessageStreaming).not.toHaveBeenCalled();
    expect(setSessionStatusEntry).not.toHaveBeenCalled();
    expect(stopLoading).not.toHaveBeenCalled();

    upsertMessageInfo.mockReset();
  });

  it('ignores replayed v2 parts after a terminal step completes the assistant message', () => {
    const handlers = installHandlers();
    let assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };

    upsertMessageInfo.mockClear();
    upsertMessageInfo.mockImplementation((info: Message) => {
      assistantEntry = { ...assistantEntry, info };
    });
    upsertPart.mockClear();
    markLoadingActivity.mockClear();
    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
      })
    );

    handlers.get('session.next.step.ended')?.({
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'assistant-1',
        finish: 'stop',
        timestamp: 3,
      },
    });
    upsertPart.mockClear();
    markLoadingActivity.mockClear();
    startLoading.mockClear();
    stopLoading.mockClear();

    handlers.get('session.next.text.ended')?.({
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'assistant-1',
        textID: 'text-replay',
        text: 'stale replay',
      },
    });

    expect(upsertPart).not.toHaveBeenCalled();
    expect(markLoadingActivity).not.toHaveBeenCalled();
    expect(startLoading).not.toHaveBeenCalled();
    expect(stopLoading).toHaveBeenCalledTimes(1);

    upsertMessageInfo.mockReset();
  });

  it('keeps tool-call v2 step ends in progress', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        setSessionStatusEntry,
        syncSessionMessages,
      })
    );

    handlers.get('session.next.step.ended')?.({
      seq: 1,
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'assistant-1',
        finish: 'tool_calls',
      },
    });

    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'busy' });
    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(stopLoading).not.toHaveBeenCalled();
    expect(syncSessionMessages).not.toHaveBeenCalled();
  });

  it('settles terminal v2 step ends against the latest legacy assistant when ids differ', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    const updateUsageLimitState = vi.fn();
    const clearPendingAbort = vi.fn();
    const syncSession = vi.fn().mockResolvedValue(undefined);
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    let assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };

    upsertMessageInfo.mockClear();
    upsertMessageInfo.mockImplementation((info: Message) => {
      assistantEntry = { ...assistantEntry, info };
    });
    finishMessageStreaming.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [assistantEntry],
        setSessionStatusEntry,
        updateUsageLimitState,
        clearPendingAbort,
        syncSession,
        shouldResyncSessionAfterIdle: () => true,
        syncSessionMessages,
      })
    );

    handlers.get('session.next.step.ended')?.({
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'v2-assistant-1',
        finish: 'stop',
        timestamp: 3,
      },
    });

    expect(upsertMessageInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'assistant-1',
        time: { created: 1, completed: 3 },
      })
    );
    expect(finishMessageStreaming).toHaveBeenCalledWith('assistant-1');
    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(clearPendingAbort).toHaveBeenCalledWith('session-1');
    expect(updateUsageLimitState).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(syncSession).toHaveBeenCalledWith('session-1');
    expect(syncSessionMessages).not.toHaveBeenCalled();
    expect(stopLoading).toHaveBeenCalledTimes(1);

    upsertMessageInfo.mockReset();
  });

  it('settles a pending terminal v2 step after the legacy assistant sync arrives', async () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    const updateUsageLimitState = vi.fn();
    const clearPendingAbort = vi.fn();
    const syncSession = vi.fn().mockResolvedValue(undefined);
    let messages: Array<{ info: Message; parts: Part[] }> = [
      createUserEntry() as { info: Message; parts: Part[] },
    ];
    const assistantEntry = createAssistantEntry() as { info: Message; parts: Part[] };
    const syncSessionMessages = vi.fn(async () => {
      messages = [assistantEntry];
    });

    upsertMessageInfo.mockClear();
    upsertMessageInfo.mockImplementation((info: Message) => {
      messages = [{ ...assistantEntry, info }];
    });
    finishMessageStreaming.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => messages,
        setSessionStatusEntry,
        updateUsageLimitState,
        clearPendingAbort,
        syncSession,
        shouldResyncSessionAfterIdle: () => true,
        syncSessionMessages,
      })
    );

    handlers.get('session.next.step.ended')?.({
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'v2-assistant-1',
        finish: 'stop',
        timestamp: 3,
      },
    });

    await vi.waitFor(() => {
      expect(upsertMessageInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'assistant-1',
          time: { created: 1, completed: 3 },
        })
      );
    });
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
    expect(finishMessageStreaming).toHaveBeenCalledWith('assistant-1');
    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(clearPendingAbort).toHaveBeenCalledWith('session-1');
    expect(updateUsageLimitState).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(syncSession).toHaveBeenCalledWith('session-1');
    expect(stopLoading).toHaveBeenCalledTimes(1);

    upsertMessageInfo.mockReset();
  });

  it('does not settle an older assistant when a newer user prompt is latest', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    upsertMessageInfo.mockClear();
    finishMessageStreaming.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          createAssistantEntry() as { info: Message; parts: Part[] },
          createUserEntry({ id: 'user-2' }) as { info: Message; parts: Part[] },
        ],
        setSessionStatusEntry,
        syncSessionMessages,
      })
    );

    handlers.get('session.next.step.ended')?.({
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'v2-assistant-1',
        finish: 'stop',
      },
    });

    expect(upsertMessageInfo).not.toHaveBeenCalled();
    expect(finishMessageStreaming).not.toHaveBeenCalled();
    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'busy' });
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });

  it('marks inactive sessions busy from progress events without active message work', () => {
    const handlers = installHandlers();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    const setSessionStatusEntry = vi.fn();
    const clearUsageLimitOnResumedProgress = vi.fn();

    markLoadingActivity.mockClear();
    startLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'active-session',
        syncSessionMessages,
        setSessionStatusEntry,
        clearUsageLimitOnResumedProgress,
      })
    );

    handlers.get('session.next.text.delta')?.({
      properties: {
        sessionID: 'background-session',
        text: 'streaming response',
      },
    });
    handlers.get('session.next.reasoning.delta')?.({
      properties: {
        sessionID: 'reasoning-session',
        reasoningID: 'reasoning-1',
        delta: 'thinking',
      },
    });

    expect(setSessionStatusEntry).toHaveBeenNthCalledWith(1, 'background-session', {
      type: 'busy',
    });
    expect(setSessionStatusEntry).toHaveBeenNthCalledWith(2, 'reasoning-session', {
      type: 'busy',
    });
    expect(clearUsageLimitOnResumedProgress).toHaveBeenNthCalledWith(1, 'background-session', {
      type: 'busy',
    });
    expect(clearUsageLimitOnResumedProgress).toHaveBeenNthCalledWith(2, 'reasoning-session', {
      type: 'busy',
    });
    expect(markLoadingActivity).not.toHaveBeenCalled();
    expect(startLoading).not.toHaveBeenCalled();
    expect(syncSessionMessages).not.toHaveBeenCalled();
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

  it('refreshes todos when the active session becomes idle', () => {
    const handlers = installHandlers();
    const messages = [createCompletedAssistantEntry(1, 2)];
    const syncTodosForSession = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => messages,
        syncTodosForSession,
      })
    );

    handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

    expect(syncTodosForSession).toHaveBeenCalledWith('session-1', messages);
  });

  it('settles the latest active assistant message when the session becomes idle', () => {
    const handlers = installHandlers();

    upsertMessageInfo.mockClear();
    finishMessageStreaming.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [createAssistantEntry() as { info: Message; parts: Part[] }],
      })
    );

    handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

    expect(upsertMessageInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'assistant-1',
        time: expect.objectContaining({ completed: expect.any(Number) }),
      })
    );
    expect(finishMessageStreaming).toHaveBeenCalledWith('assistant-1');
  });

  it('does not settle an older assistant when the latest session message is a user prompt', () => {
    const handlers = installHandlers();

    upsertMessageInfo.mockClear();
    finishMessageStreaming.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          createAssistantEntry() as { info: Message; parts: Part[] },
          createUserEntry() as { info: Message; parts: Part[] },
        ],
      })
    );

    handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

    expect(upsertMessageInfo).not.toHaveBeenCalled();
    expect(finishMessageStreaming).not.toHaveBeenCalled();
  });

  it('does not mark the active session seen on idle while the session list is open', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    const handoffTodosToMessages = vi.fn().mockReturnValue(true);

    markSessionSeen.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        handoffTodosToMessages,
        setSessionStatusEntry,
      })
    );

    setShowSessionPicker(true);
    handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });
    setShowSessionPicker(false);

    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(markSessionSeen).not.toHaveBeenCalled();
    expect(handoffTodosToMessages).toHaveBeenCalledTimes(1);
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

  it('resyncs messages on idle when the active chat is empty', () => {
    const handlers = installHandlers();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [],
        shouldResyncSessionAfterIdle: () => true,
        syncSessionMessages,
      })
    );

    handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
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

  it('keeps loading for a busy follow-up sent after the previous assistant completed', () => {
    const handlers = installHandlers();

    loadingStartedAt.mockReturnValueOnce(3);
    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [createCompletedAssistantEntry(1, 2)],
      })
    );

    handlers.get('session.status')?.({
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });

    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(stopLoading).not.toHaveBeenCalled();
  });

  it('keeps active parent loading when a child session is still working', () => {
    const handlers = installHandlers();

    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-parent',
        isSessionInActiveTree: (sessionId) =>
          sessionId === 'session-parent' || sessionId === 'session-child',
      })
    );

    handlers.get('session.status')?.({
      properties: { sessionID: 'session-child', status: { type: 'busy' } },
    });
    handlers.get('message.updated')?.({
      properties: {
        info: {
          ...createAssistantEntry({
            id: 'assistant-parent-1',
            sessionID: 'session-parent',
            time: { created: 1, completed: 2 },
          }).info,
        },
      },
    });

    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(stopLoading).not.toHaveBeenCalled();
  });

  it('stops active parent loading when the last working child session becomes idle', () => {
    const handlers = installHandlers();

    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-parent',
        isSessionInActiveTree: (sessionId) =>
          sessionId === 'session-parent' || sessionId === 'session-child',
      })
    );

    handlers.get('session.status')?.({
      properties: { sessionID: 'session-child', status: { type: 'busy' } },
    });
    handlers.get('message.updated')?.({
      properties: {
        info: {
          ...createAssistantEntry({
            id: 'assistant-parent-1',
            sessionID: 'session-parent',
            time: { created: 1, completed: 2 },
          }).info,
        },
      },
    });

    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(stopLoading).not.toHaveBeenCalled();

    handlers.get('session.idle')?.({ properties: { sessionID: 'session-child' } });

    expect(stopLoading).toHaveBeenCalledTimes(1);
  });

  it('stops loading for a stale busy status when synced assistant already completed', () => {
    const handlers = installHandlers();

    loadingStartedAt.mockReturnValueOnce(1);
    startLoading.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [createCompletedAssistantEntry(1, 2)],
      })
    );

    handlers.get('session.status')?.({
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });

    expect(stopLoading).toHaveBeenCalledTimes(1);
    expect(startLoading).not.toHaveBeenCalled();
  });

  it('applies late part deltas after completion without marking the session busy', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();
    const completedAssistant = createCompletedAssistantEntry(1, 2);
    completedAssistant.parts = [
      {
        id: 'text-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'text',
        text: 'done',
      },
    ];

    loadingStartedAt.mockReturnValueOnce(1);
    applyMessagePartDelta.mockClear();
    markLoadingActivity.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [completedAssistant],
        setSessionStatusEntry,
      })
    );

    handlers.get('message.part.delta')?.({
      properties: {
        sessionID: 'session-1',
        messageID: 'assistant-1',
        partID: 'text-1',
        delta: 'late',
        field: 'text',
      },
    });

    expect(setSessionStatusEntry).not.toHaveBeenCalled();
    expect(markLoadingActivity).not.toHaveBeenCalled();
    expect(applyMessagePartDelta).toHaveBeenCalledWith(
      'assistant-1',
      'text-1',
      'late',
      'session-1',
      'text'
    );
    expect(stopLoading).toHaveBeenCalledTimes(1);
  });

  it('ignores late reasoning deltas after the assistant message already completed', () => {
    const handlers = installHandlers();
    const setSessionStatusEntry = vi.fn();

    loadingStartedAt.mockReturnValueOnce(1);
    applyMessagePartDelta.mockClear();
    markLoadingActivity.mockClear();
    stopLoading.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        getMessages: () => [createCompletedAssistantEntry(1, 2)],
        setSessionStatusEntry,
      })
    );

    handlers.get('session.next.reasoning.delta')?.({
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'assistant-1',
        reasoningID: 'reasoning-1',
        delta: 'late',
      },
    });

    expect(setSessionStatusEntry).not.toHaveBeenCalled();
    expect(markLoadingActivity).not.toHaveBeenCalled();
    expect(applyMessagePartDelta).not.toHaveBeenCalled();
    expect(stopLoading).toHaveBeenCalledTimes(1);
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

  it('syncs session state when OpenCode reports compaction completion', () => {
    const handlers = installHandlers();
    const syncSession = vi.fn().mockResolvedValue(undefined);
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    setSessionCompactingStore.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        getActiveSessionId: () => 'session-1',
        syncSession,
        syncSessionMessages,
      })
    );

    handlers.get('session.compacted')?.({ properties: { sessionID: 'session-1' } });

    expect(setSessionCompactingStore).toHaveBeenCalledWith('session-1', false);
    expect(syncSession).toHaveBeenCalledWith('session-1');
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });

  it('merges sync session updates by sessionID without overwriting existing fields with nulls', () => {
    const handlers = installHandlers();
    const upsertSession = vi.fn();
    const setSessionCompacting = vi.fn();

    state.sessions = [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'New Chat',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ];
    setState.mockClear();

    registerSessionEventHandlers(
      createDefaultDeps({
        upsertSession,
        setSessionCompacting,
      })
    );

    handlers.get('session.updated')?.({
      properties: {
        sessionID: 'session-1',
        info: {
          title: 'Updated title',
          version: null,
          agent: 'plan',
          time: { created: null, updated: 2 },
        },
      },
    });

    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1',
        title: 'Updated title',
        version: '1',
        time: { created: 1, updated: 2 },
      })
    );
    expect(setState).toHaveBeenCalledWith('sessionSelectedAgents', 'session-1', 'plan');
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

    expect(syncTodosFromMessages).toHaveBeenCalledTimes(1);
    expect(syncTodosFromMessages).toHaveBeenCalledWith(undefined, {
      sessionID: 'session-child',
      todos: [],
    });
    expect(setDiffs).toHaveBeenCalledTimes(1);
    expect(setDiffs).toHaveBeenCalledWith([diff]);
  });
});
