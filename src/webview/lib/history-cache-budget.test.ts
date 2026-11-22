import { createStore, flush as flushSolid } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { MessageEntry } from '../types';
import { HistoryCacheBudget } from './history-cache-budget';
import { isObject, isString } from './runtime-values';

const MAX_BYTES = 24 * 1024 * 1024;

// The original estimator over plain data, including its 8-byte charge for a repeated reference.
function referenceBytes(value: readonly MessageEntry[]): number {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (isString(item)) bytes += item.length * 2;
    else if (isObject(item) && !seen.has(item)) {
      seen.add(item);
      bytes += 64;
      for (const [key, child] of Object.entries(item)) {
        bytes += key.length * 2 + 16;
        pending.push(child);
      }
    } else bytes += 8;
  }
  return bytes;
}

function textEntry(text: string): MessageEntry {
  return {
    info: {
      id: 'repeated',
      sessionID: 'session-1',
      role: 'user',
      time: { created: 0 },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
    parts: [
      { id: 'repeated-text', sessionID: 'session-1', messageID: 'repeated', type: 'text', text },
    ],
  };
}

describe('HistoryCacheBudget', () => {
  it('charges a repeated record reference like the plain estimate, including mutated store records', () => {
    const empty = textEntry('');
    // Every charge is even, so the 24 MiB boundary is reachable exactly.
    const base = referenceBytes([empty, empty]);
    flushSolid();
    const [store, setStore] = createStore({ messages: [empty] });
    for (const [extraBytes, evicted] of [
      [0, false],
      [2, true],
    ] as const) {
      const text = 'x'.repeat((MAX_BYTES - base + extraBytes) / 2);
      const plain = textEntry(text);
      expect(referenceBytes([plain, plain])).toBe(MAX_BYTES + extraBytes);
      // Grow the store record in place, as streamed text does.
      setStore((draft) => {
        const part = draft.messages[0]!.parts[0]!;
        if (part.type !== 'text') throw new Error('Expected text fixture');
        part.text = text;
      });
      flushSolid();
      for (const record of [plain, store.messages[0]!]) {
        const budget = new HistoryCacheBudget();
        const evict = vi.fn();
        budget.retain('session-1', [record, record], evict);
        expect(evict).toHaveBeenCalledTimes(evicted ? 1 : 0);
      }
    }
  });
});
