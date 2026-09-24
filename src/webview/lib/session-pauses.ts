import { asRecord } from '../../shared/type-utils';
import { isSessionResumeMessage, readSessionPauses } from '../../shared/session-pauses';
import type { MessageEntry, Session } from '../types';
import { client } from './client';
import { setState, state } from './app-state';
import {
  hasUserMessageContent,
  parseUserMessageContent,
} from '../components/message/UserMessageContent';

export type SessionPause = {
  sessionId: string;
  messageId: string;
  pausedAt: number;
  resumed: boolean;
};

export function getSessionPauseMap(
  sessions: readonly Session[],
  messages: readonly MessageEntry[]
): Map<string, SessionPause> {
  const latestProgress = new Map<string, number>();
  const messageIndexes = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    messageIndexes.set(message.info.id, index);
    if (
      message.info.role === 'user' &&
      (message.info.pendingDelivery ||
        (!isSessionResumeMessage(message.parts) &&
          !hasUserMessageContent(parseUserMessageContent(message.parts))))
    ) {
      continue;
    }
    latestProgress.set(message.info.sessionID, index);
  }
  const pauses = new Map<string, SessionPause>();
  for (const session of sessions) {
    for (const pause of readSessionPauses(session.metadata)) {
      const boundaryIndex = messageIndexes.get(pause.messageId);
      pauses.set(pause.messageId, {
        ...pause,
        sessionId: session.id,
        resumed:
          boundaryIndex !== undefined && (latestProgress.get(session.id) ?? -1) > boundaryIndex,
      });
    }
  }
  return pauses;
}

export async function recordSessionPause(sessionId: string): Promise<void> {
  const pausedAt = Date.now();
  const directory = state.sessions.find((session) => session.id === sessionId)?.directory;
  // Read after interruption so the divider follows the final canonical message.
  const [session, messages] = await Promise.all([
    client.session.get(sessionId, { directory }),
    client.session.messages(sessionId, { directory, limit: 1 }),
  ]);
  const message = messages.at(-1);
  if (!message) return;
  const metadata = asRecord(session.metadata) ?? {};
  const varro = asRecord(metadata.varro) ?? {};
  const pauses = readSessionPauses(session.metadata);
  if (pauses.some((pause) => pause.messageId === message.info.id)) return;
  const updated = await client.session.update(
    sessionId,
    {
      metadata: {
        ...metadata,
        varro: {
          ...varro,
          pauses: [...pauses, { messageId: message.info.id, pausedAt }],
        },
      },
    },
    { directory }
  );
  setState('sessions', (entry) => entry.id === sessionId, 'metadata', updated.metadata);
}
