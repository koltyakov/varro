import { describe, expect, it, vi } from 'vitest';
import {
  getStickyUserMessagePreview,
  getNextVisibleUserMessageTopMap,
  shouldShowStickyUserMessagePreview,
  isMessageHiddenBehindStickyPreview,
} from './sticky-preview';

vi.mock('../Message', () => ({
  getUserMessagePreviewText: vi.fn((parts: { text?: string }[]) => {
    const first = parts[0];
    if (!first || !first.text) return '(no content)';
    return first.text;
  }),
}));

type TestMessage = { info: { id: string; role: 'user' | 'assistant' }; parts: { text?: string }[] };

function user(id: string, text: string = 'hello'): TestMessage {
  return { info: { id, role: 'user' }, parts: [{ text }] };
}

function assistant(id: string): TestMessage {
  return { info: { id, role: 'assistant' }, parts: [] };
}

describe('getStickyUserMessagePreview', () => {
  it('returns null when firstVisibleMessageIndex is null', () => {
    expect(getStickyUserMessagePreview([], null)).toBeNull();
  });

  it('returns null when firstVisibleMessageIndex is negative', () => {
    expect(getStickyUserMessagePreview([], -1)).toBeNull();
  });

  it('returns null when index is out of bounds', () => {
    expect(getStickyUserMessagePreview([], 0)).toBeNull();
    expect(getStickyUserMessagePreview([user('u1')], 5)).toBeNull();
  });

  it('returns null when first visible message is a user message', () => {
    const messages = [user('u1'), assistant('a1')];
    expect(getStickyUserMessagePreview(messages, 0)).toBeNull();
  });

  it('finds the preceding user message', () => {
    const messages = [user('u1', 'my prompt'), assistant('a1')];
    const result = getStickyUserMessagePreview(messages, 1);
    expect(result).toEqual({ id: 'u1', index: 0, text: 'my prompt' });
  });

  it('skips empty previews and continues searching', () => {
    const messages = [
      user('u1', 'good text'),
      user('u2', ''), // mock will return '(no content)' for empty string... let's use undefined
      assistant('a1'),
    ];
    // The mock returns '(no content)' for empty text which gets skipped
    // Actually our mock checks `first.text` truthiness, empty string is falsy → '(no content)' → skipped
    const result = getStickyUserMessagePreview(messages, 2);
    expect(result).toEqual({ id: 'u1', index: 0, text: 'good text' });
  });

  it('skips user messages with (no content) preview', () => {
    const messages: TestMessage[] = [
      user('u1', 'visible'),
      { info: { id: 'u2', role: 'user' }, parts: [{}] }, // no text → '(no content)'
      assistant('a1'),
    ];
    const result = getStickyUserMessagePreview(messages, 2);
    expect(result).toEqual({ id: 'u1', index: 0, text: 'visible' });
  });

  it('returns null when no user message precedes the visible assistant', () => {
    const messages = [assistant('a1')];
    expect(getStickyUserMessagePreview(messages, 0)).toBeNull();
  });

  it('picks the closest preceding user message', () => {
    const messages = [user('u1', 'first'), assistant('a1'), user('u2', 'second'), assistant('a2')];
    const result = getStickyUserMessagePreview(messages, 3);
    expect(result).toEqual({ id: 'u2', index: 2, text: 'second' });
  });
});

describe('getNextVisibleUserMessageTopMap', () => {
  it('returns null for all entries when no user messages are visible', () => {
    const messages = [
      { info: { id: 'a1', role: 'assistant' as const } },
      { info: { id: 'u1', role: 'user' as const } },
    ];
    const bounds = new Map<string, { top: number; bottom: number }>();
    const result = getNextVisibleUserMessageTopMap(messages, bounds);
    expect(result.get('a1')).toBeNull();
    expect(result.get('u1')).toBeNull();
  });

  it('propagates visible user message top backward', () => {
    const messages = [
      { info: { id: 'a1', role: 'assistant' as const } },
      { info: { id: 'u1', role: 'user' as const } },
      { info: { id: 'a2', role: 'assistant' as const } },
    ];
    const bounds = new Map<string, { top: number; bottom: number }>([
      ['u1', { top: 100, bottom: 200 }],
    ]);
    const result = getNextVisibleUserMessageTopMap(messages, bounds);
    expect(result.get('a1')).toBe(100);
    expect(result.get('u1')).toBeNull();
    expect(result.get('a2')).toBeNull();
  });

  it('updates nextVisibleUserMessageTop for each visible user message', () => {
    const messages = [
      { info: { id: 'u1', role: 'user' as const } },
      { info: { id: 'u2', role: 'user' as const } },
    ];
    const bounds = new Map<string, { top: number; bottom: number }>([
      ['u1', { top: 10, bottom: 50 }],
      ['u2', { top: 60, bottom: 100 }],
    ]);
    const result = getNextVisibleUserMessageTopMap(messages, bounds);
    // u2 is iterated first (reverse), sets next=60; u1 is next, sets next=10
    expect(result.get('u1')).toBe(60);
    expect(result.get('u2')).toBeNull();
  });

  it('skips user messages not in bounds', () => {
    const messages = [
      { info: { id: 'u1', role: 'user' as const } },
      { info: { id: 'u2', role: 'user' as const } },
    ];
    const bounds = new Map<string, { top: number; bottom: number }>([
      ['u2', { top: 60, bottom: 100 }],
    ]);
    const result = getNextVisibleUserMessageTopMap(messages, bounds);
    expect(result.get('u1')).toBe(60);
    expect(result.get('u2')).toBeNull();
  });

  it('skips user messages with bottom <= 0', () => {
    const messages = [
      { info: { id: 'u1', role: 'user' as const } },
      { info: { id: 'u2', role: 'user' as const } },
    ];
    const bounds = new Map<string, { top: number; bottom: number }>([
      ['u2', { top: 0, bottom: 0 }],
    ]);
    const result = getNextVisibleUserMessageTopMap(messages, bounds);
    expect(result.get('u1')).toBeNull();
  });
});

