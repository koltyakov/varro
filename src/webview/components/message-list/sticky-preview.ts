import { getUserMessagePreviewText } from '../Message';
import type { Message, Part } from '../../types';

export type StickyUserMessagePreview = {
  id: string;
  index: number;
  text: string;
};

const STICKY_PREVIEW_MIN_VIEWPORT_HEIGHT_PX = 480;
const EMPTY_USER_MESSAGE_PREVIEW = '(no content)';

export function getStickyUserMessagePreview(
  messages: Array<{ info: Message; parts: Part[] }>,
  firstVisibleMessageIndex: number | null
): StickyUserMessagePreview | null {
  if (firstVisibleMessageIndex === null || firstVisibleMessageIndex < 0) return null;
  const firstVisibleEntry = messages[firstVisibleMessageIndex];
  if (!firstVisibleEntry) return null;
  if (firstVisibleEntry.info.role === 'user') return null;

  for (let i = firstVisibleMessageIndex; i >= 0; i--) {
    const entry = messages[i];
    if (!entry) continue;
    if (entry.info.role !== 'user') continue;
    const text = getUserMessagePreviewText(entry.parts);
    if (text === EMPTY_USER_MESSAGE_PREVIEW) continue;
    return {
      id: entry.info.id,
      index: i,
      text,
    };
  }

  return null;
}

export function getNextVisibleUserMessageTopMap(
  messages: Array<{ info: Message }>,
  observedVisibleMessageBounds: ReadonlyMap<string, { top: number; bottom: number }>
) {
  const result = new Map<string, number | null>();
  let nextVisibleUserMessageTop: number | null = null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    result.set(entry.info.id, nextVisibleUserMessageTop);
    if (entry.info.role !== 'user') continue;

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
  visibleRange: { start: number; end: number };
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

  if (args.shouldVirtualize && preview.index < args.visibleRange.start) {
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
