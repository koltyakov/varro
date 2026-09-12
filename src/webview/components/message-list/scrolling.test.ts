import { describe, expect, it } from 'vitest';
import {
  BottomFollowMotion,
  captureExpansionScrollAnchor,
  getDistanceFromBottom,
  getSmoothBottomFollowTop,
  performScrollToBottom,
  recoverScrollAnchorDescendant,
  resolveAutoScrollOnUserScroll,
  restoreExpansionScrollAnchor,
} from './scrolling';

describe('bottom follow motion', () => {
  it('starts gently, bounds speed, and settles without reversing', () => {
    const motion = new BottomFollowMotion();
    let top = 0;
    const steps: number[] = [];
    for (let frame = 0; frame < 90; frame += 1) {
      const next = motion.next(top, 600, 16);
      steps.push(next - top);
      top = next;
    }
    expect(steps[0]).toBeLessThan(6);
    expect(steps[1]).toBeGreaterThan(steps[0]!);
    expect(Math.max(...steps)).toBeLessThanOrEqual(1.1 * 16);
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
    expect(top).toBe(600);
  });

  it('retains velocity when another block extends the destination', () => {
    const motion = new BottomFollowMotion();
    let top = 0;
    let previousStep = 0;
    for (let frame = 0; frame < 30; frame += 1) {
      const next = motion.next(top, frame < 10 ? 300 : 900, 16);
      const step = next - top;
      expect(Math.abs(step - previousStep)).toBeLessThan(4);
      previousStep = step;
      top = next;
    }
  });

  it('keeps fractional progress at high refresh rates', () => {
    const motion = new BottomFollowMotion();
    let top = 0;
    for (let frame = 0; frame < 180; frame += 1) {
      const next = motion.next(top, 40, 8);
      if (Math.abs(next - top) >= 1) top = Math.round(next);
    }
    expect(top).toBe(40);
  });

  it('keeps the same timing at 60 and 120 Hz', () => {
    const positions = [8, 16].map((elapsed) => {
      const motion = new BottomFollowMotion();
      let top = 0;
      for (let time = 0; time < 240; time += elapsed) {
        top = motion.next(top, 200, elapsed);
      }
      return top;
    });
    expect(positions[0]).toBeCloseTo(positions[1]!, 5);
  });

  it('discards old momentum after direct movement or cancellation', () => {
    const motion = new BottomFollowMotion();
    let top = 0;
    for (let frame = 0; frame < 10; frame += 1) top = motion.next(top, 600, 16);
    const userTop = top + 100;
    expect(motion.next(userTop, 600, 16) - userTop).toBeLessThan(6);
    motion.reset();
    expect(motion.next(userTop, 600, 16) - userTop).toBeLessThan(6);
    expect(motion.next(userTop, userTop - 10, 16)).toBe(userTop - 10);
  });

  it('limits movement after a suspended frame', () => {
    const motion = new BottomFollowMotion();
    expect(motion.next(0, 1_000, 10_000)).toBeLessThan(12);
  });
});

describe('smooth bottom follow', () => {
  it('converges on a moving target and preserves a newer downward user position', () => {
    let top = 100;
    for (let frame = 0; frame < 30; frame += 1) {
      if (frame === 4) top = 350;
      const target = frame < 4 ? 400 : 500;
      const next = getSmoothBottomFollowTop(top, target, 16);
      expect(next).toBeGreaterThanOrEqual(top);
      expect(next).toBeLessThanOrEqual(target);
      if (frame === 0) expect(next).toBeLessThan(200);
      top = next;
    }
    expect(top).toBe(500);
  });

  it('bounds the step after a suspended frame instead of jumping to the target', () => {
    expect(getSmoothBottomFollowTop(0, 1_000, 10_000)).toBeLessThan(700);
    expect(getSmoothBottomFollowTop(999.5, 1_000, 16)).toBe(1_000);
  });

  it('lands on the destination before the follow loop considers it settled', () => {
    expect(getSmoothBottomFollowTop(998.5, 1_000, 16)).toBe(1_000);
  });
});

