import type { MessageEntry, SessionStatus } from '../../types';

export type AssistantRetryState = 'retrying' | 'retried' | 'recovered' | 'resolved';

type RetryContinuation = { parentID: string; completed: boolean; recovered: boolean };

/** Backward-scan state after visiting every newer message. */
export type AssistantRetryScanState = {
  successfulProviders: ReadonlySet<string>;
  newerUserSessions: ReadonlySet<string>;
  continuations: ReadonlyMap<string, RetryContinuation>;
};

const EMPTY_RETRY_SCAN_STATE: AssistantRetryScanState = {
  successfulProviders: new Set(),
  newerUserSessions: new Set(),
  continuations: new Map(),
};

/** Distinguish automatic retries from failures followed by a later successful response. */
export function getAssistantRetryStates(
  messages: readonly MessageEntry[],
  sessionStatus: Readonly<Record<string, SessionStatus>>
): Map<string, AssistantRetryState> {
  return scanAssistantRetryStates(messages, sessionStatus).states;
}

/**
 * Scans `messages` from newest to oldest. Passing the state left by scanning every newer message
 * continues one backward pass exactly, so an older transcript prefix can be scanned separately.
 */
export function scanAssistantRetryStates(
  messages: readonly MessageEntry[],
  sessionStatus: Readonly<Record<string, SessionStatus>>,
  newer: AssistantRetryScanState = EMPTY_RETRY_SCAN_STATE
) {
  const states = new Map<string, AssistantRetryState>();
  const successfulProviders = new Set(newer.successfulProviders);
  const newerUserSessions = new Set(newer.newerUserSessions);
  const continuations = new Map(newer.continuations);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const { info } = messages[index]!;
    if (info.role === 'user') {
      continuations.delete(info.sessionID);
      newerUserSessions.add(info.sessionID);
      continue;
    }
    const next = continuations.get(info.sessionID);
    const providerKey = JSON.stringify([info.sessionID, info.providerID, info.modelID]);
    const continuation = info.parentID && next?.parentID === info.parentID ? next : undefined;
    if (info.error && info.retry) {
      const status = sessionStatus[info.sessionID]?.type;
      const working =
        !newerUserSessions.has(info.sessionID) && (status === 'busy' || status === 'retry');
      if (continuation?.recovered) states.set(info.id, 'recovered');
      else if (continuation?.completed) states.set(info.id, 'retried');
      else if (working) states.set(info.id, 'retrying');
      else if (continuation) states.set(info.id, 'retried');
    }
    // Generated activity rows have no provider finish and cannot prove recovery.
    const completed = info.time.completed !== undefined && !!info.finish;
    const succeeded =
      completed && !info.error && info.finish !== 'error' && info.finish !== 'aborted';
    if (info.error && !states.has(info.id) && successfulProviders.has(providerKey)) {
      states.set(info.id, 'resolved');
    }
    if (succeeded) successfulProviders.add(providerKey);
    if (!completed && info.time.completed !== undefined) continue;
    continuations.set(info.sessionID, {
      parentID: info.parentID,
      completed: completed || !!continuation?.completed,
      recovered: !!continuation?.recovered || succeeded,
    });
  }
  const state: AssistantRetryScanState = { successfulProviders, newerUserSessions, continuations };
  return { states, state };
}

export function sameAssistantRetryScanState(
  previous: AssistantRetryScanState,
  next: AssistantRetryScanState
) {
  const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
    left.size === right.size && [...right].every((value) => left.has(value));
  if (
    !sameSet(previous.successfulProviders, next.successfulProviders) ||
    !sameSet(previous.newerUserSessions, next.newerUserSessions) ||
    previous.continuations.size !== next.continuations.size
  ) {
    return false;
  }
  for (const [sessionId, continuation] of next.continuations) {
    const earlier = previous.continuations.get(sessionId);
    if (
      !earlier ||
      earlier.parentID !== continuation.parentID ||
      earlier.completed !== continuation.completed ||
      earlier.recovered !== continuation.recovered
    ) {
      return false;
    }
  }
  return true;
}
