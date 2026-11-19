import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StarterHistogram } from './StarterHistogram';
import * as tileWavesModule from './TileWaves';

describe('StarterHistogram', () => {
  let container: HTMLDivElement;
  let cleanup: (() => void) | undefined;
  let now: number;
  let reducedMotion: boolean;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let notifyResize: (() => void) | undefined;
  const colors: string[] = [];
  const alphas: number[] = [];
  const getContextDescriptor = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'getContext'
  )!;
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn<(x: number, y: number, width: number, height: number) => void>(),
    fillStyle: '',
    globalAlpha: 0,
  };

  function paint(milliseconds: number) {
    let remaining = milliseconds;
    do {
      const step = Math.min(16, remaining);
      now += step;
      remaining -= step;
      const callbacks = [...frames.values()];
      frames.clear();
      if (callbacks.length > 0) {
        context.fillRect.mockClear();
        colors.length = 0;
        alphas.length = 0;
      }
      for (const callback of callbacks) callback(now);
    } while (remaining > 0);
  }

  function hasTileAt(column: number, y: number) {
    return context.fillRect.mock.calls.some(
      ([left, top, width, height]) =>
        Math.floor((left + width / 2) / 9) === column && top + height / 2 === y
    );
  }

  function finishAnimation() {
    for (let frame = 0; frame < 1500 && frames.size > 0; frame++) paint(16);
    expect(frames.size).toBe(0);
  }

  beforeEach(() => {
    now = 0;
    nextFrame = 0;
    reducedMotion = false;
    frames = new Map();
    notifyResize = undefined;
    container = document.createElement('div');
    document.body.append(container);
    context.fillRect.mockClear();
    colors.length = 0;
    alphas.length = 0;
    context.fillRect.mockImplementation(() => {
      colors.push(context.fillStyle);
      alphas.push(context.globalAlpha);
    });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 320, 112)
    );
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      value: () => context,
      configurable: true,
    });
    const motion = new EventTarget();
    Object.defineProperty(motion, 'matches', { get: () => reducedMotion });
    vi.stubGlobal('matchMedia', () => motion);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    cleanup?.();
    container.remove();
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', getContextDescriptor);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mount() {
    const onClick = vi.fn();
    cleanup = render(() => <StarterHistogram onClick={onClick} />, container);
    paint(0);
    return { histogram: container.firstElementChild!, onClick };
  }

  function captureTileMask(): (x: number, y: number) => boolean {
    const OriginalTileWaves = tileWavesModule.TileWaves;
    let containsTile: ((x: number, y: number, now: number) => boolean) | undefined;
    vi.spyOn(tileWavesModule, 'TileWaves').mockImplementation(function (canvas, appearance) {
      containsTile = appearance?.containsTile;
      return new OriginalTileWaves(canvas, appearance);
    });
    return (x, y) => containsTile?.(x, y, now) ?? false;
  }

  it('fills narrower dim gray bars with only one-pixel separators and no internal holes', () => {
    const { histogram, onClick } = mount();
    expect(histogram.children).toHaveLength(1);
    expect(histogram.firstElementChild).toBeInstanceOf(HTMLCanvasElement);
    expect(context.fillRect).toHaveBeenCalled();
    const tips: number[] = [];
    for (let column = 0; column < 36; column++) {
      expect(hasTileAt(column, 50)).toBe(false);
      const tiles = context.fillRect.mock.calls.filter(
        ([left, , width]) => Math.floor((left + width / 2) / 9) === column
      );
      expect(tiles.length).toBeGreaterThan(5);
      for (let lane = 0; lane < 2; lane++) {
        const rows = tiles.filter(
          ([left, , width]) => Math.floor(((left + width / 2) % 9) / 4) === lane
        );
        tips.push(Math.max(...rows.map(([, top, , height]) => top + height / 2)));
        const centers = rows.map(([, top, , height]) => top + height / 2);
        expect(centers).toEqual(
          Array.from({ length: (centers.at(-1)! - 2) / 4 + 1 }, (_, index) => 2 + index * 4)
        );
      }
      const endings = tips.slice(-2);
      expect(Math.max(...endings) - Math.min(...endings)).toBe(4);
      expect(endings.filter((tip) => tip < Math.max(...endings))).toHaveLength(1);
    }
    expect(new Set(tips).size).toBeGreaterThan(1);
    expect(
      context.fillRect.mock.calls.filter(([, y, , height]) => y + height / 2 === 2)
    ).toHaveLength(72);
    const topColumns = context.fillRect.mock.calls
      .filter(([, y, , height]) => y + height / 2 === 2)
      .map(([x, , width]) => x + width / 2);
    expect(topColumns.slice(0, 6)).toEqual([2, 6, 11, 15, 20, 24]);
    expect(new Set(colors)).toEqual(new Set(['rgb(128 128 128)']));
    expect(frames.size).toBe(0);
    histogram.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps adjacent random heights as distinct flat bars instead of smoothing them together', () => {
    let calls = 0;
    vi.mocked(Math.random).mockImplementation(() => {
      if (calls++ === 0) return 0.1;
      return calls % 2 === 0 ? 0.1 : 0.9;
    });
    mount();
    expect(hasTileAt(0, 70)).toBe(false);
    expect(hasTileAt(1, 70)).toBe(true);
    const tallRow = context.fillRect.mock.calls.filter(
      ([x, y, width, height]) => x + width / 2 >= 9 && x + width / 2 < 18 && y + height / 2 === 70
    );
    expect(tallRow).toHaveLength(2);
  });

  it('uses the complete width instead of leaving gutters around a rounded-down tile grid', () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(0, 0, 333, 112)
    );
    const { histogram } = mount();
    const canvas = histogram.querySelector('canvas')!;
    expect(canvas.width).toBe(333);
    expect(canvas.style.width).toBe('333px');
    expect(context.fillRect.mock.calls.some(([x, , width]) => x + width > 330)).toBe(true);
  });

  it('scales bar heights in short layouts without stretching tiles or regenerating the original profile', () => {
    vi.mocked(Math.random).mockReturnValue(0.9);
    const { histogram } = mount();
    const canvas = histogram.querySelector('canvas')!;
    const initial = [...context.fillRect.mock.calls];
    const randomCalls = vi.mocked(Math.random).mock.calls.length;
    const sizes = new Set(initial.map(([, , width]) => width));

    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(0, 0, 320, 56)
    );
    notifyResize?.();
    paint(0);
    expect(canvas.height).toBe(56);
    expect(context.fillRect.mock.calls.length).toBeLessThan(initial.length);
    const tips = context.fillRect.mock.calls.map(([, y, , height]) => y + height / 2);
    expect(Math.max(...tips)).toBeLessThanOrEqual(46);
    expect(Math.max(...tips)).toBeGreaterThanOrEqual(38);
    expect(new Set(context.fillRect.mock.calls.map(([, , width]) => width))).toEqual(sizes);
    for (const [, , width, height] of context.fillRect.mock.calls) expect(width).toBe(height);
    expect(Math.random).toHaveBeenCalledTimes(randomCalls);

    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(0, 0, 320, 112)
    );
    notifyResize?.();
    paint(0);
    expect(canvas.height).toBe(112);
    expect(context.fillRect.mock.calls).toEqual(initial);
    expect(Math.random).toHaveBeenCalledTimes(randomCalls);
  });

  it('keeps random nearby bar changes visible at a reduced canvas height', () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(0, 0, 320, 56)
    );
    const { histogram } = mount();
    const centers = () =>
      context.fillRect.mock.calls
        .map(([x, y, width, height]) => [x + width / 2, y + height / 2].join(','))
        .join(';');
    const initial = centers();
    histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 40 }));
    let changed = false;
    for (let frame = 0; frame < 30; frame++) {
      paint(16);
      changed ||= centers() !== initial;
    }
    expect(changed).toBe(true);
  });

  it('keeps a one-to-one canvas pixel scale in fractional-height layouts so tiles never stretch', () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(0, 0, 320.25, 56.25)
    );
    const { histogram } = mount();
    const canvas = histogram.querySelector('canvas')!;
    expect(canvas.width).toBe(321);
    expect(canvas.height).toBe(57);
    expect(canvas.style.width).toBe('321px');
    expect(canvas.style.height).toBe('57px');
    for (const [, , width, height] of context.fillRect.mock.calls) {
      expect(width).toBe(height);
      expect(width).toBeCloseTo(2.22);
    }
  });

  it('preserves its baseline on reentry and bounds random wave creation during rapid pointer movement', () => {
    const { histogram } = mount();
    vi.mocked(Math.random).mockReturnValue(0.9);
    histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 42 }));
    paint(700);
    expect(hasTileAt(0, 70)).toBe(false);
    const randomCalls = vi.mocked(Math.random).mock.calls.length;
    histogram.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 10 })
    );
    expect(vi.mocked(Math.random).mock.calls.length).toBeGreaterThan(randomCalls);
    const afterMove = vi.mocked(Math.random).mock.calls.length;
    for (let index = 0; index < 100; index++) {
      histogram.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 80 + index, clientY: 10 })
      );
    }
    expect(Math.random).toHaveBeenCalledTimes(afterMove);
    histogram.dispatchEvent(new MouseEvent('pointerleave'));
    vi.mocked(Math.random).mockReturnValue(0.4);
    histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 42 }));
    paint(160);
    histogram.dispatchEvent(new MouseEvent('pointerleave'));
    finishAnimation();
    expect(hasTileAt(0, 70)).toBe(false);
    expect(hasTileAt(0, 42)).toBe(false);
    cleanup?.();
    cleanup = undefined;
    expect(frames.size).toBe(0);
  });

  it('keeps its original geometry and returns to idle with reduced motion', () => {
    reducedMotion = true;
    const { histogram, onClick } = mount();
    const initial = [...context.fillRect.mock.calls];
    expect(hasTileAt(0, 70)).toBe(false);
    vi.mocked(Math.random).mockReturnValue(0.9);
    histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 42 }));
    paint(1);
    expect(hasTileAt(0, 70)).toBe(false);
    expect(frames.size).toBe(0);
    histogram.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 166, clientY: 90 }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(context.fillRect.mock.calls).toEqual(initial);
    expect(frames.size).toBe(0);
  });

  it.each([true, false])(
    'does no interaction drawing with reduced motion, initially enabled: %s',
    (initiallyReduced) => {
      reducedMotion = initiallyReduced;
      const { histogram, onClick } = mount();
      if (!initiallyReduced) {
        histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 80, clientY: 12 }));
        paint(160);
        reducedMotion = true;
        window.matchMedia('(prefers-reduced-motion: reduce)').dispatchEvent(new Event('change'));
        paint(16);
      }
      context.clearRect.mockClear();
      context.fillRect.mockClear();
      const styles = vi.spyOn(globalThis, 'getComputedStyle');

      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 80, clientY: 12 }));
      for (let frame = 0; frame < 120; frame++) {
        histogram.dispatchEvent(
          new MouseEvent('pointermove', {
            bubbles: true,
            clientX: 20 + ((frame * 7) % 280),
            clientY: 30,
          })
        );
        paint(16);
      }
      histogram.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      histogram.dispatchEvent(new MouseEvent('pointerleave'));
      histogram.dispatchEvent(new MouseEvent('pointercancel'));
      paint(16);

      expect(onClick).toHaveBeenCalledOnce();
      expect(context.clearRect).not.toHaveBeenCalled();
      expect(context.fillRect).not.toHaveBeenCalled();
      expect(styles).not.toHaveBeenCalled();
      expect(frames.size).toBe(0);
    }
  );

  it('leaves distant groups unchanged and restores the exact original tiles after leaving', () => {
    const { histogram } = mount();
    const initial = [...context.fillRect.mock.calls];
    const distantCenters = () =>
      context.fillRect.mock.calls
        .filter(([x]) => x < 64)
        .map(([x, y, width, height]) => [x + width / 2, y + height / 2]);
    const distant = distantCenters();
    vi.mocked(Math.random).mockReturnValue(0.9);
    histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 90 }));
    for (let index = 0; index < 50; index++) {
      paint(16);
      expect(distantCenters()).toEqual(distant);
    }
    histogram.dispatchEvent(new MouseEvent('pointerleave'));
    finishAnimation();
    expect(context.fillRect.mock.calls).toEqual(initial);
    expect(frames.size).toBe(0);

    vi.mocked(Math.random).mockReturnValue(0.4);
    histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 90 }));
    paint(200);
    histogram.dispatchEvent(new MouseEvent('pointerleave'));
    finishAnimation();
    expect(context.fillRect.mock.calls).toEqual(initial);
    expect(frames.size).toBe(0);
  });

  it('randomizes nearby tips and fades wave lighting back to gray even while hovered', () => {
    const { histogram } = mount();
    vi.mocked(Math.random).mockReturnValue(0.9);
    const tip = () =>
      Math.max(
        ...context.fillRect.mock.calls
          .filter(([x]) => x >= 160 && x < 170)
          .map(([, y, , height]) => y + height / 2)
      );
    const initialTip = tip();
    histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 90 }));
    let displacement = 0;
    let colored = false;
    const waveLevels = new Set<number>();
    for (let frame = 0; frame < 200; frame++) {
      paint(16);
      displacement = Math.max(displacement, Math.abs(tip() - initialTip));
      colored ||= colors.some((color) => color !== 'rgb(128 128 128)');
      for (const [index, color] of colors.entries()) {
        if (color !== 'rgb(128 128 128)') {
          waveLevels.add(alphas[index]!);
          expect(alphas[index]).toBeLessThanOrEqual(0.42);
        }
      }
    }
    expect(displacement).toBeGreaterThanOrEqual(4);
    expect(colored).toBe(true);
    expect(waveLevels.size).toBeGreaterThanOrEqual(2);
    expect(hasTileAt(0, 50)).toBe(false);
    paint(8000);
    expect(new Set(colors)).toEqual(new Set(['rgb(128 128 128)']));
    expect(frames.size).toBe(1);
    histogram.dispatchEvent(new MouseEvent('pointerleave'));
    finishAnimation();
    expect(new Set(colors)).toEqual(new Set(['rgb(128 128 128)']));
    expect(frames.size).toBe(0);
  });

  it('starts the expanding highlight at the cursor in both axes, not as a vertical band', () => {
    const firstFrame = (y: number) => {
      now = 0;
      vi.mocked(Math.random).mockReturnValue(0.1);
      const { histogram } = mount();
      vi.mocked(Math.random).mockReturnValue(0.9);
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: y }));
      paint(16);
      const highlighted = context.fillRect.mock.calls.flatMap(([, top, , height], index) =>
        colors[index] === 'rgb(128 128 128)' ? [] : [top + height / 2]
      );
      cleanup?.();
      cleanup = undefined;
      return highlighted;
    };
    const nearTop = firstFrame(12);
    const nearBottom = firstFrame(90);
    expect(nearTop.length).toBeGreaterThan(0);
    expect(nearBottom).toHaveLength(0);
    expect(Math.max(...nearTop)).toBeLessThan(60);
  });

  it('gives each wave a different irregular contour and random tile intensities', () => {
    const sample = (seed: number) => {
      now = 0;
      vi.mocked(Math.random).mockReturnValue(0.1);
      const { histogram } = mount();
      vi.mocked(Math.random).mockReturnValue(seed);
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 28 }));
      paint(160);
      const highlighted = context.fillRect.mock.calls.flatMap(([x, y, width, height], index) =>
        colors[index] === 'rgb(128 128 128)'
          ? []
          : [[x + width / 2, y + height / 2, alphas[index]!]]
      );
      cleanup?.();
      cleanup = undefined;
      return highlighted;
    };
    const first = sample(0.1);
    expect(first.length).toBeGreaterThan(0);
    expect(sample(0.1)).toEqual(first);
    const different = sample(0.9);
    expect(different.length).toBeGreaterThan(0);
    expect(different).not.toEqual(first);
    expect(new Set([...first, ...different].map((tile) => tile[2])).size).toBeGreaterThan(1);
  });

  it.each([112, 56])(
    'expands upward and downward from the cursor at canvas height %s',
    (height) => {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
        new DOMRect(0, 0, 320, height)
      );
      vi.mocked(Math.random).mockReturnValue(0.9);
      const { histogram } = mount();
      vi.mocked(Math.random).mockReturnValue(0.1);
      const cursorY = height === 112 ? 46 : 22;
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: cursorY }));
      // Keep the bars still so this measures the radial light, not spring deformation.
      histogram.dispatchEvent(new MouseEvent('pointerleave'));
      const lastLit = new Map<number, number>();
      for (let frame = 0; frame < 100; frame++) {
        paint(16);
        for (const [index, color] of colors.entries()) {
          if (color === 'rgb(128 128 128)') continue;
          const [x, y, width, tileHeight] = context.fillRect.mock.calls[index]!;
          if (Math.abs(x + width / 2 - 166) > 4) continue;
          const centerY = y + tileHeight / 2;
          lastLit.set(centerY, now);
        }
      }
      // Broad leading edges overlap early; the trailing edge must still clear outward.
      const near = lastLit.get(cursorY)!;
      const above = lastLit.get(2)!;
      const below = lastLit.get(height === 112 ? 78 : 34)!;
      expect(near).toBeGreaterThan(0);
      const minimumTravelTime = (48 * height) / 112;
      expect(above).toBeGreaterThan(near + minimumTravelTime);
      expect(below).toBeGreaterThan(near + minimumTravelTime);
    }
  );

  it('randomizes wavefront width independently of speed and contour', () => {
    const sample = (widthRandom: number) => {
      now = 0;
      vi.mocked(Math.random).mockReturnValue(0.9);
      const { histogram } = mount();
      vi.mocked(Math.random).mockReturnValue(0.5).mockReturnValueOnce(widthRandom);
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 46 }));
      paint(320);
      const count = colors.filter((color) => color !== 'rgb(128 128 128)').length;
      cleanup?.();
      cleanup = undefined;
      return count;
    };
    const thin = sample(0);
    const broad = sample(0.99);
    expect(thin).toBeGreaterThan(0);
    expect(broad).toBeGreaterThan(thin * 2);
  });

  it('lights a broad band with dim inner and outer edges around its brighter crest', () => {
    const { histogram } = mount();
    vi.mocked(Math.random).mockReturnValue(0.5);
    histogram.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 166, clientY: 12 }));
    const traces = new Map<number, { at: number; alpha: number }[]>();
    for (let frame = 0; frame < 150; frame++) {
      paint(16);
      for (const [index, color] of colors.entries()) {
        if (color === 'rgb(128 128 128)') continue;
        const [x, y, width, height] = context.fillRect.mock.calls[index]!;
        const centerX = x + width / 2;
        if (centerX < 240 || centerX > 280 || y + height / 2 !== 2) continue;
        const trace = traces.get(centerX) ?? [];
        trace.push({ at: now, alpha: alphas[index]! });
        traces.set(centerX, trace);
      }
    }
    const trace = [...traces.values()].toSorted((a, b) => b.length - a.length)[0]!;
    const peak = Math.max(...trace.map((sample) => sample.alpha));
    expect(trace.at(-1)!.at - trace[0]!.at).toBeGreaterThanOrEqual(300);
    expect(peak).toBeGreaterThanOrEqual(0.24);
    expect(trace[0]!.alpha).toBe(0.12);
    expect(trace.at(-1)!.alpha).toBe(0.12);
    expect(trace.findIndex((sample) => sample.alpha === peak)).toBeGreaterThan(0);
    finishAnimation();
    expect(frames.size).toBe(0);
  });

  it('gives a faster sweep a stronger local response than a slow pass', () => {
    const sweep = (delay: number) => {
      now = 0;
      reducedMotion = true;
      vi.mocked(Math.random).mockReturnValue(0.5);
      const { histogram } = mount();
      const tips = () =>
        Array.from({ length: 36 }, (_, column) =>
          Math.max(
            ...context.fillRect.mock.calls
              .filter(([x]) => Math.floor(x / 9) === column)
              .map(([, y]) => y)
          )
        );
      const baseline = tips();
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 134, clientY: 20 }));
      reducedMotion = false;
      paint(delay);
      histogram.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 134, clientY: 36 })
      );
      histogram.dispatchEvent(new MouseEvent('pointerleave'));
      let peak = 0;
      for (let frame = 0; frame < 40; frame++) {
        paint(16);
        peak = Math.max(
          peak,
          tips().reduce((sum, tip, column) => sum + Math.max(0, tip - baseline[column]!), 0)
        );
      }
      cleanup?.();
      cleanup = undefined;
      expect(frames.size).toBe(0);
      return peak;
    };

    const slow = sweep(480);
    const fast = sweep(16);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow);
  });

  it('limits slow ripples locally and lets fast cursor movement reach the far edge', () => {
    const reach = (delay: number) => {
      now = 0;
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
        new DOMRect(0, 0, 960, 112)
      );
      reducedMotion = true;
      const { histogram } = mount();
      // Suppress the entry ripple to measure only the subsequent cursor velocity.
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 102, clientY: 46 }));
      reducedMotion = false;
      paint(delay);
      histogram.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 166, clientY: 46 })
      );
      histogram.dispatchEvent(new MouseEvent('pointerleave'));
      let farthest = 0;
      for (let frame = 0; frame < 1000 && frames.size > 0; frame++) {
        paint(16);
        for (const [index, color] of colors.entries()) {
          if (color === 'rgb(128 128 128)') continue;
          const [x, y, width, height] = context.fillRect.mock.calls[index]!;
          farthest = Math.max(farthest, Math.hypot(x + width / 2 - 166, y + height / 2 - 46));
        }
      }
      expect(frames.size).toBe(0);
      cleanup?.();
      cleanup = undefined;
      return farthest;
    };
    const slow = reach(1000);
    const fast = reach(48);
    expect(slow).toBeGreaterThan(40);
    expect(slow).toBeLessThan(250);
    expect(fast).toBeGreaterThan(750);
  });

  it('makes slow mouse ripples travel much slower and glow less intensely than fast sweeps', () => {
    const sample = (delay: number) => {
      now = 0;
      vi.mocked(Math.random).mockReturnValue(0.5);
      reducedMotion = true;
      const { histogram } = mount();
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 102, clientY: 12 }));
      reducedMotion = false;
      paint(delay);
      histogram.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 166, clientY: 12 })
      );
      histogram.dispatchEvent(new MouseEvent('pointerleave'));
      const startedAt = now;
      let arrival = 0;
      let peakAlpha = 0;
      for (let frame = 0; frame < 600 && frames.size > 0; frame++) {
        paint(16);
        for (const [index, color] of colors.entries()) {
          if (color === 'rgb(128 128 128)') continue;
          peakAlpha = Math.max(peakAlpha, alphas[index]!);
          const [x, y, width, height] = context.fillRect.mock.calls[index]!;
          const centerX = x + width / 2;
          if (!arrival && centerX >= 240 && centerX <= 252 && y + height / 2 === 2)
            arrival = now - startedAt;
        }
      }
      expect(frames.size).toBe(0);
      cleanup?.();
      cleanup = undefined;
      return { arrival, peakAlpha };
    };
    const slow = sample(1000);
    const fast = sample(48);
    expect(fast.arrival).toBeGreaterThan(0);
    expect(slow.arrival).toBeGreaterThan(fast.arrival * 2);
    expect(slow.peakAlpha).toBeGreaterThan(0);
    expect(slow.peakAlpha).toBeLessThan(fast.peakAlpha);
  });

  it.each([112, 56])(
    'randomizes nearby bars without following pointer height or direction at height %s',
    (height) => {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
        new DOMRect(0, 0, 320, height)
      );
      const containsTile = captureTileMask();
      const response = (direction: number) => {
        now = 0;
        reducedMotion = true;
        vi.mocked(Math.random).mockReturnValue(0.5);
        const { histogram } = mount();
        const rows = Array.from({ length: Math.ceil(height / 4) }, (_, index) => index * 4 + 2);
        const tips = () =>
          Array.from({ length: 36 }, (_, column) =>
            Math.max(
              ...rows.filter(
                (y) => containsTile(column * 9 + 2, y) || containsTile(column * 9 + 6, y)
              )
            )
          );
        const baseline = tips();
        const y = ((60 - direction * 24) * height) / 112;
        histogram.dispatchEvent(
          new MouseEvent('pointerenter', {
            clientX: 166,
            clientY: y - (direction * 16 * height) / 112,
          })
        );
        reducedMotion = false;
        paint(48);
        histogram.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: 166, clientY: y })
        );
        const randomCalls = vi.mocked(Math.random).mock.calls.length;
        const displacements: number[][] = [];
        for (let frame = 0; frame < 120; frame++) {
          paint(16);
          displacements.push(tips().map((tip, column) => tip - baseline[column]!));
        }
        expect(Math.random).toHaveBeenCalledTimes(randomCalls);
        histogram.dispatchEvent(new MouseEvent('pointerleave'));
        finishAnimation();
        expect(tips()).toEqual(baseline);
        cleanup?.();
        cleanup = undefined;
        return displacements;
      };
      const upward = response(-1);
      const downward = response(1);
      expect(downward).toEqual(upward);
      const nearby = upward.flatMap((frame) => frame.slice(12, 25));
      expect(Math.max(...nearby)).toBeGreaterThan(0);
      expect(Math.min(...nearby)).toBeLessThan(0);
      expect(upward.every((frame) => frame.slice(0, 7).every((offset) => offset === 0))).toBe(true);
    }
  );

  it('gives each interaction a fresh random set of nearby bar heights', () => {
    const containsTile = captureTileMask();
    const sample = (seed: number) => {
      now = 0;
      vi.mocked(Math.random).mockReturnValue(0.5);
      const { histogram } = mount();
      vi.mocked(Math.random).mockReturnValue(seed);
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 40 }));
      paint(160);
      const rows = Array.from({ length: 28 }, (_, row) => row * 4 + 2);
      const tips = Array.from({ length: 13 }, (_, index) => {
        const x = (12 + index) * 9;
        return Math.max(...rows.filter((y) => containsTile(x + 2, y) || containsTile(x + 6, y)));
      });
      cleanup?.();
      cleanup = undefined;
      return tips;
    };
    const first = sample(0.1);
    expect(sample(0.1)).toEqual(first);
    expect(sample(0.9)).not.toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(1);
  });

  it.each([112, 56])(
    'keeps nearby bars pulsing like a music visualizer during a stationary hover at height %s',
    (height) => {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
        new DOMRect(0, 0, 320, height)
      );
      vi.mocked(Math.random).mockReturnValue(0.5);
      const containsTile = captureTileMask();
      const { histogram } = mount();
      const initial = [...context.fillRect.mock.calls];
      const rows = Array.from({ length: Math.ceil(height / 4) }, (_, row) => row * 4 + 2);
      const tip = (column: number) =>
        Math.max(
          ...rows.filter((y) => containsTile(column * 9 + 2, y) || containsTile(column * 9 + 6, y))
        );
      const distant = Array.from({ length: 7 }, (_, column) => tip(column));
      const styles = vi.spyOn(window, 'getComputedStyle');
      histogram.dispatchEvent(
        new MouseEvent('pointerenter', { clientX: 166, clientY: height / 2 })
      );
      const randomCalls = vi.mocked(Math.random).mock.calls.length;
      const styleReads = styles.mock.calls.length;
      const layoutReads = vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length;
      paint(9000);
      expect(new Set(colors)).toEqual(new Set(['rgb(128 128 128)']));
      const left: number[] = [];
      const right: number[] = [];
      for (let sample = 0; sample < 20; sample++) {
        paint(120);
        expect(frames.size).toBe(1);
        left.push(tip(17));
        right.push(tip(18));
        expect(Array.from({ length: 7 }, (_, column) => tip(column))).toEqual(distant);
      }
      expect(new Set(left).size).toBeGreaterThanOrEqual(3);
      expect(new Set(right).size).toBeGreaterThanOrEqual(3);
      expect(left).not.toEqual(right);
      expect(Math.random).toHaveBeenCalledTimes(randomCalls);
      expect(styles).toHaveBeenCalledTimes(styleReads);
      expect(HTMLElement.prototype.getBoundingClientRect).toHaveBeenCalledTimes(layoutReads);
      histogram.dispatchEvent(new MouseEvent('pointerleave'));
      finishAnimation();
      expect(context.fillRect.mock.calls).toEqual(initial);
      const paints = context.clearRect.mock.calls.length;
      paint(160);
      expect(context.clearRect).toHaveBeenCalledTimes(paints);
    }
  );

  it.each(['reduced motion', 'hidden document'])(
    'stops the music-style hover animation for %s',
    (reason) => {
      const { histogram } = mount();
      const initial = [...context.fillRect.mock.calls];
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 40 }));
      paint(300);
      expect(frames.size).toBe(1);
      if (reason === 'reduced motion') {
        reducedMotion = true;
        window.matchMedia('(prefers-reduced-motion: reduce)').dispatchEvent(new Event('change'));
      } else {
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
        expect(frames.size).toBe(0);
        hidden.mockReturnValue(false);
        document.dispatchEvent(new Event('visibilitychange'));
      }
      paint(16);
      expect(context.fillRect.mock.calls).toEqual(initial);
      expect(frames.size).toBe(0);
    }
  );

  it.each([
    { direction: 'down', height: 112, from: 8, to: 24, targetY: 66 },
    { direction: 'up', height: 112, from: 104, to: 88, targetY: 50 },
    { direction: 'down', height: 56, from: 4, to: 12, targetY: 34 },
    { direction: 'up', height: 56, from: 52, to: 44, targetY: 26 },
  ])(
    'keeps a $direction wave traveling over histogram tiles at height $height while bars resize',
    ({ height, from, to, targetY }) => {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
        new DOMRect(0, 0, 320, height)
      );
      const containsTile = captureTileMask();
      reducedMotion = true;
      vi.mocked(Math.random).mockReturnValue(0.9);
      const { histogram } = mount();
      const initial = [...context.fillRect.mock.calls];
      expect(hasTileAt(18, targetY)).toBe(true);
      vi.mocked(Math.random).mockReturnValue(0.1);
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: from }));
      reducedMotion = false;
      paint(48);
      histogram.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 166, clientY: to })
      );
      // Keep the pointer inside to exercise wave lighting and bar resizing together.
      const firstLit = new Map<number, number>();
      let paintedOutside = false;
      for (let frame = 0; frame < 180; frame++) {
        paint(16);
        for (const [index, color] of colors.entries()) {
          if (color === 'rgb(128 128 128)') continue;
          const [x, y, width, tileHeight] = context.fillRect.mock.calls[index]!;
          paintedOutside ||= !containsTile(x + width / 2, y + tileHeight / 2);
          if (Math.abs(x + width / 2 - 166) > 4) continue;
          const centerY = y + tileHeight / 2;
          if (!firstLit.has(centerY)) firstLit.set(centerY, now);
        }
      }
      expect(firstLit.has(targetY)).toBe(true);
      expect(paintedOutside).toBe(false);
      const nearY = to + (targetY > to ? 10 : -10);
      expect(firstLit.get(targetY)!).toBeGreaterThan(firstLit.get(nearY)!);
      histogram.dispatchEvent(new MouseEvent('pointerleave'));
      finishAnimation();
      expect(context.fillRect.mock.calls).toEqual(initial);
    }
  );

  it.each([
    { edge: 'top', from: 2, to: 6 },
    { edge: 'bottom', from: 110, to: 108 },
  ])('preserves vertical pointer movement near the $edge edge', ({ from, to }) => {
    vi.mocked(Math.random).mockReturnValue(0.9);
    reducedMotion = true;
    const { histogram } = mount();
    histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: from }));
    reducedMotion = false;
    paint(48);
    histogram.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 166, clientY: to })
    );
    histogram.dispatchEvent(new MouseEvent('pointerleave'));
    let highlights = 0;
    for (let frame = 0; frame < 200; frame++) {
      paint(16);
      highlights += colors.filter((color) => color !== 'rgb(128 128 128)').length;
    }
    expect(highlights).toBeGreaterThan(0);
    finishAnimation();
  });

  it.each(
    [112, 56].flatMap((height) =>
      [
        { direction: 'right', dx: 24, dy: 0 },
        { direction: 'left', dx: -24, dy: 0 },
        { direction: 'down', dx: 0, dy: 24 },
        { direction: 'up', dx: 0, dy: -24 },
        { direction: 'down-right', dx: 24, dy: 24 },
        { direction: 'down-left', dx: -24, dy: 24 },
        { direction: 'up-right', dx: 24, dy: -24 },
        { direction: 'up-left', dx: -24, dy: -24 },
      ].map((motion) => ({ ...motion, height, dy: (motion.dy * height) / 112 }))
    )
  )('radiates only $direction in a forward sector at height $height', ({ height, dx, dy }) => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(0, 0, 320, height)
    );
    vi.mocked(Math.random).mockReturnValue(0.9);
    reducedMotion = true;
    const { histogram } = mount();
    const x = 166;
    const y = height === 112 ? 46 : 22;
    histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: x - dx, clientY: y - dy }));
    reducedMotion = false;
    paint(48);
    const angles = vi.spyOn(Math, 'atan2');
    histogram.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y })
    );
    const cachedAngles = angles.mock.calls.length;
    histogram.dispatchEvent(new MouseEvent('pointerleave'));
    let highlights = 0;
    let centerPeak = 0;
    let edgePeak = 0;
    for (let frame = 0; frame < 200 && frames.size > 0; frame++) {
      paint(16);
      for (const [index, color] of colors.entries()) {
        if (color === 'rgb(128 128 128)') continue;
        const [left, top, width, tileHeight] = context.fillRect.mock.calls[index]!;
        const tileDx = left + width / 2 - x;
        const tileDy = top + tileHeight / 2 - y;
        const alignment =
          (tileDx * dx + tileDy * dy) / (Math.hypot(tileDx, tileDy) * Math.hypot(dx, dy));
        expect(alignment).toBeGreaterThan(0.5);
        if (alignment > 0.95) centerPeak = Math.max(centerPeak, alphas[index]!);
        if (alignment < 0.7) edgePeak = Math.max(edgePeak, alphas[index]!);
        highlights++;
      }
    }
    expect(highlights).toBeGreaterThan(0);
    if (dx === 24 && dy === 0 && height === 112) {
      expect(edgePeak).toBeGreaterThan(0);
      expect(centerPeak).toBeGreaterThan(edgePeak);
    }
    finishAnimation();
    expect(cachedAngles).toBeGreaterThan(0);
    expect(angles).toHaveBeenCalledTimes(cachedAngles);
  });

  it('keeps highlights soft with a narrower brightness range and stable per-wave randomness', () => {
    const { histogram } = mount();
    histogram.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 166, clientY: 12 }));
    let dim = 0;
    let bright = 0;
    let peakAlpha = 0;
    for (let frame = 0; frame < 240; frame++) {
      paint(16);
      for (const [index, color] of colors.entries()) {
        if (color === 'rgb(128 128 128)') continue;
        peakAlpha = Math.max(peakAlpha, alphas[index]!);
        if (alphas[index]! <= 0.24) dim++;
        else bright++;
      }
    }
    expect(bright).toBeGreaterThan(0);
    expect(dim).toBeGreaterThan(bright * 3);
    expect(peakAlpha).toBe(0.42);
    const randomCalls = vi.mocked(Math.random).mock.calls.length;
    paint(32);
    expect(Math.random).toHaveBeenCalledTimes(randomCalls);
  });

  it('starts a separate wave at the moved cursor while the original wave keeps its contour and timing', () => {
    const sample = (move: boolean) => {
      now = 0;
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
        new DOMRect(0, 0, 960, 112)
      );
      vi.mocked(Math.random).mockReturnValue(0.9);
      const { histogram } = mount();
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 42, clientY: 12 }));
      paint(320);
      if (move)
        histogram.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: 600, clientY: 12 })
        );
      const originalFrames: number[][][] = [];
      let newOriginLit = false;
      for (let frame = 0; frame < 30; frame++) {
        paint(16);
        originalFrames.push(
          context.fillRect.mock.calls.flatMap(([x, y, width, height], index) =>
            x + width / 2 < 200 && y + height / 2 === 2 ? [[x + width / 2, alphas[index]!]] : []
          )
        );
        if (frame < 5)
          newOriginLit ||= colors.some((color, index) => {
            const [x, y, width, height] = context.fillRect.mock.calls[index]!;
            return (
              color !== 'rgb(128 128 128)' &&
              Math.abs(x + width / 2 - 600) < 20 &&
              y + height / 2 <= 18
            );
          });
      }
      cleanup?.();
      cleanup = undefined;
      expect(frames.size).toBe(0);
      return { originalFrames, newOriginLit };
    };
    const still = sample(false);
    const moved = sample(true);
    expect(still.newOriginLit).toBe(false);
    expect(moved.newOriginLit).toBe(true);
    expect(moved.originalFrames).toEqual(still.originalFrames);
    expect(still.originalFrames.some((frame) => frame.some(([, alpha]) => alpha === 0.24))).toBe(
      true
    );
  });

  it('lets existing random bar changes settle independently of a distant cursor origin', () => {
    const sample = (move: boolean) => {
      now = 0;
      vi.mocked(Math.random).mockReturnValue(0.1);
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
        new DOMRect(0, 0, 960, 112)
      );
      const { histogram } = mount();
      histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 42, clientY: 90 }));
      histogram.dispatchEvent(new MouseEvent('pointerleave'));
      paint(180);
      if (move)
        histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 600, clientY: 90 }));
      const tips: number[] = [];
      for (let frame = 0; frame < 35; frame++) {
        paint(16);
        tips.push(
          Math.max(
            ...context.fillRect.mock.calls
              .filter(([x, , width]) => Math.abs(x + width / 2 - 60) < 10)
              .map(([, y, , height]) => y + height / 2)
          )
        );
      }
      cleanup?.();
      cleanup = undefined;
      expect(frames.size).toBe(0);
      return tips;
    };
    const original = sample(false);
    expect(new Set(original).size).toBeGreaterThan(1);
    expect(sample(true)).toEqual(original);
  });

  it.each([0.1, 0.5, 0.9])('keeps the orange wave visibly populated for wave seed %s', (seed) => {
    const { histogram } = mount();
    vi.mocked(Math.random).mockReturnValue(seed);
    histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 90 }));
    let peakHighlights = 0;
    for (let frame = 0; frame < 200; frame++) {
      paint(16);
      peakHighlights = Math.max(
        peakHighlights,
        colors.filter((color) => color !== 'rgb(128 128 128)').length
      );
    }
    expect(peakHighlights).toBeGreaterThanOrEqual(20);
    histogram.dispatchEvent(new MouseEvent('pointerleave'));
    finishAnimation();
    expect(new Set(colors)).toEqual(new Set(['rgb(128 128 128)']));
    expect(frames.size).toBe(0);
  });

  it.each([320, 960])(
    'propagates highlights across every bar at width %s without ending playback early',
    (width) => {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
        new DOMRect(0, 0, width, 112)
      );
      const { histogram } = mount();
      vi.mocked(Math.random).mockReturnValue(0.9);
      histogram.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 166, clientY: 90 })
      );
      const firstHighlightedAt = new Map<number, number>();
      const count = Math.ceil(width / 9);
      for (let frame = 0; frame < 800; frame++) {
        paint(16);
        for (const [index, color] of colors.entries()) {
          if (color === 'rgb(128 128 128)') continue;
          const [x, , size] = context.fillRect.mock.calls[index]!;
          const column = Math.floor((x + size / 2) / 9);
          if (!firstHighlightedAt.has(column)) firstHighlightedAt.set(column, frame);
        }
      }
      expect(firstHighlightedAt.size).toBe(count);
      expect(firstHighlightedAt.has(0)).toBe(true);
      expect(firstHighlightedAt.has(count - 1)).toBe(true);
      if (width === 960)
        expect(firstHighlightedAt.get(count - 1)!).toBeGreaterThan(firstHighlightedAt.get(0)!);
      if (width === 320) expect(firstHighlightedAt.get(count - 1)! * 16).toBeGreaterThan(500);
      expect(new Set(colors)).toEqual(new Set(['rgb(128 128 128)']));
      expect(frames.size).toBe(0);
    }
  );

  it('lets a full-width wave finish while the cursor keeps moving', () => {
    const width = 960;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(0, 0, width, 112)
    );
    const { histogram } = mount();
    vi.mocked(Math.random).mockReturnValue(0.9);
    histogram.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 166, clientY: 90 }));
    const highlighted = new Set<number>();
    for (let frame = 0; frame < 800; frame++) {
      histogram.dispatchEvent(
        new MouseEvent('pointermove', {
          bubbles: true,
          clientX: 166 + Math.sin(frame / 5) * 24,
          clientY: 80 + Math.sin(frame / 7) * 10,
        })
      );
      paint(16);
      for (const [index, color] of colors.entries()) {
        if (color === 'rgb(128 128 128)') continue;
        const [x, , size] = context.fillRect.mock.calls[index]!;
        highlighted.add(Math.floor((x + size / 2) / 9));
      }
    }
    expect(highlighted.size).toBe(Math.ceil(width / 9));
    histogram.dispatchEvent(new MouseEvent('pointerleave'));
    finishAnimation();
    expect(new Set(colors)).toEqual(new Set(['rgb(128 128 128)']));
    expect(frames.size).toBe(0);
  });

  it('keeps slow ongoing mouse movement local instead of repeatedly lighting the far edge', () => {
    const width = 960;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(0, 0, width, 112)
    );
    const { histogram } = mount();
    vi.mocked(Math.random).mockReturnValue(0.9);
    histogram.dispatchEvent(new MouseEvent('pointerenter', { clientX: 166, clientY: 90 }));
    let localHighlights = 0;
    let edgeHighlights = 0;
    for (let frame = 0; frame < 1200; frame++) {
      histogram.dispatchEvent(
        new MouseEvent('pointermove', {
          bubbles: true,
          clientX: 166 + Math.min(frame % 280, 280 - (frame % 280)) * 0.25,
          clientY: 90,
        })
      );
      paint(16);
      const edgeLit = colors.some((color, index) => {
        if (color === 'rgb(128 128 128)') return false;
        const [x, , size] = context.fillRect.mock.calls[index]!;
        const center = x + size / 2;
        return center >= width - 9 && center < width;
      });
      if (edgeLit) edgeHighlights++;
      if (now > 8000 && colors.some((color) => color !== 'rgb(128 128 128)')) localHighlights++;
    }
    expect(localHighlights).toBeGreaterThan(100);
    expect(edgeHighlights).toBe(0);
    histogram.dispatchEvent(new MouseEvent('pointerleave'));
    finishAnimation();
    expect(frames.size).toBe(0);
  });

  it('randomizes nearby bars on click without changing distant groups or the resting shape', () => {
    const { histogram, onClick } = mount();
    const initial = [...context.fillRect.mock.calls];
    const distant = initial.filter(([x]) => x < 64);
    const initialCenters = initial
      .map(([x, y, width, height]) => [x + width / 2, y + height / 2].join(','))
      .join(';');
    histogram.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 166, clientY: 90 }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(frames.size).toBe(1);
    let moved = false;
    for (let frame = 0; frame < 30; frame++) {
      paint(16);
      moved ||=
        context.fillRect.mock.calls
          .map(([x, y, width, height]) => [x + width / 2, y + height / 2].join(','))
          .join(';') !== initialCenters;
      // Compare centers because a light wave can change square size without moving its tile.
      expect(
        context.fillRect.mock.calls
          .filter(([x]) => x < 64)
          .map(([x, y, width, height]) => [x + width / 2, y + height / 2])
      ).toEqual(distant.map(([x, y, width, height]) => [x + width / 2, y + height / 2]));
    }
    expect(moved).toBe(true);
    histogram.dispatchEvent(new MouseEvent('pointerleave'));
    finishAnimation();
    expect(context.fillRect.mock.calls).toEqual(initial);
    expect(frames.size).toBe(0);
  });
});
