import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, vi } from 'vitest';
import { flush as flushSolid, reconcile, untrack } from 'solid-js';
import {
  setExpandThinking,
  setState,
  setShowFileDiffs,
  setShowEmptyStateHistogram,
  setShowThinkingPreference,
  requestMessageListScrollToBottom,
  state,
  stopLoading,
} from '../lib/state';
import type { AppState } from '../lib/state';
import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  Session,
  ToolPart,
  UserMessage,
} from '../types';
import { resetMessageWindowState } from '../lib/message-window';
import { resetMessageEditState } from '../lib/message-edit-state';
import { setExpandedDiffOverlay } from '../lib/diff-overlay-state';
import { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';

const testDiffOverlayOwner = Symbol();

export interface MessageListTestEnvironmentState {
  getContainer(): HTMLDivElement | null;
  setContainer(element: HTMLDivElement | null): void;
  getCleanup(): (() => void) | undefined;
  setCleanup(cleanup: (() => void) | undefined): void;
}

export function installMessageListTestEnvironment(
  environment: MessageListTestEnvironmentState
): void {
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
  let originalIntersectionObserver: typeof globalThis.IntersectionObserver | undefined;
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
  let originalWindowRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalWindowCancelAnimationFrame: typeof window.cancelAnimationFrame;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

  beforeEach(() => {
    const nextContainer = document.createElement('div');
    environment.setContainer(nextContainer);
    document.body.appendChild(nextContainer);
    originalResizeObserver = globalThis.ResizeObserver;
    originalIntersectionObserver = globalThis.IntersectionObserver;
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    originalWindowRequestAnimationFrame = window.requestAnimationFrame;
    originalWindowCancelAnimationFrame = window.cancelAnimationFrame;
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    globalThis.ResizeObserver = class ResizeObserver implements globalThis.ResizeObserver {
      readonly box = 'content-box';
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    globalThis.requestAnimationFrame = vi.fn().mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    globalThis.cancelAnimationFrame = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    environment.getCleanup()?.();
    environment.setCleanup(undefined);
    await Promise.resolve();
    vi.useRealTimers();
    environment.getContainer()?.remove();
    environment.setContainer(null);
    setState(storePath('messages', []));
    setState(storePath('sessions', []));
    setState(storePath('permissions', []));
    setState(storePath('questions', []));
    setState(storePath('activeSessionId', null));
    setState(storePath('messagesLoading', false));
    setState(storePath('pendingSessionSelectionId', null));
    setState(storePath('providers', []));
    setState(storePath('agents', []));
    setState(storePath('allAgents', []));
    setState(storePath('queuedMessages', []));
    setState(storePath('streamingPartId', null));
    setState(storePath('streamingText', ''));
    resetMessageWindowState();
    resetToolCallExpansionState();
    setStateRecord('sessionSelectedAgents', {});
    setStateRecord('sessionStatus', {});
    setStateRecord('sessionAutoPermissionCounts', {});
    setStateRecord('skippedPlanSessions', {});
    setShowFileDiffs(false);
    setShowEmptyStateHistogram(false);
    setExpandThinking(false);
    setShowThinkingPreference(true);
    stopLoading();
    resetMessageEditState();
    setExpandedDiffOverlay(testDiffOverlayOwner, false);
    restoreProperty(globalThis, 'ResizeObserver', originalResizeObserver);
    restoreProperty(globalThis, 'IntersectionObserver', originalIntersectionObserver);
    restoreProperty(globalThis, 'requestAnimationFrame', originalRequestAnimationFrame);
    restoreProperty(globalThis, 'cancelAnimationFrame', originalCancelAnimationFrame);
    restoreProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    vi.restoreAllMocks();
    // Queued frame fixtures replace window methods too, and assertions can skip restore().
    window.requestAnimationFrame = originalWindowRequestAnimationFrame;
    window.cancelAnimationFrame = originalWindowCancelAnimationFrame;
  });
}

export { testDiffOverlayOwner };

function restoreProperty<T extends typeof globalThis | HTMLElement, K extends keyof T>(
  target: T,
  key: K,
  original: T[K] | undefined
): void {
  if (original) target[key] = original;
  else Object.defineProperty(target, key, { configurable: true, value: undefined, writable: true });
}

type RecordStateKey =
  | 'sessionAutoPermissionCounts'
  | 'sessionSelectedAgents'
  | 'sessionSelectedModels'
  | 'sessionStatus'
  | 'skippedPlanSessions';

/** Replaces one keyed state record the way production setters do, reconciling in place. */
export function setStateRecord<K extends RecordStateKey>(key: K, incoming: AppState[K]): void {
  setState((draft) => {
    const current = draft[key];
    if (current === null || current === undefined) draft[key] = incoming;
    else reconcile(incoming)(current);
  });
}

export function installQueuedAnimationFrameMocks() {
  const originalGlobalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalGlobalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalWindowRequestAnimationFrame = window.requestAnimationFrame;
  const originalWindowCancelAnimationFrame = window.cancelAnimationFrame;
  const pendingAnimationFrameCallbacks: Array<FrameRequestCallback | null> = [];
  const requestAnimationFrameMock = vi.fn().mockImplementation((cb: FrameRequestCallback) => {
    pendingAnimationFrameCallbacks.push(cb);
    return pendingAnimationFrameCallbacks.length;
  });
  const cancelAnimationFrameMock = vi.fn().mockImplementation((id: number) => {
    if (id <= 0) return;
    pendingAnimationFrameCallbacks[id - 1] = null;
  });

  const install = (
    target: typeof globalThis | Window,
    request: typeof requestAnimationFrame,
    cancel: typeof cancelAnimationFrame
  ) => {
    Object.defineProperty(target, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: request,
    });
    Object.defineProperty(target, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: cancel,
    });
  };
  install(globalThis, requestAnimationFrameMock, cancelAnimationFrameMock);
  install(window, requestAnimationFrameMock, cancelAnimationFrameMock);

  return {
    flush(now = 0) {
      const callbacks = pendingAnimationFrameCallbacks.splice(0);
      for (const callback of callbacks) callback?.(now);
    },
    restore() {
      install(globalThis, originalGlobalRequestAnimationFrame, originalGlobalCancelAnimationFrame);
      install(window, originalWindowRequestAnimationFrame, originalWindowCancelAnimationFrame);
    },
  };
}

