import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { MessageList } from '../components/MessageList';
import { replaceMessages, resetDefaultAppState, setState } from '../lib/state';
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

describe('MessageList virtualization perf guards', () => {
  beforeEach(() => {
    resetDefaultAppState();
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
    vi.restoreAllMocks();
  });

  it('renders only a bounded row window for large transcripts', async () => {
    // Principle: once the exact-height bootstrap completes, large transcripts must return to a
    // bounded DOM window with virtual spacers. Rendering the whole transcript is a regression.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-item-container')) {
        return new DOMRect(0, 0, 500, 120);
      }
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, 24_000);
      }
      return new DOMRect(0, 0, 500, 500);
    });

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

  it('keeps the rendered row window bounded across width changes', async () => {
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
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
      return this.classList.contains('interactive-list') ? listWidth : 500;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-item-container')) {
        return new DOMRect(0, 0, listWidth, 120);
      }
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, listWidth, 24_000);
      }
      return new DOMRect(0, 0, listWidth, 500);
    });

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

    let maxAddedRows = 0;
    const mutationObserver = new MutationObserver((records) => {
      let addedRows = 0;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          addedRows += node.matches('[data-msg-id]') ? 1 : 0;
          addedRows += node.querySelectorAll('[data-msg-id]').length;
        }
      }
      maxAddedRows = Math.max(
        maxAddedRows,
        addedRows,
        container?.querySelectorAll('[data-msg-id]').length ?? 0
      );
    });
    mutationObserver.observe(container!, { childList: true, subtree: true });

    const layoutObserver = observers.find(
      (observer) => observer.targets.has(list) && observer.targets.has(track)
    );
    expect(layoutObserver).toBeDefined();
    listWidth = 420;
    layoutObserver!.callback([], layoutObserver as unknown as ResizeObserver);
    await settlePerfEffects();
    await Promise.resolve();
    mutationObserver.disconnect();

    expect(maxAddedRows).toBeLessThan(80);
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(80);
  });
});
