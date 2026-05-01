import {
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import {
  getSelectedAgentForSession,
  getPermissionGroupMembers,
  isSessionAwaitingInput,
  state,
  isLoading,
  isSkippedPlanSession,
  stopLoading,
  hasActiveQuestion,
  hasActivePermission,
  isSessionCompacting,
  loadingStartedAt,
  loadingLastActivityAt,
  messageListScrollRequestKey,
  getChildRunsByParentId,
  getActiveUsageLimitNotice,
  getSessionTreeRootId,
  getSessionTreeIds,
  messageStructureVersion,
  showStickyUserPrompt,
} from '../lib/state';
import { isAssistantMessage, sumAssistantTokens } from '../lib/message-metrics';
import type { AssistantMessage, Message, Part, Permission, QuestionRequest } from '../types';
import { type AssistantFileEditStackGroup } from './Message';
import { recheckSessionStatus } from '../hooks/useOpenCode';
import { modelSupportsReasoning } from '../lib/model-capabilities';
import { formatLabelWithProvider, formatVariantLabel } from '../lib/format';
import { getTrailingFileEventSignature } from '../lib/message-event-collapse';
import { shouldShowAssistantPartInline } from '../lib/part-utils';
import { PendingActionRows, StickyUserMessagePreviewCard } from './message-list/MessageListChrome';
import {
  getNextVisibleUserMessageTopMap,
  getStickyUserMessagePreview,
  isMessageHiddenBehindStickyPreview,
  shouldShowStickyUserMessagePreview,
  type StickyUserMessagePreview,
} from './message-list/sticky-preview';
import { hasVisibleBlockingStreamingPart } from './message-list/streaming';
import {
  buildVirtualMetrics,
  calculateVirtualRangeFromMetrics,
  getFirstVisibleMessageIndexFromVirtualMetrics,
  pruneMeasuredHeights,
  type VirtualMetrics,
} from './message-list/virtualization';
import {
  captureExpansionScrollAnchor,
  getDistanceFromBottom,
  performScrollToBottom,
  resolveAutoScrollOnUserScroll,
  restoreExpansionScrollAnchor as restoreExpansionScrollAnchorFromState,
  type ExpansionScrollAnchor,
} from './message-list/scrolling';
import { MessageRows, type AssistantDialogSummaryInfo } from './message-list/MessageRows';
import { VirtualizedContent } from './message-list/VirtualizedContent';

export {
  calculateVirtualRange,
  calculateVirtualRangeFromMetrics,
  getFirstVisibleMessageIndexFromVirtualMetrics,
  pruneMeasuredHeights,
} from './message-list/virtualization';

export {
  getNextVisibleUserMessageTopMap,
  getStickyUserMessagePreview,
  shouldShowStickyUserMessagePreview,
} from './message-list/sticky-preview';

function isPlanningAssistantMessage(info: AssistantMessage): boolean {
  return info.agent === 'plan' || getSelectedAgentForSession(info.sessionID) === 'plan';
}

function getLinkedToolCallKey(
  sessionId: string,
  messageId: string | null | undefined,
  callId: string | null | undefined
) {
  if (!messageId || !callId) return null;

  return `${sessionId}\u0000${messageId}\u0000${callId}`;
}

function getLinkedToolCallKeys(messages: Array<{ info: Message; parts: Part[] }>) {
  const keys = new Set<string>();

  for (const entry of messages) {
    const messageId = entry.info.id;
    const sessionId = entry.info.sessionID;
    for (const part of entry.parts) {
      if (
        part.type !== 'tool' ||
        part.messageID !== messageId ||
        !shouldShowAssistantPartInline(part)
      ) {
        continue;
      }
      const key = getLinkedToolCallKey(sessionId, messageId, part.callID);
      if (key) keys.add(key);
    }
  }

  return keys;
}

function hasLinkedToolCall(
  linkedToolCalls: ReadonlySet<string>,
  sessionId: string,
  messageId: string | null | undefined,
  callId: string | null | undefined
) {
  const key = getLinkedToolCallKey(sessionId, messageId, callId);
  if (!key) return false;

  return linkedToolCalls.has(key);
}

export function getStandalonePermissionPrompts(
  messages: Array<{ info: Message; parts: Part[] }>,
  permissions: Permission[],
  activeSessionId: string | null,
  linkedToolCalls = getLinkedToolCallKeys(messages)
) {
  if (!activeSessionId) return [];

  const rootId = getSessionTreeRootId(activeSessionId) || activeSessionId;
  const sessionIds = new Set(getSessionTreeIds(rootId));

  return permissions.filter(
    (permission) =>
      sessionIds.has(permission.sessionID) &&
      !getPermissionGroupMembers(permission).some((member) =>
        hasLinkedToolCall(linkedToolCalls, member.sessionID, member.messageID, member.callID)
      )
  );
}

export function getStandaloneQuestionPrompts(
  messages: Array<{ info: Message; parts: Part[] }>,
  questions: QuestionRequest[],
  activeSessionId: string | null,
  linkedToolCalls = getLinkedToolCallKeys(messages)
) {
  if (!activeSessionId) return [];

  const rootId = getSessionTreeRootId(activeSessionId) || activeSessionId;
  const sessionIds = new Set(getSessionTreeIds(rootId));

  return questions.filter(
    (question) =>
      sessionIds.has(question.sessionID) &&
      !hasLinkedToolCall(
        linkedToolCalls,
        question.sessionID,
        question.tool?.messageID,
        question.tool?.callID
      )
  );
}

function getRenderedMessages(
  messages: Array<{ info: Message; parts: Part[] }>,
  range: { start: number; end: number },
  shouldVirtualize: boolean
) {
  return shouldVirtualize ? messages.slice(range.start, range.end) : messages;
}

export function buildPlanImplementationPrompt(parts: Part[]) {
  void parts;
  return 'Implement the plan from your last response in the current workspace. Make the code changes instead of revising the plan.';
}

export function buildPlanDocumentContent(parts: Part[]) {
  return parts
    .filter(
      (part): part is Extract<Part, { type: 'text' }> =>
        part.type === 'text' && !part.synthetic && !part.ignored
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function getLatestPlanImplementationMessageId(
  messages: Array<{ info: Message }>
): string | null {
  const lastMessage = messages[messages.length - 1]?.info;
  if (
    !lastMessage ||
    !isAssistantMessage(lastMessage) ||
    !isPlanningAssistantMessage(lastMessage)
  ) {
    return null;
  }

  return lastMessage.id;
}

export function shouldShowPlanImplementationAction(args: {
  hasBuildAgent: boolean;
  info: Message;
  latestPlanImplementationMessageId: string | null;
}) {
  if (
    !args.hasBuildAgent ||
    !isAssistantMessage(args.info) ||
    !isPlanningAssistantMessage(args.info) ||
    !!args.info.error
  ) {
    return false;
  }
  if (args.info.id !== args.latestPlanImplementationMessageId) {
    return false;
  }

  const session = state.sessions.find((item) => item.id === args.info.sessionID);
  return !session || !isSkippedPlanSession(args.info.sessionID, session.time.updated);
}

const VIRTUALIZE_THRESHOLD = 50;

const STICKY_PREVIEW_DISPLAY_DEBOUNCE_MS = 90;
const EXPANSION_SCROLL_ANCHOR_WINDOW_MS = 250;

export function MessageList() {
  // oxlint-disable-next-line no-unassigned-vars
  let containerRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let trackRef: HTMLDivElement | undefined;
  const [autoScroll, setAutoScroll] = createSignal(true);
  const lastAssistantID = createMemo(() => {
    const msgs = state.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (isAssistantMessage(msgs[i].info)) return msgs[i].info.id;
    }
    return null;
  });
  let scrollTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let lastScrollAt = 0;
  let expectedScrollTop = -1;
  let ignoreScrollUntil = 0;
  let lastObservedScrollTop = 0;
  let pendingInitialScrollSessionId: string | null = null;
  let initialScrollRafId = 0;
  let previousStickyPreviewId: string | null = null;
  let previousStickyPreviewBounds: { top: number; bottom: number } | null = null;
  let pendingExpansionScrollAnchor: ExpansionScrollAnchor | null = null;
  let stickyPreviewDebounceTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let firstVisibleMessageObserver: IntersectionObserver | null = null;
  let measuredRowObserver: ResizeObserver | null = null;
  let measurementRafId = 0;
  let measurementScheduled = false;
  let pendingMeasurementAfterResize = false;
  let viewportStateRafId = 0;
  let viewportStateScheduled = false;
  let pendingScrollTop = 0;
  let pendingViewportHeight = 0;
  let stickyPreviewRafId = 0;
  let stickyPreviewViewportStateScheduled = false;
  let pendingStickyPreviewScrollTop = 0;
  let pendingStickyPreviewViewportHeight = 0;
  let lastScrollbarInset = -1;
  const SCROLL_INTERVAL_MS = 700;
  const INITIAL_SCROLL_MAX_FRAMES = 30;
  const INITIAL_SCROLL_STABLE_FRAMES = 3;
  const AUTO_SCROLL_THRESHOLD_PX = 60;
  const PROGRAMMATIC_SCROLL_WINDOW_MS = 200;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [measurementVersion, setMeasurementVersion] = createSignal(0);
  const [observedVisibleMessageVersion, setObservedVisibleMessageVersion] = createSignal(0);
  const [observedFirstVisibleMessageId, setObservedFirstVisibleMessageId] = createSignal<
    string | null
  >(null);
  const [stickyUserMessagePreview, setStickyUserMessagePreview] =
    createSignal<StickyUserMessagePreview | null>(null);
  const [stickyPreviewScrollTop, setStickyPreviewScrollTop] = createSignal(0);
  const [stickyPreviewViewportHeight, setStickyPreviewViewportHeight] = createSignal(0);
  const activeUsageLimit = createMemo(() => getActiveUsageLimitNotice(state.activeSessionId));
  const shouldShowStarterLogo = createMemo(() => {
    if (state.messages.length > 0) return false;

    const sessionId = state.activeSessionId;
    if (!sessionId) return true;

    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return false;
    if (state.queuedMessages.some((item) => item.sessionId === sessionId)) return false;
    if (isSessionAwaitingInput(sessionId)) return false;

    const statusType = state.sessionStatus[sessionId]?.type;
    if (statusType === 'busy' || statusType === 'retry') return false;

    return session.time.created === session.time.updated;
  });
  const observedVisibleMessageBounds = new Map<string, { top: number; bottom: number }>();

  const messages = createMemo(() => state.messages);
  const latestPlanImplementationMessageId = createMemo(() =>
    getLatestPlanImplementationMessageId(messages())
  );
  const visibleBlockingStreamingPart = createMemo(() =>
    hasVisibleBlockingStreamingPart(messages(), state.streamingPartId, state.streamingText)
  );
  const messageIndexById = createMemo(() => {
    messageStructureVersion();
    return untrack(() => {
      const result = new Map<string, number>();
      for (const [index, entry] of state.messages.entries()) {
        result.set(entry.info.id, index);
      }
      return result;
    });
  });

  function flushViewportState() {
    viewportStateScheduled = false;
    viewportStateRafId = 0;
    batch(() => {
      setScrollTop(pendingScrollTop);
      setViewportHeight(pendingViewportHeight);
    });
  }

  function scheduleViewportState(nextScrollTop: number, nextViewportHeight: number) {
    pendingScrollTop = nextScrollTop;
    pendingViewportHeight = nextViewportHeight;
    if (viewportStateScheduled) return;

    viewportStateScheduled = true;
    viewportStateRafId = requestAnimationFrame(flushViewportState);
  }

  function cancelScheduledViewportState() {
    viewportStateScheduled = false;
    if (!viewportStateRafId) return;
    cancelAnimationFrame(viewportStateRafId);
    viewportStateRafId = 0;
  }

  function recomputeObservedFirstVisibleMessageId() {
    if (!containerRef || shouldVirtualize()) {
      setObservedFirstVisibleMessageId(null);
      return;
    }

    const currentViewportHeight = containerRef.clientHeight;
    let nextMessageId: string | null = null;
    let nextTop = Number.POSITIVE_INFINITY;
    for (const [messageId, bounds] of observedVisibleMessageBounds) {
      if (bounds.bottom <= 0 || bounds.top >= currentViewportHeight) continue;
      if (bounds.top < nextTop) {
        nextTop = bounds.top;
        nextMessageId = messageId;
      }
    }
    setObservedFirstVisibleMessageId(nextMessageId);
  }

  function clearObservedVisibleMessages() {
    if (observedVisibleMessageBounds.size > 0) {
      setObservedVisibleMessageVersion((version) => version + 1);
    }
    observedVisibleMessageBounds.clear();
    setObservedFirstVisibleMessageId(null);
  }

  const nextVisibleUserMessageTopByMessageId = createMemo(() => {
    observedVisibleMessageVersion();
    messageStructureVersion();
    return untrack(() =>
      getNextVisibleUserMessageTopMap(state.messages, observedVisibleMessageBounds)
    );
  });

  function flushStickyPreviewViewportState() {
    stickyPreviewViewportStateScheduled = false;
    stickyPreviewRafId = 0;
    batch(() => {
      setStickyPreviewScrollTop(pendingStickyPreviewScrollTop);
      setStickyPreviewViewportHeight(pendingStickyPreviewViewportHeight);
    });
  }

  function scheduleStickyPreviewViewportState(nextScrollTop: number, nextViewportHeight: number) {
    pendingStickyPreviewScrollTop = nextScrollTop;
    pendingStickyPreviewViewportHeight = nextViewportHeight;
    if (stickyPreviewViewportStateScheduled) return;

    stickyPreviewViewportStateScheduled = true;
    stickyPreviewRafId = requestAnimationFrame(flushStickyPreviewViewportState);
  }

  function cancelScheduledStickyPreviewViewportState() {
    stickyPreviewViewportStateScheduled = false;
    if (!stickyPreviewRafId) return;
    cancelAnimationFrame(stickyPreviewRafId);
    stickyPreviewRafId = 0;
  }

  function syncObservedVisibleMessages() {
    if (!firstVisibleMessageObserver || !containerRef || shouldVirtualize()) return;
    firstVisibleMessageObserver.disconnect();
    clearObservedVisibleMessages();
    const rows = containerRef.querySelectorAll<HTMLElement>('[data-msg-id]');
    for (const row of rows) {
      firstVisibleMessageObserver.observe(row);
    }
  }

  const shouldVirtualize = createMemo(() => messages().length >= VIRTUALIZE_THRESHOLD);

  const measuredHeights = new Map<string, number>();
  let lastTrackHeight = 0;

  const messageIds = createMemo(() => messages().map((msg) => msg.info.id));

  createEffect(() => {
    if (pruneMeasuredHeights(measuredHeights, messageIds())) {
      setMeasurementVersion((version) => version + 1);
    }
  });

  const virtualMetrics = createMemo(() => {
    if (!shouldVirtualize()) {
      return { prefix: [0], totalHeight: 0, itemCount: 0 } satisfies VirtualMetrics;
    }

    measurementVersion();
    return buildVirtualMetrics({ itemIds: messageIds(), measuredHeights });
  });

  const visibleRange = createMemo(() => {
    const msgs = messages();
    if (!shouldVirtualize() || msgs.length === 0) {
      return { start: 0, end: msgs.length, topPad: 0, bottomPad: 0 };
    }
    return calculateVirtualRangeFromMetrics({
      metrics: virtualMetrics(),
      scrollTop: scrollTop(),
      viewportHeight: viewportHeight(),
    });
  });
  const linkedToolCalls = createMemo(() => {
    messageStructureVersion();
    const allMessages = untrack(() => state.messages);
    return getLinkedToolCallKeys(
      getRenderedMessages(allMessages, visibleRange(), shouldVirtualize())
    );
  });
  const standalonePermissions = createMemo(() =>
    getStandalonePermissionPrompts(
      untrack(() => state.messages),
      state.permissions,
      state.activeSessionId,
      linkedToolCalls()
    )
  );
  const standaloneQuestions = createMemo(() =>
    getStandaloneQuestionPrompts(
      untrack(() => state.messages),
      state.questions,
      state.activeSessionId,
      linkedToolCalls()
    )
  );

  const stickyUserMessagePreviewCandidate = createMemo(() => {
    const throttledViewportHeight = stickyPreviewViewportHeight();
    const currentViewportHeight =
      throttledViewportHeight > 0 ? throttledViewportHeight : viewportHeight();
    const currentScrollTop = throttledViewportHeight > 0 ? stickyPreviewScrollTop() : scrollTop();
    if (!containerRef || currentViewportHeight <= 0) return null;

    const virtualized = shouldVirtualize();
    const currentVisibleRange = virtualized
      ? calculateVirtualRangeFromMetrics({
          metrics: virtualMetrics(),
          scrollTop: currentScrollTop,
          viewportHeight: currentViewportHeight,
        })
      : visibleRange();
    const containerRect = containerRef.getBoundingClientRect();
    let firstVisibleMessageIndex = virtualized
      ? getFirstVisibleMessageIndexFromVirtualMetrics({
          metrics: virtualMetrics(),
          scrollTop: currentScrollTop,
        })
      : null;

    if (firstVisibleMessageIndex === null) {
      const firstVisibleMessageId = observedFirstVisibleMessageId();
      if (firstVisibleMessageId) {
        firstVisibleMessageIndex = messageIndexById().get(firstVisibleMessageId) ?? null;
      } else {
        const rows = containerRef.querySelectorAll<HTMLElement>('[data-msg-id]');
        for (const row of rows) {
          const rowId = row.dataset.msgId;
          if (!rowId) continue;
          const rowRect = row.getBoundingClientRect();
          const rowTop = rowRect.top - containerRect.top;
          const rowBottom = rowRect.bottom - containerRect.top;
          if (rowBottom <= 0 || rowTop >= currentViewportHeight) continue;
          firstVisibleMessageIndex = messageIndexById().get(rowId) ?? null;
          break;
        }
      }
    }

    const preview = getStickyUserMessagePreview(messages(), firstVisibleMessageIndex);
    if (!preview) return null;

    const previewElement = getStickyUserMessageSourceElement(preview.id);
    const rowRect = previewElement?.getBoundingClientRect();
    const nextUserMessageTop = getStickyUserMessageNextUserMessageTop(
      preview.id,
      preview.index,
      containerRect
    );
    const stickyPreviewBounds =
      previousStickyPreviewId === preview.id
        ? (getStickyUserMessagePreviewBounds(containerRect) ?? previousStickyPreviewBounds)
        : null;
    const shouldShow = shouldShowStickyUserMessagePreview({
      preview,
      shouldVirtualize: virtualized,
      visibleRange: currentVisibleRange,
      rowTop: rowRect ? rowRect.top - containerRect.top : null,
      rowBottom: rowRect ? rowRect.bottom - containerRect.top : null,
      nextUserMessageTop,
      viewportHeight: currentViewportHeight,
      previousPreviewId: previousStickyPreviewId,
      stickyPreviewTop: stickyPreviewBounds?.top ?? null,
      stickyPreviewBottom: stickyPreviewBounds?.bottom ?? null,
    });
    return shouldShow ? preview : null;
  });

  function measureVisibleItems() {
    if (!shouldVirtualize()) return false;
    if (!trackRef) return;
    const items = trackRef.querySelectorAll<HTMLElement>('[data-msg-id]');
    let changed = false;
    items.forEach((el) => {
      const id = el.dataset.msgId;
      if (!id) return;
      const h = el.getBoundingClientRect().height;
      if (h > 0 && (measuredHeights.get(id) ?? 0) !== h) {
        measuredHeights.set(id, h);
        changed = true;
      }
    });
    if (changed) {
      setMeasurementVersion((version) => version + 1);
    }
    return changed;
  }

  function setMeasuredHeightFor(id: string, height: number) {
    if (height <= 0) return false;
    if ((measuredHeights.get(id) ?? 0) === height) return false;
    measuredHeights.set(id, height);
    setMeasurementVersion((version) => version + 1);
    return true;
  }

  function observeMeasuredRow(element: HTMLDivElement, messageId: string, active: boolean) {
    if (!shouldVirtualize()) return;

    if (!active) {
      measuredRowObserver?.unobserve(element);
      return;
    }

    measuredRowObserver?.observe(element);
  }

  function cancelScheduledMeasurement() {
    if (measurementRafId) cancelAnimationFrame(measurementRafId);
    measurementRafId = 0;
    measurementScheduled = false;
  }

  function scheduleVisibleMeasurement(options?: { afterResize?: boolean }) {
    if (options?.afterResize) pendingMeasurementAfterResize = true;
    if (measurementScheduled) return;

    measurementScheduled = true;
    const rafId = requestAnimationFrame(() => {
      measurementScheduled = false;
      measurementRafId = 0;
      const hadResize = pendingMeasurementAfterResize;
      pendingMeasurementAfterResize = false;
      if (shouldVirtualize() && !measuredRowObserver) {
        measureVisibleItems();
      }
      const previousTrackHeight = lastTrackHeight;
      lastTrackHeight = trackRef?.getBoundingClientRect().height ?? previousTrackHeight;
      if (hadResize && restoreExpansionScrollAnchor()) {
        return;
      }
      if (hadResize && lastTrackHeight > previousTrackHeight + 1) {
        scrollToBottom();
      }
    });
    measurementRafId = measurementScheduled ? rafId : 0;
  }

  function getStickyUserMessagePreviewBounds(containerRect: DOMRect) {
    if (!containerRef) return null;
    const sticky = containerRef.querySelector<HTMLElement>('.latest-user-message-sticky');
    const stickyRect = sticky?.getBoundingClientRect();
    if (!stickyRect) return null;

    return {
      top: stickyRect.top - containerRect.top,
      bottom: stickyRect.bottom - containerRect.top,
    };
  }

  function getStickyUserMessageSourceElement(messageId: string) {
    if (!containerRef) return null;
    const row = containerRef.querySelector<HTMLElement>(`[data-msg-id="${messageId}"]`);
    return row?.querySelector<HTMLElement>('.user-message-card') ?? row;
  }

  function getStickyUserMessageNextUserMessageTop(
    messageId: string,
    messageIndex: number,
    containerRect: DOMRect
  ) {
    if (firstVisibleMessageObserver) {
      return nextVisibleUserMessageTopByMessageId().get(messageId) ?? null;
    }

    if (!containerRef) return null;
    for (let index = messageIndex + 1; index < messages().length; index += 1) {
      const nextMessage = messages()[index];
      if (nextMessage?.info.role !== 'user') continue;

      const nextElement = getStickyUserMessageSourceElement(nextMessage.info.id);
      const nextRect = nextElement?.getBoundingClientRect();
      if (!nextRect) return null;

      const nextTop = nextRect.top - containerRect.top;
      const nextBottom = nextRect.bottom - containerRect.top;
      if (nextBottom <= 0) continue;

      return nextTop;
    }

    return null;
  }

  function updateScrollbarInset() {
    if (!containerRef) return;
    const scrollbarInset = Math.max(0, containerRef.offsetWidth - containerRef.clientWidth);
    if (scrollbarInset === lastScrollbarInset) return;

    lastScrollbarInset = scrollbarInset;
    containerRef.parentElement?.style.setProperty(
      '--interactive-list-scrollbar-inset',
      `${scrollbarInset}px`
    );
  }

  function restoreExpansionScrollAnchor() {
    const anchor = pendingExpansionScrollAnchor;
    pendingExpansionScrollAnchor = null;
    const restored = restoreExpansionScrollAnchorFromState({
      anchor,
      container: containerRef,
      now: performance.now(),
      programmaticScrollWindowMs: PROGRAMMATIC_SCROLL_WINDOW_MS,
    });
    if (!restored) return false;

    const nextScrollTop = restored.nextScrollTop;
    expectedScrollTop = nextScrollTop;
    ignoreScrollUntil = restored.nextIgnoreScrollUntil;
    setScrollTop(nextScrollTop);
    lastObservedScrollTop = nextScrollTop;
    return true;
  }

  function shouldHideStickyUserMessagePreviewImmediately(preview: StickyUserMessagePreview | null) {
    if (!containerRef || !preview) return false;

    const containerRect = containerRef.getBoundingClientRect();
    const stickyBounds = getStickyUserMessagePreviewBounds(containerRect);
    if (!stickyBounds) return false;

    const nextUserMessageTop = getStickyUserMessageNextUserMessageTop(
      preview.id,
      preview.index,
      containerRect
    );
    if (
      nextUserMessageTop !== null &&
      nextUserMessageTop !== undefined &&
      nextUserMessageTop <= stickyBounds.bottom
    ) {
      return true;
    }

    const row = getStickyUserMessageSourceElement(preview.id);
    if (!row) return false;

    if (containerRef.clientHeight <= 0) return false;

    const rowRect = row.getBoundingClientRect();
    const rowBottom = rowRect.bottom - containerRect.top;
    return !isMessageHiddenBehindStickyPreview({
      rowBottom,
      nextUserMessageTop,
      stickyPreviewBottom: stickyBounds.bottom,
    });
  }

  function distanceFromBottom() {
    return getDistanceFromBottom(containerRef);
  }

  function performScroll() {
    const now = performance.now();
    const result = performScrollToBottom({
      container: containerRef,
      now,
      programmaticScrollWindowMs: PROGRAMMATIC_SCROLL_WINDOW_MS,
    });
    if (!result) return;

    expectedScrollTop = result.nextScrollTop;
    ignoreScrollUntil = result.nextIgnoreScrollUntil;
    lastObservedScrollTop = result.nextScrollTop;
    lastScrollAt = result.nextLastScrollAt;
  }

  function cancelPendingScroll() {
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      scrollTimer = 0;
    }
    if (stickyPreviewDebounceTimer) {
      clearTimeout(stickyPreviewDebounceTimer);
      stickyPreviewDebounceTimer = 0;
    }
    if (initialScrollRafId) {
      cancelAnimationFrame(initialScrollRafId);
      initialScrollRafId = 0;
    }
    cancelScheduledMeasurement();
  }

  function scrollToBottomUntilStable(sessionId: string) {
    if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);
    let attempts = 0;
    let stableFrames = 0;
    let lastHeight = -1;

    const tick = () => {
      initialScrollRafId = 0;
      if (!containerRef || !trackRef) return;
      if (state.activeSessionId !== sessionId) return;
      if (!autoScroll()) return;

      if (shouldVirtualize() && !measuredRowObserver) {
        measureVisibleItems();
      }
      performScroll();

      const currentHeight = trackRef.getBoundingClientRect().height;
      if (currentHeight === lastHeight) {
        stableFrames++;
        if (stableFrames >= INITIAL_SCROLL_STABLE_FRAMES) return;
      } else {
        stableFrames = 0;
        lastHeight = currentHeight;
      }

      if (++attempts < INITIAL_SCROLL_MAX_FRAMES) {
        initialScrollRafId = requestAnimationFrame(tick);
      }
    };
    initialScrollRafId = requestAnimationFrame(tick);
  }

  function scrollToBottom() {
    if (!containerRef || !autoScroll()) return;
    const now = performance.now();
    const elapsed = now - lastScrollAt;
    if (elapsed >= SCROLL_INTERVAL_MS) {
      cancelPendingScroll();
      performScroll();
      return;
    }
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = 0;
      if (!autoScroll()) return;
      performScroll();
    }, SCROLL_INTERVAL_MS - elapsed);
  }

  function onScroll() {
    if (!containerRef) return;
    const top = containerRef.scrollTop;
    const currentViewportHeight = containerRef.clientHeight;
    scheduleViewportState(top, currentViewportHeight);
    scheduleStickyPreviewViewportState(top, currentViewportHeight);
    const decision = resolveAutoScrollOnUserScroll({
      top,
      nearBottom: distanceFromBottom() < AUTO_SCROLL_THRESHOLD_PX,
      autoScroll: autoScroll(),
      expectedScrollTop,
      lastObservedScrollTop,
      ignoreScrollUntil,
      now: performance.now(),
      autoScrollThresholdPx: AUTO_SCROLL_THRESHOLD_PX,
    });
    lastObservedScrollTop = decision.nextLastObservedScrollTop;
    expectedScrollTop = decision.nextExpectedScrollTop;
    ignoreScrollUntil = decision.nextIgnoreScrollUntil;
    if (decision.shouldCancelPendingScroll) cancelPendingScroll();
    if (decision.nextAutoScroll !== null) setAutoScroll(decision.nextAutoScroll);
  }

  function handleClickCapture(event: MouseEvent) {
    if (!containerRef) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest<HTMLElement>('[aria-expanded]');
    if (!anchor || !containerRef.contains(anchor)) return;

    pendingExpansionScrollAnchor = captureExpansionScrollAnchor({
      anchor,
      container: containerRef,
      now: performance.now(),
      windowMs: EXPANSION_SCROLL_ANCHOR_WINDOW_MS,
    });
  }

  onMount(() => {
    if (!containerRef) return;
    containerRef.addEventListener('click', handleClickCapture as EventListener, true);
    updateScrollbarInset();
    setViewportHeight(containerRef.clientHeight);
    setScrollTop(containerRef.scrollTop);
    setStickyPreviewViewportHeight(containerRef.clientHeight);
    setStickyPreviewScrollTop(containerRef.scrollTop);

    if (typeof IntersectionObserver !== 'undefined') {
      firstVisibleMessageObserver = new IntersectionObserver(
        (entries) => {
          if (!containerRef) return;
          for (const entry of entries) {
            const messageId = (entry.target as HTMLElement).dataset.msgId;
            if (!messageId) continue;

            if (!entry.isIntersecting) {
              observedVisibleMessageBounds.delete(messageId);
              continue;
            }

            const rootBounds = entry.rootBounds ?? containerRef.getBoundingClientRect();
            observedVisibleMessageBounds.set(messageId, {
              top: entry.boundingClientRect.top - rootBounds.top,
              bottom: entry.boundingClientRect.bottom - rootBounds.top,
            });
          }
          setObservedVisibleMessageVersion((version) => version + 1);
          recomputeObservedFirstVisibleMessageId();
        },
        {
          root: containerRef,
          threshold: [0, 1],
        }
      );

      queueMicrotask(() => {
        syncObservedVisibleMessages();
      });
    }

    if (typeof ResizeObserver !== 'undefined') {
      measuredRowObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const element = entry.target as HTMLDivElement;
          const messageId = element.dataset.msgId;
          if (!messageId) continue;
          setMeasuredHeightFor(messageId, entry.contentRect.height);
        }
      });
    }

    lastObservedScrollTop = containerRef.scrollTop ?? 0;
    if (!trackRef) return;
    lastTrackHeight = trackRef.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      if (!containerRef) return;
      updateScrollbarInset();
      setViewportHeight(containerRef.clientHeight);
      scheduleStickyPreviewViewportState(containerRef.scrollTop, containerRef.clientHeight);
      scheduleVisibleMeasurement({ afterResize: true });
    });
    observer.observe(containerRef);
    observer.observe(trackRef);
    onCleanup(() => {
      containerRef?.removeEventListener('click', handleClickCapture as EventListener, true);
      observer.disconnect();
      firstVisibleMessageObserver?.disconnect();
      firstVisibleMessageObserver = null;
      measuredRowObserver?.disconnect();
      measuredRowObserver = null;
      clearObservedVisibleMessages();
      if (scrollTimer) clearTimeout(scrollTimer);
      if (stickyPreviewDebounceTimer) clearTimeout(stickyPreviewDebounceTimer);
      if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);
      cancelScheduledMeasurement();
      cancelScheduledViewportState();
      cancelScheduledStickyPreviewViewportState();
    });
  });

  createEffect(() => {
    messageIds();
    const virtualized = shouldVirtualize();
    queueMicrotask(() => {
      if (!firstVisibleMessageObserver) return;
      if (virtualized) {
        firstVisibleMessageObserver.disconnect();
        clearObservedVisibleMessages();
        return;
      }
      syncObservedVisibleMessages();
    });
  });

  createEffect(() => {
    const candidate = stickyUserMessagePreviewCandidate();
    const current = untrack(stickyUserMessagePreview);

    if (current?.id === candidate?.id && current?.text === candidate?.text) {
      previousStickyPreviewId = current?.id ?? null;
      if (stickyPreviewDebounceTimer) {
        clearTimeout(stickyPreviewDebounceTimer);
        stickyPreviewDebounceTimer = 0;
      }
      return;
    }

    if (stickyPreviewDebounceTimer) {
      clearTimeout(stickyPreviewDebounceTimer);
      stickyPreviewDebounceTimer = 0;
    }

    if (candidate) {
      if (previousStickyPreviewId !== candidate.id) {
        previousStickyPreviewBounds = null;
      }
      setStickyUserMessagePreview(candidate);
      previousStickyPreviewId = candidate.id;
      return;
    }

    if (shouldHideStickyUserMessagePreviewImmediately(current)) {
      setStickyUserMessagePreview(null);
      previousStickyPreviewId = current?.id ?? null;
      return;
    }

    stickyPreviewDebounceTimer = setTimeout(() => {
      stickyPreviewDebounceTimer = 0;
      setStickyUserMessagePreview(candidate);
      previousStickyPreviewId = null;
      previousStickyPreviewBounds = null;
    }, STICKY_PREVIEW_DISPLAY_DEBOUNCE_MS);
  });

  createEffect(() => {
    const current = stickyUserMessagePreview();
    if (!current) return;

    queueMicrotask(() => {
      const activePreview = stickyUserMessagePreview();
      if (!activePreview || activePreview.id !== current.id || !containerRef) return;

      const containerRect = containerRef.getBoundingClientRect();
      previousStickyPreviewBounds = getStickyUserMessagePreviewBounds(containerRect);
      if (!shouldHideStickyUserMessagePreviewImmediately(activePreview)) return;

      setStickyUserMessagePreview(null);
      previousStickyPreviewId = activePreview.id;
    });
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    measuredHeights.clear();
    pendingInitialScrollSessionId = sessionId;
    cancelPendingScroll();
    expectedScrollTop = -1;
    ignoreScrollUntil = 0;
    setStickyUserMessagePreview(null);
    previousStickyPreviewId = null;
    previousStickyPreviewBounds = null;
    setAutoScroll(true);
    queueMicrotask(() => performScroll());
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    const msgs = messages();
    if (msgs.length === 0) return;
    queueMicrotask(() => {
      if (state.activeSessionId !== sessionId) return;
      scheduleVisibleMeasurement();
      if (sessionId && pendingInitialScrollSessionId === sessionId) {
        pendingInitialScrollSessionId = null;
        performScroll();
        scrollToBottomUntilStable(sessionId);
        return;
      }

      if (sessionId && autoScroll()) {
        performScroll();
      }
    });
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    messageListScrollRequestKey();
    if (!sessionId || !containerRef) return;
    setAutoScroll(true);
    queueMicrotask(() => {
      if (state.activeSessionId !== sessionId) return;
      performScroll();
      scrollToBottomUntilStable(sessionId);
    });
  });

  createEffect(() => {
    if (!shouldVirtualize()) return;
    const { start, end } = visibleRange();
    queueMicrotask(() => {
      if (!shouldVirtualize()) return;
      scheduleVisibleMeasurement();
    });
    void start;
    void end;
  });

  let prevLoading = isLoading();
  createEffect(() => {
    const loading = isLoading();
    if (prevLoading && !loading && autoScroll()) {
      if (scrollTimer) {
        clearTimeout(scrollTimer);
        scrollTimer = 0;
      }
      queueMicrotask(() => performScroll());
    }
    prevLoading = loading;
  });

  const modelChangeMap = createMemo(() => {
    messageStructureVersion();
    const providerMap = new Map(state.providers.map((p) => [p.id, p]));
    return untrack(() => {
      const result = new Map<string, string>();
      let prevProvider: string | undefined;
      let prevModel: string | undefined;
      let prevVariant: string | undefined;
      for (const msg of state.messages) {
        if (!isAssistantMessage(msg.info)) continue;
        const cur = msg.info as AssistantMessage;
        if (cur.mode === 'subagent') continue;
        const modelChanged = cur.providerID !== prevProvider || cur.modelID !== prevModel;
        const variantChanged = (cur.variant || '') !== (prevVariant || '');
        if (prevProvider !== undefined && (modelChanged || variantChanged)) {
          const provider = providerMap.get(cur.providerID);
          const modelName = provider?.models[cur.modelID]?.name || cur.modelID;
          const parts: string[] = [];
          if (modelChanged) parts.push(modelName);
          if (cur.variant) parts.push(formatVariantLabel(cur.variant));
          else if (
            variantChanged &&
            !modelSupportsReasoning(cur.providerID, cur.modelID, state.providers)
          ) {
            parts.push('No thinking');
          }
          result.set(
            msg.info.id,
            formatLabelWithProvider(parts.join(' · '), provider?.name || cur.providerID)
          );
        }
        prevProvider = cur.providerID;
        prevModel = cur.modelID;
        prevVariant = cur.variant;
      }
      return result;
    });
  });

  const previousTrailingFileEventSignatureMap = createMemo(() => {
    messageStructureVersion();
    return untrack(() => {
      const result = new Map<string, string | null>();
      let previousTrailingSignature: string | null = null;

      for (const msg of state.messages) {
        result.set(msg.info.id, previousTrailingSignature);

        if (!isAssistantMessage(msg.info)) {
          previousTrailingSignature = null;
          continue;
        }

        previousTrailingSignature = getTrailingFileEventSignature(msg.parts);
      }

      return result;
    });
  });

  const assistantStackGroupMap = createMemo(
    () => new Map<string, AssistantFileEditStackGroup | null>(),
  );

  const assistantDialogSummaryMap = createMemo(() => {
    messageStructureVersion();
    return untrack(() => getAssistantDialogSummaryMap(state.messages));
  });
  const hasBuildAgent = createMemo(() => state.agents.some((agent) => agent.name === 'build'));

  return (
    <div
      ref={containerRef}
      class="interactive-list min-h-0 flex-1 overflow-y-auto"
      role="log"
      aria-live="polite"
      aria-label="Chat messages"
      onScroll={onScroll}
    >
      <div ref={trackRef} class="interactive-list-track">
        <Show when={showStickyUserPrompt() && stickyUserMessagePreview()}>
          {(preview) => <StickyUserMessagePreviewCard preview={preview()} />}
        </Show>
        <Show
          when={state.messages.length > 0}
          fallback={
            <Show when={shouldShowStarterLogo()}>
              <div class="chat-empty-state">
                <img
                  class="chat-empty-logo"
                  src={state.emptyStateLogoUri}
                  alt=""
                  aria-hidden="true"
                  draggable="false"
                />
              </div>
            </Show>
          }
        >
          <Show
            when={shouldVirtualize()}
            fallback={
              <MessageRows
                messages={messages()}
                modelChangeMap={modelChangeMap()}
                lastAssistantID={lastAssistantID()}
                previousTrailingFileEventSignatureMap={previousTrailingFileEventSignatureMap()}
                fileEditStackGroupMap={assistantStackGroupMap()}
                assistantDialogSummaryMap={assistantDialogSummaryMap()}
                hasBuildAgent={hasBuildAgent()}
                latestPlanImplementationMessageId={latestPlanImplementationMessageId()}
                observeMeasuredRow={observeMeasuredRow}
                isPlanningAssistantMessage={isPlanningAssistantMessage}
                shouldShowPlanImplementationAction={shouldShowPlanImplementationAction}
                buildPlanImplementationPrompt={buildPlanImplementationPrompt}
                buildPlanDocumentContent={buildPlanDocumentContent}
              />
            }
          >
            <VirtualizedContent
              messages={messages()}
              modelChangeMap={modelChangeMap()}
              lastAssistantID={lastAssistantID()}
              previousTrailingFileEventSignatureMap={previousTrailingFileEventSignatureMap()}
              fileEditStackGroupMap={assistantStackGroupMap()}
              assistantDialogSummaryMap={assistantDialogSummaryMap()}
              hasBuildAgent={hasBuildAgent()}
              latestPlanImplementationMessageId={latestPlanImplementationMessageId()}
              visibleRange={visibleRange()}
              observeMeasuredRow={observeMeasuredRow}
              isPlanningAssistantMessage={isPlanningAssistantMessage}
              shouldShowPlanImplementationAction={shouldShowPlanImplementationAction}
              buildPlanImplementationPrompt={buildPlanImplementationPrompt}
              buildPlanDocumentContent={buildPlanDocumentContent}
            />
          </Show>
        </Show>
        <PendingActionRows
          questions={standaloneQuestions()}
          permissions={standalonePermissions()}
        />
        <Show
          when={
            (isLoading() || isSessionCompacting()) &&
            !hasActiveQuestion() &&
            !hasActivePermission() &&
            !visibleBlockingStreamingPart() &&
            !activeUsageLimit()
          }
        >
          <LoadingRow compacting={isSessionCompacting()} />
        </Show>
      </div>
    </div>
  );
}

