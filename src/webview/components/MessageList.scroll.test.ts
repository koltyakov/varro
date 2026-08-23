import { describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import {
  replaceMessages,
  requestMessageListScrollToBottom,
  setMessagesIncremental,
  setShowInlineFileChanges,
  setShowThinkingPreference,
  setState,
  startLoading,
  state,
  stopLoading,
  upsertPart,
} from '../lib/state';
import { MessageList } from './MessageList';
import { setSessionHistoryCursor } from '../lib/message-window';
import { setExpandedDiffOverlay } from '../lib/diff-overlay-state';
import {
  assistantMessage,
  hasAssistantModelChangeBetween,
  installMessageListTestEnvironment,
  installQueuedAnimationFrameMocks,
  reasoningPart,
  testDiffOverlayOwner,
  textPart,
  toolPart,
  userMessage,
} from './MessageList.test-utils';
import { fixture } from '../test-fixtures';
import { navArrowDownIcon } from '../lib/ui-icons';
import { toCssUrl } from './UiIcon';

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

describe('MessageList auto-scroll', () => {
  it('updates the virtualized range when initial bottom scroll is programmatic', async () => {
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

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 7200 });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(scrollTopValue).toBe(6800);
    const firstRenderedMessageId =
      container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId;
    expect(firstRenderedMessageId).not.toBe('assistant-0');

    animationFrames.restore();
  });

  it('virtualizes after mount-time measurement when resize observers do not emit', async () => {
    // Principle: exact-height virtualization must still activate in test/no-layout environments.
    // If this regresses, the list falls back to rendering every row and future refactors may hide it
    // behind fake performance improvements.
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

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 7200 });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-item-container')) {
          return new DOMRect(0, 0, 500, 120);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 7200);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(40);
    expect(container?.querySelector('.virtual-spacer-top')).toBeTruthy();

    animationFrames.restore();
  });

  it.each(['insertion', 'removal'] as const)(
    'preserves a detached visible row across a structural %s during active slow scrolling',
    async (mutation) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      const baseMessages = Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      });
      const heightById = new Map(
        baseMessages.map((message, index) => [message.info.id, 70 + (index % 4) * 25])
      );
      let layoutIds = baseMessages.map((message) => message.info.id);
      let list: HTMLDivElement | null = null;
      let scrollTopValue = 0;
      const rowTop = (messageId: string) => {
        const index = layoutIds.indexOf(messageId);
        return layoutIds
          .slice(0, Math.max(0, index))
          .reduce((total, id) => total + (heightById.get(id) ?? 0), 0);
      };
      const totalHeight = () =>
        layoutIds.reduce((total, id) => total + (heightById.get(id) ?? 0), 0);

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: HTMLElement) {
          if (this === list || this.classList.contains('interactive-list')) {
            return new DOMRect(0, 0, 500, 400);
          }
          if (this.classList.contains('interactive-list-track')) {
            return new DOMRect(0, 0, 500, totalHeight());
          }
          const messageId = this.dataset.msgId;
          if (messageId && heightById.has(messageId)) {
            return new DOMRect(
              0,
              rowTop(messageId) - scrollTopValue,
              500,
              heightById.get(messageId)
            );
          }
          return new DOMRect(0, 0, 500, 40);
        }
      );

      setState('activeSessionId', 'session-1');
      replaceMessages(baseMessages);
      cleanup = render(() => MessageList(), container!);
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      list = container?.querySelector('.interactive-list') as HTMLDivElement;
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
      Object.defineProperty(list, 'scrollHeight', {
        configurable: true,
        get: totalHeight,
      });
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        animationFrames.flush();
      }
      const anchorId = 'assistant-25';
      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
      scrollTopValue = rowTop(anchorId) + 20;
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      animationFrames.flush();
      await Promise.resolve();

      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      const anchorBefore = container?.querySelector(
        `[data-msg-id="${anchorId}"]`
      ) as HTMLDivElement;
      expect(anchorBefore).toBeInstanceOf(HTMLDivElement);
      const anchorTopBefore = anchorBefore.getBoundingClientRect().top;

      const nextMessages = state.messages.map((message) => ({
        info: message.info,
        parts: message.parts,
      }));
      if (mutation === 'removal') {
        nextMessages.splice(4, 1);
      } else {
        const insertedId = 'assistant-inserted';
        heightById.set(insertedId, 135);
        nextMessages.splice(4, 0, {
          info: assistantMessage(insertedId),
          parts: [
            {
              ...textPart('text-inserted', 'Inserted response'),
              messageID: insertedId,
            },
          ],
        });
      }
      replaceMessages(nextMessages);
      layoutIds = nextMessages.map((message) => message.info.id);
      await Promise.resolve();
      animationFrames.flush();
      await Promise.resolve();

      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      const anchorAfter = container?.querySelector(`[data-msg-id="${anchorId}"]`) as HTMLDivElement;
      expect(anchorAfter).toBeInstanceOf(HTMLDivElement);
      expect(
        Math.abs(anchorAfter.getBoundingClientRect().top - anchorTopBefore)
      ).toBeLessThanOrEqual(0.5);
      animationFrames.restore();
    }
  );

  it('preserves the visible row for one mixed resize batch above, at, and below it', async () => {
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

    const rowHeights = Array.from({ length: 50 }, () => 100);
    const rowTop = (index: number) =>
      rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(
            0,
            0,
            500,
            rowHeights.reduce((total, height) => total + height, 0)
          );
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, rowTop(index) - scrollTopValue, 500, rowHeights[index]);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => rowHeights.reduce((total, height) => total + height, 0),
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 2000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchor = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const changedRows = [8, 14, 20, 25].map(
      (index) => container?.querySelector(`[data-msg-id="assistant-${index}"]`) as HTMLDivElement
    );
    expect(anchor).toBeInstanceOf(HTMLDivElement);
    expect(changedRows.every((row) => row instanceof HTMLDivElement)).toBe(true);
    const rowObserver = observers.find((observer) => observer.targets.has(anchor));
    expect(rowObserver).toBeDefined();
    const anchorTopBefore = anchor.getBoundingClientRect().top;

    rowHeights[8] = 130;
    rowHeights[14] = 80;
    rowHeights[20] = 180;
    rowHeights[25] = 160;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      changedRows.map((row, index) =>
        fixture<ResizeObserverEntry>({
          target: row,
          borderBoxSize: [{ blockSize: rowHeights[[8, 14, 20, 25][index]!]!, inlineSize: 500 }],
        })
      ),
      fixture<ResizeObserver>(rowObserver)
    );

    expect(scrollTopValue).toBe(2010);
    expect(anchor.getBoundingClientRect().top).toBe(anchorTopBefore);

    const belowRow = changedRows[3]!;
    rowHeights[25] = 200;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: belowRow,
          borderBoxSize: [{ blockSize: 200, inlineSize: 500 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );
    expect(scrollTopValue).toBe(2010);
    expect(anchor.getBoundingClientRect().top).toBe(anchorTopBefore);
    animationFrames.restore();
  });

  it('ignores delayed resize entries from unmounted rows', async () => {
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

    const rowHeight = 100;
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 50 * rowHeight);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * rowHeight - scrollTopValue, 500, rowHeight);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 50 * rowHeight });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const staleRow = container?.querySelector('[data-msg-id="assistant-49"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(staleRow));
    expect(staleRow).toBeInstanceOf(HTMLDivElement);
    expect(rowObserver).toBeDefined();

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 0;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('[data-msg-id="assistant-49"]')).toBeNull();

    const bottomSpacer = () =>
      Number.parseFloat(
        container?.querySelector<HTMLElement>('.virtual-spacer-bottom')?.style.height || '0'
      );
    const bottomPadBefore = bottomSpacer();
    document.body.append(staleRow);
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: staleRow,
          borderBoxSize: [{ blockSize: 500, inlineSize: 500 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );
    await Promise.resolve();

    expect(bottomSpacer()).toBe(bottomPadBefore);
    staleRow.remove();
    animationFrames.restore();
  });

  it('yields pending width measurement anchoring to direct user scroll input', async () => {
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

    const rowHeights = Array.from({ length: 50 }, () => 100);
    const rowTop = (index: number) =>
      rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(
            0,
            0,
            500,
            rowHeights.reduce((total, height) => total + height, 0)
          );
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, rowTop(index) - scrollTopValue, 500, rowHeights[index]);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 500 });
    Object.defineProperty(list, 'offsetWidth', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => rowHeights.reduce((total, height) => total + height, 0),
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 2000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    vi.advanceTimersByTime(600);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchor = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(anchor));
    expect(anchor).toBeInstanceOf(HTMLDivElement);
    expect(rowObserver).toBeDefined();
    const publishWidthMeasurement = (height: number, inlineSize: number) => {
      rowHeights[20] = height;
      // SAFETY: The fixture provides the unknown fields read by this statement.
      rowObserver!.callback(
        [
          fixture<ResizeObserverEntry>({
            target: anchor,
            borderBoxSize: [{ blockSize: height, inlineSize }],
          }),
        ],
        fixture<ResizeObserver>(rowObserver)
      );
    };

    publishWidthMeasurement(120, 420);
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
    scrollTopValue += 120;
    list.dispatchEvent(new Event('scroll'));
    const wheelOwnedTop = scrollTopValue;
    await Promise.resolve();
    expect(scrollTopValue).toBe(wheelOwnedTop);

    vi.advanceTimersByTime(600);
    publishWidthMeasurement(140, 380);
    list.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }));
    scrollTopValue += 200;
    list.dispatchEvent(new Event('scroll'));
    const keyboardOwnedTop = scrollTopValue;
    await Promise.resolve();
    expect(scrollTopValue).toBe(keyboardOwnedTop);

    vi.advanceTimersByTime(600);
    publishWidthMeasurement(160, 340);
    list.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 495 }));
    scrollTopValue += 100;
    list.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    const pointerOwnedTop = scrollTopValue;
    await Promise.resolve();
    expect(scrollTopValue).toBe(pointerOwnedTop);
    animationFrames.restore();
  });

  it('anchors width reflow to the visible row instead of a stale mounted row', async () => {
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

    const rowHeights = Array.from({ length: 50 }, () => 100);
    const rowTop = (index: number) =>
      rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(
            0,
            0,
            500,
            rowHeights.reduce((total, height) => total + height, 0)
          );
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, rowTop(index) - scrollTopValue, 500, rowHeights[index]);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 500 });
    Object.defineProperty(list, 'offsetWidth', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => rowHeights.reduce((total, height) => total + height, 0),
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }

    // Remember row 19 while it intersects the viewport, then let geometry move before the
    // ResizeObserver width batch. It remains mounted in overscan but row 20 is now first visible.
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 1975;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    scrollTopValue = 2010;

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const staleRow = container?.querySelector('[data-msg-id="assistant-19"]') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const visibleRow = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    const rowObserver = observers.find(
      (observer) => observer.targets.has(staleRow) && observer.targets.has(visibleRow)
    );
    expect(staleRow.getBoundingClientRect().bottom).toBe(-10);
    expect(visibleRow.getBoundingClientRect().top).toBe(-10);
    expect(rowObserver).toBeDefined();

    rowHeights[19] = 165;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: staleRow,
          borderBoxSize: [{ blockSize: 165, inlineSize: 360 }],
        }),
        fixture<ResizeObserverEntry>({
          target: visibleRow,
          borderBoxSize: [{ blockSize: 100, inlineSize: 360 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(visibleRow.getBoundingClientRect().top).toBe(-10);
    animationFrames.restore();
  });

  it('preserves a painted descendant when width reflow changes its row-relative position', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let hostWidth = 500;
    vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => hostWidth);

    const rowHeight = 300;
    let markerOffset = 140;
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, hostWidth, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, hostWidth, 50 * rowHeight);
        }
        const row = this.dataset.msgId
          ? this
          : (this.closest<HTMLElement>('[data-msg-id]') ?? null);
        const messageId = row?.dataset.msgId;
        if (messageId?.startsWith('assistant-')) {
          const index = Number(messageId.replace('assistant-', ''));
          const rowTop = index * rowHeight - scrollTopValue;
          if (this.matches('.rendered-markdown p')) {
            return new DOMRect(0, rowTop + markerOffset, hostWidth, 20);
          }
          return new DOMRect(0, rowTop, hostWidth, rowHeight);
        }
        return new DOMRect(0, 0, hostWidth, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, get: () => hostWidth });
    Object.defineProperty(list, 'offsetWidth', { configurable: true, get: () => hostWidth });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 50 * rowHeight });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 20 * rowHeight;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 0 }));

    scrollTopValue = 22 * rowHeight;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    const marker = container?.querySelector<HTMLElement>(
      '[data-msg-id="assistant-22"] .rendered-markdown p'
    );
    expect(marker?.getBoundingClientRect().top).toBe(140);

    markerOffset = 162;
    hostWidth = 360;
    window.dispatchEvent(new Event('resize'));
    expect(marker?.getBoundingClientRect().top).toBe(140);
    animationFrames.flush();
    expect(marker?.getBoundingClientRect().top).toBe(140);
    animationFrames.restore();
  });

  it('preserves the wheel destination when width reflow precedes the native scroll event', async () => {
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

    const rowHeights = Array.from({ length: 60 }, () => 100);
    const rowTop = (index: number) =>
      rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 786);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(
            0,
            0,
            500,
            rowHeights.reduce((total, height) => total + height, 0)
          );
        }
        const row = this.dataset.msgId
          ? this
          : (this.closest<HTMLElement>('[data-msg-id]') ?? null);
        const messageId = row?.dataset.msgId;
        if (messageId?.startsWith('user-') || messageId?.startsWith('assistant-')) {
          const index = Number(messageId.slice(messageId.lastIndexOf('-') + 1));
          const top = rowTop(index) - scrollTopValue;
          return this.classList.contains('user-message-card')
            ? new DOMRect(0, top + 6, 500, 40)
            : new DOMRect(0, top, 500, rowHeights[index]);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = index === 20 ? `user-${index}` : `assistant-${index}`;
        return {
          info: index === 20 ? userMessage(messageId) : assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Message ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 786 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 500 });
    Object.defineProperty(list, 'offsetWidth', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => rowHeights.reduce((total, height) => total + height, 0),
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 1976;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const precedingRow = container?.querySelector('[data-msg-id="assistant-19"]') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchorRow = container?.querySelector('[data-msg-id="user-20"]') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchorCard = anchorRow.querySelector('.user-message-card') as HTMLDivElement;
    const rowObserver = observers.find(
      (observer) => observer.targets.has(precedingRow) && observer.targets.has(anchorRow)
    );
    expect(anchorCard.getBoundingClientRect().top).toBe(30);
    expect(rowObserver).toBeDefined();

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 22 }));
    scrollTopValue += 22;
    expect(anchorCard.getBoundingClientRect().top).toBe(8);

    rowHeights[19] = 122;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: precedingRow,
          borderBoxSize: [{ blockSize: 122, inlineSize: 360 }],
        }),
        fixture<ResizeObserverEntry>({
          target: anchorRow,
          borderBoxSize: [{ blockSize: 100, inlineSize: 360 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );
    // Sample every reflow frame: a settled-only assertion can miss a one-frame jump that a
    // later correction hides.
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
      expect(anchorCard.getBoundingClientRect().top).toBe(8);
    }
    await Promise.resolve();

    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(anchorCard.getBoundingClientRect().top).toBe(8);
    animationFrames.restore();
  });

  it('does not treat a visible row below pre-message chrome as above the viewport', async () => {
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

    const chromeHeight = 48;
    const rowHeights: number[] = Array.from({ length: 50 }, (_, index) => (index === 0 ? 20 : 100));
    const rowTop = (index: number) =>
      chromeHeight + rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
    const totalHeight = () =>
      chromeHeight + rowHeights.reduce((total, height) => total + height, 0);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, -scrollTopValue, 500, totalHeight());
        }
        if (this.classList.contains('message-history-banner')) {
          return new DOMRect(0, 14 - scrollTopValue, 500, 22);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, rowTop(index) - scrollTopValue, 500, rowHeights[index]);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-older');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const historyBanner = container?.querySelector('.message-history-banner') as HTMLDivElement;
    track.style.paddingTop = '14px';
    historyBanner.style.marginBottom = '12px';
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: totalHeight });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 30;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const firstRow = container?.querySelector('[data-msg-id="assistant-0"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(firstRow));
    expect(rowObserver).toBeDefined();
    const topBefore = firstRow.getBoundingClientRect().top;
    expect(topBefore).toBe(18);

    rowHeights[0] = 40;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: firstRow,
          borderBoxSize: [{ blockSize: 40, inlineSize: 500 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );

    expect(firstRow.getBoundingClientRect().top).toBe(topBefore);
    expect(scrollTopValue).toBe(30);
    animationFrames.restore();
  });

  it('invalidates cached heights for offscreen reasoning rows when thinking visibility changes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 5000);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * 100 - scrollTopValue, 500, 100);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index < 40
              ? [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }]
              : [
                  {
                    ...reasoningPart(`reasoning-${index}`, `Reasoning ${index}`),
                    messageID: messageId,
                  },
                ],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 0;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id="assistant-40"]')).toBeNull();
    const bottomSpacer = () =>
      Number.parseFloat(
        container?.querySelector<HTMLElement>('.virtual-spacer-bottom')?.style.height || '0'
      );
    const bottomPadBefore = bottomSpacer();

    setShowThinkingPreference(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id="assistant-40"]')).toBeNull();
    // Compact activity already gives the follower rows zero height, so hiding thinking removes only
    // the disclosure owner's provisional height.
    expect(bottomSpacer() - bottomPadBefore).toBe(-100);
    animationFrames.restore();
  });

  it('invalidates an offscreen active edit height when inline previews are disabled', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 5000);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * 100 - scrollTopValue, 500, 100);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    const editMessageId = 'assistant-0';
    const edit = toolPart('edit-0', editMessageId, 'call-edit-0');
    edit.tool = 'apply_patch';
    edit.state = {
      status: 'completed',
      input: {
        patchText:
          '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const value = 1;\n+const value = 2;\n*** End Patch',
      },
      output: 'Done',
      title: 'apply_patch',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    setShowInlineFileChanges(true);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId, { parentID: 'user-1' }),
          parts:
            index === 0
              ? [edit]
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 2000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector(`[data-msg-id="${editMessageId}"]`)).toBeNull();
    const topSpacer = () =>
      Number.parseFloat(
        container?.querySelector<HTMLElement>('.virtual-spacer-top')?.style.height || '0'
      );
    const topPadBefore = topSpacer();

    setShowInlineFileChanges(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(container?.querySelector(`[data-msg-id="${editMessageId}"]`)).toBeNull();
    expect(topSpacer() - topPadBefore).toBe(60);
    animationFrames.restore();
  });

  it('preserves the visible row while invalidating offscreen thinking heights above it', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const rowHeights = Array.from({ length: 50 }, () => 100);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(
            0,
            0,
            500,
            rowHeights.reduce((sum, height) => sum + height, 0)
          );
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          const mountedIndexes = [
            ...(container?.querySelectorAll<HTMLElement>('[data-msg-id^="assistant-"]') || []),
          ].map((row) => Number(row.dataset.msgId!.replace('assistant-', '')));
          const firstMountedIndex = Math.min(...mountedIndexes, index);
          const topPad = Number.parseFloat(
            container?.querySelector<HTMLElement>('.virtual-spacer-top')?.style.height || '0'
          );
          const mountedHeightBefore = rowHeights
            .slice(firstMountedIndex, index)
            .reduce((sum, height) => sum + height, 0);
          return new DOMRect(
            0,
            topPad + mountedHeightBefore - scrollTopValue,
            500,
            rowHeights[index]
          );
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId, { parentID: 'user-1' }),
          parts:
            index < 5
              ? [
                  {
                    ...reasoningPart(`reasoning-${index}`, `Reasoning ${index}`),
                    messageID: messageId,
                  },
                ]
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => rowHeights.reduce((sum, height) => sum + height, 0),
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 2000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchor = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    expect(anchor).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="assistant-0"]')).toBeNull();
    const anchorTopBefore = anchor.getBoundingClientRect().top;
    rowHeights[0] = 40;
    for (let index = 1; index < 5; index += 1) rowHeights[index] = 0;

    setShowThinkingPreference(false);
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }

    expect(anchor.isConnected).toBe(true);
    expect(anchor.getBoundingClientRect().top).toBe(anchorTopBefore);
    animationFrames.restore();
  });

  it('does not give an explicitly render-empty row a provisional virtual height', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 4900);
        }
        if (this.dataset.msgId) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          const height = index === 0 ? 0 : 100;
          return new DOMRect(0, index * 100 - scrollTopValue, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 0
              ? []
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 4900 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    expect(
      container?.querySelector('.interactive-list-track')?.classList.contains('virtualized')
    ).toBe(true);

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 3000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId).toBe(
      'assistant-16'
    );
    animationFrames.restore();
  });

  it('retains the prior height when a rendered nonempty row reports a transient zero', async () => {
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
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 5000);
        }
        if (this.dataset.msgId) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * 100 - scrollTopValue, 500, 100);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const firstRow = container?.querySelector('[data-msg-id="assistant-0"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(firstRow));
    expect(firstRow.childElementCount).toBeGreaterThan(0);
    expect(rowObserver).toBeDefined();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: firstRow,
          borderBoxSize: [{ blockSize: 0, inlineSize: 500 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 3000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId).toBe(
      'assistant-15'
    );
    animationFrames.restore();
  });

  it('remounts and remeasures a cached zero-height row after it gains content', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const zeroRowHasContent =
          state.messages.find((message) => message.info.id === 'assistant-30')?.parts.length !== 0;
        const trackHeight = zeroRowHasContent ? 5000 : 4900;
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        if (this.dataset.msgId) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          const height = index === 30 && !zeroRowHasContent ? 0 : 100;
          const documentTop =
            index <= 30 ? index * 100 : index * 100 - (zeroRowHasContent ? 0 : 100);
          return new DOMRect(0, documentTop - scrollTopValue, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 30
              ? []
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () =>
        state.messages.find((message) => message.info.id === 'assistant-30')?.parts.length
          ? 5000
          : 4900,
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    scrollTopValue = 4450;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeNull();

    let emptyRowRemounted = false;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof HTMLElement &&
            (node.dataset.msgId === 'assistant-30' ||
              node.querySelector('[data-msg-id="assistant-30"]'))
          ) {
            emptyRowRemounted = true;
          }
        }
      }
    });
    mutationObserver.observe(track, { childList: true, subtree: true });
    upsertPart({
      ...textPart('text-0-extra', 'An unrelated message changed'),
      messageID: 'assistant-0',
    });
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(emptyRowRemounted).toBe(false);

    upsertPart({
      ...textPart('text-30', 'Content appeared after the zero-height row unmounted'),
      messageID: 'assistant-30',
    });
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeInstanceOf(HTMLDivElement);
    mutationObserver.disconnect();
    animationFrames.restore();
  });

  it('makes a cached zero-height row provisional when it gains model chrome', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const hasModelChange = hasAssistantModelChangeBetween('assistant-29', 'assistant-30');
        const trackHeight = hasModelChange ? 5000 : 4900;
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        if (this.dataset.msgId) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          const height = index === 30 && !hasModelChange ? 0 : 100;
          const documentTop = index <= 30 ? index * 100 : index * 100 - (hasModelChange ? 0 : 100);
          return new DOMRect(0, documentTop - scrollTopValue, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 30
              ? []
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => (hasAssistantModelChangeBetween('assistant-29', 'assistant-30') ? 5000 : 4900),
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    scrollTopValue = 4450;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeNull();

    replaceMessages(
      state.messages.map((message) =>
        message.info.id === 'assistant-29'
          ? {
              ...message,
              info: assistantMessage('assistant-29', {
                modelID: 'claude-sonnet-4',
                providerID: 'anthropic',
              }),
            }
          : message
      )
    );
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const remountedRow = container?.querySelector('[data-msg-id="assistant-30"]');
    expect(remountedRow).toBeInstanceOf(HTMLDivElement);
    expect(remountedRow?.querySelector('.model-change-indicator')).not.toBeNull();
    animationFrames.restore();
  });

  it('remounts an offscreen cached zero-height row after the same text part becomes visible', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const zeroRowHasContent = !!state.messages
          .find((message) => message.info.id === 'assistant-30')
          ?.parts.find((part) => part.id === 'text-30' && part.type === 'text' && part.text.trim());
        const trackHeight = zeroRowHasContent ? 5000 : 4900;
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        if (this.dataset.msgId) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          const height = index === 30 && !zeroRowHasContent ? 0 : 100;
          const documentTop =
            index <= 30 ? index * 100 : index * 100 - (zeroRowHasContent ? 0 : 100);
          return new DOMRect(0, documentTop - scrollTopValue, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, index === 30 ? '' : `Response ${index}`),
              messageID: messageId,
            },
          ],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () =>
        state.messages
          .find((message) => message.info.id === 'assistant-30')
          ?.parts.find((part) => part.id === 'text-30' && part.type === 'text' && part.text.trim())
          ? 5000
          : 4900,
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    scrollTopValue = 4450;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeNull();

    upsertPart({
      ...textPart('text-30', 'The existing part is now visible'),
      messageID: 'assistant-30',
    });
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const remountedRow = container?.querySelector('[data-msg-id="assistant-30"]');
    expect(remountedRow).toBeInstanceOf(HTMLDivElement);
    expect(remountedRow?.textContent).toContain('The existing part is now visible');
    animationFrames.restore();
  });

  it('cancels pending width work when async initial messages arrive or the list unmounts', async () => {
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

    let listWidth = 500;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-item-container')) {
          return new DOMRect(0, 0, listWidth, 120);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, listWidth, 6000);
        }
        return new DOMRect(0, 0, listWidth, 500);
      }
    );

    setState('activeSessionId', 'session-1');
    cleanup = render(() => MessageList(), container!);
    const list = container!.querySelector('.interactive-list')!;
    const track = container!.querySelector('.interactive-list-track')!;
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(list) && observer.targets.has(track)
    );
    expect(layoutObserver).toBeDefined();

    listWidth = 420;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback([], fixture<ResizeObserver>(layoutObserver));
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(container?.querySelector('.interactive-list-track.virtualized')).toBeTruthy();
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(40);
    await vi.advanceTimersByTimeAsync(100);
    expect(container?.querySelector('.interactive-list-track.virtualized')).toBeTruthy();

    listWidth = 400;
    const timersBeforeResize = vi.getTimerCount();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback([], fixture<ResizeObserver>(layoutObserver));
    expect(vi.getTimerCount()).toBeGreaterThan(timersBeforeResize);
    cleanup();
    cleanup = undefined;
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBeforeResize);
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBeforeResize);
  });

  it('stays pinned to the real bottom when virtualized messages update in place', async () => {
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

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollTopValue = 0;
    let scrollHeightValue = 7200;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(scrollTopValue).toBe(6800);

    scrollTopValue = 6800;
    scrollHeightValue = 7440;
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(
                `text-${index}`,
                index === 59 ? 'Updated response with more content' : `Response ${index}`
              ),
              messageID: messageId,
            },
          ],
        };
      })
    );

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(scrollTopValue).toBe(7040);
    animationFrames.restore();
  });

  it('keeps correcting initial bottom scroll when scrollHeight shifts without track growth', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(scrollTopValue).toBe(800);

    scrollHeightValue = 1700;
    trackHeight = 1200;
    animationFrames.flush();

    expect(scrollTopValue).toBe(1300);
    animationFrames.restore();
  });

  it('keeps bottom follow active after a downward wheel that cannot move the list', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
    trackHeight = 1600;
    scrollHeightValue = 1600;
    animationFrames.flush();

    expect(scrollTopValue).toBe(1200);
    animationFrames.restore();
  });

  it('restarts bottom follow after a downward wheel cancels its pending frame', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
    ]);
    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(scrollTopValue).toBe(800);

    trackHeight = 1600;
    scrollHeightValue = 1600;
    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
    setState('streamingPartId', 'text-2');
    setState('streamingText', 'Streaming growth');
    await Promise.resolve();

    expect(scrollTopValue).toBe(1200);
    animationFrames.flush();
    animationFrames.restore();
  });

  it('keeps the latest message fully visible when the last response grows', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 1200 });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 1700 });
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('text-2', 'Expanded response'), textPart('text-3', 'More content')],
      },
    ]);

    await Promise.resolve();
    await Promise.resolve();

    expect(scrollTopValue).toBe(1300);
  });

  it('corrects bottom scroll immediately when rendered content resizes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    trackHeight = 1700;
    scrollHeightValue = 1700;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(1300);
    animationFrames.restore();
  });

  it('keeps following running tool growth when a resize notification is delayed', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Run checks')] },
      { info: assistantMessage('assistant-1'), parts: [toolPart('tool-1', 'assistant-1')] },
    ]);
    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(scrollTopValue).toBe(800);
    animationFrames.flush();

    trackHeight = 1700;
    scrollHeightValue = 1700;
    animationFrames.flush();

    expect(scrollTopValue).toBe(1300);
    animationFrames.restore();
  });

  it('keeps following delayed layout growth after final parts arrive in one batch', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    const userEntry = {
      info: userMessage('user-1'),
      parts: [textPart('text-1', 'Explain the result')],
    };
    setState('activeSessionId', 'session-1');
    replaceMessages([
      userEntry,
      {
        info: assistantMessage('assistant-1'),
        parts: [{ ...textPart('text-2', 'Initial response'), messageID: 'assistant-1' }],
      },
    ]);
    setState('streamingPartId', 'text-2');
    setState('streamingText', 'Initial response');
    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    setMessagesIncremental([
      userEntry,
      {
        info: assistantMessage('assistant-1'),
        parts: Array.from({ length: 20 }, (_, index) => ({
          ...textPart(`text-${index + 2}`, `Final response section ${index + 1}`),
          messageID: 'assistant-1',
        })),
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    // The first post-stream frame runs before deferred markdown and entrance layout settles.
    animationFrames.flush();
    trackHeight = 1800;
    scrollHeightValue = 1800;
    animationFrames.flush();

    expect(scrollTopValue).toBe(1400);
    animationFrames.restore();
  });

  it('keeps following delayed layout growth while the session is still working', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Explain the result')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Committed response')] },
    ]);
    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    trackHeight = 1800;
    scrollHeightValue = 1800;
    animationFrames.flush();

    expect(scrollTopValue).toBe(1400);
    animationFrames.restore();
  });

  it('keeps following deferred final layout after loading completes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Explain the result')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Final response')] },
    ]);
    startLoading(1);
    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    stopLoading();
    await Promise.resolve();
    animationFrames.flush();

    trackHeight = 1800;
    scrollHeightValue = 1800;
    animationFrames.flush();

    expect(scrollTopValue).toBe(1400);
    animationFrames.restore();
  });

  it('synchronizes a browser bottom clamp when grouped activity shrinks during follow', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    let scrollHeightValue = 5000;
    let trackHeight = 5000;

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

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * 100 - scrollTopValue, 500, 100);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 49
              ? [toolPart('tool-49', messageId)]
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
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
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    expect(scrollTopValue).toBe(4600);
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([fixture<ResizeObserverEntry>({ target: list })], {} as ResizeObserver);
    }
    animationFrames.flush();

    trackHeight = 5500;
    scrollHeightValue = 5500;
    requestMessageListScrollToBottom();
    await Promise.resolve();
    expect(scrollTopValue).toBe(5100);

    trackHeight = 1000;
    scrollHeightValue = 1000;
    // Chrome clamps to the new bottom during layout, before it necessarily dispatches scroll.
    scrollTopValue = 600;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id]')?.getAttribute('data-msg-id')).toBe(
      'assistant-0'
    );
    animationFrames.restore();
  });

  it('does not auto-scroll again when the track bounces back to an already-followed height', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    trackHeight = 1700;
    scrollHeightValue = 1700;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();
    expect(scrollTopValue).toBe(1300);

    const assignmentCountAfterGrowth = assignedScrollTops.length;

    trackHeight = 1688;
    scrollHeightValue = 1688;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();
    expect(assignedScrollTops).toHaveLength(assignmentCountAfterGrowth);

    trackHeight = 1700;
    scrollHeightValue = 1700;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterGrowth);
    expect(scrollTopValue).toBe(1300);
    animationFrames.restore();
  });

  it('keeps following when non-scroll pointer input precedes a layout clamp', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'clientWidth', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'offsetWidth', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    scrollHeightValue = 400;
    list?.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, clientX: 495 }));
    scrollHeightValue = 1200;
    list?.firstElementChild?.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, bubbles: true, clientX: 495 })
    );
    // The browser can clamp scrollTop while content briefly shrinks, then deliver the scroll
    // event only after the old bottom target has returned.
    scrollTopValue = 760;
    list?.dispatchEvent(new Event('scroll'));

    trackHeight = 1400;
    scrollHeightValue = 1400;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(1000);
    animationFrames.restore();
  });

  it('ignores external PageUp but stops following after in-list PageUp movement', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    const externalButton = document.createElement('button');
    container?.appendChild(externalButton);
    externalButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    scrollTopValue = 500;
    list?.dispatchEvent(new Event('scroll'));

    trackHeight = 1400;
    scrollHeightValue = 1400;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(1000);

    list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    scrollTopValue = 700;
    list?.dispatchEvent(new Event('scroll'));

    trackHeight = 1600;
    scrollHeightValue = 1600;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(700);
    animationFrames.restore();
  });

  it.each([
    { name: 'classic', clientWidth: 484 },
    { name: 'overlay', clientWidth: 500 },
  ])('stops following after $name scrollbar pointer-originated upward scrolling', async (args) => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'clientWidth', {
      configurable: true,
      value: args.clientWidth,
    });
    Object.defineProperty(list!, 'offsetWidth', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, clientX: 495 }));
    scrollTopValue = 500;
    list?.dispatchEvent(new Event('scroll'));

    trackHeight = 1400;
    scrollHeightValue = 1400;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(500);
    animationFrames.restore();
  });

  it('resumes after nested diff input without outer movement but not after diff keyboard scrolling', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    const diffViewport = document.createElement('div');
    diffViewport.className = 'diff-view-lines';
    diffViewport.tabIndex = 0;
    list?.appendChild(diffViewport);
    const externalButton = document.createElement('button');
    container?.appendChild(externalButton);

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    diffViewport.focus();
    diffViewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    externalButton.focus();
    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();

    trackHeight = 1400;
    scrollHeightValue = 1400;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();
    expect(scrollTopValue).toBe(1000);

    diffViewport.focus();
    diffViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    scrollTopValue = 700;
    list?.dispatchEvent(new Event('scroll'));
    externalButton.focus();
    await Promise.resolve();
    await Promise.resolve();

    trackHeight = 1600;
    scrollHeightValue = 1600;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(700);
    animationFrames.restore();
  });

  it('does not rewrite scrollTop when resize leaves the list already at bottom', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    const assignmentCountAfterInitialScroll = assignedScrollTops.length;
    trackHeight = 1700;
    scrollHeightValue = 1700;
    scrollTopValue = 1300;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterInitialScroll);
    expect(scrollTopValue).toBe(1300);
    animationFrames.restore();
  });

  it('does not snap back to bottom after a small upward scroll near the threshold', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    scrollTopValue = 760;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();

    const assignmentCountAfterUserScroll = assignedScrollTops.length;

    trackHeight = 1240;
    scrollHeightValue = 1240;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterUserScroll);
    expect(scrollTopValue).toBe(760);
    animationFrames.restore();
  });

  it('does not re-pin to bottom after loading settles when the user moved slightly upward', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);
    startLoading(1);

    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 1200 });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    scrollTopValue = 760;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    const assignmentCountAfterUserScroll = assignedScrollTops.length;

    stopLoading();
    await Promise.resolve();
    animationFrames.flush();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterUserScroll);
    expect(scrollTopValue).toBe(760);
    animationFrames.restore();
  });

  it('keeps auto-scroll enabled when the bottom target shifts before a near-bottom scroll event', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    scrollHeightValue = 1240;
    scrollTopValue = 800;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();

    trackHeight = 1240;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(assignedScrollTops.at(-1)).toBe(840);
    expect(scrollTopValue).toBe(840);
    animationFrames.restore();
  });

  it('releases the send-triggered follow lock after bottom scroll stabilizes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    scrollTopValue = 400;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();

    requestMessageListScrollToBottom();
    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    animationFrames.flush();
    animationFrames.flush();
    animationFrames.flush();

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    scrollTopValue = 760;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();

    trackHeight = 1240;
    scrollHeightValue = 1240;
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(assignedScrollTops.at(-1)).toBe(800);
    expect(scrollTopValue).toBe(760);
    animationFrames.restore();
  });

  it('never reverses a downward user scroll during the measured append transition', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const baseMessages = Array.from({ length: 50 }, (_, index) => {
      const messageId = `assistant-${index}`;
      return {
        info: assistantMessage(messageId),
        parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
      };
    });
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    let scrollHeightValue = 5000;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, scrollHeightValue);
        }
        if (this.dataset.msgId) {
          const index =
            this.dataset.msgId === 'assistant-appended'
              ? 50
              : Number(this.dataset.msgId.replace('assistant-', ''));
          const height = index === 50 ? 200 : 100;
          return new DOMRect(0, index * 100 - scrollTopValue, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(baseMessages);

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
      },
    });
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    expect(scrollTopValue).toBe(4600);

    scrollHeightValue = 5200;
    replaceMessages([
      ...baseMessages,
      {
        info: assistantMessage('assistant-appended'),
        parts: [
          {
            ...textPart('text-appended', 'Appended response'),
            messageID: 'assistant-appended',
          },
        ],
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush(30);

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    scrollTopValue += 100;
    const userOwnedTop = scrollTopValue;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush(60);

    expect(scrollTopValue).toBeGreaterThanOrEqual(userOwnedTop);
    animationFrames.restore();
  });

  it('keeps following new messages after an explicit scroll request from a recent wheel scroll', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
    scrollTopValue = 400;
    list?.dispatchEvent(new Event('scroll'));

    requestMessageListScrollToBottom();
    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    animationFrames.flush();
    animationFrames.flush();

    trackHeight = 1600;
    scrollHeightValue = 1600;
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Follow-up response')] },
    ]);
    await Promise.resolve();
    animationFrames.flush();

    expect(assignedScrollTops.at(-1)).toBe(1200);
    expect(scrollTopValue).toBe(1200);
    animationFrames.restore();
  });

  it('re-attaches to bottom again on the next explicit scroll request', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const trackHeight = 1200;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    const scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    requestMessageListScrollToBottom();
    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    animationFrames.flush();
    animationFrames.flush();
    animationFrames.flush();

    scrollTopValue = 760;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();

    const assignmentCountAfterNearBottomScroll = assignedScrollTops.length;

    requestMessageListScrollToBottom();
    await Promise.resolve();
    animationFrames.flush();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterNearBottomScroll + 1);
    expect(assignedScrollTops.at(-1)).toBe(800);
    expect(scrollTopValue).toBe(800);
    animationFrames.restore();
  });

  it('reacts to trailing permission growth when jump-to-latest crosses its threshold', async () => {
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

    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    let trailingHeight = 0;
    const messageHeight = 100;
    const messageTrackHeight = 50 * messageHeight;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, messageTrackHeight + trailingHeight);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * messageHeight - scrollTopValue, 500, messageHeight);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => messageTrackHeight + trailingHeight,
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    scrollTopValue = messageTrackHeight - list.clientHeight - 220;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(container?.querySelector('.jump-to-latest-button')).toBeNull();

    trailingHeight = 100;
    setState('permissions', [
      {
        id: 'permission-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: '',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ]);
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(list!) && observer.targets.has(track)
    );
    expect(layoutObserver).toBeDefined();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback(
      [fixture<ResizeObserverEntry>({ target: track })],
      fixture<ResizeObserver>(layoutObserver)
    );
    await Promise.resolve();

    expect(container?.querySelector('.jump-to-latest-button')).toBeInstanceOf(HTMLButtonElement);
    animationFrames.restore();
  });

  it('shows the jump-to-latest button after scrolling away and returns to bottom on click', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    const scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);
    expect(container?.querySelector('.jump-to-latest-button')).toBeNull();

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
    scrollTopValue = 200;
    list?.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const button = container?.querySelector('.jump-to-latest-button') as HTMLButtonElement | null;
    expect(button).toBeInstanceOf(HTMLButtonElement);
    const icon = button?.querySelector<HTMLElement>('.ui-icon');
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('14px');
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(navArrowDownIcon));

    setExpandedDiffOverlay(testDiffOverlayOwner, true);
    expect(container?.querySelector('.jump-to-latest-button')).toBeNull();

    setExpandedDiffOverlay(testDiffOverlayOwner, false);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const restoredButton = container?.querySelector(
      '.jump-to-latest-button'
    ) as HTMLButtonElement | null;
    expect(restoredButton).toBeInstanceOf(HTMLButtonElement);

    restoredButton?.click();
    await Promise.resolve();
    animationFrames.flush();

    expect(scrollTopValue).toBe(800);
    expect(container?.querySelector('.jump-to-latest-button')).toBeNull();
    animationFrames.restore();
  });
});
