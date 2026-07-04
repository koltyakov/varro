import { getSessionTreeIds, state } from '../../lib/state';
import { shouldShowAssistantPartInline } from '../../lib/part-utils';
import type { Message, Part } from '../../types';

export function getRenderedMessages(
  messages: Array<{ info: Message; parts: Part[] }>,
  range: { start: number; end: number },
  shouldVirtualize: boolean
) {
  return shouldVirtualize ? messages.slice(range.start, range.end) : messages;
}

function shouldHideThreadMessage(
  entry: { info: Message; parts: Part[] },
  activeSessionId: string | null
) {
  if (!activeSessionId) return false;

  const activeTreeIds = new Set(getSessionTreeIds(activeSessionId));
  if (!activeTreeIds.has(entry.info.sessionID)) return true;
  if (entry.info.sessionID === activeSessionId) return false;

  const session = state.sessions.find((item) => item.id === entry.info.sessionID);
  return !!session?.parentID;
}

export function getVisibleThreadMessages(
  messages: Array<{ info: Message; parts: Part[] }>,
  activeSessionId = state.activeSessionId
) {
  return messages.filter((entry) => !shouldHideThreadMessage(entry, activeSessionId));
}

export function getMessageIdSet(messages: Array<{ info: Message }>) {
  return new Set(messages.map((message) => message.info.id));
}

export function hasVisibleRunningToolPart(messages: Array<{ parts: Part[] }>) {
  return messages.some((entry) =>
    entry.parts.some(
      (part) =>
        part.type === 'tool' &&
        (part.state.status === 'pending' || part.state.status === 'running') &&
        shouldShowAssistantPartInline(part)
    )
  );
}
