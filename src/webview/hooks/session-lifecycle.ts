import {
  clearCurrentDocumentStateForSession,
  clearMessages,
  clearSelectedAgentForSession,
  clearSelectedMcpsForSession,
  clearSelectedModelForSession,
  clearSessionSeen,
  clearSkippedPlanSession,
  markSessionSeen,
  persistActiveSessionId,
  removePermissionModeForSession,
  setSessionFailed,
  setSessions,
  setSessionUsageLimit,
  setState,
  state,
  stopLoading,
} from '../lib/state';
import type { Session } from '../types';

type LifecycleState = {
  activeSessionId: string | null;
  sessions: Session[];
};

type LifecycleDependencies = {
  getState(): LifecycleState;
  getCurrentWorkspacePath(): string | null;
  setSessions(sessions: Session[]): void;
  clearSessionStatusEntry(sessionId: string): void;
  clearPendingAbort(sessionId: string | null | undefined): void;
  clearPendingAbortTree(sessionIds: string[]): void;
  removePermissionModeForSession(sessionId: string): void;
  clearCurrentDocumentStateForSession(sessionId: string): void;
  clearSelectedAgentForSession(sessionId: string): void;
  clearSelectedMcpsForSession(sessionId: string): void;
  clearSkippedPlanSession(sessionId: string): void;
  clearSelectedModelForSession(sessionId: string): void;
  clearSessionSeen(sessionId: string): void;
  setSessionUsageLimit(sessionId: string, notice: null): void;
  setSessionFailed(sessionId: string, failed: boolean): void;
  filterQuestions(predicate: (sessionId: string) => boolean): void;
  filterPermissions(predicate: (sessionId: string) => boolean): void;
  filterPendingAttentionSessionIds(predicate: (sessionId: string) => boolean): void;
  clearActiveSessionState(): void;
  markSessionSeen(sessionId: string, updatedAt?: number): void;
};

export function createSessionLifecycleOperations(deps: {
  getCurrentWorkspacePath(): string | null;
  clearPendingAbort(sessionId: string | null | undefined): void;
  clearPendingAbortTree(sessionIds: string[]): void;
  resetTodoSync(): void;
  resetToolCallExpansionState(): void;
}) {
  const clearActiveSessionState = () => {
    deps.resetTodoSync();
    deps.resetToolCallExpansionState();
    setState('activeSessionId', null);
    persistActiveSessionId(null);
    clearMessages();
    stopLoading();
  };

  const lifecycleDeps: LifecycleDependencies = {
    getState: () => ({ activeSessionId: state.activeSessionId, sessions: state.sessions }),
    getCurrentWorkspacePath: deps.getCurrentWorkspacePath,
    setSessions,
    clearSessionStatusEntry: (sessionId: string) => {
      setState('sessionStatus', (statuses) => {
        const next = { ...statuses };
        delete next[sessionId];
        return next;
      });
    },
    clearPendingAbort: deps.clearPendingAbort,
    clearPendingAbortTree: deps.clearPendingAbortTree,
    removePermissionModeForSession,
    clearCurrentDocumentStateForSession,
    clearSelectedAgentForSession,
    clearSelectedMcpsForSession,
    clearSkippedPlanSession,
    clearSelectedModelForSession,
    clearSessionSeen,
    setSessionUsageLimit,
    setSessionFailed,
    filterQuestions: (predicate: (sessionId: string) => boolean) =>
      setState('questions', (items) => items.filter((item) => predicate(item.sessionID))),
    filterPermissions: (predicate: (sessionId: string) => boolean) =>
      setState('permissions', (items) => items.filter((item) => predicate(item.sessionID))),
    filterPendingAttentionSessionIds: (predicate: (sessionId: string) => boolean) =>
      setState('pendingAttentionSessionIds', (items) =>
        items.filter((sessionId) => predicate(sessionId))
      ),
    clearActiveSessionState,
    markSessionSeen,
  };

  return {
    clearActiveSessionState,
    applySessions: (sessions: Session[]) => applySessions(lifecycleDeps, sessions),
    clearDeletedSessionState: (id: string) => clearDeletedSessionState(lifecycleDeps, id),
    hideDeletedSessionTree: (id: string, sessions = state.sessions) =>
      hideDeletedSessionTree(lifecycleDeps, id, sessions),
    removeDeletedSessionTree: (id: string, sessions = state.sessions) =>
      removeDeletedSessionTree(lifecycleDeps, id, sessions),
    upsertSession: (session: Session) => upsertSession(lifecycleDeps, session),
  };
}

