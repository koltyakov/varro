import type { Session } from '../types';

export type SessionMarkerMap = Record<string, number>;
type ScopedSessionMarkerStore = Record<string, SessionMarkerMap>;

export const NO_WORKSPACE_STORAGE_SCOPE = '__varro.no-workspace__';

type SessionMarkerStorage = {
  readStored<T>(key: string): T | null | undefined;
  writeStored(key: string, value: unknown): void;
};

export function normalizeWorkspacePath(path: string | null | undefined) {
  if (!path) return null;
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || null;
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

export function nextSeenSessions(
  current: SessionMarkerMap,
  sessionId: string,
  updatedAt?: number,
  now = Date.now()
) {
  const seenAt = Math.max(current[sessionId] ?? 0, updatedAt ?? 0, now);
  if (current[sessionId] === seenAt) return null;
  return { ...current, [sessionId]: seenAt };
}

export function nextCompletedSessionResponses(
  current: SessionMarkerMap,
  sessionId: string,
  completedAt?: number,
  now = Date.now()
) {
  // Use the real completion time when known so that re-settling already-seen messages
  // (e.g. loading a session's history) can't push the marker past an older "seen" marker
  // and resurrect a false unread badge. `now` is only a fallback for completions that
  // arrive without a timestamp (status-transition events).
  const completed = Math.max(current[sessionId] ?? 0, completedAt ?? now);
  if (current[sessionId] === completed) return null;
  return { ...current, [sessionId]: completed };
}

export function removeSessionMarker(current: SessionMarkerMap, sessionId: string) {
  if (!(sessionId in current)) return null;
  const next = { ...current };
  delete next[sessionId];
  return next;
}

export function nextSkippedPlanSessions(
  current: SessionMarkerMap,
  sessions: Session[],
  sessionId: string,
  updatedAt?: number
) {
  const sessionUpdatedAt =
    updatedAt ?? sessions.find((session) => session.id === sessionId)?.time.updated;
  if (typeof sessionUpdatedAt !== 'number') return null;
  return { ...current, [sessionId]: sessionUpdatedAt };
}

export function isSkippedPlanSessionMarker(
  skippedPlanSessions: SessionMarkerMap,
  sessionId: string,
  updatedAt: number
) {
  const skippedAt = skippedPlanSessions[sessionId];
  return typeof skippedAt === 'number' && skippedAt >= updatedAt;
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

function isSessionMarkerMap(value: unknown): value is SessionMarkerMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (item) => typeof item === 'number' && Number.isFinite(item)
  );
}

function sanitizeSessionMarkerMap(value: unknown): SessionMarkerMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const sanitized: SessionMarkerMap = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'number' && Number.isFinite(item)) {
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || isSessionMarkerMap(raw)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([workspaceScope, value]) => [
      workspaceScope,
      sanitizeSessionMarkerMap(value),
    ])
  );
}