type QueuedAnimationFrames = ReturnType<typeof installQueuedAnimationFrameMocks>;

/** Runs one queued animation frame with Solid flushed on both sides of it. */
export function flushFrame(animationFrames: Pick<QueuedAnimationFrames, 'flush'>): void {
  flushSolid();
  animationFrames.flush();
  flushSolid();
}

export function settleBottomFollow(
  animationFrames: ReturnType<typeof installQueuedAnimationFrameMocks>,
  list: HTMLElement
) {
  // Follow now eases over multiple frames. Keep exact destination assertions after settling.
  const startedAt = performance.now();
  for (let frame = 1; frame <= 120; frame += 1) {
    animationFrames.flush(startedAt + frame * 16);
    if (Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) < 0.01) return;
  }
}

export async function measureTranscriptRows(
  list: HTMLElement,
  animationFrames: ReturnType<typeof installQueuedAnimationFrameMocks>
) {
  // Geometry fixtures that use absolute row offsets need a measured history, not the cold
  // provisional prefix. Visit it through the normal scroll path before exercising reflow.
  list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
  const step = Math.max(100, list.clientHeight);
  const extent = Math.max(list.scrollHeight, state.messages.length * 160);
  for (let top = 0; top <= extent; top += step) {
    list.scrollTop = top;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
  }
  requestMessageListScrollToBottom();
  await Promise.resolve();
  settleBottomFollow(animationFrames, list);
  await Promise.resolve();
}

export interface TrackedResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly targets: Set<Element>;
}

/** Installs a ResizeObserver that records every instance with its currently observed targets. */
export function installTrackedResizeObservers(): TrackedResizeObserver[] {
  const observers: TrackedResizeObserver[] = [];
  class TestResizeObserver {
    readonly targets = new Set<Element>();

    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  // SAFETY: The fixture provides the unknown fields read by this statement.
  globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
  return observers;
}

/** Installs a ResizeObserver that only records the callback of every instance. */
export function captureResizeObserverCallbacks(): ResizeObserverCallback[] {
  const resizeCallbacks: ResizeObserverCallback[] = [];
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }

    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
  globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
  return resizeCallbacks;
}

/** Delivers one entry-less resize notification to every captured callback. */
export function notifyResizeObservers(resizeCallbacks: readonly ResizeObserverCallback[]): void {
  for (const callback of resizeCallbacks) {
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    callback([], {} as ResizeObserver);
  }
}

/** Replaces element geometry with a per-element rectangle resolver. */
export function mockElementRects(resolve: (element: HTMLElement) => DOMRect) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return resolve(this);
  });
}

/** Reports `trackHeight()` for the list track and a fixed viewport box for every other element. */
export function mockTrackRects(trackHeight: () => number, viewportHeight = 400) {
  return mockElementRects(
    (element) =>
      new DOMRect(
        0,
        0,
        500,
        element.classList.contains('interactive-list-track') ? trackHeight() : viewportHeight
      )
  );
}

type LayoutMetrics<T> = Partial<
  Record<'clientHeight' | 'clientWidth' | 'offsetWidth' | 'scrollHeight', T>
>;

/**
 * Overrides layout metrics that jsdom reports as zero: `fixed` entries become read-only
 * values and `live` entries become getters evaluated on every read.
 */
export function defineLayoutMetrics(
  element: Element,
  fixed: LayoutMetrics<number>,
  live: LayoutMetrics<() => number> = {}
): void {
  for (const [name, value] of Object.entries(fixed)) {
    Object.defineProperty(element, name, { configurable: true, value });
  }
  for (const [name, get] of Object.entries(live)) {
    Object.defineProperty(element, name, { configurable: true, get });
  }
}

/**
 * Backs `element.scrollTop` with a test-owned box, so tests can read every position the list
 * assigns and force browser-style scroll positions by writing `scrollTop.value`.
 * `onAssign` observes each assignment made through the element.
 */
