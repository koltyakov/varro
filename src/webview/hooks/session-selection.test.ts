import { describe, expect, it, vi } from 'vitest';
import type { Message, Session, SessionStatus } from '../types';
import {
  selectSessionWithDependencies,
  syncSessionMessagesWithDependencies,
} from './session/session-selection';

function assistantMessage(id: string): Message {
  return {
    id,
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
  };
}

function selectedModelFromSession(session: Session) {
  if (!session.model) return null;
  return {
    providerID: session.model.providerID,
    modelID: session.model.id,
    variant: session.model.variant,
  };
}

describe('session-selection helpers', () => {
  it('restores a locally redefined model while selecting and loading a session', async () => {
    const activeSession = { value: 'session-0' as string | null };
    const startLoading = vi.fn();
    const stopLoading = vi.fn();
    const clearMessages = vi.fn();
    const persistActiveSessionId = vi.fn();
    const markSessionSeen = vi.fn();
    const syncSessionMcps = vi.fn(async () => {});
    const applySelectedModel = vi.fn();
    const resolvePersistedModel = vi.fn(() => ({
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'high',
    }));
    const resolveFallbackModel = vi.fn(() => ({
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'high',
    }));
    const deriveSelectedModelFromMessages = vi.fn(() => ({
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'high',
    }));
    const externalSession: Session = {
      id: 'session-1',
      projectID: 'project-1',
      directory: '/repo',
      title: 'Session 1',
      version: '1',
      model: { providerID: 'openai', id: 'gpt-5.6-sol', variant: 'high' },
      time: { created: 0, updated: 2 },
    };

    await selectSessionWithDependencies(
      {
        getActiveSessionId: () => activeSession.value,
        setActiveSessionId: (id) => {
          activeSession.value = id;
        },
        clearPendingAbort: vi.fn(),
        persistActiveSessionId,
        markSessionSeen,
        clearDraftCurrentDocumentState: vi.fn(),
        resetToolCallExpansionState: vi.fn(),
        resolvePersistedAgent: () => ({ persistedAgent: null, fallbackAgent: 'build' }),
        applySelectedAgent: vi.fn(),
        getSession: () => externalSession,
        resolveSessionModel: selectedModelFromSession,
        resolvePersistedModel,
        resolveFallbackModel,
        applySelectedModel,
        getConnectedMcpNames: () => ['docs'],
        hasSelectedMcps: () => false,
        setSelectedMcpsForSession: vi.fn(),
        syncSessionMcps,
        resetTodoSync: vi.fn(),
        clearMessages,
        loadSession: vi.fn(async () => ({
          session: externalSession,
          messages: [{ info: assistantMessage('assistant-1'), parts: [] }],
        })),
        isCurrentSelectionGeneration: () => true,
        upsertSession: vi.fn(),
        setMessagesIncremental: vi.fn(),
        syncFailedSessionsFromMessages: vi.fn(),
        requestMessageListScrollToBottom: vi.fn(),
        deriveSelectedAgentFromMessages: () => 'build',
        deriveSelectedModelFromMessages,
        syncTodosForSession: vi.fn(async () => {}),
        loadQuestions: vi.fn(async () => {}),
        loadSessionStatuses: vi.fn(async () => ({ 'session-1': { type: 'busy' as const } })),
        mergeSessionStatuses: vi.fn(),
        updateUsageLimitState: vi.fn(),
        startLoading,
        stopLoading,
        setError: vi.fn(),
      },
      { next: () => 1 },
      'session-1',
      {
        selectedModel: {
          providerID: 'openai',
          modelID: 'gpt-5.6-luna',
          variant: 'max',
        },
      }
    );

    expect(activeSession.value).toBe('session-1');
    expect(clearMessages.mock.invocationCallOrder[0]).toBeLessThan(
      syncSessionMcps.mock.invocationCallOrder[0]
    );
    expect(persistActiveSessionId).toHaveBeenCalledWith('session-1');
    expect(markSessionSeen).toHaveBeenCalledWith('session-1');
    expect(applySelectedModel).toHaveBeenNthCalledWith(
      1,
      {
        providerID: 'openai',
        modelID: 'gpt-5.6-sol',
        variant: 'high',
      },
      'session-1'
    );
    expect(applySelectedModel).toHaveBeenNthCalledWith(
      2,
      {
        providerID: 'openai',
        modelID: 'gpt-5.6-sol',
        variant: 'high',
      },
      'session-1'
    );
    expect(resolvePersistedModel).toHaveBeenCalledWith('session-1');
    expect(resolveFallbackModel).not.toHaveBeenCalled();
    expect(deriveSelectedModelFromMessages).not.toHaveBeenCalled();
    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(stopLoading).not.toHaveBeenCalled();
  });

  it('flags messages as loading until the session messages are applied', async () => {
    let resolveLoad!: (value: {
      session: {
        id: string;
        projectID: string;
        directory: string;
        title: string;
        version: string;
        time: { created: number; updated: number };
      };
      messages: { info: Message; parts: never[] }[];
    }) => void;
    const loadPromise = new Promise<Parameters<typeof resolveLoad>[0]>((resolve) => {
      resolveLoad = resolve;
    });
    const setMessagesLoading = vi.fn();
    const setMessagesIncremental = vi.fn();

    const selection = selectSessionWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        setActiveSessionId: vi.fn(),
        clearPendingAbort: vi.fn(),
        persistActiveSessionId: vi.fn(),
        markSessionSeen: vi.fn(),
        clearDraftCurrentDocumentState: vi.fn(),
        resetToolCallExpansionState: vi.fn(),
        resolvePersistedAgent: () => ({ persistedAgent: null, fallbackAgent: 'build' }),
        applySelectedAgent: vi.fn(),
        getSession: () => undefined,
        resolveSessionModel: selectedModelFromSession,
        resolvePersistedModel: () => null,
        resolveFallbackModel: () => null,
        applySelectedModel: vi.fn(),
        getConnectedMcpNames: () => [],
        hasSelectedMcps: () => false,
        setSelectedMcpsForSession: vi.fn(),
        syncSessionMcps: vi.fn(async () => {}),
        resetTodoSync: vi.fn(),
        clearMessages: vi.fn(),
        setMessagesLoading,
        loadSession: vi.fn(() => loadPromise),
        isCurrentSelectionGeneration: () => true,
        upsertSession: vi.fn(),
        setMessagesIncremental,
        syncFailedSessionsFromMessages: vi.fn(),
        requestMessageListScrollToBottom: vi.fn(),
        deriveSelectedAgentFromMessages: () => null,
        deriveSelectedModelFromMessages: () => null,
        syncTodosForSession: vi.fn(async () => {}),
        loadQuestions: vi.fn(async () => {}),
        loadSessionStatuses: vi.fn(async () => ({})),
        mergeSessionStatuses: vi.fn(),
        updateUsageLimitState: vi.fn(),
        startLoading: vi.fn(),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      { next: () => 1 },
      'session-1'
    );

    await vi.waitFor(() => expect(setMessagesLoading).toHaveBeenCalledWith(true));
    expect(setMessagesLoading).not.toHaveBeenCalledWith(false);

    resolveLoad({
      session: {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 2 },
      },
      messages: [{ info: assistantMessage('assistant-1'), parts: [] }],
    });
    await selection;

    expect(setMessagesLoading.mock.lastCall).toEqual([false]);
    expect(setMessagesLoading.mock.invocationCallOrder[1]).toBeGreaterThan(
      setMessagesIncremental.mock.invocationCallOrder[0]
    );
  });

  it('clears the loading flag and reports an error when the session load fails', async () => {
    const setMessagesLoading = vi.fn();
    const setError = vi.fn();

    await selectSessionWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        setActiveSessionId: vi.fn(),
        clearPendingAbort: vi.fn(),
        persistActiveSessionId: vi.fn(),
        markSessionSeen: vi.fn(),
        clearDraftCurrentDocumentState: vi.fn(),
        resetToolCallExpansionState: vi.fn(),
        resolvePersistedAgent: () => ({ persistedAgent: null, fallbackAgent: 'build' }),
        applySelectedAgent: vi.fn(),
        getSession: () => undefined,
        resolveSessionModel: selectedModelFromSession,
        resolvePersistedModel: () => null,
        resolveFallbackModel: () => null,
        applySelectedModel: vi.fn(),
        getConnectedMcpNames: () => [],
        hasSelectedMcps: () => false,
        setSelectedMcpsForSession: vi.fn(),
        syncSessionMcps: vi.fn(async () => {}),
        resetTodoSync: vi.fn(),
        clearMessages: vi.fn(),
        setMessagesLoading,
        loadSession: vi.fn(async () => {
          throw new Error('load failed');
        }),
        isCurrentSelectionGeneration: () => true,
        upsertSession: vi.fn(),
        setMessagesIncremental: vi.fn(),
        syncFailedSessionsFromMessages: vi.fn(),
        requestMessageListScrollToBottom: vi.fn(),
        deriveSelectedAgentFromMessages: () => null,
        deriveSelectedModelFromMessages: () => null,
        syncTodosForSession: vi.fn(async () => {}),
        loadQuestions: vi.fn(async () => {}),
        loadSessionStatuses: vi.fn(async () => ({})),
        mergeSessionStatuses: vi.fn(),
        updateUsageLimitState: vi.fn(),
        startLoading: vi.fn(),
        stopLoading: vi.fn(),
        setError,
      },
      { next: () => 1 },
      'session-1'
    );

    expect(setMessagesLoading).toHaveBeenNthCalledWith(1, true);
    expect(setMessagesLoading).toHaveBeenNthCalledWith(2, false);
    expect(setError).toHaveBeenCalledWith('Failed to load messages');
  });

  it('does not persist, mark seen, or surface an error for stale selection failures', async () => {
    const persistActiveSessionId = vi.fn();
    const markSessionSeen = vi.fn();
    const setError = vi.fn();

    await selectSessionWithDependencies(
      {
        getActiveSessionId: () => 'session-2',
        setActiveSessionId: vi.fn(),
        clearPendingAbort: vi.fn(),
        persistActiveSessionId,
        markSessionSeen,
        clearDraftCurrentDocumentState: vi.fn(),
        resetToolCallExpansionState: vi.fn(),
        resolvePersistedAgent: () => ({ persistedAgent: null, fallbackAgent: 'build' }),
        applySelectedAgent: vi.fn(),
        getSession: () => undefined,
        resolveSessionModel: selectedModelFromSession,
        resolvePersistedModel: () => null,
        resolveFallbackModel: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        applySelectedModel: vi.fn(),
        getConnectedMcpNames: () => ['docs'],
        hasSelectedMcps: () => false,
        setSelectedMcpsForSession: vi.fn(),
        syncSessionMcps: vi.fn(async () => {}),
        resetTodoSync: vi.fn(),
        clearMessages: vi.fn(),
        loadSession: vi.fn(async () => {
          throw new Error('offline');
        }),
        isCurrentSelectionGeneration: () => false,
        upsertSession: vi.fn(),
        setMessagesIncremental: vi.fn(),
        syncFailedSessionsFromMessages: vi.fn(),
        requestMessageListScrollToBottom: vi.fn(),
        deriveSelectedAgentFromMessages: () => null,
        deriveSelectedModelFromMessages: () => null,
        syncTodosForSession: vi.fn(async () => {}),
        loadQuestions: vi.fn(async () => {}),
        loadSessionStatuses: vi.fn(async () => ({})),
        mergeSessionStatuses: vi.fn(),
        updateUsageLimitState: vi.fn(),
        startLoading: vi.fn(),
        stopLoading: vi.fn(),
        setError,
      },
      { next: () => 1 },
      'session-1'
    );

    expect(persistActiveSessionId).not.toHaveBeenCalled();
    expect(markSessionSeen).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it('does not block message loading on MCP reconciliation', async () => {
    let resolveMcpSync!: () => void;
    const mcpSync = new Promise<void>((resolve) => {
      resolveMcpSync = resolve;
    });
    const setMessagesIncremental = vi.fn();
    const selection = selectSessionWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        setActiveSessionId: vi.fn(),
        clearPendingAbort: vi.fn(),
        persistActiveSessionId: vi.fn(),
        markSessionSeen: vi.fn(),
        clearDraftCurrentDocumentState: vi.fn(),
        resetToolCallExpansionState: vi.fn(),
        resolvePersistedAgent: () => ({ persistedAgent: null, fallbackAgent: 'build' }),
        applySelectedAgent: vi.fn(),
        getSession: () => undefined,
        resolveSessionModel: selectedModelFromSession,
        resolvePersistedModel: () => null,
        resolveFallbackModel: () => null,
        applySelectedModel: vi.fn(),
        getConnectedMcpNames: () => [],
        hasSelectedMcps: () => false,
        setSelectedMcpsForSession: vi.fn(),
        syncSessionMcps: vi.fn(() => mcpSync),
        resetTodoSync: vi.fn(),
        clearMessages: vi.fn(),
        loadSession: vi.fn(async () => ({
          session: {
            id: 'session-1',
            projectID: 'project-1',
            directory: '/repo',
            title: 'Session 1',
            version: '1',
            time: { created: 0, updated: 2 },
          },
          messages: [{ info: assistantMessage('assistant-1'), parts: [] }],
        })),
        isCurrentSelectionGeneration: () => true,
        upsertSession: vi.fn(),
        setMessagesIncremental,
        syncFailedSessionsFromMessages: vi.fn(),
        requestMessageListScrollToBottom: vi.fn(),
        deriveSelectedAgentFromMessages: () => null,
        deriveSelectedModelFromMessages: () => null,
        syncTodosForSession: vi.fn(async () => {}),
        loadQuestions: vi.fn(async () => {}),
        loadSessionStatuses: vi.fn(async () => ({})),
        mergeSessionStatuses: vi.fn(),
        updateUsageLimitState: vi.fn(),
        startLoading: vi.fn(),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      { next: () => 1 },
      'session-1'
    );

    await vi.waitFor(() => expect(setMessagesIncremental).toHaveBeenCalledTimes(1));
    resolveMcpSync();
    await selection;
  });

  it('does not report loaded messages as failed when follow-up startup sync fails', async () => {
    const activeSession = { value: null as string | null };
    const setMessagesIncremental = vi.fn();
    const setError = vi.fn();
    const messages = [{ info: assistantMessage('assistant-1'), parts: [] }];

    await selectSessionWithDependencies(
      {
        getActiveSessionId: () => activeSession.value,
        setActiveSessionId: (id) => {
          activeSession.value = id;
        },
        clearPendingAbort: vi.fn(),
        persistActiveSessionId: vi.fn(),
        markSessionSeen: vi.fn(),
        clearDraftCurrentDocumentState: vi.fn(),
        resetToolCallExpansionState: vi.fn(),
        resolvePersistedAgent: () => ({ persistedAgent: null, fallbackAgent: 'build' }),
        applySelectedAgent: vi.fn(),
        getSession: () => undefined,
        resolveSessionModel: selectedModelFromSession,
        resolvePersistedModel: () => null,
        resolveFallbackModel: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        applySelectedModel: vi.fn(),
        getConnectedMcpNames: () => [],
        hasSelectedMcps: () => false,
        setSelectedMcpsForSession: vi.fn(),
        syncSessionMcps: vi.fn(async () => {}),
        resetTodoSync: vi.fn(),
        clearMessages: vi.fn(),
        loadSession: vi.fn(async () => ({
          session: {
            id: 'session-1',
            projectID: 'project-1',
            directory: '/repo',
            title: 'Session 1',
            version: '1',
            time: { created: 0, updated: 2 },
          },
          messages,
        })),
        isCurrentSelectionGeneration: () => true,
        upsertSession: vi.fn(),
        setMessagesIncremental,
        syncFailedSessionsFromMessages: vi.fn(),
        requestMessageListScrollToBottom: vi.fn(),
        deriveSelectedAgentFromMessages: () => null,
        deriveSelectedModelFromMessages: () => null,
        syncTodosForSession: vi.fn(async () => {
          throw new Error('todos unavailable');
        }),
        loadQuestions: vi.fn(async () => {
          throw new Error('questions unavailable');
        }),
        loadSessionStatuses: vi.fn(async () => {
          throw new Error('statuses unavailable');
        }),
        mergeSessionStatuses: vi.fn(),
        updateUsageLimitState: vi.fn(),
        startLoading: vi.fn(),
        stopLoading: vi.fn(),
        setError,
      },
      { next: () => 1 },
      'session-1'
    );

    expect(setMessagesIncremental).toHaveBeenCalledWith(messages);
    expect(setError).not.toHaveBeenCalled();
  });

  it('syncs active-session messages only for the latest generation', async () => {
    const setMessagesIncremental = vi.fn();
    const stopLoading = vi.fn();
    const messages = [{ info: assistantMessage('assistant-1'), parts: [] }];
    const currentGeneration = { value: 0 };

    await syncSessionMessagesWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getSessionStatus: () => ({ type: 'idle' }) satisfies SessionStatus,
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => messages),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setMessagesIncremental,
        stopLoading,
        syncFailedSessionsFromMessages: vi.fn(),
        handoffTodosToMessages: vi.fn(),
      },
      {
        next: () => ++currentGeneration.value,
        isCurrent: (generation) => generation === currentGeneration.value,
      },
      'session-1'
    );

    expect(setMessagesIncremental).toHaveBeenCalledWith(messages, { preserveExtraParts: true });
    expect(stopLoading).not.toHaveBeenCalled();
  });

  it('keeps loading when synced active messages complete while status is still busy', async () => {
    const setMessagesIncremental = vi.fn();
    const stopLoading = vi.fn();
    const completed = assistantMessage('assistant-1');
    completed.time.completed = 2;

    await syncSessionMessagesWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getSessionStatus: () => ({ type: 'busy' }) satisfies SessionStatus,
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => [{ info: completed, parts: [] }]),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setMessagesIncremental,
        stopLoading,
        syncFailedSessionsFromMessages: vi.fn(),
        handoffTodosToMessages: vi.fn(),
      },
      {
        next: () => 1,
        isCurrent: () => true,
      },
      'session-1'
    );

    expect(setMessagesIncremental).toHaveBeenCalledWith([{ info: completed, parts: [] }], {
      preserveExtraParts: false,
    });
    expect(stopLoading).not.toHaveBeenCalled();
  });

  it('stops loading when synced active messages complete after status is idle', async () => {
    const setMessagesIncremental = vi.fn();
    const stopLoading = vi.fn();
    const completed = assistantMessage('assistant-1');
    completed.time.completed = 2;

    await syncSessionMessagesWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getSessionStatus: () => ({ type: 'idle' }) satisfies SessionStatus,
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => [{ info: completed, parts: [] }]),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setMessagesIncremental,
        stopLoading,
        syncFailedSessionsFromMessages: vi.fn(),
        handoffTodosToMessages: vi.fn(),
      },
      {
        next: () => 1,
        isCurrent: () => true,
      },
      'session-1'
    );

    expect(setMessagesIncremental).toHaveBeenCalledWith([{ info: completed, parts: [] }], {
      preserveExtraParts: false,
    });
    expect(stopLoading).toHaveBeenCalledTimes(1);
  });

  it('keeps retry sessions loading even when the latest assistant message has an error', async () => {
    const activeSession = { value: null as string | null };
    const startLoading = vi.fn();
    const stopLoading = vi.fn();
    const failed = assistantMessage('assistant-1');
    failed.error = { name: 'ProviderError', data: { message: '429 usage limit reached' } };

    await selectSessionWithDependencies(
      {
        getActiveSessionId: () => activeSession.value,
        setActiveSessionId: (id) => {
          activeSession.value = id;
        },
        clearPendingAbort: vi.fn(),
        persistActiveSessionId: vi.fn(),
        markSessionSeen: vi.fn(),
        clearDraftCurrentDocumentState: vi.fn(),
        resetToolCallExpansionState: vi.fn(),
        resolvePersistedAgent: () => ({ persistedAgent: null, fallbackAgent: 'build' }),
        applySelectedAgent: vi.fn(),
        getSession: () => undefined,
        resolveSessionModel: selectedModelFromSession,
        resolvePersistedModel: () => null,
        resolveFallbackModel: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        applySelectedModel: vi.fn(),
        getConnectedMcpNames: () => [],
        hasSelectedMcps: () => false,
        setSelectedMcpsForSession: vi.fn(),
        syncSessionMcps: vi.fn(async () => {}),
        resetTodoSync: vi.fn(),
        clearMessages: vi.fn(),
        loadSession: vi.fn(async () => ({
          session: {
            id: 'session-1',
            projectID: 'project-1',
            directory: '/repo',
            title: 'Session 1',
            version: '1',
            time: { created: 0, updated: 2 },
          },
          messages: [{ info: failed, parts: [] }],
        })),
        isCurrentSelectionGeneration: () => true,
        upsertSession: vi.fn(),
        setMessagesIncremental: vi.fn(),
        syncFailedSessionsFromMessages: vi.fn(),
        requestMessageListScrollToBottom: vi.fn(),
        deriveSelectedAgentFromMessages: () => null,
        deriveSelectedModelFromMessages: () => null,
        syncTodosForSession: vi.fn(async () => {}),
        loadQuestions: vi.fn(async () => {}),
        loadSessionStatuses: vi.fn(async () => ({ 'session-1': { type: 'retry' as const } })),
        mergeSessionStatuses: vi.fn(),
        updateUsageLimitState: vi.fn(),
        startLoading,
        stopLoading,
        setError: vi.fn(),
      },
      { next: () => 1 },
      'session-1'
    );

    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(stopLoading).not.toHaveBeenCalled();
  });

  it('keeps inactive sessions running when synced messages show completion', async () => {
    const setSessionStatusEntry = vi.fn();
    const syncFailedSessionsFromMessages = vi.fn();
    const completed = assistantMessage('assistant-1');
    completed.time.completed = 2;

    await syncSessionMessagesWithDependencies(
      {
        getActiveSessionId: () => 'session-2',
        getSessionStatus: () => ({ type: 'busy' }) satisfies SessionStatus,
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => [{ info: completed, parts: [] }]),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry,
        setMessagesIncremental: vi.fn(),
        stopLoading: vi.fn(),
        syncFailedSessionsFromMessages,
        handoffTodosToMessages: vi.fn(),
      },
      {
        next: () => 1,
        isCurrent: () => true,
      },
      'session-1'
    );

    expect(syncFailedSessionsFromMessages).toHaveBeenCalledWith([{ info: completed, parts: [] }]);
    expect(setSessionStatusEntry).not.toHaveBeenCalled();
  });

  it('reconciles stale failures for completed inactive idle sessions', async () => {
    const setSessionStatusEntry = vi.fn();
    const syncFailedSessionsFromMessages = vi.fn();
    const completed = assistantMessage('assistant-1');
    completed.time.completed = 2;
    const messages = [{ info: completed, parts: [] }];

    await syncSessionMessagesWithDependencies(
      {
        getActiveSessionId: () => 'session-2',
        getSessionStatus: () => ({ type: 'idle' }) satisfies SessionStatus,
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => messages),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry,
        setMessagesIncremental: vi.fn(),
        stopLoading: vi.fn(),
        syncFailedSessionsFromMessages,
        handoffTodosToMessages: vi.fn(),
      },
      {
        next: () => 1,
        isCurrent: () => true,
      },
      'session-1'
    );

    expect(syncFailedSessionsFromMessages).toHaveBeenCalledWith(messages);
    expect(setSessionStatusEntry).not.toHaveBeenCalled();
  });

  it('keeps loading when synced messages predate the current loading turn', async () => {
    const stopLoading = vi.fn();
    const completed = assistantMessage('assistant-1');
    completed.time.completed = 2;

    await syncSessionMessagesWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getSessionStatus: () => ({ type: 'busy' }) satisfies SessionStatus,
        loadingStartedAt: () => 3,
        loadSessionMessages: vi.fn(async () => [{ info: completed, parts: [] }]),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setMessagesIncremental: vi.fn(),
        stopLoading,
        syncFailedSessionsFromMessages: vi.fn(),
        handoffTodosToMessages: vi.fn(),
      },
      {
        next: () => 1,
        isCurrent: () => true,
      },
      'session-1'
    );

    expect(stopLoading).not.toHaveBeenCalled();
  });
});
