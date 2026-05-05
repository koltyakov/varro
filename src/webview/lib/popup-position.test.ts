import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  alignPopupToBoundary,
  clampAnchoredPopupHeight,
  clampPopupToViewport,
  observePopupViewport,
} from './popup-position';

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

afterEach(() => {
  window.innerWidth = originalInnerWidth;
  window.innerHeight = originalInnerHeight;
  vi.restoreAllMocks();
});

describe('popup-position', () => {
  it('leaves anchored popups uncapped when they fit above the anchor', () => {
    const el = document.createElement('div');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 120,
      top: 120,
      right: 280,
      bottom: 420,
      left: 40,
      width: 240,
      height: 300,
      toJSON: () => ({}),
    });

    clampAnchoredPopupHeight(el);

    expect(el.style.maxHeight).toBe('');
  });

  it('caps anchored popups to the space above their bottom edge', () => {
    const el = document.createElement('div');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: -24,
      top: -24,
      right: 280,
      bottom: 420,
      left: 40,
      width: 240,
      height: 444,
      toJSON: () => ({}),
    });

    clampAnchoredPopupHeight(el);

    expect(el.style.maxHeight).toBe('412px');
  });

  it('translates free-floating popups horizontally and caps vertical overflow', () => {
    window.innerWidth = 300;
    window.innerHeight = 260;

    const el = document.createElement('div');
    const rects = [
      {
        x: 120,
        y: 40,
        top: 40,
        right: 360,
        bottom: 340,
        left: 120,
        width: 240,
        height: 300,
        toJSON: () => ({}),
      },
      {
        x: 52,
        y: 40,
        top: 40,
        right: 292,
        bottom: 340,
        left: 52,
        width: 240,
        height: 300,
        toJSON: () => ({}),
      },
    ];
    const getBoundingClientRect = vi.spyOn(el, 'getBoundingClientRect');
    getBoundingClientRect.mockImplementation(() => rects.shift() ?? rects[rects.length - 1]!);

    clampPopupToViewport(el);

    expect(el.style.transform).toBe('translateX(-68px)');
    expect(el.style.maxHeight).toBe('212px');
  });

  it('right-aligns popups to a boundary edge', () => {
    const popup = document.createElement('div');
    const parent = document.createElement('div');
    parent.appendChild(popup);
    document.body.appendChild(parent);

    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({
      x: 140,
      y: 0,
      top: 0,
      left: 140,
      right: 220,
      bottom: 24,
      width: 80,
      height: 24,
      toJSON: () => ({}),
    });

    const boundary = document.createElement('div');
    vi.spyOn(boundary, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 220,
      bottom: 24,
      width: 220,
      height: 24,
      toJSON: () => ({}),
    });

    alignPopupToBoundary(popup, boundary, 'right');

    expect(popup.style.left).toBe('auto');
    expect(popup.style.right).toBe('0px');
  });

  it('observes popup and window changes for repositioning', async () => {
    const observed: Element[] = [];
    let disconnected = false;
    let resizeCallback: ResizeObserverCallback | undefined;
    const originalResizeObserver = globalThis.ResizeObserver;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe(target: Element) {
        observed.push(target);
      }

      disconnect() {
        disconnected = true;
      }
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;

    const el = document.createElement('div');
    const reposition = vi.fn();

    try {
      const cleanup = observePopupViewport(el, reposition);
      await Promise.resolve();

      expect(reposition).toHaveBeenCalledTimes(1);
      expect(observed).toEqual([el]);

      resizeCallback?.([], {} as ResizeObserver);
      await Promise.resolve();
      expect(reposition).toHaveBeenCalledTimes(2);

      window.dispatchEvent(new Event('resize'));
      await Promise.resolve();
      expect(reposition).toHaveBeenCalledTimes(3);

      cleanup();
      expect(disconnected).toBe(true);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
