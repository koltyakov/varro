import type { MessageEntry, SessionStatus } from '../../types';

export type AssistantRetryState = 'retrying' | 'retried' | 'recovered';

/** Derive recovery from completed provider responses in the same visible turn. */
export function getAssistantRetryStates(
  messages: readonly MessageEntry[],
  sessionStatus: Readonly<Record<string, SessionStatus>>
): Map<string, AssistantRetryState> {
  const states = new Map<string, AssistantRetryState>();
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
    if (!completed && info.time.completed !== undefined) continue;
    continuations.set(info.sessionID, {
      parentID: info.parentID,
      completed: completed || !!continuation?.completed,
      recovered:
        !!continuation?.recovered ||
        (completed && !info.error && info.finish !== 'error' && info.finish !== 'aborted'),
    });
  }
  return states;
}
