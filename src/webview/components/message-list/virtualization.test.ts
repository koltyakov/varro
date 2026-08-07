import { describe, expect, it } from 'vitest';
import {
  alignBlockSizeToPixel,
  buildVirtualMetrics,
  calculateVirtualRange,
  getFirstVisibleMessageIndexFromVirtualMetrics,
  pruneMeasuredHeights,
} from './virtualization';

describe('alignBlockSizeToPixel', () => {
  it('rounds positive block sizes up to whole CSS pixels', () => {
    expect(alignBlockSizeToPixel(59.59375)).toBe(60);
    expect(alignBlockSizeToPixel(60)).toBe(60);
    expect(alignBlockSizeToPixel(0)).toBe(0);
  });
});

describe('buildVirtualMetrics', () => {
  it('builds prefix offsets from measured and default heights', () => {
    expect(
      buildVirtualMetrics({
        itemIds: ['a', 'b', 'c'],
        measuredHeights: new Map([
          ['a', 40],
          ['c', 80],
        ]),
        defaultItemHeight: 50,
      })
    ).toEqual({
      prefix: [0, 40, 90, 170],
      totalHeight: 170,
      itemCount: 3,
    });
  });

  it('keeps an explicitly measured zero-height row out of downstream offsets', () => {
    expect(
      buildVirtualMetrics({
        itemIds: ['empty', 'visible'],
        measuredHeights: new Map([
          ['empty', 0],
          ['visible', 40],
        ]),
      })
    ).toEqual({
      prefix: [0, 0, 40],
      totalHeight: 40,
      itemCount: 2,
    });
  });

  it('uses a known zero height instead of the provisional default before measurement', () => {
    expect(
      buildVirtualMetrics({
        itemIds: ['owner', 'hidden-1', 'hidden-2', 'hidden-3', 'visible'],
        measuredHeights: new Map([
          ['owner', 40],
          ['hidden-1', 160],
          ['visible', 80],
        ]),
        knownZeroHeightIds: new Set(['hidden-1', 'hidden-2', 'hidden-3']),
      })
    ).toEqual({
      prefix: [0, 40, 40, 40, 40, 120],
      totalHeight: 120,
      itemCount: 5,
    });
  });

  it('rebuilds cached downstream offsets when a measured height changes', () => {
    const itemIds = ['a', 'b', 'c'];
    const measuredHeights = new Map([
      ['a', 40],
      ['b', 50],
      ['c', 60],
    ]);
    const previous = buildVirtualMetrics({ itemIds, measuredHeights });

    measuredHeights.set('b', 80);

    expect(
      buildVirtualMetrics({
        itemIds,
        measuredHeights,
        previous: { metrics: previous, itemIds },
        dirtyFromIndex: 1,
      })
    ).toEqual({
      prefix: [0, 40, 120, 180],
      totalHeight: 180,
      itemCount: 3,
    });
  });

  it.each([
    {
      change: 'a prepend',
      itemIds: ['x', 'a', 'b', 'c'],
      expectedPrefix: [0, 30, 70, 120, 180],
    },
    {
      change: 'a middle insertion',
      itemIds: ['a', 'x', 'b', 'c'],
      expectedPrefix: [0, 40, 70, 120, 180],
    },
    {
      change: 'a middle removal',
      itemIds: ['a', 'c'],
      expectedPrefix: [0, 40, 100],
    },
    {
      change: 'a reorder',
      itemIds: ['b', 'a', 'c'],
      expectedPrefix: [0, 50, 90, 150],
    },
  ])('invalidates cached offsets after $change', ({ itemIds, expectedPrefix }) => {
    const previousItemIds = ['a', 'b', 'c'];
    const measuredHeights = new Map([
      ['a', 40],
      ['b', 50],
      ['c', 60],
      ['x', 30],
    ]);
    const previous = buildVirtualMetrics({ itemIds: previousItemIds, measuredHeights });

    expect(
      buildVirtualMetrics({
        itemIds,
        measuredHeights,
        previous: { metrics: previous, itemIds: previousItemIds },
      })
    ).toEqual({
      prefix: expectedPrefix,
      totalHeight: expectedPrefix.at(-1),
      itemCount: itemIds.length,
    });
  });

  it.each([
    { dirtyFromIndex: 0, id: 'a', height: 70, expectedPrefix: [0, 70, 120, 180] },
    { dirtyFromIndex: 2, id: 'c', height: 90, expectedPrefix: [0, 40, 90, 180] },
  ])(
    'rebuilds from dirty boundary $dirtyFromIndex without retaining a stale prefix',
    ({ dirtyFromIndex, id, height, expectedPrefix }) => {
      const itemIds = ['a', 'b', 'c'];
      const measuredHeights = new Map([
        ['a', 40],
        ['b', 50],
        ['c', 60],
      ]);
      const previous = buildVirtualMetrics({ itemIds, measuredHeights });
      measuredHeights.set(id, height);

      expect(
        buildVirtualMetrics({
          itemIds,
          measuredHeights,
          previous: { metrics: previous, itemIds },
          dirtyFromIndex,
        }).prefix
      ).toEqual(expectedPrefix);
    }
  );

  it('keeps prefix offsets and spacers on whole CSS pixels', () => {
    expect(
      buildVirtualMetrics({
        itemIds: ['a', 'b', 'c'],
        measuredHeights: new Map([
          ['a', 40.25],
          ['b', 59.5],
        ]),
        defaultItemHeight: 50.25,
      })
    ).toEqual({
      prefix: [0, 41, 101, 152],
      totalHeight: 152,
      itemCount: 3,
    });
  });
});

