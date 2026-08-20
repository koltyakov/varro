import { describe, expect, it, vi } from 'vitest';
import type { MessageEntry } from '../../types';
import {
  getStickyUserMessagePreview,
  getNextVisibleUserMessageTopMap,
  getUserMessageNavigationPreviews,
  shouldShowStickyUserMessagePreview,
  isMessageHiddenBehindStickyPreview,
} from './sticky-preview';

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise sticky-preview integration with the Message renderer. */
vi.mock('../Message', () => ({
  getUserMessagePreviewText: vi.fn((parts: { text?: string }[]) => {
    const first = parts[0];
    if (!first || !first.text) return '(no content)';
    return first.text;
  }),
  getUserMessageMarkupSuffix: vi.fn((text: string) => {
    const index = text.indexOf('<svg');
    if (index < 0) return null;
    const content = text.slice(index);
    return {
      prefix: text.slice(0, index).trim(),
      content,
      format: { kind: 'svg', byteSize: new TextEncoder().encode(content).byteLength },
    };
  }),
  parseUserMessageContent: vi.fn((parts: { text?: string }[]) => ({
    messageTexts: parts.flatMap((part) => (part.text ? [part.text] : [])),
    attachments: [],
    fileParts: [],
  })),
}));

function user(id: string, text: string = 'hello'): MessageEntry {
  return {
    info: {
      id,
      sessionID: 'session-1',
      role: 'user',
      time: { created: 0 },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
    parts: [
      {
        id: `${id}-text`,
        sessionID: 'session-1',
        messageID: id,
        type: 'text',
        text,
      },
    ],
  };
}

function assistant(id: string, parentID: string = 'u1'): MessageEntry {
  return {
    info: {
      id,
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: 0 },
      parentID,
      modelID: 'gpt-5',
      providerID: 'openai',
      mode: 'default',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [],
  };
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

  it('falls back to the preceding user message when the assistant parent is not loaded', () => {
    const messages = [user('u1', 'my prompt'), assistant('a1', 'unloaded-user')];
    const result = getStickyUserMessagePreview(messages, 1);
    expect(result).toEqual({
      id: 'u1',
      index: 0,
      text: 'my prompt',
      attachmentCount: 0,
      imageCount: 0,
    });
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
    expect(result).toEqual({
      id: 'u1',
      index: 0,
      text: 'good text',
      attachmentCount: 0,
      imageCount: 0,
    });
  });

  it('skips user messages with (no content) preview', () => {
    const messages: MessageEntry[] = [
      user('u1', 'visible'),
      { ...user('u2'), parts: [] },
      assistant('a1'),
    ];
    const result = getStickyUserMessagePreview(messages, 2);
    expect(result).toEqual({
      id: 'u1',
      index: 0,
      text: 'visible',
      attachmentCount: 0,
      imageCount: 0,
    });
  });

  it('returns null when no user message precedes the visible assistant', () => {
    const messages = [assistant('a1')];
    expect(getStickyUserMessagePreview(messages, 0)).toBeNull();
  });

  it('picks the closest preceding user message', () => {
    const messages = [
      user('u1', 'first'),
      assistant('a1'),
      user('u2', 'second'),
      assistant('a2', 'u2'),
    ];
    const result = getStickyUserMessagePreview(messages, 3);
    expect(result).toEqual({
      id: 'u2',
      index: 2,
      text: 'second',
      attachmentCount: 0,
      imageCount: 0,
    });
  });

  it('keeps the assistant parent prompt when a queued user message is interleaved', () => {
    const messages = [
      user('u1', 'active prompt'),
      assistant('a1'),
      user('u2', 'queued follow-up'),
      assistant('a2', 'u1'),
    ];

    expect(getStickyUserMessagePreview(messages, 3)).toEqual({
      id: 'u1',
      index: 0,
      text: 'active prompt',
      attachmentCount: 0,
      imageCount: 0,
    });
  });

  it('includes compact markup metadata without changing the prompt identity', () => {
    const messages = [user('u1', '<svg>\n<path />\n</svg>'), assistant('a1')];

    expect(getStickyUserMessagePreview(messages, 1)).toEqual({
      id: 'u1',
      index: 0,
      text: '<svg>\n<path />\n</svg>',
      format: { kind: 'svg', byteSize: 21 },
      attachmentCount: 0,
      imageCount: 0,
    });
  });

  it('keeps prose before trailing markup in the compact sticky preview', () => {
    const text = 'Change the icon to\n\n<svg>\n<path />\n</svg>';
    const messages = [user('u1', text), assistant('a1')];

    expect(getStickyUserMessagePreview(messages, 1)).toEqual({
      id: 'u1',
      index: 0,
      text,
      format: { kind: 'svg', byteSize: 21 },
      formatPrefix: 'Change the icon to',
      attachmentCount: 0,
      imageCount: 0,
    });
  });
});

