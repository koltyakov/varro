import { createMemo, deep, mapArray } from 'solid-js';
import type { Accessor } from 'solid-js';

/**
 * Derivations read one memo per record instead of subscribing to every nested field.
 * Keep canonical records for rendering and anchoring; these immutable views are for scans only.
 * Keyed owners retain unchanged snapshots and dispose subscriptions when entries leave the list.
 */
export function createRecordSnapshots<T>(entries: Accessor<readonly T[]>) {
  const snapshots = mapArray(
    entries,
    (entry) => createMemo(() => deep(entry), { name: 'recordSnapshot' }),
    { keyed: true }
  );
  // Aggregate through bounded chunks, so a long transcript does not merely move its
  // thousands of subscriptions into the memo that joins the per-message views.
  const chunks = createMemo<Accessor<T>[][]>((previous = []) => {
    const current = snapshots();
    const next: Accessor<T>[][] = [];
    for (let start = 0; start < current.length; start += 128) {
      const chunk = current.slice(start, start + 128);
      const retained = previous[next.length];
      next.push(
        retained?.length === chunk.length && retained.every((read, index) => read === chunk[index])
          ? retained
          : chunk
      );
    }
    return next;
  });
  const resolved = mapArray(
    chunks,
    (chunk) => createMemo(() => chunk.map((read) => read()), { name: 'recordSnapshotChunk' }),
    { keyed: true }
  );
  return createMemo(() => resolved().flatMap((read) => read()), { name: 'recordSnapshots' });
}
