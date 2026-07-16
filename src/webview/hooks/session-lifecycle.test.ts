import { describe, expect, it, vi } from 'vitest';
import type { MockedObject } from 'vitest';
import type * as StateModule from '../lib/state';
import type { Session, SessionStatus } from '../types';

const {
  clearMessages,
  clearCurrentDocumentStateForSession,
  clearSelectedAgentForSession,
  clearSelectedMcpsForSession,
  clearSelectedModelForSession,
  clearSessionSeen,
  clearSkippedPlanSession,
  markSessionSeenState,
  persistActiveSessionId,
  removePermissionModeForSession,
  setSessionFailed,
  setSessionsState,
  setSessionUsageLimit,
  setState,
  state,
  stopLoading,
} = vi.hoisted(() => ({
  clearMessages: vi.fn(),
  clearCurrentDocumentStateForSession: vi.fn(),
  clearSelectedAgentForSession: vi.fn(),
  clearSelectedMcpsForSession: vi.fn(),
  clearSelectedModelForSession: vi.fn(),
  clearSessionSeen: vi.fn(),
  clearSkippedPlanSession: vi.fn(),
  markSessionSeenState: vi.fn(),
  persistActiveSessionId: vi.fn(),
  removePermissionModeForSession: vi.fn(),
  setSessionFailed: vi.fn(),
  setSessionsState: vi.fn(),
  setSessionUsageLimit: vi.fn(),
  setState: vi.fn(),
  state: {
    activeSessionId: null as string | null,
    sessions: [] as Session[],
  },
  stopLoading: vi.fn(),
}));

vi.mock('../lib/state', async () => {
  const actual = (await vi.importActual('../lib/state')) as MockedObject<typeof StateModule>;
  return {
    ...actual,
    clearMessages,
    clearCurrentDocumentStateForSession,
    clearSelectedAgentForSession,
    clearSelectedMcpsForSession,
    clearSelectedModelForSession,
    clearSessionSeen,
    clearSkippedPlanSession,
    markSessionSeen: markSessionSeenState,
    persistActiveSessionId,
    removePermissionModeForSession,
    setSessionFailed,
    setSessions: setSessionsState,
    setSessionUsageLimit,
    setState,
    state,
    stopLoading,
  };
});

import {
  applySessions,
  clearDeletedSessionState,
  getDeletedSessionTreeIds,
  getNextSessionIdAfterDeletion,
  hideDeletedSessionTree,
  isSessionInWorkspace,
  normalizeProjectPath,
  removeDeletedSessionTree,
  SessionLifecycleOperations,
  sortSessions,
  upsertSession,
} from './session/session-lifecycle';

function session(id: string, directory = '/repo', updated = 0, parentID?: string): Session {
  return {
    id,
    projectID: 'project-1',
    directory,
    title: id,
    version: '1',
    ...(parentID ? { parentID } : {}),
    time: { created: updated, updated },
  };
}

function createDeps(overrides?: {
  activeSessionId?: string | null;
  sessions?: Session[];
  workspace?: string | null;
}) {
  const current = {
    activeSessionId: overrides?.activeSessionId ?? null,
    sessions: overrides?.sessions ?? [],
  };
  const sessionStatus: Record<string, SessionStatus> = {};

  return {
    current,
    sessionStatus,
    calls: {
      clearActiveSessionState: vi.fn(() => {
        current.activeSessionId = null;
      }),
      markSessionSeen: vi.fn(),
      clearPendingAbort: vi.fn(),
      clearPendingAbortTree: vi.fn(),
      removePermissionModeForSession: vi.fn(),
      clearCurrentDocumentStateForSession: vi.fn(),
      clearSelectedAgentForSession: vi.fn(),
      clearSelectedMcpsForSession: vi.fn(),
      clearSkippedPlanSession: vi.fn(),
      clearSelectedModelForSession: vi.fn(),
      clearSessionSeen: vi.fn(),
      setSessionUsageLimit: vi.fn(),
      setSessionFailed: vi.fn(),
      filterQuestions: vi.fn(),
      filterPermissions: vi.fn(),
      filterPendingAttentionSessionIds: vi.fn(),
    },
    deps: {
      getState: () => current,
      getCurrentWorkspacePath: () => overrides?.workspace ?? '/repo',
      setSessions: (sessions: Session[]) => {
        current.sessions = sessions;
      },
      clearSessionStatusEntry: (sessionId: string) => {
        delete sessionStatus[sessionId];
      },
      clearPendingAbort: vi.fn(),
      clearPendingAbortTree: vi.fn(),
      removePermissionModeForSession: vi.fn(),
      clearCurrentDocumentStateForSession: vi.fn(),
      clearSelectedAgentForSession: vi.fn(),
      clearSelectedMcpsForSession: vi.fn(),
      clearSkippedPlanSession: vi.fn(),
      clearSelectedModelForSession: vi.fn(),
      clearSessionSeen: vi.fn(),
      setSessionUsageLimit: vi.fn(),
      setSessionFailed: vi.fn(),
      filterQuestions: vi.fn(),
      filterPermissions: vi.fn(),
      filterPendingAttentionSessionIds: vi.fn(),
      clearActiveSessionState: vi.fn(() => {
        current.activeSessionId = null;
      }),
      markSessionSeen: vi.fn(),
    },
  };
}

