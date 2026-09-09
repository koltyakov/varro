import type { Session } from '../types';
import { normalizeWorkspaceIdentity } from '../../shared/workspace-path';
import { isNumber, type UnknownRecord, isObject } from './runtime-values';

export type SessionMarkerMap = Record<string, number>;
type ScopedSessionMarkerStore = Record<string, SessionMarkerMap>;

export const NO_WORKSPACE_STORAGE_SCOPE = '__varro.no-workspace__';

type SessionMarkerStorage = {
  readStored<T>(key: string): T | null | undefined;
  writeStored<T>(key: string, value: T): void;
};

export function normalizeWorkspacePath(path: string | null | undefined) {
  return normalizeWorkspaceIdentity(path);
}

export function getSessionMarkerWorkspaceScope(workspacePath: string | null | undefined) {
  return normalizeWorkspacePath(workspacePath) || NO_WORKSPACE_STORAGE_SCOPE;
}

export function readInitialSessionMarkerScope(
  storage: SessionMarkerStorage,
  key: string,
  workspaceScope: string
): SessionMarkerMap {
  const raw = storage.readStored<unknown>(key);
  if (isSessionMarkerMap(raw)) {
    const markers = sanitizeSessionMarkerMap(raw);
    storage.writeStored(key, { [workspaceScope]: markers });
    return markers;
  }

  return readScopedSessionMarkerState(storage, key, workspaceScope);
}

export function readScopedSessionMarkerState(
  storage: SessionMarkerStorage,
  key: string,
  workspaceScope: string
): SessionMarkerMap {
  return readScopedSessionMarkerStore(storage, key)[workspaceScope] || {};
}

export function readMergedSessionMarkerState(
  storage: SessionMarkerStorage,
  key: string,
  workspaceScopes: readonly string[],
  sessions: readonly Pick<Session, 'id' | 'directory'>[] = []
) {
  const stored = readScopedSessionMarkerStore(storage, key);
  const merged: SessionMarkerMap = {};
  for (const workspaceScope of new Set(workspaceScopes)) {
    for (const [sessionId, timestamp] of Object.entries(stored[workspaceScope] ?? {})) {
      merged[sessionId] = Math.max(merged[sessionId] ?? 0, timestamp);
    }
  }
  // Exact-directory records may belong to nested projects or other directories
  // admitted by the host catalog. Restore only the catalog's session IDs.
  for (const session of sessions) {
    const markers = stored[getSessionMarkerWorkspaceScope(session.directory)];
    const timestamp = markers?.[session.id];
    if (timestamp !== undefined) {
      merged[session.id] = Math.max(merged[session.id] ?? 0, timestamp);
    }
  }
  return merged;
}

export function writeScopedSessionMarkerState(
  storage: SessionMarkerStorage,
  key: string,
  workspaceScope: string,
  markers: SessionMarkerMap
) {
  const nextStore = readScopedSessionMarkerStore(storage, key);
  if (Object.keys(markers).length === 0) {
    delete nextStore[workspaceScope];
  } else {
    nextStore[workspaceScope] = markers;
  }
  storage.writeStored(key, nextStore);
}

export function updateScopedSessionMarker(
  storage: SessionMarkerStorage,
  key: string,
  workspaceScope: string,
  sessionId: string,
  timestamp: number | undefined
) {
  const nextStore = readScopedSessionMarkerStore(storage, key);
  const markers = Object.hasOwn(nextStore, workspaceScope) ? nextStore[workspaceScope]! : {};
  if (timestamp === undefined) delete markers[sessionId];
  else markers[sessionId] = timestamp;
  if (Object.keys(markers).length === 0) delete nextStore[workspaceScope];
  else nextStore[workspaceScope] = markers;
  storage.writeStored(key, nextStore);
}

export function nextSessionMarkerTimestamp(
  current: number | undefined,
  updatedAt?: number,
  now = Date.now()
) {
  // Use the real completion time when known so that re-settling already-seen messages
  // (e.g. loading a session's history) can't push the marker past an older "seen" marker
  // and resurrect a false unread badge. `now` is only a fallback for completions that
  // arrive without a timestamp (status-transition events).
  const timestamp = Math.max(current ?? 0, updatedAt ?? now);
  return current === timestamp ? null : timestamp;
}

export function isSkippedPlanSessionMarker(
  skippedPlanSessions: SessionMarkerMap,
  sessionId: string,
  updatedAt: number
) {
  const skippedAt = skippedPlanSessions[sessionId];
  return isNumber(skippedAt) && skippedAt >= updatedAt;
}

export function isSessionUnreadMarker(
  lastSeenSessions: SessionMarkerMap,
  sessionId: string,
  updatedAt: number
) {
  const seen = lastSeenSessions[sessionId] ?? 0;
  return updatedAt > seen;
}

export function isSessionCompletedResponseUnreadMarker(
  completedSessionResponses: SessionMarkerMap,
  lastSeenSessions: SessionMarkerMap,
  sessionId: string
) {
  const completedAt = completedSessionResponses[sessionId] ?? 0;
  const seenAt = lastSeenSessions[sessionId] ?? 0;
  return completedAt > seenAt;
}

export function pruneSkippedPlanSessions(
  skippedPlanSessions: SessionMarkerMap,
  sessionIds: Set<string>
) {
  return pruneSessionMarkers(skippedPlanSessions, sessionIds);
}

export function pruneSessionMarkers(markers: SessionMarkerMap, sessionIds: Set<string>) {
  const nextMarkers = Object.fromEntries(
    Object.entries(markers).filter(([id]) => sessionIds.has(id))
  );
  if (Object.keys(nextMarkers).length === Object.keys(markers).length) return null;
  return nextMarkers;
}

function isSessionMarkerMap<T>(value: T): value is T & SessionMarkerMap {
  if (!value || !isObject(value) || Array.isArray(value)) return false;
  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  return Object.values(value as UnknownRecord).every(
    (item) => isNumber(item) && Number.isFinite(item)
  );
}

function sanitizeSessionMarkerMap<T>(value: T) {
  if (!value || !isObject(value) || Array.isArray(value)) return {};
  const sanitized: SessionMarkerMap = {};
  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  for (const [key, item] of Object.entries(value as UnknownRecord)) {
    if (isNumber(item) && Number.isFinite(item)) {
      sanitized[key] = item;
    }
  }
  return sanitized;
}

function readScopedSessionMarkerStore(
  storage: SessionMarkerStorage,
  key: string
): ScopedSessionMarkerStore {
  const raw = storage.readStored<unknown>(key);
  if (!raw || !isObject(raw) || Array.isArray(raw) || isSessionMarkerMap(raw)) {
    return {};
  }

  return Object.fromEntries(
    // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
    Object.entries(raw as UnknownRecord).map(([workspaceScope, value]) => [
      workspaceScope,
      sanitizeSessionMarkerMap(value),
    ])
  );
}