describe('getUserMessageNavigationPreviews', () => {
  it('returns previewable user turns in transcript order', () => {
    expect(
      getUserMessageNavigationPreviews([
        user('u1', 'First'),
        assistant('a1'),
        user('empty', ''),
        user('u2', 'Second'),
      ])
    ).toEqual([
      { id: 'u1', index: 0, text: 'First', attachmentCount: 0, imageCount: 0 },
      { id: 'u2', index: 3, text: 'Second', attachmentCount: 0, imageCount: 0 },
    ]);
  });

  it('excludes prompts from managed subagent sessions', () => {
    const subagentPrompt = user('subagent-user', 'Internal prompt');
    subagentPrompt.info.sessionID = 'child-session';

    expect(
      getUserMessageNavigationPreviews(
        [user('u1', 'Visible prompt'), subagentPrompt],
        new Set(['child-session'])
      ).map((preview) => preview.id)
    ).toEqual(['u1']);
  });
});

describe('getNextVisibleUserMessageTopMap', () => {
  it('returns null for all entries when no user messages are visible', () => {
    const messages = [assistant('a1'), user('u1')];
    const bounds = new Map<string, { top: number; bottom: number }>();
    const result = getNextVisibleUserMessageTopMap(messages, bounds);
    expect(result.get('a1')).toBeNull();
    expect(result.get('u1')).toBeNull();
  });

  it('propagates visible user message top backward', () => {
    const messages = [assistant('a1'), user('u1'), assistant('a2')];
    const bounds = new Map<string, { top: number; bottom: number }>([
      ['u1', { top: 100, bottom: 200 }],
    ]);
    const result = getNextVisibleUserMessageTopMap(messages, bounds);
    expect(result.get('a1')).toBe(100);
    expect(result.get('u1')).toBeNull();
    expect(result.get('a2')).toBeNull();
  });

  it('updates nextVisibleUserMessageTop for each visible user message', () => {
    const messages = [user('u1'), user('u2')];
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
    const messages = [user('u1'), user('u2')];
    const bounds = new Map<string, { top: number; bottom: number }>([
      ['u2', { top: 60, bottom: 100 }],
    ]);
    const result = getNextVisibleUserMessageTopMap(messages, bounds);
    expect(result.get('u1')).toBe(60);
    expect(result.get('u2')).toBeNull();
  });

  it('skips user messages with bottom <= 0', () => {
    const messages = [user('u1'), user('u2')];
    const bounds = new Map<string, { top: number; bottom: number }>([
      ['u2', { top: 0, bottom: 0 }],
    ]);
    const result = getNextVisibleUserMessageTopMap(messages, bounds);
    expect(result.get('u1')).toBeNull();
  });
});

describe('shouldShowStickyUserMessagePreview', () => {
  // SAFETY: The fixture provides the complete domain shape read by this statement.
  const baseArgs = {
    preview: { id: 'u1', index: 0, text: 'hello', attachmentCount: 0, imageCount: 0 } as const,
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

  it('keeps an unmounted prompt that is only inside the overscan range', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        visibleRange: { start: 0, end: 20, coreStart: 10 },
      })
    ).toBe(true);
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
        preview: { ...baseArgs.preview, index: 1 },
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
        preview: { ...baseArgs.preview, index: 1 },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 5 },
        rowTop: 10,
        rowBottom: 50,
      })
    ).toBe(false);
  });

  it('hides the first prompt sticky once its real card reaches the list top', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 5 },
        previousPreviewId: 'u1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 100,
        rowTop: 0,
        rowBottom: 50,
      })
    ).toBe(false);
  });

  it('keeps the previous preview until its card reaches the sticky collision boundary', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        preview: { ...baseArgs.preview, index: 1 },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 5 },
        previousPreviewId: 'u1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 50,
        rowTop: 10,
        rowBottom: 49,
      })
    ).toBe(true);
    expect(
      shouldShowStickyUserMessagePreview({
        ...baseArgs,
        preview: { ...baseArgs.preview, index: 1 },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 5 },
        previousPreviewId: 'u1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 50,
        rowTop: 10,
        rowBottom: 51,
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
