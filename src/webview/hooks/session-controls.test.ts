import { describe, expect, it, vi } from 'vitest';
import type { Message, Session } from '../types';
import {
  abortSessionWithDependencies,
  compactSessionWithDependencies,
  editMessageWithDependencies,
  redoSessionWithDependencies,
  reviewSessionWithDependencies,
  undoSessionWithDependencies,
} from './session/session-controls';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

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

function assistantMessage(id: string, sessionID = 'session-1'): Message {
  return {
    id,
    sessionID,
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

function completedTaskPart(id: string, sessionId = id) {
  return {
    id: `task-part-${id}`,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'tool' as const,
    callID: `task-call-${id}`,
    tool: 'task',
    state: {
      status: 'completed' as const,
      input: { description: `Task ${id}` },
      output: 'Done',
      title: `Task ${id}`,
      metadata: { sessionId },
      time: { start: 1, end: 2 },
    },
  };
}

describe('session-controls helpers', () => {
  it('sends the review prompt so the send path can create a session', async () => {
    const sendMessage = vi.fn(async () => {});

    await reviewSessionWithDependencies({
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'review the current changes in my code and provide feedback'
    );
  });

  it('marks aborting sessions idle and preserves previous limits on failure', async () => {
    const setSessionStatusEntry = vi.fn();
    const setSessionUsageLimit = vi.fn();
    const setError = vi.fn();
    const logError = vi.fn();

    await expect(
      abortSessionWithDependencies({
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
        setError,
        logError,
      })
    ).rejects.toThrow('abort failed');

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
    expect(setError).toHaveBeenCalledWith('Failed to stop the run: abort failed');
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

  it('undos from the latest assistant in the active session instead of a child session', async () => {
    const revertSession = vi.fn(async () => {});

    await undoSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        { info: userMessage('user-1') },
        { info: assistantMessage('assistant-active') },
        { info: assistantMessage('assistant-child', 'child-1') },
      ],
      startLoading: vi.fn(),
      revertSession,
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      stopLoading: vi.fn(),
      setError: vi.fn(),
    });

    expect(revertSession).toHaveBeenCalledWith('session-1', 'assistant-active');
  });

  it('edits a user message by deleting its history tail and resending the new text', async () => {
    const callOrder: string[] = [];
    const deleteMessage = vi.fn(async (_sessionId: string, messageId: string) => {
      callOrder.push(`delete:${messageId}`);
    });
    const syncSessionMessages = vi.fn(async () => {
      callOrder.push('sync-messages');
    });
    const sendEditedMessage = vi.fn(async () => {
      callOrder.push('send');
      return true;
    });
    const abortSession = vi.fn(async () => {});
    const invalidateMessageSync = vi.fn(() => {
      callOrder.push('invalidate-sync');
    });
    const pruneMessagesFrom = vi.fn(() => {
      callOrder.push('prune');
      return vi.fn();
    });
    const deferMessageRemovals = vi.fn((_sessionId: string, _messageIds: string[]) => {
      callOrder.push('defer-removals');
      return () => callOrder.push('release-removals');
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
        deferMessageRemovals,
        pruneMessagesFrom,
        deleteMessage,
        syncSessionMessages,
        sendEditedMessage,
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt',
      { onOptimisticPublish: () => callOrder.push('publish') }
    );

    expect(abortSession).not.toHaveBeenCalled();
    expect(invalidateMessageSync).toHaveBeenCalledTimes(1);
    expect(deferMessageRemovals).toHaveBeenCalledWith('session-1', ['assistant-1', 'user-1']);
    expect(pruneMessagesFrom).toHaveBeenCalledWith('session-1', 'user-1');
    expect(deleteMessage.mock.calls).toEqual([
      ['session-1', 'assistant-1'],
      ['session-1', 'user-1'],
    ]);
    expect(syncSessionMessages).not.toHaveBeenCalled();
    expect(sendEditedMessage).toHaveBeenCalledWith('updated prompt', 'session-1', undefined);
    expect(callOrder).toEqual([
      'loading',
      'invalidate-sync',
      'defer-removals',
      'delete:assistant-1',
      'delete:user-1',
      'publish',
      'prune',
      'release-removals',
      'send',
    ]);
  });

  it('deletes only parent message ids when child rows are interleaved in the edited tail', async () => {
    const deleteMessage = vi.fn(async () => {});
    const child = { info: assistantMessage('child-assistant', 'child-1') };

    await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1') },
          child,
          { info: assistantMessage('assistant-1') },
        ],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        startLoading: vi.fn(),
        deferMessageRemovals: vi.fn(() => vi.fn()),
        pruneMessagesFrom: vi.fn(),
        deleteMessage,
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage: vi.fn(async () => true),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(deleteMessage.mock.calls).toEqual([
      ['session-1', 'assistant-1'],
      ['session-1', 'user-1'],
    ]);
  });

  it('aborts and recycles task child trees before deleting their launch history', async () => {
    const order: string[] = [];
    const taskPart = {
      id: 'task-part',
      sessionID: 'session-1',
      messageID: 'assistant-1',
      type: 'tool' as const,
      callID: 'task-call',
      tool: 'task',
      state: {
        status: 'completed' as const,
        input: { description: 'Inspect the repo' },
        output: 'Done',
        title: 'Inspect the repo',
        metadata: { sessionId: 'child-1' },
        time: { start: 1, end: 2 },
      },
    };

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1'), parts: [] },
          { info: assistantMessage('assistant-1'), parts: [taskPart] },
        ],
        getSessions: () => [
          session('session-1'),
          session('child-1', { parentID: 'session-1', time: { created: 1, updated: 1 } }),
          session('grandchild-1', {
            parentID: 'child-1',
            time: { created: 2, updated: 2 },
          }),
        ],
        getSessionTreeIds: (id) => (id === 'child-1' ? ['child-1', 'grandchild-1'] : [id]),
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async (id) => {
          order.push(`abort:${id}`);
        }),
        moveSessionTreeToRecycleBin: vi.fn(async (id) => {
          order.push(`recycle:${id}`);
        }),
        restoreSessionTreeFromRecycleBin: vi.fn(async () => {}),
        startLoading: vi.fn(),
        deleteMessage: vi.fn(async (_sessionId, id) => {
          order.push(`delete:${id}`);
        }),
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage: vi.fn(async () => {
          order.push('send');
          return true;
        }),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(true);
    expect(order).toEqual([
      'abort:child-1',
      'recycle:child-1',
      'delete:assistant-1',
      'delete:user-1',
      'send',
    ]);
  });

  it('keeps launch history and reports a failed child recycle operation', async () => {
    const deleteMessage = vi.fn(async () => {});
    const setError = vi.fn();
    const restore = vi.fn(async () => false);
    const sync = vi.fn(async () => {});
    const taskPart = {
      id: 'task-part',
      sessionID: 'session-1',
      messageID: 'assistant-1',
      type: 'tool' as const,
      callID: 'task-call',
      tool: 'task',
      state: {
        status: 'running' as const,
        input: { description: 'Inspect the repo' },
        title: 'Inspect the repo',
        metadata: { sessionId: 'child-1' },
        time: { start: 1 },
      },
    };

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1'), parts: [] },
          { info: assistantMessage('assistant-1'), parts: [taskPart] },
        ],
        getSessions: () => [session('session-1'), session('child-1', { parentID: 'session-1' })],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async () => {}),
        moveSessionTreeToRecycleBin: vi.fn(async () => {
          throw new Error('recycle failed');
        }),
        restoreSessionTreeFromRecycleBin: restore,
        startLoading: vi.fn(),
        deleteMessage,
        syncSessionMessages: sync,
        sendEditedMessage: vi.fn(async () => true),
        stopLoading: vi.fn(),
        setError,
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(false);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith('child-1');
    expect(sync.mock.calls).toEqual([['session-1']]);
    expect(setError).toHaveBeenCalledWith('recycle failed');
  });

  it('restores a child tree after the recycle request loses its response', async () => {
    const restore = vi.fn(async () => true);
    const sync = vi.fn(async () => {});
    const setError = vi.fn();

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1'), parts: [] },
          {
            info: assistantMessage('assistant-1'),
            parts: [completedTaskPart('child-1')],
          },
        ],
        getSessions: () => [session('session-1'), session('child-1', { parentID: 'session-1' })],
        getSessionTreeIds: (id) => [id],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async () => {}),
        moveSessionTreeToRecycleBin: vi.fn(async () => {
          throw new Error('recycle response lost');
        }),
        restoreSessionTreeFromRecycleBin: restore,
        startLoading: vi.fn(),
        deleteMessage: vi.fn(async () => {}),
        syncSessionMessages: sync,
        sendEditedMessage: vi.fn(async () => true),
        stopLoading: vi.fn(),
        setError,
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(false);
    expect(restore).toHaveBeenCalledWith('child-1');
    expect(sync.mock.calls).toEqual([['session-1'], ['child-1']]);
    expect(setError).toHaveBeenCalledWith('recycle response lost');
  });

  it('ignores unknown and unrelated task session ids from metadata', async () => {
    const recycle = vi.fn(async () => {});

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1'), parts: [] },
          {
            info: assistantMessage('assistant-1'),
            parts: [
              completedTaskPart('unknown', 'missing-child'),
              completedTaskPart('sibling', 'sibling-child'),
            ],
          },
        ],
        getSessions: () => [
          session('session-1'),
          session('other-parent'),
          session('sibling-child', { parentID: 'other-parent' }),
        ],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async () => {}),
        moveSessionTreeToRecycleBin: recycle,
        restoreSessionTreeFromRecycleBin: vi.fn(async () => {}),
        startLoading: vi.fn(),
        deleteMessage: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage: vi.fn(async () => true),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(true);
    expect(recycle).not.toHaveBeenCalled();
  });

  it('restores confirmed and ambiguous child recycle attempts when a later recycle fails', async () => {
    const restore = vi.fn(async () => {});
    const sync = vi.fn(async () => {});

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1'), parts: [] },
          {
            info: assistantMessage('assistant-1'),
            parts: [completedTaskPart('child-1'), completedTaskPart('child-2')],
          },
        ],
        getSessions: () => [
          session('session-1'),
          session('child-1', { parentID: 'session-1' }),
          session('child-2', { parentID: 'session-1' }),
        ],
        getSessionTreeIds: (id) => [id],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async () => {}),
        moveSessionTreeToRecycleBin: vi.fn(async (id) => {
          if (id === 'child-2') throw new Error('second recycle failed');
        }),
        restoreSessionTreeFromRecycleBin: restore,
        startLoading: vi.fn(),
        deleteMessage: vi.fn(async () => {}),
        syncSessionMessages: sync,
        sendEditedMessage: vi.fn(async () => true),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(false);
    expect(restore.mock.calls).toEqual([['child-2'], ['child-1']]);
    expect(sync).toHaveBeenCalledWith('session-1');
    expect(sync).toHaveBeenCalledWith('child-1');
    expect(sync).toHaveBeenCalledWith('child-2');
  });

  it('reports a false restore response for a confirmed recycle as a rollback failure', async () => {
    const setError = vi.fn();
    const stopLoading = vi.fn();
    const sync = vi.fn(async () => {});

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1'), parts: [] },
          {
            info: assistantMessage('assistant-1'),
            parts: [completedTaskPart('child-1')],
          },
        ],
        getSessions: () => [session('session-1'), session('child-1', { parentID: 'session-1' })],
        getSessionTreeIds: (id) => [id],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async () => {}),
        moveSessionTreeToRecycleBin: vi.fn(async () => {}),
        restoreSessionTreeFromRecycleBin: vi.fn(async () => false),
        startLoading: vi.fn(),
        deleteMessage: vi.fn(async () => {
          throw new Error('delete failed');
        }),
        syncSessionMessages: sync,
        sendEditedMessage: vi.fn(async () => true),
        stopLoading,
        setError,
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(false);
    expect(stopLoading).toHaveBeenCalledOnce();
    expect(sync.mock.calls).toEqual([['session-1']]);
    expect(setError).toHaveBeenCalledWith(
      'delete failed. Rollback also failed: Rollback failed for recycled child sessions (restore child-1: restore returned false). Check the recycle bin and reload the affected sessions.'
    );
  });

  it('surfaces a thrown child restore failure with the original edit failure', async () => {
    const setError = vi.fn();
    const stopLoading = vi.fn();

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1'), parts: [] },
          {
            info: assistantMessage('assistant-1'),
            parts: [completedTaskPart('child-1')],
          },
        ],
        getSessions: () => [session('session-1'), session('child-1', { parentID: 'session-1' })],
        getSessionTreeIds: (id) => [id],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async () => {}),
        moveSessionTreeToRecycleBin: vi.fn(async () => {}),
        restoreSessionTreeFromRecycleBin: vi.fn(async () => {
          throw new Error('restore request failed');
        }),
        startLoading: vi.fn(),
        deleteMessage: vi.fn(async () => {
          throw new Error('delete failed');
        }),
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage: vi.fn(async () => true),
        stopLoading,
        setError,
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(false);
    expect(stopLoading).toHaveBeenCalledOnce();
    expect(setError).toHaveBeenCalledWith(
      'delete failed. Rollback also failed: Rollback failed for recycled child sessions (restore child-1: restore request failed). Check the recycle bin and reload the affected sessions.'
    );
  });

  it('attempts every child rollback and syncs the restored trees when one restore fails', async () => {
    const restore = vi.fn(async (id: string) => {
      if (id === 'child-2') throw new Error('restore unavailable');
    });
    const sync = vi.fn(async () => {});
    const setError = vi.fn();

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1'), parts: [] },
          {
            info: assistantMessage('assistant-1'),
            parts: [completedTaskPart('child-1'), completedTaskPart('child-2')],
          },
        ],
        getSessions: () => [
          session('session-1'),
          session('child-1', { parentID: 'session-1' }),
          session('grandchild-1', { parentID: 'child-1' }),
          session('child-2', { parentID: 'session-1' }),
        ],
        getSessionTreeIds: (id) => (id === 'child-1' ? ['child-1', 'grandchild-1'] : [id]),
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async () => {}),
        moveSessionTreeToRecycleBin: vi.fn(async () => {}),
        restoreSessionTreeFromRecycleBin: restore,
        startLoading: vi.fn(),
        deleteMessage: vi.fn(async () => {
          throw new Error('delete failed');
        }),
        syncSessionMessages: sync,
        sendEditedMessage: vi.fn(async () => true),
        stopLoading: vi.fn(),
        setError,
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(false);
    expect(restore.mock.calls).toEqual([['child-2'], ['child-1']]);
    expect(sync.mock.calls).toEqual([['session-1'], ['child-1'], ['grandchild-1']]);
    expect(setError).toHaveBeenCalledWith(
      'delete failed. Rollback also failed: Rollback failed for recycled child sessions (restore child-2: restore unavailable). Check the recycle bin and reload the affected sessions.'
    );
  });

  it('keeps recycled child trees trashed when the replacement send fails', async () => {
    const restore = vi.fn(async () => {});
    const sync = vi.fn(async () => {});

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1'), parts: [] },
          {
            info: assistantMessage('assistant-1'),
            parts: [completedTaskPart('child-1')],
          },
        ],
        getSessions: () => [session('session-1'), session('child-1', { parentID: 'session-1' })],
        getSessionTreeIds: (id) => [id],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async () => {}),
        moveSessionTreeToRecycleBin: vi.fn(async () => {}),
        restoreSessionTreeFromRecycleBin: restore,
        startLoading: vi.fn(),
        deleteMessage: vi.fn(async () => {}),
        syncSessionMessages: sync,
        sendEditedMessage: vi.fn(async () => false),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(false);
    expect(restore).not.toHaveBeenCalled();
    expect(sync.mock.calls).toEqual([['session-1']]);
  });

  it('restores a child tree and syncs every descendant when the first parent delete fails', async () => {
    const restore = vi.fn(async () => {});
    const sync = vi.fn(async () => {});

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [
          { info: userMessage('user-1'), parts: [] },
          {
            info: assistantMessage('assistant-1'),
            parts: [completedTaskPart('child-1')],
          },
        ],
        getSessions: () => [
          session('session-1'),
          session('child-1', { parentID: 'session-1' }),
          session('grandchild-1', { parentID: 'child-1' }),
        ],
        getSessionTreeIds: (id) => (id === 'child-1' ? ['child-1', 'grandchild-1'] : [id]),
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async () => {}),
        moveSessionTreeToRecycleBin: vi.fn(async () => {}),
        restoreSessionTreeFromRecycleBin: restore,
        startLoading: vi.fn(),
        deleteMessage: vi.fn(async () => {
          throw new Error('delete failed');
        }),
        syncSessionMessages: sync,
        sendEditedMessage: vi.fn(async () => true),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(false);
    expect(restore).toHaveBeenCalledWith('child-1');
    expect(sync.mock.calls).toEqual([['session-1'], ['child-1'], ['grandchild-1']]);
  });

  it('leaves child trees trashed and resyncs the parent after a partial parent deletion', async () => {
    const restore = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    let messages = [
      { info: userMessage('user-1'), parts: [] },
      {
        info: assistantMessage('assistant-1'),
        parts: [completedTaskPart('child-1')],
      },
    ];
    const deleteMessage = vi.fn(async (_sessionId: string, messageId: string) => {
      if (messageId === 'user-1') throw new Error('delete failed');
      messages = messages.filter((message) => message.info.id !== messageId);
    });

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => messages,
        getSessions: () => [session('session-1'), session('child-1', { parentID: 'session-1' })],
        getSessionTreeIds: (id) => [id],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async () => {}),
        moveSessionTreeToRecycleBin: vi.fn(async () => {}),
        restoreSessionTreeFromRecycleBin: restore,
        startLoading: vi.fn(),
        deleteMessage,
        syncSessionMessages: sync,
        sendEditedMessage: vi.fn(async () => true),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(false);
    expect(deleteMessage.mock.calls).toEqual([
      ['session-1', 'assistant-1'],
      ['session-1', 'user-1'],
    ]);
    expect(restore).not.toHaveBeenCalled();
    expect(sync.mock.calls).toEqual([['session-1']]);
  });

  it('restores a child when a later deletion succeeded but its launch message remains', async () => {
    const restore = vi.fn(async () => true);
    const sync = vi.fn(async () => {});
    let messages = [
      { info: userMessage('user-1'), parts: [] },
      {
        info: assistantMessage('assistant-1'),
        parts: [completedTaskPart('child-1')],
      },
      { info: { ...userMessage('user-2'), time: { created: 2 } }, parts: [] },
      {
        info: { ...assistantMessage('assistant-2'), time: { created: 3 } },
        parts: [],
      },
    ];
    const deleteMessage = vi.fn(async (_sessionId: string, messageId: string) => {
      if (messageId === 'user-2') throw new Error('delete failed');
      messages = messages.filter((message) => message.info.id !== messageId);
    });

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => messages,
        getSessions: () => [session('session-1'), session('child-1', { parentID: 'session-1' })],
        getSessionTreeIds: (id) => [id],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        abortActiveSessionTree: vi.fn(async () => {}),
        moveSessionTreeToRecycleBin: vi.fn(async () => {}),
        restoreSessionTreeFromRecycleBin: restore,
        startLoading: vi.fn(),
        deleteMessage,
        syncSessionMessages: sync,
        sendEditedMessage: vi.fn(async () => true),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(false);
    expect(deleteMessage.mock.calls).toEqual([
      ['session-1', 'assistant-2'],
      ['session-1', 'user-2'],
    ]);
    expect(restore).toHaveBeenCalledWith('child-1');
    expect(sync.mock.calls).toEqual([['session-1'], ['child-1']]);
  });

  it('keeps the edited history truncated when the replacement send fails', async () => {
    const restorePrunedMessages = vi.fn();
    const stopLoading = vi.fn();
    const onOptimisticPublish = vi.fn();
    const releaseRemovals = vi.fn();
    const pruneMessagesFrom = vi.fn(() => restorePrunedMessages);
    const prepareEditedMessageSend = vi.fn(() => async () => false);

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [{ info: userMessage('user-1') }],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        startLoading: vi.fn(),
        deferMessageRemovals: vi.fn(() => releaseRemovals),
        pruneMessagesFrom,
        deleteMessage: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage: vi.fn(async () => false),
        prepareEditedMessageSend,
        stopLoading,
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt',
      { onOptimisticPublish }
    );

    expect(result).toBe(false);
    expect(prepareEditedMessageSend).toHaveBeenCalledWith(
      'updated prompt',
      'session-1',
      undefined,
      { providerID: 'openai', modelID: 'gpt-4o' }
    );
    expect(pruneMessagesFrom).toHaveBeenCalledWith('session-1', 'user-1');
    expect(restorePrunedMessages).not.toHaveBeenCalled();
    expect(onOptimisticPublish).not.toHaveBeenCalled();
    expect(releaseRemovals).toHaveBeenCalledOnce();
    expect(stopLoading).toHaveBeenCalledOnce();
  });

  it('aborts a working session before deleting the edited history tail', async () => {
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
        deleteMessage: vi.fn(async () => {
          callOrder.push('delete');
        }),
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage: vi.fn(async () => {
          callOrder.push('send');
          return true;
        }),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(callOrder).toEqual(['abort', 'delete', 'send']);
  });

  it('does not delete or resend an edit when stopping the active run fails', async () => {
    const deleteMessage = vi.fn(async () => {});
    const sendEditedMessage = vi.fn(async () => true);
    const syncSessionMessages = vi.fn(async () => {});

    const result = await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [{ info: userMessage('user-1') }],
        isSessionWorking: () => true,
        abortSession: vi.fn(async () => {
          throw new Error('abort failed');
        }),
        startLoading: vi.fn(),
        deleteMessage,
        syncSessionMessages,
        sendEditedMessage,
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt'
    );

    expect(result).toBe(false);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(sendEditedMessage).not.toHaveBeenCalled();
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });

  it('keeps an edit targeted to its captured session when the active session changes', async () => {
    const abortGate = deferred<void>();
    let activeSessionId = 'session-1';
    const abortSession = vi.fn(async (_sessionId: string) => abortGate.promise);
    const deleteMessage = vi.fn(async () => {});
    const sendEditedMessage = vi.fn(async () => true);

    const edit = editMessageWithDependencies(
      {
        getActiveSessionId: () => activeSessionId,
        getMessages: () => [{ info: userMessage('user-1') }],
        isSessionWorking: () => true,
        abortSession,
        startLoading: vi.fn(),
        deleteMessage,
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage,
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      'updated prompt',
      {
        queuedAttachments: {
          droppedFiles: [{ path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' }],
          clipboardImages: [],
          terminalSelection: null,
        },
      }
    );

    await vi.waitFor(() => expect(abortSession).toHaveBeenCalledWith('session-1'));
    activeSessionId = 'session-2';
    abortGate.resolve();

    await expect(edit).resolves.toBe(true);
    expect(deleteMessage).toHaveBeenCalledWith('session-1', 'user-1');
    expect(sendEditedMessage).toHaveBeenCalledWith('updated prompt', 'session-1', {
      droppedFiles: [{ path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' }],
      clipboardImages: [],
      terminalSelection: null,
    });
  });

  it('editMessage returns early for blank text, missing messages, and inactive sessions', async () => {
    const deleteMessage = vi.fn(async () => {});
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
      deleteMessage,
      syncSessionMessages: vi.fn(async () => {}),
      sendEditedMessage: vi.fn(async () => true),
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
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('editMessage can resend attachment-only edits with empty text', async () => {
    const deleteMessage = vi.fn(async () => {});
    const sendEditedMessage = vi.fn(async () => true);

    await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [{ info: userMessage('user-1') }],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        startLoading: vi.fn(),
        deleteMessage,
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage,
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      'user-1',
      '',
      { allowEmptyText: true }
    );

    expect(deleteMessage).toHaveBeenCalledWith('session-1', 'user-1');
    expect(sendEditedMessage).toHaveBeenCalledWith('', 'session-1', undefined);
  });

  it('resyncs history and reports errors without sending when deletion fails', async () => {
    const stopLoading = vi.fn();
    const setError = vi.fn();
    const sendEditedMessage = vi.fn(async () => true);
    const syncSessionMessages = vi.fn(async () => {});
    const releaseRemovals = vi.fn();

    await editMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getMessages: () => [{ info: userMessage('user-1') }],
        isSessionWorking: () => false,
        abortSession: vi.fn(async () => {}),
        startLoading: vi.fn(),
        deferMessageRemovals: vi.fn(() => releaseRemovals),
        pruneMessagesFrom: vi.fn(),
        deleteMessage: vi.fn(async () => {
          throw new Error('delete failed');
        }),
        syncSessionMessages,
        sendEditedMessage,
        stopLoading,
        setError,
      },
      'user-1',
      'updated prompt'
    );

    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
    expect(stopLoading).toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('delete failed');
    expect(sendEditedMessage).not.toHaveBeenCalled();
    expect(releaseRemovals).toHaveBeenCalledOnce();
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
        deleteMessage: vi.fn(async () => {
          throw 'oops';
        }),
        syncSessionMessages: vi.fn(async () => {}),
        sendEditedMessage: vi.fn(async () => true),
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
