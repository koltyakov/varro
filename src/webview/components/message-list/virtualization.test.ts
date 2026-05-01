import { describe, expect, it } from 'vitest';
import {
  buildVirtualMetrics,
  calculateVirtualRange,
  getFirstVisibleMessageIndexFromVirtualMetrics,
  pruneMeasuredHeights,
} from './virtualization';

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
    ).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
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
