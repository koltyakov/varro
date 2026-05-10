import { describe, expect, it, vi } from 'vitest';
import type { Message, Session } from '../types';
import {
  resolveMessagesSelectedModel,
  SessionSyncOperations,
  selectSessionWithStateDependencies,
  syncSessionMessagesWithStateDependencies,
  syncSessionWithStateDependencies,
} from './session/session-sync';
import { provider } from './useOpenCode.test-support';

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
    variant: 'high',
  };
}

function session(id = 'session-1'): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: 'Session',
    version: '1',
    time: { created: 0, updated: 0 },
  };
}

describe('session sync helpers', () => {
  it('selects a session through the state dependency wrapper', async () => {
    const activeSession = { value: 'session-0' as string | null };
    const startLoading = vi.fn();

    await selectSessionWithStateDependencies(
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
        getConnectedMcpNames: () => ['docs'],
        hasSelectedMcps: () => false,
        setSelectedMcpsForSession: vi.fn(),
        syncSessionMcps: vi.fn(async () => {}),
        resetTodoSync: vi.fn(),
        clearMessages: vi.fn(),
        loadSession: vi.fn(async () => ({
          session: session('session-1'),
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
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      { next: () => 1 },
      'session-1'
    );

    expect(activeSession.value).toBe('session-1');
    expect(startLoading).toHaveBeenCalledTimes(1);
  });

  it('syncs session messages through the state dependency wrapper', async () => {
    const setMessagesIncremental = vi.fn();
    const messages = [{ info: assistantMessage('assistant-1'), parts: [] }];
    const currentGeneration = { value: 0 };

    await syncSessionMessagesWithStateDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getSessionStatus: () => ({ type: 'idle' }),
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => messages),
        updateUsageLimitState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setMessagesIncremental,
        stopLoading: vi.fn(),
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

  it('syncs session metadata through the state dependency wrapper', async () => {
    const upsertSession = vi.fn();

    await syncSessionWithStateDependencies(
      {
        loadSession: vi.fn(async () => session('session-1')),
        upsertSession,
      },
      'session-1'
    );

    expect(upsertSession).toHaveBeenCalledWith(session('session-1'));
  });

  it('resolves selected model from messages against available providers', () => {
    const resolved = resolveMessagesSelectedModel(
      [{ info: assistantMessage('assistant-1'), parts: [] }],
      [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ],
      { openai: 'gpt-4o' },
      () => ({ providerID: 'openai', modelID: 'gpt-4o', variant: 'high' })
    );

    expect(resolved).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });

  it('creates bound session sync operations from one dependency bag', async () => {
    const activeSession = { value: 'session-0' as string | null };
    const operations = new SessionSyncOperations(
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
          session: session('session-1'),
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
        setSessionStatusEntry: vi.fn(),
        startLoading: vi.fn(),
        stopLoading: vi.fn(),
        setError: vi.fn(),
        getSessionStatus: () => ({ type: 'idle' }),
        loadingStartedAt: () => null,
        loadSessionMessages: vi.fn(async () => [
          { info: assistantMessage('assistant-1'), parts: [] },
        ]),
        handoffTodosToMessages: vi.fn(),
        loadSessionMetadata: vi.fn(async () => session('session-1')),
      },
      {
        nextSelection: () => 1,
        nextSync: () => 1,
        isCurrentSync: () => true,
      }
    );

    await operations.selectSession('session-1');
    await operations.syncSessionMessages('session-1');
    await operations.syncSession('session-1');

    expect(activeSession.value).toBe('session-1');
  });
});
