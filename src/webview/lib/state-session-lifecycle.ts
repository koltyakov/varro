import { produce, reconcile } from 'solid-js/store';
import type { Message, MessageEntry, Session, SessionStatus } from '../types';
import type { RecycleBinEntry, WorkspaceStatusEventSummary } from '../../shared/protocol';
import type { WorkspaceStatusEntry } from '../../shared/opencode-types';
import { isAbortedAssistantError } from '../../shared/error-classification';
import type { UsageLimitNotice } from './usage-limit';
import {
  getSessionMarkerWorkspaceScopeValue,
  isLoading,
  sessionTreeIndex,
  sessionUsageLimitVersion,
  setSessionMarkerWorkspaceScopeValue,
  setSessionUsageLimitVersion,
  setState,
  state,
} from './app-state';
import { collectSessionTreeIds } from './session-tree-index';
import {
  getSessionMarkerWorkspaceScope,
  isSessionCompletedResponseUnreadMarker,
  isSessionUnreadMarker,
  isSkippedPlanSessionMarker,
  nextCompletedSessionResponses,
  nextSeenSessions,
  nextSkippedPlanSessions,
  pruneSessionMarkers,
  pruneSkippedPlanSessions,
  readScopedSessionMarkerState,
  removeSessionMarker,
  writeScopedSessionMarkerState,
} from './state-session-markers';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';

const EMPTY_SESSION_TREE_IDS: string[] = [];

export function consumeInterruptedSessionIds() {
  const ids = [...state.interruptedSessionIds];
  setState('interruptedSessionIds', []);
  return ids;
}

export function markSessionSeen(id: string, updatedAt?: number) {
  const nextSessions = nextSeenSessions(state.lastSeenSessions, id, updatedAt);
  if (!nextSessions) return;
  setState('lastSeenSessions', id, nextSessions[id]!);
  writeScopedSessionMarkerState(
    { readStored, writeStored },
    STORAGE_KEYS.lastSeenSessions,
    getSessionMarkerWorkspaceScopeValue(),
    nextSessions
  );
}

export function markSessionResponseCompleted(id: string, completedAt?: number) {
  const nextSessions = nextCompletedSessionResponses(
    state.completedSessionResponses,
    id,
    completedAt
  );
  if (!nextSessions) return;
  setState('completedSessionResponses', id, nextSessions[id]!);
  writeScopedSessionMarkerState(
    { readStored, writeStored },
    STORAGE_KEYS.completedSessionResponses,
    getSessionMarkerWorkspaceScopeValue(),
    nextSessions
  );
}

export function clearSessionSeen(id: string) {
  const nextSessions = removeSessionMarker(state.lastSeenSessions, id);
  if (!nextSessions) return;
  setState(
    'lastSeenSessions',
    produce((draft) => {
      delete draft[id];
    })
  );
  writeScopedSessionMarkerState(
    { readStored, writeStored },
    STORAGE_KEYS.lastSeenSessions,
    getSessionMarkerWorkspaceScopeValue(),
    nextSessions
  );
}

export function skipPlanSession(sessionId: string, updatedAt?: number) {
  const next = nextSkippedPlanSessions(
    state.skippedPlanSessions,
    state.sessions,
    sessionId,
    updatedAt
  );
  if (!next) return;
  setState('skippedPlanSessions', sessionId, next[sessionId]!);
  writeScopedSessionMarkerState(
    { readStored, writeStored },
    STORAGE_KEYS.skippedPlanSessions,
    getSessionMarkerWorkspaceScopeValue(),
    next
  );
}

