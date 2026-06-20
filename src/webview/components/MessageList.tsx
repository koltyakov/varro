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
  requestMessageListScrollToBottom,
  getChildRunsByParentId,
  getActiveUsageLimitNotice,
  isActiveSessionWorking,
  getSessionTreeRootId,
  getSessionTreeIds,
  messageStructureVersion,
  messageInfoVersion,
  showStickyUserPrompt,
  showModelPicker,
} from '../lib/state';
import { isAssistantMessage, sumAssistantTokens } from '../lib/message-metrics';
import type { AssistantMessage, Message, Part, Permission, QuestionRequest } from '../types';
import {
  getUserMessageEditContext,
  getUserMessageEditText,
  hasUserMessageEditableContent,
  type AssistantFileEditStackGroup,
} from './Message';
import { editingMessage, startEditingMessage } from '../lib/message-edit-state';
import { recheckSessionStatus } from '../hooks/useOpenCode';
import { modelSupportsReasoning } from '../lib/model-capabilities';
import { formatLabelWithProvider, formatVariantLabel } from '../lib/format';
import { getTrailingFileEventSignature } from '../lib/message-event-collapse';
import { shouldShowAssistantPartInline } from '../lib/part-utils';
import {
  buildPermissionRequestLookup,
  buildQuestionRequestLookup,
  getToolCallLookupKey,
} from '../lib/tool-call-matching';
import {
  ChatContentBottomFade,
  PendingActionRows,
  StickyUserMessagePreviewCard,
} from './message-list/MessageListChrome';
import {
  getNextVisibleUserMessageTopMap,
  getStickyUserMessagePreview,
  isMessageHiddenBehindStickyPreview,
  shouldShowStickyUserMessagePreview,
  type StickyUserMessagePreview,
} from './message-list/sticky-preview';
import {
  findStreamingPart,
  hasCommittedVisibleTextAsLastPart,
  hasVisibleBlockingStreamingPart,
} from './message-list/streaming';
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
import type { AssistantDialogSummaryInfo } from './message-list/MessageRows';
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
  return info.agent === 'plan';
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

function shouldHideThreadMessage(
  entry: { info: Message; parts: Part[] },
  activeSessionId: string | null
) {
  if (!activeSessionId) return false;

  const activeTreeIds = new Set(getSessionTreeIds(activeSessionId));
  if (!activeTreeIds.has(entry.info.sessionID)) return true;
  if (entry.info.sessionID === activeSessionId) return false;

  const session = state.sessions.find((item) => item.id === entry.info.sessionID);
  return !!session?.parentID;
}

export function getVisibleThreadMessages(
  messages: Array<{ info: Message; parts: Part[] }>,
  activeSessionId = state.activeSessionId
) {
  return messages.filter((entry) => !shouldHideThreadMessage(entry, activeSessionId));
}

