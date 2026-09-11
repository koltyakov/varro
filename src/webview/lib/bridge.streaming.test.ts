import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComputed, createRoot, createSignal } from 'solid-js';
import type { ExtensionMessage } from '../../shared/protocol';
import { cleanupBridge, initializeBridge, onMessage } from './bridge';

function toolUpdate(index: number): ExtensionMessage {
  return {
    type: 'server/event',
    payload: {
      id: `event-${index}`,
      seq: index,
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part',
          messageID: 'message',
          sessionID: 'session',
          type: 'tool',
          tool: 'read',
          callID: 'call',
          state: { status: 'running', input: { index }, time: { start: 1 } },
        },
      },
    },
  };
}

function deliver(message: ExtensionMessage) {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

describe('incoming stream batches', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initializeBridge();
  });
  afterEach(() => {
    cleanupBridge();
    vi.useRealTimers();
  });

  it('delivers every tool update in order with one reactive publication', async () => {
    const received: ExtensionMessage[] = [];
    const observed: number[] = [];
    const dispose = createRoot((disposeRoot) => {
      const [count, setCount] = createSignal(0);
      createComputed(() => {
        observed.push(count());
      });
      onMessage((message) => {
        received.push(message);
        setCount((value) => value + 1);
      });
      return disposeRoot;
    });
    const updates = Array.from({ length: 32 }, (_, index) => toolUpdate(index));
    for (const update of updates) deliver(update);
    expect(received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(received).toEqual(updates);
    expect(observed).toEqual([0, 32]);
    dispose();
  });

  it('flushes preceding tools before an actionable permission without waiting for the batch timer', () => {
    const received: ExtensionMessage[] = [];
    onMessage((message) => {
      received.push(message);
    });
    const tool = toolUpdate(0);
    const permission: ExtensionMessage = {
      type: 'server/event',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'permission',
          sessionID: 'session',
          permission: 'bash',
          patterns: ['pwd'],
          always: [],
          metadata: {},
        },
      },
    };
    deliver(tool);
    expect(received).toHaveLength(0);
    deliver(permission);
    expect(received).toEqual([tool, permission]);
  });

  it('discards buffered events when the bridge is cleaned up', async () => {
    const received: ExtensionMessage[] = [];
    onMessage((message) => {
      received.push(message);
    });
    deliver(toolUpdate(0));
    cleanupBridge();
    initializeBridge();
    onMessage((message) => {
      received.push(message);
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(received).toHaveLength(0);
  });

  it('bounds pending batches while preserving every durable event identity and sequence', async () => {
    const received: ExtensionMessage[] = [];
    onMessage((message) => {
      received.push(message);
    });
    const updates = Array.from({ length: 130 }, (_, index) => toolUpdate(index));
    for (const update of updates) deliver(update);
    expect(received).toEqual(updates.slice(0, 128));
    await vi.advanceTimersByTimeAsync(20);
    expect(received).toEqual(updates);
  });
});
