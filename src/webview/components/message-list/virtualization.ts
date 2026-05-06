const DEFAULT_ITEM_HEIGHT = 160;
const OVERSCAN = 9;

export type VirtualMetrics = {
  prefix: number[];
  totalHeight: number;
  itemCount: number;
};

export type VisibleRange = {
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
  coreStart: number;
  coreEnd: number;
};

export function buildVirtualMetrics(args: {
  itemIds: string[];
  measuredHeights: Map<string, number>;
  defaultItemHeight?: number;
}): VirtualMetrics {
  const itemCount = args.itemIds.length;
  const defaultItemHeight = args.defaultItemHeight ?? DEFAULT_ITEM_HEIGHT;
  const prefix = Array.from<number>({ length: itemCount + 1 });
  prefix[0] = 0;

  for (let index = 0; index < itemCount; index += 1) {
    const id = args.itemIds[index];
    prefix[index + 1] = prefix[index] + (args.measuredHeights.get(id) ?? defaultItemHeight);
  }

  return {
    prefix,
    totalHeight: prefix[itemCount] || 0,
    itemCount,
  };
}

export function calculateVirtualRangeFromMetrics(args: {
  metrics: VirtualMetrics;
  scrollTop: number;
  viewportHeight: number;
  defaultItemHeight?: number;
  overscan?: number;
}) {
  const itemCount = args.metrics.itemCount;
  const defaultItemHeight = args.defaultItemHeight ?? DEFAULT_ITEM_HEIGHT;
  const overscan = args.overscan ?? OVERSCAN;
  if (itemCount === 0)
    return { start: 0, end: 0, topPad: 0, bottomPad: 0, coreStart: 0, coreEnd: 0 };

  const overscanPx = overscan * defaultItemHeight;
  const startOffset = Math.max(0, args.scrollTop - overscanPx);
  const endOffset = Math.max(startOffset, args.scrollTop + args.viewportHeight + overscanPx);
  const start = Math.max(
    0,
    Math.min(itemCount - 1, lowerBound(args.metrics.prefix, startOffset + 1) - 1)
  );
  const end = Math.min(
    itemCount,
    Math.max(start + 1, lowerBound(args.metrics.prefix, endOffset + 1))
  );

  const coreStart = Math.max(
    start,
    Math.min(itemCount - 1, lowerBound(args.metrics.prefix, args.scrollTop + 1) - 1)
  );
  const coreEnd = Math.min(
    end,
    Math.max(
      coreStart + 1,
      lowerBound(args.metrics.prefix, args.scrollTop + args.viewportHeight + 1)
    )
  );

  return {
    start,
    end,
    coreStart,
    coreEnd,
    topPad: args.metrics.prefix[start] || 0,
    bottomPad: args.metrics.totalHeight - (args.metrics.prefix[end] || 0),
  };
}

export function calculateVirtualRange(args: {
  itemIds: string[];
  measuredHeights: Map<string, number>;
  scrollTop: number;
  viewportHeight: number;
  defaultItemHeight?: number;
  overscan?: number;
}) {
  return calculateVirtualRangeFromMetrics({
    metrics: buildVirtualMetrics(args),
    scrollTop: args.scrollTop,
    viewportHeight: args.viewportHeight,
    defaultItemHeight: args.defaultItemHeight,
    overscan: args.overscan,
  });
}

export function getFirstVisibleMessageIndexFromVirtualMetrics(args: {
  metrics: VirtualMetrics;
  scrollTop: number;
}) {
  if (args.metrics.itemCount === 0) return null;
  const start = lowerBound(args.metrics.prefix, Math.max(0, args.scrollTop) + 1) - 1;
  return Math.max(0, Math.min(args.metrics.itemCount - 1, start));
}

export function pruneMeasuredHeights(
  measuredHeights: Map<string, number>,
  itemIds: readonly string[]
) {
  const itemIdSet = new Set(itemIds);
  let changed = false;
  for (const id of measuredHeights.keys()) {
    if (itemIdSet.has(id)) continue;
    measuredHeights.delete(id);
    changed = true;
  }
  return changed;
}

function lowerBound(values: number[], target: number) {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
