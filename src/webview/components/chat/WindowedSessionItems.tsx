import { For, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { calculateVirtualRangeFromMetrics } from '../message-list/virtualization';
import { isString } from '../../lib/runtime-values';

const WINDOW_THRESHOLD = 100;
const ESTIMATED_ROW_HEIGHT = 64;

export function WindowedSessionItems(props: {
  ids: readonly string[];
  focusedIndex: number;
  retainedIds: readonly (string | null)[];
  children: (
    id: string,
    index: Accessor<number>,
    observe: (element: HTMLElement) => void
  ) => JSX.Element;
}) {
  let marker: HTMLSpanElement | undefined;
  let scroll: HTMLElement | null = null;
  let observer: ResizeObserver | undefined;
  let frame = 0;
  const heights = new Map<string, number>();
  const mounted = new Map<string, HTMLElement>();
  const [revision, setRevision] = createSignal(0);
  const [viewport, setViewport] = createSignal({ top: 0, height: 640 });
  const [nativeFocus, setNativeFocus] = createSignal<string | null>(null);
  const ids = createMemo(() => props.ids, [], {
    equals: (previous, next) =>
      previous.length === next.length && previous.every((id, index) => id === next[index]),
  });
  const indexes = createMemo(() => new Map(ids().map((id, index) => [id, index])));
  const metrics = createMemo(() => {
    revision();
    const prefix = [0];
    for (const id of ids()) prefix.push(prefix.at(-1)! + (heights.get(id) ?? ESTIMATED_ROW_HEIGHT));
    return { prefix, totalHeight: prefix.at(-1)!, itemCount: ids().length };
  });
  const updateViewport = () => {
    if (scroll) setViewport({ top: scroll.scrollTop, height: scroll.clientHeight || 640 });
  };
  const measure = () => {
    frame = 0;
    if (!scroll) return;
    const previous = metrics();
    const anchor = calculateVirtualRangeFromMetrics({
      metrics: previous,
      scrollTop: scroll.scrollTop,
      viewportHeight: 1,
      overscan: 0,
    }).coreStart;
    let changed = false;
    for (const [id, element] of mounted) {
      if (!element.isConnected) continue;
      const height = element.getBoundingClientRect().height;
      if (height > 0 && heights.get(id) !== height) {
        heights.set(id, height);
        changed = true;
      }
    }
    if (changed) {
      setRevision((value) => value + 1);
      // Keep the same visible row when measurements above it replace estimates.
      scroll.scrollTop += (metrics().prefix[anchor] ?? 0) - (previous.prefix[anchor] ?? 0);
    }
    updateViewport();
  };
  const scheduleMeasure = () => {
    if (ids().length < WINDOW_THRESHOLD) return;
    if (!frame) frame = requestAnimationFrame(measure);
  };
  const observe = (id: string, element: HTMLElement) => {
    mounted.set(id, element);
    observer?.observe(element);
    scheduleMeasure();
    onCleanup(() => {
      observer?.unobserve(element);
      mounted.delete(id);
    });
  };
  const onFocus = () => {
    const element = document.activeElement;
    setNativeFocus(
      element instanceof HTMLElement
        ? (element.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId ?? null)
        : null
    );
  };
  onMount(() => {
    scroll = marker?.closest<HTMLElement>('.session-list-scroll') ?? null;
    if (!scroll) return;
    observer =
      globalThis.ResizeObserver === undefined ? undefined : new ResizeObserver(scheduleMeasure);
    observer?.observe(scroll);
    for (const element of mounted.values()) observer?.observe(element);
    scroll.addEventListener('scroll', updateViewport, { passive: true });
    scroll.addEventListener('focusin', onFocus);
    scroll.addEventListener('focusout', onFocus);
    updateViewport();
    scheduleMeasure();
  });
  onCleanup(() => {
    observer?.disconnect();
    cancelAnimationFrame(frame);
    scroll?.removeEventListener('scroll', updateViewport);
    scroll?.removeEventListener('focusin', onFocus);
    scroll?.removeEventListener('focusout', onFocus);
  });
  createEffect(() => {
    const positions = indexes();
    for (const id of heights.keys()) if (!positions.has(id)) heights.delete(id);
    untrack(scheduleMeasure);
  });
  type Gap = { start: number; end: number };
  const items = createMemo<Array<string | Gap>>(() => {
    const orderedIds = ids();
    if (orderedIds.length < WINDOW_THRESHOLD) return [...orderedIds];
    const view = viewport();
    const range = calculateVirtualRangeFromMetrics({
      metrics: metrics(),
      scrollTop: view.top,
      viewportHeight: view.height,
      defaultItemHeight: ESTIMATED_ROW_HEIGHT,
      overscan: 6,
    });
    const retained = new Set<number>();
    for (let index = range.start; index < range.end; index++) retained.add(index);
    if (props.focusedIndex >= 0 && props.focusedIndex < orderedIds.length)
      retained.add(props.focusedIndex);
    for (const id of [...props.retainedIds, nativeFocus()]) {
      const index = id ? indexes().get(id) : undefined;
      if (index !== undefined) retained.add(index);
    }
    const result: Array<string | Gap> = [];
    let end = 0;
    for (const index of [...retained].toSorted((a, b) => a - b)) {
      if (index > end) result.push({ start: end, end: index });
      result.push(orderedIds[index]!);
      end = index + 1;
    }
    if (end < orderedIds.length) result.push({ start: end, end: orderedIds.length });
    return result;
  });
  return (
    <>
      <span
        ref={(element) => {
          marker = element;
        }}
        hidden
      />
      <For each={items()}>
        {(item) => {
          if (!isString(item))
            return (
              <div
                aria-hidden="true"
                style={{
                  height: `${metrics().prefix[item.end]! - metrics().prefix[item.start]!}px`,
                  'overflow-anchor': 'none',
                }}
              />
            );
          return props.children(
            item,
            () => indexes().get(item) ?? 0,
            (element) => observe(item, element)
          );
        }}
      </For>
    </>
  );
}
