import { appStore } from '../../lib/stores/app-store';
import { composerStore } from '../../lib/stores/composer-store';
import { permissionsStore } from '../../lib/stores/permissions-store';
import { routingStore } from '../../lib/stores/routing-store';
import { sessionStore } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import type { Session } from '../../types';

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
  clearActiveSessionState(): void;
  markSessionSeen(sessionId: string, updatedAt?: number): void;
};

type SessionLifecycleDependencies = {
  getCurrentWorkspacePath(): string | null;
  clearPendingAbort(sessionId: string | null | undefined): void;
  clearPendingAbortTree(sessionIds: string[]): void;
  resetTodoSync(): void;
  resetToolCallExpansionState(): void;
};

export class SessionLifecycleOperations {
  private readonly lifecycleDeps: LifecycleDependencies;

  constructor(private readonly deps: SessionLifecycleDependencies) {
    this.lifecycleDeps = {
      getState: () => ({
        activeSessionId: appStore.state.activeSessionId,
        sessions: appStore.state.sessions,
      }),
      getCurrentWorkspacePath: deps.getCurrentWorkspacePath,
      setSessions: sessionStore.setSessions,
      clearSessionStatusEntry: sessionStore.clearSessionStatusEntry,
      clearPendingAbort: deps.clearPendingAbort,
      clearPendingAbortTree: deps.clearPendingAbortTree,
      removePermissionModeForSession: permissionsStore.removePermissionModeForSession,
      clearCurrentDocumentStateForSession: composerStore.clearCurrentDocumentStateForSession,
      clearSelectedAgentForSession: routingStore.clearSelectedAgentForSession,
      clearSelectedMcpsForSession: routingStore.clearSelectedMcpsForSession,
      clearSkippedPlanSession: sessionStore.clearSkippedPlanSession,
      clearSelectedModelForSession: routingStore.clearSelectedModelForSession,
      clearSessionSeen: sessionStore.clearSessionSeen,
      setSessionUsageLimit: sessionStore.setSessionUsageLimit,
      setSessionFailed: sessionStore.setSessionFailed,
      filterQuestions: (predicate: (sessionId: string) => boolean) =>
        appStore.setState('questions', (items) =>
          items.filter((item) => predicate(item.sessionID))
        ),
      filterPermissions: (predicate: (sessionId: string) => boolean) =>
        appStore.setState('permissions', (items) =>
          items.filter((item) => predicate(item.sessionID))
        ),
      clearActiveSessionState: this.clearActiveSessionState,
      markSessionSeen: sessionStore.markSessionSeen,
    };
  }

  readonly clearActiveSessionState = () => {
    this.deps.resetTodoSync();
    this.deps.resetToolCallExpansionState();
    sessionStore.setActiveSessionId(null);
    sessionStore.persistActiveSessionId(null);
    sessionStore.clearMessages();
    uiStore.stopLoading();
  };

  readonly applySessions = (sessions: Session[]) => applySessions(this.lifecycleDeps, sessions);

  readonly clearDeletedSessionState = (id: string) =>
    clearDeletedSessionState(this.lifecycleDeps, id);

  readonly hideDeletedSessionTree = (id: string, sessions = appStore.state.sessions) =>
    hideDeletedSessionTree(this.lifecycleDeps, id, sessions);

  readonly removeDeletedSessionTree = (id: string, sessions = appStore.state.sessions) =>
    removeDeletedSessionTree(this.lifecycleDeps, id, sessions);

  readonly upsertSession = (session: Session) => upsertSession(this.lifecycleDeps, session);
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
  for (const deletedId of deletedIds) {
    clearDeletedSessionState(deps, deletedId);
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