export function backScrollTop(
  element: Element,
  scrollTop: { value: number },
  onAssign?: (value: number) => void
): void {
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop.value,
    set: (value: number) => {
      scrollTop.value = value;
      onAssign?.(value);
    },
  });
}

export function installControllableIntersectionObserver() {
  let callback: IntersectionObserverCallback | undefined;
  let observer: IntersectionObserver | undefined;

  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly scrollMargin = '0px';
    readonly thresholds = [0, 1];

    constructor(nextCallback: IntersectionObserverCallback) {
      callback = nextCallback;
      // oxlint-disable-next-line no-this-alias -- The harness must pass the exact observer instance back to its callback.
      observer = this;
    }

    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  globalThis.IntersectionObserver = TestIntersectionObserver;

  return {
    emit(
      entries: Array<Partial<IntersectionObserverEntry> & Pick<IntersectionObserverEntry, 'target'>>
    ) {
      if (!callback || !observer) throw new Error('IntersectionObserver was not created');
      const completeEntries = entries.map((partialEntry) => ({
        boundingClientRect: new DOMRectReadOnly(),
        intersectionRatio: 1,
        intersectionRect: new DOMRectReadOnly(),
        isIntersecting: true,
        rootBounds: null,
        time: 0,
        ...partialEntry,
      }));
      callback(completeEntries, observer);
    },
  };
}

export function textPart(
  id: string,
  text: string,
  options?: { ignored?: boolean; synthetic?: boolean }
): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text,
    ...options,
  };
}

export function filePart(id: string, filename: string): FilePart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime: 'image/png',
    filename,
    url: `https://example.test/${id}.png`,
  };
}

export function userMessage(id: string): UserMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-5.4' },
  };
}

export function assistantMessage(
  id: string,
  options?: {
    agent?: string;
    error?: AssistantMessage['error'];
    mode?: string;
    modelID?: string;
    parentID?: string;
    providerID?: string;
    sessionID?: string;
    time?: AssistantMessage['time'];
    tokens?: AssistantMessage['tokens'];
    variant?: string;
  }
): AssistantMessage {
  return {
    id,
    sessionID: options?.sessionID ?? 'session-1',
    role: 'assistant',
    time: options?.time ?? { created: 1, completed: 2 },
    parentID: options?.parentID ?? 'parent-1',
    modelID: options?.modelID ?? 'gpt-5.4',
    providerID: options?.providerID ?? 'openai',
    mode: options?.mode ?? 'default',
    agent: options?.agent,
    error: options?.error,
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: options?.tokens ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    variant: options?.variant,
  };
}

/** Builds `count` single-text assistant rows: `assistant-N` holding `text-N` ("Response N"). */
export function assistantRows(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const messageId = `assistant-${index}`;
    return {
      info: assistantMessage(messageId),
      parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
    };
  });
}

/** Builds one `user-1`/`assistant-1` turn with `text-1` and `text-2` parts. */
export function promptAndResponse(prompt: string, response: string) {
  return [
    { info: userMessage('user-1'), parts: [textPart('text-1', prompt)] },
    { info: assistantMessage('assistant-1'), parts: [textPart('text-2', response)] },
  ];
}

/** Builds numbered turns: `user-N` ("Prompt N") then `assistant-N` ("Response N"), parts `text-1..`. */
export function conversationTurns(count: number) {
  return Array.from({ length: count }, (_, index) => [
    {
      info: userMessage(`user-${index + 1}`),
      parts: [textPart(`text-${index * 2 + 1}`, `Prompt ${index + 1}`)],
    },
    {
      info: assistantMessage(`assistant-${index + 1}`),
      parts: [textPart(`text-${index * 2 + 2}`, `Response ${index + 1}`)],
    },
  ]).flat();
}

export function hasAssistantModelChangeBetween(previousId: string, currentId: string) {
  // Fake layout reads this during measurement; real DOM geometry never subscribes.
  return untrack(() => hasAssistantModelChangeBetweenNow(previousId, currentId));
}

function hasAssistantModelChangeBetweenNow(previousId: string, currentId: string) {
  const previous = state.messages.find((message) => message.info.id === previousId);
  const current = state.messages.find((message) => message.info.id === currentId);
  return (
    previous?.info.role === 'assistant' &&
    current?.info.role === 'assistant' &&
    (previous.info.providerID !== current.info.providerID ||
      previous.info.modelID !== current.info.modelID)
  );
}

export function session(id: string, options: Partial<Session> = {}): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/workspace',
    title: id,
    version: '1',
    time: { created: 1, updated: 1 },
    ...options,
  };
}

export function entry(info: Message) {
  const parts: Part[] = [];
  return { info, parts };
}

export function toolPart(id: string, messageID = 'message-1', callID = 'call-1'): ToolPart {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'tool',
    callID,
    tool: 'bash',
    state: {
      status: 'running',
      input: { command: 'pwd' },
      time: { start: 1 },
    },
  };
}

export function reasoningPart(id: string, text: string): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text,
    time: { start: 1 },
  };
}
