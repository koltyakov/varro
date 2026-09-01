import { describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import {
  replaceMessages,
  requestMessageListScrollToBottom,
  setSessions,
  setShowModelPicker,
  setState,
  startLoading,
  state,
  upsertPart,
} from '../lib/state';
import type { MessageEntry } from '../types';
import { MessageList } from './MessageList';
import { getAssistantDialogSummaryMap } from './message-list/assistant-dialog';
import * as toolCallMatching from '../lib/tool-call-matching';
import {
  getNextVisibleUserMessageTopMap,
  getStickyUserMessagePreview,
  shouldShowStickyUserMessagePreview,
} from './message-list/sticky-preview';
import {
  editingMessage,
  resetMessageEditState,
  startEditingMessage,
} from '../lib/message-edit-state';
import {
  cacheSessionHistoryPage,
  invalidateSessionMessageWindowRequests,
  markSessionHistoryLoadFailed,
  resetSessionMessageWindowForRefetch,
  setSessionHistoryCursor,
  setSessionHistoryPrompts,
} from '../lib/message-window';
import { client } from '../lib/client';
import {
  assistantMessage,
  entry,
  filePart,
  installControllableIntersectionObserver,
  installMessageListTestEnvironment,
  installQueuedAnimationFrameMocks,
  session,
  textPart,
  toolPart,
  userMessage,
} from './MessageList.test-utils';
import { fixture } from '../test-fixtures';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

installMessageListTestEnvironment({
  getContainer: () => container,
  setContainer: (element) => {
    container = element;
  },
  getCleanup: () => cleanup,
  setCleanup: (nextCleanup) => {
    cleanup = nextCleanup;
  },
});

describe('getStickyUserMessagePreview', () => {
  it('returns the preceding user prompt for the first visible assistant message', () => {
    expect(
      getStickyUserMessagePreview(
        [
          { info: userMessage('user-1'), parts: [textPart('text-1', 'Old prompt')] },
          { info: assistantMessage('assistant-1'), parts: [] },
          { info: userMessage('user-2'), parts: [textPart('text-2', 'Newest prompt')] },
          { info: assistantMessage('assistant-2'), parts: [] },
        ],
        3
      )
    ).toEqual({
      id: 'user-2',
      index: 2,
      text: 'Newest prompt',
      attachmentCount: 0,
      imageCount: 0,
    });
  });

  it('uses fallback preview text for attachment-only user messages', () => {
    expect(
      getStickyUserMessagePreview(
        [
          { info: userMessage('user-1'), parts: [filePart('file-1', 'diagram.png')] },
          { info: assistantMessage('assistant-1'), parts: [] },
        ],
        1
      )
    ).toEqual({
      id: 'user-1',
      index: 0,
      text: 'Attachment: diagram.png',
      attachmentCount: 0,
      imageCount: 1,
    });
  });

  it('skips empty user prompts when picking a sticky preview', () => {
    expect(
      getStickyUserMessagePreview(
        [
          {
            info: userMessage('user-1'),
            parts: [textPart('text-1', '(no content)', { ignored: true })],
          },
          { info: assistantMessage('assistant-1'), parts: [] },
        ],
        1
      )
    ).toBeNull();
  });

  it('returns null when the first visible message is already a user prompt', () => {
    expect(
      getStickyUserMessagePreview(
        [{ info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt')] }],
        0
      )
    ).toBeNull();
  });

  it('returns null when the first visible index is stale for the current message array', () => {
    expect(
      getStickyUserMessagePreview(
        [
          { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt')] },
          { info: assistantMessage('assistant-1'), parts: [] },
        ],
        5
      )
    ).toBeNull();
  });

  it('skips child-session user prompts that are rendered as compact handoff rows', () => {
    expect(
      getStickyUserMessagePreview(
        [
          {
            info: {
              ...userMessage('user-child-1'),
              sessionID: 'child-1',
            },
            parts: [
              {
                id: 'text-child-1',
                sessionID: 'child-1',
                messageID: 'user-child-1',
                type: 'text',
                text: 'Explore repo structure',
              },
            ],
          },
          {
            info: assistantMessage('assistant-child-1', {
              sessionID: 'child-1',
              mode: 'subagent',
            }),
            parts: [],
          },
          { info: assistantMessage('assistant-1'), parts: [] },
        ],
        2
      )
    ).toBeNull();
  });
});

describe('getNextVisibleUserMessageTopMap', () => {
  it('reuses observed user row bounds to resolve the next visible user prompt', () => {
    const messages = [
      entry(userMessage('user-1')),
      entry(assistantMessage('assistant-1')),
      entry(userMessage('user-2')),
      entry(assistantMessage('assistant-2')),
      entry(userMessage('user-3')),
      entry(assistantMessage('assistant-3')),
    ];

    const observedBounds = new Map<string, { top: number; bottom: number }>([
      ['user-2', { top: -80, bottom: -20 }],
      ['user-3', { top: 72, bottom: 124 }],
    ]);

    const nextTopByMessageId = getNextVisibleUserMessageTopMap(messages, observedBounds);
    expect(nextTopByMessageId.get('assistant-3')).toBeNull();
    expect(nextTopByMessageId.get('user-3')).toBeNull();
    expect(nextTopByMessageId.get('assistant-2')).toBe(72);
    expect(nextTopByMessageId.get('user-2')).toBe(72);
    expect(nextTopByMessageId.get('assistant-1')).toBe(72);
    expect(nextTopByMessageId.get('user-1')).toBe(72);
  });
});

describe('shouldShowStickyUserMessagePreview', () => {
  const previewFixture = {
    id: 'user-1',
    index: 2,
    text: 'Prompt',
    attachmentCount: 0,
    imageCount: 0,
  };

  it('returns false on vertically narrow screens', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { ...previewFixture, index: 1 },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        viewportHeight: 320,
      })
    ).toBe(false);
  });

  it('returns true when virtualization places the prompt above the visible range', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { ...previewFixture, index: 1 },
        shouldVirtualize: true,
        visibleRange: { start: 5, end: 10 },
        rowTop: null,
        rowBottom: null,
        viewportHeight: 500,
      })
    ).toBe(true);
  });

  it('returns true when the prompt row sits above the viewport', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        viewportHeight: 500,
      })
    ).toBe(true);
  });

  it('returns false when the prompt row is visible', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 120,
        rowBottom: 180,
        viewportHeight: 500,
      })
    ).toBe(false);
  });

  it('trusts a mounted prompt over a stale virtual range', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: true,
        visibleRange: { start: 3, end: 8 },
        rowTop: -20,
        rowBottom: 32,
        viewportHeight: 500,
      })
    ).toBe(false);
  });

  it('keeps the current sticky preview while the prompt remains covered by it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 12,
        rowBottom: 40,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(true);
  });

  it('keeps the current sticky preview when the prompt peeks into its covered area', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -5,
        rowBottom: 40,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(true);
  });

  it('hides the current sticky preview once the prompt extends below it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 10,
        rowBottom: 61,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('hides the current sticky preview once the next user message rises into it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 10,
        rowBottom: 60,
        nextUserMessageTop: 58,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('keeps the previous sticky preview only until the next user message reaches it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        nextUserMessageTop: 62,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(true);

    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        nextUserMessageTop: 59,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('does not attach a native title tooltip to the sticky preview text', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    const defaultRect = new DOMRect(0, -600, 500, 40);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || defaultRect;
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(user2Row!, new DOMRect(0, -90, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 40, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const stickyText = container?.querySelector(
      '.latest-user-message-sticky-text'
    ) as HTMLDivElement | null;
    expect(stickyText).toBeInstanceOf(HTMLDivElement);
    expect(stickyText?.textContent).toContain('Prompt 2');
    expect(stickyText?.getAttribute('title')).toBeNull();

    animationFrames.restore();
  });

  it('loads and scrolls to a sticky prompt behind a truncated history boundary', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    const boundaryRowDocumentTop = 500;
    const boundaryCardDocumentTop = 520;
    const scrollIntoView = vi.fn(() => {
      scrollTopValue = boundaryRowDocumentTop;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    vi.spyOn(client.session, 'messages').mockResolvedValue([
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 500);
        }
        const row = this.classList.contains('interactive-item-container')
          ? this
          : this.closest<HTMLElement>('[data-msg-id]');
        if (row?.dataset.msgId === 'boundary-user') {
          const documentTop = this.classList.contains('user-message-card')
            ? boundaryCardDocumentTop
            : boundaryRowDocumentTop;
          return new DOMRect(0, documentTop - scrollTopValue, 500, 52);
        }
        if (row?.dataset.msgId === 'assistant-1') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, 20, 500, 320);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    track.style.setProperty('--latest-user-message-sticky-gap', '13px');
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky-text')?.textContent).toContain(
      'Boundary prompt'
    );

    requestMessageListScrollToBottom();
    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(list.scrollTop).toBe(700);

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    sticky?.click();
    expect(sticky?.classList.contains('is-loading')).toBe(true);
    expect(sticky?.textContent).not.toContain('Loading…');
    expect(sticky?.querySelector('.latest-user-message-sticky-spinner')).not.toBeNull();
    await vi.waitFor(() => {
      expect(state.messages.some((message) => message.info.id === 'boundary-user')).toBe(true);
    });
    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);
    expect(sticky?.classList.contains('is-loading')).toBe(true);
    for (let frame = 0; frame < 5; frame += 1) {
      animationFrames.flush();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(client.session.messages).toHaveBeenCalledWith('session-1', {
      limit: 200,
      before: 'cursor-1',
    });
    const boundaryCard = container?.querySelector<HTMLElement>(
      '[data-msg-id="boundary-user"] .user-message-card'
    );
    expect(boundaryCard).toBeInstanceOf(HTMLDivElement);
    const computedStickyGap = Number.parseFloat(
      getComputedStyle(track).getPropertyValue('--latest-user-message-sticky-gap')
    );
    expect(
      Math.abs(
        boundaryCard!.getBoundingClientRect().top -
          list.getBoundingClientRect().top -
          computedStickyGap
      )
    ).toBeLessThanOrEqual(1);
    expect(scrollIntoView).not.toHaveBeenCalled();
    animationFrames.restore();
  });

  it('retries sticky navigation when its page is invalidated at the same cursor', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const freshPage = [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi
      .spyOn(client.session, 'messages')
      .mockReturnValueOnce(pendingStalePage)
      .mockResolvedValueOnce(freshPage);
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-stale');
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.dataset.msgId === 'assistant-1') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 800 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    try {
      const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
      expect(sticky?.textContent).toContain('Boundary prompt');
      sticky?.click();
      await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(1));

      invalidateSessionMessageWindowRequests('session-1');
      releaseStalePage?.(stalePage);

      await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(2));
      expect(messagesSpy).toHaveBeenLastCalledWith('session-1', {
        limit: 200,
        before: 'cursor-stale',
      });
      await vi.waitFor(() => {
        expect(state.messages.some((message) => message.info.id === 'boundary-user')).toBe(true);
      });
    } finally {
      releaseStalePage?.(stalePage);
      await vi.advanceTimersByTimeAsync(0);
      animationFrames.restore();
    }
  });

  it('releases stale sticky loading when the same-session window resets', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const currentPage = [
      { info: userMessage('current-older'), parts: [textPart('current-text', 'Current history')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi.spyOn(client.session, 'messages').mockImplementation((_id, options) => {
      if (options?.before === 'cursor-stale') return pendingStalePage;
      if (options?.before === 'cursor-current') return Promise.resolve(currentPage);
      throw new Error(`Unexpected cursor ${options?.before}`);
    });
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-stale');
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.dataset.msgId === 'assistant-1') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 800 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    try {
      const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
      expect(sticky?.textContent).toContain('Boundary prompt');
      sticky?.click();
      await vi.waitFor(() => {
        expect(messagesSpy).toHaveBeenCalledWith('session-1', {
          limit: 200,
          before: 'cursor-stale',
        });
      });
      expect(sticky?.classList.contains('is-loading')).toBe(true);

      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
      expect(sticky?.classList.contains('is-loading')).toBe(false);
      expect(
        container?.querySelector('.message-history-banner')?.classList.contains('is-loading')
      ).toBe(false);

      sticky?.click();
      expect(sticky?.classList.contains('is-loading')).toBe(true);

      resetSessionMessageWindowForRefetch('session-1');
      setSessionHistoryCursor('session-1', 'cursor-current');
      markSessionHistoryLoadFailed('session-1', true);
      await Promise.resolve();

      expect(sticky?.classList.contains('is-loading')).toBe(false);
      const retry = container?.querySelector<HTMLButtonElement>('.message-history-banner-retry');
      expect(retry).toBeInstanceOf(HTMLButtonElement);
      expect(retry?.disabled).toBe(false);
      retry?.click();
      await vi.waitFor(() => {
        expect(messagesSpy).toHaveBeenCalledWith('session-1', {
          limit: 200,
          before: 'cursor-current',
        });
      });
    } finally {
      releaseStalePage?.(stalePage);
      await vi.advanceTimersByTimeAsync(0);
      animationFrames.restore();
    }
  });

  it('uses an older previewable boundary prompt when the newest cached prompt is empty', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-older');
    setSessionHistoryPrompts('session-1', [
      {
        info: userMessage('boundary-visible'),
        parts: [textPart('boundary-visible-text', 'Previewable boundary prompt')],
      },
      { info: userMessage('boundary-empty'), parts: [] },
    ]);
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.dataset.msgId === 'assistant-1') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 800 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Previewable boundary prompt'
    );
    animationFrames.restore();
  });

  it('keeps an unloaded boundary sticky mounted while prompt history refreshes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }
        if (this.dataset.msgId === 'assistant-1') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 800 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Boundary prompt');

    setSessionHistoryPrompts('session-1', []);
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    await Promise.resolve();

    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);
    animationFrames.restore();
  });

  it('keeps sticky navigation pending while history anchoring owns scroll', async () => {
    // This verifies scroll-owner ordering; destination geometry is covered by the alignment cases.
    const animationFrames = installQueuedAnimationFrameMocks();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    let releaseHistory: (() => void) | undefined;
    const historyPending = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    markSessionHistoryLoadFailed('session-1', true);
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    vi.spyOn(client.session, 'messages').mockImplementation(async () => {
      await historyPending;
      return [
        {
          info: userMessage('boundary-user'),
          parts: [textPart('boundary-text', 'Boundary prompt')],
        },
      ];
    });
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);
    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, 20, 500, 320);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });
    rectMap.set(list, new DOMRect(0, 0, 500, 500));
    const retry = container?.querySelector<HTMLButtonElement>('.message-history-banner-retry');
    expect(retry).toBeInstanceOf(HTMLButtonElement);
    retry?.click();
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(client.session.messages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-1',
      });
    });
    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Boundary prompt');
    sticky?.click();
    expect(sticky?.classList.contains('is-loading')).toBe(true);

    releaseHistory?.();
    await vi.waitFor(() => {
      expect(state.messages.some((message) => message.info.id === 'boundary-user')).toBe(true);
    });
    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);
    expect(sticky?.classList.contains('is-loading')).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();

    animationFrames.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(sticky?.isConnected).toBe(true);
    expect(sticky?.classList.contains('is-loading')).toBe(true);

    for (let frame = 0; frame < 5; frame += 1) {
      animationFrames.flush();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(scrollIntoView).not.toHaveBeenCalled();
    animationFrames.restore();
  });

  it('navigates to a loaded sticky prompt while older history is still loading', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let releaseHistory: (() => void) | undefined;
    const historyPending = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    markSessionHistoryLoadFailed('session-1', true);
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    vi.spyOn(client.session, 'messages').mockImplementation(async () => {
      await historyPending;
      return [];
    });
    replaceMessages([
      {
        info: userMessage('boundary-user'),
        parts: [textPart('boundary-text', 'Boundary prompt')],
      },
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);
    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, 20, 500, 320);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    const sourceCard = container?.querySelector<HTMLElement>(
      '[data-msg-id="boundary-user"] .user-message-card'
    );
    const sourceRow = sourceCard?.closest<HTMLElement>('[data-msg-id="boundary-user"]');
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 800 });
    rectMap.set(list, new DOMRect(0, 0, 500, 500));
    rectMap.set(sourceCard!, new DOMRect(0, -600, 500, 40));
    rectMap.set(sourceRow!, new DOMRect(0, -600, 500, 40));
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const retry = container?.querySelector<HTMLButtonElement>('.message-history-banner-retry');
    expect(retry).toBeInstanceOf(HTMLButtonElement);
    retry?.click();
    await vi.waitFor(() => {
      expect(client.session.messages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-1',
      });
    });

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky-clickable');
    expect(sticky?.textContent).toContain('Boundary prompt');
    sticky?.click();

    expect(list.scrollTop).not.toBe(800);
    expect(sticky?.classList.contains('is-loading')).toBe(false);

    releaseHistory?.();
    animationFrames.flush();
    await Promise.resolve();
    animationFrames.restore();
  });

  it('does not show a new sticky preview until the prompt is clearly above the viewport', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -10,
        rowBottom: 8,
        viewportHeight: 500,
        previousPreviewId: 'user-2',
      })
    ).toBe(false);
  });
});

