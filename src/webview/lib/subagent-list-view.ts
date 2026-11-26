import { createSignal } from 'solid-js';

export type SubagentListView = 'tree' | 'flat';

// Shared by every sub-agent list and its header toggle; nested lists open as a tree.
const [subagentListView, setSubagentListView] = createSignal<SubagentListView>('tree');
const [nestedParentCounts, setNestedParentCounts] = createSignal<ReadonlyMap<string, number>>(
  new Map()
);

export { setSubagentListView, subagentListView };

/** Whether a mounted sub-agent list for this parent has sessions nested below its direct children. */
export function hasNestedSubagents(parentSessionId: string | null | undefined): boolean {
  return !!parentSessionId && (nestedParentCounts().get(parentSessionId) ?? 0) > 0;
}

/**
 * Marks a parent's sub-agent list as nested until the returned cleanup runs. Counted, so the
 * sidebar and main lists can show the same parent independently.
 */
export function reportNestedSubagents(parentSessionId: string): () => void {
  const update = (delta: number) =>
    setNestedParentCounts((current) => {
      const next = new Map(current);
      const count = (next.get(parentSessionId) ?? 0) + delta;
      if (count > 0) next.set(parentSessionId, count);
      else next.delete(parentSessionId);
      return next;
    });
  update(1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    update(-1);
  };
}