describe('session-lifecycle helpers', () => {
  it('normalizes workspace paths and filters sessions to the active workspace', () => {
    expect(normalizeProjectPath('/repo///')).toBe('/repo');
    expect(normalizeProjectPath('C:\\repo\\')).toBe('C:/repo');

    const setup = createDeps({
      activeSessionId: 'session-2',
      sessions: [session('session-1', '/repo-a', 1), session('session-2', '/repo-b', 2)],
      workspace: '/repo-a',
    });

    applySessions(setup.deps, setup.current.sessions);

    expect(setup.current.sessions.map((item) => item.id)).toEqual(['session-1']);
    expect(setup.deps.clearActiveSessionState).toHaveBeenCalledTimes(1);
  });

  it('treats Windows workspace paths as case-insensitive when filtering sessions', () => {
    const setup = createDeps({
      sessions: [
        session('session-1', 'C:\\Users\\Andrew\\Projects\\Varro', 2),
        session('session-2', 'D:\\Other', 1),
      ],
      workspace: 'c:/users/andrew/projects/varro',
    });

    applySessions(setup.deps, setup.current.sessions);

    expect(setup.current.sessions.map((item) => item.id)).toEqual(['session-1']);
    expect(setup.deps.clearActiveSessionState).not.toHaveBeenCalled();
  });

  it('filters nested Windows sessions when workspace casing differs', () => {
    const setup = createDeps({
      sessions: [
        session('session-1', 'C:\\Users\\Andrew\\Projects\\Varro\\packages\\cli', 2),
        session('session-2', 'D:\\Other', 1),
      ],
      workspace: 'c:/users/andrew/projects/varro',
    });

    applySessions(setup.deps, setup.current.sessions);

    expect(setup.current.sessions.map((item) => item.id)).toEqual([]);
  });

  it('filters sessions whose directory is nested under the active workspace', () => {
    const setup = createDeps({
      sessions: [
        session('session-1', '/repo/project-a', 2),
        session('session-2', '/other/project-b', 1),
      ],
      workspace: '/repo',
    });

    applySessions(setup.deps, setup.current.sessions);

    expect(setup.current.sessions.map((item) => item.id)).toEqual([]);
    expect(setup.deps.clearActiveSessionState).not.toHaveBeenCalled();
  });

  it('tracks deleted session trees and next selection candidates', () => {
    const sessions = [
      session('root', '/repo', 1),
      session('child', '/repo', 2, 'root'),
      session('other', '/repo', 3),
    ];

    expect(getDeletedSessionTreeIds('root', sessions)).toEqual(new Set(['root', 'child']));
    expect(
      getNextSessionIdAfterDeletion([session('child', '/repo', 2, 'root'), session('other')])
    ).toBe('other');
  });

  it.each([
    {
      name: 'traverses descendants of a missing root in deletion order',
      rootId: 'missing',
      sessions: [
        session('first', '/repo', 0, 'missing'),
        session('second', '/repo', 0, 'missing'),
        session('first-leaf', '/repo', 0, 'first'),
        session('second-leaf', '/repo', 0, 'second'),
      ],
      expected: ['missing', 'second', 'second-leaf', 'first', 'first-leaf'],
    },
    {
      name: 'terminates cycles and visits each ID once',
      rootId: 'a',
      sessions: [session('a', '/repo', 0, 'b'), session('b', '/repo', 0, 'a')],
      expected: ['a', 'b'],
    },
    {
      name: 'deduplicates duplicate session IDs',
      rootId: 'root',
      sessions: [
        session('root'),
        session('child', '/repo', 0, 'root'),
        session('child', '/repo', 0, 'root'),
        session('leaf', '/repo', 0, 'child'),
      ],
      expected: ['root', 'child', 'leaf'],
    },
  ])('$name', ({ rootId, sessions, expected }) => {
    expect([...getDeletedSessionTreeIds(rootId, sessions)]).toEqual(expected);
  });

  it('clears per-session state on permanent deletion', () => {
    const setup = createDeps({ activeSessionId: 'session-1', sessions: [session('session-1')] });

    clearDeletedSessionState(setup.deps, 'session-1');

    expect(setup.deps.clearPendingAbort).toHaveBeenCalledWith('session-1');
    expect(setup.deps.clearSelectedMcpsForSession).toHaveBeenCalledWith('session-1');
    expect(setup.deps.clearSessionSeen).toHaveBeenCalledWith('session-1');
    expect(setup.deps.clearActiveSessionState).toHaveBeenCalledTimes(1);
  });

  it('clears per-session state when hiding a deleted session tree', () => {
    const setup = createDeps({
      activeSessionId: 'root',
      sessions: [session('root'), session('child', '/repo', 1, 'root'), session('other')],
    });

    hideDeletedSessionTree(setup.deps, 'root', setup.current.sessions);

    expect(setup.current.sessions.map((item) => item.id)).toEqual(['other']);
    expect(setup.deps.clearPendingAbort).toHaveBeenCalledWith('root');
    expect(setup.deps.clearPendingAbort).toHaveBeenCalledWith('child');
    expect(setup.deps.clearSessionSeen).toHaveBeenCalledWith('root');
    expect(setup.deps.clearSessionSeen).toHaveBeenCalledWith('child');
  });

  it('upserts sessions inside the current workspace and marks the active one seen', () => {
    const setup = createDeps({
      activeSessionId: 'session-1',
      sessions: [session('session-2', '/repo', 1)],
    });

    upsertSession(setup.deps, session('session-1', '/repo', 3));

    expect(setup.current.sessions.map((item) => item.id)).toEqual(['session-1', 'session-2']);
    expect(setup.deps.markSessionSeen).toHaveBeenCalledWith('session-1', 3);
  });

  it('keeps newer session metadata when an older snapshot arrives later', () => {
    const newer = session('session-1', '/repo', 10);
    newer.title = 'Actual task title';
    const older = session('session-1', '/repo', 5);
    older.title = 'New Chat';
    const setup = createDeps({ sessions: [newer] });

    applySessions(setup.deps, [older]);

    expect(setup.current.sessions).toEqual([newer]);
  });

  it('keeps a title update from an older snapshot when the current title is a placeholder', () => {
    const existing = session('session-1', '/repo', 10);
    existing.title = 'New session - 2026-07-09T12:00:00.000Z';
    const olderWithTitle = session('session-1', '/repo', 5);
    olderWithTitle.title = 'Actual task title';
    const setup = createDeps({ sessions: [existing] });

    applySessions(setup.deps, [olderWithTitle]);

    expect(setup.current.sessions[0]?.title).toBe('Actual task title');
    expect(setup.current.sessions[0]?.time.updated).toBe(10);
  });

  it('normalizeProjectPath returns null for null, undefined, and empty string', () => {
    expect(normalizeProjectPath(null)).toBeNull();
    expect(normalizeProjectPath(undefined)).toBeNull();
    expect(normalizeProjectPath('')).toBeNull();
  });

  it('normalizeProjectPath returns an already-clean path as-is', () => {
    expect(normalizeProjectPath('/repo')).toBe('/repo');
    expect(normalizeProjectPath('/home/user/project')).toBe('/home/user/project');
  });

  it('isSessionInWorkspace returns false when session has null or empty directory', () => {
    const nullDirSession = session('s1', undefined as unknown as string);
    nullDirSession.directory = null as unknown as string;
    expect(isSessionInWorkspace(nullDirSession, '/repo')).toBe(false);

    const emptyDirSession = session('s2', '');
    expect(isSessionInWorkspace(emptyDirSession, '/repo')).toBe(false);
  });

  it('isSessionInWorkspace returns true when workspace is null (all sessions match)', () => {
    expect(isSessionInWorkspace(session('s1', '/any/path'), null)).toBe(true);
  });

  it('upsertSession filters out a session outside workspace that already exists in list', () => {
    const setup = createDeps({
      activeSessionId: null,
      sessions: [session('session-1', '/repo', 1), session('session-2', '/other', 2)],
      workspace: '/repo',
    });

    // session-2 is outside workspace and exists in the list — should be filtered out
    upsertSession(setup.deps, session('session-2', '/other', 3));

    expect(setup.current.sessions.map((item) => item.id)).toEqual(['session-1']);
  });

  it('upsertSession is a no-op for a session outside workspace that does not exist in list', () => {
    const setup = createDeps({
      activeSessionId: null,
      sessions: [session('session-1', '/repo', 1)],
      workspace: '/repo',
    });

    upsertSession(setup.deps, session('session-new', '/other', 3));

    expect(setup.current.sessions.map((item) => item.id)).toEqual(['session-1']);
  });

  it('removeDeletedSessionTree removes tree and clears state', () => {
    const setup = createDeps({
      activeSessionId: 'root',
      sessions: [session('root'), session('child', '/repo', 1, 'root'), session('other')],
    });

    const deletedIds = removeDeletedSessionTree(setup.deps, 'root', setup.current.sessions);

    expect(deletedIds).toEqual(new Set(['root', 'child']));
    expect(setup.current.sessions.map((item) => item.id)).toEqual(['other']);
    expect(setup.deps.clearPendingAbort).toHaveBeenCalledWith('root');
    expect(setup.deps.clearPendingAbort).toHaveBeenCalledWith('child');
    expect(setup.deps.clearActiveSessionState).toHaveBeenCalled();
  });

  it('getNextSessionIdAfterDeletion returns null for empty array', () => {
    expect(getNextSessionIdAfterDeletion([])).toBeNull();
  });

  it('getNextSessionIdAfterDeletion returns first session when only child sessions exist', () => {
    const sessions = [
      session('child-1', '/repo', 1, 'root'),
      session('child-2', '/repo', 2, 'root'),
    ];
    expect(getNextSessionIdAfterDeletion(sessions)).toBe('child-1');
  });

  it('sortSessions sorts by updated time descending', () => {
    const sessions = [
      session('old', '/repo', 1),
      session('newest', '/repo', 3),
      session('mid', '/repo', 2),
    ];

    const sorted = sortSessions(sessions);

    expect(sorted.map((s) => s.id)).toEqual(['newest', 'mid', 'old']);
  });

  it('sortSessions uses creation order within the same activity age', () => {
    const now = 10 * 60_000;
    const olderCreated = session('older-created', '/repo', now - 5_000);
    olderCreated.time.created = now - 50_000;
    const newerCreated = session('newer-created', '/repo', now - 20_000);
    newerCreated.time.created = now - 30_000;
    const previousMinute = session('previous-minute', '/repo', now - 70_000);
    previousMinute.time.created = now - 80_000;

    const sorted = sortSessions([olderCreated, previousMinute, newerCreated], now);

    expect(sorted.map((item) => item.id)).toEqual([
      'newer-created',
      'older-created',
      'previous-minute',
    ]);
  });

  it('applySessions does not call clearActiveSessionState when active session is in the list', () => {
    const setup = createDeps({
      activeSessionId: 'session-1',
      sessions: [session('session-1', '/repo', 1), session('session-2', '/repo', 2)],
      workspace: '/repo',
    });

    applySessions(setup.deps, setup.current.sessions);

    expect(setup.deps.clearActiveSessionState).not.toHaveBeenCalled();
  });

  it('creates bound lifecycle operations from shared state dependencies', () => {
    const resetTodoSync = vi.fn();
    const resetToolCallExpansionState = vi.fn();
    const clearPendingAbort = vi.fn();

    state.activeSessionId = 'session-2';
    state.sessions = [session('session-1', '/repo-a', 1), session('session-2', '/repo-b', 2)];

    const operations = new SessionLifecycleOperations({
      getCurrentWorkspacePath: () => '/repo-a',
      clearPendingAbort,
      clearPendingAbortTree: vi.fn(),
      resetTodoSync,
      resetToolCallExpansionState,
    });

    operations.applySessions(state.sessions);

    expect(setSessionsState).toHaveBeenCalledWith([session('session-1', '/repo-a', 1)]);
    expect(resetTodoSync).toHaveBeenCalledTimes(1);
    expect(resetToolCallExpansionState).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith('activeSessionId', null);
    expect(persistActiveSessionId).toHaveBeenCalledWith(null);
    expect(clearMessages).toHaveBeenCalledTimes(1);
    expect(stopLoading).toHaveBeenCalledTimes(1);

    state.activeSessionId = 'session-1';
    operations.clearDeletedSessionState('session-1');

    expect(clearPendingAbort).toHaveBeenCalledWith('session-1');
    expect(clearCurrentDocumentStateForSession).toHaveBeenCalledWith('session-1');
    expect(clearSelectedMcpsForSession).toHaveBeenCalledWith('session-1');
    expect(setSessionUsageLimit).toHaveBeenCalledWith('session-1', null);
    expect(setSessionFailed).toHaveBeenCalledWith('session-1', false);
  });
});
