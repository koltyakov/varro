import { flush as flushSolid, untrack } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { render } from '@solidjs/web';

import {
  replaceMessages,
  requestMessageListScrollToBottom,
  setMessagesIncremental,
  setShowFileDiffs,
  setShowThinkingPreference,
  setState,
  startLoading,
  state,
  stopLoading,
  upsertPart,
} from '../lib/state';
import { MessageList } from './MessageList';
import { setSessionHistoryCursor } from '../lib/message-window';
import { setExpandedDiffOverlay } from '../lib/diff-overlay-state';
import { prepareForComposerCollapse, trackInlineDiffLoad } from '../lib/message-list-layout';
import { onBeforeShowThinkingPreferenceChange } from '../lib/state-ui-preferences';
import {
  assistantMessage,
  hasAssistantModelChangeBetween,
  installMessageListTestEnvironment,
  installQueuedAnimationFrameMocks,
  measureTranscriptRows,
  settleBottomFollow,
  reasoningPart,
  testDiffOverlayOwner,
  textPart,
  toolPart,
  userMessage,
  setStateRecord,
  flushFrame,
  installTrackedResizeObservers,
  captureResizeObserverCallbacks,
  notifyResizeObservers,
  mockElementRects,
  mockTrackRects,
  assistantRows,
  promptAndResponse,
  conversationTurns,
  defineLayoutMetrics,
  backScrollTop,
} from './MessageList.test-utils';
import { fixture } from '../test-fixtures';
import { navArrowDownIcon } from '../lib/ui-icons';
import { toCssUrl } from './UiIcon';
import { client } from '../lib/client';
import { resetMessageEditState, startEditingMessage } from '../lib/message-edit-state';
import { installOpenCodeRuntime } from '../hooks/runtime/useOpenCode.runtime';
import type { OpenCodeRuntime } from '../hooks/runtime/useOpenCode.runtime';
import type { MessageEntry } from '../types';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

installMessageListTestEnvironment({
  getContainer: () => container,
  setContainer: (element) => {
    container = element;
  },
  getCleanup: () => cleanup,
  setCleanup: (nextCleanup) => {
    cleanup = nextCleanup;
  },
});

/** Mounts MessageList into the test container and returns its scroll container. */
function mountList(): HTMLDivElement {
  cleanup = render(() => MessageList(), container!);
  flushSolid();
  // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
  return container?.querySelector('.interactive-list') as HTMLDivElement;
}

/**
 * Mounts 50 assistant rows in a 400 px viewport with tracked resize observers. Row geometry
 * follows the mutable `rowHeights` (100 px each) and the scroll position in `scrollTop`.
 */
function mountResizableAssistantRows(
  listMetrics: { clientWidth?: number; offsetWidth?: number } = {}
) {
  const animationFrames = installQueuedAnimationFrameMocks();
  flushSolid();
  const observers = installTrackedResizeObservers();

  const rowHeights = Array.from({ length: 50 }, () => 100);
  const rowTop = (index: number) =>
    rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
  let list: HTMLDivElement | null = null;
  const scrollTop = { value: 0 };
  mockElementRects((element) => {
    if (element === list || element.classList.contains('interactive-list')) {
      return new DOMRect(0, 0, 500, 400);
    }
    if (element.classList.contains('interactive-list-track')) {
      return new DOMRect(
        0,
        0,
        500,
        rowHeights.reduce((total, height) => total + height, 0)
      );
    }
    if (element.dataset.msgId?.startsWith('assistant-')) {
      const index = Number(element.dataset.msgId.replace('assistant-', ''));
      return new DOMRect(0, rowTop(index) - scrollTop.value, 500, rowHeights[index]);
    }
    return new DOMRect(0, 0, 500, 40);
  });

  setState(storePath('activeSessionId', 'session-1'));
  flushSolid();
  replaceMessages(assistantRows(50));
  flushSolid();

  list = mountList();
  defineLayoutMetrics(
    list,
    { clientHeight: 400, ...listMetrics },
    { scrollHeight: () => rowHeights.reduce((total, height) => total + height, 0) }
  );
  backScrollTop(list, scrollTop);
  return { animationFrames, observers, rowHeights, list, scrollTop };
}

/**
 * Mounts one prompt/response turn in a 400 px viewport whose track and scroll heights the
 * test drives through `layout` (both start at 1200 px). Resize callbacks are captured and
 * every scrollTop assignment is recorded; the initial bottom scroll is still pending.
 */
function mountFollowedTurn(listMetrics: { clientWidth?: number; offsetWidth?: number } = {}) {
  const animationFrames = installQueuedAnimationFrameMocks();
  flushSolid();
  const resizeCallbacks = captureResizeObserverCallbacks();
  const layout = { trackHeight: 1200, scrollHeight: 1200 };
  mockTrackRects(() => layout.trackHeight);

  setState(storePath('activeSessionId', 'session-1'));
  flushSolid();
  replaceMessages(promptAndResponse('Prompt 1', 'Initial response'));
  flushSolid();

  mountList();

  // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
  const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
  expect(list).toBeInstanceOf(HTMLDivElement);

  const scrollTop = { value: 0 };
  const assignedScrollTops: number[] = [];
  defineLayoutMetrics(
    list!,
    { clientHeight: 400, ...listMetrics },
    { scrollHeight: () => layout.scrollHeight }
  );
  backScrollTop(list!, scrollTop, (value) => assignedScrollTops.push(value));
  return { animationFrames, resizeCallbacks, layout, list, scrollTop, assignedScrollTops };
}