function getMessageIdSet(messages: Array<{ info: Message }>) {
  return new Set(messages.map((message) => message.info.id));
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
const LOADING_ROW_REAPPEAR_DELAY_MS = 180;
const LOADING_ROW_RESERVE_RELEASE_DELAY_MS = 600;
const TRAILING_SUMMARY_SETTLE_DELAY_MS = 240;
// Only offer "jump to latest" when at least this much content is hidden
// below the viewport; a barely-scrolled list doesn't need the button.
const JUMP_TO_LATEST_MIN_HIDDEN_CONTENT_PX = 240;

export function MessageList() {
  // oxlint-disable-next-line no-unassigned-vars
  let containerRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let trackRef: HTMLDivElement | undefined;
  const [autoScroll, setAutoScroll] = createSignal(true);
  const lastAssistantID = createMemo(() => {
    const msgs = state.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (isAssistantMessage(msgs[i]!.info)) return msgs[i]!.info.id;
    }
    return null;
  });
  let expectedScrollTop = -1;
  let ignoreScrollUntil = 0;
  let lastObservedScrollTop = 0;
  let pendingInitialScrollSessionId: string | null = null;
  let initialScrollRafId = 0;
  let pendingScrollToBottomRequest = false;
  let followModeLocked = false;
  let previousStickyPreviewId: string | null = null;
  let previousStickyPreviewBounds: { top: number; bottom: number } | null = null;
  let pendingExpansionScrollAnchor: ExpansionScrollAnchor | null = null;
  let stickyPreviewDebounceTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let firstVisibleMessageObserver: IntersectionObserver | null = null;
  let measuredRowObserver: ResizeObserver | null = null;
  let measurementRafId = 0;
  let measurementScheduled = false;
  let pendingMeasurementAfterResize = false;
  let suppressSyncScrollTop = false;
  let stickyPreviewRafId = 0;
  let stickyPreviewViewportStateScheduled = false;
  let pendingStickyPreviewScrollTop = 0;
  let pendingStickyPreviewViewportHeight = 0;
  let lastScrollbarInset = -1;
  let lastContainerOffsetWidth = -1;
  let lastAutoScrolledTrackHeight = 0;
  let lastAutoScrolledBottomScrollTop = 0;
  let lastWheelAt = Number.NEGATIVE_INFINITY;
  let lastUserScrollAt = Number.NEGATIVE_INFINITY;
  let lastWheelUpAt = Number.NEGATIVE_INFINITY;
  let previousAutoScrollEnabled = true;
  let pinnedToBottom = true;
  let activeFollowLoopSessionId: string | null = null;
  const AUTO_SCROLL_THRESHOLD_PX = 60;
  const REATTACH_THRESHOLD_PX = 10;
  const PROGRAMMATIC_SCROLL_WINDOW_MS = 200;
  const ACTIVE_WHEEL_WINDOW_MS = 180;
  const USER_SCROLL_IDLE_MS = 240;

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
  const [reserveLoadingRow, setReserveLoadingRow] = createSignal(false);
  const [showLoadingRow, setShowLoadingRow] = createSignal(false);
  const activeUsageLimit = createMemo(() => getActiveUsageLimitNotice(state.activeSessionId));
  const activeSessionWorking = createMemo(() => isActiveSessionWorking());
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
  const messages = createMemo(() => {
    messageStructureVersion();
    return untrack(() => getVisibleThreadMessages(state.messages, state.activeSessionId));
  });
  const latestPlanImplementationMessageId = createMemo(() => {
    messageInfoVersion();
    return untrack(() => getLatestPlanImplementationMessageId(state.messages));
  });
  const streamingPart = createMemo(() => {
    const streamingPartId = state.streamingPartId;
    messageStructureVersion();
    return untrack(() => findStreamingPart(messages(), streamingPartId));
  });
  const streamingTextLength = createMemo(() => state.streamingText.length);
  const visibleBlockingStreamingPart = createMemo(() => {
    const streamingText = state.streamingText;
    return hasVisibleBlockingStreamingPart(streamingPart(), streamingText);
  });
  const committedTextBlocksReappear = createMemo(() => {
    messageStructureVersion();
    const currentStreamingPartId = state.streamingPartId;
    const currentLoadingStartedAt = loadingStartedAt();
    return untrack(() =>
      hasCommittedVisibleTextAsLastPart(messages(), currentStreamingPartId, currentLoadingStartedAt)
    );
  });
  const messageIndexById = createMemo(() => {
    messageInfoVersion();
    return untrack(() => {
      const result = new Map<string, number>();
      for (const [index, entry] of state.messages.entries()) {
        result.set(entry.info.id, index);
      }
      return result;
    });
  });

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

  const measuredHeights = new Map<string, number>();
  let lastTrackHeight = 0;
  let cachedVirtualMetrics: VirtualMetrics | null = null;
  let cachedVirtualMetricsItemIds: string[] | null = null;
  let dirtyVirtualMetricsFromIndex = Number.POSITIVE_INFINITY;
  let loadingRowReappearTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let loadingRowReserveReleaseTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let trailingSummarySettleTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let loadingRowHiddenByVisibleStream = false;

  function clearLoadingRowReappearTimer() {
    if (!loadingRowReappearTimer) return;
    clearTimeout(loadingRowReappearTimer);
    loadingRowReappearTimer = 0;
  }

  function clearLoadingRowReserveReleaseTimer() {
    if (!loadingRowReserveReleaseTimer) return;
    clearTimeout(loadingRowReserveReleaseTimer);
    loadingRowReserveReleaseTimer = 0;
  }

  function clearTrailingSummarySettleTimer() {
    if (!trailingSummarySettleTimer) return;
    clearTimeout(trailingSummarySettleTimer);
    trailingSummarySettleTimer = 0;
  }

  function markVirtualMetricsDirty(messageId: string) {
    if (dirtyVirtualMetricsFromIndex === 0) return;
    const index = messageIndexById().get(messageId);
    if (typeof index !== 'number') return;
    if (index < dirtyVirtualMetricsFromIndex) {
      dirtyVirtualMetricsFromIndex = index;
    }
  }

  createEffect(() => {
    const enabled = autoScroll();
    if (enabled && !previousAutoScrollEnabled) {
      lastAutoScrolledTrackHeight = trackRef?.getBoundingClientRect().height ?? lastTrackHeight;
    }
    previousAutoScrollEnabled = enabled;
  });

  const messageIds = createMemo(() => messages().map((msg) => msg.info.id));

  // Principle: native scrollbar mapping must come from real layout, not guessed row heights.
  // Large transcripts stay non-virtualized until every row has an exact measured height; only then
  // do we switch to prefix-sum virtualization. Do not replace this with estimated heights.
  const shouldMeasureRows = createMemo(() => messages().length >= VIRTUALIZE_THRESHOLD);

  function hasMeasuredEveryMessage() {
    if (!shouldMeasureRows()) return false;
    for (const id of messageIds()) {
      if (!measuredHeights.has(id)) return false;
    }
    return true;
  }

  const hasMeasuredAllRows = createMemo(() => {
    measurementVersion();
    return hasMeasuredEveryMessage();
  });

  const shouldVirtualize = createMemo(() => shouldMeasureRows() && hasMeasuredAllRows());

  createEffect(() => {
    if (pruneMeasuredHeights(measuredHeights, messageIds())) {
      setMeasurementVersion((version) => version + 1);
    }
  });

  const hasIncompleteVisibleAssistantReply = createMemo(() => {
    messageInfoVersion();
    return messages().some(
      (entry) => isAssistantMessage(entry.info) && !entry.info.time.completed && !entry.info.error
    );
  });

  const loadingRowEligible = createMemo(
    () =>
      (activeSessionWorking() || hasIncompleteVisibleAssistantReply()) &&
      !hasActiveQuestion() &&
      !hasActivePermission() &&
      !activeUsageLimit()
  );

  const shouldShowLoadingRow = createMemo(
    () => loadingRowEligible() && !visibleBlockingStreamingPart() && !committedTextBlocksReappear()
  );

  createEffect(() => {
    const eligible = loadingRowEligible();
    const blockedByVisibleStream = eligible && visibleBlockingStreamingPart();
    const shouldShow = shouldShowLoadingRow();
    const isReserved = reserveLoadingRow();
    const isShowing = showLoadingRow();

    if (!eligible) {
      clearLoadingRowReappearTimer();
      loadingRowHiddenByVisibleStream = false;
      if (isShowing) setShowLoadingRow(false);
      if (!isReserved || loadingRowReserveReleaseTimer) return;
      loadingRowReserveReleaseTimer = setTimeout(() => {
        loadingRowReserveReleaseTimer = 0;
        if (!loadingRowEligible()) setReserveLoadingRow(false);
      }, LOADING_ROW_RESERVE_RELEASE_DELAY_MS);
      return;
    }

    clearLoadingRowReserveReleaseTimer();
    if (!isReserved) setReserveLoadingRow(true);

    if (blockedByVisibleStream) {
      clearLoadingRowReappearTimer();
      loadingRowHiddenByVisibleStream = true;
      if (isShowing) setShowLoadingRow(false);
      return;
    }

    if (!shouldShow || isShowing || loadingRowReappearTimer) return;

    if (!loadingRowHiddenByVisibleStream) {
      setShowLoadingRow(true);
      return;
    }

    loadingRowReappearTimer = setTimeout(() => {
      loadingRowReappearTimer = 0;
      if (shouldShowLoadingRow()) setShowLoadingRow(true);
    }, LOADING_ROW_REAPPEAR_DELAY_MS);
  });

  const virtualMetrics = createMemo(() => {
    if (!shouldVirtualize()) {
      cachedVirtualMetrics = null;
      cachedVirtualMetricsItemIds = null;
      dirtyVirtualMetricsFromIndex = Number.POSITIVE_INFINITY;
      return { prefix: [0], totalHeight: 0, itemCount: 0 } satisfies VirtualMetrics;
    }

    measurementVersion();
    const ids = messageIds();
    const previous =
      cachedVirtualMetrics && cachedVirtualMetricsItemIds
        ? { metrics: cachedVirtualMetrics, itemIds: cachedVirtualMetricsItemIds }
        : undefined;
    const result = buildVirtualMetrics({
      itemIds: ids,
      measuredHeights,
      previous,
      dirtyFromIndex: previous ? Math.min(dirtyVirtualMetricsFromIndex, ids.length) : undefined,
    });
    cachedVirtualMetrics = result;
    cachedVirtualMetricsItemIds = ids;
    dirtyVirtualMetricsFromIndex = ids.length;
    return result;
  });

  const visibleRange = createMemo(() => {
    const msgs = messages();
    const editing = editingMessage();
    if (editing) {
      const editedIndex = msgs.findIndex((entry) => entry.info.id === editing.messageId);
      if (editedIndex >= 0) {
        return {
          start: 0,
          end: msgs.length,
          topPad: 0,
          bottomPad: 0,
          coreStart: 0,
          coreEnd: msgs.length,
        };
      }
    }
    if (!shouldVirtualize() || msgs.length === 0) {
      return {
        start: 0,
        end: msgs.length,
        topPad: 0,
        bottomPad: 0,
        coreStart: 0,
        coreEnd: msgs.length,
      };
    }
    return calculateVirtualRangeFromMetrics({
      metrics: virtualMetrics(),
      scrollTop: scrollTop(),
      viewportHeight: viewportHeight(),
    });
  });
  const renderedMessages = createMemo(() =>
    getRenderedMessages(messages(), visibleRange(), shouldVirtualize())
  );
  const renderedMessageIds = createMemo(() => getMessageIdSet(renderedMessages()));
  const linkedToolCalls = createMemo(() => {
    messageStructureVersion();
    return getLinkedToolCallKeys(renderedMessages());
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
  const activeSessionRootId = createMemo(
    () => getSessionTreeRootId(state.activeSessionId) || state.activeSessionId
  );
  const [trailingSummarySettled, setTrailingSummarySettled] = createSignal(true);

  createEffect(() => {
    clearTrailingSummarySettleTimer();

    if (activeSessionWorking()) {
      if (trailingSummarySettled()) setTrailingSummarySettled(false);
      return;
    }

    if (trailingSummarySettled()) return;

    trailingSummarySettleTimer = setTimeout(() => {
      trailingSummarySettleTimer = 0;
      if (!activeSessionWorking()) setTrailingSummarySettled(true);
    }, TRAILING_SUMMARY_SETTLE_DELAY_MS);
  });

  const questionRequestsByToolCall = createMemo(() =>
    buildQuestionRequestLookup(state.questions, activeSessionRootId())
  );
  const permissionRequestsByToolCall = createMemo(() =>
    buildPermissionRequestLookup(state.permissions, activeSessionRootId())
  );

  function getQuestionRequestForTool(part: Extract<Part, { type: 'tool' }>) {
    const key = getToolCallLookupKey(activeSessionRootId(), part.messageID, part.callID);
    return key ? (questionRequestsByToolCall().get(key) ?? null) : null;
  }

  function getPermissionMatchForTool(part: Extract<Part, { type: 'tool' }>) {
    const key = getToolCallLookupKey(activeSessionRootId(), part.messageID, part.callID);
    return key ? (permissionRequestsByToolCall().get(key) ?? null) : null;
  }

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
    if (!shouldMeasureRows()) return false;
    if (!trackRef) return;
    const items = trackRef.querySelectorAll<HTMLElement>('[data-msg-id]');
    const measuredHeightsFromLayout = [...items].map((el) => el.getBoundingClientRect().height);
    const hasLayoutMeasurements = measuredHeightsFromLayout.some((height) => height > 0);
    const noLayoutFallbackHeight = hasLayoutMeasurements
      ? 0
      : Math.max(1, Math.floor((containerRef?.scrollHeight || 0) / Math.max(1, items.length))) ||
        160;
    let changed = false;
    items.forEach((el, index) => {
      const id = el.dataset.msgId;
      if (!id) return;
      const h = hasLayoutMeasurements ? measuredHeightsFromLayout[index]! : noLayoutFallbackHeight;
      if ((measuredHeights.get(id) ?? -1) !== h) {
        measuredHeights.set(id, h);
        markVirtualMetricsDirty(id);
        changed = true;
      }
    });
    if (changed) scheduleMeasurementDebounce();
    return changed;
  }

  function measureMountedRow(element: HTMLDivElement, messageId: string) {
    // Principle: mount-time measurement is part of the exact-height bootstrap. Tests and no-layout
    // environments may never deliver ResizeObserver entries, so virtualization must not depend on
    // observer callbacks alone.
    const height = element.getBoundingClientRect().height || 160;
    if ((measuredHeights.get(messageId) ?? -1) === height) return;
    measuredHeights.set(messageId, height);
    markVirtualMetricsDirty(messageId);
    if (hasMeasuredEveryMessage()) scheduleMeasurementDebounce();
  }

  function setMeasuredHeightsFor(entries: ResizeObserverEntry[]) {
    let changed = false;
    for (const entry of entries) {
      const element = entry.target as HTMLDivElement;
      const messageId = element.dataset.msgId;
      const height = element.getBoundingClientRect().height;
      if (!messageId || (measuredHeights.get(messageId) ?? -1) === height) {
        continue;
      }

      measuredHeights.set(messageId, height);
      markVirtualMetricsDirty(messageId);
      element.style.setProperty('--cis', `${height}px`);
      element.dataset.cis = '';
      changed = true;
    }

    if (!changed) return;

    scheduleMeasurementDebounce();
    scheduleVisibleMeasurement({ afterResize: true });
  }

  function scheduleMeasurementDebounce() {
    publishMeasurementVersion();
  }

  function captureVisibleScrollAnchor() {
    if (!containerRef || !shouldVirtualize()) return null;

    if (observedVisibleMessageBounds.size > 0) {
      const ids = messageIds();
      const range = visibleRange();
      for (let i = range.start; i < range.end && i < ids.length; i += 1) {
        const id = ids[i]!;
        const bounds = observedVisibleMessageBounds.get(id);
        if (bounds && bounds.bottom > 0) {
          return { messageId: id, top: bounds.top, topPad: range.topPad };
        }
      }
    }

    const containerRect = containerRef.getBoundingClientRect();
    const rows = containerRef.querySelectorAll<HTMLElement>('[data-msg-id]');
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue;
      const messageId = row.dataset.msgId;
      if (!messageId) continue;
      return {
        messageId,
        top: rect.top - containerRect.top,
        topPad: visibleRange().topPad,
      };
    }
    return null;
  }

  function restoreVisibleScrollAnchor(
    anchor: { messageId: string; top: number; topPad: number } | null
  ) {
    if (!containerRef || !shouldVirtualize()) return;
    let delta: number | null = null;
    if (anchor) {
      const row = containerRef.querySelector<HTMLElement>(
        `[data-msg-id="${CSS.escape(anchor.messageId)}"]`
      );
      if (row) {
        const containerRect = containerRef.getBoundingClientRect();
        delta = row.getBoundingClientRect().top - containerRect.top - anchor.top;
      } else {
        delta = visibleRange().topPad - anchor.topPad;
      }
    }

    if (delta === null || Math.abs(delta) <= 0.5) return;
    const container = containerRef;
    suppressSyncScrollTop = true;
    container.scrollTop += delta;
    suppressSyncScrollTop = false;
    batch(() => {
      setScrollTop(container.scrollTop);
      setViewportHeight(container.clientHeight);
    });
    expectedScrollTop = -1;
    ignoreScrollUntil = 0;
  }

  function publishMeasurementVersion() {
    if (!containerRef) {
      setMeasurementVersion((version) => version + 1);
      return;
    }

    const capturedAutoScroll = autoScroll();
    if (capturedAutoScroll || userScrollRecentlyActive()) {
      setMeasurementVersion((version) => version + 1);
      return;
    }

    const anchor = captureVisibleScrollAnchor();

    setMeasurementVersion((version) => version + 1);

    queueMicrotask(() => restoreVisibleScrollAnchor(anchor));
  }

  function observeMeasuredRow(element: HTMLDivElement, messageId: string, active: boolean) {
    if (!active) {
      measuredRowObserver?.unobserve(element);
      return;
    }

    if (!shouldMeasureRows()) return;

    measureMountedRow(element, messageId);
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
      if (shouldMeasureRows() && !hasMeasuredAllRows()) {
        measureVisibleItems();
      }
      const previousTrackHeight = lastTrackHeight;
      lastTrackHeight = trackRef?.getBoundingClientRect().height ?? previousTrackHeight;
      if (hadResize && restoreExpansionScrollAnchor()) {
        return;
      }
      if (shouldCorrectBottomAfterResize()) {
        performScroll();
        const sessionId = state.activeSessionId;
        if (sessionId) startFollowLoop(sessionId);
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
    const row = [...containerRef.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
      (element) => element.dataset.msgId === messageId
    );
    return row?.querySelector<HTMLElement>('.user-message-card') ?? row;
  }

  function getStickyUserMessageNextUserMessageTop(
    messageId: string,
    messageIndex: number,
    containerRect: DOMRect
  ) {
    if (firstVisibleMessageObserver && !shouldVirtualize()) {
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
    suppressSyncScrollTop = true;
    const restored = restoreExpansionScrollAnchorFromState({
      anchor,
      container: containerRef,
      now: performance.now(),
      programmaticScrollWindowMs: PROGRAMMATIC_SCROLL_WINDOW_MS,
    });
    suppressSyncScrollTop = false;
    if (!restored) return false;

    const nextScrollTop = restored.nextScrollTop;
    expectedScrollTop = nextScrollTop;
    ignoreScrollUntil = restored.nextIgnoreScrollUntil;
    setScrollTop(nextScrollTop);
    lastObservedScrollTop = nextScrollTop;
    return true;
  }

  function getNextUserMessageTopFromDOM(
    messageIndex: number,
    containerRect: DOMRect,
    messageId?: string
  ): number | null {
    if (firstVisibleMessageObserver && !shouldVirtualize() && messageId) {
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

  function shouldHideStickyUserMessagePreviewImmediately(preview: StickyUserMessagePreview | null) {
    if (!containerRef || !preview) return false;

    const containerRect = containerRef.getBoundingClientRect();
    const stickyBounds = getStickyUserMessagePreviewBounds(containerRect);
    if (!stickyBounds) return false;

    const nextUserMessageTop = getNextUserMessageTopFromDOM(
      preview.index,
      containerRect,
      preview.id
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

  function bottomScrollTop() {
    if (!containerRef) return 0;

    return Math.max(0, containerRef.scrollHeight - containerRef.clientHeight);
  }

  function shouldCorrectBottomAfterResize() {
    if (!containerRef || !autoScroll()) return false;

    const nextBottomScrollTop = bottomScrollTop();
    return nextBottomScrollTop > containerRef.scrollTop + 1;
  }

  function userScrollRecentlyActive() {
    const now = performance.now();
    return (
      now - lastWheelAt <= USER_SCROLL_IDLE_MS || now - lastUserScrollAt <= USER_SCROLL_IDLE_MS
    );
  }

  function performScroll(options?: { force?: boolean }) {
    if (!options?.force && userScrollRecentlyActive() && !followModeLocked) return;

    const now = performance.now();
    suppressSyncScrollTop = true;
    const result = performScrollToBottom({
      container: containerRef,
      now,
      programmaticScrollWindowMs: PROGRAMMATIC_SCROLL_WINDOW_MS,
    });
    suppressSyncScrollTop = false;
    if (!result) return;

    expectedScrollTop = result.nextScrollTop;
    ignoreScrollUntil = result.nextIgnoreScrollUntil;
    lastObservedScrollTop = result.nextScrollTop;
    lastAutoScrolledTrackHeight = trackRef?.getBoundingClientRect().height ?? lastTrackHeight;
    lastAutoScrolledBottomScrollTop = result.nextScrollTop;
    pinnedToBottom = true;
    batch(() => {
      setScrollTop(result.nextScrollTop);
      if (containerRef) setViewportHeight(containerRef.clientHeight);
    });
  }

  function cancelPendingScroll() {
    if (stickyPreviewDebounceTimer) {
      clearTimeout(stickyPreviewDebounceTimer);
      stickyPreviewDebounceTimer = 0;
    }
    if (initialScrollRafId) {
      cancelAnimationFrame(initialScrollRafId);
      initialScrollRafId = 0;
    }
    cancelScheduledMeasurement();
    if (activeFollowLoopSessionId) {
      activeFollowLoopSessionId = null;
    }
  }

  function startFollowLoop(sessionId: string, options?: { immediate?: boolean }) {
    if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);

    activeFollowLoopSessionId = sessionId;

    if (options?.immediate) {
      tick();
      return;
    }

    initialScrollRafId = requestAnimationFrame(tick);

    function tick() {
      initialScrollRafId = 0;
      if (!containerRef || !trackRef) {
        activeFollowLoopSessionId = null;
        return;
      }
      if (state.activeSessionId !== sessionId) {
        activeFollowLoopSessionId = null;
        return;
      }
      if (!autoScroll()) {
        activeFollowLoopSessionId = null;
        return;
      }

      ignoreScrollUntil = Math.max(
        ignoreScrollUntil,
        performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS
      );

      if (shouldMeasureRows() && !hasMeasuredAllRows()) {
        measureVisibleItems();
      }

      const currentHeight = trackRef.getBoundingClientRect().height;
      const currentBottomScrollTop = Math.max(
        0,
        containerRef.scrollHeight - containerRef.clientHeight
      );
      const belowBottomTarget = containerRef.scrollTop < currentBottomScrollTop - 1;
      const trackGrew = currentHeight > lastAutoScrolledTrackHeight + 1;
      if (belowBottomTarget || trackGrew) {
        performScroll({ force: true });
      }

      const isStreaming = state.streamingText.length > 0 || state.streamingPartId;
      const stable =
        Math.abs(currentHeight - lastAutoScrolledTrackHeight) <= 1 &&
        Math.abs(currentBottomScrollTop - lastAutoScrolledBottomScrollTop) <= 1 &&
        distanceFromBottom() <= 1;

      if (stable && !isStreaming) {
        expectedScrollTop = -1;
        followModeLocked = false;
        activeFollowLoopSessionId = null;
        return;
      }

      initialScrollRafId = requestAnimationFrame(tick);
    }
  }

  function getEditMaxScrollTop(top: number) {
    if (!containerRef) return null;
    const editing = editingMessage();
    if (!editing) return null;
    const row = [...containerRef.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
      (element) => element.dataset.msgId === editing.messageId
    );
    if (!row) return null;

    const containerRect = containerRef.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return Math.max(0, top + rowRect.top - containerRect.top);
  }

  function clampEditScrollTop(top: number) {
    if (!containerRef) return top;
    const maxScrollTop = getEditMaxScrollTop(top);
    if (maxScrollTop !== null && top > maxScrollTop + 1) {
      containerRef.scrollTop = maxScrollTop;
      return maxScrollTop;
    }
    return top;
  }

  function onScroll() {
    if (!containerRef) return;
    const autoScrollEnabled = autoScroll();
    const now = performance.now();
    const top = clampEditScrollTop(containerRef.scrollTop);
    const currentViewportHeight = containerRef.clientHeight;
    const distance = distanceFromBottom();
    const bottomTargetStable = Math.abs(bottomScrollTop() - lastAutoScrolledBottomScrollTop) <= 1;
    if (!autoScrollEnabled || now - lastWheelAt <= ACTIVE_WHEEL_WINDOW_MS) {
      lastUserScrollAt = now;
    }
    if (!suppressSyncScrollTop) {
      batch(() => {
        setScrollTop(top);
        setViewportHeight(currentViewportHeight);
      });
    }
    scheduleStickyPreviewViewportState(top, currentViewportHeight);
    const decision = resolveAutoScrollOnUserScroll({
      top,
      distanceFromBottom: distance,
      nearBottom:
        distance < AUTO_SCROLL_THRESHOLD_PX &&
        (autoScrollEnabled || distance <= REATTACH_THRESHOLD_PX),
      autoScroll: autoScroll(),
      userScrolledUp: now - lastWheelUpAt <= 160,
      bottomTargetStable,
      followModeLocked,
      expectedScrollTop,
      lastObservedScrollTop,
      ignoreScrollUntil,
      now,
      autoScrollThresholdPx: AUTO_SCROLL_THRESHOLD_PX,
    });
    const scrollDelta = top - lastObservedScrollTop;
    const shouldReattachToBottom =
      !autoScrollEnabled && distance <= REATTACH_THRESHOLD_PX && scrollDelta >= 0;
    if (decision.shouldCancelPendingScroll) {
      pinnedToBottom = false;
    } else if (distance < AUTO_SCROLL_THRESHOLD_PX) {
      pinnedToBottom = true;
    }
    lastObservedScrollTop = decision.nextLastObservedScrollTop;
    expectedScrollTop = decision.nextExpectedScrollTop;
    ignoreScrollUntil = decision.nextIgnoreScrollUntil;
    followModeLocked = decision.nextFollowModeLocked;
    if (decision.shouldCancelPendingScroll) cancelPendingScroll();
    if (decision.nextAutoScroll !== null) setAutoScroll(decision.nextAutoScroll);
    if (shouldReattachToBottom) {
      const sessionId = state.activeSessionId;
      setAutoScroll(true);
      queueMicrotask(() => {
        if (sessionId && state.activeSessionId !== sessionId) return;
        performScroll({ force: true });
        if (sessionId) startFollowLoop(sessionId);
      });
    }
  }

  function onWheel(event: WheelEvent) {
    lastWheelAt = performance.now();
    if (containerRef && event.deltaY > 0.5) {
      const top = containerRef.scrollTop;
      const maxScrollTop = getEditMaxScrollTop(top);
      if (maxScrollTop !== null && top + event.deltaY >= maxScrollTop - 1) {
        containerRef.scrollTop = maxScrollTop;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (initialScrollRafId) {
      cancelAnimationFrame(initialScrollRafId);
      initialScrollRafId = 0;
    }
    if (event.deltaY < -0.5) {
      lastWheelUpAt = lastWheelAt;
      followModeLocked = false;
      pinnedToBottom = false;
      expectedScrollTop = -1;
      ignoreScrollUntil = 0;
      cancelPendingScroll();
      if (autoScroll()) setAutoScroll(false);
    }
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
    lastContainerOffsetWidth = containerRef.offsetWidth;
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
        setMeasuredHeightsFor(entries);
      });
    }

    lastObservedScrollTop = containerRef.scrollTop ?? 0;
    if (!trackRef) return;
    lastTrackHeight = trackRef.getBoundingClientRect().height;
    lastAutoScrolledTrackHeight = lastTrackHeight;
    const observer = new ResizeObserver(() => {
      if (!containerRef) return;
      const currentContainerOffsetWidth = containerRef.offsetWidth;
      if (currentContainerOffsetWidth !== lastContainerOffsetWidth) {
        lastContainerOffsetWidth = currentContainerOffsetWidth;
        if (shouldMeasureRows()) {
          measuredHeights.clear();
          setMeasurementVersion((version) => version + 1);
        }
        updateScrollbarInset();
      }
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
      if (stickyPreviewDebounceTimer) clearTimeout(stickyPreviewDebounceTimer);
      clearLoadingRowReappearTimer();
      clearLoadingRowReserveReleaseTimer();
      clearTrailingSummarySettleTimer();
      if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);
      cancelScheduledMeasurement();
      activeFollowLoopSessionId = null;
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
    stickyPreviewScrollTop();
    const current = untrack(stickyUserMessagePreview);
    if (!current) return;
    if (shouldHideStickyUserMessagePreviewImmediately(current)) {
      setStickyUserMessagePreview(null);
      previousStickyPreviewId = current.id;
      previousStickyPreviewBounds = null;
      if (stickyPreviewDebounceTimer) {
        clearTimeout(stickyPreviewDebounceTimer);
        stickyPreviewDebounceTimer = 0;
      }
    }
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    measuredHeights.clear();
    setMeasurementVersion((version) => version + 1);
    pendingInitialScrollSessionId = sessionId;
    cancelPendingScroll();
    pendingScrollToBottomRequest = false;
    expectedScrollTop = -1;
    ignoreScrollUntil = 0;
    followModeLocked = false;
    pinnedToBottom = true;
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
        startFollowLoop(sessionId);
        return;
      }

      if (sessionId && (autoScroll() || pendingScrollToBottomRequest)) {
        if (pendingScrollToBottomRequest) {
          pendingScrollToBottomRequest = false;
          setAutoScroll(true);
        }
        performScroll();
        startFollowLoop(sessionId);
      }
    });
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    const currentStreamingTextLength = streamingTextLength();
    if (!sessionId || currentStreamingTextLength === 0 || (!autoScroll() && !pinnedToBottom))
      return;

    queueMicrotask(() => {
      if (state.activeSessionId !== sessionId || (!autoScroll() && !pinnedToBottom)) return;
      followModeLocked = true;
      setAutoScroll(true);
      startFollowLoop(sessionId, { immediate: true });
    });
  });

  createEffect((previousRequestKey: number | undefined) => {
    const sessionId = state.activeSessionId;
    const requestKey = messageListScrollRequestKey();
    if (previousRequestKey === undefined) return requestKey;
    if (!sessionId || !containerRef) return requestKey;

    pendingScrollToBottomRequest = true;
    followModeLocked = true;
    lastWheelAt = Number.NEGATIVE_INFINITY;
    lastUserScrollAt = Number.NEGATIVE_INFINITY;
    lastWheelUpAt = Number.NEGATIVE_INFINITY;
    setAutoScroll(true);
    queueMicrotask(() => {
      if (state.activeSessionId !== sessionId) return;
      performScroll({ force: true });
      startFollowLoop(sessionId);
    });
    return requestKey;
  });

  createEffect(() => {
    if (!shouldMeasureRows()) return;
    const { start, end } = visibleRange();
    queueMicrotask(() => {
      if (!shouldMeasureRows()) return;
      scheduleVisibleMeasurement();
    });
    void start;
    void end;
  });

  let prevLoading = isLoading();
  createEffect(() => {
    const loading = isLoading();
    if (prevLoading && !loading && autoScroll()) {
      const sessionId = state.activeSessionId;
      queueMicrotask(() => {
        if (!sessionId || state.activeSessionId !== sessionId) return;
        performScroll();
      });
    }
    prevLoading = loading;
  });

  const modelChangeMap = createMemo(() => {
    messageInfoVersion();
    const providerMap = new Map(state.providers.map((p) => [p.id, p]));
    const messagesSnapshot = messages();
    return untrack(() => {
      const result = new Map<string, string>();
      let prevProvider: string | undefined;
      let prevModel: string | undefined;
      let prevVariant: string | undefined;
      for (const msg of messagesSnapshot) {
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
    () => new Map<string, AssistantFileEditStackGroup | null>()
  );

  const assistantDialogSummaryMap = createMemo(() => {
    messageStructureVersion();
    const activeStatusType = state.activeSessionId
      ? state.sessionStatus[state.activeSessionId]?.type
      : undefined;
    const suppressTrailingSummary =
      activeSessionWorking() ||
      activeStatusType === 'busy' ||
      activeStatusType === 'retry' ||
      !trailingSummarySettled();
    return untrack(() =>
      getAssistantDialogSummaryMap(state.messages, renderedMessageIds(), {
        suppressTrailingSummary,
      })
    );
  });
  const highlightedAssistantMessageIds = createMemo(() => {
    messageStructureVersion();
    const activeStatusType = state.activeSessionId
      ? state.sessionStatus[state.activeSessionId]?.type
      : undefined;
    const suppressTrailingSummary =
      activeSessionWorking() ||
      activeStatusType === 'busy' ||
      activeStatusType === 'retry' ||
      !trailingSummarySettled();
    return untrack(
      () =>
        new Set(
          getAssistantDialogSummaryMap(state.messages, undefined, {
            suppressTrailingSummary,
          }).keys()
        )
    );
  });
  const hasBuildAgent = createMemo(() => state.agents.some((agent) => agent.name === 'build'));
  const showJumpToLatest = createMemo(() => {
    if (autoScroll() || messages().length === 0) return false;
    if (editingMessage()) return false;
    // Reactive triggers for the DOM-based distance read below; measurement
    // version covers content growing below the viewport without scrolling.
    scrollTop();
    viewportHeight();
    measurementVersion();
    return distanceFromBottom() > JUMP_TO_LATEST_MIN_HIDDEN_CONTENT_PX;
  });

  function scrollMessageIntoView(preview: StickyUserMessagePreview) {
    if (!containerRef) return;
    const row = [...containerRef.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
      (element) => element.dataset.msgId === preview.id
    );
    if (row) {
      row.scrollIntoView({ block: 'start' });
      return;
    }
    if (shouldVirtualize()) {
      containerRef.scrollTop = virtualMetrics().prefix[preview.index] ?? 0;
    }
  }

  function handleStickyPreviewEdit(preview: StickyUserMessagePreview) {
    if (activeSessionWorking()) return;
    const entry =
      messages()[preview.index]?.info.id === preview.id
        ? messages()[preview.index]
        : messages().find((candidate) => candidate.info.id === preview.id);
    if (!entry || entry.info.role !== 'user') return;
    if (entry.info.sessionID !== state.activeSessionId) return;
    if (!hasUserMessageEditableContent(entry.parts)) return;
    setAutoScroll(false);
    scrollMessageIntoView(preview);
    startEditingMessage(
      entry.info.id,
      entry.info.sessionID,
      getUserMessageEditText(entry.parts),
      getUserMessageEditContext(entry.parts)
    );
  }

  function handleStickyPreviewClick(preview: StickyUserMessagePreview) {
    if (activeSessionWorking()) {
      scrollMessageIntoView(preview);
      return;
    }

    handleStickyPreviewEdit(preview);
  }

  const stickyPreviewTitle = () =>
    activeSessionWorking() ? 'Click to scroll to message' : 'Click to edit message';

  return (
    <div class="interactive-list-shell min-h-0 flex-1">
      <div
        ref={containerRef}
        class={`interactive-list min-h-0 flex-1 overflow-y-auto${showModelPicker() ? ' showing-model-picker' : ''}${editingMessage() ? ' editing-message' : ''}`}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        onWheel={onWheel}
        onScroll={onScroll}
      >
        <div
          ref={trackRef}
          class={`interactive-list-track${shouldVirtualize() ? ' virtualized' : ''}${editingMessage() ? ' editing-message' : ''}`}
        >
          <Show when={showStickyUserPrompt() && stickyUserMessagePreview()}>
            {(preview) => (
              <StickyUserMessagePreviewCard
                preview={preview()}
                title={stickyPreviewTitle()}
                onClick={handleStickyPreviewClick}
              />
            )}
          </Show>
          <Show
            when={state.messages.length > 0}
            fallback={
              <Show when={shouldShowStarterLogo()}>
                <div class="chat-empty-state">
                  <Show when={state.emptyStateLogoUri}>
                    <img
                      class="chat-empty-logo"
                      src={state.emptyStateLogoUri}
                      alt=""
                      aria-hidden="true"
                      draggable="false"
                    />
                  </Show>
                  <div class="chat-empty-hints">
                    <span class="chat-empty-hint">
                      <kbd>@</kbd> add files and agents
                    </span>
                    <span class="chat-empty-hint">
                      <kbd>/</kbd> run commands
                    </span>
                    <span class="chat-empty-hint">
                      <kbd>Shift</kbd>
                      <kbd>Enter</kbd> new line
                    </span>
                  </div>
                </div>
              </Show>
            }
          >
            <VirtualizedContent
              messages={messages()}
              modelChangeMap={modelChangeMap()}
              lastAssistantID={lastAssistantID()}
              outerListVirtualized={shouldVirtualize()}
              previousTrailingFileEventSignatureMap={previousTrailingFileEventSignatureMap()}
              fileEditStackGroupMap={assistantStackGroupMap()}
              assistantDialogSummaryMap={assistantDialogSummaryMap()}
              highlightedAssistantMessageIds={highlightedAssistantMessageIds()}
              hasBuildAgent={hasBuildAgent()}
              latestPlanImplementationMessageId={latestPlanImplementationMessageId()}
              visibleRange={visibleRange()}
              observeMeasuredRow={observeMeasuredRow}
              isPlanningAssistantMessage={isPlanningAssistantMessage}
              questionRequestForTool={getQuestionRequestForTool}
              permissionMatchForTool={getPermissionMatchForTool}
              shouldShowPlanImplementationAction={shouldShowPlanImplementationAction}
              buildPlanImplementationPrompt={buildPlanImplementationPrompt}
              buildPlanDocumentContent={buildPlanDocumentContent}
            />
          </Show>
          <Show when={!editingMessage()}>
            <PendingActionRows
              questions={standaloneQuestions()}
              permissions={standalonePermissions()}
            />
          </Show>
          <Show when={reserveLoadingRow() && !editingMessage()}>
            <LoadingRow compacting={isSessionCompacting()} visible={showLoadingRow()} />
          </Show>
        </div>
      </div>
      <ChatContentBottomFade />
      <Show when={showJumpToLatest()}>
        <button
          type="button"
          class="jump-to-latest-button"
          aria-label="Scroll to latest message"
          title="Scroll to latest message"
          onClick={() => requestMessageListScrollToBottom()}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
            <path
              d="M3.5 6.5 8 11l4.5-4.5"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </Show>
    </div>
  );
}

export function getAssistantDialogSummaryMap(
  messages: Array<{ info: Message; parts: Part[] }>,
  targetMessageIds?: ReadonlySet<string>,
  options?: { suppressTrailingSummary?: boolean }
) {
  const result = new Map<string, AssistantDialogSummaryInfo>();
  let childRunsByParentId: Map<string, Array<{ info: AssistantMessage; parts: Part[] }>> | null =
    null;
  let currentMessages: AssistantMessage[] = [];
  let currentPrimaryMessageIds: string[] = [];
  let currentSubagentHandoffCount = 0;
  let currentUserRequestCreated: number | null = null;

  const flush = (args?: { trailing?: boolean }) => {
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

    if (args?.trailing && options?.suppressTrailingSummary) {
      currentMessages = [];
      currentPrimaryMessageIds = [];
      currentSubagentHandoffCount = 0;
      currentUserRequestCreated = null;
      return;
    }

    if (targetMessageIds && !targetMessageIds.has(lastMessage.id)) {
      currentMessages = [];
      currentPrimaryMessageIds = [];
      currentSubagentHandoffCount = 0;
      currentUserRequestCreated = null;
      return;
    }

    const lastEntry = messages.find((entry) => entry.info.id === lastMessage.id);
    if (lastEntry?.parts.some((part) => part.type === 'tool' && part.state.status === 'running')) {
      currentMessages = [];
      currentPrimaryMessageIds = [];
      currentSubagentHandoffCount = 0;
      currentUserRequestCreated = null;
      return;
    }

    childRunsByParentId ||= getChildRunsByParentId(messages);

    const aggregateMessages = collectAssistantDialogMessages(
      currentMessages,
      childRunsByParentId,
      new Set(currentMessages.map((message) => message.sessionID))
    );
    const completedMessages = aggregateMessages.filter((message) => !!message.time.completed);
    const end = Math.max(...completedMessages.map((message) => message.time.completed || 0));
    const tokens = sumAssistantTokens(aggregateMessages);
    const childRunCount = countAssistantDialogChildRuns(
      currentPrimaryMessageIds,
      childRunsByParentId
    );
    const agentCount = Math.max(childRunCount, currentSubagentHandoffCount);
    result.set(lastMessage.id, {
      durationMs: Math.max(
        0,
        end - (currentUserRequestCreated ?? currentMessages[0]!.time.created)
      ),
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
    if (assistant.mode === 'subagent') continue;

    currentMessages.push(assistant);
    currentPrimaryMessageIds.push(assistant.id);
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

  flush({ trailing: true });
  return result;
}

function collectAssistantDialogMessages(
  messages: AssistantMessage[],
  childRunsByParentId: Map<string, Array<{ info: AssistantMessage; parts: Part[] }>>,
  parentSessionIds: ReadonlySet<string>
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

    if (!parentSessionIds.has(message.sessionID)) continue;
    for (const child of childRunsByParentId.get(message.sessionID) || []) {
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

function LoadingRow(props: { compacting: boolean; visible: boolean }) {
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
    <div
      class={`interactive-item-container interactive-response interactive-loading-row${
        props.visible ? '' : ' is-reserved'
      }`}
      aria-hidden={props.visible ? undefined : true}
    >
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