function getAssistantDialogSummaryMap(messages: Array<{ info: Message; parts: Part[] }>) {
  const result = new Map<string, AssistantDialogSummaryInfo>();
  const childRunsByParentId = getChildRunsByParentId(messages);
  let currentMessages: AssistantMessage[] = [];
  let currentPrimaryMessageIds: string[] = [];
  let currentSubagentHandoffCount = 0;
  let currentUserRequestCreated: number | null = null;

  const flush = () => {
    if (currentMessages.length === 0) {
      currentMessages = [];
      currentPrimaryMessageIds = [];
      currentSubagentHandoffCount = 0;
      currentUserRequestCreated = null;
      return;
    }

    const lastMessage = currentMessages[currentMessages.length - 1];
    if (!lastMessage?.time.completed) {
      currentMessages = [];
      currentPrimaryMessageIds = [];
      currentSubagentHandoffCount = 0;
      currentUserRequestCreated = null;
      return;
    }

    const aggregateMessages = collectAssistantDialogMessages(currentMessages, childRunsByParentId);
    const completedMessages = aggregateMessages.filter((message) => !!message.time.completed);
    const end = Math.max(...completedMessages.map((message) => message.time.completed || 0));
    const tokens = sumAssistantTokens(aggregateMessages);
    const childRunCount = countAssistantDialogChildRuns(
      currentPrimaryMessageIds,
      childRunsByParentId
    );
    const agentCount = Math.max(childRunCount, currentSubagentHandoffCount);
    result.set(lastMessage.id, {
      durationMs: Math.max(0, end - (currentUserRequestCreated ?? currentMessages[0].time.created)),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      agentCount,
    });

    currentMessages = [];
    currentPrimaryMessageIds = [];
    currentSubagentHandoffCount = 0;
    currentUserRequestCreated = null;
  };

  for (const entry of messages) {
    if (!isAssistantMessage(entry.info)) {
      flush();
      if (entry.info.role === 'user') {
        currentUserRequestCreated = entry.info.time.created;
      }
      continue;
    }

    const assistant = entry.info as AssistantMessage;
    currentMessages.push(assistant);
    if (assistant.mode !== 'subagent') {
      currentPrimaryMessageIds.push(assistant.id);
    }
    for (const part of entry.parts) {
      if (part.type === 'agent' && part.name.trim()) {
        currentSubagentHandoffCount++;
        continue;
      }

      if (part.type === 'subtask') {
        currentSubagentHandoffCount++;
      }
    }
  }

  flush();
  return result;
}

