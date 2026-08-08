import { state } from '../../lib/state';
import { collectSessionTreeIds } from '../../lib/session-tree-index';
import { shouldShowAssistantPartInline } from '../../lib/part-utils';
import type { MessageEntry, Part, Session } from '../../types';

export function getRenderedMessages(
  messages: MessageEntry[],
  range: { start: number; end: number },
  shouldVirtualize: boolean
) {
  return shouldVirtualize ? messages.slice(range.start, range.end) : messages;
}

function shouldHideThreadMessage(
  entry: MessageEntry,
  activeSessionId: string | null,
  activeTreeIds: ReadonlySet<string>,
  sessions: Session[]
) {
  if (!activeSessionId) return false;

  if (!activeTreeIds.has(entry.info.sessionID)) return true;
  if (entry.info.sessionID === activeSessionId) return false;

  const session = sessions.find((item) => item.id === entry.info.sessionID);
  return !!session?.parentID;
}

export function getVisibleThreadMessages(
  messages: MessageEntry[],
  activeSessionId = state.activeSessionId,
  sessions = state.sessions
) {
  const activeTreeIds = new Set(collectSessionTreeIds(activeSessionId, sessions));
  return messages.filter(
    (entry) => !shouldHideThreadMessage(entry, activeSessionId, activeTreeIds, sessions)
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
