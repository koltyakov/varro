import { describe, expect, it, vi } from 'vitest';
import type { Message, Session } from '../types';
import {
  abortSessionWithDependencies,
  compactSessionWithDependencies,
  editMessageWithDependencies,
  redoSessionWithDependencies,
  reviewSessionWithDependencies,
  SessionControlOperations,
  undoSessionWithDependencies,
} from './session/session-controls';

function userMessage(id: string): Message {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 0 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
  };
}

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

function session(id = 'session-1', overrides?: Partial<Session>): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: 'Session',
    version: '1',
    time: { created: 0, updated: 0 },
    ...overrides,
  };
}

describe('session-controls helpers', () => {
  it('sends the review prompt for the active session', async () => {
    const sendMessage = vi.fn(async () => {});

    await reviewSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'review the current changes in my code and provide feedback'
    );
  });

  it('marks aborting sessions idle and preserves previous limits on failure', async () => {
    const setSessionStatusEntry = vi.fn();
    const setSessionUsageLimit = vi.fn();
    const logError = vi.fn();

    await abortSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      getSessionTreeRootId: () => null,
      getSessionTreeIds: () => ['session-1', 'child-1'],
      getSelectedAgentForSession: () => 'plan',
      skipPlanSession: vi.fn(),
      getSessionStatus: (sessionId) =>
        sessionId === 'session-1'
          ? { type: 'retry', attempt: 1, message: 'retry', next: 3 }
          : { type: 'busy' },
      getSessionUsageLimit: (sessionId) => ({ sessionID: sessionId, attempt: 1 }),
      markPendingAbortTree: vi.fn(),
      setSessionStatusEntry,
      stopLoading: vi.fn(),
      abortRemoteSession: vi.fn(async () => {
        throw new Error('abort failed');
      }),
      clearPendingAbortTree: vi.fn(),
      setSessionUsageLimit,
      logError,
    });

    expect(setSessionStatusEntry).toHaveBeenNthCalledWith(1, 'session-1', { type: 'idle' });
    expect(setSessionStatusEntry).toHaveBeenNthCalledWith(2, 'child-1', { type: 'idle' });
    expect(setSessionStatusEntry).toHaveBeenNthCalledWith(3, 'session-1', {
      type: 'retry',
      attempt: 1,
      message: 'retry',
      next: 3,
    });
    expect(setSessionStatusEntry).toHaveBeenNthCalledWith(4, 'child-1', { type: 'busy' });
    expect(setSessionUsageLimit).toHaveBeenNthCalledWith(1, 'session-1', {
      sessionID: 'session-1',
      attempt: 1,
    });
    expect(setSessionUsageLimit).toHaveBeenNthCalledWith(2, 'child-1', {
      sessionID: 'child-1',
      attempt: 1,
    });
    expect(logError).toHaveBeenCalledWith('abortSession', expect.any(Error));
  });

  it('undos from the latest assistant message', async () => {
    const revertSession = vi.fn(async () => {});

    await undoSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        { info: userMessage('user-1') },
        { info: assistantMessage('assistant-1') },
      ],
      startLoading: vi.fn(),
      revertSession,
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      stopLoading: vi.fn(),
      setError: vi.fn(),
    });

    expect(revertSession).toHaveBeenCalledWith('session-1', 'assistant-1');
  });

  it('edits a user message by reverting to it and resending the new text', async () => {
    const callOrder: string[] = [];
    const revertSession = vi.fn(async () => {
      callOrder.push('revert');
    });
    const syncSession = vi.fn(async () => {
      callOrder.push('sync-session');
    });
    const syncSessionMessages = vi.fn(async () => {
      callOrder.push('sync-messages');
    });
    const sendEditedMessage = vi.fn(async () => {
      callOrder.push('send');
    });
    const abortSession = vi.fn(async () => {});
    const invalidateMessageSync = vi.fn(() => {
      callOrder.push('invalidate-sync');
    });
    const pruneMessagesFrom = vi.fn(() => {
      callOrder.push('prune');
      return vi.fn();
    });

    await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1') },
          { info: assistantMessage('assistant-1') },
        ],
        isSessionWorking: () => false,
        abortSession,
        startLoading: vi.fn(() => {
          callOrder.push('loading');
        }),
        invalidateMessageSync,
        pruneMessagesFrom,
        revertSession,
        syncSession,
        syncSessionMessages,
        sendEditedMessage,
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(abortSession).not.toHaveBeenCalled();
    expect(invalidateMessageSync).toHaveBeenCalledTimes(1);
    expect(pruneMessagesFrom).toHaveBeenCalledWith('session-1', 'user-1');
    expect(revertSession).toHaveBeenCalledWith('session-1', 'user-1');
    expect(syncSessionMessages).not.toHaveBeenCalled();
    expect(sendEditedMessage).toHaveBeenCalledWith('updated prompt');
    expect(callOrder).toEqual([
      'loading',
      'invalidate-sync',
      'prune',
      'revert',
      'sync-session',
      'send',
    ]);
  });

  it('aborts a working session before reverting the edited message', async () => {
    const callOrder: string[] = [];

    await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [{ info: userMessage('user-1') }],
        isSessionWorking: () => true,
        abortSession: vi.fn(async () => {
          callOrder.push('abort');
        }),
        startLoading: vi.fn(),
        revertSession: vi.fn(async () => {
          callOrder.push('revert');
        }),
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage: vi.fn(async () => {
          callOrder.push('send');
        }),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(callOrder).toEqual(['abort', 'revert', 'send']);
  });

  it('editMessage returns early for blank text, missing messages, and inactive sessions', async () => {
    const revertSession = vi.fn(async () => {});
    const startLoading = vi.fn();
    const makeDeps = (overrides?: {
      getActiveSessionId?: () => string | null;
      getMessages?: () => Array<{ info: Message }>;
    }) => ({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [{ info: userMessage('user-1') }],
      isSessionWorking: () => false,
      abortSession: vi.fn(async () => {}),
      startLoading,
      revertSession,
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      sendEditedMessage: vi.fn(async () => {}),
      stopLoading: vi.fn(),
      setError: vi.fn(),
      ...overrides,
    });

    await editMessageWithDependencies(makeDeps(), 'user-1', '   ');
    await editMessageWithDependencies(
      makeDeps({ getActiveSessionId: () => null }),
      'user-1',
      'updated'
    );
    await editMessageWithDependencies(makeDeps(), 'missing-message', 'updated');
    await editMessageWithDependencies(
      makeDeps({ getMessages: () => [{ info: assistantMessage('assistant-1') }] }),
      'assistant-1',
      'updated'
    );
    await editMessageWithDependencies(
      makeDeps({
        getMessages: () => [{ info: { ...userMessage('user-1'), sessionID: 'session-2' } }],
      }),
      'user-1',
      'updated'
    );

    expect(startLoading).not.toHaveBeenCalled();
    expect(revertSession).not.toHaveBeenCalled();
  });

  it('editMessage can resend attachment-only edits with empty text', async () => {
    const revertSession = vi.fn(async () => {});
    const sendEditedMessage = vi.fn(async () => {});

    await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [{ info: userMessage('user-1') }],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        startLoading: vi.fn(),
        revertSession,
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage,
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      '',
      { allowEmptyText: true }
    );

    expect(revertSession).toHaveBeenCalledWith('session-1', 'user-1');
    expect(sendEditedMessage).toHaveBeenCalledWith('');
  });

  it('editMessage stops loading and reports errors without sending when revert fails', async () => {
    const stopLoading = vi.fn();
    const setError = vi.fn();
    const sendEditedMessage = vi.fn(async () => {});
    const restorePrunedMessages = vi.fn();

    await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [{ info: userMessage('user-1') }],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        startLoading: vi.fn(),
        pruneMessagesFrom: vi.fn(() => restorePrunedMessages),
        revertSession: vi.fn(async () => {
          throw new Error('revert failed');
        }),
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage,
        stopLoading,
        setError,
      },
      'user-1',
      'updated prompt'
    );

    expect(restorePrunedMessages).toHaveBeenCalled();
    expect(stopLoading).toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('revert failed');
    expect(sendEditedMessage).not.toHaveBeenCalled();
  });

  it('editMessage reports a generic message when a non-Error is thrown', async () => {
    const setError = vi.fn();

    await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [{ info: userMessage('user-1') }],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        startLoading: vi.fn(),
        revertSession: vi.fn(async () => {
          throw 'oops';
        }),
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage: vi.fn(async () => {}),
        stopLoading: vi.fn(),
        setError,
      },
      'user-1',
      'updated prompt'
    );

    expect(setError).toHaveBeenCalledWith('Failed to edit message');
  });

  it('redos through unrevert and upserts the session', async () => {
    const upsertSession = vi.fn();

    await redoSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      startLoading: vi.fn(),
      unrevertSession: vi.fn(async () => session('session-1')),
      upsertSession,
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      stopLoading: vi.fn(),
      setError: vi.fn(),
    });

    expect(upsertSession).toHaveBeenCalledWith(session('session-1'));
  });

  it('requires a selected model before compacting', async () => {
    const setError = vi.fn();

    await compactSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      clearPendingAbort: vi.fn(),
      resolveSelectedModel: () => null,
      setError,
      setSessionCompacting: vi.fn(),
      startLoading: vi.fn(),
      compactRemoteSession: vi.fn(async () => {}),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      getSession: () => undefined,
      stopLoading: vi.fn(),
    });

    expect(setError).toHaveBeenCalledWith('Select a model before compacting the session');
  });

  it('compacts the active session with the resolved model', async () => {
    const compactRemoteSession = vi.fn(async () => {});
    const setSessionCompacting = vi.fn();

    await compactSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      clearPendingAbort: vi.fn(),
      resolveSelectedModel: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
      setError: vi.fn(),
      setSessionCompacting,
      startLoading: vi.fn(),
      compactRemoteSession,
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      getSession: () => session('session-1'),
      stopLoading: vi.fn(),
    });

    expect(setSessionCompacting).toHaveBeenNthCalledWith(1, 'session-1', true);
    expect(setSessionCompacting).toHaveBeenNthCalledWith(2, 'session-1', false);
    expect(compactRemoteSession).toHaveBeenCalledWith('session-1', {
      providerID: 'openai',
      modelID: 'gpt-4o',
    });
  });

  it('creates bound session-control operations from one dependency bag', async () => {
    const sendMessage = vi.fn(async () => {});
    const markPendingAbortTree = vi.fn();
    const abortRemoteSession = vi.fn(async () => {});
    const revertSession = vi.fn(async () => {});
    const unrevertSession = vi.fn(async () => session('session-1'));
    const upsertSession = vi.fn();
    const clearPendingAbort = vi.fn();
    const compactRemoteSession = vi.fn(async () => {});
    const sendEditedMessage = vi.fn(async () => {});

    const operations = new SessionControlOperations({
      getActiveSessionId: () => 'session-1',
      sendMessage,
      getSessionTreeRootId: () => null,
      getSessionTreeIds: () => ['session-1'],
      getSelectedAgentForSession: () => 'build',
      skipPlanSession: vi.fn(),
      getSessionStatus: () => ({ type: 'idle' }),
      getSessionUsageLimit: () => null,
      markPendingAbortTree,
      setSessionStatusEntry: vi.fn(),
      stopLoading: vi.fn(),
      abortRemoteSession,
      clearPendingAbortTree: vi.fn(),
      setSessionUsageLimit: vi.fn(),
      logError: vi.fn(),
      getMessages: () => [
        { info: userMessage('user-1') },
        { info: assistantMessage('assistant-1') },
      ],
      startLoading: vi.fn(),
      revertSession,
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      setError: vi.fn(),
      isSessionWorking: () => false,
      sendEditedMessage,
      invalidateMessageSync: vi.fn(),
      pruneMessagesFrom: vi.fn(),
      unrevertSession,
      upsertSession,
      clearPendingAbort,
      resolveSelectedModel: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
      setSessionCompacting: vi.fn(),
      compactRemoteSession,
      getSession: () => session('session-1'),
    });

    await operations.reviewSession();
    await operations.abortSession();
    await operations.undoSession();
    await operations.editMessage('user-1', 'updated prompt');
    await operations.redoSession();
    await operations.compactSession();

    expect(sendMessage).toHaveBeenCalledWith(
      'review the current changes in my code and provide feedback'
    );
    expect(markPendingAbortTree).toHaveBeenCalledWith(['session-1']);
    expect(abortRemoteSession).toHaveBeenCalledWith('session-1');
    expect(revertSession).toHaveBeenCalledWith('session-1', 'assistant-1');
    expect(revertSession).toHaveBeenCalledWith('session-1', 'user-1');
    expect(sendEditedMessage).toHaveBeenCalledWith('updated prompt');
    expect(unrevertSession).toHaveBeenCalledWith('session-1');
    expect(upsertSession).toHaveBeenCalledWith(session('session-1'));
    expect(clearPendingAbort).toHaveBeenCalledWith('session-1');
    expect(compactRemoteSession).toHaveBeenCalledWith('session-1', {
      providerID: 'openai',
      modelID: 'gpt-4o',
    });
  });

  it('reviewSession does not call sendMessage when no active session', async () => {
    const sendMessage = vi.fn(async () => {});

    await reviewSessionWithDependencies({
      getActiveSessionId: () => null,
      sendMessage,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('abortSession returns early when no active session', async () => {
    const markPendingAbortTree = vi.fn();
    const stopLoading = vi.fn();

    await abortSessionWithDependencies({
      getActiveSessionId: () => null,
      getSessionTreeRootId: vi.fn(),
      getSessionTreeIds: vi.fn(),
      getSelectedAgentForSession: vi.fn(),
      skipPlanSession: vi.fn(),
      getSessionStatus: vi.fn(),
      getSessionUsageLimit: vi.fn(),
      markPendingAbortTree,
      setSessionStatusEntry: vi.fn(),
      stopLoading,
      abortRemoteSession: vi.fn(async () => {}),
      clearPendingAbortTree: vi.fn(),
      setSessionUsageLimit: vi.fn(),
      logError: vi.fn(),
    });

    expect(markPendingAbortTree).not.toHaveBeenCalled();
    expect(stopLoading).not.toHaveBeenCalled();
  });

  it('undoSession returns early when no active session', async () => {
    const startLoading = vi.fn();

    await undoSessionWithDependencies({
      getActiveSessionId: () => null,
      getMessages: vi.fn(),
      startLoading,
      revertSession: vi.fn(async () => {}),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      stopLoading: vi.fn(),
      setError: vi.fn(),
    });

    expect(startLoading).not.toHaveBeenCalled();
  });

  it('undoSession returns early when no assistant messages exist', async () => {
    const startLoading = vi.fn();

    await undoSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [{ info: userMessage('user-1') }],
      startLoading,
      revertSession: vi.fn(async () => {}),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      stopLoading: vi.fn(),
      setError: vi.fn(),
    });

    expect(startLoading).not.toHaveBeenCalled();
  });

  it('undoSession calls stopLoading and setError when revert throws an Error', async () => {
    const stopLoading = vi.fn();
    const setError = vi.fn();

    await undoSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        { info: userMessage('user-1') },
        { info: assistantMessage('assistant-1') },
      ],
      startLoading: vi.fn(),
      revertSession: vi.fn(async () => {
        throw new Error('revert failed');
      }),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      stopLoading,
      setError,
    });

    expect(stopLoading).toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('revert failed');
  });

  it('undoSession calls setError with generic message when non-Error is thrown', async () => {
    const setError = vi.fn();

    await undoSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        { info: userMessage('user-1') },
        { info: assistantMessage('assistant-1') },
      ],
      startLoading: vi.fn(),
      revertSession: vi.fn(async () => {
        throw 'something went wrong';
      }),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      stopLoading: vi.fn(),
      setError,
    });

    expect(setError).toHaveBeenCalledWith('Failed to undo');
  });

  it('redoSession returns early when no active session', async () => {
    const startLoading = vi.fn();

    await redoSessionWithDependencies({
      getActiveSessionId: () => null,
      startLoading,
      unrevertSession: vi.fn(async () => session('session-1')),
      upsertSession: vi.fn(),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      stopLoading: vi.fn(),
      setError: vi.fn(),
    });

    expect(startLoading).not.toHaveBeenCalled();
  });

  it('redoSession calls stopLoading and setError when unrevert throws an Error', async () => {
    const stopLoading = vi.fn();
    const setError = vi.fn();

    await redoSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      startLoading: vi.fn(),
      unrevertSession: vi.fn(async () => {
        throw new Error('unrevert failed');
      }),
      upsertSession: vi.fn(),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      stopLoading,
      setError,
    });

    expect(stopLoading).toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('unrevert failed');
  });

  it('redoSession calls setError with generic message when non-Error is thrown', async () => {
    const setError = vi.fn();

    await redoSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      startLoading: vi.fn(),
      unrevertSession: vi.fn(async () => {
        throw 42;
      }),
      upsertSession: vi.fn(),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      stopLoading: vi.fn(),
      setError,
    });

    expect(setError).toHaveBeenCalledWith('Failed to redo');
  });

  it('compactSession returns early when no active session', async () => {
    const startLoading = vi.fn();

    await compactSessionWithDependencies({
      getActiveSessionId: () => null,
      clearPendingAbort: vi.fn(),
      resolveSelectedModel: vi.fn(),
      setError: vi.fn(),
      setSessionCompacting: vi.fn(),
      startLoading,
      compactRemoteSession: vi.fn(async () => {}),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      getSession: () => undefined,
      stopLoading: vi.fn(),
    });

    expect(startLoading).not.toHaveBeenCalled();
  });

  it('compactSession calls stopLoading, setSessionCompacting(false), and setError when compact throws an Error', async () => {
    const stopLoading = vi.fn();
    const setSessionCompacting = vi.fn();
    const setError = vi.fn();

    await compactSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      clearPendingAbort: vi.fn(),
      resolveSelectedModel: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
      setError,
      setSessionCompacting,
      startLoading: vi.fn(),
      compactRemoteSession: vi.fn(async () => {
        throw new Error('compact failed');
      }),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      getSession: () => undefined,
      stopLoading,
    });

    expect(stopLoading).toHaveBeenCalled();
    expect(setSessionCompacting).toHaveBeenCalledWith('session-1', false);
    expect(setError).toHaveBeenCalledWith('compact failed');
  });

  it('compactSession calls setError with generic message when non-Error is thrown', async () => {
    const setError = vi.fn();

    await compactSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      clearPendingAbort: vi.fn(),
      resolveSelectedModel: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
      setError,
      setSessionCompacting: vi.fn(),
      startLoading: vi.fn(),
      compactRemoteSession: vi.fn(async () => {
        throw 'oops';
      }),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      getSession: () => undefined,
      stopLoading: vi.fn(),
    });

    expect(setError).toHaveBeenCalledWith('Failed to compact session');
  });

  it('compactSession does not call setSessionCompacting(false) when session has time.compacting set', async () => {
    const setSessionCompacting = vi.fn();

    await compactSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      clearPendingAbort: vi.fn(),
      resolveSelectedModel: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
      setError: vi.fn(),
      setSessionCompacting,
      startLoading: vi.fn(),
      compactRemoteSession: vi.fn(async () => {}),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      getSession: () =>
        session('session-1', { time: { created: 0, updated: 0, compacting: Date.now() } }),
      stopLoading: vi.fn(),
    });

    // Only called once to set compacting to true; never called with false
    expect(setSessionCompacting).toHaveBeenCalledTimes(1);
    expect(setSessionCompacting).toHaveBeenCalledWith('session-1', true);
  });

  it('aborts the root session tree when a subagent session is active', async () => {
    const abortRemoteSession = vi.fn(async () => true);
    const skipPlanSession = vi.fn();

    await abortSessionWithDependencies({
      getActiveSessionId: () => 'child-1',
      getSessionTreeRootId: (sessionId) => (sessionId === 'child-1' ? 'session-1' : null),
      getSessionTreeIds: (sessionId) =>
        sessionId === 'session-1' ? ['session-1', 'child-1', 'child-2'] : [sessionId],
      getSelectedAgentForSession: () => 'build',
      skipPlanSession,
      getSessionStatus: () => ({ type: 'busy' }),
      getSessionUsageLimit: () => null,
      markPendingAbortTree: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      stopLoading: vi.fn(),
      abortRemoteSession,
      clearPendingAbortTree: vi.fn(),
      setSessionUsageLimit: vi.fn(),
      logError: vi.fn(),
    });

    expect(skipPlanSession).not.toHaveBeenCalled();
    expect(abortRemoteSession).toHaveBeenCalledTimes(3);
    expect(abortRemoteSession).toHaveBeenNthCalledWith(1, 'session-1');
    expect(abortRemoteSession).toHaveBeenNthCalledWith(2, 'child-1');
    expect(abortRemoteSession).toHaveBeenNthCalledWith(3, 'child-2');
  });
});
