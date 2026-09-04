import { batch } from 'solid-js';
import { produce, reconcile } from 'solid-js/store';
import type { Message, MessageEntry, Session, SessionStatus } from '../types';
import type { RecycleBinEntry, WorkspaceStatusEventSummary } from '../../shared/protocol';
import type { WorkspaceStatusEntry } from '../../shared/opencode-types';
import { isAbortedAssistantError } from '../../shared/error-classification';
import { getRelativePathWithinWorkspace, isSameWorkspacePath } from '../../shared/workspace-path';
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
import { postMessage } from './bridge';
import { clearQuestionResponsePending } from './state-permissions';
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
  readMergedSessionMarkerState,
  readScopedSessionMarkerState,
  removeSessionMarker,
  writeScopedSessionMarkerState,
} from './state-session-markers';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';

const EMPTY_SESSION_TREE_IDS: string[] = [];
const markerStorage = { readStored, writeStored };
const restoredMarkerDirectories = new Map<string, string>();

function restoreCatalogSessionMarkers(sessions: readonly Session[]) {
  const unrestored = sessions.filter(
    (session) => restoredMarkerDirectories.get(session.id) !== session.directory
  );
  if (unrestored.length === 0) return;
  for (const field of [
    'lastSeenSessions',
    'skippedPlanSessions',
    'completedSessionResponses',
  ] as const) {
    const stored = readMergedSessionMarkerState(markerStorage, STORAGE_KEYS[field], [], unrestored);
    batch(() => {
      for (const [sessionId, timestamp] of Object.entries(stored)) {
        const current = state[field][sessionId];
        if (current === undefined || timestamp > current) setState(field, sessionId, timestamp);
      }
    });
  }
  for (const session of unrestored) restoredMarkerDirectories.set(session.id, session.directory);
}

function writeMarkerForSession(key: string, sessionId: string, timestamp: number | undefined) {
  const directory = state.sessions.find((session) => session.id === sessionId)?.directory;
  const scope = directory
    ? getSessionMarkerWorkspaceScope(directory)
    : getSessionMarkerWorkspaceScopeValue();
  const markers = { ...readScopedSessionMarkerState(markerStorage, key, scope) };
  if (timestamp === undefined) delete markers[sessionId];
  else markers[sessionId] = timestamp;
  writeScopedSessionMarkerState(markerStorage, key, scope, markers);
}

function writeOpenWorkspaceMarkerState(key: string, markers: Record<string, number>) {
  for (const folder of state.editorContext.workspaceFolders ?? []) {
    const sessionIds = new Set(
      state.sessions
        .filter((session) => isSameWorkspacePath(session.directory, folder.path))
        .map((session) => session.id)
    );
    writeScopedSessionMarkerState(
      markerStorage,
      key,
      getSessionMarkerWorkspaceScope(folder.path),
      Object.fromEntries(Object.entries(markers).filter(([sessionId]) => sessionIds.has(sessionId)))
    );
  }
}

export function consumeInterruptedSessionIds() {
  const ids = [...state.interruptedSessionIds];
  setState('interruptedSessionIds', []);
  return ids;
}

export function markSessionSeen(id: string, updatedAt?: number) {
  const nextSessions = nextSeenSessions(state.lastSeenSessions, id, updatedAt);
  if (!nextSessions) return false;
  setState('lastSeenSessions', id, nextSessions[id]!);
  writeMarkerForSession(STORAGE_KEYS.lastSeenSessions, id, nextSessions[id]);
  postMessage({ type: 'session/seen', payload: { sessionId: id } });
  return true;
}

export function markSessionResponseCompleted(id: string, completedAt?: number) {
  const nextSessions = nextCompletedSessionResponses(
    state.completedSessionResponses,
    id,
    completedAt
  );
  if (!nextSessions) return;
  setState('completedSessionResponses', id, nextSessions[id]!);
  writeMarkerForSession(STORAGE_KEYS.completedSessionResponses, id, nextSessions[id]);
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
  writeMarkerForSession(STORAGE_KEYS.lastSeenSessions, id, undefined);
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
  writeMarkerForSession(STORAGE_KEYS.skippedPlanSessions, sessionId, next[sessionId]);
  postMessage({
    type: 'session-plan-state/update',
    payload: { sessionId, skippedAt: next[sessionId]! },
  });
}

