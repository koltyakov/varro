import { describe, expect, it } from 'vitest';
import {
  captureExpansionScrollAnchor,
  getDistanceFromBottom,
  performScrollToBottom,
  resolveAutoScrollOnUserScroll,
  restoreExpansionScrollAnchor,
} from './scrolling';

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

  it('disables auto-scroll for a large upward pull from the expected target without a wheel event', () => {
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
      nextAutoScroll: false,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: 24_000,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: true,
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

  it('disables auto-scroll near bottom when the user scrolls upward and the bottom target is stable', () => {
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
      nextAutoScroll: false,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: 460,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: true,
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
});
