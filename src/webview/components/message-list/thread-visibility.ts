import { state } from '../../lib/state';
import { collectSessionTreeIds } from '../../lib/session-tree-index';
import { shouldShowAssistantPartInline } from '../../lib/part-utils';
import type { MessageEntry, Part } from '../../types';

export function getRenderedMessages(
  messages: MessageEntry[],
  range: {
    start: number;
    end: number;
    pinnedGapStart?: number;
    pinnedGapEnd?: number;
  },
  shouldVirtualize: boolean,
  forceVirtualContent?: (messageId: string) => boolean
) {
  if (!shouldVirtualize) return messages;
  if (
    range.pinnedGapStart === undefined ||
    range.pinnedGapEnd === undefined ||
    range.pinnedGapStart >= range.pinnedGapEnd
  ) {
    return messages.slice(range.start, range.end);
  }

  return [
    ...messages.slice(range.start, range.pinnedGapStart),
    ...messages
      .slice(range.pinnedGapStart, range.pinnedGapEnd)
      .filter((message) => forceVirtualContent?.(message.info.id)),
    ...messages.slice(range.pinnedGapEnd, range.end),
  ];
}

function shouldHideThreadMessage(
  entry: MessageEntry,
  activeSessionId: string,
  activeTreeIds: ReadonlySet<string>,
  childSessionIds: ReadonlySet<string>
) {
  if (!activeTreeIds.has(entry.info.sessionID)) return true;
  if (entry.info.sessionID === activeSessionId) return false;
  return childSessionIds.has(entry.info.sessionID);
}

export function getVisibleThreadMessages(
  messages: MessageEntry[],
  activeSessionId = state.activeSessionId,
  sessions = state.sessions
) {
  if (!activeSessionId) return [];
  const activeTreeIds = new Set(collectSessionTreeIds(activeSessionId, sessions));
  const childSessionIds = new Set(
    sessions.filter((session) => session.parentID).map((session) => session.id)
  );
  return messages.filter(
    (entry) => !shouldHideThreadMessage(entry, activeSessionId, activeTreeIds, childSessionIds)
  );
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
