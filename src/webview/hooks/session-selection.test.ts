import { describe, expect, it, vi } from 'vitest';
import type { Message, SessionStatus } from '../types';
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

describe('session-selection helpers', () => {
  it('selects a session, loads its messages, and updates loading state', async () => {
    const activeSession = { value: 'session-0' as string | null };
    const startLoading = vi.fn();
    const stopLoading = vi.fn();
    const clearMessages = vi.fn();
    const persistActiveSessionId = vi.fn();
    const markSessionSeen = vi.fn();
    const syncSessionMcps = vi.fn(async () => {});

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
        resolvePersistedModel: () => null,
        resolveFallbackModel: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        applySelectedModel: vi.fn(),
        getConnectedMcpNames: () => ['docs'],
        hasSelectedMcps: () => false,
        setSelectedMcpsForSession: vi.fn(),
        syncSessionMcps,
        resetTodoSync: vi.fn(),
        clearMessages,
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
        setMessagesIncremental: vi.fn(),
        syncFailedSessionsFromMessages: vi.fn(),
        requestMessageListScrollToBottom: vi.fn(),
        deriveSelectedAgentFromMessages: () => 'build',
        deriveSelectedModelFromMessages: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
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
    expect(clearMessages.mock.invocationCallOrder[0]).toBeLessThan(
      syncSessionMcps.mock.invocationCallOrder[0]
    );
    expect(persistActiveSessionId).toHaveBeenCalledWith('session-1');
    expect(markSessionSeen).toHaveBeenCalledWith('session-1');
    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(stopLoading).not.toHaveBeenCalled();
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

  it('stops loading when synced active messages show a completed assistant reply', async () => {
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

  it('settles inactive running sessions when synced messages show completion', async () => {
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
    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
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