describe('MessageList auto-scroll', () => {
  it.each([
    { collapse: 0.125, reserve: 0, reducedMotion: false },
    { collapse: 0.875, reserve: 1, reducedMotion: false },
    { collapse: 2.25, reserve: 2, reducedMotion: false },
    { collapse: 2.25, reserve: 2, reducedMotion: true },
  ])(
    'reserves only the rounded scrollport loss for a $collapse px composer collapse, reduced motion: $reducedMotion',
    async ({ collapse, reserve, reducedMotion }) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      if (reducedMotion) {
        const originalMatchMedia = globalThis.matchMedia;
        globalThis.matchMedia = () =>
          fixture<MediaQueryList>({
            matches: true,
            addEventListener() {},
            removeEventListener() {},
          });
        onTestFinished(() => {
          if (originalMatchMedia) globalThis.matchMedia = originalMatchMedia;
          else Reflect.deleteProperty(globalThis, 'matchMedia');
        });
      }
      let viewportHeight = 400.75;
      let contentHeight = 1200;
      const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
      class TestResizeObserver {
        readonly targets: Element[] = [];
        constructor(callback: ResizeObserverCallback) {
          observers.push({ callback, targets: this.targets });
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        unobserve() {}
        disconnect() {}
      }
      // SAFETY: This observer implements the methods used by MessageList.
      globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
      const reserveHeight = () =>
        Number.parseFloat(
          container?.querySelector<HTMLElement>('.append-scroll-bottom-reserve')?.style.height ??
            '0'
        );
      mockElementRects((element) => {
        return new DOMRect(
          0,
          0,
          500,
          element.classList.contains('interactive-list-track')
            ? contentHeight + reserveHeight()
            : viewportHeight
        );
      });
      setState(storePath('activeSessionId', 'session-1'));
      replaceMessages(promptAndResponse('Prompt', 'Response'));
      flushSolid();
      const list = mountList();
      const track = list.querySelector<HTMLElement>('.interactive-list-track')!;
      Object.defineProperty(list, 'clientHeight', {
        configurable: true,
        get: () => Math.round(viewportHeight),
      });
      Object.defineProperty(list, 'scrollHeight', {
        configurable: true,
        get: () => contentHeight + reserveHeight(),
      });
      let scrollTop = 0;
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        get: () => Math.min(scrollTop, Math.max(0, list.scrollHeight - list.clientHeight)),
        set: (next: number) => {
          scrollTop = Math.max(0, next);
        },
      });
      const observer = observers.find((candidate) => candidate.targets.includes(list))!;
      const notifyResize = (targets: Element[]) =>
        observer.callback(
          targets.map((target) => fixture<ResizeObserverEntry>({ target })),
          fixture<ResizeObserver>({})
        );
      for (let frame = 0; frame < 4; frame++) {
        await Promise.resolve();
        flushFrame(animationFrames);
      }
      expect(list.scrollTop).toBe(799);
      notifyResize([list]);
      animationFrames.flush();
      flushSolid();
      const composer = document.createElement('div');
      container!.append(composer);
      prepareForComposerCollapse(composer, collapse);
      flushSolid();
      viewportHeight += collapse;
      expect(reserveHeight()).toBe(reserve);
      expect(list.scrollTop).toBe(799);
      notifyResize([list, track]);
      for (let frame = 0; frame < 4; frame++) {
        animationFrames.flush();
        flushSolid();
      }
      expect(reserveHeight()).toBe(reserve);
      expect(list.scrollTop).toBe(799);

      // Genuine appended content consumes the protected range without retaining a
      // rounded extra pixel from the composer's last fractional slice.
      contentHeight += 100;
      notifyResize([track]);
      flushSolid();
      await Promise.resolve();
      flushSolid();
      // Even immediate reduced-motion following must leave the observed track's reserve
      // unchanged during resize delivery and its microtasks, until the queued frame runs.
      expect(reserveHeight()).toBe(reserve);
      const startedAt = performance.now();
      for (let frame = 1; frame <= 120; frame++) {
        animationFrames.flush(startedAt + frame * 16);
        flushSolid();
      }
      expect(reserveHeight()).toBe(0);
      expect(list.scrollTop).toBe(contentHeight - list.clientHeight);
      animationFrames.restore();
    }
  );

  it.each(['touchend', 'touchcancel'])(
    'yields to a native touch pan through pointer cancellation and %s',
    async (endEvent) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      let height = 1200;
      mockTrackRects(() => height);
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(promptAndResponse('Prompt', 'Response'));
      flushSolid();
      const list = mountList();
      defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: () => height });
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
      }
      expect(list.scrollTop).toBe(800);
      const pointer = (type: string) => {
        const event = new MouseEvent(type, { bubbles: true, button: 0 });
        Object.defineProperty(event, 'pointerType', { value: 'touch' });
        list.dispatchEvent(event);
      };
      const touch = (type: string, y?: number, target: HTMLElement = list) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', {
          value: y === undefined ? [] : [{ identifier: 1, clientX: 100, clientY: y }],
        });
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      };
      pointer('pointerdown');
      touch('touchstart', 100);
      pointer('pointercancel');
      expect(list.hasAttribute('data-pointer-scroll-owned')).toBe(true);
      // The first movement can arrive long after pointerdown and its input-intent timeout.
      vi.advanceTimersByTime(2000);
      flushSolid();
      touch('touchmove', 104);
      list.scrollTop = 796;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      startLoading();
      flushSolid();
      height += 200;
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(list.scrollTop).toBe(796);
      touch(endEvent);
      expect(list.hasAttribute('data-pointer-scroll-owned')).toBe(false);
      expect(list.style.overflowAnchor).toBe('');
      // Native momentum and subsequent streaming must not reattach the reader.
      list.scrollTop = 500;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      height += 200;
      for (let frame = 0; frame < 8; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
        expect(list.scrollTop).toBe(500);
      }
      requestMessageListScrollToBottom();
      await Promise.resolve();
      flushSolid();
      settleBottomFollow(animationFrames, list);
      flushSolid();
      expect(list.scrollTop).toBe(height - 400);
      animationFrames.restore();
      flushSolid();
    }
  );

  it.each([
    { working: true, detached: false },
    { working: false, detached: false },
    { working: true, detached: true },
    { working: false, detached: true },
  ])(
    'catches up instantly after visibility restoration with working=$working, detached=$detached',
    async ({ working, detached }) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      let hidden = false;
      vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
      let height = 1200;
      mockTrackRects(() => height);
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(promptAndResponse('Prompt', 'Response'));
      flushSolid();
      const list = mountList();
      defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: () => height });
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
      }
      expect(list.scrollTop).toBe(800);
      if (detached) {
        list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        flushSolid();
        list.scrollTop = 200;
        list.dispatchEvent(new Event('scroll'));
        flushSolid();
      }
      flushSolid();

      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      flushSolid();
      startLoading();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      height += 2400;
      if (!working) stopLoading();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      flushSolid();
      expect(list.scrollTop).toBe(detached ? 200 : height - 400);
      // Late row measurement on restoration must also settle before paint.
      height += 300;
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
        expect(list.scrollTop).toBe(detached ? 200 : height - 400);
      }

      if (!detached) {
        stopLoading();
        flushSolid();
        await Promise.resolve();
        flushSolid();
        for (let frame = 0; frame < 4; frame += 1) animationFrames.flush();
        const previousTop = list.scrollTop;
        height += 200;
        startLoading();
        flushSolid();
        await Promise.resolve();
        flushFrame(animationFrames);
        expect(list.scrollTop).toBeGreaterThanOrEqual(previousTop);
        expect(list.scrollTop).toBeLessThan(height - 400);
        settleBottomFollow(animationFrames, list);
        flushSolid();
        expect(list.scrollTop).toBe(height - 400);
      }
      flushSolid();
      animationFrames.restore();
      flushSolid();
    }
  );

  it.each([true, false])(
    'catches up instantly after suspended frames without a visibility event with working=%s',
    async (working) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      let height = 1200;
      mockTrackRects(() => height);
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(promptAndResponse('Prompt', 'Response'));
      flushSolid();
      const list = mountList();
      defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: () => height });
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
      }
      expect(list.scrollTop).toBe(800);
      startLoading();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      height += 2400;
      if (!working) stopLoading();
      flushSolid();
      await Promise.resolve();
      flushSolid();

      const restoredAt = performance.now() + 2000;
      animationFrames.flush(restoredAt);
      flushSolid();
      expect(list.scrollTop).toBe(height - 400);
      height += 300;
      animationFrames.flush(restoredAt + 16);
      flushSolid();
      expect(list.scrollTop).toBe(height - 400);
      animationFrames.restore();
      flushSolid();
    }
  );

  it.each([
    { growth: 24, detached: false, trackChanged: false },
    { growth: 120, detached: false, trackChanged: true },
    { growth: 120, detached: true, trackChanged: false },
  ])(
    'follows composer growth immediately with growth=$growth, detached=$detached, trackChanged=$trackChanged',
    async ({ growth, detached, trackChanged }) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
      class TestResizeObserver {
        readonly targets: Element[] = [];
        constructor(callback: ResizeObserverCallback) {
          observers.push({ callback, targets: this.targets });
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        unobserve() {}
        disconnect() {}
      }
      // SAFETY: The test observer implements the browser methods used by MessageList.
      globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
      let height = 1200;
      let viewportHeight = 400;
      mockElementRects((element) => {
        return new DOMRect(
          0,
          0,
          500,
          element.classList.contains('interactive-list-track') ? height : viewportHeight
        );
      });
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(promptAndResponse('Prompt', 'Response'));
      flushSolid();
      const list = mountList();
      const track = list.querySelector<HTMLElement>('.interactive-list-track')!;
      Object.defineProperty(list, 'clientHeight', {
        configurable: true,
        get: () => viewportHeight,
      });
      Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height });
      const observer = observers.find((candidate) => candidate.targets.includes(list))!;
      const notifyResize = (targets: Element[]) =>
        observer.callback(
          targets.map((target) => fixture<ResizeObserverEntry>({ target })),
          fixture<ResizeObserver>({})
        );
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
      }
      notifyResize([list]);
      animationFrames.flush();
      flushSolid();
      expect(list.scrollTop).toBe(800);
      if (detached) {
        list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        flushSolid();
        list.scrollTop = 200;
        list.dispatchEvent(new Event('scroll'));
        flushSolid();
      }
      flushSolid();

      viewportHeight -= growth;
      notifyResize(trackChanged ? [list, track] : [list]);
      // The resize correction must finish before the next painted frame, without easing.
      expect(list.scrollTop).toBe(detached ? 200 : height - viewportHeight);
      for (let frame = 0; frame < 4; frame += 1) animationFrames.flush();
      expect(list.scrollTop).toBe(detached ? 200 : height - viewportHeight);

      if (!detached) {
        const previousTop = list.scrollTop;
        height += 200;
        notifyResize([track]);
        animationFrames.flush();
        flushSolid();
        expect(list.scrollTop).toBeGreaterThanOrEqual(previousTop);
        expect(list.scrollTop).toBeLessThan(height - viewportHeight);
        settleBottomFollow(animationFrames, list);
        flushSolid();
        expect(list.scrollTop).toBe(height - viewportHeight);
      }
      flushSolid();
      animationFrames.restore();
      flushSolid();
    }
  );

  it.each([
    { enabled: true, detached: false, interrupted: false },
    { enabled: false, detached: false, interrupted: false },
    { enabled: true, detached: true, interrupted: false },
    { enabled: false, detached: true, interrupted: false },
    { enabled: true, detached: false, interrupted: true },
    { enabled: false, detached: false, interrupted: true },
  ])(
    'reconciles diff view immediately with enabled=$enabled, detached=$detached, interrupted=$interrupted',
    async ({ enabled, detached, interrupted }) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      let height = enabled ? 1200 : 2400;
      mockTrackRects(() => height);
      setShowFileDiffs(!enabled);
      flushSolid();
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(promptAndResponse('Prompt', 'Response'));
      flushSolid();
      const list = mountList();
      defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: () => height });
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
      }
      expect(list.scrollTop).toBe(height - 400);
      if (detached) {
        list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        flushSolid();
        list.scrollTop = 200;
        list.dispatchEvent(new Event('scroll'));
        flushSolid();
      }
      flushSolid();

      height = enabled ? 2400 : 1200;
      setShowFileDiffs(enabled);
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(list.scrollTop).toBe(detached ? 200 : height - 400);
      expect(container?.querySelector('.append-scroll-bottom-reserve')).toBeNull();
      if (interrupted) {
        list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        flushSolid();
        list.scrollTop = 200;
        list.dispatchEvent(new Event('scroll'));
        flushSolid();
      }
      flushSolid();
      for (let frame = 0; frame < 4; frame += 1) animationFrames.flush();
      if (interrupted) expect(list.scrollTop).toBe(200);

      const previousTop = list.scrollTop;
      height += 200;
      startLoading();
      flushSolid();
      await Promise.resolve();
      flushFrame(animationFrames);
      if (detached || interrupted) {
        expect(list.scrollTop).toBe(previousTop);
      } else {
        expect(list.scrollTop).toBeGreaterThanOrEqual(previousTop);
        expect(list.scrollTop).toBeLessThan(height - 400);
        settleBottomFollow(animationFrames, list);
        flushSolid();
        expect(list.scrollTop).toBe(height - 400);
      }
      flushSolid();
      animationFrames.restore();
      flushSolid();
    }
  );

  it('yields diff-toggle settling to paint when range changes release loading previews', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const height = 1200;
    mockTrackRects(() => height);
    setShowFileDiffs(false);
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(promptAndResponse('Prompt', 'Response'));
    flushSolid();
    const list = mountList();
    let releaseDuringMeasurement = false;
    let released = 0;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => {
        if (releaseDuringMeasurement && released < 30) {
          released += 1;
          trackInlineDiffLoad('session-1', 'unmounted-preview')?.();
        }
        return height;
      },
    });
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    expect(list.scrollTop).toBe(800);
    releaseDuringMeasurement = true;
    setShowFileDiffs(true);
    flushSolid();
    for (let task = 0; task < 40; task += 1) await Promise.resolve();
    // Reentrant completion must leave work for the browser's next frame instead of
    // consuming every release in an uninterrupted microtask chain.
    expect(released).toBeGreaterThan(0);
    expect(released).toBeLessThan(30);
    releaseDuringMeasurement = false;
    for (let frame = 0; frame < 4; frame += 1) animationFrames.flush();
    expect(list.scrollTop).toBe(800);
    animationFrames.restore();
    flushSolid();
  });

  it('positions initial layout corrections immediately after the first stable frame', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let height = 1200;
    mockTrackRects(() => height);
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(promptAndResponse('Prompt', 'Response'));
    flushSolid();
    const list = mountList();
    defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: () => height });
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    expect(list.scrollTop).toBe(800);

    // ResizeObserver can deliver the hydrated row geometry after the first frame callback.
    height += 24;
    animationFrames.flush();
    flushSolid();
    expect(list.scrollTop).toBe(824);
    animationFrames.restore();
    flushSolid();
  });

  it.each([1200, 900_000])(
    'jumps to latest immediately at height %i and still eases subsequent growth',
    async (initialHeight) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      let height = initialHeight;
      mockTrackRects(() => height);
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(promptAndResponse('Prompt', 'Response'));
      flushSolid();
      const list = mountList();
      defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: () => height });
      await Promise.resolve();
      flushSolid();
      for (let frame = 0; frame < 20; frame += 1) animationFrames.flush();
      expect(list.scrollTop).toBe(height - 400);

      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      flushSolid();
      list.scrollTop = 200;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      requestMessageListScrollToBottom();
      await Promise.resolve();
      flushSolid();
      expect(list.scrollTop).toBe(height - 400);

      const previousBottom = list.scrollTop;
      height += 200;
      startLoading();
      flushSolid();
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(list.scrollTop).toBeGreaterThanOrEqual(previousBottom);
      expect(list.scrollTop).toBeLessThan(height - 400);
      settleBottomFollow(animationFrames, list);
      flushSolid();
      expect(list.scrollTop).toBe(height - 400);
      animationFrames.restore();
      flushSolid();
    }
  );

  it.each([2, 60])(
    'jumps before a batched send and eases only the new card with %i existing rows',
    async (messageCount) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      const rowHeight = messageCount === 2 ? 600 : 120;
      const initialHeight = messageCount * rowHeight;
      let height = initialHeight;
      let userRowsStartTop = initialHeight;
      let list: HTMLDivElement | null = null;
      mockElementRects((element) => {
        if (element.classList.contains('interactive-list-track'))
          return new DOMRect(0, 0, 500, height);
        if (element.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 400);
        const messageId = element.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        const rowTop = messageId?.startsWith('assistant-')
          ? Number(messageId.slice('assistant-'.length)) * rowHeight
          : userRowsStartTop + (messageId === 'user-next' ? 200 : 0);
        return new DOMRect(
          0,
          rowTop - (list?.scrollTop ?? 0),
          500,
          messageId?.startsWith('user-') ? 200 : rowHeight
        );
      });
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(
        Array.from({ length: messageCount }, (_, index) => ({
          info: assistantMessage(`assistant-${index}`),
          parts: [textPart(`text-${index}`, `Response ${index}`)],
        }))
      );
      flushSolid();
      list = mountList();
      defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: () => height });
      for (let frame = 0; frame < 20; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
      }
      if (messageCount >= 50) await measureTranscriptRows(list, animationFrames);
      flushSolid();
      const previousBottom = initialHeight - 400;
      expect(list.scrollTop).toBe(previousBottom);

      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      flushSolid();
      list.scrollTop = 200;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      // Use the current bottom, including output received while the reader was detached.
      height += rowHeight;
      userRowsStartTop = height;
      setMessagesIncremental([
        ...state.messages,
        {
          info: assistantMessage(`assistant-${messageCount}`),
          parts: [textPart('background-text', 'Output received while reading history')],
        },
      ]);
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(list.scrollTop).toBe(200);
      const existingBottom = height - 400;
      (() => {
        startLoading();
        requestMessageListScrollToBottom('user-new');
        expect(list.scrollTop).toBe(existingBottom);
        height += 200;
        setMessagesIncremental([
          ...state.messages,
          { info: userMessage('user-new'), parts: [textPart('new-text', 'Follow-up')] },
        ]);
      })();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(list.scrollTop).toBeGreaterThanOrEqual(existingBottom);
      expect(list.scrollTop).toBeLessThan(height - 400);
      settleBottomFollow(animationFrames, list);
      flushSolid();
      expect(list.scrollTop).toBe(height - 400);

      // The same reveal still yields to a new gesture after the immediate jump.
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      flushSolid();
      list.scrollTop = 200;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      (() => {
        requestMessageListScrollToBottom('user-next');
        expect(list.scrollTop).toBe(height - 400);
        height += 200;
        setMessagesIncremental([
          ...state.messages,
          { info: userMessage('user-next'), parts: [textPart('next-text', 'Another follow-up')] },
        ]);
      })();
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -96, bubbles: true }));
      flushSolid();
      const destination = list.scrollTop - 96;
      list.scrollTop = destination;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
        expect(list.scrollTop).toBe(destination);
      }
      animationFrames.restore();
      flushSolid();
    }
  );

  it.each(['never', 'before steering', 'before admission'])(
    'preserves follow through steering admission with detachment=%s',
    async (detach) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(promptAndResponse('Prompt', 'Response'));
      flushSolid();
      startLoading();
      flushSolid();
      const list = mountList();
      let height = 1200;
      defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: () => height });
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(list.scrollTop).toBe(800);

      const scrollAway = () => {
        list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        list.scrollTop = 400;
        list.dispatchEvent(new Event('scroll'));
      };
      if (detach === 'before steering') scrollAway();
      (() => {
        setMessagesIncremental([
          ...state.messages,
          {
            info: { ...userMessage('steer-1'), delivery: 'steer', pendingDelivery: 'steer' },
            parts: [textPart('steer-text', 'Change direction')],
          },
        ]);
      })();
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(container!.querySelector('[data-msg-id="steer-1"]')).toBeNull();
      expect(list.scrollTop).toBe(detach === 'before steering' ? 400 : 800);
      if (detach === 'before admission') scrollAway();

      height = 1400;
      setState(
        storePath('messages', 2, 'info', (info) => ({ ...info, pendingDelivery: undefined }))
      );
      flushSolid();
      await Promise.resolve();
      flushSolid();
      settleBottomFollow(animationFrames, list);
      flushSolid();
      expect(container!.querySelector('[data-msg-id="steer-1"]')).not.toBeNull();
      expect(list.scrollTop).toBe(detach === 'never' ? 1000 : 400);

      // Admission must not establish a new scroll request that overrides later reading.
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      flushSolid();
      const detachedTop = list.scrollTop - 200;
      list.scrollTop = detachedTop;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      height = 1600;
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
        expect(list.scrollTop).toBe(detachedTop);
      }
      animationFrames.restore();
      flushSolid();
    }
  );

  it('restores bottom follow on send after scrolling up and follows subsequent growth', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(promptAndResponse('Prompt', 'Response'));
    flushSolid();
    const list = mountList();
    let height = 1200;
    defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: () => height });
    await Promise.resolve();
    flushFrame(animationFrames);
    expect(list.scrollTop).toBe(800);

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    flushSolid();
    list.scrollTop = 400;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    expect(list.scrollTop).toBe(400);

    requestMessageListScrollToBottom('user-2');
    await Promise.resolve();
    flushFrame(animationFrames);
    expect(list.scrollTop).toBe(800);

    height = 1400;
    startLoading();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    settleBottomFollow(animationFrames, list);
    flushSolid();
    expect(list.scrollTop).toBe(1000);
    animationFrames.restore();
    flushSolid();
  });

  for (const cause of ['queued request', 'reattach', 'diff blur']) {
    it(`cancels ${cause} when an upward wheel takes ownership`, async () => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(promptAndResponse('Prompt', 'Response'));
      flushSolid();
      const list = mountList();
      let top = 0;
      defineLayoutMetrics(list, { clientHeight: 400, scrollHeight: 1200 });
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
        },
      });
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(top).toBe(800);

      let diff: HTMLDivElement | undefined;
      if (cause === 'queued request') requestMessageListScrollToBottom();
      else if (cause === 'reattach') {
        list.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
        flushSolid();
        top = 600;
        list.dispatchEvent(new Event('scroll'));
        flushSolid();
        list.dispatchEvent(new WheelEvent('wheel', { deltaY: 195, bubbles: true }));
        flushSolid();
        top = 795;
        list.dispatchEvent(new Event('scroll'));
        flushSolid();
      } else {
        diff = document.createElement('div');
        diff.className = 'diff-view-lines';
        diff.tabIndex = 0;
        list.append(diff);
        diff.focus();
        flushSolid();
      }
      flushSolid();
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -96, bubbles: true }));
      flushSolid();
      diff?.blur();
      flushSolid();
      const destination = top - 96;
      top = destination;
      // Diff blur can run before Chromium reports the wheel's resulting scroll event.
      if (cause === 'diff blur') await Promise.resolve();
      flushSolid();
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
        expect(top).toBe(destination);
      }
      animationFrames.restore();
      flushSolid();
    });
  }

  it('cancels a pending first-turn alignment frame on unmount', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    mountList();

    replaceMessages([
      { info: userMessage('user-first'), parts: [textPart('text-first', 'First prompt')] },
    ]);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    requestMessageListScrollToBottom('user-first');
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const requestFrame = vi.mocked(globalThis.requestAnimationFrame);
    const alignmentCallIndex = requestFrame.mock.calls.findLastIndex(([callback]) =>
      callback.toString().includes('pendingNewTurnMessageId')
    );
    expect(alignmentCallIndex).toBeGreaterThanOrEqual(0);
    const alignmentRafId = requestFrame.mock.results[alignmentCallIndex]?.value;

    cleanup!();
    flushSolid();
    cleanup = undefined;
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalledWith(alignmentRafId);
    animationFrames.restore();
    flushSolid();
  });

  it('updates the virtualized range when initial bottom scroll is programmatic', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(assistantRows(60));
    flushSolid();

    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    const scrollTop = { value: 0 };
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => 7200 });
    backScrollTop(list!, scrollTop);

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    expect(scrollTop.value).toBe(6800);
    const firstRenderedMessageId =
      container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId;
    expect(firstRenderedMessageId).not.toBe('assistant-0');

    animationFrames.restore();
    flushSolid();
  });

  it('virtualizes after mount-time measurement when resize observers do not emit', async () => {
    // Principle: exact-height virtualization must still activate in test/no-layout environments.
    // If this regresses, the list falls back to rendering every row and future refactors may hide it
    // behind fake performance improvements.
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(assistantRows(60));
    flushSolid();

    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    const scrollTop = { value: 0 };
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => 7200 });
    backScrollTop(list!, scrollTop);

    mockElementRects((element) => {
      if (element.classList.contains('interactive-item-container')) {
        return new DOMRect(0, 0, 500, 120);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, 7200);
      }
      return new DOMRect(0, 0, 500, 400);
    });

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(40);
    expect(container?.querySelector('.virtual-spacer-top')).toBeTruthy();

    animationFrames.restore();
    flushSolid();
  });

  it('does not rescan an unmeasured transcript on every busy follow frame', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let rowMeasurementCount = 0;

    mockElementRects((element) => {
      if (element.classList.contains('interactive-item-container')) {
        rowMeasurementCount += 1;
        return new DOMRect(0, 0, 500, element.dataset.msgId === 'assistant-0' ? 0 : 120);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, 7200);
      }
      return new DOMRect(0, 0, 500, 400);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setStateRecord('sessionStatus', { 'session-1': { type: 'busy' } });
    flushSolid();
    replaceMessages(assistantRows(60));
    flushSolid();

    mountList();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    const measurementsAfterBootstrap = rowMeasurementCount;

    animationFrames.flush();
    flushFrame(animationFrames);

    expect(rowMeasurementCount).toBe(measurementsAfterBootstrap);
    animationFrames.restore();
    flushSolid();
  });

  it('stops the follow loop while a busy tool has no geometry changes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();

    mockTrackRects(() => 800);

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setStateRecord('sessionStatus', { 'session-1': { type: 'busy' } });
    flushSolid();
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [toolPart('tool-1', 'assistant-1')],
      },
    ]);
    flushSolid();

    mountList();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    for (let frame = 0; frame < 4; frame += 1) animationFrames.flush();

    const requestFrame = vi.mocked(globalThis.requestAnimationFrame);
    const settledRequestCount = requestFrame.mock.calls.length;
    animationFrames.flush();
    flushSolid();

    expect(requestFrame).toHaveBeenCalledTimes(settledRequestCount);
    animationFrames.restore();
    flushSolid();
  });

  it.each(['text', 'part', 'track', 'container'] as const)(
    'settles a paused stream and resumes follow after %s changes without overriding detachment',
    async (trigger) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      const observers: Array<{ callback: ResizeObserverCallback; observer: ResizeObserver }> = [];
      globalThis.ResizeObserver = class implements ResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          observers.push({ callback, observer: this });
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      let trackHeight = 1200;
      let viewportHeight = 400;
      mockElementRects((element) => {
        return new DOMRect(
          0,
          0,
          500,
          element.classList.contains('interactive-list-track') ? trackHeight : viewportHeight
        );
      });
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      setStateRecord('sessionStatus', { 'session-1': { type: 'busy' } });
      flushSolid();
      replaceMessages([
        {
          info: assistantMessage('assistant-1'),
          parts: [{ ...textPart('text-1', 'Paused'), messageID: 'assistant-1' }],
        },
      ]);
      flushSolid();
      setState(storePath('streamingPartId', 'text-1'));
      flushSolid();
      setState(storePath('streamingText', trigger === 'part' ? '' : 'Paused'));
      flushSolid();
      const list = mountList();
      const track = container!.querySelector<HTMLDivElement>('.interactive-list-track')!;
      Object.defineProperty(list, 'clientHeight', { get: () => viewportHeight });
      Object.defineProperty(list, 'scrollHeight', { get: () => trackHeight });
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      for (let frame = 0; frame < 8; frame += 1) animationFrames.flush();
      expect(list.scrollTop).toBe(800);
      const requestFrame = vi.mocked(globalThis.requestAnimationFrame);
      const pausedRequestCount = requestFrame.mock.calls.length;
      animationFrames.flush();
      flushSolid();
      expect(requestFrame).toHaveBeenCalledTimes(pausedRequestCount);

      const resume = async () => {
        if (trigger === 'text' || trigger === 'part') {
          trackHeight += 200;
          setState(storePath('streamingText', `${state.streamingText} resumed`));
        } else {
          if (trigger === 'track') trackHeight += 200;
          else viewportHeight -= 100;
          for (const { callback, observer } of observers) {
            callback(
              [fixture<ResizeObserverEntry>({ target: trigger === 'track' ? track : list })],
              observer
            );
          }
        }
        await Promise.resolve();
        animationFrames.flush();
      };
      await resume();
      flushSolid();
      settleBottomFollow(animationFrames, list);
      flushSolid();
      expect(list.scrollTop).toBe(trackHeight - viewportHeight);
      // Deferred layout must still be followed before the next resize notification.
      trackHeight += 100;
      animationFrames.flush();
      flushSolid();
      settleBottomFollow(animationFrames, list);
      flushSolid();
      expect(list.scrollTop).toBe(trackHeight - viewportHeight);
      for (let frame = 0; frame < 8; frame += 1) animationFrames.flush();
      const resumedRequestCount = requestFrame.mock.calls.length;
      animationFrames.flush();
      flushSolid();
      expect(requestFrame).toHaveBeenCalledTimes(resumedRequestCount);

      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      flushSolid();
      list.scrollTop -= 200;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      const detachedScrollTop = list.scrollTop;
      await resume();
      flushSolid();
      for (let frame = 0; frame < 8; frame += 1) animationFrames.flush();
      expect(list.scrollTop).toBe(detachedScrollTop);
      animationFrames.restore();
      flushSolid();
    }
  );

  it.each(['insertion', 'removal'] as const)(
    'preserves a detached visible row across a structural %s during active slow scrolling',
    async (mutation) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      const baseMessages = assistantRows(50);
      const heightById = new Map(
        baseMessages.map((message, index) => [message.info.id, 70 + (index % 4) * 25])
      );
      let layoutIds = baseMessages.map((message) => message.info.id);
      let list: HTMLDivElement | null = null;
      const scrollTop = { value: 0 };
      const rowTop = (messageId: string) => {
        const index = layoutIds.indexOf(messageId);
        return layoutIds
          .slice(0, Math.max(0, index))
          .reduce((total, id) => total + (heightById.get(id) ?? 0), 0);
      };
      const totalHeight = () =>
        layoutIds.reduce((total, id) => total + (heightById.get(id) ?? 0), 0);

      mockElementRects((element) => {
        if (element === list || element.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (element.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, totalHeight());
        }
        const messageId = element.dataset.msgId;
        if (messageId && heightById.has(messageId)) {
          return new DOMRect(
            0,
            rowTop(messageId) - scrollTop.value,
            500,
            heightById.get(messageId)
          );
        }
        return new DOMRect(0, 0, 500, 40);
      });

      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(baseMessages);
      flushSolid();
      list = mountList();
      defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: totalHeight });
      backScrollTop(list, scrollTop);

      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
      }
      const anchorId = 'assistant-25';
      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
      flushSolid();
      scrollTop.value = rowTop(anchorId) + 20;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      await Promise.resolve();
      flushFrame(animationFrames);
      await Promise.resolve();
      flushSolid();

      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      const anchorBefore = container?.querySelector(
        `[data-msg-id="${anchorId}"]`
      ) as HTMLDivElement;
      expect(anchorBefore).toBeInstanceOf(HTMLDivElement);
      const anchorTopBefore = anchorBefore.getBoundingClientRect().top;

      const nextMessages = state.messages.map((message) => ({
        info: message.info,
        parts: message.parts,
      }));
      if (mutation === 'removal') {
        nextMessages.splice(4, 1);
      } else {
        const insertedId = 'assistant-inserted';
        heightById.set(insertedId, 135);
        flushSolid();
        nextMessages.splice(4, 0, {
          info: assistantMessage(insertedId),
          parts: [
            {
              ...textPart('text-inserted', 'Inserted response'),
              messageID: insertedId,
            },
          ],
        });
      }
      flushSolid();
      replaceMessages(nextMessages);
      flushSolid();
      layoutIds = nextMessages.map((message) => message.info.id);
      await Promise.resolve();
      flushFrame(animationFrames);
      await Promise.resolve();
      flushSolid();

      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      const anchorAfter = container?.querySelector(`[data-msg-id="${anchorId}"]`) as HTMLDivElement;
      expect(anchorAfter).toBeInstanceOf(HTMLDivElement);
      expect(
        Math.abs(anchorAfter.getBoundingClientRect().top - anchorTopBefore)
      ).toBeLessThanOrEqual(0.5);
      animationFrames.restore();
      flushSolid();
    }
  );

  it('preserves the visible row for one mixed resize batch above, at, and below it', async () => {
    const { animationFrames, observers, rowHeights, list, scrollTop } =
      mountResizableAssistantRows();

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 2000;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchor = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const changedRows = [8, 14, 20, 25].map(
      (index) => container?.querySelector(`[data-msg-id="assistant-${index}"]`) as HTMLDivElement
    );
    expect(anchor).toBeInstanceOf(HTMLDivElement);
    expect(changedRows.every((row) => row instanceof HTMLDivElement)).toBe(true);
    const rowObserver = observers.find((observer) => observer.targets.has(anchor));
    expect(rowObserver).toBeDefined();
    const anchorTopBefore = anchor.getBoundingClientRect().top;

    rowHeights[8] = 130;
    rowHeights[14] = 80;
    rowHeights[20] = 180;
    rowHeights[25] = 160;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      changedRows.map((row, index) =>
        fixture<ResizeObserverEntry>({
          target: row,
          borderBoxSize: [{ blockSize: rowHeights[[8, 14, 20, 25][index]!]!, inlineSize: 500 }],
        })
      ),
      fixture<ResizeObserver>(rowObserver)
    );

    expect(scrollTop.value).toBe(2010);
    expect(anchor.getBoundingClientRect().top).toBe(anchorTopBefore);

    const belowRow = changedRows[3]!;
    rowHeights[25] = 200;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: belowRow,
          borderBoxSize: [{ blockSize: 200, inlineSize: 500 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );
    expect(scrollTop.value).toBe(2010);
    expect(anchor.getBoundingClientRect().top).toBe(anchorTopBefore);
    animationFrames.restore();
    flushSolid();
  });

  it('ignores delayed resize entries from unmounted rows', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const observers = installTrackedResizeObservers();

    const rowHeight = 100;
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };
    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, 50 * rowHeight);
      }
      if (element.dataset.msgId?.startsWith('assistant-')) {
        const index = Number(element.dataset.msgId.replace('assistant-', ''));
        return new DOMRect(0, index * rowHeight - scrollTop.value, 500, rowHeight);
      }
      return new DOMRect(0, 0, 500, 40);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(assistantRows(50));
    flushSolid();
    list = mountList();
    defineLayoutMetrics(list, { clientHeight: 400, scrollHeight: 50 * rowHeight });
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const staleRow = container?.querySelector('[data-msg-id="assistant-49"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(staleRow));
    expect(staleRow).toBeInstanceOf(HTMLDivElement);
    expect(rowObserver).toBeDefined();

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 0;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('[data-msg-id="assistant-49"]')).toBeNull();

    const bottomSpacer = () =>
      Number.parseFloat(
        container?.querySelector<HTMLElement>('.virtual-spacer-bottom')?.style.height || '0'
      );
    const bottomPadBefore = bottomSpacer();
    document.body.append(staleRow);
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: staleRow,
          borderBoxSize: [{ blockSize: 500, inlineSize: 500 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );
    await Promise.resolve();
    flushSolid();

    expect(bottomSpacer()).toBe(bottomPadBefore);
    staleRow.remove();
    flushSolid();
    animationFrames.restore();
    flushSolid();
  });

  it('yields pending width measurement anchoring to direct user scroll input', async () => {
    const { animationFrames, observers, rowHeights, list, scrollTop } = mountResizableAssistantRows(
      { clientWidth: 500, offsetWidth: 500 }
    );

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 2000;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();
    vi.advanceTimersByTime(600);
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchor = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(anchor));
    expect(anchor).toBeInstanceOf(HTMLDivElement);
    expect(rowObserver).toBeDefined();
    const publishWidthMeasurement = (height: number, inlineSize: number) => {
      rowHeights[20] = height;
      // SAFETY: The fixture provides the unknown fields read by this statement.
      rowObserver!.callback(
        [
          fixture<ResizeObserverEntry>({
            target: anchor,
            borderBoxSize: [{ blockSize: height, inlineSize }],
          }),
        ],
        fixture<ResizeObserver>(rowObserver)
      );
    };

    publishWidthMeasurement(120, 420);
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
    flushSolid();
    scrollTop.value += 120;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    const wheelOwnedTop = scrollTop.value;
    await Promise.resolve();
    flushSolid();
    expect(scrollTop.value).toBe(wheelOwnedTop);

    vi.advanceTimersByTime(600);
    flushSolid();
    publishWidthMeasurement(140, 380);
    list.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }));
    flushSolid();
    scrollTop.value += 200;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    const keyboardOwnedTop = scrollTop.value;
    await Promise.resolve();
    flushSolid();
    expect(scrollTop.value).toBe(keyboardOwnedTop);

    vi.advanceTimersByTime(600);
    flushSolid();
    publishWidthMeasurement(160, 340);
    list.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 495 }));
    flushSolid();
    expect(list.style.overflowAnchor).toBe('none');
    expect(list.hasAttribute('data-pointer-scroll-owned')).toBe(true);
    scrollTop.value += 100;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    flushSolid();
    expect(list.style.overflowAnchor).toBe('');
    expect(list.hasAttribute('data-pointer-scroll-owned')).toBe(false);
    const pointerOwnedTop = scrollTop.value;
    await Promise.resolve();
    flushSolid();
    expect(scrollTop.value).toBe(pointerOwnedTop);
    animationFrames.restore();
    flushSolid();
  });

  it('anchors width reflow to the visible row instead of a stale mounted row', async () => {
    const { animationFrames, observers, rowHeights, list, scrollTop } = mountResizableAssistantRows(
      { clientWidth: 500, offsetWidth: 500 }
    );

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }

    // Remember row 19 while it intersects the viewport, then let geometry move before the
    // ResizeObserver width batch. It remains mounted in overscan but row 20 is now first visible.
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 1975;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();
    scrollTop.value = 2010;

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const staleRow = container?.querySelector('[data-msg-id="assistant-19"]') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const visibleRow = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    const rowObserver = observers.find(
      (observer) => observer.targets.has(staleRow) && observer.targets.has(visibleRow)
    );
    expect(staleRow.getBoundingClientRect().bottom).toBe(-10);
    expect(visibleRow.getBoundingClientRect().top).toBe(-10);
    expect(rowObserver).toBeDefined();

    rowHeights[19] = 165;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: staleRow,
          borderBoxSize: [{ blockSize: 165, inlineSize: 360 }],
        }),
        fixture<ResizeObserverEntry>({
          target: visibleRow,
          borderBoxSize: [{ blockSize: 100, inlineSize: 360 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    expect(visibleRow.getBoundingClientRect().top).toBe(-10);
    animationFrames.restore();
    flushSolid();
  });

  it('preserves the first fully painted descendant when an earlier block is clipped', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let hostWidth = 500;
    vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => hostWidth);

    const rowHeight = 300;
    let markerOffset = 140;
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };
    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, hostWidth, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, hostWidth, 50 * rowHeight);
      }
      const row = element.dataset.msgId
        ? element
        : (element.closest<HTMLElement>('[data-msg-id]') ?? null);
      const messageId = row?.dataset.msgId;
      if (messageId?.startsWith('assistant-')) {
        const index = Number(messageId.replace('assistant-', ''));
        const rowTop = index * rowHeight - scrollTop.value;
        if (element.matches('.rendered-markdown p')) {
          const offset = element.textContent?.startsWith('Earlier block') ? 20 : markerOffset;
          return new DOMRect(0, rowTop + offset, hostWidth, 20);
        }
        return new DOMRect(0, rowTop, hostWidth, rowHeight);
      }
      return new DOMRect(0, 0, hostWidth, 40);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, `Earlier block ${index}\n\nResponse ${index}`),
              messageID: messageId,
            },
          ],
        };
      })
    );
    flushSolid();
    list = mountList();
    defineLayoutMetrics(
      list,
      { clientHeight: 400, scrollHeight: 50 * rowHeight },
      { clientWidth: () => hostWidth, offsetWidth: () => hostWidth }
    );
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }

    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 20 * rowHeight;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();
    list.dispatchEvent(new Event('scroll'));
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 0 }));
    flushSolid();

    scrollTop.value = 22 * rowHeight;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    const marker = container?.querySelector<HTMLElement>(
      '[data-msg-id="assistant-22"] .rendered-markdown p:last-child'
    );
    expect(marker?.getBoundingClientRect().top).toBe(140);

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 22 }));
    flushSolid();
    scrollTop.value += 22;
    expect(marker?.getBoundingClientRect().top).toBe(118);

    markerOffset = 162;
    hostWidth = 360;
    window.dispatchEvent(new Event('resize'));
    flushSolid();
    expect(marker?.getBoundingClientRect().top).toBe(118);
    animationFrames.flush();
    flushSolid();
    expect(marker?.getBoundingClientRect().top).toBe(118);
    animationFrames.restore();
    flushSolid();
  });

  it('restores a detached paragraph during the native zoom frame after an earlier frame sampler', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let hostWidth = 486;
    let pixelRatio = 1;
    let listTop = 37;
    let reflowOffset = 0;
    let scrollTopValue = 0;
    vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => hostWidth);
    vi.spyOn(window, 'devicePixelRatio', 'get').mockImplementation(() => pixelRatio);
    mockElementRects((element) => {
      if (element.classList.contains('interactive-list')) {
        return new DOMRect(0, listTop, hostWidth, 631);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, listTop - scrollTopValue, hostWidth, 15000);
      }
      const row = element.dataset.msgId ? element : element.closest<HTMLElement>('[data-msg-id]');
      const messageId = row?.dataset.msgId;
      if (messageId?.startsWith('assistant-')) {
        const index = Number(messageId.replace('assistant-', ''));
        const top = listTop + index * 300 + reflowOffset - scrollTopValue;
        if (element.matches('.rendered-markdown p')) {
          return new DOMRect(0, top + 24, hostWidth, 22.28);
        }
        return new DOMRect(0, top, hostWidth, 300);
      }
      return new DOMRect(0, 0, hostWidth, 40);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, `I will end this sentence with END-${index}.`),
              messageID: messageId,
            },
          ],
        };
      })
    );
    flushSolid();
    const list = mountList();
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 631 },
      clientWidth: { configurable: true, get: () => hostWidth },
      offsetWidth: { configurable: true, get: () => hostWidth },
      scrollHeight: { configurable: true, value: 15000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      },
    });
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTopValue = 20 * 300;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    const paragraph = container!.querySelector<HTMLElement>(
      '[data-msg-id="assistant-20"] .rendered-markdown p'
    )!;
    expect(paragraph.getBoundingClientRect().top).toBe(61);

    let sampledTop: number | undefined;
    requestAnimationFrame(() => {
      sampledTop = paragraph.getBoundingClientRect().top;
    });
    pixelRatio = 1.2;
    listTop = 36.822914;
    window.dispatchEvent(new Event('resize'));
    flushSolid();
    // Native zoom can reflow again after the resize event, before the queued frame callbacks.
    hostWidth = 405;
    reflowOffset = -42.684894;
    animationFrames.flush();
    flushSolid();
    expect(sampledTop).toBeCloseTo(18.13802, 4);
    expect(paragraph.getBoundingClientRect().top - listTop).toBeCloseTo(24, 4);
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(paragraph.getBoundingClientRect().top - listTop).toBeCloseTo(24, 4);
    }
    animationFrames.restore();
    flushSolid();
  });

  it('settles a resize correction that synchronously reflows its virtual core before returning', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let width = 486;
    let top = 0;
    let offset = 0;
    let reflowOnCorrection = false;
    vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
    mockElementRects((element) => {
      if (element.classList.contains('interactive-list')) return new DOMRect(0, 37, width, 631);
      if (element.classList.contains('interactive-list-track'))
        return new DOMRect(0, 37 - top, width, 18000);
      const row = element.dataset.msgId ? element : element.closest<HTMLElement>('[data-msg-id]');
      const id = row?.dataset.msgId;
      if (id?.startsWith('assistant-')) {
        const y = 37 + Number(id.slice('assistant-'.length)) * 300 + offset - top;
        return element.matches('.rendered-markdown p')
          ? new DOMRect(0, y + 24, width, 23)
          : new DOMRect(0, y, width, 300);
      }
      return new DOMRect(0, 0, width, 40);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const id = `assistant-${index}`;
        return {
          info: assistantMessage(id),
          parts: [{ ...textPart(`text-${index}`, `Paragraph ${index}.`), messageID: id }],
        };
      })
    );
    flushSolid();
    const list = mountList();
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 631 },
      clientWidth: { configurable: true, get: () => width },
      offsetWidth: { configurable: true, get: () => width },
      scrollHeight: { configurable: true, value: 18000 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
          if (reflowOnCorrection) {
            reflowOnCorrection = false;
            offset -= 22;
          }
        },
      },
    });
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -720 }));
    flushSolid();
    top = 6000;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    const paragraph = container!.querySelector<HTMLElement>(
      '[data-msg-id="assistant-20"] .rendered-markdown p'
    )!;
    const initialTop = paragraph.getBoundingClientRect().top;
    width = 430;
    offset = 178;
    reflowOnCorrection = true;
    window.dispatchEvent(new Event('resize'));
    flushSolid();
    expect(paragraph.getBoundingClientRect().top).toBe(initialTop);
    animationFrames.restore();
    flushSolid();
  });

  it('does not refresh a fully visible resize anchor after local width reflow', async () => {
    vi.useFakeTimers();
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const observers = installTrackedResizeObservers();

    const rowHeights: number[] = Array.from({ length: 50 }, (_, index) =>
      index % 2 === 0 ? 82 : 65
    );
    const rowElements = new Map<number, HTMLElement>();
    const rowHeight = (index: number) => {
      const row = rowElements.get(index);
      const correction = Number.parseFloat(
        row?.style.getPropertyValue('--interactive-item-block-correction') ?? ''
      );
      return rowHeights[index]! + (Number.isFinite(correction) ? correction : 0);
    };
    const rowTop = (index: number) =>
      rowHeights
        .slice(0, index)
        .reduce((total, _height, rowIndex) => total + rowHeight(rowIndex), 0);
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };
    let listWidth = 486;
    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, listWidth, 631);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(
          0,
          0,
          listWidth,
          rowHeights.reduce((total, _height, index) => total + rowHeight(index), 0)
        );
      }
      const row = element.dataset.msgId
        ? element
        : (element.closest<HTMLElement>('[data-msg-id]') ?? null);
      const messageId = row?.dataset.msgId;
      if (messageId?.startsWith('user-') || messageId?.startsWith('assistant-')) {
        const index = Number(messageId.slice(messageId.lastIndexOf('-') + 1));
        const top = rowTop(index) - scrollTop.value;
        if (element.dataset.assistantRenderKey) return new DOMRect(0, top + 6, listWidth, 22);
        if (element.classList.contains('user-message-card')) {
          return new DOMRect(0, top + 6, listWidth, Math.max(1, rowHeights[index]! - 12));
        }
        return new DOMRect(0, top, listWidth, rowHeight(index));
      }
      return new DOMRect(0, 0, listWidth, 40);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = index % 2 === 0 ? `user-${index}` : `assistant-${index}`;
        return {
          info:
            index % 2 === 0
              ? userMessage(messageId)
              : assistantMessage(messageId, { parentID: `user-${index - 1}` }),
          parts: [{ ...textPart(`text-${index}`, `Message ${index}`), messageID: messageId }],
        };
      })
    );
    flushSolid();
    list = mountList();
    for (const row of container?.querySelectorAll<HTMLElement>('[data-msg-id]') ?? []) {
      const messageId = row.dataset.msgId;
      if (!messageId) continue;
      rowElements.set(Number(messageId.slice(messageId.lastIndexOf('-') + 1)), row);
      flushSolid();
    }
    defineLayoutMetrics(
      list,
      { clientHeight: 631 },
      {
        clientWidth: () => listWidth,
        offsetWidth: () => listWidth,
        scrollHeight: () =>
          rowHeights.reduce((total, _height, index) => total + rowHeight(index), 0),
      }
    );
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }

    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    const userIndex = 20;
    const assistantIndex = 21;
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = rowTop(userIndex) + 14;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();
    // Leave the next coalesced refresh pending so local reflow can precede it.
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const userRow = container?.querySelector(`[data-msg-id="user-${userIndex}"]`) as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const assistantRow = container?.querySelector(
      `[data-msg-id="assistant-${assistantIndex}"]`
    ) as HTMLDivElement;
    const rowObserver = observers.find(
      (observer) => observer.targets.has(userRow) && observer.targets.has(assistantRow)
    );
    expect(userRow.getBoundingClientRect().top).toBe(-14);
    expect(assistantRow.getBoundingClientRect().top).toBe(68);
    expect(rowObserver).toBeDefined();

    rowHeights[userIndex] = 103.25;
    listWidth = 360;
    // Local layout can change before ResizeObserver reports the new row sizes. A pending detached
    // anchor refresh must not replace the pre-reflow anchor with this already-moved geometry.
    animationFrames.flush();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: userRow,
          borderBoxSize: [{ blockSize: 103.25, inlineSize: 360 }],
        }),
        fixture<ResizeObserverEntry>({
          target: assistantRow,
          borderBoxSize: [{ blockSize: 65, inlineSize: 360 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(assistantRow.getBoundingClientRect().top).toBe(68);
    }

    await vi.advanceTimersByTimeAsync(101);
    flushSolid();
    rowHeights[userIndex] = 125.5;
    listWidth = 480;
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: userRow,
          borderBoxSize: [{ blockSize: rowHeight(userIndex), inlineSize: 480 }],
        }),
        fixture<ResizeObserverEntry>({
          target: assistantRow,
          borderBoxSize: [{ blockSize: 65, inlineSize: 480 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(assistantRow.getBoundingClientRect().top).toBe(68);
    }
    animationFrames.restore();
    flushSolid();
  });

  it('preserves the wheel destination when width reflow precedes the native scroll event', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const observers = installTrackedResizeObservers();

    const rowHeights = Array.from({ length: 60 }, () => 100);
    const rowTop = (index: number) =>
      rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };
    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 786);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(
          0,
          0,
          500,
          rowHeights.reduce((total, height) => total + height, 0)
        );
      }
      const row = element.dataset.msgId
        ? element
        : (element.closest<HTMLElement>('[data-msg-id]') ?? null);
      const messageId = row?.dataset.msgId;
      if (messageId?.startsWith('user-') || messageId?.startsWith('assistant-')) {
        const index = Number(messageId.slice(messageId.lastIndexOf('-') + 1));
        const top = rowTop(index) - scrollTop.value;
        return element.classList.contains('user-message-card')
          ? new DOMRect(0, top + 6, 500, 40)
          : new DOMRect(0, top, 500, rowHeights[index]);
      }
      return new DOMRect(0, 0, 500, 40);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = index === 20 ? `user-${index}` : `assistant-${index}`;
        return {
          info: index === 20 ? userMessage(messageId) : assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Message ${index}`), messageID: messageId }],
        };
      })
    );
    flushSolid();
    list = mountList();
    defineLayoutMetrics(
      list,
      { clientHeight: 786, clientWidth: 500, offsetWidth: 500 },
      { scrollHeight: () => rowHeights.reduce((total, height) => total + height, 0) }
    );
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }

    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 1976;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const precedingRow = container?.querySelector('[data-msg-id="assistant-19"]') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchorRow = container?.querySelector('[data-msg-id="user-20"]') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchorCard = anchorRow.querySelector('.user-message-card') as HTMLDivElement;
    const rowObserver = observers.find(
      (observer) => observer.targets.has(precedingRow) && observer.targets.has(anchorRow)
    );
    expect(anchorCard.getBoundingClientRect().top).toBe(30);
    expect(rowObserver).toBeDefined();

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 22 }));
    flushSolid();
    scrollTop.value += 22;
    expect(anchorCard.getBoundingClientRect().top).toBe(8);

    rowHeights[19] = 122;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: precedingRow,
          borderBoxSize: [{ blockSize: 122, inlineSize: 360 }],
        }),
        fixture<ResizeObserverEntry>({
          target: anchorRow,
          borderBoxSize: [{ blockSize: 100, inlineSize: 360 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );
    // Sample every reflow frame: a settled-only assertion can miss a one-frame jump that a
    // later correction hides.
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(anchorCard.getBoundingClientRect().top).toBe(8);
    }
    await Promise.resolve();
    flushSolid();

    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(anchorCard.getBoundingClientRect().top).toBe(8);
    animationFrames.restore();
    flushSolid();
  });

  it('does not reverse an upward wheel for a delayed stale measurement above its user anchor', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const observers = installTrackedResizeObservers();

    const rowHeights: number[] = Array.from({ length: 60 }, (_, index) =>
      index % 2 === 0 ? 65 : 82
    );
    const rowTop = (index: number) =>
      rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };
    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 720, 514);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(
          0,
          0,
          720,
          rowHeights.reduce((total, height) => total + height, 0)
        );
      }
      const row = element.dataset.msgId
        ? element
        : (element.closest<HTMLElement>('[data-msg-id]') ?? null);
      const messageId = row?.dataset.msgId;
      if (messageId?.startsWith('user-') || messageId?.startsWith('assistant-')) {
        const index = Number(messageId.slice(messageId.lastIndexOf('-') + 1));
        const top = rowTop(index) - scrollTop.value;
        return element.classList.contains('user-message-card')
          ? new DOMRect(0, top, 720, 40)
          : new DOMRect(0, top, 720, rowHeights[index]);
      }
      return new DOMRect(0, 0, 720, 40);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = index % 2 === 0 ? `assistant-${index}` : `user-${index}`;
        return {
          info: index % 2 === 0 ? assistantMessage(messageId) : userMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Message ${index}`), messageID: messageId }],
        };
      })
    );
    flushSolid();
    list = mountList();
    defineLayoutMetrics(
      list,
      { clientHeight: 514, clientWidth: 720, offsetWidth: 720 },
      { scrollHeight: () => rowHeights.reduce((total, height) => total + height, 0) }
    );
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = rowTop(20) + 23;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    // The browser has already laid out this 2px change, but its observer entry is delayed until
    // after the next direct wheel destination is established.
    rowHeights[20] = rowHeights[20]! + 2;
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -180 }));
    flushSolid();
    scrollTop.value -= 180;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    const wheelDestination = scrollTop.value;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchorCard = container?.querySelector(
      '[data-msg-id="user-21"] .user-message-card'
    ) as HTMLDivElement;
    const anchorTop = anchorCard.getBoundingClientRect().top;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const staleRow = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const growingRow = container?.querySelector('[data-msg-id="assistant-24"]') as HTMLDivElement;
    const rowObserver = observers.find(
      (observer) => observer.targets.has(staleRow) && observer.targets.has(growingRow)
    );
    expect(rowObserver).toBeDefined();

    rowHeights[24] = rowHeights[24]! + 134;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: staleRow,
          borderBoxSize: [{ blockSize: rowHeights[20]!, inlineSize: 720 }],
        }),
        fixture<ResizeObserverEntry>({
          target: growingRow,
          borderBoxSize: [{ blockSize: rowHeights[24]!, inlineSize: 720 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );

    expect(scrollTop.value).toBe(wheelDestination);
    expect(anchorCard.getBoundingClientRect().top).toBe(anchorTop);

    // A stale remembered position can also outlive an unrelated layout shift. An unchanged
    // observer batch must not turn that displacement into a programmatic scroll correction.
    rowHeights[20] = rowHeights[20]! + 179;
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: growingRow,
          borderBoxSize: [{ blockSize: rowHeights[24]!, inlineSize: 720 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );
    expect(scrollTop.value).toBe(wheelDestination);
    animationFrames.restore();
    flushSolid();
  });

  it('cancels compact activity layout settling before native wheel movement is reported', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const rowIds = Array.from({ length: 60 }, (_, index) => {
      if (index === 20) return 'user-active';
      if (index === 21) return 'assistant-completed';
      if (index === 22) return 'assistant-running';
      if (index === 23) return 'assistant-edit';
      return `assistant-${index}`;
    });
    const rowIndex = new Map(rowIds.map((id, index) => [id, index]));
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };

    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, -scrollTop.value, 500, 6000);
      }
      const row = element.dataset.msgId ? element : element.closest<HTMLElement>('[data-msg-id]');
      const index = row?.dataset.msgId ? rowIndex.get(row.dataset.msgId) : undefined;
      if (index !== undefined) {
        return new DOMRect(0, index * 100 - scrollTop.value, 500, 100);
      }
      return new DOMRect(0, 0, 500, 40);
    });

    const completed = toolPart('grep-completed', 'assistant-completed', 'call-grep-completed');
    completed.tool = 'grep';
    completed.state = {
      status: 'completed',
      input: { pattern: 'activity' },
      output: 'matches',
      title: 'activity',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    const running = toolPart('bash-running', 'assistant-running', 'call-bash-running');
    running.tool = 'bash';
    running.state = {
      status: 'running',
      input: { command: 'npm run test' },
      title: 'npm run test',
      time: { start: 3 },
    };
    const completedRunning = toolPart('bash-running', 'assistant-running', 'call-bash-running');
    completedRunning.tool = 'bash';
    completedRunning.state = {
      status: 'completed',
      input: { command: 'npm run test' },
      output: 'passed',
      title: 'npm run test',
      metadata: {},
      time: { start: 3, end: 4 },
    };
    const edit = toolPart('patch-completed', 'assistant-edit', 'call-patch-completed');
    edit.tool = 'apply_patch';
    edit.state = {
      status: 'completed',
      input: { patchText: '*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch' },
      output: 'Done',
      title: 'apply_patch',
      metadata: {},
      time: { start: 5, end: 6 },
    };
    const messagesWith = (activity: ReturnType<typeof toolPart>) =>
      rowIds.map((messageId, index) => {
        if (messageId === 'user-active') {
          return {
            info: userMessage(messageId),
            parts: [textPart('prompt-active', 'Inspect, edit, and verify the activity flow')],
          };
        }
        const parts =
          messageId === 'assistant-completed'
            ? [completed]
            : messageId === 'assistant-running'
              ? [reasoningPart('reasoning-running', 'Checking the active change'), activity]
              : messageId === 'assistant-edit'
                ? [edit]
                : [textPart(`text-${index}`, `Response ${index}`)];
        return {
          info: assistantMessage(messageId, { parentID: 'user-active' }),
          parts,
        };
      });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setStateRecord('sessionStatus', { 'session-1': { type: 'busy' } });
    flushSolid();
    replaceMessages(messagesWith(running));
    flushSolid();
    mountList();
    // SAFETY: The rendered MessageList fixture always provides its transcript element.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    defineLayoutMetrics(list, {
      clientHeight: 400,
      clientWidth: 500,
      offsetWidth: 500,
      scrollHeight: 6000,
    });
    backScrollTop(list, scrollTop);
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 2000;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await vi.advanceTimersByTimeAsync(500);
    flushSolid();

    replaceMessages(messagesWith(completedRunning));
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -64 }));
    flushSolid();
    scrollTop.value -= 64;
    const wheelDestination = scrollTop.value;
    const anchor = container?.querySelector<HTMLElement>(
      '[data-msg-id="user-active"] .user-message-card'
    );
    const anchorDestination = anchor?.getBoundingClientRect().top;

    for (let frame = 0; frame < 12; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
      expect(scrollTop.value).toBe(wheelDestination);
      expect(anchor?.getBoundingClientRect().top).toBe(anchorDestination);
    }
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(wheelDestination);
    animationFrames.restore();
    flushSolid();
  });

  it('does not treat a visible row below pre-message chrome as above the viewport', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const observers = installTrackedResizeObservers();

    const chromeHeight = 48;
    const rowHeights: number[] = Array.from({ length: 50 }, (_, index) => (index === 0 ? 20 : 100));
    const rowTop = (index: number) =>
      chromeHeight + rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
    const totalHeight = () =>
      chromeHeight + rowHeights.reduce((total, height) => total + height, 0);
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };
    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, -scrollTop.value, 500, totalHeight());
      }
      if (element.classList.contains('message-history-banner')) {
        return new DOMRect(0, 14 - scrollTop.value, 500, 22);
      }
      if (element.dataset.msgId?.startsWith('assistant-')) {
        const index = Number(element.dataset.msgId.replace('assistant-', ''));
        return new DOMRect(0, rowTop(index) - scrollTop.value, 500, rowHeights[index]);
      }
      return new DOMRect(0, 0, 500, 40);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-older');
    flushSolid();
    replaceMessages(assistantRows(50));
    flushSolid();

    list = mountList();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const historyBanner = container?.querySelector('.message-history-banner') as HTMLDivElement;
    track.style.paddingTop = '14px';
    historyBanner.style.marginBottom = '12px';
    defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: totalHeight });
    backScrollTop(list, scrollTop);
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 30;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const firstRow = container?.querySelector('[data-msg-id="assistant-0"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(firstRow));
    expect(rowObserver).toBeDefined();
    const topBefore = firstRow.getBoundingClientRect().top;
    expect(topBefore).toBe(18);

    rowHeights[0] = 40;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: firstRow,
          borderBoxSize: [{ blockSize: 40, inlineSize: 500 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );

    expect(firstRow.getBoundingClientRect().top).toBe(topBefore);
    expect(scrollTop.value).toBe(30);
    animationFrames.restore();
    flushSolid();
  });

  it('invalidates cached heights for offscreen reasoning rows when thinking visibility changes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };

    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, 5000);
      }
      if (element.dataset.msgId?.startsWith('assistant-')) {
        const index = Number(element.dataset.msgId.replace('assistant-', ''));
        return new DOMRect(0, index * 100 - scrollTop.value, 500, 100);
      }
      return new DOMRect(0, 0, 500, 40);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index < 40
              ? [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }]
              : [
                  {
                    ...reasoningPart(`reasoning-${index}`, `Reasoning ${index}`),
                    messageID: messageId,
                  },
                ],
        };
      })
    );
    flushSolid();

    list = mountList();
    defineLayoutMetrics(list, { clientHeight: 400, scrollHeight: 5000 });
    backScrollTop(list, scrollTop);
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 0;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('[data-msg-id="assistant-40"]')).toBeNull();
    const bottomSpacer = () =>
      Number.parseFloat(
        container?.querySelector<HTMLElement>('.virtual-spacer-bottom')?.style.height || '0'
      );
    const bottomPadBefore = bottomSpacer();

    setShowThinkingPreference(false);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('[data-msg-id="assistant-40"]')).toBeNull();
    // Compact activity already gives the follower rows zero height, so hiding thinking removes only
    // the disclosure owner's provisional height.
    expect(bottomSpacer() - bottomPadBefore).toBe(-100);
    animationFrames.restore();
    flushSolid();
  });

  it.each([false, true])(
    'invalidates an offscreen active edit height when inline previews are disabled (reopened: %s)',
    async (reopened) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      let list: HTMLDivElement | null = null;
      const scrollTop = { value: 0 };

      mockElementRects((element) => {
        if (element === list || element.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (element.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 5000);
        }
        if (element.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(element.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * 100 - scrollTop.value, 500, 100);
        }
        return new DOMRect(0, 0, 500, 40);
      });

      const editMessageId = 'assistant-20';
      const edit = toolPart('edit-0', editMessageId, 'call-edit-0');
      edit.tool = 'apply_patch';
      edit.state = {
        status: 'completed',
        input: {
          patchText:
            '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const value = 1;\n+const value = 2;\n*** End Patch',
        },
        output: 'Done',
        title: 'apply_patch',
        metadata: {},
        time: { start: 1, end: 2 },
      };
      setShowFileDiffs(true);
      flushSolid();
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      setStateRecord('sessionStatus', { 'session-1': { type: 'busy' } });
      flushSolid();
      replaceMessages(
        Array.from({ length: 50 }, (_, index) => {
          const messageId = `assistant-${index}`;
          return {
            info: assistantMessage(messageId, { parentID: 'user-1' }),
            parts:
              index === 20
                ? [edit]
                : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
          };
        })
      );
      flushSolid();

      for (let mount = 0; mount < (reopened ? 2 : 1); mount += 1) {
        if (mount > 0) cleanup?.();
        flushSolid();
        list = mountList();
        defineLayoutMetrics(list, { clientHeight: 400, scrollHeight: 5000 });
        backScrollTop(list, scrollTop);
        for (let frame = 0; frame < 4; frame += 1) {
          await Promise.resolve();
          flushFrame(animationFrames);
        }
        if (mount === 0) await measureTranscriptRows(list, animationFrames);
        flushSolid();
      }
      list!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
      flushSolid();
      scrollTop.value = 4000;
      list!.dispatchEvent(new Event('scroll'));
      flushSolid();
      await Promise.resolve();
      flushFrame(animationFrames);
      await Promise.resolve();
      flushSolid();

      expect(container?.querySelector(`[data-msg-id="${editMessageId}"]`)).toBeNull();
      const topSpacer = () =>
        Number.parseFloat(
          container?.querySelector<HTMLElement>('.virtual-spacer-top')?.style.height || '0'
        );
      const topPadBefore = topSpacer();

      setShowFileDiffs(false);
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();

      expect(container?.querySelector(`[data-msg-id="${editMessageId}"]`)).toBeNull();
      // A reopen's initial preview projection already invalidates the old estimate.
      // Hiding that still-unmounted preview must not restore its old measured height.
      expect(topSpacer() - topPadBefore).toBe(reopened ? 0 : 60);
      expect(topPadBefore % 100).toBe(reopened ? 60 : 0);
      animationFrames.restore();
      flushSolid();
    }
  );

  it('preserves the visible row while invalidating offscreen thinking heights above it', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const rowHeights = Array.from({ length: 50 }, () => 100);
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };

    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(
          0,
          0,
          500,
          rowHeights.reduce((sum, height) => sum + height, 0)
        );
      }
      if (element.dataset.msgId?.startsWith('assistant-')) {
        const index = Number(element.dataset.msgId.replace('assistant-', ''));
        const mountedIndexes = [
          ...(container?.querySelectorAll<HTMLElement>('[data-msg-id^="assistant-"]') || []),
        ].map((row) => Number(row.dataset.msgId!.replace('assistant-', '')));
        const firstMountedIndex = Math.min(...mountedIndexes, index);
        const topPad = Number.parseFloat(
          container?.querySelector<HTMLElement>('.virtual-spacer-top')?.style.height || '0'
        );
        const mountedHeightBefore = rowHeights
          .slice(firstMountedIndex, index)
          .reduce((sum, height) => sum + height, 0);
        return new DOMRect(
          0,
          topPad + mountedHeightBefore - scrollTop.value,
          500,
          rowHeights[index]
        );
      }
      return new DOMRect(0, 0, 500, 40);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId, { parentID: 'user-1' }),
          parts:
            index < 5
              ? [
                  {
                    ...reasoningPart(`reasoning-${index}`, `Reasoning ${index}`),
                    messageID: messageId,
                  },
                ]
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    flushSolid();

    list = mountList();
    defineLayoutMetrics(
      list,
      { clientHeight: 400 },
      { scrollHeight: () => rowHeights.reduce((sum, height) => sum + height, 0) }
    );
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 2000;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchor = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    expect(anchor).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="assistant-0"]')).toBeNull();
    const anchorTopBefore = anchor.getBoundingClientRect().top;
    rowHeights[0] = 40;
    for (let index = 1; index < 5; index += 1) rowHeights[index] = 0;

    setShowThinkingPreference(false);
    flushSolid();
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }

    expect(anchor.isConnected).toBe(true);
    expect(anchor.getBoundingClientRect().top).toBe(anchorTopBefore);
    animationFrames.restore();
    flushSolid();
  });

  it('preserves the first fully painted user card when hiding thinking shrinks a clipped row', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };
    let clientHeight = 100;
    let thinkingVisible = true;
    let hostWidth = 500;
    let paragraphOffset = 6;
    let collectingAnchorReads = false;
    const anchorReads = new Map<HTMLElement, number>();
    vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => hostWidth);

    const rowHeight = (index: number) => {
      if (index !== 20) return 100;
      return thinkingVisible ? 76 : 65;
    };
    const rowTop = (index: number) => {
      let top = -scrollTop.value;
      for (let rowIndex = 0; rowIndex < index; rowIndex += 1) top += rowHeight(rowIndex);
      return top;
    };

    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, hostWidth, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(
          0,
          0,
          hostWidth,
          Array.from({ length: 50 }, (_, index) => rowHeight(index)).reduce(
            (sum, height) => sum + height,
            0
          )
        );
      }
      const row = element.dataset.msgId ? element : element.closest<HTMLElement>('[data-msg-id]');
      const messageId = row?.dataset.msgId;
      if (collectingAnchorReads && element.tagName === 'P') {
        anchorReads.set(element, (anchorReads.get(element) ?? 0) + 1);
      }
      if (!row || !messageId) return new DOMRect(0, 0, hostWidth, 40);
      const index =
        messageId === 'assistant-anchor'
          ? 20
          : messageId === 'user-anchor'
            ? 21
            : Number(messageId.replace('assistant-', ''));
      const top = rowTop(index);
      if (element === row) return new DOMRect(0, top, hostWidth, rowHeight(index));
      if (element.classList.contains('user-message-card')) {
        return new DOMRect(0, top + 6, hostWidth, 69);
      }
      if (element.tagName === 'P') return new DOMRect(0, top + paragraphOffset, hostWidth, 39);
      return new DOMRect(0, top, hostWidth, rowHeight(index));
    });

    setShowThinkingPreference(true);
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        if (index === 20) {
          return {
            info: assistantMessage('assistant-anchor'),
            parts: [
              reasoningPart('reasoning-anchor', 'Thinking above the visible prompt'),
              textPart('text-anchor', 'Response above the visible prompt'),
            ],
          };
        }
        if (index === 21) {
          return {
            info: userMessage('user-anchor'),
            parts: [textPart('user-text-anchor', 'Keep this prompt fixed')],
          };
        }
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [textPart(`text-${index}`, `Response ${index}`)],
        };
      })
    );
    flushSolid();

    list = mountList();
    Object.defineProperty(list, 'clientHeight', {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(list, 'clientWidth', {
      configurable: true,
      get: () => hostWidth,
    });
    Object.defineProperty(list, 'offsetWidth', {
      configurable: true,
      get: () => hostWidth,
    });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () =>
        Array.from({ length: 50 }, (_, index) => rowHeight(index)).reduce(
          (sum, height) => sum + height,
          0
        ),
    });
    backScrollTop(list, scrollTop);
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }

    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 1998;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }

    const anchor = container?.querySelector<HTMLElement>(
      '[data-msg-id="user-anchor"] .user-message-card'
    );
    expect(anchor?.getBoundingClientRect().top).toBe(84);

    hostWidth = 360;
    window.dispatchEvent(new Event('resize'));
    flushSolid();
    paragraphOffset = -21;
    clientHeight = 400;
    expect(anchor?.getBoundingClientRect().top).toBe(84);
    const stopUpdatingFixtureGeometry = onBeforeShowThinkingPreferenceChange(() => {
      collectingAnchorReads = false;
      thinkingVisible = false;
    });
    collectingAnchorReads = true;
    setShowThinkingPreference(false);
    flushSolid();
    stopUpdatingFixtureGeometry();
    flushSolid();
    // Later visible blocks used to be reread by the anchor candidate sort comparator.
    for (const messageId of ['assistant-22', 'assistant-23']) {
      const paragraph = container?.querySelector<HTMLElement>(`[data-msg-id="${messageId}"] p`);
      expect(paragraph).toBeInstanceOf(HTMLElement);
      expect(anchorReads.get(paragraph!)).toBe(1);
    }
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }

    expect(anchor?.getBoundingClientRect().top).toBe(84);
    animationFrames.restore();
    flushSolid();
  });

  it('does not give an explicitly render-empty row a provisional virtual height', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };

    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, 4900);
      }
      if (element.dataset.msgId) {
        const index = Number(element.dataset.msgId.replace('assistant-', ''));
        const height = index === 0 ? 0 : 100;
        return new DOMRect(0, index * 100 - scrollTop.value, 500, height);
      }
      return new DOMRect(0, 0, 500, 40);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 0
              ? []
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    flushSolid();

    list = mountList();
    defineLayoutMetrics(list, { clientHeight: 400, scrollHeight: 4900 });
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    expect(
      container?.querySelector('.interactive-list-track')?.classList.contains('virtualized')
    ).toBe(true);

    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 3000;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId).toBe(
      'assistant-16'
    );
    animationFrames.restore();
    flushSolid();
  });

  it('retains the prior height when a rendered nonempty row reports a transient zero', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const observers = installTrackedResizeObservers();
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };
    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, 5000);
      }
      if (element.dataset.msgId) {
        const index = Number(element.dataset.msgId.replace('assistant-', ''));
        return new DOMRect(0, index * 100 - scrollTop.value, 500, 100);
      }
      return new DOMRect(0, 0, 500, 40);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(assistantRows(50));
    flushSolid();
    list = mountList();
    defineLayoutMetrics(list, { clientHeight: 400, scrollHeight: 5000 });
    backScrollTop(list, scrollTop);
    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    list.scrollTop = 0;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const firstRow = container?.querySelector('[data-msg-id="assistant-0"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(firstRow));
    expect(firstRow.childElementCount).toBeGreaterThan(0);
    expect(rowObserver).toBeDefined();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    rowObserver!.callback(
      [
        fixture<ResizeObserverEntry>({
          target: firstRow,
          borderBoxSize: [{ blockSize: 0, inlineSize: 500 }],
        }),
      ],
      fixture<ResizeObserver>(rowObserver)
    );

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTop.value = 3000;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId).toBe(
      'assistant-15'
    );
    animationFrames.restore();
    flushSolid();
  });

  it('remounts and remeasures a cached zero-height row after it gains content', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };

    mockElementRects((element) => {
      // Fake geometry reads the store like a measurement: untracked.
      const zeroRowHasContent = untrack(
        () =>
          state.messages.find((message) => message.info.id === 'assistant-30')?.parts.length !== 0
      );
      const trackHeight = zeroRowHasContent ? 5000 : 4900;
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      if (element.dataset.msgId) {
        const index = Number(element.dataset.msgId.replace('assistant-', ''));
        const height = index === 30 && !zeroRowHasContent ? 0 : 100;
        const documentTop = index <= 30 ? index * 100 : index * 100 - (zeroRowHasContent ? 0 : 100);
        return new DOMRect(0, documentTop - scrollTop.value, 500, height);
      }
      return new DOMRect(0, 0, 500, 40);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 30
              ? []
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    flushSolid();

    list = mountList();
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () =>
        state.messages.find((message) => message.info.id === 'assistant-30')?.parts.length
          ? 5000
          : 4900,
    });
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    flushSolid();
    scrollTop.value = 4450;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeNull();

    let emptyRowRemounted = false;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof HTMLElement &&
            (node.dataset.msgId === 'assistant-30' ||
              node.querySelector('[data-msg-id="assistant-30"]'))
          ) {
            emptyRowRemounted = true;
          }
        }
      }
    });
    mutationObserver.observe(track, { childList: true, subtree: true });
    flushSolid();
    upsertPart({
      ...textPart('text-0-extra', 'An unrelated message changed'),
      messageID: 'assistant-0',
    });
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();
    expect(emptyRowRemounted).toBe(false);

    upsertPart({
      ...textPart('text-30', 'Content appeared after the zero-height row unmounted'),
      messageID: 'assistant-30',
    });
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeInstanceOf(HTMLDivElement);
    mutationObserver.disconnect();
    animationFrames.restore();
    flushSolid();
  });

  it('makes a cached zero-height row provisional when it gains model chrome', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };

    mockElementRects((element) => {
      const hasModelChange = hasAssistantModelChangeBetween('assistant-29', 'assistant-30');
      const trackHeight = hasModelChange ? 5000 : 4900;
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      if (element.dataset.msgId) {
        const index = Number(element.dataset.msgId.replace('assistant-', ''));
        const height = index === 30 && !hasModelChange ? 0 : 100;
        const documentTop = index <= 30 ? index * 100 : index * 100 - (hasModelChange ? 0 : 100);
        return new DOMRect(0, documentTop - scrollTop.value, 500, height);
      }
      return new DOMRect(0, 0, 500, 40);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 30
              ? []
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    flushSolid();

    list = mountList();
    defineLayoutMetrics(
      list,
      { clientHeight: 400 },
      {
        scrollHeight: () =>
          hasAssistantModelChangeBetween('assistant-29', 'assistant-30') ? 5000 : 4900,
      }
    );
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    flushSolid();
    scrollTop.value = 4450;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeNull();

    replaceMessages(
      state.messages.map((message) =>
        message.info.id === 'assistant-29'
          ? {
              ...message,
              info: assistantMessage('assistant-29', {
                modelID: 'claude-sonnet-4',
                providerID: 'anthropic',
              }),
            }
          : message
      )
    );
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    const remountedRow = container?.querySelector('[data-msg-id="assistant-30"]');
    expect(remountedRow).toBeInstanceOf(HTMLDivElement);
    expect(remountedRow?.querySelector('.model-change-indicator')).not.toBeNull();
    animationFrames.restore();
    flushSolid();
  });

  it('remounts an offscreen cached zero-height row after the same text part becomes visible', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };

    mockElementRects((element) => {
      // Fake geometry reads the store like a measurement: untracked.
      const zeroRowHasContent = untrack(
        () =>
          !!state.messages
            .find((message) => message.info.id === 'assistant-30')
            ?.parts.find(
              (part) => part.id === 'text-30' && part.type === 'text' && part.text.trim()
            )
      );
      const trackHeight = zeroRowHasContent ? 5000 : 4900;
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      if (element.dataset.msgId) {
        const index = Number(element.dataset.msgId.replace('assistant-', ''));
        const height = index === 30 && !zeroRowHasContent ? 0 : 100;
        const documentTop = index <= 30 ? index * 100 : index * 100 - (zeroRowHasContent ? 0 : 100);
        return new DOMRect(0, documentTop - scrollTop.value, 500, height);
      }
      return new DOMRect(0, 0, 500, 40);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, index === 30 ? '' : `Response ${index}`),
              messageID: messageId,
            },
          ],
        };
      })
    );
    flushSolid();

    list = mountList();
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () =>
        state.messages
          .find((message) => message.info.id === 'assistant-30')
          ?.parts.find((part) => part.id === 'text-30' && part.type === 'text' && part.text.trim())
          ? 5000
          : 4900,
    });
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    flushSolid();
    scrollTop.value = 4450;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeNull();

    upsertPart({
      ...textPart('text-30', 'The existing part is now visible'),
      messageID: 'assistant-30',
    });
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    const remountedRow = container?.querySelector('[data-msg-id="assistant-30"]');
    expect(remountedRow).toBeInstanceOf(HTMLDivElement);
    expect(remountedRow?.textContent).toContain('The existing part is now visible');
    animationFrames.restore();
    flushSolid();
  });

  it('remounts an offscreen zero-height row when completion makes diffs eligible', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };
    let diffRequested = false;
    vi.spyOn(client.session, 'diff').mockImplementation(async () => {
      diffRequested = true;
      return [
        {
          file: 'src/completed.ts',
          before: 'old',
          after: 'new',
          additions: 1,
          deletions: 1,
        },
      ];
    });
    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, diffRequested ? 5000 : 4900);
      }
      if (element.dataset.msgId) {
        const index = Number(element.dataset.msgId.replace('message-', ''));
        const height = index === 30 && !diffRequested ? 0 : 100;
        const documentTop = index <= 30 ? index * 100 : index * 100 - (diffRequested ? 0 : 100);
        return new DOMRect(0, documentTop - scrollTop.value, 500, height);
      }
      return new DOMRect(0, 0, 500, 40);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `message-${index}`;
        if (index === 30) {
          return {
            info: assistantMessage(messageId, { time: { created: 1 } }),
            parts: [],
          };
        }
        return {
          info: userMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Prompt ${index}`), messageID: messageId }],
        };
      })
    );
    flushSolid();

    list = mountList();
    defineLayoutMetrics(
      list,
      { clientHeight: 400 },
      { scrollHeight: () => (diffRequested ? 5000 : 4900) }
    );
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    flushSolid();
    scrollTop.value = 4450;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('[data-msg-id="message-30"]')).toBeNull();
    expect(client.session.diff).not.toHaveBeenCalled();

    replaceMessages(
      state.messages.map((message) =>
        message.info.id === 'message-30'
          ? {
              ...message,
              info: assistantMessage('message-30', { time: { created: 1, completed: 2 } }),
            }
          : message
      )
    );
    flushSolid();
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }

    expect(client.session.diff).toHaveBeenCalledWith('session-1', 'message-30', {
      directory: undefined,
    });
    const remountedRow = container?.querySelector('[data-msg-id="message-30"]');
    expect(remountedRow).toBeInstanceOf(HTMLDivElement);
    expect(remountedRow?.querySelector('.diff-summary')).toBeInstanceOf(HTMLDivElement);
    animationFrames.restore();
    flushSolid();
  });

  it('cancels pending width work when async initial messages arrive or the list unmounts', async () => {
    const observers = installTrackedResizeObservers();

    let listWidth = 500;
    mockElementRects((element) => {
      if (element.classList.contains('interactive-item-container')) {
        return new DOMRect(0, 0, listWidth, 120);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, listWidth, 6000);
      }
      return new DOMRect(0, 0, listWidth, 500);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    mountList();
    const list = container!.querySelector('.interactive-list')!;
    const track = container!.querySelector('.interactive-list-track')!;
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(list) && observer.targets.has(track)
    );
    expect(layoutObserver).toBeDefined();

    listWidth = 420;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback([], fixture<ResizeObserver>(layoutObserver));
    replaceMessages(assistantRows(50));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.interactive-list-track.virtualized')).toBeTruthy();
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(40);
    await vi.advanceTimersByTimeAsync(100);
    flushSolid();
    expect(container?.querySelector('.interactive-list-track.virtualized')).toBeTruthy();

    listWidth = 400;
    const timersBeforeResize = vi.getTimerCount();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback([], fixture<ResizeObserver>(layoutObserver));
    expect(vi.getTimerCount()).toBeGreaterThan(timersBeforeResize);
    cleanup!();
    flushSolid();
    cleanup = undefined;
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBeforeResize);
    await vi.advanceTimersByTimeAsync(100);
    flushSolid();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBeforeResize);
  });

  it('stays pinned to the real bottom when virtualized messages update in place', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(assistantRows(60));
    flushSolid();

    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    const scrollTop = { value: 0 };
    let scrollHeightValue = 7200;
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
    backScrollTop(list!, scrollTop);

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    expect(scrollTop.value).toBe(6800);

    scrollTop.value = 6800;
    scrollHeightValue = 7440;
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(
                `text-${index}`,
                index === 59 ? 'Updated response with more content' : `Response ${index}`
              ),
              messageID: messageId,
            },
          ],
        };
      })
    );
    flushSolid();

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(7040);
    animationFrames.restore();
    flushSolid();
  });

  it('keeps correcting initial bottom scroll when scrollHeight shifts without track growth', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let trackHeight = 1200;

    mockTrackRects(() => trackHeight);

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(conversationTurns(1));
    flushSolid();

    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    const scrollTop = { value: 0 };
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
    backScrollTop(list!, scrollTop);

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(scrollTop.value).toBe(800);

    scrollHeightValue = 1700;
    trackHeight = 1200;
    animationFrames.flush();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1300);
    animationFrames.restore();
    flushSolid();
  });

  it('keeps bottom follow active after a downward wheel that cannot move the list', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let trackHeight = 1200;

    mockTrackRects(() => trackHeight);

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(conversationTurns(1));
    flushSolid();

    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    const scrollTop = { value: 0 };
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
    backScrollTop(list!, scrollTop);

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(scrollTop.value).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
    flushSolid();
    trackHeight = 1600;
    scrollHeightValue = 1600;
    animationFrames.flush();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1200);
    animationFrames.restore();
    flushSolid();
  });

  it('restarts bottom follow after a downward wheel cancels its pending frame', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let trackHeight = 1200;

    mockTrackRects(() => trackHeight);

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(conversationTurns(1));
    flushSolid();
    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    const scrollTop = { value: 0 };
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
    backScrollTop(list!, scrollTop);

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(scrollTop.value).toBe(800);

    trackHeight = 1600;
    scrollHeightValue = 1600;
    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
    flushSolid();
    setState(storePath('streamingPartId', 'text-2'));
    flushSolid();
    setState(storePath('streamingText', 'Streaming growth'));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1200);
    animationFrames.flush();
    flushSolid();
    animationFrames.restore();
    flushSolid();
  });

  it('keeps the latest message fully visible when the last response grows', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(promptAndResponse('Prompt 1', 'Initial response'));
    flushSolid();

    mountList();
    await Promise.resolve();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    const scrollTop = { value: 0 };
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => 1200 });
    backScrollTop(list!, scrollTop);

    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 1700 });
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('text-2', 'Expanded response'), textPart('text-3', 'More content')],
      },
    ]);
    flushSolid();

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1300);
    animationFrames.restore();
    flushSolid();
  });

  it('eases bottom scroll to the new destination when rendered content resizes', async () => {
    const { animationFrames, resizeCallbacks, list, scrollTop, layout } = mountFollowedTurn();
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    await Promise.resolve();
    flushFrame(animationFrames);
    // Finish initial positioning before testing smooth follow for later content growth.
    animationFrames.flush();
    flushSolid();
    expect(scrollTop.value).toBe(800);

    layout.trackHeight = 1700;
    layout.scrollHeight = 1700;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush(performance.now() + 16);
    flushSolid();

    expect(scrollTop.value).toBeGreaterThan(800);
    expect(scrollTop.value).toBeLessThan(1300);
    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1300);
    animationFrames.restore();
    flushSolid();
  });

  it('keeps following running tool growth when a resize notification is delayed', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let trackHeight = 1200;

    mockTrackRects(() => trackHeight);

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Run checks')] },
      { info: assistantMessage('assistant-1'), parts: [toolPart('tool-1', 'assistant-1')] },
    ]);
    flushSolid();
    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    const scrollTop = { value: 0 };
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
    backScrollTop(list!, scrollTop);

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(scrollTop.value).toBe(800);
    animationFrames.flush();
    flushSolid();

    trackHeight = 1700;
    scrollHeightValue = 1700;
    animationFrames.flush();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1300);
    animationFrames.restore();
    flushSolid();
  });

  it('keeps following delayed layout growth after final parts arrive in one batch', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let trackHeight = 1200;

    mockTrackRects(() => trackHeight);

    const userEntry = {
      info: userMessage('user-1'),
      parts: [textPart('text-1', 'Explain the result')],
    };
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages([
      userEntry,
      {
        info: assistantMessage('assistant-1'),
        parts: [{ ...textPart('text-2', 'Initial response'), messageID: 'assistant-1' }],
      },
    ]);
    flushSolid();
    setState(storePath('streamingPartId', 'text-2'));
    flushSolid();
    setState(storePath('streamingText', 'Initial response'));
    flushSolid();
    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    const scrollTop = { value: 0 };
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
    backScrollTop(list!, scrollTop);

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    setMessagesIncremental([
      userEntry,
      {
        info: assistantMessage('assistant-1'),
        parts: Array.from({ length: 20 }, (_, index) => ({
          ...textPart(`text-${index + 2}`, `Final response section ${index + 1}`),
          messageID: 'assistant-1',
        })),
      },
    ]);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    // The first post-stream frame runs before deferred markdown and entrance layout settles.
    animationFrames.flush();
    flushSolid();
    trackHeight = 1800;
    scrollHeightValue = 1800;
    animationFrames.flush();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1400);
    animationFrames.restore();
    flushSolid();
  });

  it('keeps following delayed layout growth while the session is still working', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let trackHeight = 1200;

    mockTrackRects(() => trackHeight);

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setStateRecord('sessionStatus', { 'session-1': { type: 'busy' } });
    flushSolid();
    replaceMessages(promptAndResponse('Explain the result', 'Committed response'));
    flushSolid();
    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    const scrollTop = { value: 0 };
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
    backScrollTop(list!, scrollTop);

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    trackHeight = 1800;
    scrollHeightValue = 1800;
    animationFrames.flush();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1400);
    animationFrames.restore();
    flushSolid();
  });

  it('keeps following deferred final layout after loading completes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let trackHeight = 1200;

    mockTrackRects(() => trackHeight);

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(promptAndResponse('Explain the result', 'Final response'));
    flushSolid();
    startLoading(1);
    flushSolid();
    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    const scrollTop = { value: 0 };
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
    backScrollTop(list!, scrollTop);

    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);
    animationFrames.flush();
    flushSolid();
    expect(scrollTop.value).toBe(800);

    stopLoading();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);

    trackHeight = 1800;
    scrollHeightValue = 1800;
    animationFrames.flush();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1400);
    animationFrames.restore();
    flushSolid();
  });

  it('synchronizes a browser bottom clamp when grouped activity shrinks during follow', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const resizeCallbacks = captureResizeObserverCallbacks();
    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };
    let scrollHeightValue = 5000;
    let trackHeight = 5000;

    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      if (element.dataset.msgId?.startsWith('assistant-')) {
        const index = Number(element.dataset.msgId.replace('assistant-', ''));
        return new DOMRect(0, index * 100 - scrollTop.value, 500, 100);
      }
      return new DOMRect(0, 0, 500, 400);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 49
              ? [toolPart('tool-49', messageId)]
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    flushSolid();
    list = mountList();
    defineLayoutMetrics(list, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    expect(scrollTop.value).toBe(4600);
    for (const callback of resizeCallbacks) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callback([fixture<ResizeObserverEntry>({ target: list })], {} as ResizeObserver);
    }
    animationFrames.flush();
    flushSolid();

    trackHeight = 5500;
    scrollHeightValue = 5500;
    requestMessageListScrollToBottom();
    await Promise.resolve();
    flushSolid();
    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(5100);

    trackHeight = 1000;
    scrollHeightValue = 1000;
    // Chrome clamps to the new bottom during layout, before it necessarily dispatches scroll.
    scrollTop.value = 600;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushFrame(animationFrames);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('[data-msg-id]')?.getAttribute('data-msg-id')).toBe(
      'assistant-0'
    );
    animationFrames.restore();
    flushSolid();
  });

  it('does not auto-scroll again when the track bounces back to an already-followed height', async () => {
    const { animationFrames, resizeCallbacks, list, scrollTop, assignedScrollTops, layout } =
      mountFollowedTurn();
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    layout.trackHeight = 1700;
    layout.scrollHeight = 1700;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();
    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1300);

    const assignmentCountAfterGrowth = assignedScrollTops.length;

    layout.trackHeight = 1688;
    layout.scrollHeight = 1688;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();
    expect(assignedScrollTops).toHaveLength(assignmentCountAfterGrowth);

    layout.trackHeight = 1700;
    layout.scrollHeight = 1700;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterGrowth);
    expect(scrollTop.value).toBe(1300);
    animationFrames.restore();
    flushSolid();
  });

  it('keeps following when non-scroll pointer input precedes a layout clamp', async () => {
    const { animationFrames, resizeCallbacks, list, scrollTop, layout } = mountFollowedTurn({
      clientWidth: 500,
      offsetWidth: 500,
    });

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    layout.scrollHeight = 400;
    list?.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, clientX: 495 }));
    flushSolid();
    layout.scrollHeight = 1200;
    list?.firstElementChild?.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, bubbles: true, clientX: 495 })
    );
    flushSolid();
    // The browser can clamp scrollTop while content briefly shrinks, then deliver the scroll
    // event only after the old bottom target has returned.
    scrollTop.value = 760;
    list?.dispatchEvent(new Event('scroll'));
    flushSolid();

    layout.trackHeight = 1400;
    layout.scrollHeight = 1400;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1000);
    animationFrames.restore();
    flushSolid();
  });

  it('yields bottom follow before a delayed in-list Shift+Space scroll event', async () => {
    const { animationFrames, resizeCallbacks, list, scrollTop, layout } = mountFollowedTurn();

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    const externalButton = document.createElement('button');
    container?.appendChild(externalButton);
    externalButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    flushSolid();
    scrollTop.value = 500;
    list?.dispatchEvent(new Event('scroll'));
    flushSolid();

    layout.trackHeight = 1400;
    layout.scrollHeight = 1400;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1000);

    list?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true }));
    flushSolid();
    const keyboardOwnedTop = scrollTop.value;

    layout.trackHeight = 1600;
    layout.scrollHeight = 1600;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();

    expect(scrollTop.value).toBe(keyboardOwnedTop);
    list?.dispatchEvent(new Event('scroll'));
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(keyboardOwnedTop);
    animationFrames.restore();
    flushSolid();
  });

  it.each([
    { name: 'classic', clientWidth: 484 },
    { name: 'overlay', clientWidth: 500 },
  ])('stops following after $name scrollbar pointer-originated upward scrolling', async (args) => {
    const { animationFrames, resizeCallbacks, list, scrollTop, layout } = mountFollowedTurn({
      clientWidth: args.clientWidth,
      offsetWidth: 500,
    });

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    list?.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, clientX: 495 }));
    flushSolid();
    scrollTop.value = 500;
    list?.dispatchEvent(new Event('scroll'));
    flushSolid();

    layout.trackHeight = 1400;
    layout.scrollHeight = 1400;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();

    expect(scrollTop.value).toBe(500);
    animationFrames.restore();
    flushSolid();
  });

  it('resumes after nested diff input without outer movement but not after diff keyboard scrolling', async () => {
    const { animationFrames, resizeCallbacks, list, scrollTop, layout } = mountFollowedTurn();

    const diffViewport = document.createElement('div');
    diffViewport.className = 'diff-view-lines';
    diffViewport.tabIndex = 0;
    diffViewport.style.overflowY = 'auto';
    defineLayoutMetrics(diffViewport, { clientHeight: 100, scrollHeight: 400 });
    diffViewport.scrollTop = 120;
    list?.appendChild(diffViewport);
    const externalButton = document.createElement('button');
    container?.appendChild(externalButton);

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    diffViewport.focus();
    flushSolid();
    diffViewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    flushSolid();
    diffViewport.scrollTop = 0;
    externalButton.focus();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);

    layout.trackHeight = 1400;
    layout.scrollHeight = 1400;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();
    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(1000);

    diffViewport.focus();
    flushSolid();
    diffViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    flushSolid();
    scrollTop.value = 700;
    list?.dispatchEvent(new Event('scroll'));
    flushSolid();
    externalButton.focus();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    layout.trackHeight = 1600;
    layout.scrollHeight = 1600;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();

    expect(scrollTop.value).toBe(700);
    animationFrames.restore();
    flushSolid();
  });

  it('does not rewrite scrollTop when resize leaves the list already at bottom', async () => {
    const { animationFrames, resizeCallbacks, scrollTop, assignedScrollTops, layout } =
      mountFollowedTurn();
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    const assignmentCountAfterInitialScroll = assignedScrollTops.length;
    layout.trackHeight = 1700;
    layout.scrollHeight = 1700;
    scrollTop.value = 1300;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterInitialScroll);
    expect(scrollTop.value).toBe(1300);
    animationFrames.restore();
    flushSolid();
  });

  it('does not snap back to bottom after a small upward scroll near the threshold', async () => {
    const { animationFrames, resizeCallbacks, list, scrollTop, assignedScrollTops, layout } =
      mountFollowedTurn();
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    flushSolid();
    scrollTop.value = 760;
    list?.dispatchEvent(new Event('scroll'));
    flushFrame(animationFrames);

    const assignmentCountAfterUserScroll = assignedScrollTops.length;

    layout.trackHeight = 1240;
    layout.scrollHeight = 1240;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterUserScroll);
    expect(scrollTop.value).toBe(760);
    animationFrames.restore();
    flushSolid();
  });

  it('does not re-pin to bottom after loading settles when the user moved slightly upward', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(promptAndResponse('Prompt 1', 'Initial response'));
    flushSolid();
    startLoading(1);
    flushSolid();

    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    const scrollTop = { value: 0 };
    const assignedScrollTops: number[] = [];
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => 1200 });
    backScrollTop(list!, scrollTop, (value) => assignedScrollTops.push(value));

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    flushSolid();
    scrollTop.value = 760;
    list?.dispatchEvent(new Event('scroll'));
    flushFrame(animationFrames);
    const assignmentCountAfterUserScroll = assignedScrollTops.length;

    stopLoading();
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterUserScroll);
    expect(scrollTop.value).toBe(760);
    animationFrames.restore();
    flushSolid();
  });

  it('keeps auto-scroll enabled when the bottom target shifts before a near-bottom scroll event', async () => {
    const { animationFrames, resizeCallbacks, list, scrollTop, assignedScrollTops, layout } =
      mountFollowedTurn();
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    layout.scrollHeight = 1240;
    scrollTop.value = 800;
    list?.dispatchEvent(new Event('scroll'));
    flushFrame(animationFrames);

    layout.trackHeight = 1240;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(assignedScrollTops.at(-1)).toBe(840);
    expect(scrollTop.value).toBe(840);
    animationFrames.restore();
    flushSolid();
  });

  it('releases the send-triggered follow lock after bottom scroll stabilizes', async () => {
    const { animationFrames, resizeCallbacks, list, scrollTop, assignedScrollTops, layout } =
      mountFollowedTurn();
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    flushSolid();
    scrollTop.value = 400;
    list?.dispatchEvent(new Event('scroll'));
    flushFrame(animationFrames);

    requestMessageListScrollToBottom();
    await Promise.resolve();
    flushFrame(animationFrames);
    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(800);

    animationFrames.flush();
    flushFrame(animationFrames);
    animationFrames.flush();
    flushSolid();

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    flushSolid();
    scrollTop.value = 760;
    list?.dispatchEvent(new Event('scroll'));
    flushFrame(animationFrames);

    layout.trackHeight = 1240;
    layout.scrollHeight = 1240;
    notifyResizeObservers(resizeCallbacks);
    animationFrames.flush();
    flushSolid();

    expect(assignedScrollTops.at(-1)).toBe(800);
    expect(scrollTop.value).toBe(760);
    animationFrames.restore();
    flushSolid();
  });

  it.each(['downward wheel', 'held scrollbar', 'scrollbar held before append'] as const)(
    'respects %s ownership during the measured append transition',
    async (input) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      const baseMessages = assistantRows(50);
      let list: HTMLDivElement | null = null;
      const scrollTop = { value: 0 };
      let scrollHeightValue = 5000;
      mockElementRects((element) => {
        if (element === list || element.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (element.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, scrollHeightValue);
        }
        if (element.dataset.msgId) {
          const index =
            element.dataset.msgId === 'assistant-appended'
              ? 50
              : Number(element.dataset.msgId.replace('assistant-', ''));
          const height = index === 50 ? 200 : 100;
          return new DOMRect(0, index * 100 - scrollTop.value, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      });
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(baseMessages);
      flushSolid();

      list = mountList();
      defineLayoutMetrics(
        list,
        { clientHeight: 400, clientWidth: 500, offsetWidth: 500 },
        { scrollHeight: () => scrollHeightValue }
      );
      backScrollTop(list, scrollTop);
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushFrame(animationFrames);
      }
      expect(scrollTop.value).toBe(4600);

      if (input === 'scrollbar held before append') {
        list.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 495 })
        );
        flushSolid();
      }
      flushSolid();
      scrollHeightValue = 5200;
      replaceMessages([
        ...baseMessages,
        {
          info: assistantMessage('assistant-appended'),
          parts: [
            {
              ...textPart('text-appended', 'Appended response'),
              messageID: 'assistant-appended',
            },
          ],
        },
      ]);
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      animationFrames.flush(30);
      flushSolid();

      if (input !== 'downward wheel') {
        if (input === 'held scrollbar') {
          list.dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 495 })
          );
          flushSolid();
        } else {
          expect(scrollTop.value).toBe(4600);
        }
        flushSolid();
        const grabbedTop = scrollTop.value;
        animationFrames.flush(60);
        flushSolid();
        expect(scrollTop.value).toBe(grabbedTop);
        scrollTop.value -= 100;
        const userOwnedTop = scrollTop.value;
        list.dispatchEvent(new Event('scroll'));
        flushSolid();
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        flushSolid();
        animationFrames.flush(90);
        flushSolid();
        expect(scrollTop.value).toBe(userOwnedTop);
      } else {
        list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
        flushSolid();
        scrollTop.value += 100;
        const userOwnedTop = scrollTop.value;
        list.dispatchEvent(new Event('scroll'));
        flushSolid();
        animationFrames.flush(60);
        flushSolid();
        expect(scrollTop.value).toBeGreaterThanOrEqual(userOwnedTop);
      }
      flushSolid();
      animationFrames.restore();
      flushSolid();
    }
  );

  it('keeps following new messages after an explicit scroll request from a recent wheel scroll', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    let trackHeight = 1200;

    mockTrackRects(() => trackHeight);

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(promptAndResponse('Prompt 1', 'Initial response'));
    flushSolid();

    mountList();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    const scrollTop = { value: 0 };
    const assignedScrollTops: number[] = [];
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
    backScrollTop(list!, scrollTop, (value) => assignedScrollTops.push(value));

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
    flushSolid();
    scrollTop.value = 400;
    list?.dispatchEvent(new Event('scroll'));
    flushSolid();

    requestMessageListScrollToBottom();
    await Promise.resolve();
    flushFrame(animationFrames);
    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(scrollTop.value).toBe(800);

    animationFrames.flush();
    flushFrame(animationFrames);

    trackHeight = 1600;
    scrollHeightValue = 1600;
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Follow-up response')] },
    ]);
    flushSolid();
    await Promise.resolve();
    flushFrame(animationFrames);

    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(assignedScrollTops.at(-1)).toBe(1200);
    expect(scrollTop.value).toBe(1200);
    animationFrames.restore();
    flushSolid();
  });

  it('re-attaches to bottom again on the next explicit scroll request', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const resizeCallbacks = captureResizeObserverCallbacks();
    const trackHeight = 1200;
    mockTrackRects(() => trackHeight);

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(promptAndResponse('Prompt 1', 'Initial response'));
    flushSolid();

    mountList();
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    const scrollHeightValue = 1200;
    const scrollTop = { value: 0 };
    const assignedScrollTops: number[] = [];
    defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
    backScrollTop(list!, scrollTop, (value) => assignedScrollTops.push(value));

    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    requestMessageListScrollToBottom();
    await Promise.resolve();
    flushFrame(animationFrames);
    expect(scrollTop.value).toBe(800);

    animationFrames.flush();
    flushFrame(animationFrames);
    animationFrames.flush();
    flushSolid();

    scrollTop.value = 760;
    list?.dispatchEvent(new Event('scroll'));
    flushFrame(animationFrames);

    const assignmentCountAfterNearBottomScroll = assignedScrollTops.length;

    requestMessageListScrollToBottom();
    await Promise.resolve();
    flushSolid();
    expect(scrollTop.value).toBe(800);
    settleBottomFollow(animationFrames, list!);
    flushSolid();
    expect(assignedScrollTops.length).toBeGreaterThan(assignmentCountAfterNearBottomScroll);
    expect(assignedScrollTops.at(-1)).toBe(800);
    expect(scrollTop.value).toBe(800);
    animationFrames.restore();
    flushSolid();
  });

  it('reacts to trailing permission growth when jump-to-latest crosses its threshold', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const observers = installTrackedResizeObservers();

    let list: HTMLDivElement | null = null;
    const scrollTop = { value: 0 };
    let trailingHeight = 0;
    const messageHeight = 100;
    const messageTrackHeight = 50 * messageHeight;
    mockElementRects((element) => {
      if (element === list || element.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (element.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, messageTrackHeight + trailingHeight);
      }
      if (element.dataset.msgId?.startsWith('assistant-')) {
        const index = Number(element.dataset.msgId.replace('assistant-', ''));
        return new DOMRect(0, index * messageHeight - scrollTop.value, 500, messageHeight);
      }
      return new DOMRect(0, 0, 500, 40);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(assistantRows(50));
    flushSolid();
    list = mountList();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    defineLayoutMetrics(
      list,
      { clientHeight: 400 },
      { scrollHeight: () => messageTrackHeight + trailingHeight }
    );
    backScrollTop(list, scrollTop);

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushFrame(animationFrames);
    }
    await measureTranscriptRows(list, animationFrames);
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    flushSolid();
    scrollTop.value = messageTrackHeight - list.clientHeight - 220;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.jump-to-latest-button')).toBeNull();

    trailingHeight = 100;
    setState(
      storePath('permissions', [
        {
          id: 'permission-1',
          type: 'bash',
          sessionID: 'session-1',
          messageID: '',
          title: 'Allow bash',
          metadata: {},
          time: { created: 1 },
        },
      ])
    );
    flushSolid();
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(list!) && observer.targets.has(track)
    );
    expect(layoutObserver).toBeDefined();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback(
      [fixture<ResizeObserverEntry>({ target: track })],
      fixture<ResizeObserver>(layoutObserver)
    );
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.jump-to-latest-button')).toBeInstanceOf(HTMLButtonElement);
    animationFrames.restore();
    flushSolid();
  });

  it.each(['idle', 'busy'] as const)(
    'shows the jump-to-latest button after scrolling away and jumps instantly on click while %s',
    async (status) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      const trackHeight = 1200;

      mockTrackRects(() => trackHeight);

      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(promptAndResponse('Prompt 1', 'Initial response'));
      flushSolid();

      mountList();

      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
      expect(list).toBeInstanceOf(HTMLDivElement);

      const scrollHeightValue = 1200;
      const scrollTop = { value: 0 };
      defineLayoutMetrics(list!, { clientHeight: 400 }, { scrollHeight: () => scrollHeightValue });
      backScrollTop(list!, scrollTop);

      await Promise.resolve();
      flushFrame(animationFrames);
      expect(scrollTop.value).toBe(800);
      expect(container?.querySelector('.jump-to-latest-button')).toBeNull();
      for (let frame = 0; frame < 20; frame += 1) animationFrames.flush();

      list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      flushSolid();
      scrollTop.value = 200;
      list?.dispatchEvent(new Event('scroll'));
      flushSolid();
      await Promise.resolve();
      flushSolid();

      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      const button = container?.querySelector('.jump-to-latest-button') as HTMLButtonElement | null;
      expect(button).toBeInstanceOf(HTMLButtonElement);
      const icon = button?.querySelector<HTMLElement>('.ui-icon');
      expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('14px');
      expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(navArrowDownIcon));

      setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
      flushSolid();
      expect(button?.querySelector('.ui-icon')).toBeNull();
      expect(button?.querySelectorAll('.jump-to-latest-activity > span')).toHaveLength(3);

      setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
      flushSolid();
      expect(button?.querySelector('.jump-to-latest-activity')).toBeNull();
      expect(button?.querySelector('.ui-icon')).toBeInstanceOf(HTMLElement);

      setExpandedDiffOverlay(testDiffOverlayOwner, true);
      flushSolid();
      expect(container?.querySelector('.jump-to-latest-button')).toBeNull();

      setExpandedDiffOverlay(testDiffOverlayOwner, false);
      flushSolid();
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      const restoredButton = container?.querySelector(
        '.jump-to-latest-button'
      ) as HTMLButtonElement | null;
      expect(restoredButton).toBeInstanceOf(HTMLButtonElement);

      setState(storePath('sessionStatus', 'session-1', { type: status }));
      flushSolid();
      restoredButton?.click();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(scrollTop.value).toBe(800);
      expect(container?.querySelector('.jump-to-latest-button')).toBeNull();
      animationFrames.restore();
      flushSolid();
    }
  );
});

/**
 * Mounts a 1200 px transcript in a 400 px scrollport and detaches 10 px above its bottom with
 * an upward wheel. Unlike `backScrollTop`, assignments and resizes clamp eagerly to the current
 * range, as browser layout does. `growScrollport` grows the scrollport like a shrinking composer.
 */
async function mountDetachedNearBottom(
  options: {
    messages?: MessageEntry[];
    contentHeight?: number;
    beforeMount?: () => void;
  } = {}
) {
  const animationFrames = installQueuedAnimationFrameMocks();
  flushSolid();
  const observers = installTrackedResizeObservers();
  const layout = {
    viewportHeight: 400,
    contentHeight: options.contentHeight ?? 1200,
    trackWidth: 485,
  };
  const reserveHeight = () =>
    Number.parseFloat(
      container?.querySelector<HTMLElement>('.append-scroll-bottom-reserve')?.style.height ?? '0'
    );
  const scrollHeight = () =>
    Math.max(layout.viewportHeight, layout.contentHeight + reserveHeight());
  mockElementRects((element) =>
    element.classList.contains('interactive-list-track')
      ? new DOMRect(0, 0, layout.trackWidth, layout.contentHeight + reserveHeight())
      : new DOMRect(0, 0, 500, layout.viewportHeight)
  );
  setState(storePath('activeSessionId', 'session-1'));
  options.beforeMount?.();
  replaceMessages(options.messages ?? promptAndResponse('Prompt', 'Response'));
  flushSolid();
  const list = mountList();
  const track = list.querySelector<HTMLElement>('.interactive-list-track')!;
  const assignedScrollTops: number[] = [];
  let scrollTop = 0;
  const clamp = () => {
    scrollTop = Math.min(scrollTop, Math.max(0, scrollHeight() - layout.viewportHeight));
  };
  defineLayoutMetrics(
    list,
    { clientWidth: 485, offsetWidth: 500 },
    { clientHeight: () => layout.viewportHeight, scrollHeight }
  );
  Object.defineProperty(list, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = Math.max(0, next);
      clamp();
      assignedScrollTops.push(scrollTop);
    },
  });
  const notify = (targets: Element[]) => {
    for (const observer of observers) {
      const observed = targets.filter((target) => observer.targets.has(target));
      if (observed.length === 0) continue;
      observer.callback(
        observed.map((target) => fixture<ResizeObserverEntry>({ target })),
        fixture<ResizeObserver>({})
      );
    }
  };
  for (let frame = 0; frame < 4; frame += 1) {
    await Promise.resolve();
    flushFrame(animationFrames);
  }
  notify([list, track]);
  settleBottomFollow(animationFrames, list);
  flushSolid();
  const bottom = layout.contentHeight - layout.viewportHeight;
  expect(list.scrollTop).toBe(bottom);

  list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -10 }));
  flushSolid();
  if (scrollTop > bottom - 10) scrollTop = bottom - 10;
  list.dispatchEvent(new Event('scroll'));
  flushSolid();
  for (let frame = 0; frame < 4; frame += 1) flushFrame(animationFrames);
  expect(list.scrollTop).toBe(bottom - 10);
  assignedScrollTops.length = 0;

  return {
    animationFrames,
    list,
    track,
    layout,
    reserveHeight,
    assignedScrollTops,
    notify,
    /** Grows the scrollport like a shrinking composer; layout clamps before the observer runs. */
    growScrollport(growth: number, targets: Element[] = [list]) {
      layout.viewportHeight += growth;
      clamp();
      notify(targets);
      flushSolid();
    },
  };
}

describe('MessageList detached composer shrink', () => {
  /** Grows the scrollport by 28 px and asserts the detached helper left the browser clamp alone. */
  function expectClampKept(harness: Awaited<ReturnType<typeof mountDetachedNearBottom>>) {
    const before = harness.list.scrollTop;
    const reserveBefore = harness.reserveHeight();
    harness.growScrollport(28);
    const clamped = harness.list.scrollTop;
    expect(clamped).toBeLessThan(before);
    expect(harness.assignedScrollTops).not.toContain(before);
    expect(harness.reserveHeight()).toBeLessThanOrEqual(reserveBefore);
  }

  it('restores a detached reader clamped by scrollport growth', async () => {
    const harness = await mountDetachedNearBottom();
    harness.growScrollport(28);
    expect(harness.reserveHeight()).toBe(18);
    expect(harness.list.scrollTop).toBe(790);
    harness.animationFrames.restore();
  });

  it('yields a combined width and height resize to width reflow', async () => {
    const harness = await mountDetachedNearBottom();
    harness.layout.trackWidth = 465;
    const before = harness.list.scrollTop;
    harness.growScrollport(28, [harness.list, harness.track]);
    expect(harness.assignedScrollTops).not.toContain(before);
    expect(harness.reserveHeight()).toBe(0);
    harness.animationFrames.restore();
  });

  it('yields to a held scrollbar thumb', async () => {
    const harness = await mountDetachedNearBottom();
    harness.list.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 495 })
    );
    flushSolid();
    expect(harness.list.hasAttribute('data-pointer-scroll-owned')).toBe(true);
    // A small drag is observed, so the held thumb rather than unresolved input owns the range.
    harness.list.scrollTop -= 2;
    harness.list.dispatchEvent(new Event('scroll'));
    flushSolid();
    harness.assignedScrollTops.length = 0;
    const before = harness.list.scrollTop;
    harness.growScrollport(28);
    // The held range may be preserved, but the old position is not written back under the thumb.
    expect(harness.assignedScrollTops).not.toContain(before);
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    flushSolid();
    harness.animationFrames.restore();
  });

  it('yields to inline editing', async () => {
    const harness = await mountDetachedNearBottom();
    startEditingMessage('user-1', 'session-1', 'Prompt');
    flushSolid();
    onTestFinished(() => {
      resetMessageEditState();
      flushSolid();
    });
    expectClampKept(harness);
    harness.animationFrames.restore();
  });

  it('yields to focused diff content', async () => {
    const harness = await mountDetachedNearBottom();
    const diff = document.createElement('div');
    diff.className = 'diff-view-lines';
    diff.tabIndex = 0;
    harness.track.append(diff);
    onTestFinished(() => diff.remove());
    diff.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    flushSolid();
    expectClampKept(harness);
    harness.animationFrames.restore();
  });

  it('yields to a disclosure expansion anchor', async () => {
    const harness = await mountDetachedNearBottom({
      messages: [
        { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt')] },
        {
          info: assistantMessage('assistant-1'),
          parts: [
            {
              ...toolPart('tool-1', 'assistant-1'),
              state: {
                status: 'completed',
                input: { command: 'pwd' },
                output: '/workspace',
                title: 'pwd',
                metadata: {},
                time: { start: 1, end: 2 },
              },
            },
            { ...textPart('text-2', 'Response'), messageID: 'assistant-1' },
          ],
        },
      ],
    });
    const summary = harness.list.querySelector<HTMLElement>(
      '.assistant-activity-summary[aria-expanded="false"]'
    );
    expect(summary).toBeInstanceOf(HTMLElement);
    // A keyboard activation (detail 0) records the expansion anchor.
    summary!.click();
    flushSolid();
    expectClampKept(harness);
    harness.animationFrames.restore();
  });

  it('yields to sticky navigation from session search', async () => {
    const harness = await mountDetachedNearBottom();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })
    );
    flushSolid();
    const input = container!.querySelector<HTMLInputElement>('.session-search input')!;
    input.value = 'Prompt';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(130);
    flushSolid();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    flushSolid();
    await Promise.resolve();
    await Promise.resolve();
    flushSolid();
    harness.assignedScrollTops.length = 0;
    expectClampKept(harness);
    harness.animationFrames.restore();
  });

  it('yields to a pending older-history anchor', async () => {
    let restoreRuntime: (() => void) | undefined;
    const harness = await mountDetachedNearBottom({
      // A barely overflowing transcript puts the detached reader at the history threshold.
      contentHeight: 420,
      beforeMount: () => {
        setSessionHistoryCursor('session-1', 'cursor-older');
        restoreRuntime = installOpenCodeRuntime(
          fixture<OpenCodeRuntime>({ loadOlderSessionHistoryPage: () => new Promise(() => {}) })
        );
      },
    });
    onTestFinished(() => restoreRuntime?.());
    // The detaching wheel near the top starts the page request after its own scroll event.
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    flushSolid();
    harness.assignedScrollTops.length = 0;
    expectClampKept(harness);
    harness.animationFrames.restore();
  });

  it('yields to structural reconciliation in the same frame', async () => {
    const harness = await mountDetachedNearBottom({ messages: conversationTurns(2) });
    replaceMessages(conversationTurns(2).filter((entry) => entry.info.id !== 'assistant-1'));
    flushSolid();
    harness.assignedScrollTops.length = 0;
    expectClampKept(harness);
    harness.animationFrames.restore();
  });
});
