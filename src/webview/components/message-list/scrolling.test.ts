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
        nearBottom: true,
        autoScroll: true,
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
      shouldCancelPendingScroll: false,
    });
  });

  it('disables auto-scroll when the user pulls away from the target during a programmatic scroll window', () => {
    expect(
      resolveAutoScrollOnUserScroll({
        top: 200,
        nearBottom: false,
        autoScroll: true,
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
      shouldCancelPendingScroll: true,
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
