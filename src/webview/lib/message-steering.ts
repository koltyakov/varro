import { isSessionResumeMessage } from '../../shared/session-pauses';
import type { Message, Part } from '../types';
import { isContinuationAssistantFinish } from './message-metrics';
import { parseSkillAttachment } from './skill-reference';

type SteeringEntry = { info: Message; parts?: Part[] };

export type SteeringMessages = {
  ids: ReadonlySet<string>;
  /** Null means unfinished; a timestamp marks the latest terminal response. */
  endsBySessionId: ReadonlyMap<string, number | null>;
  assistantStartsBySessionId: ReadonlyMap<string, number>;
};

/** Continue across history segments without confusing queued follow-ups with steering. */
export function collectSteeringMessages(
  messages: readonly SteeringEntry[],
  previous?: SteeringMessages
): SteeringMessages {
  const ids = new Set<string>();
  const endsBySessionId = new Map(previous?.endsBySessionId);
  const assistantStartsBySessionId = new Map(previous?.assistantStartsBySessionId);
  for (const { info, parts } of messages) {
    if (info.role === 'assistant') {
      if (info.mode === 'subagent' || info.summary || info.mode === 'automatic') continue;
      const terminal =
        !info.retry &&
        (info.time.completed !== undefined || !!info.error) &&
        (!isContinuationAssistantFinish(info.finish) || !!info.error);
      endsBySessionId.set(
        info.sessionID,
        terminal ? (info.time.completed ?? info.time.created) : null
      );
      assistantStartsBySessionId.set(info.sessionID, info.time.created);
      continue;
    }
    if (info.pendingDelivery) continue;
    if (parts && isSessionResumeMessage(parts)) {
      endsBySessionId.set(info.sessionID, null);
      continue;
    }
    if (
      parts &&
      !parts.some(
        (part) =>
          part.type === 'file' ||
          part.type === 'agent' ||
          (part.type === 'text' &&
            part.text.trim().length > 0 &&
            (!part.synthetic || parseSkillAttachment(part.text) !== null))
      )
    )
      continue;
    const endedAt = endsBySessionId.get(info.sessionID);
    const assistantStartedAt = assistantStartsBySessionId.get(info.sessionID);
    // An assistant row can finish after steering arrived, without moving in transcript order.
    if (
      info.delivery === 'steer' ||
      (info.delivery !== 'queue' &&
        (endedAt === null ||
          (endedAt !== undefined &&
            assistantStartedAt !== undefined &&
            info.time.created > assistantStartedAt &&
            info.time.created < endedAt)))
    )
      ids.add(info.id);
    else endsBySessionId.set(info.sessionID, null);
  }
  return { ids, endsBySessionId, assistantStartsBySessionId };
}
