import { beforeEach, describe, expect, it } from 'vitest';
import type { FileDiff, Session } from '../../types';
import { sessionStore } from './session-store';
import { resetDefaultAppState, state } from '../state';

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

  it('exposes session tree helpers for loaded sessions', () => {
    const root = createSession('root');
    const child = createSession('child', 'root');

    sessionStore.setSessions([root, child]);

    expect(sessionStore.getSessionTreeIds('root')).toEqual(['root', 'child']);
    expect(sessionStore.getSessionTreeRootId('child')).toBe('root');
  });
});
