import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type * as AssistantDialogModule from '../components/message-list/assistant-dialog';
import type * as StickyPreviewModule from '../components/message-list/sticky-preview';

const { assistantDialogSummaryPasses, stickyPreviewSelectionPasses } = vi.hoisted(() => ({
  assistantDialogSummaryPasses: { value: 0 },
  stickyPreviewSelectionPasses: { value: 0 },
}));

vi.mock('../components/message-list/assistant-dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof AssistantDialogModule>();
  return {
    ...actual,
    getAssistantDialogSummaryMap: (
      ...args: Parameters<typeof actual.getAssistantDialogSummaryMap>
    ) => {
      assistantDialogSummaryPasses.value += 1;
      return actual.getAssistantDialogSummaryMap(...args);
    },
  };
});

vi.mock('../components/message-list/sticky-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof StickyPreviewModule>();
  return {
    ...actual,
    getStickyUserMessagePreview: (
      ...args: Parameters<typeof actual.getStickyUserMessagePreview>
    ) => {
      stickyPreviewSelectionPasses.value += 1;
      return actual.getStickyUserMessagePreview(...args);
    },
  };
});

import { MessageList } from '../components/MessageList';
import { replaceMessages, resetDefaultAppState, setState, upsertMessageInfo } from '../lib/state';
import type { AssistantMessage, Message, Part, TextPart, UserMessage } from '../types';
import { settlePerfEffects } from './harness';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let originalWindowResizeObserver: typeof window.ResizeObserver | undefined;
let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
let originalWindowRequestAnimationFrame: typeof window.requestAnimationFrame | undefined;
let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
let originalWindowCancelAnimationFrame: typeof window.cancelAnimationFrame | undefined;

function createUserMessage(id: string): UserMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
  };
}

function createAssistantMessage(id: string): AssistantMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'parent-1',
    modelID: 'gpt-4o',
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
  };
}

function createTextPart(id: string, messageID: string, text: string): TextPart {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'text',
    text,
  };
}

function entry(info: Message, parts: Part[]) {
  return { info, parts };
}

function resizeObserverEntry(
  target: Element,
  inlineSize: number,
  blockSize: number
): ResizeObserverEntry {
  const size: ResizeObserverSize = { inlineSize, blockSize };
  return {
    target,
    borderBoxSize: [size],
    contentBoxSize: [size],
    contentRect: new DOMRect(0, 0, inlineSize, blockSize),
    devicePixelContentBoxSize: [size],
  };
}

