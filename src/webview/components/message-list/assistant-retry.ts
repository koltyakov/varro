import type { MessageEntry, SessionStatus } from '../../types';

export type AssistantRetryState = 'retrying' | 'retried' | 'recovered' | 'resolved';

/** Distinguish automatic retries from failures followed by a later successful response. */
export function getAssistantRetryStates(
  messages: readonly MessageEntry[],
  sessionStatus: Readonly<Record<string, SessionStatus>>
): Map<string, AssistantRetryState> {
  const states = new Map<string, AssistantRetryState>();
  const successfulProviders = new Set<string>();
  const newerUserSessions = new Set<string>();
  const continuations = new Map<
    string,
    { parentID: string; completed: boolean; recovered: boolean }
  >();
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
    const status = sessionStatus[info.sessionID]?.type;
    const working =
      !newerUserSessions.has(info.sessionID) && (status === 'busy' || status === 'retry');
    if (info.error && info.retry) {
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
  return states;
}
