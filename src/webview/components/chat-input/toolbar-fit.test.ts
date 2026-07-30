import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolbarFitter } from './toolbar-fit';
import { TOOLBAR_COMPACT_MODES } from './toolbar-compact';
import type { ToolbarCompactMode } from './toolbar-compact';

// jsdom reports every layout measurement as 0, so the widths the fitter reads are stubbed
// directly. `available` is the toolbar budget; `required` is what the two groups need.
function createHarness(options: {
  available: number;
  required: (mode: ToolbarCompactMode) => number;
}) {
  const modes: ToolbarCompactMode[] = [];
  let currentMode: ToolbarCompactMode = 'full';
  let available = options.available;

  const toolbar = document.createElement('div');
  const left = document.createElement('div');
  const right = document.createElement('div');
  document.body.append(toolbar, left, right);

  Object.defineProperty(toolbar, 'clientWidth', { get: () => available });
  Object.defineProperty(left, 'scrollWidth', { get: () => options.required(currentMode) });
  right.getBoundingClientRect = () => ({ width: 0 }) as DOMRect;

  const fitter = createToolbarFitter({
    getToolbar: () => toolbar,
    getLeftGroup: () => left,
    getRightGroup: () => right,
    setMode: (mode) => {
      currentMode = mode;
      modes.push(mode);
    },
  });

  return {
    fitter,
    modes,
    getMode: () => currentMode,
    setAvailable: (nextAvailable: number) => {
      available = nextAvailable;
    },
  };
}

// The fitter alternates requestAnimationFrame and queueMicrotask, so draining it means running
// the frame callback and then letting the queued microtask chain settle.
async function settle(frames = TOOLBAR_COMPACT_MODES.length + 2) {
  for (let index = 0; index < frames; index += 1) {
    await Promise.resolve();
  }
}

let frameCallbacks: FrameRequestCallback[] = [];

function runFrames() {
  const pending = frameCallbacks;
  frameCallbacks = [];
  for (const callback of pending) callback(0);
}

