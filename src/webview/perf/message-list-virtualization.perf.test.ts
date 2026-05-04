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
  });
});
