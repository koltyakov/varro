import { isNumber } from '../../lib/runtime-values';
export const VIRTUALIZE_THRESHOLD = 50;
const DEFAULT_ITEM_HEIGHT = 160;
const OVERSCAN = 9;
const PIXEL_ALIGNMENT_EPSILON = 0.001;

export type VirtualMetrics = {
  prefix: VirtualPrefix;
  totalHeight: number;
  itemCount: number;
};

type VirtualPrefix = Iterable<number> & {
  readonly length: number;
  at(index: number): number | undefined;
};
const PREFIX_CHUNK_SIZE = 256;

// Published prefixes are immutable snapshots. Tail changes share complete earlier chunks so
// anchoring can still read old geometry without copying every row on every streamed resize.
class ChunkedVirtualPrefix implements VirtualPrefix {
  private readonly chunks: number[][] = [];

  constructor(
    readonly length: number,
    previous?: VirtualPrefix,
    copyCount = 0
  ) {
    if (previous instanceof ChunkedVirtualPrefix) {
      const complete = Math.floor(copyCount / PREFIX_CHUNK_SIZE);
      for (let index = 0; index < complete; index++) this.chunks.push(previous.chunks[index]!);
      const remainder = copyCount % PREFIX_CHUNK_SIZE;
      if (remainder) this.chunks.push(previous.chunks[complete]!.slice(0, remainder));
    } else if (previous) {
      for (let index = 0; index < copyCount; index++) this.set(index, previous.at(index)!);
    }
  }

  at(index: number): number | undefined {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    return this.chunks[Math.floor(index / PREFIX_CHUNK_SIZE)]?.[index % PREFIX_CHUNK_SIZE];
  }

  set(index: number, value: number) {
    const chunk = Math.floor(index / PREFIX_CHUNK_SIZE);
    this.chunks[chunk] ??= [];
    this.chunks[chunk]![index % PREFIX_CHUNK_SIZE] = value;
  }

  *[Symbol.iterator]() {
    for (let index = 0; index < this.length; index++) yield this.at(index)!;
  }
}

export type VisibleRange = {
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
  coreStart: number;
  coreEnd: number;
  pinnedIndex?: number;
  pinnedGapStart?: number;
  pinnedGapEnd?: number;
};

export function alignBlockSizeToPixel(blockSize: number) {
  if (!Number.isFinite(blockSize) || blockSize <= 0) return 0;
  const nearestInteger = Math.round(blockSize);
  if (Math.abs(blockSize - nearestInteger) < PIXEL_ALIGNMENT_EPSILON) {
    return nearestInteger;
  }
  return Math.ceil(blockSize);
}

export function buildVirtualMetrics(args: {
  itemIds: string[];
  measuredHeights: Map<string, number>;
  knownZeroHeightIds?: ReadonlySet<string>;
  defaultItemHeight?: number;
  /**
   * Optional cached metrics from a previous build. When provided alongside the
   * itemIds reference that produced it, the rebuild will reuse prefix entries
   * up to the first divergence between the cached and new itemIds. Pair with
   * dirtyFromIndex to also short-circuit when an existing item's measured
   * height changed.
   */
  previous?: { metrics: VirtualMetrics; itemIds: string[] };
  /**
   * Lower bound (inclusive) of the first item whose measured height is known
   * to have changed since the cached metrics were produced. Ignored when
   * previous is missing.
   */
  dirtyFromIndex?: number;
}): VirtualMetrics {
  const itemCount = args.itemIds.length;
  const defaultItemHeight = alignBlockSizeToPixel(args.defaultItemHeight ?? DEFAULT_ITEM_HEIGHT);

  let rebuildFrom = 0;
  let prefix: ChunkedVirtualPrefix;

  if (args.previous) {
    const previousIds = args.previous.itemIds;
    const previousPrefix = args.previous.metrics.prefix;
    const upper = Math.min(previousIds.length, itemCount);
    let commonLen = previousIds === args.itemIds ? upper : 0;
    while (commonLen < upper && previousIds[commonLen] === args.itemIds[commonLen]) {
      commonLen += 1;
    }
    rebuildFrom = isNumber(args.dirtyFromIndex)
      ? Math.max(0, Math.min(commonLen, args.dirtyFromIndex))
      : commonLen;
    const copyUpTo = Math.min(rebuildFrom, previousPrefix.length - 1);
    prefix = new ChunkedVirtualPrefix(itemCount + 1, previousPrefix, copyUpTo + 1);
    rebuildFrom = copyUpTo;
  } else {
    prefix = new ChunkedVirtualPrefix(itemCount + 1);
    prefix.set(0, 0);
  }

  for (let index = rebuildFrom; index < itemCount; index += 1) {
    const id = args.itemIds[index]!;
    const measuredHeight = args.measuredHeights.get(id);
    const itemHeight = args.knownZeroHeightIds?.has(id)
      ? 0
      : measuredHeight === undefined
        ? defaultItemHeight
        : alignBlockSizeToPixel(measuredHeight);
    prefix.set(index + 1, prefix.at(index)! + itemHeight);
  }

  return {
    prefix: itemCount < PREFIX_CHUNK_SIZE ? [...prefix] : prefix,
    totalHeight: prefix.at(itemCount) || 0,
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
  const start = getPhysicalRowIndexAtOffset(args.metrics, startOffset);
  const end = Math.min(
    itemCount,
    Math.max(start + 1, lowerBound(args.metrics.prefix, endOffset + 1))
  );

  const coreStart = Math.max(start, getPhysicalRowIndexAtOffset(args.metrics, args.scrollTop));
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
    topPad: args.metrics.prefix.at(start) || 0,
    bottomPad: args.metrics.totalHeight - (args.metrics.prefix.at(end) || 0),
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
  return getPhysicalRowIndexAtOffset(args.metrics, args.scrollTop);
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

function lowerBound(values: VirtualPrefix, target: number) {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values.at(mid)! < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function getPhysicalRowIndexAtOffset(metrics: VirtualMetrics, offset: number) {
  const target = Math.min(Math.max(0, offset) + 1, Math.max(1, metrics.totalHeight));
  const index = lowerBound(metrics.prefix, target) - 1;
  return Math.max(0, Math.min(metrics.itemCount - 1, index));
}
