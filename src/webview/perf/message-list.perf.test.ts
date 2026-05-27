import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { MessageList } from '../components/MessageList';
import { replaceMessages, resetDefaultAppState, setState } from '../lib/state';
import type { AssistantMessage, Message, Part, TextPart } from '../types';
import { settlePerfEffects } from './harness';

const { messageRowPassCounts } = vi.hoisted(() => ({
  messageRowPassCounts: new Map<string, number>(),
}));

vi.mock('../components/message-list/MessageRows', async () => {
  const { createRenderEffect } = await import('solid-js');

  function countMessagePass(message: { info: Message; parts: Part[] }) {
    messageRowPassCounts.set(message.info.id, (messageRowPassCounts.get(message.info.id) ?? 0) + 1);
  }

  return {
    MessageRows(props: { messages: Array<{ info: Message; parts: Part[] }> }) {
      createRenderEffect(() => {
        for (const message of props.messages) {
          countMessagePass(message);
        }
      });

      return null;
    },
    MessageRow(props: { msg: { info: Message; parts: Part[] } }) {
      createRenderEffect(() => countMessagePass(props.msg));

      return null;
    },
  };
});

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalGlobalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let originalWindowResizeObserver: typeof window.ResizeObserver | undefined;
let originalGlobalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
let originalWindowRequestAnimationFrame: typeof window.requestAnimationFrame | undefined;
let originalGlobalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
let originalWindowCancelAnimationFrame: typeof window.cancelAnimationFrame | undefined;

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

describe('MessageList perf guards', () => {
  beforeEach(() => {
    resetDefaultAppState();
    messageRowPassCounts.clear();

    container = document.createElement('div');
    document.body.appendChild(container);

    originalGlobalResizeObserver = globalThis.ResizeObserver;
    originalWindowResizeObserver = window.ResizeObserver;
    originalGlobalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalWindowRequestAnimationFrame = window.requestAnimationFrame;
    originalGlobalCancelAnimationFrame = globalThis.cancelAnimationFrame;
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
      value: originalGlobalResizeObserver,
    });
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: originalWindowResizeObserver,
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalGlobalRequestAnimationFrame,
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalWindowRequestAnimationFrame,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalGlobalCancelAnimationFrame,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalWindowCancelAnimationFrame,
    });

    messageRowPassCounts.clear();
    resetDefaultAppState();
    vi.restoreAllMocks();
  });

  it('does not revisit sibling message rows when one message part streams nested text updates', async () => {
    replaceMessages([
      entry(createAssistantMessage('message-1'), [createTextPart('part-a', 'message-1', 'Alpha')]),
      entry(createAssistantMessage('message-2'), [createTextPart('part-b', 'message-2', 'Beta')]),
      entry(createAssistantMessage('message-3'), [createTextPart('part-c', 'message-3', 'Gamma')]),
    ]);
    setState('activeSessionId', 'session-1');

    cleanup = render(() => MessageList(), container!);
    await settlePerfEffects();

    expect(messageRowPassCounts.get('message-1')).toBe(1);
    expect(messageRowPassCounts.get('message-2')).toBe(1);
    expect(messageRowPassCounts.get('message-3')).toBe(1);

    for (let index = 0; index < 10; index += 1) {
      setState('messages', 0, 'parts', 0, 'text', (text) => `${text}${index}`);
    }

    await settlePerfEffects();

    expect(messageRowPassCounts.get('message-2')).toBe(1);
    expect(messageRowPassCounts.get('message-3')).toBe(1);
  });
});