describe('calculateVirtualRange', () => {
  it('includes overscan and returns matching spacer heights', () => {
    expect(
      calculateVirtualRange({
        itemIds: ['a', 'b', 'c', 'd'],
        measuredHeights: new Map([
          ['a', 40],
          ['b', 60],
          ['c', 80],
          ['d', 100],
        ]),
        scrollTop: 100,
        viewportHeight: 50,
        defaultItemHeight: 50,
        overscan: 0,
      })
    ).toEqual({
      start: 2,
      end: 3,
      coreStart: 2,
      coreEnd: 3,
      topPad: 100,
      bottomPad: 100,
    });

    expect(
      calculateVirtualRange({
        itemIds: ['a', 'b', 'c', 'd'],
        measuredHeights: new Map([
          ['a', 40],
          ['b', 60],
          ['c', 80],
          ['d', 100],
        ]),
        scrollTop: 100,
        viewportHeight: 50,
        defaultItemHeight: 50,
        overscan: 1,
      })
    ).toEqual({
      start: 1,
      end: 4,
      coreStart: 2,
      coreEnd: 3,
      topPad: 40,
      bottomPad: 0,
    });
  });

  it('returns an empty range for no items', () => {
    expect(
      calculateVirtualRange({
        itemIds: [],
        measuredHeights: new Map(),
        scrollTop: 100,
        viewportHeight: 50,
      })
    ).toEqual({ start: 0, end: 0, coreStart: 0, coreEnd: 0, topPad: 0, bottomPad: 0 });
  });

  it('skips runs of zero-height rows at exact viewport boundaries', () => {
    const itemIds = ['empty-a', 'empty-b', 'visible-a', 'visible-b'];
    const measuredHeights = new Map([
      ['empty-a', 0],
      ['empty-b', 0],
      ['visible-a', 40],
      ['visible-b', 40],
    ]);

    expect(
      calculateVirtualRange({
        itemIds,
        measuredHeights,
        scrollTop: 0,
        viewportHeight: 20,
        overscan: 0,
      })
    ).toEqual({
      start: 2,
      end: 3,
      coreStart: 2,
      coreEnd: 3,
      topPad: 0,
      bottomPad: 40,
    });

    const metrics = buildVirtualMetrics({ itemIds, measuredHeights });
    expect(getFirstVisibleMessageIndexFromVirtualMetrics({ metrics, scrollTop: 0 })).toBe(2);
    expect(getFirstVisibleMessageIndexFromVirtualMetrics({ metrics, scrollTop: 40 })).toBe(3);
  });
});

describe('getFirstVisibleMessageIndexFromVirtualMetrics', () => {
  it('clamps scroll positions to existing item indexes', () => {
    const metrics = buildVirtualMetrics({
      itemIds: ['a', 'b', 'c'],
      measuredHeights: new Map([
        ['a', 40],
        ['b', 60],
        ['c', 80],
      ]),
    });

    expect(getFirstVisibleMessageIndexFromVirtualMetrics({ metrics, scrollTop: -20 })).toBe(0);
    expect(getFirstVisibleMessageIndexFromVirtualMetrics({ metrics, scrollTop: 40 })).toBe(1);
    expect(getFirstVisibleMessageIndexFromVirtualMetrics({ metrics, scrollTop: 999 })).toBe(2);
  });
});

describe('pruneMeasuredHeights', () => {
  it('removes stale heights and reports whether anything changed', () => {
    const measuredHeights = new Map([
      ['a', 40],
      ['stale', 60],
    ]);

    expect(pruneMeasuredHeights(measuredHeights, ['a'])).toBe(true);
    expect(Array.from(measuredHeights.entries())).toEqual([['a', 40]]);
    expect(pruneMeasuredHeights(measuredHeights, ['a'])).toBe(false);
  });
});
