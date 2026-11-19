import { flush as flushSolid, createEffect, createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, FileDiff, Part, Session, SessionStatus } from '../../types';
import {
  markProviderAuthFailure,
  providerRequiresReconnection,
  resetProviderConnectionState,
} from '../provider-connection-state';
import { upsertMessageInfo } from '../state-messages';
import {
  captureSessionStatusSnapshotTime,
  resetSessionStatusSnapshotTracking,
  sessionStore,
} from './session-store';
import {
  resetDefaultAppState,
  resetQuestionResolutionState,
  removeResolvedQuestion,
  setMessagesIncremental,
  setShowSessionPicker,
  startLoading,
  state,
  stopLoading,
  upsertQuestion,
} from '../state';

function createSession(id: string, parentID?: string): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/workspace',
    parentID,
    title: id,
    version: '1',
    time: {
      created: 1,
      updated: 1,
    },
  };
}

function completedAssistantMessage(sessionID = 'session-1'): AssistantMessage {
  return {
    id: `${sessionID}-assistant-1`,
    sessionID,
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: `${sessionID}-user-1`,
    modelID: 'gpt-4o',
    providerID: 'openai',
    mode: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function toolPart(status: 'running' | 'completed'): Part {
  return {
    id: 'tool-1',
    sessionID: 'session-1',
    messageID: 'session-1-assistant-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'bash',
    state:
      status === 'running'
        ? {
            status: 'running',
            input: { command: 'npm test' },
            title: 'Runs tests',
            metadata: {},
            time: { start: 1 },
          }
        : {
            status: 'completed',
            input: { command: 'npm test' },
            output: 'ok',
            title: 'Runs tests',
            metadata: {},
            time: { start: 1, end: 2 },
          },
  };
}

describe('sessionStore', () => {
  it('retains service lifetime through optimistic send, steering, retry and idle statuses', () => {
    sessionStore.setSessionStatusEntry('session-1', { type: 'idle', backgroundServices: 1 });
    flushSolid();
    for (const status of [
      { type: 'busy' },
      { type: 'retry', attempt: 1, message: 'Retrying', next: 1000 },
      { type: 'idle' },
    ] satisfies SessionStatus[]) {
      sessionStore.setSessionStatusEntry('session-1', status);
      flushSolid();
      expect(sessionStore.getBackgroundServiceCount('session-1')).toBe(1);
    }
    sessionStore.setSessionStatusEntry('session-1', { type: 'idle', backgroundServices: 0 });
    flushSolid();
    expect(sessionStore.getBackgroundServiceCount('session-1')).toBe(0);
  });

  it('protects process lifetime from stale snapshots separately from optimistic turn changes', () => {
    sessionStore.setSessionStatuses({ 'session-1': { type: 'idle', backgroundServices: 1 } });
    flushSolid();
    const snapshotStartedAt = captureSessionStatusSnapshotTime();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy', backgroundServices: 0 });
    flushSolid();
    sessionStore.setSessionStatuses(
      { 'session-1': { type: 'idle', backgroundServices: 1 } },
      { snapshotStartedAt }
    );
    flushSolid();
    expect(sessionStore.getBackgroundServiceCount('session-1')).toBe(0);
    sessionStore.setSessionStatuses({ 'session-1': { type: 'idle', backgroundServices: 1 } });
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();
    expect(sessionStore.getBackgroundServiceCount('session-1')).toBe(1);
    sessionStore.setSessionStatuses({});
    flushSolid();
    expect(sessionStore.getBackgroundServiceCount('session-1')).toBe(0);
  });
  it.each(['idle', 'busy'] as const)(
    'publishes service-count-only changes for %s sessions',
    (type) => {
      sessionStore.setSessionStatusEntry('session-1', { type, backgroundServices: 1 });
      flushSolid();
      sessionStore.setSessionStatusEntry('session-1', { type, backgroundServices: 2 });
      flushSolid();
      expect(state.sessionStatus['session-1']).toEqual({ type, backgroundServices: 2 });
      sessionStore.setSessionStatuses({ 'session-1': { type, backgroundServices: 1 } });
      flushSolid();
      expect(state.sessionStatus['session-1']).toEqual({ type, backgroundServices: 1 });
      sessionStore.setSessionStatuses({ 'session-1': { type } });
      flushSolid();
      expect(state.sessionStatus['session-1']).toEqual({ type });
    }
  );
  it('publishes command-only changes in background status events and snapshots', () => {
    const status: SessionStatus = {
      type: 'busy',
      background: true,
      backgroundStartedAt: 1,
      backgroundCommand: 'npm test',
    };
    sessionStore.setSessionStatusEntry('session-1', status);
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', {
      ...status,
      backgroundCommand: 'npm run build',
    });
    flushSolid();
    expect(state.sessionStatus['session-1']).toMatchObject({ backgroundCommand: 'npm run build' });
    sessionStore.setSessionStatuses({
      'session-1': { ...status, backgroundCommand: 'python3 tools/serve.py 18765' },
    });
    flushSolid();
    expect(state.sessionStatus['session-1']).toMatchObject({
      backgroundCommand: 'python3 tools/serve.py 18765',
    });
  });
  beforeEach(() => {
    // SAFETY: The test removes the optional host-provided initial state from the window fixture.
    delete (window as { __initialWebviewState?: unknown }).__initialWebviewState;
    window.localStorage.clear();
    flushSolid();
    resetDefaultAppState();
    flushSolid();
    resetQuestionResolutionState();
    flushSolid();
    resetSessionStatusSnapshotTracking();
    flushSolid();
    resetProviderConnectionState();
    flushSolid();
  });

  it('preserves a scheduled provider retry across idle snapshots until cancellation', () => {
    const retry = {
      type: 'retry' as const,
      attempt: 1,
      message: 'Not Found',
      next: Date.now() + 5000,
    };
    sessionStore.retainProviderRetryStatus('session-1', retry, () => {
      sessionStore.retainProviderRetryStatus('session-1', null);
      sessionStore.setSessionStatusEntry('session-1', { type: 'idle' });
    });
    sessionStore.setSessionStatusEntry('session-1', retry);
    flushSolid();
    sessionStore.setSessionStatuses({});
    flushSolid();
    expect(state.sessionStatus['session-1']).toEqual(retry);
    sessionStore.setSessionStatuses({}, { snapshotStartedAt: captureSessionStatusSnapshotTime() });
    flushSolid();
    expect(state.sessionStatus['session-1']).toEqual(retry);
    sessionStore.setSessionStatusEntry('session-1', { type: 'idle' });
    flushSolid();
    expect(state.sessionStatus['session-1']).toEqual(retry);
    sessionStore.cancelProviderRetry('session-1');
    flushSolid();
    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
    expect(sessionStore.isProviderRetryScheduled('session-1')).toBe(false);
    sessionStore.setSessionStatuses({});
    flushSolid();
    expect(state.sessionStatus['session-1']?.type).not.toBe('retry');
  });

  it('allows resumed backend work to supersede a local retry countdown', () => {
    const retry = {
      type: 'retry' as const,
      attempt: 1,
      message: 'Not Found',
      next: Date.now() + 5000,
    };
    sessionStore.retainProviderRetryStatus('session-1', retry);
    sessionStore.setSessionStatusEntry('session-1', retry);
    flushSolid();
    sessionStore.setSessionStatuses({ 'session-1': { type: 'busy' } });
    flushSolid();
    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });
  });

  it('recovers provider models from successful history without mounting message rows', () => {
    markProviderAuthFailure('openai', 'old-error', 0);
    flushSolid();
    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);
    flushSolid();
    expect(providerRequiresReconnection('openai')).toBe(false);
    markProviderAuthFailure('openai', 'late-mounted-error', 0);
    flushSolid();
    expect(providerRequiresReconnection('openai')).toBe(false);
    markProviderAuthFailure('openai', 'new-error', 3);
    flushSolid();
    upsertMessageInfo(completedAssistantMessage());
    flushSolid();
    expect(providerRequiresReconnection('openai')).toBe(true);
    upsertMessageInfo({ ...completedAssistantMessage(), time: { created: 4, completed: 5 } });
    flushSolid();
    expect(providerRequiresReconnection('openai')).toBe(false);
  });

  it('does not treat pending or failed responses as restored authentication', () => {
    markProviderAuthFailure('openai', 'error', 0);
    flushSolid();
    const info = completedAssistantMessage();
    if (info.role !== 'assistant') throw new Error('Expected assistant fixture');
    upsertMessageInfo({ ...info, time: { created: 4 } });
    flushSolid();
    expect(providerRequiresReconnection('openai')).toBe(true);
    upsertMessageInfo({ ...info, error: { name: 'UnknownError', data: { message: 'failed' } } });
    flushSolid();
    expect(providerRequiresReconnection('openai')).toBe(true);
  });

  it('updates active session, diffs, and session status entries', () => {
    const diffs: FileDiff[] = [
      {
        file: 'src/index.ts',
        before: 'before',
        after: 'after',
        additions: 1,
        deletions: 1,
      },
    ];

    sessionStore.setActiveSessionId('session-1');
    flushSolid();
    sessionStore.setDiffs(diffs);
    flushSolid();
    sessionStore.setSessionStatuses({
      'session-1': { type: 'busy' },
    });
    flushSolid();
    sessionStore.setSessionStatusEntry('session-2', { type: 'idle' });
    flushSolid();

    expect(state.activeSessionId).toBe('session-1');
    expect(state.diffs).toEqual(diffs);
    expect(state.sessionStatus).toEqual({
      'session-1': { type: 'busy' },
      'session-2': { type: 'idle' },
    });

    sessionStore.clearSessionStatusEntry('session-1');
    flushSolid();

    expect(state.sessionStatus).toEqual({
      'session-2': { type: 'idle' },
    });
  });

  it('does not let stale status snapshots overwrite newer local events', () => {
    const localUpdateTime = Date.now() + 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(localUpdateTime);
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();

    const reconciledStatuses = sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'idle' },
        'session-2': { type: 'busy' },
      },
      { snapshotStartedAt: localUpdateTime - 1 }
    );
    flushSolid();

    expect(state.sessionStatus).toEqual({
      'session-1': { type: 'busy' },
      'session-2': { type: 'busy' },
    });
    expect(reconciledStatuses).toEqual(state.sessionStatus);

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);
    flushSolid();

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'idle' },
        'session-2': { type: 'idle' },
      },
      { snapshotStartedAt: localUpdateTime + 1 }
    );
    flushSolid();

    expect(state.sessionStatus).toEqual({
      'session-1': { type: 'idle' },
      'session-2': { type: 'idle' },
    });
    nowSpy.mockRestore();
  });

  it('preserves a local event that arrives in the same millisecond as a snapshot starts', () => {
    const timestamp = Date.now() + 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(timestamp);
    const snapshotStartedAt = captureSessionStatusSnapshotTime();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();

    sessionStore.setSessionStatuses({ 'session-1': { type: 'idle' } }, { snapshotStartedAt });
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });
    nowSpy.mockRestore();
  });

  it('does not let an older status snapshot clear a newer question transition', () => {
    const timestamp = Date.now() + 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(timestamp);
    const snapshotStartedAt = captureSessionStatusSnapshotTime();
    upsertQuestion({ id: 'question-1', sessionID: 'session-1', questions: [] });
    flushSolid();
    removeResolvedQuestion('question-1');
    flushSolid();

    sessionStore.setSessionStatuses({}, { snapshotStartedAt });
    flushSolid();

    expect(state.questionResponsePendingSessionIds).toEqual(['session-1']);

    sessionStore.setSessionStatuses({}, { snapshotStartedAt: captureSessionStatusSnapshotTime() });
    flushSolid();
    expect(state.questionResponsePendingSessionIds).toEqual([]);
    nowSpy.mockRestore();
  });

  it('clears only the question transition owned by the updated child session', () => {
    upsertQuestion({ id: 'question-1', sessionID: 'child-1', questions: [] });
    flushSolid();
    upsertQuestion({ id: 'question-2', sessionID: 'child-2', questions: [] });
    flushSolid();
    removeResolvedQuestion('question-1');
    flushSolid();
    removeResolvedQuestion('question-2');
    flushSolid();

    sessionStore.setSessionStatusEntry('child-1', { type: 'busy' });
    flushSolid();

    expect(state.questionResponsePendingSessionIds).toEqual(['child-2']);
  });

  it('reports status snapshots that predate a local event or an applied snapshot as stale', () => {
    const snapshotStartedAt = captureSessionStatusSnapshotTime();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();

    expect(sessionStore.isSessionStatusSnapshotStale('session-1', snapshotStartedAt)).toBe(true);
    expect(sessionStore.isSessionStatusSnapshotStale('session-2', snapshotStartedAt)).toBe(false);
    expect(
      sessionStore.isSessionStatusSnapshotStale('session-1', captureSessionStatusSnapshotTime())
    ).toBe(false);

    sessionStore.setSessionStatuses(
      { 'session-1': { type: 'busy' } },
      { snapshotStartedAt: captureSessionStatusSnapshotTime() }
    );
    flushSolid();
    expect(sessionStore.isSessionStatusSnapshotStale('session-2', snapshotStartedAt)).toBe(true);
  });

  it('prunes acknowledged local markers and ignores older snapshots afterward', () => {
    const localUpdateTime = Date.now() + 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(localUpdateTime);
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    sessionStore.setSessionStatusEntry('acknowledged-session', { type: 'idle' });
    flushSolid();

    sessionStore.setSessionStatuses(
      { 'acknowledged-session': { type: 'idle' } },
      { snapshotStartedAt: localUpdateTime + 1 }
    );
    flushSolid();

    expect(deleteSpy).toHaveBeenCalledWith('acknowledged-session');

    sessionStore.setSessionStatuses(
      { 'acknowledged-session': { type: 'busy' } },
      { snapshotStartedAt: localUpdateTime - 1 }
    );
    flushSolid();

    expect(state.sessionStatus['acknowledged-session']).toEqual({ type: 'idle' });
    deleteSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it('preserves active running status after its local marker is acknowledged', () => {
    const localUpdateTime = Date.now() + 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(localUpdateTime);
    sessionStore.setSessions([createSession('session-1')]);
    flushSolid();
    sessionStore.setActiveSessionId('session-1');
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();

    sessionStore.setSessionStatuses(
      { 'session-1': { type: 'idle' } },
      { snapshotStartedAt: localUpdateTime + 1 }
    );
    flushSolid();
    sessionStore.setSessionStatuses(
      { 'session-1': { type: 'idle' } },
      { snapshotStartedAt: localUpdateTime + 2 }
    );
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });
    nowSpy.mockRestore();
  });

  it('ignores equivalent status snapshots', () => {
    sessionStore.setSessionStatuses({
      'session-1': { type: 'busy' },
      'session-2': { type: 'retry', attempt: 1, message: 'retrying', next: 2 },
    });
    flushSolid();
    let runs = 0;
    const dispose = createRoot((cleanup) => {
      createEffect(
        () => {
          const firstType = state.sessionStatus['session-1']?.type;
          const secondType = state.sessionStatus['session-2']?.type;
          if (!firstType || !secondType) throw new Error('Expected test statuses to exist');
        },
        () => {
          runs += 1;
        }
      );
      return cleanup;
    });
    flushSolid();

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'busy' },
        'session-2': { type: 'retry', attempt: 1, message: 'retrying', next: 2 },
      },
      { snapshotStartedAt: Date.now() + 1 }
    );
    flushSolid();

    expect(runs).toBe(1);
    dispose();
    flushSolid();
  });

  it('applies changed status snapshots', () => {
    sessionStore.setSessionStatuses({ 'session-1': { type: 'busy' } });
    flushSolid();
    let runs = 0;
    const dispose = createRoot((cleanup) => {
      createEffect(
        () => {
          const type = state.sessionStatus['session-1']?.type;
          if (!type) throw new Error('Expected test status to exist');
        },
        () => {
          runs += 1;
        }
      );
      return cleanup;
    });
    flushSolid();

    sessionStore.setSessionStatuses({ 'session-1': { type: 'idle' } });
    flushSolid();

    expect(runs).toBe(2);
    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
    dispose();
    flushSolid();
  });

  it('keeps locally running sessions busy until their latest assistant settles', () => {
    sessionStore.setActiveSessionId('session-1');
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'idle' },
      },
      { snapshotStartedAt: Date.now() + 1000 }
    );
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'idle' },
      },
      { snapshotStartedAt: Date.now() + 2000 }
    );
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
  });

  it('keeps locally running sessions busy while a completed assistant still has a running tool', () => {
    sessionStore.setActiveSessionId('session-1');
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [toolPart('running')] }]);
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'idle' },
      },
      { snapshotStartedAt: Date.now() + 1000 }
    );
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [toolPart('completed')] }]);
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'idle' },
      },
      { snapshotStartedAt: Date.now() + 2000 }
    );
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
  });

  it('suppresses a snapshot older than local idle and accepts a newer busy snapshot', () => {
    const localUpdateTime = Date.now() + 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(localUpdateTime);
    sessionStore.setSessionStatusEntry('session-1', { type: 'idle' });
    flushSolid();

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'busy' },
      },
      { snapshotStartedAt: localUpdateTime - 1 }
    );
    flushSolid();

    expect(state.sessionStatus).toEqual({
      'session-1': { type: 'idle' },
    });

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'busy' },
      },
      { snapshotStartedAt: localUpdateTime + 1 }
    );
    flushSolid();

    expect(state.sessionStatus).toEqual({
      'session-1': { type: 'busy' },
    });
    nowSpy.mockRestore();
  });

  it('keeps running status until authoritative idle when synced messages are complete', () => {
    sessionStore.setActiveSessionId('session-1');
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });
    expect(state.lastSeenSessions['session-1']).toBeGreaterThanOrEqual(2);
    expect(state.completedSessionResponses['session-1']).toBeUndefined();
  });

  it('keeps active loading sessions busy when synced messages show a completed assistant step', () => {
    sessionStore.setActiveSessionId('session-1');
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();
    startLoading(1);
    flushSolid();

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });

    stopLoading();
    flushSolid();
  });

  it('marks active synced completions unread without clearing running status', () => {
    sessionStore.setActiveSessionId('session-1');
    flushSolid();
    setShowSessionPicker(true);
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });
    expect(state.completedSessionResponses['session-1']).toBeGreaterThanOrEqual(2);
    expect(state.lastSeenSessions['session-1']).toBeUndefined();
  });

  it('does not clear a spinner before a fresh busy snapshot arrives', () => {
    sessionStore.setActiveSessionId('session-1');
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();
    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);
    flushSolid();

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'busy' },
      },
      { snapshotStartedAt: Date.now() + 1000 }
    );
    flushSolid();

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });
  });

  it('marks inactive running sessions completed when status turns idle', () => {
    sessionStore.setActiveSessionId('other-session');
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();

    sessionStore.setSessionStatusEntry('session-1', { type: 'idle' });
    flushSolid();

    expect(state.completedSessionResponses['session-1']).toBeGreaterThan(0);
    expect(state.lastSeenSessions['session-1']).toBeUndefined();
  });

  it('marks active running sessions completed when the session list is open', () => {
    sessionStore.setActiveSessionId('session-1');
    flushSolid();
    setShowSessionPicker(true);
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();

    sessionStore.setSessionStatusEntry('session-1', { type: 'idle' });
    flushSolid();

    expect(state.completedSessionResponses['session-1']).toBeGreaterThan(0);
    expect(state.lastSeenSessions['session-1']).toBeUndefined();
  });

  it('marks active editor sessions seen when status turns idle while the session list is open', () => {
    // SAFETY: The fixture provides the initial host state read by the session store.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'session', sessionId: 'session-1' },
      },
    };
    sessionStore.setActiveSessionId('session-1');
    flushSolid();
    setShowSessionPicker(true);
    flushSolid();
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    flushSolid();

    sessionStore.setSessionStatusEntry('session-1', { type: 'idle' });
    flushSolid();

    expect(state.lastSeenSessions['session-1']).toBeGreaterThan(0);
    expect(state.completedSessionResponses['session-1']).toBeUndefined();
  });

  it('exposes session tree helpers for loaded sessions', () => {
    const root = createSession('root');
    const child = createSession('child', 'root');

    sessionStore.setSessions([root, child]);
    flushSolid();

    expect(sessionStore.getSessionTreeIds('root')).toEqual(['root', 'child']);
    expect(sessionStore.getSessionTreeRootId('child')).toBe('root');
  });

  it('preserves session row identity across same-id refreshes', () => {
    sessionStore.setSessions([createSession('session-1')]);
    flushSolid();
    const existing = state.sessions[0];

    sessionStore.setSessions([
      {
        ...createSession('session-1'),
        title: 'Updated title',
        time: { created: 1, updated: 2 },
      },
    ]);
    flushSolid();

    expect(state.sessions[0]).toBe(existing);
    expect(state.sessions[0]?.title).toBe('Updated title');
    expect(state.sessions[0]?.time.updated).toBe(2);
  });
});