describe('recoverScrollAnchorDescendant', () => {
  it('preserves the captured ordinal when repeated descendants have matching text', () => {
    const renderItem = document.createElement('div');
    const first = document.createElement('p');
    const second = document.createElement('p');
    first.textContent = 'Repeated paragraph';
    second.textContent = 'Repeated paragraph';
    renderItem.append(first, second);

    expect(
      recoverScrollAnchorDescendant({
        renderItem,
        elementTag: 'P',
        elementOrdinal: 1,
        elementText: 'Repeated paragraph',
      })
    ).toBe(second);
  });
});

describe('getDistanceFromBottom', () => {
  it('returns infinity without a container', () => {
    expect(getDistanceFromBottom(null)).toBe(Number.POSITIVE_INFINITY);
  });

  it('measures remaining scroll distance', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 180,
    });

    expect(getDistanceFromBottom(container)).toBe(120);
  });
});

describe('performScrollToBottom', () => {
  it('scrolls the container and returns updated state', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 480 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 180 });
    Object.defineProperty(container, 'scrollTop', { configurable: true, writable: true, value: 0 });

    expect(performScrollToBottom({ container, now: 250, programmaticScrollWindowMs: 200 })).toEqual(
      {
        nextScrollTop: 300,
        nextIgnoreScrollUntil: 450,
      }
    );
    expect(container.scrollTop).toBe(300);
  });

  it('does not rewrite scrollTop when the container is already at the bottom', () => {
    const container = document.createElement('div');
    let scrollTop = 300;
    const writes: number[] = [];
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 480 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 180 });
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        writes.push(value);
      },
    });

    expect(performScrollToBottom({ container, now: 250, programmaticScrollWindowMs: 200 })).toEqual(
      {
        nextScrollTop: 300,
        nextIgnoreScrollUntil: 450,
      }
    );
    expect(writes).toEqual([]);
  });
});

