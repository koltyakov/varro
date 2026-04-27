import { describe, expect, it, vi } from 'vitest';
import type { Session, SessionStatus } from '../types';
import {
  applySessions,
  clearDeletedSessionState,
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
});
