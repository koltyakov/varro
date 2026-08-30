import { describe, expect, it, vi } from 'vitest';
import type { Message, Session, SessionStatus } from '../types';
import {
  selectSessionWithDependencies,
  syncSessionMessagesWithDependencies,
} from './session/session-selection';

function assistantMessage(id: string): Extract<Message, { role: 'assistant' }> {
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

type SelectionDependencies = Parameters<typeof selectSessionWithDependencies>[0];

function loadedSession(id: string) {
  return {
    session: {
      id,
      projectID: 'project-1',
      directory: '/repo',
      title: `Session ${id}`,
      version: '1',
      time: { created: 0, updated: 1 },
    } satisfies Session,
    messages: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSelectionDependencies(
  overrides: Partial<SelectionDependencies> = {}
): SelectionDependencies {
  return {
    getActiveSessionId: () => null,
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
    setMessagesLoading: vi.fn(),
    loadSession: async (id) => loadedSession(id),
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
    setError: vi.fn(),
    ...overrides,
  };
}

describe('session-selection helpers', () => {
  it('keeps a persisted selection over session and message models', async () => {
    // SAFETY: The fixture provides the string | null fields read by this statement.
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
      modelID: 'gpt-5.6-codex',
      variant: 'low',
    }));
    const externalSession: Session = {
      id: 'session-1',
      projectID: 'project-1',
      directory: '/repo',
      title: 'Session 1',
      version: '1',
      model: { providerID: 'openai', id: 'gpt-5.6-luna', variant: 'max' },
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
      'session-1'
    );

    expect(activeSession.value).toBe('session-1');
    const clearMessagesCallOrder = clearMessages.mock.invocationCallOrder[0];
    const syncSessionMcpsCallOrder = syncSessionMcps.mock.invocationCallOrder[0];
    if (clearMessagesCallOrder === undefined || syncSessionMcpsCallOrder === undefined) {
      throw new Error('Expected clearMessages and syncSessionMcps to be called');
    }
    expect(clearMessagesCallOrder).toBeLessThan(syncSessionMcpsCallOrder);
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

  it('does not let a fallback model override a session model during overlapping selection', async () => {
    // SAFETY: The fixture provides the string | null fields read by this statement.
    const activeSession = { value: null as string | null };
    const generation = { value: 0 };
    const firstResponse = deferred<ReturnType<typeof loadedSession>>();
    const secondResponse = deferred<ReturnType<typeof loadedSession>>();
    const sessionModels: Record<string, { providerID: string; modelID: string; variant?: string }> =
      {};
    const fallbackModel = {
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'low',
    };
    const restoredModel = {
      providerID: 'openai',
      modelID: 'gpt-5.6-luna',
      variant: 'xhigh',
    };
    const applySelectedModel = vi.fn((model: typeof fallbackModel, sessionId: string | null) => {
      if (sessionId) sessionModels[sessionId] = model;
    });
    const loadSession = vi
      .fn<SelectionDependencies['loadSession']>()
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const deps = createSelectionDependencies({
      getActiveSessionId: () => activeSession.value,
      setActiveSessionId: (id) => {
        activeSession.value = id;
      },
      resolvePersistedModel: (id) => sessionModels[id] ?? null,
      resolveFallbackModel: () => fallbackModel,
      applySelectedModel,
      loadSession,
      isCurrentSelectionGeneration: (value) => value === generation.value,
      deriveSelectedModelFromMessages: () => restoredModel,
    });

    const firstSelection = selectSessionWithDependencies(
      deps,
      { next: () => ++generation.value },
      'session-1'
    );
    const secondSelection = selectSessionWithDependencies(
      deps,
      { next: () => ++generation.value },
      'session-1'
    );

    secondResponse.resolve(loadedSession('session-1'));
    await secondSelection;
    firstResponse.resolve(loadedSession('session-1'));
    await firstSelection;

    expect(applySelectedModel).toHaveBeenNthCalledWith(1, fallbackModel, null);
    expect(applySelectedModel).toHaveBeenNthCalledWith(2, fallbackModel, null);
    expect(applySelectedModel).toHaveBeenNthCalledWith(3, restoredModel, 'session-1');
    expect(sessionModels['session-1']).toEqual(restoredModel);
  });

  it('flags messages as loading until the session messages and todos are applied', async () => {
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
    const todos = deferred<void>();
    const requestMessageListScrollToBottom = vi.fn();

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
        requestMessageListScrollToBottom,
        deriveSelectedAgentFromMessages: () => null,
        deriveSelectedModelFromMessages: () => null,
        syncTodosForSession: vi.fn(() => todos.promise),
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
    await vi.waitFor(() => expect(setMessagesIncremental).toHaveBeenCalledTimes(1));

    expect(setMessagesLoading).not.toHaveBeenCalledWith(false);
    expect(requestMessageListScrollToBottom).not.toHaveBeenCalled();

    todos.resolve();
    await selection;

    expect(setMessagesLoading.mock.lastCall).toEqual([false]);
    const loadingCompleteCallOrder = setMessagesLoading.mock.invocationCallOrder[1];
    const messagesAppliedCallOrder = setMessagesIncremental.mock.invocationCallOrder[0];
    const initialScrollCallOrder = requestMessageListScrollToBottom.mock.invocationCallOrder[0];
    if (
      loadingCompleteCallOrder === undefined ||
      messagesAppliedCallOrder === undefined ||
      initialScrollCallOrder === undefined
    ) {
      throw new Error('Expected messages and todos to be applied before loading completed');
    }
    expect(loadingCompleteCallOrder).toBeGreaterThan(messagesAppliedCallOrder);
    expect(initialScrollCallOrder).toBeGreaterThan(loadingCompleteCallOrder);
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

  it.each(['success', 'failure'] as const)(
    'clears message loading after a current-generation selection is abandoned before load %s',
    async (outcome) => {
      // SAFETY: The fixture provides the string | null fields read by this statement.
      const activeSession = { value: null as string | null };
      const response = deferred<ReturnType<typeof loadedSession>>();
      const setMessagesLoading = vi.fn();
      const setError = vi.fn();
      const selection = selectSessionWithDependencies(
        createSelectionDependencies({
          getActiveSessionId: () => activeSession.value,
          setActiveSessionId: (id) => {
            activeSession.value = id;
          },
          setMessagesLoading,
          loadSession: () => response.promise,
          setError,
        }),
        { next: () => 1 },
        'session-1'
      );

      await vi.waitFor(() => expect(setMessagesLoading).toHaveBeenCalledWith(true));
      activeSession.value = null;
      if (outcome === 'success') {
        response.resolve(loadedSession('session-1'));
      } else {
        response.reject(new Error('offline'));
      }
      await selection;

      expect(setMessagesLoading.mock.calls).toEqual([[true], [false]]);
      expect(setError).not.toHaveBeenCalled();
    }
  );

  it.each(['success', 'failure'] as const)(
    'does not let an older load %s clear a newer selection loading state',
    async (outcome) => {
      // SAFETY: The fixture provides the string | null fields read by this statement.
      const activeSession = { value: null as string | null };
      const generation = { value: 0 };
      const firstResponse = deferred<ReturnType<typeof loadedSession>>();
      const secondResponse = deferred<ReturnType<typeof loadedSession>>();
      const setMessagesLoading = vi.fn();
      const loadSession = vi
        .fn<SelectionDependencies['loadSession']>()
        .mockReturnValueOnce(firstResponse.promise)
        .mockReturnValueOnce(secondResponse.promise);
      const deps = createSelectionDependencies({
        getActiveSessionId: () => activeSession.value,
        setActiveSessionId: (id) => {
          activeSession.value = id;
        },
        setMessagesLoading,
        loadSession,
        isCurrentSelectionGeneration: (value) => value === generation.value,
      });

      const firstSelection = selectSessionWithDependencies(
        deps,
        { next: () => ++generation.value },
        'session-1'
      );
      const secondSelection = selectSessionWithDependencies(
        deps,
        { next: () => ++generation.value },
        'session-2'
      );
      if (outcome === 'success') {
        firstResponse.resolve(loadedSession('session-1'));
      } else {
        firstResponse.reject(new Error('offline'));
      }
      await firstSelection;

      expect(setMessagesLoading.mock.calls).toEqual([[true], [true]]);

      secondResponse.resolve(loadedSession('session-2'));
      await secondSelection;
      expect(setMessagesLoading.mock.lastCall).toEqual([false]);
    }
  );

  it('does not block message loading on MCP reconciliation', async () => {
    let resolveMcpSync!: () => void;
    const mcpSync = new Promise<void>((resolve) => {
      resolveMcpSync = resolve;
    });
    const setMessagesIncremental = vi.fn();
    const syncTodosForSession = vi.fn(async () => {});
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
        syncTodosForSession,
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
    expect(syncTodosForSession).toHaveBeenCalledWith('session-1', [
      { info: assistantMessage('assistant-1'), parts: [] },
    ]);
    resolveMcpSync();
    await selection;
  });

  it('reconciles status before startup synchronization completes', async () => {
    // SAFETY: The fixture provides the string | null fields read by this statement.
    const activeSession = { value: null as string | null };
    const loaded = deferred<ReturnType<typeof loadedSession>>();
    const statuses = deferred<Record<string, SessionStatus>>();
    const mcpSync = deferred<void>();
    const mergeSessionStatuses = vi.fn();
    const loadSessionStatuses = vi.fn(() => statuses.promise);
    const deps = createSelectionDependencies({
      getActiveSessionId: () => activeSession.value,
      setActiveSessionId: (id) => {
        activeSession.value = id;
      },
      loadSession: () => loaded.promise,
      loadSessionStatuses,
      syncSessionMcps: () => mcpSync.promise,
      mergeSessionStatuses,
    });

    const selection = selectSessionWithDependencies(deps, { next: () => 1 }, 'session-1');

    await vi.waitFor(() => expect(loadSessionStatuses).toHaveBeenCalledTimes(1));
    statuses.resolve({ 'session-1': { type: 'idle' } });
    loaded.resolve(loadedSession('session-1'));

    await vi.waitFor(() => {
      expect(mergeSessionStatuses).toHaveBeenCalledWith(
        { 'session-1': { type: 'idle' } },
        { snapshotStartedAt: expect.any(Number) }
      );
    });

    mcpSync.resolve();
    await selection;
  });

  it('does not report loaded messages as failed when follow-up startup sync fails', async () => {
    // SAFETY: The fixture provides the string | null fields read by this statement.
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
        isSessionInActiveTree: () => true,
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => messages),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setSessionMessagesIncremental: setMessagesIncremental,
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

    expect(setMessagesIncremental).toHaveBeenCalledWith('session-1', messages, {
      preserveExtraParts: true,
    });
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
        isSessionInActiveTree: () => true,
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => [{ info: completed, parts: [] }]),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setSessionMessagesIncremental: setMessagesIncremental,
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

    expect(setMessagesIncremental).toHaveBeenCalledWith(
      'session-1',
      [{ info: completed, parts: [] }],
      { preserveExtraParts: false }
    );
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
        isSessionInActiveTree: () => true,
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => [{ info: completed, parts: [] }]),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setSessionMessagesIncremental: setMessagesIncremental,
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

    expect(setMessagesIncremental).toHaveBeenCalledWith(
      'session-1',
      [{ info: completed, parts: [] }],
      { preserveExtraParts: false }
    );
    expect(stopLoading).toHaveBeenCalledTimes(1);
  });

  it('keeps retry sessions loading even when the latest assistant message has an error', async () => {
    // SAFETY: The fixture provides the string | null fields read by this statement.
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
        loadSessionStatuses: vi.fn(async () => ({
          'session-1': {
            type: 'retry' as const,
            attempt: 1,
            message: 'Retrying',
            next: 2,
          },
        })),
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
        isSessionInActiveTree: () => false,
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => [{ info: completed, parts: [] }]),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry,
        setSessionMessagesIncremental: vi.fn(),
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

  it('applies watchdog-style syncs to a child in the active session tree', async () => {
    const setSessionMessagesIncremental = vi.fn();
    const childMessage = assistantMessage('child-assistant');
    childMessage.sessionID = 'child-1';

    await syncSessionMessagesWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getSessionStatus: () => ({ type: 'busy' }) satisfies SessionStatus,
        isSessionInActiveTree: (sessionId) => sessionId === 'child-1',
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => [{ info: childMessage, parts: [] }]),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setSessionMessagesIncremental,
        stopLoading: vi.fn(),
        syncFailedSessionsFromMessages: vi.fn(),
        handoffTodosToMessages: vi.fn(),
      },
      {
        next: () => 1,
        isCurrent: () => true,
      },
      'child-1'
    );

    expect(setSessionMessagesIncremental).toHaveBeenCalledWith(
      'child-1',
      [{ info: childMessage, parts: [] }],
      { preserveExtraParts: true }
    );
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
        isSessionInActiveTree: () => false,
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => messages),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry,
        setSessionMessagesIncremental: vi.fn(),
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
        isSessionInActiveTree: () => true,
        loadingStartedAt: () => 3,
        loadSessionMessages: vi.fn(async () => [{ info: completed, parts: [] }]),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setSessionMessagesIncremental: vi.fn(),
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
