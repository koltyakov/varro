import { describe, expect, it, vi } from 'vitest';
import type { Message, SessionStatus } from '../types';
import {
  selectSessionWithDependencies,
  syncSessionMessagesWithDependencies,
} from './session-selection';

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

    await selectSessionWithDependencies(
      {
        getActiveSessionId: () => activeSession.value,
        setActiveSessionId: (id) => {
          activeSession.value = id;
        },
        persistActiveSessionId: vi.fn(),
        markSessionSeen: vi.fn(),
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
    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(stopLoading).not.toHaveBeenCalled();
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

    expect(setMessagesIncremental).toHaveBeenCalledWith(messages);
  });
});
