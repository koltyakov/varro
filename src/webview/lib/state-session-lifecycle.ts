import { storePath } from '@solidjs/signals';

import { reconcile } from 'solid-js';
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
  nextSessionMarkerTimestamp,
  pruneSessionMarkers,
  readMergedSessionMarkerState,
  updateScopedSessionMarker,
  writeScopedSessionMarkerState,
} from './state-session-markers';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';
import { isNumber } from './runtime-values';
import { readInitialWebviewState } from './state-stored-values';

const EMPTY_SESSION_TREE_IDS: string[] = [];
const markerStorage = { readStored, writeStored };
const restoredMarkerDirectories = new Map<string, string>();
const CATALOG_MARKER_FIELDS = [
  'lastSeenSessions',
  'skippedPlanSessions',
  'completedSessionResponses',
  'interruptedSessionResponses',
] as const;

type MarkerSession = Pick<Session, 'id' | 'directory'>;

function restoreCatalogSessionMarkers(sessions: readonly MarkerSession[]) {
  const unrestored = sessions.filter(
    (session) => restoredMarkerDirectories.get(session.id) !== session.directory
  );
  if (unrestored.length === 0) return;
  for (const field of CATALOG_MARKER_FIELDS) {
    const stored = readMergedSessionMarkerState(markerStorage, STORAGE_KEYS[field], [], unrestored);
    setState((draft) => {
      for (const [sessionId, timestamp] of Object.entries(stored)) {
        const current = draft[field][sessionId];
        if (current === undefined || timestamp > current) draft[field][sessionId] = timestamp;
      }
    });
  }
  for (const session of unrestored) restoredMarkerDirectories.set(session.id, session.directory);
  const shared = readInitialWebviewState().sessionReadState ?? {};
  const updates: { sessionId: string; seenAt: number }[] = [];
  setState((draft) => {
    for (const session of unrestored) {
      const sharedSeenAt = shared[session.id];
      const localSeenAt = draft.lastSeenSessions[session.id];
      if (sharedSeenAt !== undefined && (localSeenAt === undefined || sharedSeenAt > localSeenAt)) {
        draft.lastSeenSessions[session.id] = sharedSeenAt;
        writeMarkerForSession(
          STORAGE_KEYS.lastSeenSessions,
          session.id,
          sharedSeenAt,
          session.directory
        );
      } else if (
        localSeenAt !== undefined &&
        (sharedSeenAt === undefined || localSeenAt > sharedSeenAt)
      ) {
        updates.push({ sessionId: session.id, seenAt: localSeenAt });
      }
    }
  });
  for (const payload of updates) {
    postMessage({ type: 'session-read-state/update', payload });
  }
}

function writeMarkerForSession(
  key: string,
  sessionId: string,
  timestamp: number | undefined,
  directory: string | undefined
) {
  const scope = directory
    ? getSessionMarkerWorkspaceScope(directory)
    : getSessionMarkerWorkspaceScopeValue();
  updateScopedSessionMarker(markerStorage, key, scope, sessionId, timestamp);
}

