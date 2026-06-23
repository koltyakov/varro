import { describe, expect, it, vi } from 'vitest';
import type { MockedObject } from 'vitest';
import type * as StateModule from '../lib/state';
import type { Message, SessionStatus } from '../types';

const { setSessionUsageLimitState, setState, startLoading, stopLoading, state } = vi.hoisted(
  () => ({
    setSessionUsageLimitState: vi.fn(),
    setState: vi.fn(),
    startLoading: vi.fn(),
    stopLoading: vi.fn(),
    state: {
      sessionStatus: {} as Record<string, SessionStatus>,
      sessionUsageLimits: {} as Record<string, unknown>,
      messages: [] as Array<unknown>,
    },
  })
);

vi.mock('../lib/state', async () => {
  const actual = (await vi.importActual('../lib/state')) as MockedObject<typeof StateModule>;
  return {
    ...actual,
    setSessionUsageLimit: setSessionUsageLimitState,
    setState,
    startLoading,
    stopLoading,
    state,
  };
});

function completedAssistantMessage(): Message {
  return {
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
  };
}

function userMessage(): Message {
  return {
    id: 'user-1',
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
  };
}

import {
  applyUsageLimitNoticeWithDependencies,
  clearPendingAbortTreeWithDependencies,
  clearPendingAbortWithDependencies,
  clearUsageLimitOnResumedProgressWithDependencies,
  hasPendingAbortWithDependencies,
  markPendingAbortTreeWithDependencies,
  markPendingAbortWithDependencies,
  recheckSessionStatusWithDependencies,
  SessionStatusOperations,
  shouldIgnorePendingAbortStatusWithDependencies,
  updateUsageLimitStateWithDependencies,
} from './session/session-status';

