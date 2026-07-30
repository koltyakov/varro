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
  let currentModeIndex = 0;
  let hasAppliedMode = false;
  let lastAvailableWidth: number | null = null;

  const getGap = () => {
    const toolbar = ports.getToolbar();
    if (!toolbar) return 0;
    const styles = window.getComputedStyle(toolbar);
    const rawGap = styles.columnGap || styles.gap || '0';
    const gap = Number.parseFloat(rawGap);
    return Number.isFinite(gap) ? gap : 0;
  };

  const isOverflowing = (availableWidth: number, gap: number) => {
    const left = ports.getLeftGroup();
    const right = ports.getRightGroup();
    if (!left || !right) return false;
    const leftWidth = left.scrollWidth;
    const rightWidth = right.getBoundingClientRect().width;
    return leftWidth + rightWidth + gap > availableWidth + 1;
  };

  const applyMode = (modeIndex: number, activeRequestId: number, next: () => void) => {
    if (activeRequestId !== requestId) return;
    const boundedIndex = Math.max(0, Math.min(modeIndex, TOOLBAR_COMPACT_MODES.length - 1));
    if (hasAppliedMode && boundedIndex === currentModeIndex) {
      next();
      return;
    }

    currentModeIndex = boundedIndex;
    hasAppliedMode = true;
    ports.setMode(TOOLBAR_COMPACT_MODES[currentModeIndex]!);
    queueMicrotask(() => {
      if (activeRequestId !== requestId) return;
      next();
    });
  };

  const fitTighter = (activeRequestId: number, availableWidth: number, gap: number) => {
    if (activeRequestId !== requestId || !isOverflowing(availableWidth, gap)) return;
    if (currentModeIndex >= TOOLBAR_COMPACT_MODES.length - 1) return;
    applyMode(currentModeIndex + 1, activeRequestId, () =>
      fitTighter(activeRequestId, availableWidth, gap)
    );
  };

  const fitLooser = (activeRequestId: number, availableWidth: number, gap: number) => {
    if (activeRequestId !== requestId || currentModeIndex <= 0) return;
    const lastFittingModeIndex = currentModeIndex;
    applyMode(currentModeIndex - 1, activeRequestId, () => {
      if (isOverflowing(availableWidth, gap)) {
        applyMode(lastFittingModeIndex, activeRequestId, () => {});
        return;
      }
      fitLooser(activeRequestId, availableWidth, gap);
    });
  };

  const fit = (activeRequestId: number) => {
    if (activeRequestId !== requestId) return;
    const toolbar = ports.getToolbar();
    if (!toolbar) {
      applyMode(currentModeIndex, activeRequestId, () => {});
      return;
    }
    const availableWidth = toolbar.clientWidth;
    const widthShrank = lastAvailableWidth !== null && availableWidth < lastAvailableWidth;
    lastAvailableWidth = availableWidth;
    const gap = getGap();

    applyMode(currentModeIndex, activeRequestId, () => {
      if (isOverflowing(availableWidth, gap)) {
        fitTighter(activeRequestId, availableWidth, gap);
        return;
      }
      if (!widthShrank) fitLooser(activeRequestId, availableWidth, gap);
    });
  };

  return {
    schedule() {
      if (frame) cancelAnimationFrame(frame);
      const activeRequestId = ++requestId;
      frame = requestAnimationFrame(() => {
        frame = 0;
        fit(activeRequestId);
      });
    },
    cancel() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      requestId++;
    },
  };
}
