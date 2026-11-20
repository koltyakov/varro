import { createRoot, createSignal, createStore, flush, OBSERVE, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { describe, expect, it } from 'vitest';
import { createRecordSnapshots } from './record-snapshots';

function mountSnapshots<T>(entries: Accessor<readonly T[]>) {
  return createRoot((dispose) => ({ snapshots: createRecordSnapshots(entries), dispose }));
}

describe('record snapshots', () => {
  it('updates nested fields without replacing canonical records or unchanged snapshots', () => {
    const [state, setState] = createStore({
      entries: [
        { id: 'first', info: { cost: 1 }, parts: [{ text: 'Before' }] },
        { id: 'second', info: { cost: 2 }, parts: [{ text: 'Unchanged' }] },
      ],
    });
    const { snapshots, dispose } = mountSnapshots(() => state.entries);
    try {
      const canonical = untrack(() => state.entries[0]);
      const before = untrack(snapshots);
      setState(storePath('entries', 0, 'parts', 0, 'text', 'After'));
      flush();
      const after = untrack(snapshots);
      expect(after[0]!.parts[0]!.text).toBe('After');
      expect(before[0]!.parts[0]!.text).toBe('Before');
      expect(after[0]).not.toBe(before[0]);
      expect(after[1]).toBe(before[1]);
      expect(untrack(() => state.entries[0])).toBe(canonical);

      setState(storePath('entries', 0, 'info', 'cost', 3));
      flush();
      expect(untrack(snapshots)[0]!.info.cost).toBe(3);
      expect(after[0]!.info.cost).toBe(1);
    } finally {
      dispose();
    }
  });

  it('retains keyed snapshots across prepends, reorders, removals, and appends', () => {
    const [first] = createStore({ id: 'first', value: 1 });
    const [second] = createStore({ id: 'second', value: 2 });
    const [third] = createStore({ id: 'third', value: 3 });
    const [entries, setEntries] = createSignal([first, second]);
    const { snapshots, dispose } = mountSnapshots(entries);
    try {
      const before = untrack(snapshots);
      setEntries([third, second, first]);
      flush();
      expect(untrack(snapshots)[1]).toBe(before[1]);
      expect(untrack(snapshots)[2]).toBe(before[0]);
      setEntries([second]);
      flush();
      expect(untrack(snapshots)).toEqual([before[1]]);
      setEntries([second, third]);
      flush();
      expect(untrack(snapshots).map((entry) => entry.id)).toEqual(['second', 'third']);
      expect(untrack(snapshots)[0]).toBe(before[1]);
    } finally {
      dispose();
    }
  });

  it('bounds fan-in even when aggregating more than 2000 records', () => {
    const [state, setState] = createStore({
      entries: Array.from({ length: 3000 }, (_, id) => ({ id, nested: { value: id } })),
    });
    const capture = OBSERVE!.diagnostics.capture();
    const { snapshots, dispose } = mountSnapshots(() => state.entries);
    try {
      const before = untrack(snapshots);
      expect(before).toHaveLength(3000);
      for (let update = 0; update < 5; update += 1) {
        setState(storePath('entries', 2999, 'nested', 'value', -update));
        flush();
        const after = untrack(snapshots);
        expect(after[2999]!.nested.value).toBe(-update);
        for (let index = 0; index < 2999; index += 1) expect(after[index]).toBe(before[index]);
      }
      expect(capture.events.filter((event) => event.code === 'HUGE_FAN_IN')).toEqual([]);
    } finally {
      dispose();
      capture.stop();
    }
  });
});
