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
  createSessionLifecycleOperations,
  getDeletedSessionTreeIds,
  getNextSessionIdAfterDeletion,
  normalizeProjectPath,
  upsertSession,
} from './session-lifecycle';

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

  it('clears per-session state on permanent deletion', () => {
    const setup = createDeps({ activeSessionId: 'session-1', sessions: [session('session-1')] });

    clearDeletedSessionState(setup.deps, 'session-1');

    expect(setup.deps.clearPendingAbort).toHaveBeenCalledWith('session-1');
    expect(setup.deps.clearSelectedMcpsForSession).toHaveBeenCalledWith('session-1');
    expect(setup.deps.clearSessionSeen).toHaveBeenCalledWith('session-1');
    expect(setup.deps.clearActiveSessionState).toHaveBeenCalledTimes(1);
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

  it('creates bound lifecycle operations from shared state dependencies', () => {
    const resetTodoSync = vi.fn();
    const resetToolCallExpansionState = vi.fn();
    const clearPendingAbort = vi.fn();

    state.activeSessionId = 'session-2';
    state.sessions = [session('session-1', '/repo-a', 1), session('session-2', '/repo-b', 2)];

    const operations = createSessionLifecycleOperations({
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
