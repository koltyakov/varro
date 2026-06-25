import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEffect, createRoot } from 'solid-js';
import type { FileDiff, Message, Part, Session } from '../../types';
import { sessionStore } from './session-store';
import {
  resetDefaultAppState,
  setMessagesIncremental,
  setShowSessionPicker,
  startLoading,
  state,
  stopLoading,
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

function completedAssistantMessage(sessionID = 'session-1'): Message {
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
  beforeEach(() => {
    window.localStorage.clear();
    resetDefaultAppState();
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
    sessionStore.setDiffs(diffs);
    sessionStore.setSessionStatuses({
      'session-1': { type: 'busy' },
    });
    sessionStore.setSessionStatusEntry('session-2', { type: 'idle' });

    expect(state.activeSessionId).toBe('session-1');
    expect(state.diffs).toEqual(diffs);
    expect(state.sessionStatus).toEqual({
      'session-1': { type: 'busy' },
      'session-2': { type: 'idle' },
    });

    sessionStore.clearSessionStatusEntry('session-1');

    expect(state.sessionStatus).toEqual({
      'session-2': { type: 'idle' },
    });
  });

  it('does not let stale status snapshots overwrite newer local events', () => {
    const localUpdateTime = Date.now() + 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(localUpdateTime);
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'idle' },
        'session-2': { type: 'busy' },
      },
      { snapshotStartedAt: localUpdateTime - 1 }
    );

    expect(state.sessionStatus).toEqual({
      'session-1': { type: 'busy' },
      'session-2': { type: 'busy' },
    });

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'idle' },
        'session-2': { type: 'idle' },
      },
      { snapshotStartedAt: localUpdateTime + 1 }
    );

    expect(state.sessionStatus).toEqual({
      'session-1': { type: 'idle' },
      'session-2': { type: 'idle' },
    });
    nowSpy.mockRestore();
  });

  it('ignores equivalent status snapshots', () => {
    sessionStore.setSessionStatuses({
      'session-1': { type: 'busy' },
      'session-2': { type: 'retry', attempt: 1, message: 'retrying', next: 2 },
    });
    let runs = 0;
    const dispose = createRoot((cleanup) => {
      createEffect(() => {
        const firstType = state.sessionStatus['session-1']?.type;
        const secondType = state.sessionStatus['session-2']?.type;
        if (!firstType || !secondType) throw new Error('Expected test statuses to exist');
        runs += 1;
      });
      return cleanup;
    });

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'busy' },
        'session-2': { type: 'retry', attempt: 1, message: 'retrying', next: 2 },
      },
      { snapshotStartedAt: Date.now() + 1 }
    );

    expect(runs).toBe(1);
    dispose();
  });

  it('applies changed status snapshots', () => {
    sessionStore.setSessionStatuses({ 'session-1': { type: 'busy' } });
    let runs = 0;
    const dispose = createRoot((cleanup) => {
      createEffect(() => {
        const type = state.sessionStatus['session-1']?.type;
        if (!type) throw new Error('Expected test status to exist');
        runs += 1;
      });
      return cleanup;
    });

    sessionStore.setSessionStatuses({ 'session-1': { type: 'idle' } });

    expect(runs).toBe(2);
    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
    dispose();
  });

  it('keeps locally running sessions busy until their latest assistant settles', () => {
    sessionStore.setActiveSessionId('session-1');
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'idle' },
      },
      { snapshotStartedAt: Date.now() + 1000 }
    );

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);

    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
  });

  it('keeps locally running sessions busy while a completed assistant still has a running tool', () => {
    sessionStore.setActiveSessionId('session-1');
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [toolPart('running')] }]);

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'idle' },
      },
      { snapshotStartedAt: Date.now() + 1000 }
    );

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [toolPart('completed')] }]);

    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
  });

  it('keeps locally finished sessions idle when status snapshots still report running', () => {
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    sessionStore.setSessionStatusEntry('session-1', { type: 'idle' });

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'busy' },
      },
      { snapshotStartedAt: Date.now() + 1000 }
    );

    expect(state.sessionStatus).toEqual({
      'session-1': { type: 'idle' },
    });

    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });

    expect(state.sessionStatus).toEqual({
      'session-1': { type: 'busy' },
    });
  });

  it('settles stale running status when synced active messages are already complete', () => {
    sessionStore.setActiveSessionId('session-1');
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);

    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
    expect(state.lastSeenSessions['session-1']).toBeGreaterThanOrEqual(2);
    expect(state.completedSessionResponses['session-1']).toBeUndefined();
  });

  it('keeps active loading sessions busy when synced messages show a completed assistant step', () => {
    sessionStore.setActiveSessionId('session-1');
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    startLoading(1);

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);

    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });

    stopLoading();
  });

  it('marks active synced completions unread when the session list is open', () => {
    sessionStore.setActiveSessionId('session-1');
    setShowSessionPicker(true);
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });

    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);

    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
    expect(state.completedSessionResponses['session-1']).toBeGreaterThanOrEqual(2);
    expect(state.lastSeenSessions['session-1']).toBeUndefined();
  });

  it('does not let stale running snapshots revive a settled active chat spinner', () => {
    sessionStore.setActiveSessionId('session-1');
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
    setMessagesIncremental([{ info: completedAssistantMessage(), parts: [] }]);

    sessionStore.setSessionStatuses(
      {
        'session-1': { type: 'busy' },
      },
      { snapshotStartedAt: Date.now() + 1000 }
    );

    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
  });

  it('marks inactive running sessions completed when status turns idle', () => {
    sessionStore.setActiveSessionId('other-session');
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });

    sessionStore.setSessionStatusEntry('session-1', { type: 'idle' });

    expect(state.completedSessionResponses['session-1']).toBeGreaterThan(0);
    expect(state.lastSeenSessions['session-1']).toBeUndefined();
  });

  it('marks active running sessions completed when the session list is open', () => {
    sessionStore.setActiveSessionId('session-1');
    setShowSessionPicker(true);
    sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });

    sessionStore.setSessionStatusEntry('session-1', { type: 'idle' });

    expect(state.completedSessionResponses['session-1']).toBeGreaterThan(0);
    expect(state.lastSeenSessions['session-1']).toBeUndefined();
  });

  it('exposes session tree helpers for loaded sessions', () => {
    const root = createSession('root');
    const child = createSession('child', 'root');

    sessionStore.setSessions([root, child]);

    expect(sessionStore.getSessionTreeIds('root')).toEqual(['root', 'child']);
    expect(sessionStore.getSessionTreeRootId('child')).toBe('root');
  });

  it('preserves session row identity across same-id refreshes', () => {
    sessionStore.setSessions([createSession('session-1')]);
    const existing = state.sessions[0];

    sessionStore.setSessions([
      {
        ...createSession('session-1'),
        title: 'Updated title',
        time: { created: 1, updated: 2 },
      },
    ]);

    expect(state.sessions[0]).toBe(existing);
    expect(state.sessions[0]?.title).toBe('Updated title');
    expect(state.sessions[0]?.time.updated).toBe(2);
  });
});