describe('resolveAutoScrollOnUserScroll', () => {
  it('keeps auto-scroll active when the scroll matches the expected target', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 495,
        distanceFromBottom: 1,
        nearBottom: true,
        autoScroll: true,
        userScrolledUp: true,
        bottomTargetStable: false,
        followModeLocked: false,
        expectedScrollTop: 496,
        lastObservedScrollTop: 480,
        ignoreScrollUntil: 1000,
        now: 500,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: null,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 1000,
      nextLastObservedScrollTop: 495,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: false,
    });
  });

  it('disables auto-scroll when the user scrolls upward near the bottom threshold', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 460,
        distanceFromBottom: 40,
        nearBottom: true,
        autoScroll: true,
        userScrolledUp: true,
        bottomTargetStable: false,
        followModeLocked: false,
        expectedScrollTop: -1,
        lastObservedScrollTop: 495,
        ignoreScrollUntil: 0,
        now: 500,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: false,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: 460,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: true,
    });
  });

  it('disables auto-scroll for a one-pixel upward wheel movement', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 494,
        distanceFromBottom: 2,
        nearBottom: true,
        autoScroll: true,
        userScrolledUp: true,
        bottomTargetStable: false,
        followModeLocked: false,
        expectedScrollTop: -1,
        lastObservedScrollTop: 495,
        ignoreScrollUntil: 0,
        now: 500,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: false,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: 494,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: true,
    });
  });

  it('disables auto-scroll when the user pulls away from the target during a programmatic scroll window', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 200,
        distanceFromBottom: 300,
        nearBottom: false,
        autoScroll: true,
        userScrolledUp: true,
        bottomTargetStable: true,
        followModeLocked: false,
        expectedScrollTop: 500,
        lastObservedScrollTop: 480,
        ignoreScrollUntil: 1000,
        now: 500,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: false,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: 200,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: true,
    });
  });

  it('keeps auto-scroll active for a large layout shift without a wheel event', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 24_000,
        distanceFromBottom: 24_000,
        nearBottom: false,
        autoScroll: true,
        userScrolledUp: false,
        bottomTargetStable: true,
        followModeLocked: false,
        expectedScrollTop: 48_000,
        lastObservedScrollTop: 48_000,
        ignoreScrollUntil: 1000,
        now: 500,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: null,
      nextExpectedScrollTop: 48_000,
      nextIgnoreScrollUntil: 1000,
      nextLastObservedScrollTop: 24_000,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: false,
    });
  });

  it('keeps auto-scroll active when programmatic settling briefly drops below the expected target', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 57446,
        distanceFromBottom: 69,
        nearBottom: false,
        autoScroll: true,
        userScrolledUp: false,
        bottomTargetStable: true,
        followModeLocked: false,
        expectedScrollTop: 57515,
        lastObservedScrollTop: 57446,
        ignoreScrollUntil: 2000,
        now: 1900,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: null,
      nextExpectedScrollTop: 57515,
      nextIgnoreScrollUntil: 2000,
      nextLastObservedScrollTop: 57446,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: false,
    });
  });

  it('keeps auto-scroll active near bottom when scroll drift was not user initiated', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 460,
        distanceFromBottom: 40,
        nearBottom: true,
        autoScroll: true,
        userScrolledUp: false,
        bottomTargetStable: false,
        followModeLocked: false,
        expectedScrollTop: -1,
        lastObservedScrollTop: 495,
        ignoreScrollUntil: 0,
        now: 500,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: true,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: 460,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: false,
    });
  });

  it('keeps auto-scroll active when stable bottom geometry moves without user input', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 460,
        distanceFromBottom: 40,
        nearBottom: true,
        autoScroll: true,
        userScrolledUp: false,
        bottomTargetStable: true,
        followModeLocked: false,
        expectedScrollTop: -1,
        lastObservedScrollTop: 495,
        ignoreScrollUntil: 0,
        now: 500,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: true,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: 460,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: false,
    });
  });

  it('keeps following after an unprompted upward layout shift away from bottom', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 800,
        distanceFromBottom: 200,
        nearBottom: false,
        autoScroll: true,
        userScrolledUp: false,
        bottomTargetStable: true,
        followModeLocked: false,
        expectedScrollTop: -1,
        lastObservedScrollTop: 1000,
        ignoreScrollUntil: 0,
        now: 500,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: null,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: 800,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: false,
    });
  });

  it('keeps auto-scroll locked after an explicit follow request despite small stable upward drift', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 460,
        distanceFromBottom: 40,
        nearBottom: true,
        autoScroll: true,
        userScrolledUp: false,
        bottomTargetStable: true,
        followModeLocked: true,
        expectedScrollTop: -1,
        lastObservedScrollTop: 495,
        ignoreScrollUntil: 0,
        now: 500,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: true,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: 460,
      nextFollowModeLocked: true,
      shouldCancelPendingScroll: false,
    });
  });

  it('keeps the explicit follow lock active during a large non-user drift inside the programmatic window', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 57446,
        distanceFromBottom: 69,
        nearBottom: false,
        autoScroll: true,
        userScrolledUp: false,
        bottomTargetStable: true,
        followModeLocked: true,
        expectedScrollTop: 57515,
        lastObservedScrollTop: 57483,
        ignoreScrollUntil: 2000,
        now: 1900,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: null,
      nextExpectedScrollTop: 57515,
      nextIgnoreScrollUntil: 2000,
      nextLastObservedScrollTop: 57446,
      nextFollowModeLocked: true,
      shouldCancelPendingScroll: false,
    });
  });

  it('unlocks follow mode when the user intentionally pulls far away from bottom', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 380,
        distanceFromBottom: 120,
        nearBottom: false,
        autoScroll: true,
        userScrolledUp: true,
        bottomTargetStable: true,
        followModeLocked: true,
        expectedScrollTop: -1,
        lastObservedScrollTop: 495,
        ignoreScrollUntil: 0,
        now: 500,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: false,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: 380,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: true,
    });
  });

  it('keeps auto-scroll active for tiny near-bottom drift without a clear user-upward signal', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 494,
        distanceFromBottom: 2,
        nearBottom: true,
        autoScroll: true,
        userScrolledUp: false,
        bottomTargetStable: false,
        followModeLocked: false,
        expectedScrollTop: -1,
        lastObservedScrollTop: 495,
        ignoreScrollUntil: 0,
        now: 500,
        autoScrollThresholdPx: 60,
      })
    ).toEqual({
      nextAutoScroll: true,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: 494,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: false,
    });
  });
});