function writeOpenWorkspaceMarkerState(
  key: string,
  markers: Record<string, number>,
  sessions: readonly Session[],
  folders: readonly { path: string }[]
) {
  for (const folder of folders) {
    const sessionIds = new Set(
      sessions
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
  setState(storePath('interruptedSessionIds', []));
  return ids;
}

export function markSessionSeen(id: string, updatedAt?: number) {
  // Opening a session acknowledges its known markers even when the server clock is ahead.
  // Explicit message timestamps acknowledge only that message, not newer activity.
  let seenAt: number | undefined;
  setState((draft) => {
    const previous = draft.lastSeenSessions[id];
    if (updatedAt !== undefined && previous !== undefined && previous >= updatedAt) return;
    const session = draft.sessions.find((item) => item.id === id);
    const timestamp = nextSessionMarkerTimestamp(
      previous,
      updatedAt ??
        Math.max(
          Date.now(),
          session?.time.updated ?? 0,
          draft.completedSessionResponses[id] ?? 0,
          ...sessionTreeIndex
            .getTreeIds(id, draft.sessions, draft.sessionUsageLimits)
            .map((sessionId) => draft.interruptedSessionResponses[sessionId] ?? 0)
        )
    );
    if (timestamp === null) return;
    seenAt = timestamp;
    draft.lastSeenSessions[id] = timestamp;
    writeMarkerForSession(STORAGE_KEYS.lastSeenSessions, id, timestamp, session?.directory);
  });
  if (seenAt === undefined) return false;
  postMessage({ type: 'session-read-state/update', payload: { sessionId: id, seenAt } });
  return true;
}

export function markSessionResponseCompleted(id: string, completedAt?: number) {
  advanceResponseMarker('completedSessionResponses', id, completedAt);
}

export function markSessionResponseInterrupted(id: string, interruptedAt?: number) {
  advanceResponseMarker('interruptedSessionResponses', id, interruptedAt);
}

function advanceResponseMarker(
  field: 'completedSessionResponses' | 'interruptedSessionResponses',
  id: string,
  updatedAt?: number
) {
  setState((draft) => {
    const timestamp = nextSessionMarkerTimestamp(draft[field][id], updatedAt);
    if (timestamp === null) return;
    draft[field][id] = timestamp;
    writeMarkerForSession(
      STORAGE_KEYS[field],
      id,
      timestamp,
      draft.sessions.find((item) => item.id === id)?.directory
    );
  });
}

export function isSessionInterruptedResponseUnread(sessionId: string) {
  const interruptedAt = state.interruptedSessionResponses[sessionId];
  if (interruptedAt === undefined) return false;
  const rootId = getSessionTreeRootId(sessionId) || sessionId;
  const seenAt = Math.max(
    state.lastSeenSessions[sessionId] ?? 0,
    state.lastSeenSessions[rootId] ?? 0
  );
  return (
    interruptedAt > seenAt && interruptedAt > (state.completedSessionResponses[sessionId] ?? 0)
  );
}

export function clearSessionSeen(id: string) {
  clearSessionMarker('lastSeenSessions', id);
}

function clearSessionMarker(field: 'lastSeenSessions' | 'skippedPlanSessions', id: string) {
  setState((draft) => {
    if (!(id in draft[field])) return;
    delete draft[field][id];
    writeMarkerForSession(
      STORAGE_KEYS[field],
      id,
      undefined,
      draft.sessions.find((item) => item.id === id)?.directory
    );
  });
}

export function skipPlanSession(sessionId: string, updatedAt?: number) {
  let skippedAt: number | undefined;
  setState((draft) => {
    const session = draft.sessions.find((item) => item.id === sessionId);
    const sessionUpdatedAt = updatedAt ?? session?.time.updated;
    if (!isNumber(sessionUpdatedAt)) return;
    skippedAt =
      updatedAt ?? Math.max(sessionUpdatedAt, draft.completedSessionResponses[sessionId] ?? 0);
    draft.skippedPlanSessions[sessionId] = skippedAt;
    writeMarkerForSession(
      STORAGE_KEYS.skippedPlanSessions,
      sessionId,
      skippedAt,
      session?.directory
    );
  });
  if (skippedAt === undefined) return;
  postMessage({
    type: 'session-plan-state/update',
    payload: { sessionId, skippedAt },
  });
}

export function clearSkippedPlanSession(sessionId: string) {
  postMessage({
    type: 'session-plan-state/update',
    payload: { sessionId, skippedAt: null },
  });
  clearSessionMarker('skippedPlanSessions', sessionId);
}

export function applySessionPlanStateUpdate(sessionId: string, skippedAt: number | null) {
  setState((draft) => {
    if (skippedAt === null) delete draft.skippedPlanSessions[sessionId];
    else draft.skippedPlanSessions[sessionId] = skippedAt;
    writeMarkerForSession(
      STORAGE_KEYS.skippedPlanSessions,
      sessionId,
      skippedAt ?? undefined,
      draft.sessions.find((item) => item.id === sessionId)?.directory
    );
  });
}

export function isSkippedPlanSession(sessionId: string, updatedAt: number) {
  return isSkippedPlanSessionMarker(state.skippedPlanSessions, sessionId, updatedAt);
}

export function isSessionUnread(sessionId: string, updatedAt: number) {
  return isSessionUnreadMarker(state.lastSeenSessions, sessionId, updatedAt);
}

export function getSessionPlanUpdatedAt(sessionId: string, updatedAt: number) {
  // A plan can finish after it was viewed without advancing session metadata.
  return Math.max(updatedAt, state.completedSessionResponses[sessionId] ?? 0);
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
    storePath('compactingSessionIds', (ids) => {
      const idx = ids.indexOf(sessionId);
      if (compacting) {
        if (idx === -1) ids.push(sessionId);
        return ids;
      }
      if (idx !== -1) ids.splice(idx, 1);

      return ids;
    })
  );
}

export function isSessionCompacting(sessionId: string | null = state.activeSessionId) {
  if (!sessionId) return false;
  if (state.compactingSessionIds.includes(sessionId)) return true;
  return !!state.sessions.find((session) => session.id === sessionId)?.time.compacting;
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
  if (state.permissions.length === 0 && state.questions.length === 0) return false;
  const rootId = getSessionTreeRootId(sessionId) || sessionId;
  const sessionIds = new Set(getSessionTreeIds(rootId));
  return [
    ...state.permissions.map((permission) => permission.sessionID),
    ...state.questions.map((question) => question.sessionID),
  ].some((candidateSessionId) => sessionIds.has(candidateSessionId));
}

export function setWorkspaceStatuses(entries: WorkspaceStatusEntry[]) {
  setState(storePath('workspaceStatuses', entries));
}

export function setWorkspaceStatusSummary(summary: WorkspaceStatusEventSummary) {
  setState(storePath('workspaceStatusSummary', summary));
}

export function setSessions(nextSessions: Session[], complete = false) {
  sessionTreeIndex.invalidate();
  setState((draft) => {
    // Native array reconciliation may replace unobserved proxies. Catalog readers
    // retain row handles even while their list is unmounted.
    const previous = new Map(draft.sessions.map((session) => [session.id, session]));
    draft.sessions = nextSessions.map((session) => {
      const retained = previous.get(session.id);
      if (!retained) return session;
      reconcile(session)(retained);
      return retained;
    });
  });
  restoreCatalogSessionMarkers(nextSessions);
  // Pagination and local mutations cannot prove that an unloaded session was deleted.
  if (!complete) return;
  const sessionIds = new Set(nextSessions.map((session) => session.id));
  for (const sessionId of restoredMarkerDirectories.keys()) {
    if (!sessionIds.has(sessionId)) restoredMarkerDirectories.delete(sessionId);
  }
  setState((draft) => {
    for (const field of [
      'skippedPlanSessions',
      'completedSessionResponses',
      'interruptedSessionResponses',
    ] as const) {
      const retained = pruneSessionMarkers(draft[field], sessionIds);
      if (!retained) continue;
      for (const id of Object.keys(draft[field])) {
        if (!sessionIds.has(id)) delete draft[field][id];
      }
      writeOpenWorkspaceMarkerState(
        STORAGE_KEYS[field],
        retained,
        nextSessions,
        draft.editorContext.workspaceFolders ?? []
      );
    }
  });
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
  let catalog: MarkerSession[] = [];
  setState((draft) => {
    for (const field of CATALOG_MARKER_FIELDS) {
      reconcile(readMergedSessionMarkerState(markerStorage, STORAGE_KEYS[field], scopes))(
        draft[field]
      );
    }
    catalog = draft.sessions
      .filter((session) =>
        scopes.some((root) => getRelativePathWithinWorkspace(session.directory, root) !== null)
      )
      .map(({ id, directory }) => ({ id, directory }));
  });
  restoreCatalogSessionMarkers(catalog);
}

export function setRecycleBinEntries(entries: RecycleBinEntry[]) {
  setState(storePath('recycleBinEntries', entries));
}

export function setSessionFailed(sessionId: string, failed: boolean) {
  const wasFailed = state.failedSessionIds.includes(sessionId);
  if (failed && !wasFailed) {
    setState(storePath('failedSessionUpdatedAt', sessionId, Date.now()));
  } else if (!failed && state.failedSessionUpdatedAt[sessionId] !== undefined) {
    setState(
      storePath('failedSessionUpdatedAt', (updatedAt) => {
        delete updatedAt[sessionId];

        return updatedAt;
      })
    );
  }

  setState(
    storePath('failedSessionIds', (ids) => {
      const idx = ids.indexOf(sessionId);
      if (failed) {
        if (idx === -1) ids.push(sessionId);
        return ids;
      }
      if (idx !== -1) ids.splice(idx, 1);

      return ids;
    })
  );
  if (failed) clearQuestionResponsePending(sessionId);
}

export function setSessionUsageLimit(sessionId: string, notice: UsageLimitNotice | null) {
  if (!sessionId) return;

  // Update through the draft: store reads stay stale until flush, and one tick can touch
  // several sessions in a tree or set and clear the same session.
  if (notice === null) {
    let removed = false;
    setState((draft) => {
      if (draft.sessionUsageLimits[sessionId] === undefined) return;
      delete draft.sessionUsageLimits[sessionId];
      removed = true;
    });
    if (!removed) return;
    sessionTreeIndex.invalidate();
    setSessionUsageLimitVersion((value) => value + 1);
    return;
  }

  sessionTreeIndex.invalidate();
  setState((draft) => {
    draft.sessionUsageLimits[sessionId] = notice;
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
    if (isAbortedAssistantError(info.error)) {
      markSessionResponseInterrupted(sessionId, info.time.completed ?? info.time.created);
      continue;
    }
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

  setState((draft) => {
    const current = draft['failedSessionUpdatedAt'];
    const incoming = failedSessionUpdatedAt satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['failedSessionUpdatedAt'] = incoming;
    else reconcile(incoming)(current);
  });
  setState(
    storePath('failedSessionIds', [
      ...state.failedSessionIds.filter((sessionId) => !scopedSessionIds.has(sessionId)),
      ...failedSessionIds,
    ])
  );
}