describe('shouldShowStickyUserMessagePreview', () => {
  const baseArgs = {
    preview: { id: 'u1', index: 0, text: 'hello' } as const,
    shouldVirtualize: true,
    visibleRange: { start: 2, end: 5 },
    rowTop: null as number | null,
    rowBottom: null as number | null,
    viewportHeight: 600,
    previousPreviewId: null as string | null,
  };

  it('returns false when preview is null', () => {
    expect(shouldShowStickyUserMessagePreview({ ...baseArgs, preview: null })).toBe(false);
  });

  it('returns false when viewportHeight <= 0', () => {
    expect(shouldShowStickyUserMessagePreview({ ...baseArgs, viewportHeight: 0 })).toBe(false);
  });

  it('returns false when viewportHeight < 480', () => {
    expect(shouldShowStickyUserMessagePreview({ ...baseArgs, viewportHeight: 479 })).toBe(false);
  });

  it('returns true when virtualizing and preview is above visible range', () => {
    expect(shouldShowStickyUserMessagePreview(baseArgs)).toBe(true);
  });

  it('returns false when virtualizing but preview is within visible range', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        visibleRange: { start: 0, end: 5 },
      })
    ).toBe(false);
  });

  it('suppresses sticky when nextUserMessage overlaps sticky bottom for previous preview', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        previousPreviewId: 'u1',
        stickyPreviewBottom: 200,
        nextUserMessageTop: 150,
      })
    ).toBe(false);
  });

  it('keeps sticky when nextUserMessageTop is below sticky bottom', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        previousPreviewId: 'u1',
        stickyPreviewBottom: 200,
        nextUserMessageTop: 300,
      })
    ).toBe(true);
  });

  it('returns false when not virtualizing and rowBottom is null', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        shouldVirtualize: false,
        rowTop: null,
        rowBottom: null,
      })
    ).toBe(false);
  });

  it('returns true when not virtualizing and rowBottom <= 0', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 5 },
        rowTop: -100,
        rowBottom: -50,
      })
    ).toBe(true);
  });

  it('returns false when not virtualizing and rowBottom > 0', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 5 },
        rowTop: 10,
        rowBottom: 50,
      })
    ).toBe(false);
  });

  it('with previous preview and bounds, hides if rowBottom > 0', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 5 },
        previousPreviewId: 'u1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 50,
        rowTop: 10,
        rowBottom: 50,
      })
    ).toBe(false);
  });

  it('with previous preview and no nextUserMessage, shows when rowBottom <= 0', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 5 },
        previousPreviewId: 'u1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 50,
        rowTop: -50,
        rowBottom: -10,
        nextUserMessageTop: null,
      })
    ).toBe(true);
  });
});

describe('isMessageHiddenBehindStickyPreview', () => {
  it('returns false when rowBottom > 0', () => {
    expect(
      isMessageHiddenBehindStickyPreview({
        rowBottom: 10,
        stickyPreviewBottom: 50,
      })
    ).toBe(false);
  });

  it('returns false when nextUserMessageTop <= stickyPreviewBottom', () => {
    expect(
      isMessageHiddenBehindStickyPreview({
        rowBottom: -10,
        nextUserMessageTop: 40,
        stickyPreviewBottom: 50,
      })
    ).toBe(false);
  });

  it('returns true when rowBottom <= 0 and nextUserMessageTop > stickyPreviewBottom', () => {
    expect(
      isMessageHiddenBehindStickyPreview({
        rowBottom: -10,
        nextUserMessageTop: 100,
        stickyPreviewBottom: 50,
      })
    ).toBe(true);
  });

  it('returns true when rowBottom <= 0 and nextUserMessageTop is null/undefined', () => {
    expect(
      isMessageHiddenBehindStickyPreview({
        rowBottom: -10,
        stickyPreviewBottom: 50,
      })
    ).toBe(true);
    expect(
      isMessageHiddenBehindStickyPreview({
        rowBottom: -10,
        nextUserMessageTop: null,
        stickyPreviewBottom: 50,
      })
    ).toBe(true);
  });

  it('returns true when rowBottom is exactly 0', () => {
    expect(
      isMessageHiddenBehindStickyPreview({
        rowBottom: 0,
        stickyPreviewBottom: 50,
      })
    ).toBe(true);
  });
});