export function normalizeProjectPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedPath || null;
}

export function isSessionInWorkspace(
  session: Session,
  workspacePath: string | null | undefined
): boolean {
  const normalizedWorkspace = normalizeProjectPath(workspacePath);
  if (!normalizedWorkspace) return true;
  return normalizeProjectPath(session.directory) === normalizedWorkspace;
}

export function sortSessions(sessions: Session[]) {
  return [...sessions].toSorted((a, b) => b.time.updated - a.time.updated);
}

export function applySessions(deps: LifecycleDependencies, sessions: Session[]) {
  const nextSessions = sortSessions(
    sessions.filter((session) => isSessionInWorkspace(session, deps.getCurrentWorkspacePath()))
  );
  deps.setSessions(nextSessions);

  if (
    deps.getState().activeSessionId &&
    !nextSessions.some((session) => session.id === deps.getState().activeSessionId)
  ) {
    deps.clearActiveSessionState();
  }
}

export function clearDeletedSessionState(deps: LifecycleDependencies, id: string) {
  deps.clearPendingAbort(id);
  deps.removePermissionModeForSession(id);
  deps.clearCurrentDocumentStateForSession(id);
  deps.clearSelectedAgentForSession(id);
  deps.clearSelectedMcpsForSession(id);
  deps.clearSkippedPlanSession(id);
  deps.clearSelectedModelForSession(id);
  deps.clearSessionSeen(id);
  deps.clearSessionStatusEntry(id);
  deps.setSessionUsageLimit(id, null);
  deps.setSessionFailed(id, false);
  deps.filterQuestions((sessionId) => sessionId !== id);
  deps.filterPermissions((sessionId) => sessionId !== id);
  deps.filterPendingAttentionSessionIds((sessionId) => sessionId !== id);

  if (deps.getState().activeSessionId === id) {
    deps.clearActiveSessionState();
  }
}

export function hideDeletedSessionTree(
  deps: LifecycleDependencies,
  id: string,
  sessions = deps.getState().sessions
) {
  const deletedIds = getDeletedSessionTreeIds(id, sessions);

  deps.setSessions(sessions.filter((session) => !deletedIds.has(session.id)));
  deps.clearPendingAbortTree([...deletedIds]);
  deps.filterQuestions((sessionId) => !deletedIds.has(sessionId));
  deps.filterPermissions((sessionId) => !deletedIds.has(sessionId));
  deps.filterPendingAttentionSessionIds((sessionId) => !deletedIds.has(sessionId));

  const activeSessionId = deps.getState().activeSessionId;
  if (activeSessionId && deletedIds.has(activeSessionId)) {
    deps.clearActiveSessionState();
  }

  return deletedIds;
}

export function getDeletedSessionTreeIds(rootId: string, sessions: Session[]) {
  const deleted = new Set<string>();
  const pending = [rootId];

  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId || deleted.has(currentId)) continue;
    deleted.add(currentId);

    for (const session of sessions) {
      if (session.parentID === currentId) {
        pending.push(session.id);
      }
    }
  }

  return deleted;
}

export function getNextSessionIdAfterDeletion(sessions: Session[]) {
  return sessions.find((session) => !session.parentID)?.id || sessions[0]?.id || null;
}

export function removeDeletedSessionTree(
  deps: LifecycleDependencies,
  id: string,
  sessions = deps.getState().sessions
) {
  const deletedIds = getDeletedSessionTreeIds(id, sessions);

  deps.setSessions(sessions.filter((session) => !deletedIds.has(session.id)));

  for (const deletedId of deletedIds) {
    clearDeletedSessionState(deps, deletedId);
  }

  return deletedIds;
}

export function upsertSession(deps: LifecycleDependencies, session: Session) {
  const { activeSessionId, sessions } = deps.getState();
  if (!isSessionInWorkspace(session, deps.getCurrentWorkspacePath())) {
    if (sessions.some((item) => item.id === session.id)) {
      applySessions(
        deps,
        sessions.filter((item) => item.id !== session.id)
      );
    }
    return;
  }

  applySessions(deps, [session, ...sessions.filter((item) => item.id !== session.id)]);

  if (session.id === activeSessionId) {
    deps.markSessionSeen(session.id, session.time.updated);
  }
}
