import type { Session } from '../types';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';
import { isString } from './runtime-values';

const storedUnsharedSessionIds = readStored<unknown>(STORAGE_KEYS.unsharedSessions);
const unsharedSessionIds = new Set(
  Array.isArray(storedUnsharedSessionIds)
    ? storedUnsharedSessionIds.filter(
        (sessionID): sessionID is string => isString(sessionID) && sessionID.length > 0
      )
    : []
);
const preservedSessionUpdatedAts = new Map<
  string,
  { preservedUpdatedAt: number; shareUpdateCompletedAt: number }
>();

function persistUnsharedSessionIds() {
  writeStored(
    STORAGE_KEYS.unsharedSessions,
    unsharedSessionIds.size > 0 ? Array.from(unsharedSessionIds) : null
  );
}

export function markSessionShared(sessionID: string) {
  if (unsharedSessionIds.delete(sessionID)) persistUnsharedSessionIds();
}

export function markSessionUnshared(sessionID: string) {
  unsharedSessionIds.add(sessionID);
  persistUnsharedSessionIds();
}

export function beginSessionShareUpdate(sessionID: string, preservedUpdatedAt: number) {
  preservedSessionUpdatedAts.set(sessionID, {
    preservedUpdatedAt,
    shareUpdateCompletedAt: Number.POSITIVE_INFINITY,
  });
}

export function completeSessionShareUpdate(sessionID: string, shareUpdateCompletedAt: number) {
  const preserved = preservedSessionUpdatedAts.get(sessionID);
  if (!preserved || preserved.preservedUpdatedAt >= shareUpdateCompletedAt) {
    preservedSessionUpdatedAts.delete(sessionID);
    return;
  }
  preservedSessionUpdatedAts.set(sessionID, { ...preserved, shareUpdateCompletedAt });
}

export function cancelSessionShareUpdate(sessionID: string) {
  preservedSessionUpdatedAts.delete(sessionID);
}

export function applySessionShareOverride(session: Session): Session {
  let next = session;
  if (session.share && unsharedSessionIds.has(session.id)) {
    next = { ...session, share: undefined };
  }

  const preserved = preservedSessionUpdatedAts.get(session.id);
  if (!preserved) return next;
  if (session.time.updated > preserved.shareUpdateCompletedAt) {
    preservedSessionUpdatedAts.delete(session.id);
    return next;
  }
  if (session.time.updated <= preserved.preservedUpdatedAt) return next;

  return {
    ...next,
    time: { ...next.time, updated: preserved.preservedUpdatedAt },
  };
}

export function resetSessionShareOverridesForTests() {
  unsharedSessionIds.clear();
  preservedSessionUpdatedAts.clear();
  persistUnsharedSessionIds();
}