function collectAssistantDialogMessages(
  messages: AssistantMessage[],
  childRunsByParentId: Map<string, Array<{ info: AssistantMessage; parts: Part[] }>>
) {
  const result: AssistantMessage[] = [];
  const visited = new Set<string>();
  const pending = [...messages];

  while (pending.length > 0) {
    const message = pending.shift();
    if (!message || visited.has(message.id)) continue;
    visited.add(message.id);
    result.push(message);

    for (const child of childRunsByParentId.get(message.id) || []) {
      pending.push(child.info);
    }
  }

  return result;
}

function countAssistantDialogChildRuns(
  rootMessageIds: string[],
  childRunsByParentId: Map<string, Array<{ info: AssistantMessage; parts: Part[] }>>
) {
  let count = 0;
  const visited = new Set<string>();
  const pending = [...rootMessageIds];

  while (pending.length > 0) {
    const messageId = pending.shift();
    if (!messageId) continue;

    for (const child of childRunsByParentId.get(messageId) || []) {
      if (visited.has(child.info.id)) continue;
      visited.add(child.info.id);
      count++;
      pending.push(child.info.id);
    }
  }

  return count;
}

function LoadingRow(props: { compacting: boolean }) {
  const [now, setNow] = createSignal(Date.now());
  const STALE_TOTAL_THRESHOLD_MS = 90_000;
  const STALE_INACTIVITY_THRESHOLD_MS = 60_000;

  const isStale = () => {
    const currentNow = now();
    const startedAt = loadingStartedAt();
    if (startedAt === null) return false;
    const total = currentNow - startedAt;
    if (total < STALE_TOTAL_THRESHOLD_MS) return false;
    const lastActivity = loadingLastActivityAt() ?? startedAt;
    return currentNow - lastActivity >= STALE_INACTIVITY_THRESHOLD_MS;
  };

  const timer = setInterval(() => {
    setNow(Date.now());
    if (isStale()) {
      clearInterval(timer);
    }
  }, 1000);
  onCleanup(() => clearInterval(timer));

  const totalElapsedMs = () => {
    const startedAt = loadingStartedAt();
    return startedAt === null ? 0 : Math.max(0, now() - startedAt);
  };
  const elapsedSeconds = () => Math.floor(totalElapsedMs() / 1000);

  const verbs = [
    'Thinking',
    'Cogitating',
    'Pondering',
    'Musing',
    'Ruminating',
    'Weaving thoughts',
    'Scheming',
    'Synthesizing',
  ];
  const verb = () => verbs[Math.floor(elapsedSeconds() / 3) % verbs.length];

  const formatElapsed = () => {
    const s = elapsedSeconds();
    if (s < 10) return null;
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem.toString().padStart(2, '0')}s`;
  };

  return (
    <div class="interactive-item-container interactive-response interactive-loading-row">
      <div
        class={`loading-indicator ${isStale() ? 'stale' : ''} ${props.compacting ? 'is-compacting' : ''}`}
      >
        <Show
          when={!props.compacting && isStale()}
          fallback={
            <Show
              when={props.compacting}
              fallback={
                <span class="shimmer-progress loading-verb">
                  {verb()}
                  <span class="chat-animated-ellipsis" />
                </span>
              }
            >
              <span class="loading-verb">Compacting conversation context…</span>
            </Show>
          }
        >
          <span>Session may be stale</span>
        </Show>
        <Show when={formatElapsed()}>
          <span class="loading-elapsed">{formatElapsed()}</span>
        </Show>
        <Show when={isStale()}>
          <button
            class="loading-action"
            onClick={() => {
              if (state.activeSessionId) recheckSessionStatus(state.activeSessionId);
            }}
            title="Check if session is still running"
          >
            Recheck
          </button>
          <button
            class="loading-action"
            onClick={() => stopLoading()}
            title="Dismiss loading indicator"
          >
            Dismiss
          </button>
        </Show>
      </div>
    </div>
  );
}