describe('MessageList sticky prompt preview', () => {
  it('builds shared tool prompt lookups once per render for tool-heavy chats', async () => {
    const questionLookupSpy = vi.spyOn(toolCallMatching, 'buildQuestionRequestLookup');
    const permissionLookupSpy = vi.spyOn(toolCallMatching, 'buildPermissionRequestLookup');

    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [
          {
            ...toolPart('tool-1', 'assistant-1', 'call-1'),
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              output: '',
              title: 'pwd',
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
          {
            ...toolPart('tool-2', 'assistant-1', 'call-2'),
            state: {
              status: 'completed',
              input: { command: 'ls' },
              output: '',
              title: 'ls',
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
          {
            ...toolPart('tool-3', 'assistant-1', 'call-3'),
            state: {
              status: 'completed',
              input: { command: 'git status' },
              output: '',
              title: 'git status',
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ],
      },
    ]);
    setState('questions', [
      {
        id: 'question-1',
        sessionID: 'session-1',
        tool: { messageID: 'assistant-1', callID: 'call-1' },
        questions: [{ question: 'Proceed?', header: 'Confirm', options: [] }],
      },
    ]);
    setState('permissions', [
      {
        id: 'permission-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        callID: 'call-2',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(questionLookupSpy).toHaveBeenCalledTimes(1);
    expect(permissionLookupSpy).toHaveBeenCalledTimes(1);
  });

  it('limits assistant dialog summaries to rendered messages when virtualized', () => {
    const messages = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt 1')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 3_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
      {
        info: { ...userMessage('user-2'), time: { created: 4_000 } },
        parts: [textPart('text-2', 'Prompt 2')],
      },
      {
        info: assistantMessage('assistant-2', {
          time: { created: 5_000, completed: 6_000 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ];

    const summaries = getAssistantDialogSummaryMap(messages, new Set(['assistant-2']));

    expect(summaries.has('assistant-1')).toBe(false);
    expect(summaries.get('assistant-2')).toMatchObject({
      durationMs: 2_000,
      inputTokens: 200,
      outputTokens: 20,
      agentCount: 0,
    });
  });

  it('suppresses only the trailing assistant summary while a turn is still active', () => {
    const messages = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt 1')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 3_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
      {
        info: { ...userMessage('user-2'), time: { created: 4_000 } },
        parts: [textPart('text-2', 'Prompt 2')],
      },
      {
        info: assistantMessage('assistant-2', {
          time: { created: 5_000, completed: 6_000 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ];

    const summaries = getAssistantDialogSummaryMap(messages, undefined, {
      suppressTrailingSummary: true,
    });

    expect(summaries.has('assistant-1')).toBe(true);
    expect(summaries.has('assistant-2')).toBe(false);
  });

  it('does not let a hidden child prompt split the parent worked summary', async () => {
    setState('activeSessionId', 'session-1');
    setSessions([
      session('session-1'),
      session('child-1', { parentID: 'session-1', time: { created: 2_500, updated: 4_000 } }),
    ]);
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Review the changes')],
      },
      {
        info: assistantMessage('assistant-1', {
          parentID: 'user-1',
          time: { created: 2_000, completed: 3_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-1', 'I will inspect the runtime.')],
      },
      {
        info: {
          ...userMessage('child-user-1'),
          sessionID: 'child-1',
          time: { created: 2_500 },
        },
        parts: [
          {
            ...textPart('text-child-user-1', 'Review runtime changes'),
            sessionID: 'child-1',
            messageID: 'child-user-1',
          },
        ],
      },
      {
        info: assistantMessage('child-assistant-1', {
          sessionID: 'child-1',
          mode: 'subagent',
          parentID: 'assistant-1',
          time: { created: 2_600, completed: 4_000 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
      {
        info: assistantMessage('assistant-2', {
          parentID: 'user-1',
          time: { created: 4_100, completed: 6_000 },
          tokens: { input: 300, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-2', 'The changed production path continues here.')],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(
      container?.querySelector('[data-msg-id="assistant-1"] .assistant-dialog-summary')
    ).toBeNull();
    expect(container?.querySelector('.trailing-assistant-summary-row')?.textContent).toContain(
      'Worked for 5s - Tokens ↑ 600 ↓ 60 - Agents 1'
    );
  });

  it('keeps final assistant answers plain when virtualization hides the summary row', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        if (index === 58) {
          return {
            info: { ...userMessage(`user-${index}`), time: { created: index * 1000 } },
            parts: [textPart(`text-user-${index}`, `Prompt ${index}`)],
          };
        }

        if (index === 59) {
          return {
            info: assistantMessage(`assistant-${index}`, {
              time: { created: index * 1000 + 100, completed: index * 1000 + 900 },
              tokens: { input: 100, output: 25, reasoning: 0, cache: { read: 0, write: 0 } },
            }),
            parts: [textPart(`text-assistant-${index}`, 'Final visible response')],
          };
        }

        return {
          info: assistantMessage(`assistant-${index}`),
          parts: [textPart(`text-${index}`, `Response ${index}`)],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, value: 9600 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 9200 });

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const finalResponse = container?.querySelector(
      '[data-msg-id="assistant-59"] .chat-turn-content'
    );
    expect(finalResponse?.className).toContain('assistant-turn-content-plain');
    expect(finalResponse?.className).not.toContain('assistant-turn-content-highlighted');

    animationFrames.restore();
  });

  it('updates Worked for summaries when the virtualized range changes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 30 }, (_, index) => {
        const created = index * 10_000;
        return [
          {
            info: { ...userMessage(`user-${index}`), time: { created } },
            parts: [textPart(`text-user-${index}`, `Prompt ${index}`)],
          },
          {
            info: assistantMessage(`assistant-${index}`, {
              time: { created: created + 1_000, completed: created + 2_000 },
              tokens: { input: 100, output: 25, reasoning: 0, cache: { read: 0, write: 0 } },
            }),
            parts: [textPart(`text-assistant-${index}`, `Response ${index}`)],
          },
        ];
      }).flat()
    );

    try {
      cleanup = render(() => MessageList(), container!);
      await Promise.resolve();

      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      const list = container?.querySelector('.interactive-list') as HTMLDivElement;
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 9_600 });
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        writable: true,
        value: 9_200,
      });
      list.dispatchEvent(new Event('scroll'));
      animationFrames.flush();
      await Promise.resolve();

      cacheSessionHistoryPage('session-1', 'bottom-range', [state.messages[0]!]);
      await Promise.resolve();
      expect(container?.querySelector('.trailing-assistant-summary-row')?.textContent).toContain(
        'Worked for 2s'
      );

      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      expect(
        container?.querySelector('[data-msg-id="assistant-0"] .assistant-dialog-summary')
          ?.textContent
      ).toContain('Worked for 2s');

      cacheSessionHistoryPage('session-1', 'top-range', [state.messages[0]!]);
      await Promise.resolve();
      list.scrollTop = 9_200;
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      expect(container?.querySelector('.trailing-assistant-summary-row')?.textContent).toContain(
        'Worked for 2s'
      );
    } finally {
      animationFrames.restore();
    }
  });

  it('summarizes elapsed time and tokens across nested agent children', async () => {
    setState('activeSessionId', 'session-1');
    setSessions([
      session('child-1', {
        parentID: 'session-1',
        tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      session('child-2', {
        parentID: 'child-1',
        tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]);
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          textPart('text-2', 'Response'),
          {
            id: 'agent-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'agent',
            name: 'explore',
          },
          { ...textPart('text-3', 'Final response'), messageID: 'assistant-1' },
        ],
      },
      {
        info: assistantMessage('assistant-child-1', {
          mode: 'subagent',
          parentID: 'assistant-1',
          sessionID: 'child-1',
          time: { created: 2_500, completed: 8_000 },
          tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
      {
        info: assistantMessage('assistant-child-2', {
          mode: 'subagent',
          parentID: 'assistant-child-1',
          sessionID: 'child-2',
          time: { created: 3_000, completed: 11_000 },
          tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 3,100 ↓ 310 - Agents 2');
  });

  it('includes nested subagent session snapshots when their messages are not loaded', async () => {
    setState('activeSessionId', 'session-1');
    setSessions([
      session('session-1'),
      session('child-1', {
        parentID: 'session-1',
        time: { created: 2_500, updated: 8_000 },
        tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      session('child-2', {
        parentID: 'child-1',
        time: { created: 3_000, updated: 11_000 },
        tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]);
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            id: 'agent-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'agent',
            name: 'explore',
          },
          { ...textPart('text-2', 'Final response'), messageID: 'assistant-1' },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 4s - Tokens ↑ 3,100 ↓ 310');
  });

  it('keeps subagent session tokens scoped to the turn that launched them', () => {
    const messages = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt 1')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 3_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            id: 'task-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'tool' as const,
            callID: 'call-1',
            tool: 'task',
            state: {
              status: 'completed' as const,
              input: {},
              output: '',
              title: 'First task',
              metadata: { sessionId: 'child-1' },
              time: { start: 2_000, end: 3_000 },
            },
          },
        ],
      },
      {
        info: assistantMessage('assistant-child-1', {
          mode: 'subagent',
          parentID: 'session-1',
          sessionID: 'child-1',
          time: { created: 2_500, completed: 3_000 },
          tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
      {
        info: { ...userMessage('user-2'), time: { created: 4_000 } },
        parts: [textPart('text-2', 'Prompt 2')],
      },
      {
        info: assistantMessage('assistant-2', {
          time: { created: 5_000, completed: 6_000 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            id: 'task-2',
            sessionID: 'session-1',
            messageID: 'assistant-2',
            type: 'tool' as const,
            callID: 'call-2',
            tool: 'task',
            state: {
              status: 'completed' as const,
              input: {},
              output: '',
              title: 'Second task',
              metadata: { sessionId: 'child-2' },
              time: { start: 5_000, end: 6_000 },
            },
          },
        ],
      },
      {
        info: assistantMessage('assistant-child-2', {
          mode: 'subagent',
          parentID: 'session-1',
          sessionID: 'child-2',
          time: { created: 5_500, completed: 6_000 },
          tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ];
    const sessions = [
      session('child-1', {
        parentID: 'session-1',
        tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      session('child-2', {
        parentID: 'session-1',
        tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ];

    const summaries = getAssistantDialogSummaryMap(messages, undefined, { sessions });

    expect(summaries.get('assistant-1')).toMatchObject({ inputTokens: 1_100, outputTokens: 110 });
    expect(summaries.get('assistant-2')).toMatchObject({ inputTokens: 2_200, outputTokens: 220 });
  });

  it('does not attach a late task session to the preceding assistant turn', () => {
    const messages = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt 1')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 1_100, completed: 1_500 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            id: 'task-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'tool' as const,
            callID: 'call-1',
            tool: 'task',
            state: {
              status: 'completed' as const,
              input: { description: 'Late task' },
              output: '',
              title: 'Late task',
              metadata: {},
              time: { start: 1_200, end: 1_400 },
            },
          },
        ],
      },
      {
        info: { ...userMessage('user-2'), time: { created: 2_000 } },
        parts: [textPart('text-2', 'Prompt 2')],
      },
      {
        info: assistantMessage('assistant-2', {
          time: { created: 2_100, completed: 2_500 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ];
    const sessions = [
      session('late-child', {
        parentID: 'session-1',
        title: 'Late task',
        time: { created: 2_100, updated: 2_500 },
        tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ];

    const summaries = getAssistantDialogSummaryMap(messages, undefined, { sessions });

    expect(summaries.get('assistant-1')).toMatchObject({ inputTokens: 100, outputTokens: 10 });
  });

  it('shows interrupted assistant turns with the summary divider styling', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000 },
          error: { name: 'aborted', data: { message: 'Aborted' } },
          tokens: { input: 12, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            ...textPart('text-assistant-1', 'Partial response before stop'),
            messageID: 'assistant-1',
          },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const response = container?.querySelector('[data-msg-id="assistant-1"] .chat-turn-content');
    expect(response?.className).toContain('assistant-turn-content-plain');
    expect(response?.className).not.toContain('assistant-turn-content-highlighted');
    const summary = container?.querySelector(
      '.trailing-assistant-summary-row .assistant-dialog-summary'
    );
    expect(summary).toBeInstanceOf(HTMLDivElement);
    expect(summary?.textContent).toContain('Interrupted');
    expect(summary?.textContent).not.toContain('Worked for');
  });

  it('includes prefetched turn history in the Worked for summary', async () => {
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    replaceMessages([
      {
        info: assistantMessage('assistant-2', {
          time: { created: 6_000, completed: 11_000 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-2', 'Visible response')],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    expect(container?.textContent).toContain('Collecting stats...');
    expect(container?.textContent).not.toContain('Worked for 5s - Tokens ↑ 200 ↓ 20');

    cacheSessionHistoryPage('session-1', 'cursor-1', [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-1', 'Earlier response')],
      },
    ]);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 300 ↓ 30');
    expect(container?.querySelector('[data-msg-id="assistant-1"]')).toBeNull();
  });

  it('omits the token summary when input and output tokens are zero', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 11_000 },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            ...textPart('text-assistant-1', 'Received.'),
            messageID: 'assistant-1',
          },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 10s');
    expect(container?.textContent).not.toContain('Tokens');
  });

  it('summarizes in and out tokens for subagent sessions parented to the root session', () => {
    const messages: MessageEntry[] = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            id: 'agent-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'agent',
            name: 'explore',
          },
        ],
      },
      {
        info: assistantMessage('assistant-child-1', {
          mode: 'subagent',
          parentID: 'session-1',
          sessionID: 'child-1',
          time: { created: 2_500, completed: 8_000 },
          tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ];

    const summaries = getAssistantDialogSummaryMap(messages, new Set(['assistant-1']));

    expect(summaries.get('assistant-1')).toMatchObject({
      durationMs: 7_000,
      inputTokens: 1_100,
      outputTokens: 110,
      agentCount: 1,
    });
  });

  it('does not summarize a completed assistant while its latest tool is still running', () => {
    const messages: MessageEntry[] = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [toolPart('tool-1', 'assistant-1')],
      },
    ];

    expect(getAssistantDialogSummaryMap(messages).has('assistant-1')).toBe(false);

    messages[1]!.parts = [
      {
        ...toolPart('tool-1', 'assistant-1'),
        state: {
          status: 'completed',
          input: { command: 'pwd' },
          output: '/workspace',
          title: 'Run pwd',
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ];

    expect(getAssistantDialogSummaryMap(messages).get('assistant-1')).toMatchObject({
      durationMs: 4_000,
      inputTokens: 100,
      outputTokens: 10,
    });
  });

  it('updates the cached assistant summary after a completed tool receives final text', async () => {
    const runningTool = toolPart('tool-1', 'assistant-1');
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [runningTool],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    expect(container?.querySelector('.assistant-dialog-summary')).toBeNull();

    upsertPart({
      ...runningTool,
      type: 'tool',
      state: {
        status: 'completed',
        input: { command: 'pwd' },
        output: '/workspace',
        title: 'Run pwd',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    });
    await Promise.resolve();

    expect(container?.querySelector('.assistant-dialog-summary')).toBeNull();

    upsertPart({
      ...textPart('text-final', 'Done.'),
      messageID: 'assistant-1',
    });
    await Promise.resolve();
    vi.advanceTimersByTime(700);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 4s - Tokens ↑ 100 ↓ 10');
  });

  it('renders with virtualization enabled without hitting initialization order errors', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, `Response ${index}`),
              messageID: messageId,
            },
          ],
        };
      })
    );

    expect(() => {
      cleanup = render(() => MessageList(), container!);
    }).not.toThrow();

    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.interactive-list')).toBeInstanceOf(HTMLDivElement);

    animationFrames.restore();
  });

  it('adds the model-picker modifier class while the model selector is open', async () => {
    setShowModelPicker(true);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-list')?.className).toContain(
      'showing-model-picker'
    );
  });

  it('keeps abandoned content rendered below the message being edited', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
      { info: userMessage('user-3'), parts: [textPart('text-5', 'Prompt 3')] },
      { info: assistantMessage('assistant-3'), parts: [textPart('text-6', 'Response 3')] },
    ]);
    startEditingMessage('user-2', 'session-1', 'Prompt 2');

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-list')?.className).toContain('editing-message');
    expect(container?.querySelector('[data-msg-id="user-1"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="assistant-1"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="user-2"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="assistant-2"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="assistant-2"]')?.className).toContain(
      'interactive-item-edit-abandoned'
    );
    expect(container?.querySelector('[data-msg-id="user-3"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="assistant-3"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="user-3"]')?.className).toContain(
      'interactive-item-edit-abandoned'
    );
    expect(container?.querySelector('[data-msg-id="assistant-3"]')?.className).toContain(
      'interactive-item-edit-abandoned'
    );
  });

  it('prevents scrolling down past the edited message top', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);
    startEditingMessage('user-2', 'session-1', 'Prompt 2');

    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, 0, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const editedRow = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(editedRow).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 500 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(editedRow!, new DOMRect(0, -120, 500, 80));

    list?.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    expect(list!.scrollTop).toBe(372);

    list!.scrollTop = 350;
    rectMap.set(editedRow!, new DOMRect(0, 22, 500, 80));

    const wheelAllowed = list?.dispatchEvent(
      new WheelEvent('wheel', { cancelable: true, deltaY: 80 })
    );

    expect(wheelAllowed).toBe(false);
    expect(list!.scrollTop).toBe(364);
  });

  it('reveals a partially hidden message panel when editing starts', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let scrollTopValue = 500;
    let editedRowDocumentTop = 380;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.dataset.msgId === 'user-2') {
          return new DOMRect(0, editedRowDocumentTop - scrollTopValue, 500, 180);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    startEditingMessage('user-2', 'session-1', 'Prompt 2');
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(scrollTopValue).toBe(372);
    editedRowDocumentTop = 340;
    animationFrames.flush();
    await Promise.resolve();
    expect(scrollTopValue).toBe(332);

    animationFrames.restore();
  });

  it('clamps an aligned sticky destination before the first editing frame', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let scrollTopValue = 500;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.dataset.msgId === 'user-2') {
          return new DOMRect(0, 502 - scrollTopValue, 500, 180);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    startEditingMessage('user-2', 'session-1', 'Prompt 2');
    await Promise.resolve();

    expect(scrollTopValue).toBe(494);
    animationFrames.flush();
    await Promise.resolve();
    expect(scrollTopValue).toBe(494);

    animationFrames.restore();
  });

  it('suspends bottom follow on edit entry until an explicit follow request', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    let scrollHeightValue = 1200;
    let trackHeight = 1200;
    const assignedScrollTops: number[] = [];

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        if (this.dataset.msgId === 'user-2') {
          return new DOMRect(0, 700 - scrollTopValue, 500, 80);
        }
        return new DOMRect(0, 0, 500, 100);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(scrollTopValue).toBe(800);

    startEditingMessage('user-2', 'session-1', 'Prompt 2');
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(scrollTopValue).toBe(692);

    trackHeight = 1400;
    scrollHeightValue = 1400;
    setState('streamingPartId', 'text-4');
    setState('streamingText', 'Streaming growth while editing');
    await Promise.resolve();

    expect(assignedScrollTops).not.toContain(1000);
    expect(scrollTopValue).toBe(692);

    resetMessageEditState();
    trackHeight = 1600;
    scrollHeightValue = 1600;
    setState('streamingText', 'More streaming growth after edit cancellation');
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(assignedScrollTops).not.toContain(1200);
    expect(scrollTopValue).toBe(692);

    requestMessageListScrollToBottom();
    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(1200);
    animationFrames.restore();
  });

  it('shows the prompt that belongs to the response currently in view', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
      { info: userMessage('user-3'), parts: [textPart('text-5', 'Prompt 3')] },
      { info: assistantMessage('assistant-3'), parts: [textPart('text-6', 'Response 3')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    const defaultRect = new DOMRect(0, -600, 500, 40);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || defaultRect;
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user3Row = container?.querySelector('[data-msg-id="user-3"]') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const assistant3Row = container?.querySelector(
      '[data-msg-id="assistant-3"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(user3Row).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);
    expect(assistant3Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));

    rectMap.set(user2Row!, new DOMRect(0, -220, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, -340, 500, 300));
    rectMap.set(user3Row!, new DOMRect(0, -90, 500, 52));
    rectMap.set(assistant3Row!, new DOMRect(0, 40, 500, 320));

    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    let sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.textContent).toContain('Prompt 3');

    rectMap.set(assistant2Row!, new DOMRect(0, 40, 500, 320));
    rectMap.set(user3Row!, new DOMRect(0, -80, 500, 52));
    rectMap.set(assistant3Row!, new DOMRect(0, 20, 500, 320));

    list!.scrollTop = 1400;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.textContent).toContain('Prompt 2');
    expect(
      container?.querySelectorAll('.interactive-list-track .latest-user-message-sticky')
    ).toHaveLength(1);
    expect(container?.querySelector('.latest-user-message-sticky [data-msg-id]')).toBeNull();

    animationFrames.restore();
  });

  it('uses mounted row geometry when virtual metrics point at a later turn', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 30 }, (_, turn) => [
        {
          info: userMessage(`user-${turn}`),
          parts: [textPart(`user-text-${turn}`, `Prompt ${turn}`)],
        },
        {
          info: assistantMessage(`assistant-${turn}`),
          parts: [textPart(`assistant-text-${turn}`, `Response ${turn}`)],
        },
      ]).flat()
    );

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-17') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-17') return new DOMRect(0, 20, 500, 160);
        if (this.dataset.msgId) return new DOMRect(0, -600, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, value: 9_600 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 6_400 });

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Prompt 17');

    animationFrames.restore();
  });

  it('keeps the previous sticky prompt while the next user row is lower in the viewport', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 30 }, (_, turn) => [
        {
          info: userMessage(`user-${turn}`),
          parts: [textPart(`user-text-${turn}`, `Prompt ${turn}`)],
        },
        {
          info: assistantMessage(`assistant-${turn}`),
          parts: [textPart(`assistant-text-${turn}`, `Response ${turn}`)],
        },
      ]).flat()
    );

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-20') return new DOMRect(0, 280, 500, 52);
        if (this.dataset.msgId) return new DOMRect(0, -600, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, value: 9_600 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 6_400 });

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Prompt 19');

    animationFrames.restore();
  });

  it('keeps the sticky prompt mounted while new assistant activity events arrive', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let assistantTop = 20;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 1_200);
        }
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, assistantTop, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1_200 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 700 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Prompt 1');

    const activity = toolPart('search-1', 'assistant-1', 'call-search-1');
    activity.tool = 'grep';
    assistantTop = -600;
    upsertPart(activity);
    for (const callback of resizeCallbacks) {
      callback([], fixture<ResizeObserver>({}));
    }
    animationFrames.flush();
    await Promise.resolve();

    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);

    // Incoming events can leave the row between painted layouts for longer than the debounce.
    // Keep the existing prompt until geometry positively says its source is visible or overlapped.
    await vi.advanceTimersByTimeAsync(100);

    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);

    assistantTop = 20;
    for (const callback of resizeCallbacks) {
      callback([], fixture<ResizeObserver>({}));
    }
    animationFrames.flush();
    await Promise.resolve();

    upsertPart({
      ...activity,
      state: {
        status: 'completed',
        input: { pattern: 'sticky' },
        output: 'Found matches',
        title: 'Searching',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    });
    for (const callback of resizeCallbacks) {
      callback([], fixture<ResizeObserver>({}));
    }
    animationFrames.flush();
    await Promise.resolve();

    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);
    animationFrames.restore();
  });

  it('hands off to the previous sticky after the next prompt clears the overlay', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let user2Top = -62;
    let assistant1Top = -600;
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }
        if (this.classList.contains('latest-user-message-sticky')) {
          return new DOMRect(0, 18, 500, 50);
        }
        if (this.classList.contains('latest-user-message-sticky-text')) {
          return new DOMRect(0, 22, 500, 18);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -700, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, assistant1Top, 500, 90);
        if (messageId === 'user-2') return new DOMRect(0, user2Top, 500, 52);
        if (messageId === 'assistant-2') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 1_200 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Prompt 2'
    );
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Prompt 2'
    );
    vi.advanceTimersByTime(181);
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Prompt 2'
    );
    const stickyText = container?.querySelector<HTMLElement>('.latest-user-message-sticky-text');
    expect(stickyText).toBeInstanceOf(HTMLDivElement);
    stickyText!.style.maxHeight = '72px';

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
    user2Top = -30;
    assistant1Top = 20;
    list.scrollTop = 1_180;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Prompt 2'
    );

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, bubbles: true }));
    user2Top = -50;
    list.scrollTop = 1_200;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Prompt 2'
    );

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
    user2Top = 70;
    assistant1Top = 20;
    list.scrollTop = 1_180;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
    user2Top = 120;
    list.scrollTop = 1_160;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Prompt 1'
    );

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
    user2Top = 150;
    list.scrollTop = 1_140;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Prompt 1'
    );
    animationFrames.restore();
  });

  it('synchronously hides the previous sticky before the next user row enters its painted overlay', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let nextUserTop = 220;
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }
        if (this.classList.contains('latest-user-message-sticky')) {
          return new DOMRect(0, 10, 500, 50);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, 20, 500, 280);
        if (messageId === 'user-2') return new DOMRect(0, nextUserTop, 500, 52);
        if (messageId === 'assistant-2') return new DOMRect(0, nextUserTop + 80, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1_200 });

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('.latest-user-message-sticky')).toBeInstanceOf(HTMLDivElement);

    nextUserTop = 90;
    list!.scrollTop = 1_330;
    list?.dispatchEvent(new Event('scroll'));
    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();

    animationFrames.restore();
  });

  it('hides the sticky when bottom-follow moves the next user row into its overlay', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const observers: Array<{
      callback: ResizeObserverCallback;
      targets: Set<Element>;
    }> = [];
    class TestResizeObserver {
      readonly targets = new Set<Element>();

      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    // SAFETY: The fixture provides the unknown fields read by this statement.
    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;

    let nextUserTop = 220;
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 1_700);
        }
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, 20, 500, 280);
        if (messageId === 'user-2') return new DOMRect(0, nextUserTop, 500, 52);
        if (messageId === 'assistant-2') return new DOMRect(0, nextUserTop + 80, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1_700 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 1_200 });
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('.latest-user-message-sticky')).toBeInstanceOf(HTMLDivElement);

    nextUserTop = 70;
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(list) && observer.targets.has(track)
    );
    expect(layoutObserver).toBeDefined();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    layoutObserver!.callback(
      [fixture<ResizeObserverEntry>({ target: track })],
      fixture<ResizeObserver>(layoutObserver)
    );
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();

    animationFrames.restore();
  });

  it('keeps the previous sticky when layout growth moves the next prompt below stale observer bounds', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const intersections = installControllableIntersectionObserver();
    let nextUserTop = 220;
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }
        if (this.classList.contains('latest-user-message-sticky')) {
          return new DOMRect(0, 10, 500, 50);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, 0, 500, 500);
        if (messageId === 'user-2') return new DOMRect(0, nextUserTop, 500, 52);
        if (messageId === 'assistant-2') return new DOMRect(0, nextUserTop + 80, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const assistant1 = container?.querySelector('[data-msg-id="assistant-1"]') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user2 = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 1_200 });

    const emitVisibleBounds = (observedUserTop: number) =>
      intersections.emit([
        {
          target: assistant1,
          isIntersecting: true,
          rootBounds: new DOMRect(0, 0, 500, 500),
          boundingClientRect: new DOMRect(0, 0, 500, 500),
        },
        {
          target: user2,
          isIntersecting: true,
          rootBounds: new DOMRect(0, 0, 500, 500),
          boundingClientRect: new DOMRect(0, observedUserTop, 500, 52),
        },
      ]);

    emitVisibleBounds(220);
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('.latest-user-message-sticky')).toBeInstanceOf(HTMLDivElement);

    nextUserTop = 70;
    emitVisibleBounds(70);
    list.scrollTop = 1_350;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();

    nextUserTop = 360;
    list.scrollTop = 1_210;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')).toBeInstanceOf(HTMLDivElement);

    animationFrames.restore();
  });

  it('hides the previous sticky when the next prompt reaches it without a new observer callback', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const intersections = installControllableIntersectionObserver();
    let nextUserTop = 220;
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }
        if (this.classList.contains('latest-user-message-sticky')) {
          return new DOMRect(0, 10, 500, 50);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, 0, 500, 500);
        if (messageId === 'user-2') return new DOMRect(0, nextUserTop, 500, 52);
        if (messageId === 'assistant-2') return new DOMRect(0, nextUserTop + 80, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const assistant1 = container?.querySelector('[data-msg-id="assistant-1"]') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user2 = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 1_200 });

    intersections.emit([
      {
        target: assistant1,
        isIntersecting: true,
        rootBounds: new DOMRect(0, 0, 500, 500),
        boundingClientRect: new DOMRect(0, 0, 500, 500),
      },
      {
        target: user2,
        isIntersecting: true,
        rootBounds: new DOMRect(0, 0, 500, 500),
        boundingClientRect: new DOMRect(0, 220, 500, 52),
      },
    ]);
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('.latest-user-message-sticky')).toBeInstanceOf(HTMLDivElement);

    nextUserTop = 70;
    list.scrollTop = 1_350;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();

    animationFrames.restore();
  });

  it('updates the active turn marker after a completed marker jump and later scroll', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    const messageTop = new Map<string, number>([
      ['user-1', 0],
      ['assistant-1', 80],
      ['user-2', 500],
      ['assistant-2', 580],
    ]);
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 500);
        }
        const row = this.classList.contains('interactive-item-container')
          ? this
          : this.closest<HTMLElement>('[data-msg-id]');
        const top = row?.dataset.msgId ? messageTop.get(row.dataset.msgId) : undefined;
        const height = row?.dataset.msgId?.startsWith('user-') ? 80 : 420;
        return top === undefined
          ? new DOMRect(0, -600, 500, 40)
          : new DOMRect(0, top - scrollTopValue, 500, height);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    container
      ?.querySelector<HTMLButtonElement>('.turn-navigation-marker[title^="Turn 2:"]')
      ?.click();
    animationFrames.flush();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(
      container
        ?.querySelector('.turn-navigation-marker[aria-current="step"]')
        ?.getAttribute('title')
    ).toContain('Turn 2:');
    expect(
      container?.querySelector('[data-msg-id="user-2"] .user-message-card')?.classList
    ).toContain('turn-navigation-destination');

    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    scrollTopValue = 0;
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(
      container
        ?.querySelector('.turn-navigation-marker[aria-current="step"]')
        ?.getAttribute('title')
    ).toContain('Turn 1:');
    animationFrames.restore();
  });

  it('updates rendered messages synchronously without waiting for the next animation frame', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, `Response ${index}`),
              messageID: messageId,
            },
          ],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 240 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, value: 10_000 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 0 });

    const firstRenderedMessageIdBeforeScroll =
      container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId;
    expect(firstRenderedMessageIdBeforeScroll).toBe('assistant-0');

    list!.scrollTop = 3_600;
    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
    list?.dispatchEvent(new Event('scroll'));
    list!.scrollTop = 4_800;
    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
    list?.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    const firstRenderedMessageIdAfterScroll =
      container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId;
    expect(firstRenderedMessageIdAfterScroll).not.toBe('assistant-0');

    animationFrames.flush();
    await Promise.resolve();

    const firstRenderedMessageIdAfterFrame =
      container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId;
    expect(firstRenderedMessageIdAfterFrame).not.toBe('assistant-0');

    animationFrames.restore();
  });

  it('shows sticky prompts for message IDs that are not valid CSS selector values', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const unusualUserId = 'user-2"]';
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage(unusualUserId), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    const unusualUserRow = [...container!.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
      (element) => element.dataset.msgId === unusualUserId
    );
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;

    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(unusualUserRow).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(unusualUserRow!, new DOMRect(0, -80, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 20, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.textContent).toContain('Prompt 2');

    animationFrames.restore();
  });

  it.each([
    {
      kind: 'text',
      parts: [textPart('text-3', 'Prompt 2')],
    },
    {
      kind: 'image-only',
      parts: [filePart('image-2', 'Image 2')],
    },
  ])(
    'aligns a small-transcript $kind sticky jump to the real card without scrolling its parent',
    async ({ parts }) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      let list: HTMLDivElement | null = null;
      let scrollTopValue = 1200;
      let outerScrollTop = 75;
      const rowDocumentTop = 1120;
      const cardDocumentTop = 1140;
      const stickyGap = 14;
      const scrollIntoView = vi.fn(() => {
        scrollTopValue = rowDocumentTop;
        outerScrollTop = 0;
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: scrollIntoView,
      });

      setState('activeSessionId', 'session-1');
      replaceMessages([
        { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
        { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
        { info: userMessage('user-2'), parts },
        { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
      ]);

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: HTMLElement) {
          if (this === list || this.classList.contains('interactive-list')) {
            return new DOMRect(0, 100, 500, 500);
          }
          const row = this.classList.contains('interactive-item-container')
            ? this
            : this.closest<HTMLElement>('[data-msg-id]');
          if (row?.dataset.msgId === 'user-2') {
            const documentTop = this.classList.contains('user-message-card')
              ? cardDocumentTop
              : rowDocumentTop;
            return new DOMRect(0, 100 + documentTop - scrollTopValue, 500, 52);
          }
          if (row?.dataset.msgId === 'assistant-2') {
            return new DOMRect(0, 120, 500, 320);
          }
          return new DOMRect(0, -600, 500, 40);
        }
      );

      cleanup = render(() => MessageList(), container!);
      await Promise.resolve();

      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      list = container?.querySelector('.interactive-list') as HTMLDivElement;
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      const card = container?.querySelector(
        '[data-msg-id="user-2"] .user-message-card'
      ) as HTMLDivElement;
      Object.defineProperty(container!, 'scrollTop', {
        configurable: true,
        get: () => outerScrollTop,
        set: (value: number) => {
          outerScrollTop = value;
        },
      });
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });
      track.style.setProperty('--latest-user-message-sticky-gap', `${stickyGap}px`);

      list.dispatchEvent(new Event('scroll'));
      animationFrames.flush();
      await Promise.resolve();

      const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
      expect(sticky).toBeInstanceOf(HTMLDivElement);
      sticky?.click();

      const computedStickyGap = Number.parseFloat(
        getComputedStyle(track).getPropertyValue('--latest-user-message-sticky-gap')
      );
      expect(
        Math.abs(
          card.getBoundingClientRect().top - list.getBoundingClientRect().top - computedStickyGap
        )
      ).toBeLessThanOrEqual(1);
      expect(outerScrollTop).toBe(75);
      expect(scrollIntoView).not.toHaveBeenCalled();
      animationFrames.restore();
    }
  );

  it('does not enter edit mode from a sticky click while the active session is running', async () => {
    // This verifies click ownership, not destination alignment.
    const animationFrames = installQueuedAnimationFrameMocks();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    setState('activeSessionId', 'session-1');
    startLoading(1);
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(user2Row!, new DOMRect(0, -80, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 20, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.hasAttribute('title')).toBe(false);

    sticky?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(editingMessage()).toBeNull();

    animationFrames.restore();
  });

  it('hides the first prompt sticky after navigating to it in a running session', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 1200;
    setState('activeSessionId', 'session-1');
    startLoading(1);
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'First prompt')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Running response')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 500);
        }
        const row = this.classList.contains('interactive-item-container')
          ? this
          : this.closest<HTMLElement>('[data-msg-id]');
        if (row?.dataset.msgId === 'user-1') {
          const documentTop = this.classList.contains('user-message-card') ? 4 : 0;
          return new DOMRect(0, documentTop - scrollTopValue, 500, 52);
        }
        if (row?.dataset.msgId === 'assistant-1') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = Math.max(0, value);
      },
    });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('First prompt');
    sticky?.click();
    animationFrames.flush();
    await Promise.resolve();

    expect(scrollTopValue).toBe(0);
    expect(
      container
        ?.querySelector<HTMLElement>('[data-msg-id="user-1"] .user-message-card')
        ?.getBoundingClientRect().bottom
    ).toBeGreaterThan(0);
    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();
    animationFrames.restore();
  });

  it('scrolls a measured terminal-attachment prompt within the message list only', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    let outerScrollTop = 60;
    let targetLayoutShift = 0;
    let jumpStarted = false;
    const targetIndex = 40;
    const targetScrollTop = targetIndex * 120;
    const stickyTopInset = 13;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list) return new DOMRect(0, 0, 500, 500);
        const row = this.classList.contains('interactive-item-container')
          ? this
          : this.closest<HTMLElement>('.interactive-item-container');
        const messageIndex = Number(row?.dataset.msgId?.replace('message-', ''));
        if (Number.isFinite(messageIndex)) {
          const layoutShift = messageIndex === targetIndex ? targetLayoutShift : 0;
          return new DOMRect(0, messageIndex * 120 - scrollTopValue + layoutShift, 500, 120);
        }
        return new DOMRect(0, 0, 500, 500);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => ({
        info:
          index === targetIndex
            ? userMessage(`message-${index}`)
            : assistantMessage(`message-${index}`),
        parts:
          index === targetIndex
            ? [
                {
                  ...textPart(`text-${index}-1`, '[Working directory: /workspace/varro]'),
                  messageID: `message-${index}`,
                },
                {
                  ...textPart(
                    `text-${index}-2`,
                    '[Selection from terminal zsh]\n```text\nnpm run test:e2e\n3 failed\n```'
                  ),
                  messageID: `message-${index}`,
                },
              ]
            : [
                {
                  ...textPart(`text-${index}`, `Response ${index}`),
                  messageID: `message-${index}`,
                },
              ],
      }))
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    Object.defineProperty(container!, 'scrollTop', {
      configurable: true,
      get: () => outerScrollTop,
      set: (value: number) => {
        outerScrollTop = value;
      },
    });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 6000 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        if (!jumpStarted && value === targetScrollTop - stickyTopInset) {
          jumpStarted = true;
          targetLayoutShift = -100;
        }
      },
    });
    track.style.setProperty('--latest-user-message-sticky-gap', `${stickyTopInset}px`);

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    scrollTopValue = 42 * 120;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Terminal: zsh (2 lines)');
    sticky?.click();

    const computedStickyGap = Number.parseFloat(
      getComputedStyle(track).getPropertyValue('--latest-user-message-sticky-gap')
    );
    expect(scrollTopValue).toBe(targetScrollTop - stickyTopInset);
    expect(
      container
        ?.querySelector<HTMLElement>(`[data-msg-id="message-${targetIndex}"] .user-message-card`)
        ?.getBoundingClientRect().top
    ).toBe(stickyTopInset - 100);
    animationFrames.flush();
    await Promise.resolve();
    const targetCard = container?.querySelector<HTMLElement>(
      `[data-msg-id="message-${targetIndex}"] .user-message-card`
    );
    expect(targetCard).toBeInstanceOf(HTMLDivElement);
    expect(
      Math.abs(
        targetCard!.getBoundingClientRect().top -
          list.getBoundingClientRect().top -
          computedStickyGap
      )
    ).toBeLessThanOrEqual(1);
    expect(outerScrollTop).toBe(60);

    const nestedScroller = document.createElement('div');
    nestedScroller.style.overflowY = 'auto';
    Object.defineProperty(nestedScroller, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(nestedScroller, 'scrollHeight', { configurable: true, value: 300 });
    Object.defineProperty(nestedScroller, 'scrollTop', { configurable: true, value: 50 });
    targetCard!.append(nestedScroller);
    const scrollTopBeforeNestedWheel = scrollTopValue;
    targetLayoutShift -= 40;
    nestedScroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 20 }));
    animationFrames.flush();
    await Promise.resolve();
    expect(scrollTopValue).toBe(scrollTopBeforeNestedWheel);
    targetLayoutShift += 40;

    const originalCard = container?.querySelector<HTMLElement>(
      `[data-msg-id="message-${targetIndex}"] .user-message-card`
    );
    originalCard?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(editingMessage()?.messageId).toBe(`message-${targetIndex}`);
    const scrollTopAfterEdit = scrollTopValue;
    targetLayoutShift -= 50;
    for (let frame = 0; frame < 3; frame += 1) {
      animationFrames.flush();
      await Promise.resolve();
    }
    expect(scrollTopValue).toBe(scrollTopAfterEdit - 50);
    expect(scrollIntoView).not.toHaveBeenCalled();
    animationFrames.restore();
  });

  it('restores image attachments when editing a message selected through its sticky preview', async () => {
    // Sticky destination geometry is covered separately; this case owns edit-state restoration.
    const animationFrames = installQueuedAnimationFrameMocks();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      {
        info: userMessage('user-2'),
        parts: [
          textPart('text-3', 'Still is shown as this. Before switching to [Image 2]'),
          filePart('image-2', 'Image 2'),
        ],
      },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user2Card = container?.querySelector(
      '[data-msg-id="user-2"] .user-message-card'
    ) as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(user2Card).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(user2Row!, new DOMRect(0, -80, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 20, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);

    sticky?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editingMessage()).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();

    user2Card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editingMessage()).toEqual({
      messageId: 'user-2',
      sessionId: 'session-1',
      text: 'Still is shown as this. Before switching to [Image 2]',
      context: {
        files: [],
        images: [
          {
            id: 'image-2',
            url: 'https://example.test/image-2.png',
            mime: 'image/png',
            filename: 'Image 2',
            size: 0,
          },
        ],
        terminalSelection: null,
      },
      model: { providerID: 'openai', modelID: 'gpt-5.4' },
    });

    animationFrames.restore();
  });

  it('edits an image-only message after selecting it through the sticky preview', async () => {
    // Sticky destination geometry is covered separately; this case owns image-only edit state.
    const animationFrames = installQueuedAnimationFrameMocks();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      {
        info: userMessage('user-2'),
        parts: [filePart('image-2', 'Image 2')],
      },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user2Card = container?.querySelector(
      '[data-msg-id="user-2"] .user-message-card'
    ) as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(user2Card).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(user2Row!, new DOMRect(0, -80, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 20, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.textContent).toContain('Attachment: Image 2');

    sticky?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editingMessage()).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();

    user2Card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editingMessage()).toEqual({
      messageId: 'user-2',
      sessionId: 'session-1',
      text: '',
      context: {
        files: [],
        images: [
          {
            id: 'image-2',
            url: 'https://example.test/image-2.png',
            mime: 'image/png',
            filename: 'Image 2',
            size: 0,
          },
        ],
        terminalSelection: null,
      },
      model: { providerID: 'openai', modelID: 'gpt-5.4' },
    });

    animationFrames.restore();
  });

  it('hides the sticky preview as soon as any part of the prompt is visible outside it', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    const defaultRect = new DOMRect(0, -600, 500, 40);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || defaultRect;
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const user2Card = container?.querySelector(
      '[data-msg-id="user-2"] .user-message-card'
    ) as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(user2Card).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(user2Row!, new DOMRect(0, -90, 500, 52));
    rectMap.set(user2Card!, new DOMRect(120, -90, 320, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 40, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    let sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Prompt 2');
    expect(sticky).toBeInstanceOf(HTMLDivElement);

    rectMap.set(sticky!, new DOMRect(0, 10, 500, 50));

    rectMap.set(user2Card!, new DOMRect(120, 30, 320, 40));
    list!.scrollTop = 1210;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky).toBeNull();

    animationFrames.restore();
  });
});
