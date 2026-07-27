import type { Session } from '../types';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';

const storedUnsharedSessionIds = readStored<unknown>(STORAGE_KEYS.unsharedSessions);
const unsharedSessionIds = new Set(
  Array.isArray(storedUnsharedSessionIds)
    ? storedUnsharedSessionIds.filter(
        (sessionID): sessionID is string => typeof sessionID === 'string' && sessionID.length > 0
      )
    : []
);

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

export function applySessionShareOverride(session: Session): Session {
  if (!session.share || !unsharedSessionIds.has(session.id)) return session;
  return { ...session, share: undefined };
}

export function resetSessionShareOverridesForTests() {
  unsharedSessionIds.clear();
  persistUnsharedSessionIds();
}
