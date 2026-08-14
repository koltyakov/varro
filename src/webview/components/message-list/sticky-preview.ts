import {
  getUserMessageMarkupSuffix,
  getUserMessagePreviewText,
  parseUserMessageContent,
} from '../Message';
import type { UserMessageMarkupFormat } from '../Message';
import type { Message, MessageEntry, Part } from '../../types';

export type StickyUserMessagePreview = {
  id: string;
  index: number;
  text: string;
  format?: UserMessageMarkupFormat;
  formatPrefix?: string;
  attachmentCount: number;
  imageCount: number;
};

function getStickyUserMessageCounts(parts: Part[]): {
  attachmentCount: number;
  imageCount: number;
  format?: UserMessageMarkupFormat;
  formatPrefix?: string;
} {
  const parsed = parseUserMessageContent(parts);
  const imageCount = parsed.fileParts.filter((part) => part.mime.startsWith('image/')).length;
  const attachmentCount = parsed.attachments.length + (parsed.fileParts.length - imageCount);
  const firstText = parsed.messageTexts.find((text) => text.trim().length > 0);
  const markup = firstText ? getUserMessageMarkupSuffix(firstText) : null;
  const formatPrefix = markup?.prefix.replace(/\s+/g, ' ').trim();
  return {
    attachmentCount,
    imageCount,
    ...(markup ? { format: markup.format } : {}),
    ...(formatPrefix ? { formatPrefix } : {}),
  };
}

export const STICKY_PREVIEW_MIN_VIEWPORT_HEIGHT_PX = 480;
const EMPTY_USER_MESSAGE_PREVIEW = '(no content)';

export function getSubagentSessionIds(messages: readonly { info: Message }[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const entry of messages) {
    if (entry.info.role === 'assistant' && 'mode' in entry.info && entry.info.mode === 'subagent') {
      result.add(entry.info.sessionID);
    }
  }
  return result;
}

export function getStickyUserMessagePreview(
  messages: MessageEntry[],
  firstVisibleMessageIndex: number | null,
  subagentSessionIds: ReadonlySet<string> = getSubagentSessionIds(messages)
): StickyUserMessagePreview | null {
  if (firstVisibleMessageIndex === null || firstVisibleMessageIndex < 0) return null;
  const firstVisibleEntry = messages[firstVisibleMessageIndex];
  if (!firstVisibleEntry) return null;
  if (firstVisibleEntry.info.role === 'user') return null;
  const parentUserMessageId = firstVisibleEntry.info.parentID;
  let fallback: StickyUserMessagePreview | null = null;

  for (let i = firstVisibleMessageIndex; i >= 0; i--) {
    const entry = messages[i];
    if (!entry) continue;
    if (entry.info.role !== 'user') continue;
    if (subagentSessionIds.has(entry.info.sessionID)) continue;
    const text = getUserMessagePreviewText(entry.parts);
    if (text === EMPTY_USER_MESSAGE_PREVIEW) continue;
    const preview = {
      id: entry.info.id,
      index: i,
      text,
      ...getStickyUserMessageCounts(entry.parts),
    };
    if (entry.info.id === parentUserMessageId) return preview;
    fallback ??= preview;
  }

  return fallback;
}

export function getUserMessageNavigationPreviews(
  messages: MessageEntry[],
  subagentSessionIds: ReadonlySet<string> = getSubagentSessionIds(messages)
): StickyUserMessagePreview[] {
  const previews: StickyUserMessagePreview[] = [];
  for (const [index, entry] of messages.entries()) {
    if (entry.info.role !== 'user' || subagentSessionIds.has(entry.info.sessionID)) continue;
    const text = getUserMessagePreviewText(entry.parts);
    if (text === EMPTY_USER_MESSAGE_PREVIEW) continue;
    previews.push({
      id: entry.info.id,
      index,
      text,
      ...getStickyUserMessageCounts(entry.parts),
    });
  }
  return previews;
}

