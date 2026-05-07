import { describe, expect, it, vi } from 'vitest';
import type { Message, Session } from '../types';
import {
  abortSessionWithDependencies,
  compactSessionWithDependencies,
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
    const operations = new SessionControlOperations({
      getActiveSessionId: () => 'session-1',
      sendMessage: vi.fn(async () => {}),
      getSessionTreeRootId: () => null,
      getSessionTreeIds: () => ['session-1'],
      getSelectedAgentForSession: () => 'build',
      skipPlanSession: vi.fn(),
      getSessionStatus: () => ({ type: 'idle' }),
      getSessionUsageLimit: () => null,
      markPendingAbortTree: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      stopLoading: vi.fn(),
      abortRemoteSession: vi.fn(async () => {}),
      clearPendingAbortTree: vi.fn(),
      setSessionUsageLimit: vi.fn(),
      logError: vi.fn(),
      getMessages: () => [{ info: assistantMessage('assistant-1') }],
      startLoading: vi.fn(),
      revertSession: vi.fn(async () => {}),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      setError: vi.fn(),
      unrevertSession: vi.fn(async () => session('session-1')),
      upsertSession: vi.fn(),
      clearPendingAbort: vi.fn(),
      resolveSelectedModel: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
      setSessionCompacting: vi.fn(),
      compactRemoteSession: vi.fn(async () => {}),
      getSession: () => session('session-1'),
    });

    await operations.reviewSession();
    await operations.abortSession();
    await operations.undoSession();
    await operations.redoSession();
    await operations.compactSession();

    expect(true).toBe(true);
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
