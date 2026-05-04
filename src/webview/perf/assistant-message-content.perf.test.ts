import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { AssistantMessage, TextPart } from '../types';
import {
  AssistantMessageContent,
  shouldShowReadModeToggle,
} from '../components/message/AssistantMessageContent';
import { settlePerfEffects } from './harness';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalGlobalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let originalWindowResizeObserver: typeof window.ResizeObserver | undefined;

function createAssistantMessage(): AssistantMessage {
  return {
    id: 'message-1',
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

function createTextPart(text: string): TextPart {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text,
  };
}

describe('AssistantMessageContent perf guards', () => {
  beforeEach(() => {
    container = document.createElement('div');
    container.className = 'interactive-list';
    document.body.appendChild(container);

    originalGlobalResizeObserver = globalThis.ResizeObserver;
    originalWindowResizeObserver = window.ResizeObserver;
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

    vi.restoreAllMocks();
  });

  it('does not create ResizeObserver instances for non-virtualized assistant messages', async () => {
    let resizeObserverConstructCount = 0;

    class ResizeObserverSpy {
      constructor(_callback: ResizeObserverCallback) {
        resizeObserverConstructCount += 1;
      }

      observe() {}

      disconnect() {}
    }

    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: ResizeObserverSpy,
    });
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: ResizeObserverSpy,
    });

    cleanup = render(
      () =>
        AssistantMessageContent({
          info: createAssistantMessage(),
          parts: [createTextPart('Short answer')],
          textForPart: () => null,
        }),
      container!
    );

    await settlePerfEffects();

    expect(resizeObserverConstructCount).toBe(0);
  });

  it('renders only a bounded assistant-part window for long completed messages', async () => {
    class ResizeObserverStub {
      observe() {}

      disconnect() {}
    }

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

    const parts = Array.from({ length: 100 }, (_, index) => ({
      id: `part-${index}`,
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'text' as const,
      text: `Assistant part ${index}`,
    }));

    cleanup = render(
      () =>
        AssistantMessageContent({
          info: createAssistantMessage(),
          parts,
          textForPart: () => null,
          isLastAssistant: false,
          outerListVirtualized: false,
        }),
      container!
    );

    await settlePerfEffects();

    expect(container?.querySelectorAll('[data-assistant-render-key]').length).toBeLessThan(30);
  });

  it('detects read-mode eligibility for large text without split allocation', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');
    const longText = `${'A'.repeat(50_000)}\nshort tail`;

    expect(shouldShowReadModeToggle(longText)).toBe(true);
    expect(splitSpy).not.toHaveBeenCalled();
  });
});
