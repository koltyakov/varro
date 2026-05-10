import type { Session } from '../types';

export const EMPTY_SESSION_PRUNE_GRACE_MS = 5_000;

type EmptySessionStateOptions = {
  isQueued: (sessionId: string) => boolean;
  isAwaitingInput: (sessionId: string) => boolean;
  isRunning: (sessionId: string) => boolean;
  needsAttention: (sessionId: string) => boolean;
  isFailed: (sessionId: string) => boolean;
  isPlanReady: (session: Session) => boolean;
  preserve?: boolean;
  statusType?: string;
};

type EmptySessionPruneOptions = EmptySessionStateOptions & {
  activeSessionId: string | null;
};

export function isEmptySession(session: Session) {
  return session.time.created === session.time.updated;
}

export function shouldHideEmptySessionFromList(
  session: Session,
  options: EmptySessionStateOptions
) {
  if (!isEmptySession(session)) return false;
  return !hasEmptySessionKeepReason(session, options);
}

export function shouldPruneEmptySession(session: Session, options: EmptySessionPruneOptions) {
  if (!isEmptySession(session)) return false;
  if (Date.now() - session.time.updated < EMPTY_SESSION_PRUNE_GRACE_MS) return false;
  return !hasEmptySessionKeepReason(session, options);
}

function hasEmptySessionKeepReason(
  session: Session,
  options: EmptySessionStateOptions & { activeSessionId?: string | null }
) {
  if (options.preserve) return true;
  if (session.id === options.activeSessionId) return true;
  if (options.isQueued(session.id)) return true;
  if (options.isAwaitingInput(session.id)) return true;
  if (options.isRunning(session.id)) return true;
  if (options.needsAttention(session.id)) return true;
  if (options.isFailed(session.id)) return true;
  if (options.isPlanReady(session)) return true;
  return options.statusType === 'busy' || options.statusType === 'retry';
}
