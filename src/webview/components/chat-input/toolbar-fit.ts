import { TOOLBAR_COMPACT_MODES } from './toolbar-compact';
import type { ToolbarCompactMode } from './toolbar-compact';

export type ToolbarFitPorts = {
  /** The toolbar row whose client width is the space budget. */
  getToolbar: () => HTMLElement | undefined;
  /** Left group; measured by scrollWidth so its natural width survives shrinking. */
  getLeftGroup: () => HTMLElement | undefined;
  /** Right group; measured by its rendered width. */
  getRightGroup: () => HTMLElement | undefined;
  setMode: (mode: ToolbarCompactMode) => void;
};

export type ToolbarFitter = {
  /** Re-runs the fit on the next animation frame, superseding any pending run. */
  schedule: () => void;
  /** Abandons a pending or in-flight fit, e.g. on unmount. */
  cancel: () => void;
};

/**
 * Steps the composer toolbar down through {@link TOOLBAR_COMPACT_MODES} until its controls stop
 * overflowing. Each step has to be re-measured after the DOM applies the previous mode, so the
 * walk is spread across microtasks and guarded by a request id: a newer `schedule()` invalidates
 * an in-flight walk instead of letting two walks fight over the mode.
 */
export function createToolbarFitter(ports: ToolbarFitPorts): ToolbarFitter {
  let frame = 0;
  let requestId = 0;

  const getGap = () => {
    const toolbar = ports.getToolbar();
    if (!toolbar) return 0;
    const styles = window.getComputedStyle(toolbar);
    const rawGap = styles.columnGap || styles.gap || '0';
    const gap = Number.parseFloat(rawGap);
    return Number.isFinite(gap) ? gap : 0;
  };

  const isOverflowing = () => {
    const toolbar = ports.getToolbar();
    const left = ports.getLeftGroup();
    const right = ports.getRightGroup();
    if (!toolbar || !left || !right) return false;
    const leftWidth = left.scrollWidth;
    const rightWidth = right.getBoundingClientRect().width;
    return leftWidth + rightWidth + getGap() > toolbar.clientWidth + 1;
  };

  const fit = (modeIndex: number, activeRequestId: number) => {
    if (activeRequestId !== requestId) return;
    const nextMode = TOOLBAR_COMPACT_MODES[Math.min(modeIndex, TOOLBAR_COMPACT_MODES.length - 1)]!;
    ports.setMode(nextMode);
    queueMicrotask(() => {
      if (activeRequestId !== requestId) return;
      if (!isOverflowing() || modeIndex >= TOOLBAR_COMPACT_MODES.length - 1) return;
      fit(modeIndex + 1, activeRequestId);
    });
  };

  return {
    schedule() {
      if (frame) cancelAnimationFrame(frame);
      const activeRequestId = ++requestId;
      frame = requestAnimationFrame(() => {
        frame = 0;
        fit(0, activeRequestId);
      });
    },
    cancel() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      requestId++;
    },
  };
}