export function getNextVisibleUserMessageTopMap(
  messages: Array<{ info: Message }>,
  observedVisibleMessageBounds: ReadonlyMap<string, { top: number; bottom: number }>
) {
  const result = new Map<string, number | null>();
  const subagentSessionIds = getSubagentSessionIds(messages);
  let nextVisibleUserMessageTop: number | null = null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index]!;
    result.set(entry.info.id, nextVisibleUserMessageTop);
    if (entry.info.role !== 'user') continue;

    if (subagentSessionIds.has(entry.info.sessionID)) continue;

    const bounds = observedVisibleMessageBounds.get(entry.info.id);
    if (bounds && bounds.bottom > 0) {
      nextVisibleUserMessageTop = bounds.top;
    }
  }

  return result;
}

export function shouldShowStickyUserMessagePreview(args: {
  preview: StickyUserMessagePreview | null;
  shouldVirtualize: boolean;
  visibleRange: { start: number; end: number; coreStart?: number };
  rowTop: number | null;
  rowBottom: number | null;
  nextUserMessageTop?: number | null;
  viewportHeight: number;
  previousPreviewId?: string | null;
  stickyPreviewTop?: number | null;
  stickyPreviewBottom?: number | null;
}) {
  const { preview } = args;
  if (!preview) return false;
  if (args.viewportHeight <= 0) return false;
  if (args.viewportHeight < STICKY_PREVIEW_MIN_VIEWPORT_HEIGHT_PX) return false;

  const isPreviousPreview = args.previousPreviewId === preview.id;

  if (
    preview.index === 0 &&
    args.rowTop !== null &&
    args.rowTop !== undefined &&
    args.rowTop >= 0
  ) {
    return false;
  }

  // Keep the previous sticky while its real card is still fully covered by the painted overlay.
  // This makes compact and attachment-only prompts hand off at the same visual boundary.
  if (args.rowBottom !== null && args.rowBottom !== undefined && args.rowBottom > 0) {
    return (
      isPreviousPreview &&
      args.stickyPreviewBottom !== null &&
      args.stickyPreviewBottom !== undefined &&
      args.rowBottom <= args.stickyPreviewBottom &&
      (args.nextUserMessageTop === null ||
        args.nextUserMessageTop === undefined ||
        args.nextUserMessageTop > args.stickyPreviewBottom)
    );
  }

  const firstVisibleIndex = args.visibleRange.coreStart ?? args.visibleRange.start;
  if (args.shouldVirtualize && preview.index < firstVisibleIndex) {
    if (
      isPreviousPreview &&
      args.stickyPreviewBottom !== null &&
      args.stickyPreviewBottom !== undefined &&
      args.nextUserMessageTop !== null &&
      args.nextUserMessageTop !== undefined &&
      args.nextUserMessageTop <= args.stickyPreviewBottom
    ) {
      return false;
    }

    return true;
  }

  if (args.rowTop === null || args.rowBottom === null) return false;
  if (
    isPreviousPreview &&
    args.stickyPreviewTop !== null &&
    args.stickyPreviewTop !== undefined &&
    args.stickyPreviewBottom !== null &&
    args.stickyPreviewBottom !== undefined
  ) {
    if (args.rowBottom > 0) return false;
    return (
      args.nextUserMessageTop === null ||
      args.nextUserMessageTop === undefined ||
      args.nextUserMessageTop > args.stickyPreviewBottom
    );
  }

  return args.rowBottom <= 0;
}

export function isMessageHiddenBehindStickyPreview(args: {
  rowBottom: number;
  nextUserMessageTop?: number | null;
  stickyPreviewBottom: number;
}) {
  if (args.rowBottom > 0) return false;

  if (
    args.nextUserMessageTop !== null &&
    args.nextUserMessageTop !== undefined &&
    args.nextUserMessageTop <= args.stickyPreviewBottom
  ) {
    return false;
  }

  return true;
}