describe('MessageList virtualization perf guards', () => {
  beforeEach(() => {
    resetDefaultAppState();
    assistantDialogSummaryPasses.value = 0;
    stickyPreviewSelectionPasses.value = 0;
    container = document.createElement('div');
    document.body.appendChild(container);

    originalResizeObserver = globalThis.ResizeObserver;
    originalWindowResizeObserver = window.ResizeObserver;
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalWindowRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    originalWindowCancelAnimationFrame = window.cancelAnimationFrame;

    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    const requestAnimationFrameStub = vi.fn().mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const cancelAnimationFrameStub = vi.fn();

    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: ResizeObserverStub,
    });
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: ResizeObserverStub,
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: requestAnimationFrameStub,
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: requestAnimationFrameStub,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: cancelAnimationFrameStub,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: cancelAnimationFrameStub,
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    container?.remove();
    container = null;

    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: originalResizeObserver,
    });
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: originalWindowResizeObserver,
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame,
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalWindowRequestAnimationFrame,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalCancelAnimationFrame,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalWindowCancelAnimationFrame,
    });

    resetDefaultAppState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders only a bounded row window for large transcripts', async () => {
    // Principle: once the exact-height bootstrap completes, large transcripts must return to a
    // bounded DOM window with virtual spacers. Rendering the whole transcript is a regression.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-item-container')) {
          return new DOMRect(0, 0, 500, 120);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 24_000);
        }
        return new DOMRect(0, 0, 500, 500);
      }
    );

    replaceMessages(
      Array.from({ length: 200 }, (_, index) => {
        const id = `message-${index}`;
        const info = index % 2 === 0 ? createUserMessage(id) : createAssistantMessage(id);
        return entry(info, [createTextPart(`part-${index}`, id, `Message ${index}`)]);
      })
    );
    setState('activeSessionId', 'session-1');

    cleanup = render(() => MessageList(), container!);
    await settlePerfEffects();

    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(80);
    expect(container?.querySelector('.interactive-item-off-core')).toBeTruthy();
    expect(container?.querySelector('.virtual-spacer-bottom')).toBeTruthy();
  });

  it('does not rebuild assistant dialog summaries as the virtual window scrolls', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-item-container')) {
          return new DOMRect(0, 0, 500, 120);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 24_000);
        }
        return new DOMRect(0, 0, 500, 500);
      }
    );

    replaceMessages(
      Array.from({ length: 200 }, (_, index) => {
        const id = `message-${index}`;
        const info = index % 2 === 0 ? createUserMessage(id) : createAssistantMessage(id);
        return entry(info, [createTextPart(`part-${index}`, id, `Message ${index}`)]);
      })
    );
    setState('activeSessionId', 'session-1');

    cleanup = render(() => MessageList(), container!);
    await settlePerfEffects();

    const list = container!.querySelector<HTMLElement>('.interactive-list')!;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 24_000 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });
    const initialPasses = assistantDialogSummaryPasses.value;

    for (let step = 1; step <= 10; step += 1) {
      list.scrollTop = step * 1_200;
      list.dispatchEvent(new Event('scroll'));
      await settlePerfEffects();
    }

    expect(assistantDialogSummaryPasses.value).toBe(initialPasses);

    upsertMessageInfo({
      ...createAssistantMessage('message-199'),
      tokens: {
        input: 10,
        output: 5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
    await settlePerfEffects();

    expect(assistantDialogSummaryPasses.value).toBe(initialPasses + 1);
  });

  it('coalesces sticky viewport and virtual-range work into one frame pass', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-item-container')) {
          return new DOMRect(0, 0, 500, 120);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 24_000);
        }
        return new DOMRect(0, 0, 500, 500);
      }
    );

    replaceMessages(
      Array.from({ length: 200 }, (_, index) => {
        const id = `message-${index}`;
        const info = index % 2 === 0 ? createUserMessage(id) : createAssistantMessage(id);
        return entry(info, [createTextPart(`part-${index}`, id, `Message ${index}`)]);
      })
    );
    setState('activeSessionId', 'session-1');

    cleanup = render(() => MessageList(), container!);
    await settlePerfEffects();

    const list = container!.querySelector<HTMLElement>('.interactive-list')!;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 24_000 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 6_000 });
    list.dispatchEvent(new Event('scroll'));
    await settlePerfEffects();

    let nextFrameId = 1;
    const pendingFrames = new Map<number, FrameRequestCallback>();
    const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      pendingFrames.set(id, callback);
      return id;
    });
    const cancelAnimationFrameMock = vi.fn((id: number) => pendingFrames.delete(id));
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: requestAnimationFrameMock,
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: requestAnimationFrameMock,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: cancelAnimationFrameMock,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: cancelAnimationFrameMock,
    });

    stickyPreviewSelectionPasses.value = 0;
    list.scrollTop = 7_200;
    list.dispatchEvent(new Event('scroll'));
    await settlePerfEffects();

    const frames = [...pendingFrames.entries()];
    pendingFrames.clear();
    for (const [, callback] of frames) callback(0);
    await settlePerfEffects();

    expect(stickyPreviewSelectionPasses.value).toBe(1);
  });

  it('keeps the rendered row window bounded across width changes', async () => {
    vi.useFakeTimers();
    const observers: Array<{
      callback: ResizeObserverCallback;
      targets: Set<Element>;
    }> = [];
    class ResizeObserverHarness {
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
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: ResizeObserverHarness,
    });
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: ResizeObserverHarness,
    });

    let listWidth = 500;
    let fontHeightAdjustment = 0;
    const getRowHeight = () => 120 + Math.round((500 - listWidth) * 0.5) + fontHeightAdjustment;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('interactive-list') ? listWidth : 500;
      }
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-item-container')) {
          const index = Number(this.getAttribute('data-msg-id')?.replace('message-', '') ?? 0);
          const rowHeight = getRowHeight();
          return new DOMRect(0, index * rowHeight, listWidth, rowHeight);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, listWidth, getRowHeight() * 200);
        }
        return new DOMRect(0, 0, listWidth, 500);
      }
    );

    replaceMessages(
      Array.from({ length: 200 }, (_, index) => {
        const id = `message-${index}`;
        const info = index % 2 === 0 ? createUserMessage(id) : createAssistantMessage(id);
        return entry(info, [createTextPart(`part-${index}`, id, `Message ${index}`)]);
      })
    );
    setState('activeSessionId', 'session-1');

    cleanup = render(() => MessageList(), container!);
    await settlePerfEffects();

    const list = container!.querySelector<HTMLElement>('.interactive-list')!;
    const track = container!.querySelector<HTMLElement>('.interactive-list-track')!;
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(80);

    const initialBottomSpacerHeight = container
      ?.querySelector<HTMLElement>('.virtual-spacer-bottom')
      ?.style.getPropertyValue('height');
    let maxRenderedRows = container?.querySelectorAll('[data-msg-id]').length ?? 0;
    let totalAddedRows = 0;
    let totalRemovedRows = 0;
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          totalAddedRows += node.matches('[data-msg-id]') ? 1 : 0;
          totalAddedRows += node.querySelectorAll('[data-msg-id]').length;
        }
        for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue;
          totalRemovedRows += node.matches('[data-msg-id]') ? 1 : 0;
          totalRemovedRows += node.querySelectorAll('[data-msg-id]').length;
        }
      }
      maxRenderedRows = Math.max(
        maxRenderedRows,
        container?.querySelectorAll('[data-msg-id]').length ?? 0
      );
    });
    mutationObserver.observe(container!, { childList: true, subtree: true });

    const layoutObserver = observers.find(
      (observer) => observer.targets.has(list) && observer.targets.has(track)
    );
    expect(layoutObserver).toBeDefined();
    const rowObserver = observers.find((observer) =>
      [...observer.targets].some((target) => target.hasAttribute('data-msg-id'))
    );
    expect(rowObserver).toBeDefined();

    for (let step = 1; step <= 20; step += 1) {
      listWidth = 500 - step * 4;
      layoutObserver!.callback(
        [
          resizeObserverEntry(list, listWidth, 500),
          resizeObserverEntry(track, listWidth, getRowHeight() * 200),
        ],
        layoutObserver as unknown as ResizeObserver
      );
      rowObserver!.callback(
        [...rowObserver!.targets]
          .filter((target) => target.isConnected)
          .map((target) => resizeObserverEntry(target, listWidth, getRowHeight())),
        rowObserver as unknown as ResizeObserver
      );
      await vi.advanceTimersByTimeAsync(16);
    }

    await Promise.resolve();
    expect(container?.querySelector<HTMLElement>('.virtual-spacer-bottom')?.style.height).toBe(
      initialBottomSpacerHeight
    );
    expect(totalAddedRows).toBe(0);
    expect(totalRemovedRows).toBe(0);

    await vi.advanceTimersByTimeAsync(83);
    expect(container?.querySelector<HTMLElement>('.virtual-spacer-bottom')?.style.height).toBe(
      initialBottomSpacerHeight
    );
    await vi.advanceTimersByTimeAsync(1);
    await settlePerfEffects();
    await Promise.resolve();

    const widthSettledBottomSpacerHeight =
      container?.querySelector<HTMLElement>('.virtual-spacer-bottom')?.style.height;
    expect(widthSettledBottomSpacerHeight).not.toBe(initialBottomSpacerHeight);

    // Row observers are created before the layout observer, so a font-only reflow can arrive first.
    // It must still enter the settled width path rather than publishing once per row delivery.
    fontHeightAdjustment = 20;
    list.style.fontSize = '18px';
    rowObserver!.callback(
      [...rowObserver!.targets]
        .filter((target) => target.isConnected)
        .map((target) => resizeObserverEntry(target, listWidth, getRowHeight())),
      rowObserver as unknown as ResizeObserver
    );
    layoutObserver!.callback(
      [resizeObserverEntry(track, listWidth, getRowHeight() * 200)],
      layoutObserver as unknown as ResizeObserver
    );
    await vi.advanceTimersByTimeAsync(99);
    expect(container?.querySelector<HTMLElement>('.virtual-spacer-bottom')?.style.height).toBe(
      widthSettledBottomSpacerHeight
    );
    await vi.advanceTimersByTimeAsync(1);
    await settlePerfEffects();
    await Promise.resolve();
    mutationObserver.disconnect();

    expect(container?.querySelector<HTMLElement>('.virtual-spacer-bottom')?.style.height).not.toBe(
      widthSettledBottomSpacerHeight
    );
    expect(maxRenderedRows).toBeLessThan(80);
    expect(totalAddedRows).toBeLessThan(80);
    expect(totalRemovedRows).toBeLessThan(80);
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(80);
    expect(container?.querySelector('.interactive-list-track.virtualized')).toBeTruthy();
  });
});
