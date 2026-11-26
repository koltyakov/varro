import { state } from '../../lib/state';
import { collectSessionTreeIds } from '../../lib/session-tree-index';
import { shouldShowAssistantPartInline } from '../../lib/part-utils';
import type { MessageEntry, Part, Session } from '../../types';

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

/**
 * A staged rewind keeps its messages in OpenCode until it is committed or cleared. Like OpenCode's
 * own clients, show only messages ordered before the boundary.
 */
export function isMessageBehindStagedRevert(
  entry: Pick<MessageEntry, 'info'>,
  boundary: string | undefined
) {
  return boundary !== undefined && entry.info.id >= boundary;
}

function getStagedRevertBoundaries(
  sessions: readonly Pick<Session, 'id' | 'revert'>[],
  sessionIds: ReadonlySet<string>
) {
  const boundaries = new Map<string, string>();
  for (const session of sessions) {
    const messageID = session.revert?.messageID;
    if (messageID && sessionIds.has(session.id)) boundaries.set(session.id, messageID);
  }
  return boundaries;
}

function shouldHideThreadMessage(
  entry: MessageEntry,
  activeSessionId: string,
  activeTreeIds: ReadonlySet<string>,
  childSessionIds: ReadonlySet<string>,
  revertBoundaries: ReadonlyMap<string, string>
) {
  if (entry.info.role === 'user' && entry.info.pendingDelivery === 'steer') return true;
  if (!activeTreeIds.has(entry.info.sessionID)) return true;
  if (isMessageBehindStagedRevert(entry, revertBoundaries.get(entry.info.sessionID))) return true;
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
  const revertBoundaries = getStagedRevertBoundaries(sessions, activeTreeIds);
  return messages.filter(
    (entry) =>
      !shouldHideThreadMessage(
        entry,
        activeSessionId,
        activeTreeIds,
        childSessionIds,
        revertBoundaries
      )
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
