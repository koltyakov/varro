import { batch } from 'solid-js';
import { normalizeSessionTitle } from '../../../shared/session-title';
import { appStore } from '../../lib/stores/app-store';
import { composerStore } from '../../lib/stores/composer-store';
import { isSamePath } from '../../lib/path-display';
import { compareSessionsByActivity } from '../../lib/session-order';
import { collectSessionTreeIds } from '../../lib/session-tree-index';
import { permissionsStore } from '../../lib/stores/permissions-store';
import { routingStore } from '../../lib/stores/routing-store';
import { sessionStore } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import type { Session } from '../../types';

type LifecycleState = {
  activeSessionId: string | null;
  sessions: Session[];
  showSessionPicker: boolean;
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
        showSessionPicker: uiStore.showSessionPicker(),
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
    batch(() => {
      this.deps.resetTodoSync();
      this.deps.resetToolCallExpansionState();
      sessionStore.setActiveSessionId(null);
      sessionStore.persistActiveSessionId(null);
      sessionStore.clearMessages();
      uiStore.stopLoading();
    });
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
  const normalizedSessionDirectory = normalizeProjectPath(session.directory);
  if (!normalizedSessionDirectory) return false;
  return isSamePath(normalizedSessionDirectory, normalizedWorkspace);
}

export function sortSessions(sessions: Session[], now = Date.now()) {
  return [...sessions].toSorted((a, b) => compareSessionsByActivity(a, b, now));
}

function isPlaceholderSessionTitle(title: string | null | undefined) {
  const normalized = normalizeSessionTitle(title).toLowerCase();
  return !normalized || normalized === 'new chat';
}

function mergeFreshSession(existing: Session | undefined, incoming: Session) {
  if (!existing) return incoming;
  const existingUpdated = existing.time?.updated ?? 0;
  const incomingUpdated = incoming.time?.updated ?? 0;
  if (existingUpdated > incomingUpdated) {
    if (!isPlaceholderSessionTitle(incoming.title) && isPlaceholderSessionTitle(existing.title)) {
      return { ...existing, title: incoming.title };
    }
    return existing;
  }
  if (incomingUpdated > existingUpdated) return incoming;

  const merged = {
    ...existing,
    ...incoming,
    time: { ...existing.time, ...incoming.time },
  };
  if (!isPlaceholderSessionTitle(existing.title) && isPlaceholderSessionTitle(incoming.title)) {
    merged.title = existing.title;
  }
  return merged;
}

export function applySessions(deps: LifecycleDependencies, sessions: Session[]) {
  const existingById = new Map(deps.getState().sessions.map((session) => [session.id, session]));
  const nextSessions = sortSessions(
    sessions
      .filter((session) => isSessionInWorkspace(session, deps.getCurrentWorkspacePath()))
      .map((session) => mergeFreshSession(existingById.get(session.id), session))
  );
  batch(() => {
    deps.setSessions(nextSessions);

    const { activeSessionId } = deps.getState();
    if (activeSessionId && !nextSessions.some((session) => session.id === activeSessionId)) {
      deps.clearActiveSessionState();
    }
  });
}

export function clearDeletedSessionState(deps: LifecycleDependencies, id: string) {
  batch(() => {
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
  });
}

export function hideDeletedSessionTree(
  deps: LifecycleDependencies,
  id: string,
  sessions = deps.getState().sessions
) {
  const deletedIds = getDeletedSessionTreeIds(id, sessions);

  batch(() => {
    deps.setSessions(sessions.filter((session) => !deletedIds.has(session.id)));
    for (const deletedId of deletedIds) {
      clearDeletedSessionState(deps, deletedId);
    }
  });

  return deletedIds;
}

export function getDeletedSessionTreeIds(rootId: string, sessions: Session[]) {
  return new Set(collectSessionTreeIds(rootId, sessions));
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

  batch(() => {
    deps.setSessions(sessions.filter((session) => !deletedIds.has(session.id)));

    for (const deletedId of deletedIds) {
      clearDeletedSessionState(deps, deletedId);
    }
  });

  return deletedIds;
}

export function upsertSession(deps: LifecycleDependencies, session: Session) {
  const { activeSessionId, sessions, showSessionPicker } = deps.getState();
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

  if (session.id === activeSessionId && !showSessionPicker) {
    deps.markSessionSeen(session.id, session.time.updated);
  }
}
