import type { Session } from '../types';

export const EMPTY_SESSION_PRUNE_GRACE_MS = 5_000;

export function isEmptySession(session: Session) {
  return session.time.created === session.time.updated;
}

export function shouldPruneEmptySession(
  session: Session,
  options: {
    activeSessionId: string | null;
    isQueued: (sessionId: string) => boolean;
    isAwaitingInput: (sessionId: string) => boolean;
    isRunning: (sessionId: string) => boolean;
    needsAttention: (sessionId: string) => boolean;
    isFailed: (sessionId: string) => boolean;
    isPlanReady: (session: Session) => boolean;
    statusType?: string;
  }
) {
  if (!isEmptySession(session)) return false;
  if (Date.now() - session.time.updated < EMPTY_SESSION_PRUNE_GRACE_MS) return false;
  if (session.id === options.activeSessionId) return false;
  if (options.isQueued(session.id)) return false;
  if (options.isAwaitingInput(session.id)) return false;
  if (options.isRunning(session.id)) return false;
  if (options.needsAttention(session.id)) return false;
  if (options.isFailed(session.id)) return false;
  if (options.isPlanReady(session)) return false;
  return options.statusType !== 'busy' && options.statusType !== 'retry';
}