describe('session status helpers', () => {
  it('tracks pending abort retries and clears them', () => {
    const pendingAbortRetryAttempts = new Map<string, number | null>();
    const deps = {
      pendingAbortRetryAttempts,
      getSessionStatus: (sessionId: string): SessionStatus | undefined =>
        sessionId === 'session-1'
          ? { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 3 }
          : { type: 'busy' },
    };

    markPendingAbortWithDependencies(deps, 'session-1');
    markPendingAbortTreeWithDependencies(deps, ['session-2']);

    expect(hasPendingAbortWithDependencies({ pendingAbortRetryAttempts }, 'session-1')).toBe(true);
    expect(hasPendingAbortWithDependencies({ pendingAbortRetryAttempts }, 'session-2')).toBe(true);
    expect(pendingAbortRetryAttempts.get('session-1')).toBe(2);
    expect(pendingAbortRetryAttempts.get('session-2')).toBeNull();

    clearPendingAbortWithDependencies({ pendingAbortRetryAttempts }, 'session-1');
    clearPendingAbortTreeWithDependencies({ pendingAbortRetryAttempts }, ['session-2']);

    expect(pendingAbortRetryAttempts.size).toBe(0);
  });

  it('ignores stale busy and retry statuses after abort', () => {
    const pendingAbortRetryAttempts = new Map<string, number | null>([['session-1', 2]]);

    expect(
      shouldIgnorePendingAbortStatusWithDependencies({ pendingAbortRetryAttempts }, 'session-1', {
        type: 'busy',
      })
    ).toBe(true);
    expect(
      shouldIgnorePendingAbortStatusWithDependencies({ pendingAbortRetryAttempts }, 'session-1', {
        type: 'retry',
        attempt: 3,
        message: 'retry',
        next: 8,
      })
    ).toBe(true);
    expect(
      shouldIgnorePendingAbortStatusWithDependencies({ pendingAbortRetryAttempts }, 'session-1', {
        type: 'retry',
        attempt: 1,
        message: 'retry',
        next: 5,
      })
    ).toBe(false);
    expect(
      shouldIgnorePendingAbortStatusWithDependencies({ pendingAbortRetryAttempts }, 'session-1', {
        type: 'idle',
      })
    ).toBe(false);
  });

  it('clears resumed usage-limit notices unless the message-origin limit should persist', () => {
    const setSessionUsageLimit = vi.fn();

    clearUsageLimitOnResumedProgressWithDependencies(
      {
        getSessionUsageLimit: () => ({
          source: 'status',
          statusCode: 429,
          message: '429 usage limit reached',
          unit: 'messages',
          retryAt: 1,
          attempt: 2,
        }),
        setSessionUsageLimit,
      },
      'session-1',
      { type: 'busy' }
    );

    expect(setSessionUsageLimit).toHaveBeenCalledWith('session-1', null);

    setSessionUsageLimit.mockClear();

    clearUsageLimitOnResumedProgressWithDependencies(
      {
        getSessionUsageLimit: () => ({
          source: 'message',
          statusCode: 429,
          message: '429 usage limit reached',
          unit: 'messages',
          retryAt: 1,
          attempt: 2,
        }),
        setSessionUsageLimit,
      },
      'session-1',
      { type: 'busy' }
    );

    expect(setSessionUsageLimit).not.toHaveBeenCalled();
  });

  it('records usage-limit notices and refreshes provider limits when context is present', () => {
    const setSessionUsageLimit = vi.fn();
    const refreshProviderLimit = vi.fn(async () => {});

    applyUsageLimitNoticeWithDependencies(
      {
        setSessionUsageLimit,
        refreshProviderLimit,
      },
      'session-1',
      {
        source: 'status',
        statusCode: 429,
        message: '429 usage limit reached',
        unit: 'messages',
        retryAt: 1,
        attempt: 2,
        providerID: 'openai',
        modelID: 'gpt-4o',
      }
    );

    expect(setSessionUsageLimit).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        sessionID: 'session-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      })
    );
    expect(refreshProviderLimit).toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('derives usage-limit context from the selected provider when status notices omit it', () => {
    const applyUsageLimitNotice = vi.fn();

    updateUsageLimitStateWithDependencies(
      {
        deriveUsageLimitNoticeContext: () => ({ providerID: 'anthropic', modelID: 'claude' }),
        applyUsageLimitNotice,
      },
      'session-1',
      {
        type: 'retry',
        attempt: 2,
        message: '429 usage limit reached',
        next: 8,
      },
      []
    );

    expect(applyUsageLimitNotice).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        providerID: 'anthropic',
        modelID: 'claude',
        statusCode: 429,
        attempt: 2,
      }),
      { preserveExistingOnNull: false }
    );
  });

  it('rechecks status by resyncing idle sessions and starting loading for busy ones', async () => {
    const updateUsageLimitState = vi.fn();
    const clearPendingAbort = vi.fn();
    const stopLoadingSpy = vi.fn();
    const setSessionStatuses = vi.fn();
    const syncSession = vi.fn(async () => {});
    const syncSessionMessages = vi.fn(async () => {});
    const startLoadingSpy = vi.fn();
    const logError = vi.fn();

    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: () => true,
        loadSessionStatuses: async () => ({ 'session-1': { type: 'idle' } }),
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        updateUsageLimitState,
        clearPendingAbort,
        stopLoading: stopLoadingSpy,
        setSessionStatuses,
        shouldResyncSessionAfterIdle: () => true,
        syncSession,
        syncSessionMessages,
        startLoading: startLoadingSpy,
        isActiveSession: () => true,
        logError,
      },
      'session-1'
    );

    expect(updateUsageLimitState).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(setSessionStatuses).toHaveBeenCalledWith(
      { 'session-1': { type: 'idle' } },
      { snapshotStartedAt: expect.any(Number) }
    );
    expect(clearPendingAbort).toHaveBeenCalledWith('session-1');
    expect(stopLoadingSpy).toHaveBeenCalledTimes(1);
    expect(syncSession).toHaveBeenCalledWith('session-1');
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
    expect(startLoadingSpy).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();

    updateUsageLimitState.mockClear();
    clearPendingAbort.mockClear();
    stopLoadingSpy.mockClear();
    setSessionStatuses.mockClear();
    syncSession.mockClear();
    syncSessionMessages.mockClear();
    startLoadingSpy.mockClear();

    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: () => true,
        loadSessionStatuses: async () => ({
          'session-1': { type: 'retry', attempt: 1, message: 'retry', next: 3 },
        }),
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        updateUsageLimitState,
        clearPendingAbort,
        stopLoading: stopLoadingSpy,
        setSessionStatuses,
        shouldResyncSessionAfterIdle: () => true,
        syncSession,
        syncSessionMessages,
        startLoading: startLoadingSpy,
        isActiveSession: () => true,
        logError,
      },
      'session-1'
    );

    expect(updateUsageLimitState).toHaveBeenCalledWith('session-1', {
      type: 'retry',
      attempt: 1,
      message: 'retry',
      next: 3,
    });
    expect(startLoadingSpy).toHaveBeenCalledTimes(1);
    expect(stopLoadingSpy).not.toHaveBeenCalled();
  });

  it('logs errors and skips work when the document is hidden', async () => {
    const logError = vi.fn();
    const loadSessionStatuses = vi.fn(async () => {
      throw new Error('offline');
    });

    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: () => false,
        loadSessionStatuses,
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        updateUsageLimitState: vi.fn(),
        clearPendingAbort: vi.fn(),
        stopLoading: vi.fn(),
        setSessionStatuses: vi.fn(),
        shouldResyncSessionAfterIdle: () => false,
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        startLoading: vi.fn(),
        isActiveSession: () => true,
        logError,
      },
      'session-1'
    );

    expect(loadSessionStatuses).not.toHaveBeenCalled();

    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: () => true,
        loadSessionStatuses,
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        updateUsageLimitState: vi.fn(),
        clearPendingAbort: vi.fn(),
        stopLoading: vi.fn(),
        setSessionStatuses: vi.fn(),
        shouldResyncSessionAfterIdle: () => false,
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        startLoading: vi.fn(),
        isActiveSession: () => true,
        logError,
      },
      'session-1'
    );

    expect(logError).toHaveBeenCalledWith('recheckSessionStatus', expect.any(Error));
  });

  it('creates bound session-status operations from shared state dependencies', async () => {
    const pendingAbortRetryAttempts = new Map<string, number | null>();
    const refreshProviderLimit = vi.fn(async () => {});
    const syncSession = vi.fn(async () => {});
    const syncSessionMessages = vi.fn(async () => {});

    state.sessionStatus = {
      'session-1': { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 8 },
    };
    state.sessionUsageLimits = {
      'session-1': {
        source: 'status',
        statusCode: 429,
        message: '429 usage limit reached',
        unit: 'messages',
        retryAt: 1,
        attempt: 2,
      },
    };
    state.messages = [];

    const operations = new SessionStatusOperations({
      pendingAbortRetryAttempts,
      deriveUsageLimitNoticeContext: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
      refreshProviderLimit,
      isDocumentVisible: () => true,
      shouldResyncSessionAfterIdle: () => true,
      syncSession,
      syncSessionMessages,
      loadSessionStatuses: async () => ({ 'session-1': { type: 'idle' } }),
      isActiveSession: () => true,
      logError: vi.fn(),
    });

    operations.setSessionStatusEntry('session-1', { type: 'busy' });
    expect(setState).toHaveBeenCalledWith('sessionStatus', expect.any(Function));

    operations.markPendingAbortTree(['session-1']);
    expect(pendingAbortRetryAttempts.get('session-1')).toBe(2);

    operations.clearUsageLimitOnResumedProgress('session-1', { type: 'busy' });
    expect(setSessionUsageLimitState).toHaveBeenCalledWith('session-1', null);

    setSessionUsageLimitState.mockClear();
    stopLoading.mockClear();
    state.sessionStatus = { 'session-1': { type: 'idle' } };

    await operations.recheckSessionStatus('session-1');

    expect(stopLoading).toHaveBeenCalledTimes(1);
    expect(syncSession).toHaveBeenCalledWith('session-1');
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });

  it('does not toggle loading for stale inactive-session rechecks', async () => {
    const stopLoadingSpy = vi.fn();
    const startLoadingSpy = vi.fn();
    const syncSession = vi.fn(async () => {});
    const syncSessionMessages = vi.fn(async () => {});

    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: () => true,
        loadSessionStatuses: async () => ({ 'session-1': { type: 'idle' } }),
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        updateUsageLimitState: vi.fn(),
        clearPendingAbort: vi.fn(),
        stopLoading: stopLoadingSpy,
        setSessionStatuses: vi.fn(),
        shouldResyncSessionAfterIdle: () => false,
        syncSession,
        syncSessionMessages,
        startLoading: startLoadingSpy,
        isActiveSession: () => false,
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(stopLoadingSpy).not.toHaveBeenCalled();
    expect(startLoadingSpy).not.toHaveBeenCalled();
    expect(syncSession).toHaveBeenCalledWith('session-1');
    expect(syncSessionMessages).not.toHaveBeenCalled();
  });

  it('keeps active loading when an idle recheck still has an unsettled latest turn', async () => {
    const stopLoadingSpy = vi.fn();
    const startLoadingSpy = vi.fn();
    const messages = [{ info: userMessage(), parts: [] }];

    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: () => true,
        loadSessionStatuses: async () => ({ 'session-1': { type: 'idle' } }),
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        updateUsageLimitState: vi.fn(),
        clearPendingAbort: vi.fn(),
        stopLoading: stopLoadingSpy,
        setSessionStatuses: vi.fn(),
        shouldResyncSessionAfterIdle: () => true,
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        startLoading: startLoadingSpy,
        isActiveSession: () => true,
        getMessages: () => messages,
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(startLoadingSpy).toHaveBeenCalledTimes(1);
    expect(stopLoadingSpy).not.toHaveBeenCalled();
  });

  it('keeps active loading when an idle recheck only sees the previous completed reply', async () => {
    const stopLoadingSpy = vi.fn();
    const startLoadingSpy = vi.fn();
    const messages = [{ info: completedAssistantMessage(), parts: [] }];

    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: () => true,
        loadSessionStatuses: async () => ({ 'session-1': { type: 'idle' } }),
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        updateUsageLimitState: vi.fn(),
        clearPendingAbort: vi.fn(),
        stopLoading: stopLoadingSpy,
        setSessionStatuses: vi.fn(),
        shouldResyncSessionAfterIdle: () => true,
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        startLoading: startLoadingSpy,
        loadingStartedAt: () => 3,
        isActiveSession: () => true,
        getMessages: () => messages,
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(startLoadingSpy).toHaveBeenCalledTimes(1);
    expect(stopLoadingSpy).not.toHaveBeenCalled();
  });

  it('stops active loading when an idle recheck syncs a completed latest reply', async () => {
    const stopLoadingSpy = vi.fn();
    const startLoadingSpy = vi.fn();
    const setSessionStatusEntry = vi.fn();
    let messages = [{ info: userMessage(), parts: [] }];

    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: () => true,
        loadSessionStatuses: async () => ({ 'session-1': { type: 'idle' } }),
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        updateUsageLimitState: vi.fn(),
        clearPendingAbort: vi.fn(),
        stopLoading: stopLoadingSpy,
        setSessionStatusEntry,
        setSessionStatuses: vi.fn(),
        shouldResyncSessionAfterIdle: () => true,
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {
          messages = [{ info: completedAssistantMessage(), parts: [] }];
        }),
        startLoading: startLoadingSpy,
        loadingStartedAt: () => 3,
        isActiveSession: () => true,
        getCurrentSessionStatus: () => ({ type: 'busy' }),
        getMessages: () => messages,
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(stopLoadingSpy).toHaveBeenCalledTimes(1);
    expect(startLoadingSpy).not.toHaveBeenCalled();
  });

  it('replaces stale running statuses with the latest status snapshot during recheck', async () => {
    const setSessionStatuses = vi.fn();

    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: () => true,
        loadSessionStatuses: async () => ({ 'session-2': { type: 'idle' } }),
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        updateUsageLimitState: vi.fn(),
        clearPendingAbort: vi.fn(),
        stopLoading: vi.fn(),
        setSessionStatuses,
        shouldResyncSessionAfterIdle: () => false,
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        startLoading: vi.fn(),
        isActiveSession: (sessionId) => sessionId === 'session-2',
        logError: vi.fn(),
      },
      'session-2'
    );

    expect(setSessionStatuses).toHaveBeenCalledWith(
      { 'session-2': { type: 'idle' } },
      { snapshotStartedAt: expect.any(Number) }
    );
  });

  it('does not restart loading from stale busy status when messages are complete', async () => {
    const stopLoadingSpy = vi.fn();
    const startLoadingSpy = vi.fn();

    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: () => true,
        loadSessionStatuses: async () => ({ 'session-1': { type: 'busy' } }),
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        updateUsageLimitState: vi.fn(),
        clearPendingAbort: vi.fn(),
        stopLoading: stopLoadingSpy,
        setSessionStatuses: vi.fn(),
        shouldResyncSessionAfterIdle: () => false,
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        startLoading: startLoadingSpy,
        isActiveSession: () => true,
        getMessages: () => [{ info: completedAssistantMessage(), parts: [] }],
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(stopLoadingSpy).toHaveBeenCalledTimes(1);
    expect(startLoadingSpy).not.toHaveBeenCalled();
  });

  it('keeps loading from a busy recheck when completion predates the current loading turn', async () => {
    const stopLoadingSpy = vi.fn();
    const startLoadingSpy = vi.fn();

    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: () => true,
        loadSessionStatuses: async () => ({ 'session-1': { type: 'busy' } }),
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        updateUsageLimitState: vi.fn(),
        clearPendingAbort: vi.fn(),
        stopLoading: stopLoadingSpy,
        setSessionStatuses: vi.fn(),
        shouldResyncSessionAfterIdle: () => false,
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        startLoading: startLoadingSpy,
        loadingStartedAt: () => 3,
        isActiveSession: () => true,
        getMessages: () => [{ info: completedAssistantMessage(), parts: [] }],
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(startLoadingSpy).toHaveBeenCalledTimes(1);
    expect(stopLoadingSpy).not.toHaveBeenCalled();
  });
});