describe('createToolbarFitter', () => {
  beforeEach(() => {
    frameCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      frameCallbacks[handle - 1] = () => {};
    });
    vi.stubGlobal(
      'getComputedStyle',
      () => ({ columnGap: '0px', gap: '0px' }) as CSSStyleDeclaration
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('stays on the full layout when the controls already fit', async () => {
    const { fitter, modes } = createHarness({ available: 500, required: () => 100 });

    fitter.schedule();
    runFrames();
    await settle();

    expect(modes).toEqual(['full']);
  });

  it('steps down one mode at a time until the toolbar stops overflowing', async () => {
    // Each successive compact mode reclaims 40px; 'compact-agent' is the first that fits.
    const widthByMode = new Map<ToolbarCompactMode, number>(
      TOOLBAR_COMPACT_MODES.map((mode, index) => [mode, 200 - index * 40])
    );
    const { fitter, modes, getMode } = createHarness({
      available: 100,
      required: (mode) => widthByMode.get(mode) ?? 0,
    });

    fitter.schedule();
    runFrames();
    await settle();

    expect(modes).toEqual(['full', 'compact-provider-limit', 'compact-stop', 'compact-agent']);
    expect(getMode()).toBe('compact-agent');
  });

  it('stops at the tightest mode when nothing fits', async () => {
    const { fitter, modes, getMode } = createHarness({ available: 10, required: () => 999 });

    fitter.schedule();
    runFrames();
    await settle();

    expect(modes).toEqual(TOOLBAR_COMPACT_MODES);
    expect(getMode()).toBe('tight');
    // The walk must terminate rather than re-entering on the tightest mode.
    await settle();
    expect(modes).toEqual(TOOLBAR_COMPACT_MODES);
  });

  it('treats a one pixel overshoot as fitting', async () => {
    const { fitter, modes } = createHarness({ available: 100, required: () => 101 });

    fitter.schedule();
    runFrames();
    await settle();

    expect(modes).toEqual(['full']);
  });

  it('counts the column gap against the available width', async () => {
    vi.stubGlobal(
      'getComputedStyle',
      () => ({ columnGap: '20px', gap: '0px' }) as CSSStyleDeclaration
    );
    const { fitter, modes } = createHarness({ available: 100, required: () => 95 });

    fitter.schedule();
    runFrames();
    await settle();

    // 95 + 20 > 100 + 1, so the fitter has to compact at least once.
    expect(modes.length).toBeGreaterThan(1);
  });

  it('falls back to the shorthand gap when no column gap is set', async () => {
    vi.stubGlobal(
      'getComputedStyle',
      () => ({ columnGap: '', gap: '20px' }) as CSSStyleDeclaration
    );
    const { fitter, modes } = createHarness({ available: 100, required: () => 95 });

    fitter.schedule();
    runFrames();
    await settle();

    expect(modes.length).toBeGreaterThan(1);
  });

  it('ignores an unparseable gap instead of poisoning the comparison', async () => {
    vi.stubGlobal(
      'getComputedStyle',
      () => ({ columnGap: 'normal', gap: 'normal' }) as CSSStyleDeclaration
    );
    const { fitter, modes } = createHarness({ available: 100, required: () => 95 });

    fitter.schedule();
    runFrames();
    await settle();

    expect(modes).toEqual(['full']);
  });

  it('lets a newer schedule supersede a walk that is already in flight', async () => {
    const { fitter, modes } = createHarness({ available: 10, required: () => 999 });

    fitter.schedule();
    runFrames();
    await Promise.resolve();
    const modesBeforeRestart = modes.length;

    fitter.schedule();
    runFrames();
    await settle();

    expect(modes[modesBeforeRestart]).not.toBe('full');
    expect(modes.at(-1)).toBe('tight');
  });

  it('does not replay the compact-mode ladder at an unchanged narrow width', async () => {
    const { fitter, modes } = createHarness({ available: 10, required: () => 999 });

    fitter.schedule();
    runFrames();
    await settle();
    expect(modes).toEqual(TOOLBAR_COMPACT_MODES);

    const appliedModeCount = modes.length;
    for (let index = 0; index < 20; index += 1) {
      fitter.schedule();
      runFrames();
      await settle();
    }

    expect(modes).toHaveLength(appliedModeCount);
  });

  it('walks incrementally from the current mode as width grows', async () => {
    const widthByMode = new Map<ToolbarCompactMode, number>(
      TOOLBAR_COMPACT_MODES.map((mode, index) => [mode, 220 - index * 20])
    );
    const { fitter, modes, getMode, setAvailable } = createHarness({
      available: 100,
      required: (mode) => widthByMode.get(mode) ?? 0,
    });

    fitter.schedule();
    runFrames();
    await settle();
    const compactMode = getMode();
    const initialModeCount = modes.length;

    setAvailable(130);
    fitter.schedule();
    runFrames();
    await settle();

    expect(TOOLBAR_COMPACT_MODES.indexOf(getMode())).toBeLessThan(
      TOOLBAR_COMPACT_MODES.indexOf(compactMode)
    );
    expect(modes.slice(initialModeCount)).not.toContain('full');
  });

  it('does not retry a failed looser mode on every growing-width frame', async () => {
    const widthByMode = new Map<ToolbarCompactMode, number>(
      TOOLBAR_COMPACT_MODES.map((mode, index) => [mode, 200 - index * 20])
    );
    const { fitter, modes, getMode, setAvailable } = createHarness({
      available: 100,
      required: (mode) => widthByMode.get(mode) ?? 0,
    });

    fitter.schedule();
    runFrames();
    await settle();
    expect(widthByMode.get(getMode())).toBeLessThanOrEqual(101);

    setAvailable(105);
    fitter.schedule();
    runFrames();
    await settle();
    const appliedAfterFailedExpansion = modes.length;

    for (let width = 106; width < 119; width += 1) {
      setAvailable(width);
      fitter.schedule();
      runFrames();
      await settle();
    }

    expect(modes).toHaveLength(appliedAfterFailedExpansion);
    setAvailable(119);
    fitter.schedule();
    runFrames();
    await settle();
    expect(widthByMode.get(getMode())).toBe(120);
  });

  it('coalesces repeated schedules into a single frame', async () => {
    const { fitter, modes } = createHarness({ available: 500, required: () => 100 });

    fitter.schedule();
    fitter.schedule();
    fitter.schedule();
    runFrames();
    await settle();

    expect(modes).toEqual(['full']);
  });

  it('cancel abandons a scheduled fit before it runs', async () => {
    const { fitter, modes } = createHarness({ available: 10, required: () => 999 });

    fitter.schedule();
    fitter.cancel();
    runFrames();
    await settle();

    expect(modes).toEqual([]);
  });

  it('cancel stops a walk that is midway through the ladder', async () => {
    const { fitter, modes } = createHarness({ available: 10, required: () => 999 });

    fitter.schedule();
    runFrames();
    await Promise.resolve();
    const modesAtCancel = modes.length;
    fitter.cancel();
    await settle();

    expect(modes.length).toBe(modesAtCancel);
    expect(modes.at(-1)).not.toBe('tight');
  });

  it('can be scheduled again after a cancel', async () => {
    const { fitter, modes } = createHarness({ available: 500, required: () => 100 });

    fitter.schedule();
    fitter.cancel();
    runFrames();
    await settle();
    expect(modes).toEqual([]);

    fitter.schedule();
    runFrames();
    await settle();

    expect(modes).toEqual(['full']);
  });

  it('reports no overflow while the toolbar refs are still unset', async () => {
    const modes: ToolbarCompactMode[] = [];
    const fitter = createToolbarFitter({
      getToolbar: () => undefined,
      getLeftGroup: () => undefined,
      getRightGroup: () => undefined,
      setMode: (mode) => modes.push(mode),
    });

    fitter.schedule();
    runFrames();
    await settle();

    expect(modes).toEqual(['full']);
  });
});