export function clearSkippedPlanSession(sessionId: string) {
  postMessage({
    type: 'session-plan-state/update',
    payload: { sessionId, skippedAt: null },
  });
  const nextSessions = removeSessionMarker(state.skippedPlanSessions, sessionId);
  if (!nextSessions) return;
  setState(
    'skippedPlanSessions',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
  writeMarkerForSession(STORAGE_KEYS.skippedPlanSessions, sessionId, undefined);
}

export function applySessionPlanStateUpdate(sessionId: string, skippedAt: number | null) {
  const nextSessions = { ...state.skippedPlanSessions };
  if (skippedAt === null) delete nextSessions[sessionId];
  else nextSessions[sessionId] = skippedAt;
  setState('skippedPlanSessions', reconcile(nextSessions));
  writeMarkerForSession(STORAGE_KEYS.skippedPlanSessions, sessionId, nextSessions[sessionId]);
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
  const sessionIds = new Set([rootId, sessionId, ...getSessionTreeIds(rootId)]);
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
  sessionTreeIndex.invalidate();
  setState('sessions', reconcile(nextSessions, { key: 'id' }));
  restoreCatalogSessionMarkers(nextSessions);
  const sessionIds = new Set(nextSessions.map((session) => session.id));
  for (const sessionId of restoredMarkerDirectories.keys()) {
    if (!sessionIds.has(sessionId)) restoredMarkerDirectories.delete(sessionId);
  }
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
    writeOpenWorkspaceMarkerState(STORAGE_KEYS.skippedPlanSessions, nextMarkers);
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
    writeOpenWorkspaceMarkerState(STORAGE_KEYS.completedSessionResponses, nextCompletedMarkers);
  }
}

export function syncSessionMarkersForWorkspace(
  workspacePath: string | null | undefined,
  workspacePaths: readonly string[] = []
) {
  const scope = getSessionMarkerWorkspaceScope(workspacePath);
  const scopes = (workspacePaths.length > 0 ? workspacePaths : [workspacePath]).map((path) =>
    getSessionMarkerWorkspaceScope(path)
  );
  restoredMarkerDirectories.clear();
  setSessionMarkerWorkspaceScopeValue(scope);
  setState(
    'lastSeenSessions',
    reconcile(readMergedSessionMarkerState(markerStorage, STORAGE_KEYS.lastSeenSessions, scopes))
  );
  setState(
    'skippedPlanSessions',
    reconcile(readMergedSessionMarkerState(markerStorage, STORAGE_KEYS.skippedPlanSessions, scopes))
  );
  setState(
    'completedSessionResponses',
    reconcile(
      readMergedSessionMarkerState(markerStorage, STORAGE_KEYS.completedSessionResponses, scopes)
    )
  );
  restoreCatalogSessionMarkers(
    state.sessions.filter((session) =>
      scopes.some((root) => getRelativePathWithinWorkspace(session.directory, root) !== null)
    )
  );
}

export function setRecycleBinEntries(entries: RecycleBinEntry[]) {
  setState('recycleBinEntries', entries);
}

export function setSessionFailed(sessionId: string, failed: boolean) {
  const wasFailed = state.failedSessionIds.includes(sessionId);
  if (failed && !wasFailed) {
    setState('failedSessionUpdatedAt', sessionId, Date.now());
  } else if (!failed && state.failedSessionUpdatedAt[sessionId] !== undefined) {
    setState(
      'failedSessionUpdatedAt',
      produce((updatedAt) => {
        delete updatedAt[sessionId];
      })
    );
  }

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
  if (failed) clearQuestionResponsePending(sessionId);
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

export function getSessionTreeUpdated(sessionId: string | null | undefined) {
  return sessionTreeIndex.getTreeUpdated(sessionId, state.sessions, state.sessionUsageLimits);
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
  const failedSessionUpdatedAt = { ...state.failedSessionUpdatedAt };

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
    const previousFailedAt = failedSessionUpdatedAt[sessionId] ?? 0;
    const failedAt = info.time.completed ?? (previousFailedAt || Date.now());
    failedSessionUpdatedAt[sessionId] = Math.max(previousFailedAt, failedAt);
  }

  for (const sessionId of scopedSessionIds) {
    if (!failedSessionIds.has(sessionId)) delete failedSessionUpdatedAt[sessionId];
  }

  setState('failedSessionUpdatedAt', reconcile(failedSessionUpdatedAt));
  setState('failedSessionIds', [
    ...state.failedSessionIds.filter((sessionId) => !scopedSessionIds.has(sessionId)),
    ...failedSessionIds,
  ]);
}
