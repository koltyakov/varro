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
        hasPendingAbort: () => false,
        shouldIgnorePendingAbortStatus: () => false,
        markRunningToolPartsAborted: vi.fn(),
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
        syncTodosFromMessages: vi.fn(),
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
        hasPendingAbort: () => false,
        shouldIgnorePendingAbortStatus: () => false,
        markRunningToolPartsAborted: vi.fn(),
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
        syncTodosFromMessages: vi.fn(),
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

  it('keeps pending-aborted sessions idle when reselected with stale busy snapshots', async () => {
    const activeSession = { value: 'session-0' as string | null };
    const markRunningToolPartsAborted = vi.fn();
    const mergeSessionStatuses = vi.fn();
    const updateUsageLimitState = vi.fn();
    const startLoading = vi.fn();
    const stopLoading = vi.fn();
    const messages = [{ info: assistantMessage('assistant-1'), parts: [] }];

    await selectSessionWithDependencies(
      {
        getActiveSessionId: () => activeSession.value,
        setActiveSessionId: (id) => {
          activeSession.value = id;
        },
        hasPendingAbort: () => true,
        shouldIgnorePendingAbortStatus: (_sessionId, status) => status?.type === 'busy',
        markRunningToolPartsAborted,
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
        setMessagesIncremental: vi.fn(),
        syncFailedSessionsFromMessages: vi.fn(),
        requestMessageListScrollToBottom: vi.fn(),
        deriveSelectedAgentFromMessages: () => null,
        deriveSelectedModelFromMessages: () => null,
        syncTodosFromMessages: vi.fn(),
        loadQuestions: vi.fn(async () => {}),
        loadSessionStatuses: vi.fn(async () => ({ 'session-1': { type: 'busy' as const } })),
        mergeSessionStatuses,
        updateUsageLimitState,
        startLoading,
        stopLoading,
        setError: vi.fn(),
      },
      { next: () => 1 },
      'session-1'
    );

    expect(markRunningToolPartsAborted).toHaveBeenCalledWith(['session-1']);
    expect(mergeSessionStatuses).not.toHaveBeenCalled();
    expect(updateUsageLimitState).not.toHaveBeenCalled();
    expect(startLoading).not.toHaveBeenCalled();
    expect(stopLoading).toHaveBeenCalledTimes(1);
  });

  it('syncs active-session messages only for the latest generation', async () => {
    const setMessagesIncremental = vi.fn();
    const messages = [{ info: assistantMessage('assistant-1'), parts: [] }];
    const currentGeneration = { value: 0 };

    await syncSessionMessagesWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getSessionStatus: () => ({ type: 'idle' }) satisfies SessionStatus,
        loadSessionMessages: vi.fn(async () => messages),
        updateUsageLimitState: vi.fn(),
        setMessagesIncremental,
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
  });
});