describe('expansion scroll anchors', () => {
  it('captures and restores anchor-relative scroll position', () => {
    const container = document.createElement('div');
    const anchor = document.createElement('button');
    container.appendChild(anchor);
    document.body.appendChild(container);

    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 200,
    });
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    container.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 500,
        left: 0,
        right: 0,
        width: 0,
        height: 400,
        x: 0,
        y: 100,
        toJSON() {},
      }) as DOMRect;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    anchor.getBoundingClientRect = () =>
      ({
        top: 150,
        bottom: 170,
        left: 0,
        right: 0,
        width: 0,
        height: 20,
        x: 0,
        y: 150,
        toJSON() {},
      }) as DOMRect;

    const captured = captureExpansionScrollAnchor({
      anchor,
      container,
      now: 10,
      windowMs: 250,
    });

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    anchor.getBoundingClientRect = () =>
      ({
        top: 170,
        bottom: 190,
        left: 0,
        right: 0,
        width: 0,
        height: 20,
        x: 0,
        y: 170,
        toJSON() {},
      }) as DOMRect;

    expect(
      restoreExpansionScrollAnchor({
        anchor: captured,
        container,
        now: 20,
        programmaticScrollWindowMs: 200,
      })
    ).toEqual({
      nextScrollTop: 220,
      nextIgnoreScrollUntil: 220,
    });
    expect(container.scrollTop).toBe(220);

    container.remove();
  });

  it('ignores expired and disconnected anchors', () => {
    const container = document.createElement('div');
    const anchor = document.createElement('button');
    document.body.append(container, anchor);
    const captured = { element: anchor, top: 10, expiresAt: 20 };

    expect(
      restoreExpansionScrollAnchor({
        anchor: captured,
        container,
        now: 21,
        programmaticScrollWindowMs: 200,
      })
    ).toBeNull();

    anchor.remove();
    expect(
      restoreExpansionScrollAnchor({
        anchor: { ...captured, expiresAt: 100 },
        container,
        now: 30,
        programmaticScrollWindowMs: 200,
      })
    ).toBeNull();
    container.remove();
  });

  it('clamps a restored anchor to the top scroll boundary', () => {
    const container = document.createElement('div');
    const anchor = document.createElement('button');
    container.append(anchor);
    document.body.append(container);
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 5,
    });
    container.getBoundingClientRect = () => new DOMRect(0, 100, 100, 100);
    anchor.getBoundingClientRect = () => new DOMRect(0, 105, 100, 20);

    expect(
      restoreExpansionScrollAnchor({
        anchor: { element: anchor, top: 30, expiresAt: 100 },
        container,
        now: 20,
        programmaticScrollWindowMs: 200,
      })
    ).toEqual({ nextScrollTop: 0, nextIgnoreScrollUntil: 220 });
    expect(container.scrollTop).toBe(0);
    container.remove();
  });

  it('does not write scrollTop for a subpixel anchor drift', () => {
    const container = document.createElement('div');
    const anchor = document.createElement('button');
    container.append(anchor);
    document.body.append(container);
    let scrollTop = 200;
    const writes: number[] = [];
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        writes.push(value);
      },
    });
    container.getBoundingClientRect = () => new DOMRect(0, 100, 100, 100);
    anchor.getBoundingClientRect = () => new DOMRect(0, 150.5, 100, 20);

    expect(
      restoreExpansionScrollAnchor({
        anchor: { element: anchor, top: 50, expiresAt: 100 },
        container,
        now: 20,
        programmaticScrollWindowMs: 200,
      })
    ).toEqual({ nextScrollTop: 200.5, nextIgnoreScrollUntil: 220 });
    expect(writes).toEqual([]);
    expect(container.scrollTop).toBe(200);
    container.remove();
  });
});