export function clearSkippedPlanSession(sessionId: string) {
  const nextSessions = removeSessionMarker(state.skippedPlanSessions, sessionId);
  if (!nextSessions) return;
  setState(
    'skippedPlanSessions',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
  writeScopedSessionMarkerState(
    { readStored, writeStored },
    STORAGE_KEYS.skippedPlanSessions,
    getSessionMarkerWorkspaceScopeValue(),
    nextSessions
  );
}

export function isSkippedPlanSession(sessionId: string, updatedAt: number) {
  return isSkippedPlanSessionMarker(state.skippedPlanSessions, sessionId, updatedAt);
}

export function isSessionUnread(sessionId: string, updatedAt: number) {
  return isSessionUnreadMarker(state.lastSeenSessions, sessionId, updatedAt);
}

export function isSessionCompletedResponseUnread(sessionId: string) {
  return isSessionCompletedResponseUnreadMarker(
    state.completedSessionResponses,
    state.lastSeenSessions,
    sessionId
  );
}

export function setSessionCompacting(sessionId: string, compacting: boolean) {
  setState(
    'compactingSessionIds',
    produce((ids) => {
      const idx = ids.indexOf(sessionId);
      if (compacting) {
        if (idx === -1) ids.push(sessionId);
        return;
      }
      if (idx !== -1) ids.splice(idx, 1);
    })
  );
}

export function isSessionCompacting() {
  const sid = state.activeSessionId;
  if (!sid) return false;
  if (state.compactingSessionIds.includes(sid)) return true;
  return !!state.sessions.find((session) => session.id === sid)?.time.compacting;
}

export function isSessionStatusWorking(status: SessionStatus | null | undefined) {
  return status?.type === 'busy' || status?.type === 'retry';
}

export function isSessionTreeStatusWorking(
  sessionId: string | null | undefined,
  statuses: Record<string, SessionStatus | undefined> = state.sessionStatus
) {
  if (!sessionId) return false;

  const rootId = getSessionTreeRootId(sessionId) || sessionId;
  const sessionIds = new Set(getSessionTreeIds(rootId));
  return [...sessionIds].some((candidateSessionId) =>
    isSessionStatusWorking(statuses[candidateSessionId])
  );
}

export function isActiveSessionWorking() {
  return isLoading() || isSessionCompacting() || isSessionTreeStatusWorking(state.activeSessionId);
}

export function hasActiveQuestion() {
  const sid = state.activeSessionId;
  if (!sid) return false;
  const rootId = getSessionTreeRootId(sid) || sid;
  const sessionIds = new Set(getSessionTreeIds(rootId));
  return state.questions.some((question) => sessionIds.has(question.sessionID));
}

export function hasActivePermission() {
  const sid = state.activeSessionId;
  if (!sid) return false;
  const rootId = getSessionTreeRootId(sid) || sid;
  const sessionIds = new Set(getSessionTreeIds(rootId));
  return state.permissions.some((permission) => sessionIds.has(permission.sessionID));
}

export function isSessionAwaitingInput(sessionId: string) {
  const rootId = getSessionTreeRootId(sessionId) || sessionId;
  const sessionIds = new Set(getSessionTreeIds(rootId));
  return [
    ...state.permissions.map((permission) => permission.sessionID),
    ...state.questions.map((question) => question.sessionID),
  ].some((candidateSessionId) => sessionIds.has(candidateSessionId));
}

export function setWorkspaceStatuses(entries: WorkspaceStatusEntry[]) {
  setState('workspaceStatuses', entries);
}

export function setWorkspaceStatusSummary(summary: WorkspaceStatusEventSummary) {
  setState('workspaceStatusSummary', summary);
}

export function setSessions(nextSessions: Session[]) {
  setState('sessions', reconcile(nextSessions, { key: 'id' }));
  const sessionIds = new Set(nextSessions.map((session) => session.id));
  const nextMarkers = pruneSkippedPlanSessions(state.skippedPlanSessions, sessionIds);
  if (nextMarkers) {
    setState(
      'skippedPlanSessions',
      produce((draft) => {
        for (const id of Object.keys(draft)) {
          if (!sessionIds.has(id)) delete draft[id];
        }
      })
    );
    writeScopedSessionMarkerState(
      { readStored, writeStored },
      STORAGE_KEYS.skippedPlanSessions,
      getSessionMarkerWorkspaceScopeValue(),
      nextMarkers
    );
  }
  const nextCompletedMarkers = pruneSessionMarkers(state.completedSessionResponses, sessionIds);
  if (nextCompletedMarkers) {
    setState(
      'completedSessionResponses',
      produce((draft) => {
        for (const id of Object.keys(draft)) {
          if (!sessionIds.has(id)) delete draft[id];
        }
      })
    );
    writeScopedSessionMarkerState(
      { readStored, writeStored },
      STORAGE_KEYS.completedSessionResponses,
      getSessionMarkerWorkspaceScopeValue(),
      nextCompletedMarkers
    );
  }
  sessionTreeIndex.invalidate();
}

export function syncSessionMarkersForWorkspace(workspacePath: string | null | undefined) {
  const scope = getSessionMarkerWorkspaceScope(workspacePath);
  setSessionMarkerWorkspaceScopeValue(scope);
  setState(
    'lastSeenSessions',
    reconcile(
      readScopedSessionMarkerState(
        { readStored, writeStored },
        STORAGE_KEYS.lastSeenSessions,
        scope
      )
    )
  );
  setState(
    'skippedPlanSessions',
    reconcile(
      readScopedSessionMarkerState(
        { readStored, writeStored },
        STORAGE_KEYS.skippedPlanSessions,
        scope
      )
    )
  );
  setState(
    'completedSessionResponses',
    reconcile(
      readScopedSessionMarkerState(
        { readStored, writeStored },
        STORAGE_KEYS.completedSessionResponses,
        scope
      )
    )
  );
}

export function setRecycleBinEntries(entries: RecycleBinEntry[]) {
  setState('recycleBinEntries', entries);
}

export function setSessionFailed(sessionId: string, failed: boolean) {
  setState(
    'failedSessionIds',
    produce((ids) => {
      const idx = ids.indexOf(sessionId);
      if (failed) {
        if (idx === -1) ids.push(sessionId);
        return;
      }
      if (idx !== -1) ids.splice(idx, 1);
    })
  );
}

export function setSessionUsageLimit(sessionId: string, notice: UsageLimitNotice | null) {
  if (!sessionId) return;

  if (notice === null) {
    if (state.sessionUsageLimits[sessionId] === undefined) return;
    const nextLimits = { ...state.sessionUsageLimits };
    delete nextLimits[sessionId];
    sessionTreeIndex.invalidate();
    setState('sessionUsageLimits', reconcile(nextLimits));
    setSessionUsageLimitVersion((value) => value + 1);
    return;
  }

  sessionTreeIndex.invalidate();
  setState('sessionUsageLimits', {
    ...state.sessionUsageLimits,
    [sessionId]: notice,
  });
  setSessionUsageLimitVersion((value) => value + 1);
}

export function getSessionTreeIds(rootId: string | null | undefined, sessions = state.sessions) {
  if (!rootId) return EMPTY_SESSION_TREE_IDS;
  if (sessions === state.sessions) {
    return sessionTreeIndex.getTreeIds(rootId, state.sessions, state.sessionUsageLimits);
  }
  return collectSessionTreeIds(rootId, sessions);
}

export function getSessionTreeRootId(sessionId: string | null | undefined) {
  return sessionTreeIndex.getRootId(sessionId, state.sessions, state.sessionUsageLimits);
}

export function getActiveUsageLimitNotice(sessionId: string | null | undefined) {
  sessionUsageLimitVersion();
  return sessionTreeIndex.getActiveUsageLimitNotice(
    sessionId,
    state.sessions,
    state.sessionUsageLimits
  );
}

export function hasActiveUsageLimit(sessionId: string | null | undefined) {
  return !!getActiveUsageLimitNotice(sessionId);
}

export function syncFailedSessionsFromMessages(messages: MessageEntry[] = state.messages) {
  const failedSessionIds = new Set<string>();
  const scopedSessionIds = new Set<string>();

  const latestBySession = new Map<string, Message>();
  for (const entry of messages) {
    scopedSessionIds.add(entry.info.sessionID);
    latestBySession.set(entry.info.sessionID, entry.info);
  }

  for (const [sessionId, info] of latestBySession) {
    if (info.role !== 'assistant' || !info.error) continue;
    if (isAbortedAssistantError(info.error)) continue;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) continue;
    failedSessionIds.add(sessionId);
  }

  setState('failedSessionIds', [
    ...state.failedSessionIds.filter((sessionId) => !scopedSessionIds.has(sessionId)),
    ...failedSessionIds,
  ]);
}
