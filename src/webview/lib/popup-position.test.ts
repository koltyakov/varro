import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  alignPopupToBoundary,
  clampPopupToViewport,
  flipPopupDownIfNeeded,
  observePopupViewport,
  placeDropdownAnchor,
} from './popup-position';

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

function mockRect(el: HTMLElement, rect: { top: number; bottom: number }) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 40,
    y: rect.top,
    top: rect.top,
    right: 280,
    bottom: rect.bottom,
    left: 40,
    width: 240,
    height: rect.bottom - rect.top,
    toJSON: () => ({}),
  });
}

function mockOffsetParent(el: HTMLElement, parent: HTMLElement | null) {
  Object.defineProperty(el, 'offsetParent', { get: () => parent, configurable: true });
}

afterEach(() => {
  window.innerWidth = originalInnerWidth;
  window.innerHeight = originalInnerHeight;
  vi.restoreAllMocks();
});

describe('popup-position', () => {
  it('leaves dropdown menus uncapped and anchored above when they fit', () => {
    const anchor = document.createElement('div');
    const menu = document.createElement('div');
    mockOffsetParent(anchor, null);
    mockRect(menu, { top: 120, bottom: 420 });

    placeDropdownAnchor(anchor, menu, 10);

    expect(menu.style.maxHeight).toBe('');
    expect(anchor.style.bottom).toBe('100%');
    expect(anchor.style.paddingBottom).toBe('10px');
  });

  it('caps dropdown menus to the space above their bottom edge', () => {
    const anchor = document.createElement('div');
    const menu = document.createElement('div');
    mockOffsetParent(anchor, null);
    mockRect(menu, { top: -24, bottom: 420 });

    placeDropdownAnchor(anchor, menu, 10);

    expect(menu.style.maxHeight).toBe('412px');
    expect(anchor.style.bottom).toBe('100%');
  });

  it('lifts upward dropdown menus above a banner stacked over the host', () => {
    const host = document.createElement('div');
    mockRect(host, { top: 200, bottom: 260 });

    const banner = document.createElement('div');
    mockRect(banner, { top: 160, bottom: 184 });

    const anchor = document.createElement('div');
    const menu = document.createElement('div');
    mockOffsetParent(anchor, host);
    mockRect(menu, { top: 120, bottom: 150 });

    placeDropdownAnchor(anchor, menu, 10, 8, banner);

    expect(anchor.style.bottom).toBe('calc(100% + 40px)');
    expect(anchor.style.top).toBe('auto');
  });

  it('flips below the host when lifting above a banner would clip the menu', () => {
    window.innerHeight = 600;

    const host = document.createElement('div');
    mockRect(host, { top: 100, bottom: 160 });

    const banner = document.createElement('div');
    mockRect(banner, { top: 60, bottom: 84 });

    const anchor = document.createElement('div');
    const menu = document.createElement('div');
    mockOffsetParent(anchor, host);
    mockRect(menu, { top: -24, bottom: 80 });

    placeDropdownAnchor(anchor, menu, 10, 8, banner);

    expect(anchor.style.top).toBe('100%');
    expect(anchor.style.bottom).toBe('auto');
  });

  it('flips dropdown menus below their host when there is more room below', () => {
    window.innerHeight = 600;

    const host = document.createElement('div');
    mockRect(host, { top: 100, bottom: 160 });

    const anchor = document.createElement('div');
    const menu = document.createElement('div');
    mockOffsetParent(anchor, host);
    mockRect(menu, { top: -24, bottom: 80 });

    placeDropdownAnchor(anchor, menu, 10);

    expect(anchor.style.top).toBe('100%');
    expect(anchor.style.bottom).toBe('auto');
    expect(anchor.style.paddingTop).toBe('10px');
    expect(anchor.style.paddingBottom).toBe('0px');
  });

  it('keeps upward popups in place when they are not clipped', () => {
    const trigger = document.createElement('div');
    mockRect(trigger, { top: 400, bottom: 424 });

    const popup = document.createElement('div');
    mockOffsetParent(popup, trigger);
    mockRect(popup, { top: 278, bottom: 398 });

    expect(flipPopupDownIfNeeded(popup)).toBe(false);
    expect(popup.style.top).toBe('');
    expect(popup.style.bottom).toBe('');
  });

  it('flips clipped upward popups below their trigger, mirroring the gap', () => {
    window.innerHeight = 600;

    const trigger = document.createElement('div');
    mockRect(trigger, { top: 82, bottom: 104 });

    const popup = document.createElement('div');
    mockOffsetParent(popup, trigger);
    mockRect(popup, { top: -40, bottom: 80 });

    expect(flipPopupDownIfNeeded(popup)).toBe(true);
    expect(popup.style.top).toBe('calc(100% + 2px)');
    expect(popup.style.bottom).toBe('auto');
  });

  it('treats scrollable ancestors as the top bound when flipping', () => {
    window.innerHeight = 600;

    const list = document.createElement('div');
    list.style.overflowY = 'auto';
    document.body.appendChild(list);
    mockRect(list, { top: 50, bottom: 580 });

    const trigger = document.createElement('div');
    list.appendChild(trigger);
    mockRect(trigger, { top: 162, bottom: 184 });

    const popup = document.createElement('div');
    trigger.appendChild(popup);
    mockOffsetParent(popup, trigger);
    // Above the viewport-top margin, but inside the zone the sticky header
    // overlays (the list starts at y=50).
    mockRect(popup, { top: 40, bottom: 160 });

    try {
      expect(flipPopupDownIfNeeded(popup)).toBe(true);
      expect(popup.style.top).toBe('calc(100% + 2px)');
    } finally {
      list.remove();
    }
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
