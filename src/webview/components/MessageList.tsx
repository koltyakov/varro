import {
  Show,
  batch,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import {
  isSessionAwaitingInput,
  state,
  isLoading,
  stopLoading,
  hasActiveQuestion,
  hasActivePermission,
  isSessionCompacting,
  loadingStartedAt,
  loadingLastActivityAt,
  messageListScrollRequestKey,
  requestMessageListScrollToBottom,
  getActiveUsageLimitNotice,
  isActiveSessionWorking,
  getSessionTreeRootId,
  messageStructureVersion,
  messageInfoVersion,
  showModelPicker,
  compactToolOutput,
  showInlineFileChanges,
} from '../lib/state';
import {
  getAssistantActivityGroupMap,
  isAssistantActivityPart,
  isAssistantEditActivityPart,
  preserveAssistantActivityGroupKeys,
  type AssistantActivityGroupInfo,
} from '../lib/assistant-activity';
import { isAssistantMessage } from '../lib/message-metrics';
import {
  getFinalAssistantTextPartId,
  isWorkspaceDirectoryText,
  shouldShowAssistantPartInline,
} from '../lib/part-utils';
import { shouldDisplayUsageLimitNotice } from '../lib/usage-limit';
import type { AssistantMessage, MessageEntry, Part } from '../types';
import type { AssistantFileEditStackGroup } from './Message';
import { editingMessage } from '../lib/message-edit-state';
import { hasExpandedDiffOverlay } from '../lib/diff-overlay-state';
import {
  getPrefetchedSessionHistory,
  getSessionHistoryPrompts,
  isSessionHistoryLoadFailed,
  isSessionHistoryTruncated,
  markSessionHistoryLoadFailed,
  mergeOlderHistory,
} from '../lib/message-window';
import {
  loadOlderSessionHistoryPage,
  loadOlderSessionPrompts,
  recheckSessionStatus,
} from '../hooks/useOpenCode';
import { modelSupportsReasoning } from '../lib/model-capabilities';
import { formatLabelWithProvider, formatModelName, formatVariantLabel } from '../lib/format';
import {
  collapseLeadingDuplicateFileEvents,
  getTrailingFileEventSignature,
} from '../lib/message-event-collapse';
import { getToolInlineFileChangesLayoutSignature } from '../lib/tool-file-change';
import {
  buildPermissionRequestLookup,
  buildQuestionRequestLookup,
  getToolCallLookupKey,
} from '../lib/tool-call-matching';
import {
  getMessageBlockExpanded,
  trackMessageBlockExpansionState,
} from '../lib/tool-call-expansion-state';
import {
  ChatContentBottomFade,
  PendingActionRows,
  StickyUserMessagePreviewCard,
} from './message-list/MessageListChrome';
import {
  getStickyUserMessagePreview,
  hasStickyUserMessageContent,
  isMessageHiddenBehindStickyPreview,
  STICKY_PREVIEW_MIN_VIEWPORT_HEIGHT_PX,
  shouldShowStickyUserMessagePreview,
  type StickyUserMessagePreview,
} from './message-list/sticky-preview';
import {
  findStreamingPart,
  hasCommittedVisibleTextAsLastPart,
  hasVisibleBlockingStreamingPart,
} from './message-list/streaming';
import {
  alignBlockSizeToPixel,
  buildVirtualMetrics,
  calculateVirtualRangeFromMetrics,
  getFirstVisibleMessageIndexFromVirtualMetrics,
  pruneMeasuredHeights,
  type VisibleRange,
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
import { VirtualizedContent } from './message-list/VirtualizedContent';
import { deduplicateFileEdits } from './message/AssistantMessageContent';
import {
  getLinkedToolCallKeys,
  getStandalonePermissionPrompts,
  getStandaloneQuestionPrompts,
} from './message-list/pending-prompts';
import {
  getRenderedMessages,
  getVisibleThreadMessages,
  hasVisibleRunningToolPart,
} from './message-list/thread-visibility';
import {
  buildPlanDocumentContent,
  buildPlanImplementationPrompt,
  getLatestPlanImplementationMessageId,
  isPlanningAssistantMessage,
  shouldShowPlanImplementationAction,
} from './message-list/plan-actions';
import { getAssistantDialogSummaryMap } from './message-list/assistant-dialog';

function showTruncatedHistoryBanner() {
  return !editingMessage() && isSessionHistoryTruncated(state.activeSessionId);
}

function historyLoadFailed() {
  return !editingMessage() && isSessionHistoryLoadFailed(state.activeSessionId);
}

const VIRTUALIZE_THRESHOLD = 50;

const STICKY_PREVIEW_DISPLAY_DEBOUNCE_MS = 90;
const WIDTH_RESIZE_SETTLE_MS = 100;
const APPEND_SCROLL_TRANSITION_MS = 180;
const EXPANSION_SCROLL_ANCHOR_WINDOW_MS = 250;
const LOADING_ROW_REAPPEAR_DELAY_MS = 600;
const LOADING_ROW_RESERVE_RELEASE_DELAY_MS = 600;
const TRAILING_SUMMARY_SETTLE_DELAY_MS = 700;
// Only offer "jump to latest" when at least this much content is hidden
// below the viewport; a barely-scrolled list doesn't need the button.
const JUMP_TO_LATEST_MIN_HIDDEN_CONTENT_PX = 240;
const EMPTY_VISIBLE_RANGE: VisibleRange = {
  start: 0,
  end: 0,
  topPad: 0,
  bottomPad: 0,
  coreStart: 0,
  coreEnd: 0,
};

type VisibleScrollAnchor = {
  messageId: string;
  top: number;
  topPad: number;
  renderKey?: string;
};

function visibleRangesEqual(previous: VisibleRange, next: VisibleRange) {
  return (
    previous.start === next.start &&
    previous.end === next.end &&
    previous.topPad === next.topPad &&
    previous.bottomPad === next.bottomPad &&
    previous.coreStart === next.coreStart &&
    previous.coreEnd === next.coreEnd
  );
}

function waitForAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

export function getInlinePreviewLayoutSignatures(
  messages: readonly { info: { id: string }; parts: readonly Part[] }[],
  enabled: boolean
) {
  const signatures = new Map<string, string>();
  if (!enabled) return signatures;

  for (const message of messages) {
    const partSignatures: string[] = [];
    for (const part of message.parts) {
      if (part.type !== 'tool') continue;
      const signature = getToolInlineFileChangesLayoutSignature(part.tool, part.state);
      if (signature) partSignatures.push(`${part.id}:${signature}`);
    }
    if (partSignatures.length > 0) {
      signatures.set(message.info.id, partSignatures.join('\u0000'));
    }
  }
  return signatures;
}

export function getCompactActivityLayoutSignatures(
  messages: readonly {
    info: { id: string; role: 'user' | 'assistant' };
    parts: readonly Part[];
  }[],
  enabled: boolean
) {
  const signatures = new Map<string, string>();
  if (!enabled) return signatures;

  for (const message of messages) {
    if (message.info.role !== 'assistant') continue;
    const activityPartIds = message.parts.flatMap((part) =>
      isAssistantActivityPart(part) ? [part.id] : []
    );
    if (activityPartIds.length > 0) {
      signatures.set(message.info.id, activityPartIds.join('\u0000'));
    }
  }
  return signatures;
}

export function getCompactActivityDisclosureLayoutSignatures(
  groups: ReadonlyMap<string, readonly AssistantActivityGroupInfo[]>,
  isExpanded: (key: string) => boolean
) {
  return new Map(
    [...groups].map(([messageId, messageGroups]) => [
      messageId,
      messageGroups
        .map(
          (group) =>
            `${group.key}\u0000${group.ownerMessageId}\u0000${group.ownerPartId}\u0000${isExpanded(group.key) ? 'expanded' : 'collapsed'}`
        )
        .join('\u0001'),
    ])
  );
}

export function getChangedInlinePreviewMessageIds(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  currentMessageIds: ReadonlySet<string>
) {
  return [...new Set([...previous.keys(), ...current.keys()])].filter(
    (messageId) =>
      currentMessageIds.has(messageId) && previous.get(messageId) !== current.get(messageId)
  );
}

export function getNewlyAppendedMessageIds(
  previousIds: readonly string[],
  currentIds: readonly string[]
) {
  if (currentIds.length <= previousIds.length) return [];
  if (!previousIds.every((id, index) => currentIds[index] === id)) return [];
  return currentIds.slice(previousIds.length);
}

export function getPromptNumberMap(messages: readonly MessageEntry[]) {
  const result = new Map<string, number>();
  let promptNumber = 0;
  for (const message of messages) {
    if (message.info.role !== 'user') continue;
    promptNumber += 1;
    result.set(message.info.id, promptNumber);
  }
  return result;
}

export function MessageList() {
  // oxlint-disable-next-line no-unassigned-vars
  let containerRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let trackRef: HTMLDivElement | undefined;
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [showPromptNumbers, setShowPromptNumbers] = createSignal(false);
  const [promptNumberReadySessionIds, setPromptNumberReadySessionIds] = createSignal<
    ReadonlySet<string>
  >(new Set());
  const promptNumberLoads = new Map<string, Promise<void>>();
  let promptNumberSessionId: string | null = null;
  let altHeld = false;
  let disposed = false;

  function ensurePromptNumbersReady(sessionId: string) {
    const existing = promptNumberLoads.get(sessionId);
    if (existing) return existing;

    const load = (async () => {
      while (await loadOlderSessionPrompts(sessionId)) {
        // Continue until the prompt cursor reaches the beginning of the session.
      }
      if (disposed) return;
      setPromptNumberReadySessionIds((current) => new Set(current).add(sessionId));
    })().finally(() => promptNumberLoads.delete(sessionId));
    promptNumberLoads.set(sessionId, load);
    return load;
  }

  function showPromptNumbersForAlt() {
    if (altHeld) return;
    altHeld = true;
    setShowPromptNumbers(true);
    const sessionId = state.activeSessionId;
    if (sessionId) void ensurePromptNumbersReady(sessionId);
  }

  function hidePromptNumbersForAlt() {
    altHeld = false;
    setShowPromptNumbers(false);
  }

  const handleAltDown = (event: KeyboardEvent) => {
    if (event.key === 'Alt') showPromptNumbersForAlt();
  };
  const handleAltUp = (event: KeyboardEvent) => {
    if (event.key === 'Alt') hidePromptNumbersForAlt();
  };
  const syncAltState = (event: MouseEvent) => {
    if (event.altKey) showPromptNumbersForAlt();
    else hidePromptNumbersForAlt();
  };
  window.addEventListener('keydown', handleAltDown);
  window.addEventListener('keyup', handleAltUp);
  window.addEventListener('mousemove', syncAltState);
  window.addEventListener('blur', hidePromptNumbersForAlt);
  onCleanup(() => {
    disposed = true;
    altHeld = false;
    window.removeEventListener('keydown', handleAltDown);
    window.removeEventListener('keyup', handleAltUp);
    window.removeEventListener('mousemove', syncAltState);
    window.removeEventListener('blur', hidePromptNumbersForAlt);
  });
  createEffect(() => {
    const sessionId = state.activeSessionId;
    if (sessionId !== promptNumberSessionId) {
      promptNumberSessionId = sessionId;
      if (sessionId) {
        setPromptNumberReadySessionIds((current) => {
          if (!current.has(sessionId)) return current;
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
      }
    }
    if (!showPromptNumbers() || !sessionId || promptNumberReadySessionIds().has(sessionId)) return;
    void ensurePromptNumbersReady(sessionId);
  });
  const promptNumbersVisible = createMemo(() => {
    const sessionId = state.activeSessionId;
    return !!sessionId && showPromptNumbers() && promptNumberReadySessionIds().has(sessionId);
  });
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
  let appendScrollRafId = 0;
  let appendScrollSessionId: string | null = null;
  let pendingMeasuredAppendScroll = false;
  let pendingMeasuredAppendAnchor: VisibleScrollAnchor | null = null;
  let pendingScrollToBottomRequest = false;
  let deferredScrollToBottomRequestKey: number | null = null;
  let followModeLocked = false;
  let previousStickyPreviewId: string | null = null;
  let previousStickyPreviewBounds: { top: number; bottom: number } | null = null;
  let upwardStickyHandoff: {
    messageId: string;
    releaseTop: number;
    sourceEntered: boolean;
    lastInputAt: number;
  } | null = null;
  let upwardStickyHandoffReleaseTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let stickyJumpSettleEpoch = 0;
  const [stickyNavigationInProgress, setStickyNavigationInProgress] = createSignal(false);
  let editRevealEpoch = 0;
  let historyOwnedEdit: { messageId: string; sessionId: string } | null = null;
  let pendingExpansionScrollAnchor: ExpansionScrollAnchor | null = null;
  let stickyPreviewDebounceTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let firstVisibleMessageObserver: IntersectionObserver | null = null;
  let measuredRowObserver: ResizeObserver | null = null;
  let measurementRafId = 0;
  let measurementScheduled = false;
  let pendingMeasurementAfterResize = false;
  let pendingMeasurementAfterWidthResize = false;
  let pendingMeasurementAfterContentResize = false;
  let suppressSyncScrollTop = false;
  let stickyPreviewFrameRafId = 0;
  let stickyPreviewFrameScheduled = false;
  let stickyPreviewViewportStatePending = false;
  let pendingStickyPreviewScrollTop = 0;
  let pendingStickyPreviewViewportHeight = 0;
  let stickyPreviewGeometryRefreshPending = false;
  let forceStickyPreviewGeometryRefresh = false;
  let lastScrollbarInset = -1;
  let lastContainerClientHeight = -1;
  let lastContainerFontSize = -1;
  let lastTrackInlineSize = -1;
  let lastAutoScrolledTrackHeight = 0;
  let lastAutoScrolledBottomScrollTop = 0;
  let lastWheelAt = Number.NEGATIVE_INFINITY;
  let lastUserScrollAt = Number.NEGATIVE_INFINITY;
  let lastUserOwnedScrollMovementAt = Number.NEGATIVE_INFINITY;
  let lastWheelUpAt = Number.NEGATIVE_INFINITY;
  let lastScrollInputAt = Number.NEGATIVE_INFINITY;
  let userScrollOwnershipEpoch = 0;
  let activeSessionGeneration = 0;
  let historyAnchorSettleOwner: { sessionId: string; generation: number } | null = null;
  let previousAutoScrollEnabled = true;
  let pinnedToBottom = true;
  let activeFollowLoopSessionId: string | null = null;
  const activeOlderHistoryLoads = new Map<string, { generation: number; promise: Promise<void> }>();
  const pendingOlderHistoryAnchors = new Map<
    string,
    {
      anchor: VisibleScrollAnchor | null;
      generation: number;
      invalidated: boolean;
      owner: 'history' | 'edit';
      previousScrollHeight: number;
      previousScrollTop: number;
      ownershipEpoch: number;
    }
  >();
  let pendingStructuralScrollAnchor: {
    anchor: VisibleScrollAnchor;
    sessionId: string | null;
    ownershipEpoch: number;
  } | null = null;
  let pointerScrollOwnershipActive = false;
  let diffFocusPauseActive = false;
  let resumeAutoScrollAfterDiffFocus = false;
  let widthResizeActive = false;
  let widthResizeIncludesFontChange = false;
  let widthResizeSettleTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let widthResizeEpoch = 0;
  let pendingWidthMeasurementPublish = false;
  let pendingWidthStickyRefresh = false;
  let pendingWidthFollowCorrection = false;
  const AUTO_SCROLL_THRESHOLD_PX = 60;
  const REATTACH_THRESHOLD_PX = 10;
  const PROGRAMMATIC_SCROLL_WINDOW_MS = 200;
  const ACTIVE_WHEEL_WINDOW_MS = 180;
  const SCROLL_INPUT_WINDOW_MS = 500;
  const OVERLAY_SCROLLBAR_HIT_WIDTH_PX = 16;
  const USER_SCROLL_IDLE_MS = 240;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [appendBottomReserve, setAppendBottomReserve] = createSignal(0);
  const [measurementVersion, setMeasurementVersion] = createSignal(0);
  const [trackLayoutVersion, setTrackLayoutVersion] = createSignal(0);
  const [hasBootstrappedVirtualization, setHasBootstrappedVirtualization] = createSignal(false);
  const [stickyPreviewGeometryVersion, setStickyPreviewGeometryVersion] = createSignal(0);
  const [stickyUserMessagePreview, setStickyUserMessagePreview] =
    createSignal<StickyUserMessagePreview | null>(null);
  const [pendingStickyJump, setPendingStickyJump] = createSignal<{
    sessionId: string;
    preview: StickyUserMessagePreview;
  } | null>(null);
  const displayedStickyUserMessagePreview = createMemo(
    () => pendingStickyJump()?.preview ?? stickyUserMessagePreview()
  );

  function stickyNavigationOwnsScroll() {
    return stickyNavigationInProgress() || pendingStickyJump() !== null;
  }
  const [stickyPreviewScrollTop, setStickyPreviewScrollTop] = createSignal(0);
  const [stickyPreviewViewportHeight, setStickyPreviewViewportHeight] = createSignal(0);
  const [reserveLoadingRow, setReserveLoadingRow] = createSignal(false);
  const [showLoadingRow, setShowLoadingRow] = createSignal(false);
  const [trailingSummarySettled, setTrailingSummarySettled] = createSignal(true);
  const [loadingOlderHistorySessionIds, setLoadingOlderHistorySessionIds] = createSignal<
    ReadonlySet<string>
  >(new Set());
  const activeUsageLimit = createMemo(() => {
    const notice = getActiveUsageLimitNotice(state.activeSessionId);
    return notice && shouldDisplayUsageLimitNotice(notice) ? notice : null;
  });
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
  const mountedMessageRows = new Map<string, HTMLDivElement>();
  let previousVisibleStructureSessionId: string | null = null;
  let previousVisibleStructureMessageIds: readonly string[] | null = null;
  const messages = createMemo(() => {
    messageStructureVersion();
    const sessionId = state.activeSessionId;
    const canCaptureAnchor =
      previousVisibleStructureMessageIds !== null &&
      previousVisibleStructureSessionId === sessionId &&
      untrack(() => genericStructuralAnchorCanOwnScroll(sessionId));
    const anchor = canCaptureAnchor ? captureMountedVisibleScrollAnchor() : null;
    const visibleMessages = getVisibleThreadMessages(state.messages, sessionId, state.sessions);
    const currentIds = visibleMessages.map((entry) => entry.info.id);
    const previousIds = previousVisibleStructureMessageIds;
    const structureChanged =
      previousIds !== null &&
      (previousIds.length !== currentIds.length ||
        previousIds.some((id, index) => id !== currentIds[index]));
    const pureAppend =
      previousIds !== null &&
      currentIds.length >= previousIds.length &&
      previousIds.every((id, index) => currentIds[index] === id);
    previousVisibleStructureSessionId = sessionId;
    previousVisibleStructureMessageIds = currentIds;

    if (structureChanged && !pureAppend && anchor && !pendingStructuralScrollAnchor) {
      scheduleStructuralScrollAnchorRestore(anchor, sessionId);
    }
    return visibleMessages;
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
  const visibleRunningToolPart = createMemo(() => {
    messageStructureVersion();
    return untrack(() => hasVisibleRunningToolPart(messages()));
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
    const result = new Map<string, number>();
    for (const [index, entry] of messages().entries()) result.set(entry.info.id, index);
    return result;
  });
  const promptNumberMap = createMemo(() =>
    getPromptNumberMap(
      mergeOlderHistory(messages(), getSessionHistoryPrompts(state.activeSessionId))
    )
  );

  function clearObservedVisibleMessages() {
    observedVisibleMessageBounds.clear();
  }

  function syncObservedVisibleMessages() {
    if (!firstVisibleMessageObserver || !containerRef || shouldVirtualize()) return;
    firstVisibleMessageObserver.disconnect();
    clearObservedVisibleMessages();
    for (const row of mountedMessageRows.values()) {
      firstVisibleMessageObserver.observe(row);
    }
  }

  function cancelScheduledStickyPreviewFrame() {
    stickyPreviewFrameScheduled = false;
    stickyPreviewViewportStatePending = false;
    stickyPreviewGeometryRefreshPending = false;
    forceStickyPreviewGeometryRefresh = false;
    if (!stickyPreviewFrameRafId) return;
    cancelAnimationFrame(stickyPreviewFrameRafId);
    stickyPreviewFrameRafId = 0;
  }

  function flushStickyPreviewFrame() {
    stickyPreviewFrameScheduled = false;
    stickyPreviewFrameRafId = 0;
    const viewportStatePending = stickyPreviewViewportStatePending;
    stickyPreviewViewportStatePending = false;
    const geometryRefreshPending = stickyPreviewGeometryRefreshPending;
    stickyPreviewGeometryRefreshPending = false;
    const forceRefresh = forceStickyPreviewGeometryRefresh;
    forceStickyPreviewGeometryRefresh = false;
    const viewportChanged =
      viewportStatePending &&
      (pendingStickyPreviewScrollTop !== untrack(stickyPreviewScrollTop) ||
        pendingStickyPreviewViewportHeight !== untrack(stickyPreviewViewportHeight));
    const publishGeometry = geometryRefreshPending && (!widthResizeActive || forceRefresh);

    if (geometryRefreshPending && !publishGeometry) {
      pendingWidthStickyRefresh = true;
    }

    if (viewportChanged || publishGeometry) {
      batch(() => {
        if (viewportChanged) {
          setStickyPreviewScrollTop(pendingStickyPreviewScrollTop);
          setStickyPreviewViewportHeight(pendingStickyPreviewViewportHeight);
        }
        if (publishGeometry) {
          setStickyPreviewGeometryVersion((version) => version + 1);
        }
      });
      return;
    }

    if (geometryRefreshPending && widthResizeActive) {
      const current = untrack(stickyUserMessagePreview);
      if (!current || !shouldHideStickyUserMessagePreviewImmediately(current)) return;

      setStickyUserMessagePreview(null);
      previousStickyPreviewId = current.id;
      previousStickyPreviewBounds = null;
      if (stickyPreviewDebounceTimer) {
        clearTimeout(stickyPreviewDebounceTimer);
        stickyPreviewDebounceTimer = 0;
      }
    }
  }

  function scheduleStickyPreviewFrame() {
    if (stickyPreviewFrameScheduled) return;

    stickyPreviewFrameScheduled = true;
    const rafId = requestAnimationFrame(flushStickyPreviewFrame);
    stickyPreviewFrameRafId = stickyPreviewFrameScheduled ? rafId : 0;
  }

  function scheduleStickyPreviewViewportState(nextScrollTop: number, nextViewportHeight: number) {
    pendingStickyPreviewScrollTop = nextScrollTop;
    pendingStickyPreviewViewportHeight = nextViewportHeight;
    stickyPreviewViewportStatePending = true;
    scheduleStickyPreviewFrame();
  }

  function scheduleStickyPreviewGeometryRefresh(options?: { force?: boolean }) {
    if (options?.force) forceStickyPreviewGeometryRefresh = true;
    stickyPreviewGeometryRefreshPending = true;
    scheduleStickyPreviewFrame();
  }

  function publishPendingWidthMeasurements() {
    if (!pendingWidthMeasurementPublish) return false;
    pendingWidthMeasurementPublish = false;
    publishMeasurementVersion();
    return true;
  }

  function finishWidthResize(epoch: number) {
    if (epoch !== widthResizeEpoch) return;
    widthResizeSettleTimer = 0;
    widthResizeActive = false;
    widthResizeIncludesFontChange = false;

    const refreshStickyPreview = pendingWidthStickyRefresh;
    const correctBottom = pendingWidthFollowCorrection;
    pendingWidthStickyRefresh = false;
    pendingWidthFollowCorrection = false;
    publishPendingWidthMeasurements();

    if (refreshStickyPreview) {
      scheduleStickyPreviewGeometryRefresh({ force: true });
    }

    if (!correctBottom) return;
    requestAnimationFrame(() => {
      if (
        epoch !== widthResizeEpoch ||
        !autoScroll() ||
        stickyNavigationOwnsScroll() ||
        editingMessage()
      ) {
        return;
      }
      performScroll();
      const sessionId = state.activeSessionId;
      if (sessionId) startFollowLoop(sessionId);
    });
  }

  function beginWidthResize(options?: { fontChanged?: boolean }) {
    widthResizeActive = true;
    widthResizeIncludesFontChange ||= !!options?.fontChanged;
    pendingWidthStickyRefresh = true;
    if (autoScroll()) pendingWidthFollowCorrection = true;
    const contentFollowRequired = !!(
      state.streamingPartId ||
      state.streamingText.length > 0 ||
      visibleRunningToolPart() ||
      pendingExpansionScrollAnchor
    );
    if (!contentFollowRequired && activeFollowLoopSessionId && initialScrollRafId) {
      cancelAnimationFrame(initialScrollRafId);
      initialScrollRafId = 0;
      activeFollowLoopSessionId = null;
    }
    if (widthResizeSettleTimer) clearTimeout(widthResizeSettleTimer);
    const epoch = widthResizeEpoch;
    widthResizeSettleTimer = setTimeout(() => finishWidthResize(epoch), WIDTH_RESIZE_SETTLE_MS);
  }

  function cancelWidthResize() {
    widthResizeEpoch += 1;
    if (widthResizeSettleTimer) clearTimeout(widthResizeSettleTimer);
    widthResizeSettleTimer = 0;
    widthResizeActive = false;
    widthResizeIncludesFontChange = false;
    pendingWidthMeasurementPublish = false;
    pendingWidthStickyRefresh = false;
    pendingWidthFollowCorrection = false;
  }

  function finishWidthResizeNow() {
    if (!widthResizeActive) return;
    if (widthResizeSettleTimer) clearTimeout(widthResizeSettleTimer);
    finishWidthResize(widthResizeEpoch);
  }

  const measuredHeights = new Map<string, number>();
  const zeroHeightRenderContentSignatures = new Map<string, string>();
  const measuredRowInlineSizes = new WeakMap<HTMLElement, number>();
  const appliedRowHeightCorrections = new WeakMap<HTMLElement, number>();
  const pendingRowHeightCorrections = new Map<HTMLElement, number>();
  let rowHeightCorrectionScheduled = false;
  let lastTrackHeight = 0;
  let cachedVirtualMetrics: VirtualMetrics | null = null;
  let cachedVirtualMetricsItemIds: string[] | null = null;
  let dirtyVirtualMetricsFromIndex = Number.POSITIVE_INFINITY;
  let previousResizeMessageIds: readonly string[] | null = null;
  let loadingRowReappearTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let loadingRowReserveReleaseTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let trailingSummarySettleTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let loadingRowHiddenByVisibleStream = false;
  let appendBottomReserveTarget = 0;

  function flushRowHeightCorrections() {
    rowHeightCorrectionScheduled = false;
    for (const [element, correction] of pendingRowHeightCorrections) {
      if (!element.isConnected) continue;
      if (Math.abs((appliedRowHeightCorrections.get(element) ?? 0) - correction) < 0.001) {
        continue;
      }
      if (correction > 0) {
        element.style.setProperty('--interactive-item-block-correction', `${correction}px`);
      } else {
        element.style.removeProperty('--interactive-item-block-correction');
      }
      appliedRowHeightCorrections.set(element, correction);
    }
    pendingRowHeightCorrections.clear();
  }

  function alignMeasuredRowBlockSize(element: HTMLElement, measuredBlockSize: number) {
    const appliedCorrection = appliedRowHeightCorrections.get(element) ?? 0;
    const naturalBlockSize = Math.max(0, measuredBlockSize - appliedCorrection);
    const alignedBlockSize = alignBlockSizeToPixel(naturalBlockSize);
    const correction = Math.max(0, alignedBlockSize - naturalBlockSize);
    const pendingCorrection = pendingRowHeightCorrections.get(element);
    if (pendingCorrection !== undefined && Math.abs(pendingCorrection - correction) < 0.001) {
      return alignedBlockSize;
    }
    if (pendingCorrection === undefined && Math.abs(appliedCorrection - correction) < 0.001) {
      return alignedBlockSize;
    }
    pendingRowHeightCorrections.set(element, correction);
    if (!rowHeightCorrectionScheduled) {
      rowHeightCorrectionScheduled = true;
      queueMicrotask(flushRowHeightCorrections);
    }
    return alignedBlockSize;
  }

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
  const claimedEntranceMessageIds = new Set<string>();
  const revealedFlowItemKeys = new Map<string, Set<string>>();

  // Eager computation: entering ids must be captured per update flush. A lazy memo
  // would collapse "appended while scrolled up" and "scrolled back down" into one
  // recompute and wrongly animate the off-screen message when it mounts.
  const [enteringMessageIds, setEnteringMessageIds] = createSignal<ReadonlySet<string>>(new Set());
  let entranceSessionId: string | null = null;
  let previousEntranceMessageIds: readonly string[] = [];
  let awaitingInitialTranscriptPopulation = false;
  let assistantItemRevealReady = false;
  let assistantItemRevealReadyVersion = 0;

  function scheduleAssistantItemRevealReady(sessionId: string | null) {
    const version = ++assistantItemRevealReadyVersion;
    queueMicrotask(() => {
      if (version !== assistantItemRevealReadyVersion || state.activeSessionId !== sessionId)
        return;
      assistantItemRevealReady = true;
    });
  }

  createComputed(() => {
    const sessionId = state.activeSessionId;
    const currentMessageIds = messageIds();
    if (sessionId !== entranceSessionId) {
      entranceSessionId = sessionId;
      previousEntranceMessageIds = currentMessageIds;
      awaitingInitialTranscriptPopulation = currentMessageIds.length === 0;
      claimedEntranceMessageIds.clear();
      revealedFlowItemKeys.clear();
      assistantItemRevealReady = false;
      assistantItemRevealReadyVersion += 1;
      if (!awaitingInitialTranscriptPopulation) {
        scheduleAssistantItemRevealReady(sessionId);
      }
      setEnteringMessageIds(new Set<string>());
      return;
    }

    if (awaitingInitialTranscriptPopulation && currentMessageIds.length > 0) {
      awaitingInitialTranscriptPopulation = false;
      previousEntranceMessageIds = currentMessageIds;
      assistantItemRevealReady = false;
      scheduleAssistantItemRevealReady(sessionId);
      setEnteringMessageIds(new Set<string>());
      return;
    }

    // Only animate appends in unmeasured lists. A height animation would feed
    // intermediate sizes into virtual metrics while bottom-follow is settling.
    const appendedMessageIds = autoScroll()
      ? getNewlyAppendedMessageIds(previousEntranceMessageIds, currentMessageIds)
      : [];
    if (appendedMessageIds.length > 0 && currentMessageIds.length >= VIRTUALIZE_THRESHOLD) {
      pendingMeasuredAppendScroll = true;
      pendingMeasuredAppendAnchor ??= captureVisibleScrollAnchor();
    }
    const appendedIds = currentMessageIds.length < VIRTUALIZE_THRESHOLD ? appendedMessageIds : [];
    previousEntranceMessageIds = currentMessageIds;
    setEnteringMessageIds(new Set(appendedIds));
  });

  createEffect(() => {
    const currentIds = new Set(messageIds());
    for (const id of claimedEntranceMessageIds) {
      if (!currentIds.has(id)) claimedEntranceMessageIds.delete(id);
    }
    for (const id of revealedFlowItemKeys.keys()) {
      if (!currentIds.has(id)) revealedFlowItemKeys.delete(id);
    }
  });

  function claimMessageEntrance(messageId: string) {
    if (!enteringMessageIds().has(messageId) || claimedEntranceMessageIds.has(messageId)) {
      return false;
    }
    claimedEntranceMessageIds.add(messageId);
    return true;
  }

  function claimAssistantItemReveal(messageId: string, renderKey: string) {
    let keys = revealedFlowItemKeys.get(messageId);
    if (!keys) {
      keys = new Set();
      revealedFlowItemKeys.set(messageId, keys);
    }
    if (keys.has(renderKey)) return false;
    keys.add(renderKey);
    return assistantItemRevealReady;
  }

  const inlinePreviewLayoutSignatures = createMemo(() =>
    getInlinePreviewLayoutSignatures(messages(), showInlineFileChanges())
  );
  let previousInlinePreviewLayoutSignatures = new Map<string, string>();
  const compactActivityLayoutSignatures = createMemo(() =>
    getCompactActivityLayoutSignatures(messages(), compactToolOutput())
  );
  let previousCompactActivityLayoutSignatures = new Map<string, string>();

  // Bootstrap exact heights once, then keep virtualization active as new rows arrive. Newly added
  // rows use provisional heights until mounted instead of remounting the full transcript.
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

  createEffect(() => {
    if (!shouldMeasureRows()) {
      setHasBootstrappedVirtualization(false);
      return;
    }
    if (hasMeasuredAllRows()) setHasBootstrappedVirtualization(true);
  });

  const shouldVirtualize = createMemo(
    () => shouldMeasureRows() && (hasBootstrappedVirtualization() || hasMeasuredAllRows())
  );

  createEffect(() => {
    const currentMessageIds = messageIds();
    const idsChanged =
      previousResizeMessageIds !== null &&
      (previousResizeMessageIds.length !== currentMessageIds.length ||
        previousResizeMessageIds.some((id, index) => id !== currentMessageIds[index]));
    previousResizeMessageIds = currentMessageIds;
    if (idsChanged && widthResizeActive) {
      cancelWidthResize();
      scheduleStickyPreviewGeometryRefresh({ force: true });
    }
    if (pruneMeasuredHeights(measuredHeights, currentMessageIds)) {
      setMeasurementVersion((version) => version + 1);
    }
    const currentMessageIdSet = new Set(currentMessageIds);
    for (const messageId of zeroHeightRenderContentSignatures.keys()) {
      if (!currentMessageIdSet.has(messageId)) {
        zeroHeightRenderContentSignatures.delete(messageId);
      }
    }
  });

  function scheduleChangedLayoutRowMeasurements(
    previous: ReadonlyMap<string, string>,
    current: ReadonlyMap<string, string>
  ) {
    const currentMessageIds = new Set(messageIds());
    const mountedRows: Array<{ element: HTMLDivElement; messageId: string }> = [];
    let invalidatedUnmountedHeight = false;

    for (const messageId of getChangedInlinePreviewMessageIds(
      previous,
      current,
      currentMessageIds
    )) {
      const mountedRow = trackRef?.querySelector<HTMLDivElement>(
        `[data-msg-id="${CSS.escape(messageId)}"]`
      );
      if (!mountedRow) {
        if (!measuredHeights.delete(messageId)) continue;
        zeroHeightRenderContentSignatures.delete(messageId);
        markVirtualMetricsDirty(messageId);
        invalidatedUnmountedHeight = true;
        continue;
      }
      mountedRows.push({ element: mountedRow, messageId });
    }

    const activeSessionId = state.activeSessionId;
    const invalidatedAnchorOwnershipEpoch = userScrollOwnershipEpoch;
    const invalidatedAnchor =
      invalidatedUnmountedHeight &&
      !autoScroll() &&
      !followModeLocked &&
      !pendingScrollToBottomRequest &&
      appendScrollRafId === 0 &&
      !stickyNavigationOwnsScroll() &&
      !editingMessage() &&
      !pendingExpansionScrollAnchor &&
      !pendingStructuralScrollAnchor &&
      !diffFocusPauseActive &&
      !(activeSessionId && pendingOlderHistoryAnchors.has(activeSessionId))
        ? captureVisibleScrollAnchor()
        : null;
    const publishChangedLayout = () => {
      publishMeasurementVersion();
      if (!invalidatedAnchor) return;
      queueMicrotask(() => {
        if (
          userScrollOwnershipEpoch === invalidatedAnchorOwnershipEpoch &&
          !stickyNavigationOwnsScroll() &&
          !pendingExpansionScrollAnchor
        ) {
          restoreVisibleScrollAnchor(invalidatedAnchor);
        }
      });
    };

    if (mountedRows.length === 0) {
      if (invalidatedUnmountedHeight) publishChangedLayout();
      return;
    }

    queueMicrotask(() => {
      const connectedRows = mountedRows.filter(
        ({ element, messageId }) =>
          element.isConnected && mountedMessageRows.get(messageId) === element
      );
      const measuredMountedHeight = measureMountedRows(connectedRows, false);
      if (!measuredMountedHeight && !invalidatedUnmountedHeight) return;
      publishChangedLayout();
      scheduleStickyPreviewGeometryRefresh({ force: true });
      scheduleVisibleMeasurement({ afterResize: true });
    });
  }

  createEffect(() => {
    const current = inlinePreviewLayoutSignatures();
    scheduleChangedLayoutRowMeasurements(previousInlinePreviewLayoutSignatures, current);

    previousInlinePreviewLayoutSignatures = new Map(current);
  });

  createEffect(() => {
    const current = compactActivityLayoutSignatures();
    scheduleChangedLayoutRowMeasurements(previousCompactActivityLayoutSignatures, current);

    previousCompactActivityLayoutSignatures = new Map(current);
  });

  createEffect(() => {
    messageStructureVersion();
    const currentStreamingPartId = state.streamingPartId;
    const currentStreamingText = state.streamingText;

    let changed = false;
    for (const [messageId, previousSignature] of zeroHeightRenderContentSignatures) {
      const currentSignature = getMessageRenderContentSignature(
        messageId,
        currentStreamingPartId,
        currentStreamingText
      );
      if (currentSignature === previousSignature) continue;
      measuredHeights.delete(messageId);
      zeroHeightRenderContentSignatures.delete(messageId);
      markVirtualMetricsDirty(messageId);
      changed = true;
    }
    if (changed) publishMeasurementVersion();
  });

  const hasIncompleteLatestVisibleAssistantReply = createMemo(() => {
    messageInfoVersion();
    const latest = messages().at(-1)?.info;
    return !!latest && isAssistantMessage(latest) && !latest.time.completed && !latest.error;
  });

  const trailingFinalResponseReady = createMemo(() => {
    messageStructureVersion();
    messageInfoVersion();
    if (state.streamingPartId || state.streamingText.length > 0) return false;

    const entries = messages();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.info.role === 'user') return false;
      if (entry.info.mode === 'subagent') continue;
      if (!entry.info.time.completed) return false;

      const finalTextPartId = getFinalAssistantTextPartId(entry.parts, true);
      if (!finalTextPartId) return false;
      const finalTextPartIndex = entry.parts.findIndex((part) => part.id === finalTextPartId);
      const finalTextPart = entry.parts[finalTextPartIndex];
      return (
        finalTextPart?.type === 'text' &&
        !isWorkspaceDirectoryText(finalTextPart.text.trimStart()) &&
        !entry.parts.slice(finalTextPartIndex + 1).some((part) => part.type === 'tool')
      );
    }
    return false;
  });

  const loadingRowEligible = createMemo(
    () =>
      !!state.activeSessionId &&
      (activeSessionWorking() || hasIncompleteLatestVisibleAssistantReply()) &&
      !hasActiveQuestion() &&
      !hasActivePermission() &&
      !activeUsageLimit()
  );

  const shouldShowLoadingRow = createMemo(
    () =>
      loadingRowEligible() &&
      (!visibleBlockingStreamingPart() || visibleRunningToolPart()) &&
      (!committedTextBlocksReappear() || visibleRunningToolPart())
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
      if (!trailingSummarySettled()) {
        clearLoadingRowReserveReleaseTimer();
        return;
      }
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

  const visibleRange = createMemo<VisibleRange>(
    () => {
      const msgs = messages();
      loadingOlderHistorySessionIds();
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
      const metrics = virtualMetrics();
      const range = calculateVirtualRangeFromMetrics({
        metrics,
        scrollTop: scrollTop(),
        viewportHeight: viewportHeight(),
      });
      const sessionId = state.activeSessionId;
      const pendingAnchor = sessionId ? pendingOlderHistoryAnchors.get(sessionId) : undefined;
      const anchorIndex =
        pendingAnchor && !pendingAnchor.invalidated && pendingAnchor.anchor
          ? messageIndexById().get(pendingAnchor.anchor.messageId)
          : undefined;
      if (anchorIndex === undefined) return range;

      // A prepend can temporarily place the old viewport thousands of provisional pixels away.
      // Keep its real anchor mounted so exact DOM geometry is available before the next paint.
      const start = Math.min(range.start, anchorIndex);
      const end = Math.max(range.end, anchorIndex + 1);
      return {
        start,
        end,
        coreStart: Math.min(range.coreStart, anchorIndex),
        coreEnd: Math.max(range.coreEnd, anchorIndex + 1),
        topPad: metrics.prefix[start] ?? 0,
        bottomPad: metrics.totalHeight - (metrics.prefix[end] ?? 0),
      };
    },
    EMPTY_VISIBLE_RANGE,
    { equals: visibleRangesEqual }
  );

  function widthResizeNeedsRangeRefresh() {
    if (!containerRef || !shouldVirtualize()) return false;
    const ids = untrack(messageIds);
    const range = untrack(visibleRange);
    const firstId = ids[range.start];
    const lastId = ids[range.end - 1];
    const firstRow = firstId ? mountedMessageRows.get(firstId) : undefined;
    const lastRow = lastId ? mountedMessageRows.get(lastId) : undefined;
    if (!firstRow || !lastRow) return true;

    const containerRect = containerRef.getBoundingClientRect();
    if (range.start > 0 && firstRow.getBoundingClientRect().top > containerRect.top + 1) {
      return true;
    }
    return (
      range.end < ids.length && lastRow.getBoundingClientRect().bottom < containerRect.bottom - 1
    );
  }
  const renderedMessages = createMemo(() =>
    getRenderedMessages(messages(), visibleRange(), shouldVirtualize())
  );
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

  createEffect(() => {
    clearTrailingSummarySettleTimer();

    if (activeSessionWorking() || !trailingFinalResponseReady()) {
      if (trailingSummarySettled()) setTrailingSummarySettled(false);
      return;
    }

    if (trailingSummarySettled()) return;

    trailingSummarySettleTimer = setTimeout(() => {
      trailingSummarySettleTimer = 0;
      if (!activeSessionWorking() && trailingFinalResponseReady()) {
        batch(() => {
          setTrailingSummarySettled(true);
          if (!loadingRowEligible()) setReserveLoadingRow(false);
        });
      }
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
    // Sticky state must follow current painted geometry. IntersectionObserver bounds can remain
    // stale while a fully visible prompt moves or an assistant row grows. Geometry changes are
    // explicitly coalesced so row measurement publication does not rerun this DOM pass by itself.
    stickyPreviewGeometryVersion();
    const throttledViewportHeight = stickyPreviewViewportHeight();
    const currentViewportHeight =
      throttledViewportHeight > 0 ? throttledViewportHeight : viewportHeight();
    const currentScrollTop = throttledViewportHeight > 0 ? stickyPreviewScrollTop() : scrollTop();
    if (!containerRef || currentViewportHeight < STICKY_PREVIEW_MIN_VIEWPORT_HEIGHT_PX) {
      return null;
    }

    const virtualized = shouldVirtualize();
    const currentVisibleRange = untrack(() =>
      virtualized
        ? calculateVirtualRangeFromMetrics({
            metrics: virtualMetrics(),
            scrollTop: currentScrollTop,
            viewportHeight: currentViewportHeight,
          })
        : visibleRange()
    );
    const containerRect = containerRef.getBoundingClientRect();
    let firstVisibleMessageIndex: number | null = null;
    const visibleMessages = messages();
    const mountedStart = virtualized ? currentVisibleRange.start : 0;
    const mountedEnd = virtualized ? currentVisibleRange.end : visibleMessages.length;

    for (let index = mountedStart; index < mountedEnd; index += 1) {
      const row = mountedMessageRows.get(visibleMessages[index]?.info.id ?? '');
      if (!row) continue;
      const rowRect = row.getBoundingClientRect();
      const rowTop = rowRect.top - containerRect.top;
      const rowBottom = rowRect.bottom - containerRect.top;
      if (rowBottom <= 0 || rowTop >= currentViewportHeight) continue;
      firstVisibleMessageIndex =
        index > 0 && rowTop > 0 && visibleMessages[index]?.info.role === 'user' ? index - 1 : index;
      break;
    }

    if (firstVisibleMessageIndex === null && virtualized) {
      firstVisibleMessageIndex = getFirstVisibleMessageIndexFromVirtualMetrics({
        metrics: untrack(virtualMetrics),
        scrollTop: currentScrollTop,
      });
    }

    let preview = getStickyUserMessagePreview(visibleMessages, firstVisibleMessageIndex);
    let usesBoundaryPrompt = false;
    if (
      !preview &&
      firstVisibleMessageIndex !== null &&
      visibleMessages[firstVisibleMessageIndex]?.info.role === 'assistant'
    ) {
      const loadedMessageIds = new Set(visibleMessages.map((entry) => entry.info.id));
      const boundaryPrompt = getSessionHistoryPrompts(state.activeSessionId)
        .toReversed()
        .find((entry) => !loadedMessageIds.has(entry.info.id));
      if (boundaryPrompt) {
        const boundaryPreview = getStickyUserMessagePreview(
          [boundaryPrompt, visibleMessages[firstVisibleMessageIndex]!],
          1
        );
        if (boundaryPreview) {
          preview = { ...boundaryPreview, index: -1 };
          usesBoundaryPrompt = true;
        }
      }
    }
    if (!preview) return null;

    const previewElement = getStickyUserMessageSourceElement(preview.id);
    const rowRect = previewElement?.getBoundingClientRect();
    const nextUserMessageTop = getStickyUserMessageNextUserMessageTop(preview.index, containerRect);
    const stickyPreviewBounds =
      previousStickyPreviewId === preview.id
        ? (getStickyUserMessagePreviewBounds(containerRect) ?? previousStickyPreviewBounds)
        : null;
    const shouldShow = shouldShowStickyUserMessagePreview({
      preview,
      shouldVirtualize: virtualized || usesBoundaryPrompt,
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

  function getMessageRenderContentSignature(
    messageId: string,
    currentStreamingPartId = state.streamingPartId,
    currentStreamingText = state.streamingText
  ) {
    const index = messageIndexById().get(messageId);
    const message = index === undefined ? undefined : messages()[index];
    if (!message) return null;
    const streamingText = message.parts.some((part) => part.id === currentStreamingPartId)
      ? currentStreamingText
      : null;
    return JSON.stringify([message.info, message.parts, streamingText]);
  }

  function shouldAcceptRowHeight(element: HTMLElement, messageId: string, height: number) {
    if (height !== 0) {
      zeroHeightRenderContentSignatures.delete(messageId);
      return true;
    }
    if (element.childElementCount > 0 || element.textContent?.trim()) return false;

    const signature = getMessageRenderContentSignature(messageId);
    if (signature === null) return false;
    zeroHeightRenderContentSignatures.set(messageId, signature);
    return true;
  }

  function measureVisibleItems() {
    if (!shouldMeasureRows()) return false;
    if (!trackRef) return;
    const items = trackRef.querySelectorAll<HTMLElement>('[data-msg-id]');
    const measuredRects = [...items].map((element) => element.getBoundingClientRect());
    const measuredHeightsFromLayout = measuredRects.map((rect) => rect.height);
    const hasLayoutMeasurements = measuredHeightsFromLayout.some((height) => height > 0);
    const noLayoutFallbackHeight = hasLayoutMeasurements
      ? 0
      : Math.max(1, Math.floor((containerRef?.scrollHeight || 0) / Math.max(1, items.length))) ||
        160;
    let changed = false;
    items.forEach((el, index) => {
      const id = el.dataset.msgId;
      if (!id) return;
      measuredRowInlineSizes.set(el, measuredRects[index]?.width ?? 0);
      const measuredHeight = hasLayoutMeasurements
        ? measuredHeightsFromLayout[index]!
        : noLayoutFallbackHeight;
      const h = alignMeasuredRowBlockSize(el, measuredHeight);
      if (!shouldAcceptRowHeight(el, id, h)) return;
      if ((measuredHeights.get(id) ?? -1) !== h) {
        measuredHeights.set(id, h);
        markVirtualMetricsDirty(id);
        changed = true;
      }
    });
    if (changed) scheduleMeasurementPublish('content');
    return changed;
  }

  function measureMountedRows(
    rows: Array<{ element: HTMLDivElement; messageId: string }>,
    publish = true
  ) {
    // Tests and no-layout environments may never deliver ResizeObserver entries, so virtualization
    // must not depend on observer callbacks alone.
    const measurements = rows.flatMap(({ element, messageId }) => {
      const rect = element.getBoundingClientRect();
      measuredRowInlineSizes.set(element, rect.width);
      if (rect.height <= 0) return [];
      return [{ messageId, height: alignMeasuredRowBlockSize(element, rect.height) }];
    });
    if (!applyRowHeightMeasurements(measurements)) return false;
    if (publish) scheduleMeasurementPublish('content');
    return true;
  }

  function measureMountedRow(element: HTMLDivElement, messageId: string) {
    return measureMountedRows([{ element, messageId }]);
  }

  function applyRowHeightMeasurements(measurements: Array<{ messageId: string; height: number }>) {
    // ResizeObserver reports after layout. Use the old prefix metrics to offset growth above the
    // viewport before paint, including while the user is actively scrolling.
    const metricsBefore = containerRef && shouldVirtualize() ? virtualMetrics() : null;
    const firstVisibleIndex =
      metricsBefore && containerRef && !autoScroll()
        ? getFirstVisibleMessageIndexFromVirtualMetrics({
            metrics: metricsBefore,
            scrollTop: containerRef.scrollTop,
          })
        : null;
    let scrollAdjustment = 0;
    let changed = false;

    for (const { messageId, height } of measurements) {
      const previousHeight = measuredHeights.get(messageId);
      if ((previousHeight ?? -1) === height) continue;

      if (height > 0) zeroHeightRenderContentSignatures.delete(messageId);

      if (firstVisibleIndex !== null) {
        const index = messageIndexById().get(messageId);
        if (index !== undefined && index < firstVisibleIndex) {
          const previousEffectiveHeight =
            previousHeight ??
            (metricsBefore
              ? metricsBefore.prefix[index + 1]! - metricsBefore.prefix[index]!
              : undefined);
          if (previousEffectiveHeight !== undefined) {
            scrollAdjustment += height - previousEffectiveHeight;
          }
        }
      }

      measuredHeights.set(messageId, height);
      markVirtualMetricsDirty(messageId);
      changed = true;
    }

    if (containerRef && Math.abs(scrollAdjustment) > 0.5) {
      setPreservedScrollTop(containerRef.scrollTop + scrollAdjustment);
    }

    return changed;
  }

  function setMeasuredHeightsFor(entries: ResizeObserverEntry[]) {
    const measurements: Array<{ messageId: string; height: number }> = [];
    let everyInlineSizeChanged = entries.length > 0;
    for (const entry of entries) {
      const element = entry.target as HTMLDivElement;
      const messageId = element.dataset.msgId;
      const borderBoxSize = entry.borderBoxSize?.[0];
      const rect = borderBoxSize ? null : element.getBoundingClientRect();
      const measuredHeight = borderBoxSize?.blockSize ?? rect?.height ?? 0;
      const inlineSize = borderBoxSize?.inlineSize ?? rect?.width ?? 0;
      if (!messageId || !element.isConnected || measuredHeight < 0) continue;

      const previousInlineSize = measuredRowInlineSizes.get(element);
      const inlineSizeChanged =
        previousInlineSize !== undefined && Math.abs(previousInlineSize - inlineSize) > 0.5;
      measuredRowInlineSizes.set(element, inlineSize);
      if (!inlineSizeChanged) everyInlineSizeChanged = false;

      const height = alignMeasuredRowBlockSize(element, measuredHeight);
      if (!shouldAcceptRowHeight(element, messageId, height)) continue;

      measurements.push({
        messageId,
        height,
      });
    }

    let fontChanged = false;
    if (!everyInlineSizeChanged && containerRef) {
      const currentFontSize = parseFloat(getComputedStyle(containerRef).fontSize) || 0;
      fontChanged = currentFontSize !== lastContainerFontSize;
      if (fontChanged) {
        lastContainerFontSize = currentFontSize;
        beginWidthResize({ fontChanged: true });
      }
    }
    let widthReflowOnly = everyInlineSizeChanged || fontChanged || widthResizeIncludesFontChange;

    if (state.streamingPartId || state.streamingText.length > 0 || pendingExpansionScrollAnchor) {
      widthReflowOnly = false;
    }

    if (!applyRowHeightMeasurements(measurements)) return;

    if (widthReflowOnly) beginWidthResize();
    scheduleMeasurementPublish(widthReflowOnly ? 'width' : 'content');
    scheduleStickyPreviewGeometryRefresh({ force: !widthReflowOnly });
    scheduleVisibleMeasurement({ afterResize: true, widthResize: widthReflowOnly });
  }

  function scheduleMeasurementPublish(reason: 'content' | 'width') {
    if (reason === 'width' && shouldVirtualize()) {
      pendingWidthMeasurementPublish = true;
      beginWidthResize();
      return;
    }

    pendingWidthMeasurementPublish = false;
    publishMeasurementVersion();
  }

  function captureMountedVisibleScrollAnchorWithTopPad(
    topPad: number,
    preferStableRenderItem = false
  ) {
    if (!containerRef) return null;

    const containerRect = containerRef.getBoundingClientRect();
    let firstVisibleRow: VisibleScrollAnchor | null = null;
    for (const row of containerRef.querySelectorAll<HTMLElement>('[data-msg-id]')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue;
      const messageId = row.dataset.msgId;
      if (!messageId) continue;
      const rowAnchor = {
        messageId,
        top: rect.top - containerRect.top,
        topPad,
      };
      if (row.classList.contains('interactive-request')) return rowAnchor;
      if (!preferStableRenderItem) return rowAnchor;
      firstVisibleRow ??= rowAnchor;

      // Compact activity summaries can move to an older owner after a prepend. Prefer a part whose
      // render identity and visual position remain attached to the same transcript content.
      for (const element of row.querySelectorAll<HTMLElement>('[data-assistant-render-key]')) {
        const renderKey = element.dataset.assistantRenderKey;
        if (
          !renderKey ||
          renderKey.startsWith('activity-group:') ||
          element.getClientRects().length === 0
        ) {
          continue;
        }
        const elementRect = element.getBoundingClientRect();
        if (
          elementRect.bottom <= containerRect.top ||
          elementRect.top >= containerRect.bottom ||
          elementRect.height <= 0
        ) {
          continue;
        }
        return {
          messageId,
          renderKey,
          top: elementRect.top - containerRect.top,
          topPad,
        };
      }
    }
    return firstVisibleRow;
  }

  function captureVisibleScrollAnchor(options?: { preferStableRenderItem?: boolean }) {
    if (!containerRef) return null;

    const mountedAnchor = captureMountedVisibleScrollAnchorWithTopPad(
      visibleRange().topPad,
      options?.preferStableRenderItem
    );
    if (mountedAnchor) return mountedAnchor;

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

    if (!shouldVirtualize()) return null;

    const metrics = virtualMetrics();
    const index = getFirstVisibleMessageIndexFromVirtualMetrics({
      metrics,
      scrollTop: containerRef.scrollTop,
    });
    const messageId = index === null ? null : messageIds()[index];
    if (index !== null && messageId) {
      return {
        messageId,
        top: (metrics.prefix[index] ?? 0) - containerRef.scrollTop,
        topPad: visibleRange().topPad,
      };
    }
    return null;
  }

  function captureMountedVisibleScrollAnchor() {
    return captureMountedVisibleScrollAnchorWithTopPad(0);
  }

  function genericStructuralAnchorCanOwnScroll(sessionId: string | null) {
    return !(
      disposed ||
      !containerRef ||
      autoScroll() ||
      followModeLocked ||
      pendingScrollToBottomRequest ||
      appendScrollRafId !== 0 ||
      stickyNavigationOwnsScroll() ||
      editingMessage() ||
      pendingExpansionScrollAnchor ||
      diffFocusPauseActive ||
      pointerScrollOwnershipActive ||
      userScrollRecentlyActive() ||
      (sessionId && pendingOlderHistoryAnchors.has(sessionId))
    );
  }

  function scheduleStructuralScrollAnchorRestore(
    anchor: VisibleScrollAnchor,
    sessionId: string | null
  ) {
    const pending = {
      anchor,
      sessionId,
      ownershipEpoch: userScrollOwnershipEpoch,
    };
    pendingStructuralScrollAnchor = pending;
    queueMicrotask(() => {
      if (pendingStructuralScrollAnchor !== pending) return;
      try {
        if (
          state.activeSessionId !== sessionId ||
          userScrollOwnershipEpoch !== pending.ownershipEpoch ||
          !genericStructuralAnchorCanOwnScroll(sessionId)
        ) {
          return;
        }
        restoreVisibleScrollAnchor(anchor, { useMessageOffsetFallback: true });
      } finally {
        if (pendingStructuralScrollAnchor === pending) pendingStructuralScrollAnchor = null;
      }
    });
  }

  function captureMessageScrollAnchor(messageId: string) {
    if (!containerRef) return null;
    const row =
      mountedMessageRows.get(messageId) ??
      containerRef.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`);
    if (!row) return null;
    return {
      messageId,
      top: row.getBoundingClientRect().top - containerRef.getBoundingClientRect().top,
      topPad: visibleRange().topPad,
    };
  }

  function refreshPendingHistoryAnchor(options?: {
    sessionId?: string;
    messageId?: string;
    owner?: 'history' | 'edit';
    advanceOwnership?: boolean;
  }) {
    const sessionId = options?.sessionId ?? state.activeSessionId;
    if (!sessionId || !containerRef) return false;
    const pendingAnchor = pendingOlderHistoryAnchors.get(sessionId);
    if (!pendingAnchor || pendingAnchor.generation !== activeSessionGeneration) return false;
    if (pendingAnchor.invalidated && options?.owner !== 'edit') return false;
    if (options?.advanceOwnership) userScrollOwnershipEpoch += 1;
    if (options?.owner) pendingAnchor.owner = options.owner;
    if (options?.owner === 'edit') pendingAnchor.invalidated = false;

    const editing = editingMessage();
    const preferredMessageId =
      options?.messageId ??
      (pendingAnchor.owner === 'edit' && editing?.sessionId === sessionId
        ? editing.messageId
        : undefined);
    const anchor = preferredMessageId
      ? captureMessageScrollAnchor(preferredMessageId)
      : captureVisibleScrollAnchor({ preferStableRenderItem: true });
    if (!anchor && preferredMessageId) return false;
    pendingAnchor.anchor = anchor;
    pendingAnchor.previousScrollHeight = containerRef.scrollHeight;
    pendingAnchor.previousScrollTop = containerRef.scrollTop;
    pendingAnchor.ownershipEpoch = userScrollOwnershipEpoch;
    return true;
  }

  function getMountedScrollAnchorElement(anchor: VisibleScrollAnchor) {
    if (!containerRef) return null;
    if (anchor.renderKey) {
      return containerRef.querySelector<HTMLElement>(
        `[data-assistant-render-key="${CSS.escape(anchor.renderKey)}"]`
      );
    }
    return (
      mountedMessageRows.get(anchor.messageId) ??
      containerRef.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(anchor.messageId)}"]`)
    );
  }

  function restorePendingHistoryAnchorIfMounted() {
    const sessionId = state.activeSessionId;
    if (!sessionId) return false;
    const pendingAnchor = pendingOlderHistoryAnchors.get(sessionId);
    if (
      !pendingAnchor ||
      pendingAnchor.invalidated ||
      pendingAnchor.generation !== activeSessionGeneration ||
      pendingAnchor.ownershipEpoch !== userScrollOwnershipEpoch ||
      !pendingAnchor.anchor ||
      !getMountedScrollAnchorElement(pendingAnchor.anchor)
    ) {
      return false;
    }
    return restoreVisibleScrollAnchor(pendingAnchor.anchor);
  }

  function restoreVisibleScrollAnchor(
    anchor: VisibleScrollAnchor | null,
    options?: { useMessageOffsetFallback?: boolean }
  ) {
    if (!containerRef) return false;
    let delta: number | null = null;
    if (anchor) {
      const element = getMountedScrollAnchorElement(anchor);
      if (element) {
        const containerRect = containerRef.getBoundingClientRect();
        delta = element.getBoundingClientRect().top - containerRect.top - anchor.top;
      } else if (shouldVirtualize()) {
        if (options?.useMessageOffsetFallback) {
          const index = messageIndexById().get(anchor.messageId);
          if (index !== undefined) {
            delta = (virtualMetrics().prefix[index] ?? 0) - containerRef.scrollTop - anchor.top;
          }
        } else {
          delta = visibleRange().topPad - anchor.topPad;
        }
      }
    }

    if (delta === null) return false;
    if (Math.abs(delta) > 0.5) setPreservedScrollTop(containerRef.scrollTop + delta);
    expectedScrollTop = -1;
    ignoreScrollUntil = 0;
    return true;
  }

  function publishMeasurementVersion() {
    if (!containerRef) {
      setMeasurementVersion((version) => version + 1);
      return;
    }

    if (diffFocusPauseActive || pendingStructuralScrollAnchor) {
      setMeasurementVersion((version) => version + 1);
      return;
    }

    const capturedAutoScroll = autoScroll();
    if (capturedAutoScroll || stickyNavigationOwnsScroll() || userScrollRecentlyActive()) {
      setMeasurementVersion((version) => version + 1);
      return;
    }

    const anchor = captureVisibleScrollAnchor();

    setMeasurementVersion((version) => version + 1);

    queueMicrotask(() => {
      if (!stickyNavigationOwnsScroll()) restoreVisibleScrollAnchor(anchor);
    });
  }

  function observeMeasuredRow(element: HTMLDivElement, messageId: string, active: boolean) {
    if (!active) {
      if (mountedMessageRows.get(messageId) === element) mountedMessageRows.delete(messageId);
      measuredRowObserver?.unobserve(element);
      return;
    }

    mountedMessageRows.set(messageId, element);
    if (element.classList.contains('interactive-request')) {
      const currentStickyPreview = untrack(stickyUserMessagePreview);
      if (
        currentStickyPreview &&
        shouldHideStickyUserMessagePreviewImmediately(currentStickyPreview)
      ) {
        setStickyUserMessagePreview(null);
        previousStickyPreviewId = currentStickyPreview.id;
      }
    }
    if (!shouldMeasureRows() && element.classList.contains('interactive-request')) {
      scheduleStickyPreviewGeometryRefresh();
    }
    if (!shouldMeasureRows()) return;

    measureMountedRow(element, messageId);
    restorePendingHistoryAnchorIfMounted();
    if (element.isConnected && mountedMessageRows.get(messageId) === element) {
      measuredRowObserver?.observe(element);
    }
  }

  function cancelScheduledMeasurement() {
    if (measurementRafId) cancelAnimationFrame(measurementRafId);
    measurementRafId = 0;
    measurementScheduled = false;
    pendingMeasurementAfterResize = false;
    pendingMeasurementAfterWidthResize = false;
    pendingMeasurementAfterContentResize = false;
  }

  function scheduleVisibleMeasurement(options?: { afterResize?: boolean; widthResize?: boolean }) {
    if (options?.afterResize) {
      pendingMeasurementAfterResize = true;
      if (options.widthResize) pendingMeasurementAfterWidthResize = true;
      else pendingMeasurementAfterContentResize = true;
    }
    if (measurementScheduled) return;

    measurementScheduled = true;
    const rafId = requestAnimationFrame(() => {
      measurementScheduled = false;
      measurementRafId = 0;
      const hadResize = pendingMeasurementAfterResize;
      const hadWidthResize = pendingMeasurementAfterWidthResize;
      const hadContentResize = pendingMeasurementAfterContentResize;
      pendingMeasurementAfterResize = false;
      pendingMeasurementAfterWidthResize = false;
      pendingMeasurementAfterContentResize = false;
      if (shouldMeasureRows() && !hasMeasuredAllRows()) measureVisibleItems();
      if (
        hadWidthResize &&
        !hadContentResize &&
        pendingWidthMeasurementPublish &&
        widthResizeNeedsRangeRefresh()
      ) {
        publishPendingWidthMeasurements();
      }
      const previousTrackHeight = lastTrackHeight;
      lastTrackHeight = trackRef?.getBoundingClientRect().height ?? previousTrackHeight;
      // Follow mode owns the viewport; restoring a collapsing control would scroll away from bottom.
      if (hadResize && pendingExpansionScrollAnchor && autoScroll()) {
        pendingExpansionScrollAnchor = null;
        performScroll({ force: true });
        if (hadWidthResize && !hadContentResize && widthResizeActive) {
          pendingWidthFollowCorrection = true;
          return;
        }
        const sessionId = state.activeSessionId;
        if (sessionId) startFollowLoop(sessionId);
        return;
      }
      if (hadResize && restoreExpansionScrollAnchor()) {
        return;
      }
      if (shouldCorrectBottomAfterResize()) {
        performScroll();
        if (hadWidthResize && !hadContentResize && widthResizeActive) {
          pendingWidthFollowCorrection = true;
          return;
        }
        const sessionId = state.activeSessionId;
        if (sessionId) startFollowLoop(sessionId);
      }
    });
    measurementRafId = measurementScheduled ? rafId : 0;
  }

  function getStickyUserMessagePreviewBounds(containerRect: DOMRect) {
    if (!containerRef) return null;
    // The solid gap and fade paint below the card, so collision must use the whole overlay.
    const sticky = containerRef.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
    const stickyRect = sticky?.getBoundingClientRect();
    if (!stickyRect) return null;

    return {
      top: stickyRect.top - containerRect.top,
      bottom: stickyRect.bottom - containerRect.top,
    };
  }

  function handleStickyPreviewGeometryChange() {
    scheduleStickyPreviewGeometryRefresh();
  }

  function getStickyUserMessageSourceElement(messageId: string) {
    const row = mountedMessageRows.get(messageId);
    return row?.querySelector<HTMLElement>('.user-message-card') ?? row;
  }

  function beginUpwardStickyHandoff(messageId: string, sourceEntered: boolean) {
    const containerRect = containerRef?.getBoundingClientRect();
    const releaseTop = containerRect
      ? (getStickyUserMessagePreviewBounds(containerRect)?.bottom ??
        previousStickyPreviewBounds?.bottom ??
        0)
      : 0;
    if (upwardStickyHandoff?.messageId === messageId) {
      upwardStickyHandoff.releaseTop = Math.max(upwardStickyHandoff.releaseTop, releaseTop);
      upwardStickyHandoff.sourceEntered ||= sourceEntered;
      upwardStickyHandoff.lastInputAt = performance.now();
      return;
    }
    upwardStickyHandoff = {
      messageId,
      releaseTop,
      sourceEntered,
      lastInputAt: performance.now(),
    };
  }

  function clearUpwardStickyHandoff() {
    upwardStickyHandoff = null;
    if (!upwardStickyHandoffReleaseTimer) return;
    clearTimeout(upwardStickyHandoffReleaseTimer);
    upwardStickyHandoffReleaseTimer = 0;
  }

  function scheduleUpwardStickyHandoffRelease() {
    if (upwardStickyHandoffReleaseTimer) clearTimeout(upwardStickyHandoffReleaseTimer);
    upwardStickyHandoffReleaseTimer = setTimeout(() => {
      upwardStickyHandoffReleaseTimer = 0;
      if (upwardStickyHandoff) scheduleStickyPreviewGeometryRefresh({ force: true });
    }, ACTIVE_WHEEL_WINDOW_MS);
  }

  function shouldDeferStickyDuringUpwardHandoff() {
    const handoff = upwardStickyHandoff;
    if (!handoff || !containerRef) return false;
    const elapsed = performance.now() - handoff.lastInputAt;

    const source = getStickyUserMessageSourceElement(handoff.messageId);
    if (!source) {
      clearUpwardStickyHandoff();
      return false;
    }

    const containerRect = containerRef.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    if (sourceRect.top - containerRect.top > handoff.releaseTop) {
      clearUpwardStickyHandoff();
      return false;
    }
    if (sourceRect.bottom > containerRect.top) {
      handoff.sourceEntered = true;
      return true;
    }
    if (handoff.sourceEntered || elapsed > ACTIVE_WHEEL_WINDOW_MS) {
      clearUpwardStickyHandoff();
      return false;
    }
    return true;
  }

  function getStickyUserMessageNextUserMessageTop(messageIndex: number, containerRect: DOMRect) {
    if (!containerRef) return null;
    const currentMessages = messages();
    for (let index = messageIndex + 1; index < currentMessages.length; index += 1) {
      const nextMessage = currentMessages[index];
      if (nextMessage?.info.role !== 'user') continue;
      if (!hasStickyUserMessageContent(nextMessage.parts)) continue;

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
    refreshPendingHistoryAnchor({ advanceOwnership: true });
    return true;
  }

  function shouldHideStickyUserMessagePreviewImmediately(
    preview: StickyUserMessagePreview | null,
    geometry?: {
      containerRect: DOMRect;
      stickyBounds: { top: number; bottom: number };
    }
  ) {
    if (!containerRef || !preview) return false;

    const containerRect = geometry?.containerRect ?? containerRef.getBoundingClientRect();
    const stickyBounds = geometry?.stickyBounds ?? getStickyUserMessagePreviewBounds(containerRect);
    if (!stickyBounds) return false;

    const nextUserMessageTop = getStickyUserMessageNextUserMessageTop(preview.index, containerRect);
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

  function setPreservedScrollTop(nextScrollTop: number) {
    if (!containerRef) return;
    suppressSyncScrollTop = true;
    containerRef.scrollTop = Math.max(0, nextScrollTop);
    suppressSyncScrollTop = false;
    lastObservedScrollTop = containerRef.scrollTop;
    batch(() => {
      setScrollTop(containerRef!.scrollTop);
      setViewportHeight(containerRef!.clientHeight);
    });
    scheduleStickyPreviewViewportState(containerRef.scrollTop, containerRef.clientHeight);
  }

  function bottomScrollTop() {
    if (!containerRef) return 0;

    return Math.max(0, containerRef.scrollHeight - containerRef.clientHeight);
  }

  function shouldCorrectBottomAfterResize() {
    if (!containerRef || !autoScroll() || stickyNavigationOwnsScroll()) return false;

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
    if (stickyNavigationOwnsScroll()) return;
    if (appendScrollRafId) return;
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

  function cancelAppendScrollTransition() {
    pendingMeasuredAppendScroll = false;
    pendingMeasuredAppendAnchor = null;
    appendScrollSessionId = null;
    if (!appendScrollRafId) return;
    cancelAnimationFrame(appendScrollRafId);
    appendScrollRafId = 0;
  }

  function reconcileAppendBottomReserve() {
    if (!containerRef) return;
    const reserve = untrack(appendBottomReserve);
    if (reserve <= 0) return;

    const unreservedBottom = Math.max(
      0,
      containerRef.scrollHeight - reserve - containerRef.clientHeight
    );
    const nextReserve = Math.max(0, appendBottomReserveTarget - unreservedBottom);
    if (Math.abs(nextReserve - reserve) <= 0.5) return;
    setAppendBottomReserve(nextReserve);
    if (nextReserve <= 0.5) appendBottomReserveTarget = 0;
  }

  function reserveLostBottomSpace() {
    if (!containerRef || !autoScroll() || !pinnedToBottom || stickyNavigationOwnsScroll()) return;

    const previousBottomTarget = Math.max(lastAutoScrolledBottomScrollTop, lastObservedScrollTop);
    const currentBottomTarget = bottomScrollTop();
    if (currentBottomTarget >= previousBottomTarget - 0.5) return;

    appendBottomReserveTarget = previousBottomTarget;
    setAppendBottomReserve((reserve) => reserve + previousBottomTarget - currentBottomTarget);
    setPreservedScrollTop(previousBottomTarget);
  }

  function consumeBottomReserve(amount: number) {
    if (amount <= 0.5) return;
    const reserve = untrack(appendBottomReserve);
    if (reserve <= 0.5) return;

    const nextReserve = Math.max(0, reserve - amount);
    setAppendBottomReserve(nextReserve);
    if (nextReserve <= 0.5) appendBottomReserveTarget = 0;
  }

  function releaseOffscreenBottomReserve() {
    if (!containerRef || untrack(appendBottomReserve) <= 0.5) return;
    const reserveElement = trackRef?.querySelector<HTMLElement>('.append-scroll-bottom-reserve');
    if (!reserveElement) return;
    if (reserveElement.getBoundingClientRect().top < containerRef.getBoundingClientRect().bottom) {
      return;
    }

    appendBottomReserveTarget = 0;
    setAppendBottomReserve(0);
  }

  function startAppendScrollTransition(sessionId: string) {
    if (!containerRef || stickyNavigationOwnsScroll()) return;
    pendingMeasuredAppendScroll = false;
    if (appendScrollRafId) {
      cancelAnimationFrame(appendScrollRafId);
      appendScrollRafId = 0;
      appendScrollSessionId = null;
    }
    reserveLostBottomSpace();
    const appendAnchor = pendingMeasuredAppendAnchor;
    pendingMeasuredAppendAnchor = null;
    restoreVisibleScrollAnchor(appendAnchor, { useMessageOffsetFallback: true });
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      performScroll({ force: true });
      startFollowLoop(sessionId);
      return;
    }
    if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);
    initialScrollRafId = 0;
    activeFollowLoopSessionId = null;

    const startedAt = performance.now();
    const startTop = containerRef.scrollTop;
    appendScrollSessionId = sessionId;
    followModeLocked = true;
    pinnedToBottom = true;

    // Rows keep their final measured height; only the viewport coordinate moves during the reveal.
    const tick = (now: number) => {
      const container = containerRef;
      if (
        !container ||
        appendScrollSessionId !== sessionId ||
        state.activeSessionId !== sessionId ||
        !autoScroll() ||
        stickyNavigationOwnsScroll()
      ) {
        appendScrollRafId = 0;
        appendScrollSessionId = null;
        return;
      }

      reconcileAppendBottomReserve();
      const target = bottomScrollTop();
      const progress = Math.min(1, Math.max(0, (now - startedAt) / APPEND_SCROLL_TRANSITION_MS));
      const nextTop = startTop + (target - startTop) * progress;
      suppressSyncScrollTop = true;
      container.scrollTop = nextTop;
      suppressSyncScrollTop = false;
      lastObservedScrollTop = container.scrollTop;
      expectedScrollTop = target;
      ignoreScrollUntil = now + PROGRAMMATIC_SCROLL_WINDOW_MS;
      batch(() => {
        setScrollTop(container.scrollTop);
        setViewportHeight(container.clientHeight);
      });
      scheduleStickyPreviewViewportState(container.scrollTop, container.clientHeight);

      if (progress < 1) {
        appendScrollRafId = requestAnimationFrame(tick);
        return;
      }

      appendScrollRafId = 0;
      appendScrollSessionId = null;
      performScroll({ force: true });
      startFollowLoop(sessionId);
    };

    appendScrollRafId = requestAnimationFrame(tick);
  }

  function startPendingAppendScrollTransition(sessionId: string) {
    if (appendScrollSessionId === sessionId && appendScrollRafId) {
      pendingMeasuredAppendScroll = false;
      const appendAnchor = pendingMeasuredAppendAnchor;
      pendingMeasuredAppendAnchor = null;
      restoreVisibleScrollAnchor(appendAnchor, { useMessageOffsetFallback: true });
      return true;
    }
    if (!pendingMeasuredAppendScroll) return false;
    startAppendScrollTransition(sessionId);
    return true;
  }

  function cancelPendingScroll() {
    if (stickyPreviewDebounceTimer) {
      clearTimeout(stickyPreviewDebounceTimer);
      stickyPreviewDebounceTimer = 0;
    }
    if (initialScrollRafId) {
      cancelAnimationFrame(initialScrollRafId);
      initialScrollRafId = 0;
      activeFollowLoopSessionId = null;
    }
    cancelScheduledMeasurement();
    if (activeFollowLoopSessionId) {
      activeFollowLoopSessionId = null;
    }
    cancelAppendScrollTransition();
  }

  function disengageBottomFollow() {
    pendingInitialScrollSessionId = null;
    pendingScrollToBottomRequest = false;
    pendingExpansionScrollAnchor = null;
    followModeLocked = false;
    pinnedToBottom = false;
    pendingWidthFollowCorrection = false;
    expectedScrollTop = -1;
    ignoreScrollUntil = 0;
    cancelPendingScroll();
    if (autoScroll()) setAutoScroll(false);
  }

  function startFollowLoop(sessionId: string, options?: { immediate?: boolean }) {
    if (appendScrollRafId) return;
    if (stickyNavigationOwnsScroll()) {
      activeFollowLoopSessionId = null;
      return;
    }
    if (activeFollowLoopSessionId === sessionId) return;
    if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);

    activeFollowLoopSessionId = sessionId;

    if (options?.immediate) {
      tick();
      return;
    }

    initialScrollRafId = requestAnimationFrame(tick);

    function tick() {
      initialScrollRafId = 0;
      if (!containerRef || !trackRef || stickyNavigationOwnsScroll()) {
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

      if (shouldMeasureRows() && !hasMeasuredAllRows()) measureVisibleItems();

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

      const isStreaming =
        state.streamingText.length > 0 || state.streamingPartId || visibleRunningToolPart();
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
    return Math.max(0, top + rowRect.top - containerRect.top - getMessageJumpTopInset());
  }

  async function keepEditingMessageTopVisible(messageId: string, revealEpoch: number) {
    let stableFrames = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await waitForAnimationFrame();
      if (editRevealEpoch !== revealEpoch || editingMessage()?.messageId !== messageId) return;

      const container = containerRef;
      const row = mountedMessageRows.get(messageId);
      if (!container || !row) return;
      const minimumTop = getMessageJumpTopInset();
      const rowTop = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
      if (rowTop >= minimumTop - 0.5) {
        stableFrames += 1;
        if (stableFrames >= 2) return;
        continue;
      }

      stableFrames = 0;
      setPreservedScrollTop(container.scrollTop + rowTop - minimumTop);
      refreshPendingHistoryAnchor({ messageId, owner: 'edit' });
    }
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
    const scrollDelta = top - lastObservedScrollTop;
    const historyAnchorSettling =
      historyAnchorSettleOwner?.sessionId === state.activeSessionId &&
      historyAnchorSettleOwner.generation === activeSessionGeneration;
    const userScrollInputActive =
      pointerScrollOwnershipActive ||
      now - lastWheelAt <= ACTIVE_WHEEL_WINDOW_MS ||
      now - lastScrollInputAt <= SCROLL_INPUT_WINDOW_MS ||
      now - lastUserOwnedScrollMovementAt <= USER_SCROLL_IDLE_MS;
    const actualScrollMovement = !suppressSyncScrollTop && Math.abs(scrollDelta) > 0.5;
    // Layout-driven scroll events during history settling belong to the history anchor, not the
    // wheel gesture that originally reached the boundary.
    if (actualScrollMovement && !historyAnchorSettling) {
      userScrollOwnershipEpoch += 1;
    }
    if (actualScrollMovement && userScrollInputActive && !historyAnchorSettling) {
      lastUserOwnedScrollMovementAt = now;
      releaseOffscreenBottomReserve();
    }
    const userScrolledUp =
      now - lastWheelUpAt <= 160 ||
      (scrollDelta < -1 && now - lastScrollInputAt <= SCROLL_INPUT_WINDOW_MS);
    const confirmedManualUpwardMovement = scrollDelta < 0 && userScrolledUp;
    if (!autoScrollEnabled || now - lastWheelAt <= ACTIVE_WHEEL_WINDOW_MS || userScrolledUp) {
      lastUserScrollAt = now;
    }
    if (!suppressSyncScrollTop) {
      batch(() => {
        setScrollTop(top);
        setViewportHeight(currentViewportHeight);
      });
    }
    scheduleStickyPreviewViewportState(top, currentViewportHeight);
    const currentStickyPreview = untrack(stickyUserMessagePreview);
    const currentStickySource = currentStickyPreview
      ? getStickyUserMessageSourceElement(currentStickyPreview.id)
      : null;
    // Do not wait for the coalesced sticky pass when a slow scroll reveals the source card.
    if (
      confirmedManualUpwardMovement &&
      currentStickyPreview &&
      currentStickySource &&
      currentStickySource.getBoundingClientRect().bottom > containerRef.getBoundingClientRect().top
    ) {
      beginUpwardStickyHandoff(currentStickyPreview.id, true);
      scheduleUpwardStickyHandoffRelease();
      setStickyUserMessagePreview(null);
      previousStickyPreviewId = currentStickyPreview.id;
    }
    const activeSessionId = state.activeSessionId;
    const pendingHistoryAnchor = activeSessionId
      ? pendingOlderHistoryAnchors.get(activeSessionId)
      : undefined;
    if (
      activeSessionId &&
      pendingHistoryAnchor &&
      !pendingHistoryAnchor.invalidated &&
      !suppressSyncScrollTop &&
      pendingHistoryAnchor.ownershipEpoch !== userScrollOwnershipEpoch
    ) {
      refreshPendingHistoryAnchor({ sessionId: activeSessionId });
    }
    if (userScrolledUp && distance > REATTACH_THRESHOLD_PX) {
      lastWheelUpAt = Number.NEGATIVE_INFINITY;
      lastScrollInputAt = Number.NEGATIVE_INFINITY;
    }
    // Resize corrections can look like downward movement after an upward wheel.
    const shouldReattachToBottom =
      !stickyNavigationOwnsScroll() &&
      !editingMessage() &&
      !autoScrollEnabled &&
      !userScrolledUp &&
      distance <= REATTACH_THRESHOLD_PX &&
      scrollDelta > 1;
    const decision = resolveAutoScrollOnUserScroll({
      top,
      distanceFromBottom: distance,
      nearBottom:
        distance < AUTO_SCROLL_THRESHOLD_PX && (autoScrollEnabled || shouldReattachToBottom),
      autoScroll: autoScroll(),
      userScrolledUp,
      bottomTargetStable,
      followModeLocked,
      expectedScrollTop,
      lastObservedScrollTop,
      ignoreScrollUntil,
      now,
      autoScrollThresholdPx: AUTO_SCROLL_THRESHOLD_PX,
    });
    if (decision.shouldCancelPendingScroll) {
      pinnedToBottom = false;
    } else if (
      distance < AUTO_SCROLL_THRESHOLD_PX &&
      (autoScrollEnabled || shouldReattachToBottom)
    ) {
      pinnedToBottom = true;
    }
    lastObservedScrollTop = decision.nextLastObservedScrollTop;
    expectedScrollTop = decision.nextExpectedScrollTop;
    ignoreScrollUntil = decision.nextIgnoreScrollUntil;
    followModeLocked = decision.nextFollowModeLocked;
    if (confirmedManualUpwardMovement) resumeAutoScrollAfterDiffFocus = false;
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
    if (
      top <= 24 &&
      showTruncatedHistoryBanner() &&
      !stickyNavigationOwnsScroll() &&
      (!autoScrollEnabled || decision.nextAutoScroll === false)
    ) {
      void handleLoadOlderHistory();
    }
  }

  function onWheel(event: WheelEvent) {
    if (widthResizeActive) publishPendingWidthMeasurements();
    if (nestedScrollerWillConsumeWheel(event)) return;
    historyAnchorSettleOwner = null;
    const deltaY = getWheelDeltaPixels(event);
    if (stickyNavigationOwnsScroll()) cancelStickyNavigation();
    if (containerRef && deltaY < -0.5) {
      const currentStickyPreview = untrack(stickyUserMessagePreview);
      const currentStickySource = currentStickyPreview
        ? getStickyUserMessageSourceElement(currentStickyPreview.id)
        : null;
      if (
        currentStickyPreview &&
        currentStickySource &&
        currentStickySource.getBoundingClientRect().bottom - deltaY >
          containerRef.getBoundingClientRect().top
      ) {
        beginUpwardStickyHandoff(currentStickyPreview.id, false);
        setStickyUserMessagePreview(null);
        previousStickyPreviewId = currentStickyPreview.id;
      }
    }
    if (containerRef && deltaY > 0.5) {
      clearUpwardStickyHandoff();
      const top = containerRef.scrollTop;
      const maxScrollTop = getEditMaxScrollTop(top);
      if (maxScrollTop !== null && top + deltaY >= maxScrollTop - 1) {
        containerRef.scrollTop = maxScrollTop;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // A downward wheel at the physical bottom cannot move the transcript. Treating it as an
      // interruption pauses bottom-follow until a later resize snaps the viewport forward.
      if (distanceFromBottom() <= 1) return;
    }
    lastWheelAt = performance.now();
    if (deltaY > 0.5) lastWheelUpAt = Number.NEGATIVE_INFINITY;
    if (initialScrollRafId) {
      cancelAnimationFrame(initialScrollRafId);
      initialScrollRafId = 0;
      activeFollowLoopSessionId = null;
    }
    if (deltaY < -0.5) {
      lastWheelUpAt = lastWheelAt;
      if (upwardStickyHandoff) {
        upwardStickyHandoff.lastInputAt = lastWheelAt;
        scheduleUpwardStickyHandoffRelease();
      }
      if (autoScroll() || pinnedToBottom || followModeLocked) {
        disengageBottomFollow();
        resumeAutoScrollAfterDiffFocus = false;
      }
    }
  }

  function getWheelDeltaPixels(event: WheelEvent) {
    let deltaY = event.deltaY;
    if (event.deltaMode === 1) {
      const styles = containerRef ? getComputedStyle(containerRef) : null;
      deltaY *=
        Number.parseFloat(styles?.lineHeight || '') ||
        (Number.parseFloat(styles?.fontSize || '') || 13) * 1.35;
    } else if (event.deltaMode === 2) {
      deltaY *= containerRef?.clientHeight || 0;
    }
    return deltaY;
  }

  function nestedScrollerWillConsumeWheel(event: WheelEvent) {
    if (!containerRef || !(event.target instanceof Element)) return false;
    const deltaY = getWheelDeltaPixels(event);
    for (let element: Element | null = event.target; element && element !== containerRef;) {
      if (element instanceof HTMLElement) {
        const styles = getComputedStyle(element);
        const overflowY = styles.overflowY;
        const scrollable =
          (overflowY === 'auto' || overflowY === 'scroll') &&
          element.scrollHeight > element.clientHeight + 1;
        if (
          scrollable &&
          (styles.overscrollBehaviorY === 'contain' ||
            styles.overscrollBehaviorY === 'none' ||
            (deltaY < 0 && element.scrollTop > 0) ||
            (deltaY > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 1))
        ) {
          return true;
        }
      }
      element = element.parentElement;
    }
    return false;
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (!containerRef || !(target instanceof Element) || !containerRef.contains(target)) return;
    if (
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    ) {
      return;
    }
    if (
      event.key !== 'ArrowUp' &&
      event.key !== 'ArrowDown' &&
      event.key !== 'PageUp' &&
      event.key !== 'PageDown' &&
      event.key !== 'Home' &&
      event.key !== 'End' &&
      event.key !== ' '
    ) {
      return;
    }
    historyAnchorSettleOwner = null;
    if (stickyNavigationOwnsScroll()) cancelStickyNavigation();
    if (widthResizeActive) publishPendingWidthMeasurements();
    lastScrollInputAt = performance.now();
  }

  function cancelStickyNavigation() {
    deferredScrollToBottomRequestKey = null;
    stickyJumpSettleEpoch += 1;
    setStickyNavigationInProgress(false);
    setPendingStickyJump(null);
  }

  function handlePointerDown(event: PointerEvent) {
    const pointerTarget = event.target;
    if (pointerTarget instanceof Element && pointerTarget.closest('.user-message-card')) {
      cancelStickyNavigation();
    }
    if (
      !containerRef ||
      event.button !== 0 ||
      event.isPrimary === false ||
      containerRef.scrollHeight <= containerRef.clientHeight
    ) {
      return;
    }
    if (event.pointerType !== 'touch') {
      if (event.target !== containerRef) return;

      const rect = containerRef.getBoundingClientRect();
      const layoutWidth = containerRef.offsetWidth;
      if (layoutWidth <= 0 || rect.width <= 0) return;

      const scale = rect.width / layoutWidth;
      const scrollbarInset = Math.max(0, layoutWidth - containerRef.clientWidth);
      const gutterWidth = Math.min(
        rect.width,
        (scrollbarInset || OVERLAY_SCROLLBAR_HIT_WIDTH_PX) * scale
      );
      const inScrollbarGutter =
        getComputedStyle(containerRef).direction === 'rtl'
          ? event.clientX >= rect.left && event.clientX <= rect.left + gutterWidth
          : event.clientX >= rect.right - gutterWidth && event.clientX <= rect.right;
      if (!inScrollbarGutter) return;
    }
    if (widthResizeActive) publishPendingWidthMeasurements();
    if (stickyNavigationOwnsScroll()) cancelStickyNavigation();
    historyAnchorSettleOwner = null;
    pointerScrollOwnershipActive = true;
    lastScrollInputAt = performance.now();
  }

  function releasePointerScrollOwnership() {
    pointerScrollOwnershipActive = false;
  }

  function handleFocusIn(event: FocusEvent) {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.diff-view-lines')) return;

    if (!diffFocusPauseActive) {
      resumeAutoScrollAfterDiffFocus = autoScroll() || followModeLocked || pinnedToBottom;
    }
    diffFocusPauseActive = true;
    pendingExpansionScrollAnchor = null;
    disengageBottomFollow();
  }

  function handleFocusOut(event: FocusEvent) {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.diff-view-lines')) return;

    queueMicrotask(() => {
      const activeElement = document.activeElement;
      if (
        containerRef &&
        activeElement instanceof Element &&
        containerRef.contains(activeElement) &&
        activeElement.closest('.diff-view-lines')
      ) {
        return;
      }

      diffFocusPauseActive = false;
      const shouldResume = resumeAutoScrollAfterDiffFocus;
      resumeAutoScrollAfterDiffFocus = false;
      if (shouldResume) requestMessageListScrollToBottom();
    });
  }

  function handleClickCapture(event: MouseEvent) {
    if (!containerRef) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.user-message-card')) {
      cancelStickyNavigation();
    }
    if (target.closest('.diff-view-filename')) return;
    const control = target.closest<HTMLElement>('[aria-expanded], .diff-view-item-expandable');
    if (!control || !containerRef.contains(control)) return;
    const isDiffToggle = control.matches('.diff-view-toggle, .diff-view-item-expandable');
    const anchor = isDiffToggle
      ? (control.closest<HTMLElement>('.diff-view-item') ?? control)
      : control;
    const expandsCompactActivity =
      control.matches('.assistant-activity-summary') &&
      control.getAttribute('aria-expanded') === 'false';

    if (stickyNavigationOwnsScroll()) cancelStickyNavigation();
    if (isDiffToggle) {
      resumeAutoScrollAfterDiffFocus = false;
      disengageBottomFollow();
    } else if (expandsCompactActivity && (autoScroll() || pinnedToBottom || followModeLocked)) {
      // The disclosure owns this geometry change so its details open below the clicked summary.
      disengageBottomFollow();
    }

    pendingExpansionScrollAnchor = captureExpansionScrollAnchor({
      anchor,
      container: containerRef,
      now: performance.now(),
      windowMs: EXPANSION_SCROLL_ANCHOR_WINDOW_MS,
    });
  }

  function handleExternalLayoutClickCapture(event: MouseEvent) {
    if (!containerRef || !autoScroll() || !pinnedToBottom || stickyNavigationOwnsScroll()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const todoToggle = target.closest<HTMLElement>('.todo-block-header[aria-expanded="true"]');
    const todoList = todoToggle
      ?.closest('.todo-block')
      ?.querySelector<HTMLElement>('.todo-block-list');
    if (!todoList) return;

    const styles = getComputedStyle(todoList);
    const collapseHeight =
      todoList.getBoundingClientRect().height +
      (parseFloat(styles.marginTop) || 0) +
      (parseFloat(styles.marginBottom) || 0);
    if (collapseHeight <= 0.5) return;

    appendBottomReserveTarget = bottomScrollTop();
    setAppendBottomReserve((reserve) => reserve + collapseHeight);
  }

  onMount(() => {
    if (!containerRef) return;
    containerRef.addEventListener('click', handleClickCapture as EventListener, true);
    containerRef.addEventListener('focusin', handleFocusIn);
    containerRef.addEventListener('focusout', handleFocusOut);
    containerRef.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('click', handleExternalLayoutClickCapture, true);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerup', releasePointerScrollOwnership);
    document.addEventListener('pointercancel', releasePointerScrollOwnership);
    lastContainerClientHeight = containerRef.clientHeight;
    lastContainerFontSize = parseFloat(getComputedStyle(containerRef).fontSize) || 0;
    updateScrollbarInset();
    setViewportHeight(containerRef.clientHeight);
    setScrollTop(containerRef.scrollTop);
    setStickyPreviewViewportHeight(containerRef.clientHeight);
    setStickyPreviewScrollTop(containerRef.scrollTop);

    if (typeof IntersectionObserver !== 'undefined') {
      // These cached bounds are only a best-effort scroll anchor. Sticky selection and collision
      // must read live DOM rects because observer thresholds do not report in-viewport movement.
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
    lastTrackInlineSize = trackRef.getBoundingClientRect().width;
    lastAutoScrolledTrackHeight = lastTrackHeight;
    const observer = new ResizeObserver((entries) => {
      if (!containerRef) return;
      const containerChanged =
        entries.length === 0 || entries.some((entry) => entry.target === containerRef);
      const trackChanged =
        entries.length === 0 || entries.some((entry) => entry.target === trackRef);
      const currentContainerClientHeight = containerRef.clientHeight;
      const containerHeightDelta = currentContainerClientHeight - lastContainerClientHeight;
      const containerHeightChanged = currentContainerClientHeight !== lastContainerClientHeight;
      lastContainerClientHeight = currentContainerClientHeight;
      if (containerHeightDelta > 0.5) reserveLostBottomSpace();
      else if (containerHeightDelta < -0.5) consumeBottomReserve(-containerHeightDelta);
      if (trackChanged) reconcileAppendBottomReserve();
      if (trackChanged && shouldMeasureRows() && !autoScroll()) {
        setTrackLayoutVersion((version) => version + 1);
      }
      const currentContainerFontSize = containerChanged
        ? parseFloat(getComputedStyle(containerRef).fontSize) || 0
        : lastContainerFontSize;
      const fontChanged = containerChanged && currentContainerFontSize !== lastContainerFontSize;
      const trackEntry = entries.find((entry) => entry.target === trackRef);
      const currentTrackInlineSize =
        trackEntry?.borderBoxSize?.[0]?.inlineSize ?? trackRef?.getBoundingClientRect().width ?? 0;
      const trackInlineSizeChanged = Math.abs(currentTrackInlineSize - lastTrackInlineSize) > 0.5;
      const widthChanged =
        trackInlineSizeChanged ||
        fontChanged ||
        ((containerChanged || trackChanged) && widthResizeActive && widthResizeIncludesFontChange);
      if (widthChanged) {
        lastTrackInlineSize = currentTrackInlineSize;
        lastContainerFontSize = currentContainerFontSize;
        beginWidthResize({ fontChanged });
      }
      // Below the virtualization threshold rows have no individual ResizeObserver. Keep an active
      // sticky preview collision-aware even when bottom-follow owns scrolling and moves a prompt.
      const shouldRefreshUnmeasuredSticky =
        !autoScroll() || untrack(stickyUserMessagePreview) !== null;
      if (trackChanged && !shouldMeasureRows() && shouldRefreshUnmeasuredSticky) {
        if (widthResizeActive && widthChanged) pendingWidthMeasurementPublish = true;
        else setMeasurementVersion((version) => version + 1);
        scheduleStickyPreviewGeometryRefresh({ force: !widthChanged });
      }
      if (containerChanged) {
        // Keep offscreen heights as provisional estimates while mounted row observers reconcile
        // wrapping changes. Clearing the map here would disable virtualization and remount the full
        // transcript on every frame of a live panel resize.
        if (widthChanged) handleStickyPreviewGeometryChange();
        updateScrollbarInset();
        setViewportHeight(currentContainerClientHeight);
        scheduleStickyPreviewViewportState(containerRef.scrollTop, currentContainerClientHeight);
      }
      if (trackChanged || containerHeightChanged || widthChanged) {
        scheduleVisibleMeasurement({ afterResize: true, widthResize: widthChanged });
      }
    });
    observer.observe(containerRef);
    observer.observe(trackRef);
    onCleanup(() => {
      resetPendingHistoryGeneration();
      containerRef?.removeEventListener('click', handleClickCapture as EventListener, true);
      containerRef?.removeEventListener('focusin', handleFocusIn);
      containerRef?.removeEventListener('focusout', handleFocusOut);
      containerRef?.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('click', handleExternalLayoutClickCapture, true);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerup', releasePointerScrollOwnership);
      document.removeEventListener('pointercancel', releasePointerScrollOwnership);
      observer.disconnect();
      firstVisibleMessageObserver?.disconnect();
      firstVisibleMessageObserver = null;
      measuredRowObserver?.disconnect();
      measuredRowObserver = null;
      mountedMessageRows.clear();
      clearObservedVisibleMessages();
      if (stickyPreviewDebounceTimer) clearTimeout(stickyPreviewDebounceTimer);
      clearUpwardStickyHandoff();
      clearLoadingRowReappearTimer();
      clearLoadingRowReserveReleaseTimer();
      clearTrailingSummarySettleTimer();
      if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);
      cancelScheduledMeasurement();
      cancelScheduledStickyPreviewFrame();
      cancelWidthResize();
      cancelAppendScrollTransition();
      activeFollowLoopSessionId = null;
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

  createEffect((wasMeasuring: boolean | undefined) => {
    const measuring = shouldMeasureRows();
    if (wasMeasuring === measuring) return measuring;

    queueMicrotask(() => {
      if (shouldMeasureRows() !== measuring) return;
      for (const [messageId, row] of mountedMessageRows) {
        if (measuring) {
          if (!row.isConnected) continue;
          measureMountedRow(row, messageId);
          if (row.isConnected && mountedMessageRows.get(messageId) === row) {
            measuredRowObserver?.observe(row);
          }
        } else {
          measuredRowObserver?.unobserve(row);
        }
      }
    });
    return measuring;
  });

  createEffect(() => {
    const editing = editingMessage();
    const revealEpoch = ++editRevealEpoch;
    if (!editing) {
      if (historyOwnedEdit) invalidatePendingHistoryRestoration(historyOwnedEdit.sessionId);
      historyOwnedEdit = null;
      return;
    }
    historyOwnedEdit = { messageId: editing.messageId, sessionId: editing.sessionId };
    finishWidthResizeNow();
    resumeAutoScrollAfterDiffFocus = false;
    untrack(() =>
      refreshPendingHistoryAnchor({
        sessionId: editing.sessionId,
        messageId: editing.messageId,
        owner: 'edit',
        advanceOwnership: true,
      })
    );
    untrack(disengageBottomFollow);
    queueMicrotask(() => {
      if (editRevealEpoch !== revealEpoch) return;
      refreshPendingHistoryAnchor({
        sessionId: editing.sessionId,
        messageId: editing.messageId,
        owner: 'edit',
      });
      void keepEditingMessageTopVisible(editing.messageId, revealEpoch);
    });
  });

  createEffect(() => {
    const candidate = stickyUserMessagePreviewCandidate();
    const current = untrack(stickyUserMessagePreview);

    if (candidate && shouldDeferStickyDuringUpwardHandoff()) {
      if (current) {
        setStickyUserMessagePreview(null);
        previousStickyPreviewId = current.id;
      }
      return;
    }

    if (
      current?.id === candidate?.id &&
      current?.index === candidate?.index &&
      current?.text === candidate?.text &&
      current?.attachmentCount === candidate?.attachmentCount &&
      current?.imageCount === candidate?.imageCount
    ) {
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

    // Boundary prompts can be several unloaded pages above an assistant-only window. Keep the
    // existing overlay while that prompt cache refreshes unless mounted geometry says to hide it.
    if (
      current?.index === -1 &&
      !!state.activeSessionId &&
      isSessionHistoryTruncated(state.activeSessionId) &&
      (containerRef?.clientHeight ?? 0) >= STICKY_PREVIEW_MIN_VIEWPORT_HEIGHT_PX &&
      !getStickyUserMessageSourceElement(current.id)
    ) {
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
      const stickyBounds = getStickyUserMessagePreviewBounds(containerRect);
      previousStickyPreviewBounds = stickyBounds;
      if (
        !stickyBounds ||
        !shouldHideStickyUserMessagePreviewImmediately(activePreview, {
          containerRect,
          stickyBounds,
        })
      ) {
        return;
      }

      setStickyUserMessagePreview(null);
      previousStickyPreviewId = activePreview.id;
    });
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    const editingAtSessionStart = untrack(editingMessage);
    resetPendingHistoryGeneration();
    cancelScheduledStickyPreviewFrame();
    cancelWidthResize();
    setHasBootstrappedVirtualization(false);
    setAppendBottomReserve(0);
    appendBottomReserveTarget = 0;
    measuredHeights.clear();
    zeroHeightRenderContentSignatures.clear();
    setMeasurementVersion((version) => version + 1);
    pendingInitialScrollSessionId = editingAtSessionStart ? null : sessionId;
    cancelPendingScroll();
    pendingScrollToBottomRequest = false;
    deferredScrollToBottomRequestKey = null;
    expectedScrollTop = -1;
    ignoreScrollUntil = 0;
    followModeLocked = false;
    lastScrollInputAt = Number.NEGATIVE_INFINITY;
    lastUserOwnedScrollMovementAt = Number.NEGATIVE_INFINITY;
    pinnedToBottom = !editingAtSessionStart;
    diffFocusPauseActive = false;
    resumeAutoScrollAfterDiffFocus = false;
    setPendingStickyJump(null);
    setStickyNavigationInProgress(false);
    setStickyUserMessagePreview(null);
    previousStickyPreviewId = null;
    previousStickyPreviewBounds = null;
    clearUpwardStickyHandoff();
    setAutoScroll(!editingAtSessionStart);
    if (!editingAtSessionStart) queueMicrotask(() => performScroll());
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    const msgs = messages();
    if (msgs.length === 0) return;
    queueMicrotask(() => {
      if (state.activeSessionId !== sessionId) return;
      scheduleVisibleMeasurement();
      if (stickyNavigationOwnsScroll()) return;
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
        if (startPendingAppendScrollTransition(sessionId)) return;
        performScroll();
        startFollowLoop(sessionId);
      }
    });
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    const currentStreamingTextLength = streamingTextLength();
    if (
      !sessionId ||
      stickyNavigationOwnsScroll() ||
      currentStreamingTextLength === 0 ||
      (!autoScroll() && !pinnedToBottom)
    )
      return;

    queueMicrotask(() => {
      if (
        state.activeSessionId !== sessionId ||
        stickyNavigationOwnsScroll() ||
        (!autoScroll() && !pinnedToBottom)
      )
        return;
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
    const requestChanged = requestKey !== previousRequestKey;
    if (!requestChanged && deferredScrollToBottomRequestKey !== requestKey) return requestKey;
    invalidatePendingHistoryRestoration(sessionId);
    if (stickyNavigationOwnsScroll()) {
      if (requestChanged) deferredScrollToBottomRequestKey = requestKey;
      return requestKey;
    }
    deferredScrollToBottomRequestKey = null;
    if (diffFocusPauseActive) {
      resumeAutoScrollAfterDiffFocus = true;
      return requestKey;
    }

    pendingScrollToBottomRequest = true;
    followModeLocked = true;
    if (shouldMeasureRows()) {
      pendingMeasuredAppendAnchor ??= captureVisibleScrollAnchor();
      requestAnimationFrame(() => {
        if (
          disposed ||
          messageListScrollRequestKey() !== requestKey ||
          pendingMeasuredAppendScroll
        ) {
          return;
        }
        pendingMeasuredAppendAnchor = null;
      });
    }
    lastWheelAt = Number.NEGATIVE_INFINITY;
    lastUserScrollAt = Number.NEGATIVE_INFINITY;
    lastWheelUpAt = Number.NEGATIVE_INFINITY;
    lastScrollInputAt = Number.NEGATIVE_INFINITY;
    setAutoScroll(true);
    queueMicrotask(() => {
      if (state.activeSessionId !== sessionId) return;
      if (startPendingAppendScrollTransition(sessionId)) return;
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
      scheduleStickyPreviewGeometryRefresh();
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
          const modelName = formatModelName(provider?.models[cur.modelID]?.name || cur.modelID);
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
  const assistantActivityGroupMap = createMemo<Map<string, AssistantActivityGroupInfo[]>>(
    (previous) => {
      if (!compactToolOutput()) return new Map<string, AssistantActivityGroupInfo[]>();

      const previousSignatures = previousTrailingFileEventSignatureMap();
      const normalizedMessages = messages().map((message) =>
        isAssistantMessage(message.info)
          ? {
              info: message.info,
              parts: deduplicateFileEdits(
                collapseLeadingDuplicateFileEvents(
                  message.parts,
                  previousSignatures.get(message.info.id) ?? null
                )
              ),
            }
          : message
      );
      return preserveAssistantActivityGroupKeys(
        getAssistantActivityGroupMap(
          normalizedMessages,
          (part) =>
            shouldShowAssistantPartInline(part) &&
            (!showInlineFileChanges() || !isAssistantEditActivityPart(part)) &&
            (part.type !== 'tool' ||
              (!getQuestionRequestForTool(part) && !getPermissionMatchForTool(part))),
          (part) =>
            part.type === 'text'
              ? part.text.trim().length > 0 && !isWorkspaceDirectoryText(part.text)
              : shouldShowAssistantPartInline(part)
        ),
        previous
      );
    },
    new Map()
  );
  const compactActivityDisclosureLayoutSignatures = createMemo(() => {
    trackMessageBlockExpansionState();
    return getCompactActivityDisclosureLayoutSignatures(
      assistantActivityGroupMap(),
      (key) => getMessageBlockExpanded(key) ?? false
    );
  });
  let previousCompactActivityDisclosureLayoutSignatures = new Map<string, string>();

  createEffect(() => {
    const current = compactActivityDisclosureLayoutSignatures();
    scheduleChangedLayoutRowMeasurements(
      previousCompactActivityDisclosureLayoutSignatures,
      current
    );
    previousCompactActivityDisclosureLayoutSignatures = new Map(current);
  });

  const assistantStackGroupMap = createMemo(
    () => new Map<string, AssistantFileEditStackGroup | null>()
  );

  const assistantDialogMessages = createMemo(() => {
    messageStructureVersion();
    return mergeOlderHistory(state.messages, getPrefetchedSessionHistory(state.activeSessionId));
  });

  const collectingLeadingDialogStats = createMemo(() => {
    const sessionId = state.activeSessionId;
    if (!sessionId || !isSessionHistoryTruncated(sessionId)) return false;
    const firstVisible = state.messages.find((entry) => entry.info.sessionID === sessionId);
    if (!firstVisible || firstVisible.info.role === 'user') return false;
    return !getPrefetchedSessionHistory(sessionId).some((entry) => entry.info.role === 'user');
  });

  const assistantDialogSummaryMap = createMemo(() => {
    messageStructureVersion();
    const activeStatusType = state.activeSessionId
      ? state.sessionStatus[state.activeSessionId]?.type
      : undefined;
    const suppressTrailingSummary =
      activeSessionWorking() ||
      activeStatusType === 'busy' ||
      activeStatusType === 'retry' ||
      !trailingFinalResponseReady() ||
      !trailingSummarySettled();
    const sessions = state.sessions.map((session) => ({
      id: session.id,
      parentID: session.parentID,
      title: session.title,
      time: { created: session.time.created },
      tokens: session.tokens
        ? { input: session.tokens.input, output: session.tokens.output }
        : undefined,
    }));
    const dialogMessages = assistantDialogMessages();
    const collectLeadingSummaryStats = collectingLeadingDialogStats();
    return untrack(() =>
      getAssistantDialogSummaryMap(dialogMessages, undefined, {
        sessions,
        suppressTrailingSummary,
        collectLeadingSummaryStats,
      })
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
    trackLayoutVersion();
    return distanceFromBottom() > JUMP_TO_LATEST_MIN_HIDDEN_CONTENT_PX;
  });

  async function waitForMessageRow(
    preview: StickyUserMessagePreview,
    isCurrent: () => boolean = () => true
  ): Promise<HTMLElement | null> {
    finishWidthResizeNow();
    const container = containerRef;
    if (!container) return null;
    const sessionId = state.activeSessionId;
    const findRow = () => mountedMessageRows.get(preview.id);
    let previousMeasurementVersion = -1;
    let bootstrapFrames = 0;
    let settleFrames = 0;
    while (state.activeSessionId === sessionId && isCurrent()) {
      const messageIndex = messages().findIndex((entry) => entry.info.id === preview.id);
      if (messageIndex < 0) return null;

      if (shouldMeasureRows() && !shouldVirtualize()) {
        previousMeasurementVersion = -1;
        bootstrapFrames += 1;
        if (bootstrapFrames >= 60) return null;
        await waitForAnimationFrame();
        continue;
      }

      const row = findRow();
      if (!row) {
        previousMeasurementVersion = -1;
        if (shouldVirtualize()) {
          const nextScrollTop = virtualMetrics().prefix[messageIndex] ?? 0;
          container.scrollTop = nextScrollTop;
          setScrollTop(nextScrollTop);
          setStickyPreviewScrollTop(nextScrollTop);
        }
        settleFrames += 1;
        if (settleFrames >= 12) return null;
        await waitForAnimationFrame();
        continue;
      }

      if (shouldMeasureRows()) alignMountedMessage(preview);

      const currentMeasurementVersion = measurementVersion();
      if (currentMeasurementVersion === previousMeasurementVersion || settleFrames >= 11)
        return row;
      previousMeasurementVersion = currentMeasurementVersion;
      settleFrames += 1;
      await waitForAnimationFrame();
    }
    return null;
  }

  function alignMountedMessage(preview: StickyUserMessagePreview): boolean {
    const row = mountedMessageRows.get(preview.id);
    if (!row) return false;
    const target = row.querySelector<HTMLElement>('.user-message-card');
    if (containerRef && target) {
      const containerRect = containerRef.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const offset = targetRect.top - containerRect.top - getMessageJumpTopInset();
      if (Math.abs(offset) > 0.5) setPreservedScrollTop(containerRef.scrollTop + offset);
      return true;
    }
    row.scrollIntoView({ block: 'start' });
    return true;
  }

  function navigateToMountedMessage(preview: StickyUserMessagePreview): boolean {
    disengageBottomFollow();
    return alignMountedMessage(preview);
  }

  function handleStickyPreviewClick(preview: StickyUserMessagePreview) {
    if (stickyNavigationOwnsScroll()) return;
    finishWidthResizeNow();
    resumeAutoScrollAfterDiffFocus = false;
    disengageBottomFollow();
    const activeHistoryLoad = activeOlderHistoryLoads.get(state.activeSessionId ?? '');
    if (
      messages().some((entry) => entry.info.id === preview.id) &&
      activeHistoryLoad?.generation !== activeSessionGeneration
    ) {
      const settleEpoch = ++stickyJumpSettleEpoch;
      setStickyNavigationInProgress(true);
      const clearNavigation = () => {
        if (stickyJumpSettleEpoch === settleEpoch) setStickyNavigationInProgress(false);
      };
      if (!navigateToMountedMessage(preview)) {
        void waitAndNavigateToMessage(preview, () => stickyJumpSettleEpoch === settleEpoch).finally(
          clearNavigation
        );
      } else if (shouldMeasureRows()) {
        const sessionId = state.activeSessionId;
        if (sessionId) {
          void settleMountedStickyPreviewJump(preview, sessionId, settleEpoch).finally(
            clearNavigation
          );
        } else {
          clearNavigation();
        }
      } else {
        clearNavigation();
      }
      return;
    }
    const sessionId = state.activeSessionId;
    if (sessionId) {
      const jump = { sessionId, preview };
      setPendingStickyJump(jump);
      void loadAndScrollToStickyPreview(jump);
    }
  }

  async function settleMountedStickyPreviewJump(
    preview: StickyUserMessagePreview,
    sessionId: string,
    settleEpoch: number
  ) {
    let stableFrames = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await waitForAnimationFrame();
      if (state.activeSessionId !== sessionId || stickyJumpSettleEpoch !== settleEpoch) return;

      const container = containerRef;
      const target = getStickyUserMessageSourceElement(preview.id);
      const row = mountedMessageRows.get(preview.id);
      if (!container || !target || !row) return;
      const targetRect = target.getBoundingClientRect();
      const offset =
        targetRect.top - container.getBoundingClientRect().top - getMessageJumpTopInset();
      if (Math.abs(offset) <= 0.5) {
        stableFrames += 1;
        if (stableFrames >= 2) return;
        continue;
      }

      stableFrames = 0;
      setPreservedScrollTop(container.scrollTop + offset);
    }
  }

  function getMessageJumpTopInset() {
    if (!trackRef) return 8;
    const value = getComputedStyle(trackRef).getPropertyValue('--latest-user-message-sticky-gap');
    return Number.parseFloat(value) || 8;
  }

  async function waitAndNavigateToMessage(
    preview: StickyUserMessagePreview,
    isCurrent?: () => boolean
  ): Promise<boolean> {
    disengageBottomFollow();
    if (!(await waitForMessageRow(preview, isCurrent))) return false;

    let stableMeasurementFrames = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (isCurrent && !isCurrent()) return false;
      if (!navigateToMountedMessage(preview)) {
        stableMeasurementFrames = 0;
        await waitForAnimationFrame();
        continue;
      }

      const previousMeasurementVersion = measurementVersion();
      await waitForAnimationFrame();
      stableMeasurementFrames =
        measurementVersion() === previousMeasurementVersion ? stableMeasurementFrames + 1 : 0;
      if (stableMeasurementFrames >= 2) return true;
    }

    if (isCurrent && !isCurrent()) return false;
    return navigateToMountedMessage(preview);
  }

  async function loadAndScrollToStickyPreview(jump: {
    sessionId: string;
    preview: StickyUserMessagePreview;
  }) {
    const { sessionId, preview } = jump;
    const clearPendingJump = () => {
      if (pendingStickyJump() === jump) setPendingStickyJump(null);
    };
    const historyLoad = activeOlderHistoryLoads.get(sessionId);
    if (historyLoad?.generation === activeSessionGeneration) await historyLoad.promise;
    if (state.activeSessionId !== sessionId) {
      clearPendingJump();
      return;
    }

    const needsHistory = !messages().some((entry) => entry.info.id === preview.id);
    const ownsLoadingState = needsHistory && !loadingOlderHistory(sessionId);
    if (ownsLoadingState) setLoadingOlderHistory(sessionId, true);
    if (needsHistory) {
      try {
        while (
          pendingStickyJump() === jump &&
          state.activeSessionId === sessionId &&
          !messages().some((entry) => entry.info.id === preview.id)
        ) {
          if (!(await loadOlderSessionHistoryPage(sessionId))) break;
        }
      } finally {
        if (ownsLoadingState) setLoadingOlderHistory(sessionId, false);
      }
    }
    if (state.activeSessionId !== sessionId) {
      clearPendingJump();
      return;
    }
    try {
      const ready = await waitForMessageRow(preview, () => pendingStickyJump() === jump);
      if (!ready || state.activeSessionId !== sessionId) return;
      await waitForAnimationFrame();
      if (state.activeSessionId === sessionId) {
        const settleEpoch = ++stickyJumpSettleEpoch;
        await waitAndNavigateToMessage(
          preview,
          () =>
            pendingStickyJump() === jump &&
            state.activeSessionId === sessionId &&
            stickyJumpSettleEpoch === settleEpoch
        );
      }
    } finally {
      clearPendingJump();
    }
  }

  const stickyPreviewTitle = 'Click to scroll to message';

  function loadingOlderHistory(sessionId = state.activeSessionId) {
    return !!sessionId && loadingOlderHistorySessionIds().has(sessionId);
  }

  function setLoadingOlderHistory(sessionId: string, loading: boolean) {
    setLoadingOlderHistorySessionIds((current) => {
      if (current.has(sessionId) === loading) return current;
      const next = new Set(current);
      if (loading) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  function resetPendingHistoryGeneration() {
    activeSessionGeneration += 1;
    historyAnchorSettleOwner = null;
    for (const pendingAnchor of pendingOlderHistoryAnchors.values()) {
      pendingAnchor.invalidated = true;
    }
    pendingOlderHistoryAnchors.clear();
    activeOlderHistoryLoads.clear();
    setLoadingOlderHistorySessionIds(new Set<string>());
  }

  function invalidatePendingHistoryRestoration(sessionId = state.activeSessionId) {
    if (!sessionId) return;
    const pendingAnchor = pendingOlderHistoryAnchors.get(sessionId);
    if (pendingAnchor) pendingAnchor.invalidated = true;
  }

  function handleLoadOlderHistory(): Promise<void> | undefined {
    const sessionId = state.activeSessionId;
    const container = containerRef;
    if (!sessionId || !container) return;
    const generation = activeSessionGeneration;
    const existing = activeOlderHistoryLoads.get(sessionId);
    if (existing?.generation === generation) return existing.promise;
    if (loadingOlderHistory(sessionId)) return;
    const load = loadOlderHistoryPreservingScroll(sessionId, generation, container);
    const activeLoad = { generation, promise: load };
    activeOlderHistoryLoads.set(sessionId, activeLoad);
    const clearActiveLoad = () => {
      if (activeOlderHistoryLoads.get(sessionId) === activeLoad) {
        activeOlderHistoryLoads.delete(sessionId);
      }
    };
    void load.then(clearActiveLoad, clearActiveLoad);
    return load;
  }

  async function loadOlderHistoryPreservingScroll(
    sessionId: string,
    generation: number,
    container: HTMLDivElement
  ): Promise<void> {
    if (generation !== activeSessionGeneration || state.activeSessionId !== sessionId) return;
    markSessionHistoryLoadFailed(sessionId, false);
    const pendingAnchor = {
      anchor: captureVisibleScrollAnchor({ preferStableRenderItem: true }),
      generation,
      invalidated: false,
      owner: 'history' as const,
      previousScrollHeight: container.scrollHeight,
      previousScrollTop: container.scrollTop,
      ownershipEpoch: userScrollOwnershipEpoch,
    };
    pendingOlderHistoryAnchors.set(sessionId, pendingAnchor);
    setLoadingOlderHistory(sessionId, true);
    try {
      const loaded = await loadOlderSessionHistoryPage(sessionId);
      if (!loaded || generation !== activeSessionGeneration || state.activeSessionId !== sessionId)
        return;
      const settleOwner = { sessionId, generation };
      historyAnchorSettleOwner = settleOwner;
      // The pinned range contains the old viewport. Replace provisional prefix heights and align
      // its stable render item synchronously so the browser never paints the estimated position.
      measureVisibleItems();
      restorePendingHistoryAnchorIfMounted();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          measureVisibleItems();
          restorePendingHistoryAnchorIfMounted();
          resolve();
        })
      );
      const canRestoreAnchor = () =>
        generation === activeSessionGeneration &&
        state.activeSessionId === sessionId &&
        historyAnchorSettleOwner === settleOwner &&
        !!containerRef &&
        !stickyNavigationOwnsScroll() &&
        pendingOlderHistoryAnchors.get(sessionId) === pendingAnchor &&
        !pendingAnchor.invalidated &&
        userScrollOwnershipEpoch === pendingAnchor.ownershipEpoch;
      if (!canRestoreAnchor()) return;
      const currentContainer = containerRef;
      if (!currentContainer) return;
      if (!restoreVisibleScrollAnchor(pendingAnchor.anchor, { useMessageOffsetFallback: true })) {
        const heightDelta = currentContainer.scrollHeight - pendingAnchor.previousScrollHeight;
        setPreservedScrollTop(pendingAnchor.previousScrollTop + Math.max(0, heightDelta));
      }
    } finally {
      if (
        historyAnchorSettleOwner?.sessionId === sessionId &&
        historyAnchorSettleOwner.generation === generation
      ) {
        historyAnchorSettleOwner = null;
      }
      if (pendingOlderHistoryAnchors.get(sessionId) === pendingAnchor) {
        pendingOlderHistoryAnchors.delete(sessionId);
      }
      if (generation === activeSessionGeneration && state.activeSessionId === sessionId) {
        setLoadingOlderHistory(sessionId, false);
      }
    }
  }

  return (
    <div class="interactive-list-shell min-h-0 flex-1">
      <div
        ref={containerRef}
        class={`interactive-list min-h-0 flex-1 overflow-y-auto${showModelPicker() ? ' showing-model-picker' : ''}${shouldMeasureRows() || loadingOlderHistory() ? ' managed-scroll-anchor' : ''}${editingMessage() ? ' editing-message' : ''}`}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        onWheel={onWheel}
        onScroll={onScroll}
      >
        <div
          ref={trackRef}
          class={`interactive-list-track${shouldVirtualize() ? ' virtualized' : ''}${editingMessage() ? ' editing-message' : ''}${showTruncatedHistoryBanner() && scrollTop() <= 24 ? ' history-boundary-visible' : ''}`}
        >
          <Show when={displayedStickyUserMessagePreview()}>
            {(preview) => (
              <StickyUserMessagePreviewCard
                preview={preview()}
                promptNumber={
                  promptNumbersVisible() ? promptNumberMap().get(preview().id) : undefined
                }
                title={stickyPreviewTitle}
                loading={pendingStickyJump()?.preview.id === preview().id}
                onClick={handleStickyPreviewClick}
                onGeometryChange={handleStickyPreviewGeometryChange}
              />
            )}
          </Show>
          <Show
            when={state.messages.length > 0}
            fallback={
              <Show
                when={state.messagesLoading}
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
                <div class="chat-messages-loading" role="status" aria-label="Loading messages">
                  <span class="chat-messages-loading-dot" />
                  <span class="chat-messages-loading-dot" style={{ 'animation-delay': '0.3s' }} />
                  <span class="chat-messages-loading-dot" style={{ 'animation-delay': '0.6s' }} />
                </div>
              </Show>
            }
          >
            <Show when={showTruncatedHistoryBanner()}>
              <Show
                when={historyLoadFailed()}
                fallback={
                  <div
                    class={`message-history-banner${loadingOlderHistory() ? ' is-loading' : ''}`}
                    aria-hidden="true"
                  />
                }
              >
                <div class="message-history-banner is-error" role="alert">
                  <span class="message-history-banner-error-text">
                    Couldn't load earlier messages
                  </span>
                  <button
                    type="button"
                    class="message-history-banner-retry"
                    disabled={loadingOlderHistory()}
                    onClick={() => void handleLoadOlderHistory()}
                  >
                    {loadingOlderHistory() ? 'Retrying…' : 'Retry'}
                  </button>
                </div>
              </Show>
            </Show>
            <VirtualizedContent
              messages={messages()}
              modelChangeMap={modelChangeMap()}
              promptNumberMap={promptNumberMap()}
              showPromptNumbers={promptNumbersVisible()}
              lastAssistantID={lastAssistantID()}
              outerListVirtualized={shouldVirtualize()}
              previousTrailingFileEventSignatureMap={previousTrailingFileEventSignatureMap()}
              fileEditStackGroupMap={assistantStackGroupMap()}
              assistantDialogSummaryMap={assistantDialogSummaryMap()}
              assistantActivityGroupMap={assistantActivityGroupMap()}
              hasBuildAgent={hasBuildAgent()}
              latestPlanImplementationMessageId={latestPlanImplementationMessageId()}
              visibleRange={visibleRange()}
              claimMessageEntrance={claimMessageEntrance}
              claimAssistantItemReveal={claimAssistantItemReveal}
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
          <Show when={reserveLoadingRow() && !editingMessage() && !!state.activeSessionId}>
            <LoadingRow compacting={isSessionCompacting()} visible={showLoadingRow()} />
          </Show>
          <Show when={appendBottomReserve() > 0.5}>
            <div
              class="append-scroll-bottom-reserve"
              style={{ height: `${appendBottomReserve()}px` }}
              aria-hidden="true"
            />
          </Show>
        </div>
      </div>
      <ChatContentBottomFade />
      <Show when={showJumpToLatest() && !hasExpandedDiffOverlay()}>
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
