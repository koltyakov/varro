import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { MessageList } from '../components/MessageList';
import { getAssistantDialogSummaryMap } from '../components/message-list/assistant-dialog';
import { replaceMessages, resetDefaultAppState, setState, upsertPart } from '../lib/state';
import {
  getAssistantActivityGroupMap,
  preserveAssistantActivityGroupKeys,
} from '../lib/assistant-activity';
import {
  getCompactActivityDisclosureLayoutSignatures,
  getRenderEmptyMessageIds,
} from '../components/message-list/row-layout';
import type { AssistantMessage, Message, Part, TextPart } from '../types';
import { settlePerfEffects } from './harness';

const { messageRowPassCounts } = vi.hoisted(() => ({
  messageRowPassCounts: new Map<string, number>(),
}));

/* oxlint-disable anti-slop/no-module-mocking -- This benchmark measures MessageList integration without MessageRows render cost. */
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
    AssistantDialogSummaryForMessage() {
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
      setState('messages', 0, 'parts', 0, (part) =>
        part.type === 'text' ? { ...part, text: `${part.text}${index}` } : part
      );
    }

    await settlePerfEffects();

    expect(messageRowPassCounts.get('message-2')).toBe(1);
    expect(messageRowPassCounts.get('message-3')).toBe(1);
  });

  it('builds assistant dialog summaries with linear message-id access', () => {
    const countIdReads = (messageCount: number) => {
      let idReads = 0;
      const messages = Array.from({ length: messageCount }, (_, index) => {
        const id = `message-${index}`;
        const info = createAssistantMessage(id);
        Object.defineProperty(info, 'id', {
          configurable: true,
          get() {
            idReads += 1;
            return id;
          },
        });
        return entry(info, []);
      });

      getAssistantDialogSummaryMap(messages);
      return idReads;
    };

    const smallTranscriptReads = countIdReads(100);
    const largeTranscriptReads = countIdReads(1_000);

    expect(largeTranscriptReads).toBeLessThan(smallTranscriptReads * 15);
  });

  it.each(['keys', 'disclosure', 'empty'] as const)(
    'visits shared activity parts linearly when deriving %s',
    (operation) => {
      const countReads = (size: number) => {
        let reads = 0;
        const messages = Array.from({ length: size }, (_, index) => {
          const id = `activity-${index}`;
          const part: Part = {
            id: `reasoning-${index}`,
            messageID: id,
            sessionID: 'session-1',
            type: 'reasoning',
            text: 'Generated historical reasoning.\n'.repeat(40),
            time: { start: 1, end: 2 },
          };
          Object.defineProperty(part, 'messageID', {
            get() {
              reads += 1;
              return id;
            },
          });
          return entry(createAssistantMessage(id), [part]);
        });
        const groups = getAssistantActivityGroupMap(messages);
        expect(groups.size).toBe(size);
        expect(groups.get('activity-0')![0]).toBe(groups.get(`activity-${size - 1}`)![0]);
        reads = 0;
        if (operation === 'keys') preserveAssistantActivityGroupKeys(groups, groups);
        if (operation === 'disclosure')
          getCompactActivityDisclosureLayoutSignatures(groups, () => false);
        if (operation === 'empty') {
          expect(getRenderEmptyMessageIds(messages, groups, () => false).size).toBe(size - 1);
        }
        return reads;
      };
      const small = countReads(40);
      const large = countReads(160);
      expect(
        large,
        `${operation} part reads must scale with parts, not messages times parts`
      ).toBeLessThanOrEqual(small * 5);
    }
  );

  it('bounds baseline activity reads when a final Markdown part is committed', async () => {
    const size = 160;
    let baselineReads = 0;
    const messages = Array.from({ length: size }, (_, index) => {
      const id = `activity-${index}`;
      const part: Part =
        index % 2 === 0
          ? {
              id: `part-${index}`,
              messageID: id,
              sessionID: 'session-1',
              type: 'reasoning',
              text: 'Generated historical reasoning.\n'.repeat(40),
              time: { start: 1, end: 2 },
            }
          : {
              id: `part-${index}`,
              messageID: id,
              sessionID: 'session-1',
              type: 'tool',
              tool: 'read',
              callID: `call-${index}`,
              state: {
                status: 'completed',
                input: { filePath: `/workspace/file-${index}.ts` },
                output: 'Generated output.\n'.repeat(40),
                title: 'Read file',
                metadata: {},
                time: { start: 1, end: 2 },
              },
            };
      Object.defineProperty(part, 'messageID', {
        get() {
          baselineReads += 1;
          return id;
        },
      });
      return entry(createAssistantMessage(id), [part]);
    });
    const text = '# Final report\n\nGenerated Markdown result.\n'.repeat(220);
    messages.push(
      entry({ ...createAssistantMessage('final'), parentID: 'new-user', time: { created: 3 } }, [
        createTextPart('final-text', 'final', ''),
      ])
    );
    setState('messages', messages);
    setState('activeSessionId', 'session-1');
    setState('streamingPartId', 'final-text');
    setState('streamingText', text);
    cleanup = render(() => MessageList(), container!);
    await settlePerfEffects();
    expect(baselineReads).toBeGreaterThan(0);
    baselineReads = 0;
    upsertPart({ ...createTextPart('final-text', 'final', text), time: { start: 3, end: 4 } });
    await settlePerfEffects();
    expect(
      baselineReads,
      'final part commitment must not rescan each shared group for every historical row'
    ).toBeLessThan(size * 100);
  });
});
