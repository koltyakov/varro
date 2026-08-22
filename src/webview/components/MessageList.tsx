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
import type { Setter } from 'solid-js';
import {
  isAbortedAssistantError,
  isPermissionRejectedToolError,
  isQuestionSkippedToolError,
} from '../../shared/error-classification';
import {
  isSessionAwaitingInput,
  state,
  isLoading,
  hasActiveQuestion,
  hasActivePermission,
  isSessionCompacting,
  loadingStartedAt,
  messageListScrollRequestKey,
  messageListScrollTargetMessageId,
  requestMessageListScrollToBottom,
  getActiveUsageLimitNotice,
  isActiveSessionWorking,
  isSessionTreeStatusWorking,
  getSessionTreeIds,
  getSessionTreeRootId,
  messageStructureVersion,
  messageInfoVersion,
  onBeforeShowThinkingPreferenceChange,
  showModelPicker,
  showThinking,
  showInlineFileChanges,
} from '../lib/state';
import {
  getAssistantActivityPartKey,
  getAssistantActivityGroupMap,
  isAssistantActivityPart,
  isAssistantActivityPartRunning,
  isAssistantEditActivityPart,
  preserveAssistantActivityGroupKeys,
  shouldCompactAssistantActivityPart,
  type AssistantActivityGroupInfo,
  type AssistantActivityPart,
} from '../lib/assistant-activity';
import { isAssistantMessage, isContinuationAssistantFinish } from '../lib/message-metrics';
import { registerQueuedMessageRemovalHandler } from '../lib/message-list-layout';
import {
  getFinalAssistantTextPartId,
  isWorkspaceDirectoryText,
  shouldShowAssistantPartInline,
} from '../lib/part-utils';
import { shouldDisplayUsageLimitNotice } from '../lib/usage-limit';
import type { AssistantMessage, MessageEntry, Part } from '../types';
import { editingMessage } from '../lib/message-edit-state';
import { hasExpandedDiffOverlay } from '../lib/diff-overlay-state';
import {
  getPrefetchedSessionHistory,
  getSessionHistoryCursor,
  getSessionHistoryPromptCursor,
  getSessionHistoryPrompts,
  getSessionMessageWindowStateVersion,
  isSessionHistoryLoadFailed,
  isSessionHistoryTruncated,
  isSessionMessageWindowResetPending,
  markSessionHistoryLoadFailed,
  mergeOlderHistory,
} from '../lib/message-window';
import { loadOlderSessionHistoryPage, loadOlderSessionPrompts } from '../hooks/useOpenCode';
import { modelSupportsReasoning } from '../lib/model-capabilities';
import { formatLabelWithProvider, formatModelName, formatVariantLabel } from '../lib/format';
import {
  collapseLeadingDuplicateFileEvents,
  getTrailingFileEventSignature,
} from '../lib/message-event-collapse';
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
  LoadingRow,
  PendingActionRows,
  StickyUserMessagePreviewCard,
  TurnNavigationRail,
} from './message-list/MessageListChrome';
import { Tooltip } from './Tooltip';
import {
  getSubagentSessionIds,
  getStickyUserMessagePreview,
  getUserMessageNavigationPreviews,
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
  VIRTUALIZE_THRESHOLD,
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
import { AssistantDialogSummaryForMessage, type ModelChangeInfo } from './message-list/MessageRows';
import { deduplicateFileEdits } from './message/AssistantMessageContent';
import {
  getLinkedToolCallKeys,
  getStandalonePermissionPrompts,
  getStandaloneQuestionPrompts,
  reconcilePendingPermissionSequence,
  type PendingPermissionSequence,
} from './message-list/pending-prompts';
import {
  getRenderedMessages,
  getVisibleThreadMessages,
  hasVisibleRunningToolPart,
} from './message-list/thread-visibility';
import { getLatestPlanImplementationMessageId } from './message-list/plan-actions';
import {
  getAssistantDialogSummaryMap,
  type AssistantDialogSummaryInfo,
} from './message-list/assistant-dialog';
import {
  getChangedInlinePreviewMessageIds,
  getCompactActivityDisclosureLayoutSignatures,
  getCompactActivityLayoutSignatures,
  getInlinePreviewLayoutSignatures,
  getRenderEmptyAssistantMessageIds,
  getThinkingLayoutSignatures,
  hasVisibleProjectedText,
} from './message-list/row-layout';
import { isNumber, isFunction } from '../lib/runtime-values';

function showTruncatedHistoryBanner() {
  return !editingMessage() && isSessionHistoryTruncated(state.activeSessionId);
}

function historyLoadFailed() {
  return !editingMessage() && isSessionHistoryLoadFailed(state.activeSessionId);
}

const STICKY_PREVIEW_DISPLAY_DEBOUNCE_MS = 90;
const STICKY_PREVIEW_COLLISION_BUFFER_PX = 8;
const STICKY_NAVIGATION_SETTLE_FRAME_LIMIT = 32;
const STRUCTURAL_ANCHOR_SETTLE_FRAME_LIMIT = 24;
const NEW_TURN_ALIGNMENT_FRAME_LIMIT = 64;
const NEW_TURN_ALIGNMENT_MAX_STEP_PX = 24;
const BOTTOM_FOLLOW_SETTLE_FRAME_COUNT = 2;
const WIDTH_RESIZE_SETTLE_MS = 100;
const APPEND_SCROLL_TRANSITION_MS = 180;
const EXPANSION_SCROLL_ANCHOR_WINDOW_MS = 250;
const LOADING_ROW_REAPPEAR_DELAY_MS = 600;
const LOADING_ROW_RESERVE_RELEASE_DELAY_MS = 600;
const ACTIVITY_SHOW_DELAY_MS = 500;
const ACTIVITY_MIN_VISIBLE_MS = 2_000;
const ACTIVITY_EXIT_MS = 420;
const ACTIVITY_EXIT_CLEANUP_GRACE_MS = 250;
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

function setSetMembership(setter: Setter<ReadonlySet<string>>, key: string, included: boolean) {
  setter((current) => {
    if (current.has(key) === included) return current;
    const next = new Set(current);
    if (included) next.add(key);
    else next.delete(key);
    return next;
  });
}

type VisibleScrollAnchor = {
  messageId: string;
  top: number;
  topPad: number;
  messageTop?: number;
  activityGroupKey?: string;
  renderKey?: string;
  element?: HTMLElement;
};

function visibleRangesEqual(previous: VisibleRange, next: VisibleRange) {
  return (
    previous.start === next.start &&
    previous.end === next.end &&
    previous.topPad === next.topPad &&
    previous.bottomPad === next.bottomPad &&
    previous.coreStart === next.coreStart &&
    previous.coreEnd === next.coreEnd &&
    previous.pinnedIndex === next.pinnedIndex &&
    previous.pinnedGapStart === next.pinnedGapStart &&
    previous.pinnedGapEnd === next.pinnedGapEnd
  );
}

function waitForAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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

export function getActiveTurnMessageId(
  messages: readonly MessageEntry[],
  firstVisibleIndex: number | null,
  stickyTurnId: string | null,
  fallbackTurnId: string | null
): string | null {
  if (firstVisibleIndex === null) return stickyTurnId ?? fallbackTurnId;
  const firstVisibleMessage = messages[firstVisibleIndex];
  if (firstVisibleMessage?.info.role === 'user') return firstVisibleMessage.info.id;
  if (stickyTurnId) return stickyTurnId;
  for (let index = firstVisibleIndex; index >= 0; index -= 1) {
    if (messages[index]?.info.role === 'user') return messages[index]!.info.id;
  }
  return fallbackTurnId;
}

export function getActiveTurnNavigationMessageId(
  turns: readonly StickyUserMessagePreview[],
  viewportTurnId: string | null,
  selectedTurnId: string | null
): string | null {
  if (!selectedTurnId || !viewportTurnId) return selectedTurnId ?? viewportTurnId;
  const selectedIndex = turns.findIndex((turn) => turn.id === selectedTurnId);
  const viewportIndex = turns.findIndex((turn) => turn.id === viewportTurnId);
  return viewportIndex > selectedIndex ? viewportTurnId : selectedTurnId;
}

export function MessageList() {
  type HistoryLoadingOwner = { windowVersion: number };

  // oxlint-disable-next-line no-unassigned-vars
  let containerRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let trackRef: HTMLDivElement | undefined;
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [showPromptNumbers, setShowPromptNumbers] = createSignal(false);
  const [retainedActivityPartKeys, setRetainedActivityPartKeys] = createSignal<ReadonlySet<string>>(
    new Set()
  );
  const [exitingActivityPartKeys, setExitingActivityPartKeys] = createSignal<ReadonlySet<string>>(
    new Set()
  );
  const [visibleActiveActivityPartKeys, setVisibleActiveActivityPartKeys] = createSignal<
    ReadonlySet<string>
  >(new Set());
  const hasVisibleActivityTrayRows = () =>
    visibleActiveActivityPartKeys().size > 0 ||
    retainedActivityPartKeys().size > 0 ||
    exitingActivityPartKeys().size > 0;
  const [promptNumberReadySessionIds, setPromptNumberReadySessionIds] = createSignal<
    ReadonlySet<string>
  >(new Set());
  const promptNumberLoads = new Map<
    string,
    { generation: number; windowVersion: number; promise: Promise<void> }
  >();
  const promptNumberReadyWindowVersions = new Map<string, number>();
  let promptNumberSessionId: string | null = null;
  let promptNumberSessionWindowVersion = 0;
  let promptNumberHoldGeneration = 0;
  let altHeld = false;
  let disposed = false;

  function ensurePromptNumbersReady(
    sessionId: string,
    generation = promptNumberHoldGeneration
  ): Promise<void> {
    const windowVersion = getSessionMessageWindowStateVersion(sessionId);
    const existing = promptNumberLoads.get(sessionId);
    if (existing?.generation === generation && existing.windowVersion === windowVersion) {
      return existing.promise;
    }

    const pendingLoad = (async () => {
      while (await loadOlderSessionPrompts(sessionId)) {
        // Continue until the prompt cursor reaches the beginning of the session.
      }
      if (
        disposed ||
        generation !== promptNumberHoldGeneration ||
        state.activeSessionId !== sessionId ||
        getSessionMessageWindowStateVersion(sessionId) !== windowVersion ||
        isSessionMessageWindowResetPending(sessionId) ||
        getSessionHistoryPromptCursor(sessionId)
      ) {
        return;
      }
      promptNumberReadyWindowVersions.set(sessionId, windowVersion);
      setPromptNumberReadySessionIds((current) => new Set(current).add(sessionId));
    })();
    const load = pendingLoad.finally(() => {
      if (promptNumberLoads.get(sessionId)?.promise === load) promptNumberLoads.delete(sessionId);
    });
    promptNumberLoads.set(sessionId, { generation, windowVersion, promise: load });
    return load;
  }

  function promptNumbersReady(sessionId: string) {
    return (
      promptNumberReadySessionIds().has(sessionId) &&
      promptNumberReadyWindowVersions.get(sessionId) ===
        getSessionMessageWindowStateVersion(sessionId)
    );
  }

  function showPromptNumbersForAlt() {
    if (altHeld) return;
    altHeld = true;
    promptNumberHoldGeneration += 1;
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
    const windowVersion = sessionId ? getSessionMessageWindowStateVersion(sessionId) : 0;
    if (sessionId !== promptNumberSessionId || windowVersion !== promptNumberSessionWindowVersion) {
      const sessionChanged = sessionId !== promptNumberSessionId;
      promptNumberSessionId = sessionId;
      promptNumberSessionWindowVersion = windowVersion;
      if (sessionChanged) {
        promptNumberLoads.clear();
        promptNumberReadyWindowVersions.clear();
        setPromptNumberReadySessionIds(new Set<string>());
      } else if (sessionId) {
        promptNumberReadyWindowVersions.delete(sessionId);
        setPromptNumberReadySessionIds((current) => {
          if (!current.has(sessionId)) return current;
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
      }
    }
    if (!showPromptNumbers() || !sessionId || promptNumbersReady(sessionId)) return;
    void ensurePromptNumbersReady(sessionId);
  });
  const promptNumbersVisible = createMemo(() => {
    const sessionId = state.activeSessionId;
    return !!sessionId && showPromptNumbers() && promptNumbersReady(sessionId);
  });
  const lastAssistantID = createMemo(() => {
    messageStructureVersion();
    const msgs = getVisibleThreadMessages(state.messages, state.activeSessionId, state.sessions);
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (isAssistantMessage(msgs[i]!.info)) return msgs[i]!.info.id;
    }
    return null;
  });
  let expectedScrollTop = -1;
  let ignoreScrollUntil = 0;
  let lastObservedScrollTop = 0;
  let pendingInitialScrollSessionId: string | null = null;
  let pendingInitialHistoryFillSessionId: string | null = null;
  let initialScrollRafId = 0;
  let appendScrollRafId = 0;
  let appendScrollSessionId: string | null = null;
  let pendingMeasuredAppendScroll = false;
  let pendingMeasuredAppendAnchor: VisibleScrollAnchor | null = null;
  let pendingScrollToBottomRequest = false;
  let pendingNewTurnMessageId: string | null = null;
  let newTurnAlignmentRafId = 0;
  let newTurnReserveSessionId: string | null = null;
  let deferredScrollToBottomRequestKey: number | null = null;
  let followModeLocked = false;
  let previousStickyPreviewId: string | null = null;
  let previousStickyPreviewBounds: { top: number; bottom: number } | null = null;
  let upwardStickyHandoff: {
    preview: StickyUserMessagePreview;
    messageId: string;
    acceptsBoundaryEntry: boolean;
    sourceEntered: boolean;
    lastInputAt: number;
  } | null = null;
  let upwardStickyHandoffReleaseTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let stickyJumpSettleEpoch = 0;
  const [stickyNavigationInProgress, setStickyNavigationInProgress] = createSignal(false);
  const [activeTurnNavigationTargetId, setActiveTurnNavigationTargetId] = createSignal<
    string | null
  >(null);
  let pendingTurnNavigationAnimationMessageId: string | null = null;
  let turnNavigationAnimationEpoch = 0;
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
  let lastHostViewportWidth = -1;
  let lastHostViewportHeight = -1;
  let lastHostDevicePixelRatio = -1;
  let hostViewportResizeActiveUntil = Number.NEGATIVE_INFINITY;
  let lastContainerFontSize = -1;
  let lastTrackInlineSize = -1;
  let lastAutoScrolledTrackHeight = 0;
  let lastAutoScrolledBottomScrollTop = 0;
  let activityExitBottomTarget: number | null = null;
  let activityExitSummaryAnchor: { sessionId: string; top: number } | null = null;
  let activityExitSummaryObserver: MutationObserver | null = null;
  let activityExitSummarySettleRafId = 0;
  let activityExitSummarySettleFrames = 0;
  let activityExitHeldResponseTextSignature: string | null = null;
  let activityCollapseSettleRafId = 0;
  let lastWheelAt = Number.NEGATIVE_INFINITY;
  let lastUserScrollAt = Number.NEGATIVE_INFINITY;
  let lastUserOwnedScrollMovementAt = Number.NEGATIVE_INFINITY;
  let lastWheelUpAt = Number.NEGATIVE_INFINITY;
  let lastScrollInputAt = Number.NEGATIVE_INFINITY;
  let virtualPlaceholderReleaseBlockedUntil = Number.NEGATIVE_INFINITY;
  let directScrollInputEpoch = 0;
  let userScrollOwnershipEpoch = 0;
  let activeSessionGeneration = 0;
  let historyAnchorSettleOwner: {
    sessionId: string;
    generation: number;
    windowVersion: number;
  } | null = null;
  let previousAutoScrollEnabled = true;
  let pinnedToBottom = true;
  let activeFollowLoopSessionId: string | null = null;
  let bottomFollowSettleFrames = 0;
  let bottomFollowObservedStreaming = false;
  const activeOlderHistoryLoads = new Map<
    string,
    { generation: number; windowVersion: number; promise: Promise<void> }
  >();
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
      inputEpoch: number;
      windowVersion: number;
    }
  >();
  let restoringPendingHistoryAnchor = false;
  function getCurrentPendingHistoryAnchor(sessionId: string) {
    const pendingAnchor = pendingOlderHistoryAnchors.get(sessionId);
    return pendingAnchor?.generation === activeSessionGeneration &&
      pendingAnchor.windowVersion === getSessionMessageWindowStateVersion(sessionId)
      ? pendingAnchor
      : undefined;
  }
  let pendingStructuralScrollAnchor: {
    anchor: VisibleScrollAnchor;
    sessionId: string | null;
    ownershipEpoch: number;
    preserveBottom: boolean;
    attempts: number;
    stableFrames: number;
    rafId: number;
    observer: MutationObserver | null;
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
  let widthResizeAnchor: VisibleScrollAnchor | null = null;
  const [widthResizePinnedMessageId, setWidthResizePinnedMessageId] = createSignal<string | null>(
    null
  );
  let lastDetachedVisibleAnchor: VisibleScrollAnchor | null = null;
  let directMovementAnchor: { anchor: VisibleScrollAnchor; scrollTop: number } | null = null;
  let pendingWheelResizeAnchor: VisibleScrollAnchor | null = null;
  let detachedAnchorRefreshRafId = 0;
  let keydownDestinationRafId = 0;
  let pendingThinkingLayoutAnchor: VisibleScrollAnchor | null = null;
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
  const [activityExitBottomReserve, setActivityExitBottomReserve] = createSignal(0);
  const [measurementVersion, setMeasurementVersion] = createSignal(0);
  const [trackLayoutVersion, setTrackLayoutVersion] = createSignal(0);
  const [hasBootstrappedVirtualization, setHasBootstrappedVirtualization] = createSignal(false);
  const [stickyPreviewGeometryVersion, setStickyPreviewGeometryVersion] = createSignal(0);
  const [stickyUserMessagePreview, setStickyUserMessagePreview] =
    createSignal<StickyUserMessagePreview | null>(null);
  const [pendingStickyJump, setPendingStickyJump] = createSignal<{
    sessionId: string;
    preview: StickyUserMessagePreview;
    windowVersion: number;
    loadingOwner?: HistoryLoadingOwner;
  } | null>(null);
  const displayedStickyUserMessagePreview = createMemo(
    () => pendingStickyJump()?.preview ?? stickyUserMessagePreview()
  );
  createEffect(() => {
    const jump = pendingStickyJump();
    if (
      jump &&
      (state.activeSessionId !== jump.sessionId ||
        getSessionMessageWindowStateVersion(jump.sessionId) !== jump.windowVersion)
    ) {
      cancelStickyNavigation();
    }
  });

  function stickyNavigationOwnsScroll() {
    return stickyNavigationInProgress() || pendingStickyJump() !== null;
  }
  const [stickyPreviewScrollTop, setStickyPreviewScrollTop] = createSignal(0);
  const [stickyPreviewViewportHeight, setStickyPreviewViewportHeight] = createSignal(0);
  const [reserveLoadingRow, setReserveLoadingRow] = createSignal(false);
  const [showLoadingRow, setShowLoadingRow] = createSignal(false);
  const [trailingSummarySettled, setTrailingSummarySettled] = createSignal(true);
  const [trailingSummaryOwner, setTrailingSummaryOwner] = createSignal<{
    sessionId: string;
    messageId: string;
  } | null>(null);
  const [trailingSummaryOwnerConfirmed, setTrailingSummaryOwnerConfirmed] = createSignal(false);
  let trailingSummaryOwnerEpoch = 0;
  const [loadingOlderHistoryOwners, setLoadingOlderHistoryOwners] = createSignal<
    ReadonlyMap<string, HistoryLoadingOwner>
  >(new Map());
  const activeUsageLimit = createMemo(() => {
    const notice = getActiveUsageLimitNotice(state.activeSessionId);
    return notice && shouldDisplayUsageLimitNotice(notice) ? notice : null;
  });
  const activeSessionWorking = createMemo(() => isActiveSessionWorking());
  const activePermissionReviewInFlight = createMemo(() => {
    const sessionId = state.activeSessionId;
    if (!sessionId) return false;
    const rootId = getSessionTreeRootId(sessionId) || sessionId;
    return getSessionTreeIds(rootId).some(
      (candidateSessionId) =>
        (state.sessionAutoPermissionCounts[candidateSessionId]?.inFlight ?? 0) > 0
    );
  });
  const shouldShowStarterLogo = createMemo(() => {
    const sessionId = state.activeSessionId;
    if (getVisibleThreadMessages(state.messages, sessionId, state.sessions).length > 0)
      return false;
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
    const visibleAnchor = canCaptureAnchor ? captureMountedVisibleScrollAnchor() : null;
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

    const structuralAnchor =
      structureChanged && !pureAppend
        ? (captureLastRetainedVisibleScrollAnchor(previousIds, currentIds) ?? visibleAnchor)
        : null;
    if (structuralAnchor && !pendingStructuralScrollAnchor) {
      const preserveBottom = !!containerRef && getDistanceFromBottom(containerRef) <= 2;
      scheduleStructuralScrollAnchorRestore(structuralAnchor, sessionId, preserveBottom);
    }
    const pendingStructure = pendingStructuralScrollAnchor;
    if (structureChanged && pendingStructure) {
      queueMicrotask(() => {
        if (
          pendingStructuralScrollAnchor !== pendingStructure ||
          state.activeSessionId !== pendingStructure.sessionId ||
          userScrollOwnershipEpoch !== pendingStructure.ownershipEpoch ||
          !genericStructuralAnchorCanOwnScroll(pendingStructure.sessionId)
        ) {
          return;
        }
        restoreVisibleScrollAnchor(pendingStructure.anchor, {
          useMessageOffsetFallback: true,
          reserveBottomOverflow: pendingStructure.preserveBottom,
        });
      });
    }
    return visibleMessages;
  });
  const latestPlanImplementationMessageId = createMemo(() => {
    messageInfoVersion();
    const visibleMessages = messages();
    return untrack(() => getLatestPlanImplementationMessageId(visibleMessages));
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
  const visibleRunningInlineFileEdit = createMemo(() => {
    messageStructureVersion();
    return untrack(() =>
      messages().some((message) =>
        message.parts.some(
          (part) =>
            part.type === 'tool' &&
            (part.state.status === 'pending' || part.state.status === 'running') &&
            shouldShowAssistantPartInline(part) &&
            isAssistantEditActivityPart(part) &&
            !shouldCompactAssistantActivityPart(part, {
              keepEditInline: true,
            })
        )
      )
    );
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
  const subagentSessionIds = createMemo(() => getSubagentSessionIds(messages()));
  const promptNumberMap = createMemo(() =>
    getPromptNumberMap(
      mergeOlderHistory(messages(), getSessionHistoryPrompts(state.activeSessionId))
    )
  );
  const turnNavigationPreviews = createMemo(() =>
    getUserMessageNavigationPreviews(
      mergeOlderHistory(messages(), getSessionHistoryPrompts(state.activeSessionId)),
      subagentSessionIds()
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

  function syncViewportForcedVirtualContent() {
    if (!containerRef) return;
    const placeholders = containerRef.querySelectorAll<HTMLElement>(
      '.interactive-item-virtual-placeholder'
    );
    if (placeholders.length === 0 && viewportForcedVirtualContentMessageIds.size === 0) return;

    const containerRect = containerRef.getBoundingClientRect();
    const nextForcedMessageIds = new Set<string>();
    const retainIfVisible = (row: HTMLElement) => {
      const messageId = row.dataset.msgId;
      if (!messageId) return;
      const rect = row.getBoundingClientRect();
      if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
        nextForcedMessageIds.add(messageId);
      }
    };
    for (const messageId of viewportForcedVirtualContentMessageIds) {
      const row = mountedMessageRows.get(messageId);
      if (row) retainIfVisible(row);
    }
    for (const row of placeholders) retainIfVisible(row);

    if (
      nextForcedMessageIds.size === viewportForcedVirtualContentMessageIds.size &&
      [...nextForcedMessageIds].every((messageId) =>
        viewportForcedVirtualContentMessageIds.has(messageId)
      )
    ) {
      return;
    }
    viewportForcedVirtualContentMessageIds.clear();
    for (const messageId of nextForcedMessageIds) {
      viewportForcedVirtualContentMessageIds.add(messageId);
    }
    setMeasurementVersion((version) => version + 1);
  }

  function flushStickyPreviewFrame() {
    stickyPreviewFrameScheduled = false;
    stickyPreviewFrameRafId = 0;
    syncViewportForcedVirtualContent();
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
      if (!current || !shouldHideStickyUserMessagePreviewAfterLayout(current)) return;

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

  function publishPendingWidthMeasurements(options?: { preserveVisibleAnchor?: boolean }) {
    if (!pendingWidthMeasurementPublish) return false;
    const anchor = options?.preserveVisibleAnchor === false ? null : widthResizeAnchor;
    pendingWidthMeasurementPublish = false;
    if (!anchor) {
      publishMeasurementVersion(options);
      return true;
    }

    publishMeasurementVersion({ preserveVisibleAnchor: false });
    queueMicrotask(() => {
      if (
        disposed ||
        autoScroll() ||
        diffFocusPauseActive ||
        pendingStructuralScrollAnchor ||
        stickyNavigationOwnsScroll() ||
        editingMessage()
      ) {
        return;
      }
      restoreVisibleScrollAnchor(anchor, { useMessageOffsetFallback: true });
    });
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
    widthResizeAnchor = null;
    queueMicrotask(() => {
      if (epoch === widthResizeEpoch && !widthResizeActive) {
        setWidthResizePinnedMessageId(null);
      }
    });

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
    if (!widthResizeAnchor && !autoScroll()) {
      const wheelAnchor = pendingWheelResizeAnchor;
      const containerRect = containerRef?.getBoundingClientRect();
      // The wheel anchor is a prediction captured at gesture time and may be minutes old;
      // unlike freshly captured anchors it must re-verify visibility before use.
      const wheelAnchorElement = wheelAnchor?.element ?? null;
      const wheelAnchorRect = wheelAnchorElement?.getBoundingClientRect();
      const wheelAnchorIsVisible = !!(
        wheelAnchor &&
        wheelAnchorElement &&
        containerRef?.contains(wheelAnchorElement) &&
        wheelAnchorElement.isConnected &&
        containerRect &&
        wheelAnchorRect &&
        wheelAnchorRect.bottom > containerRect.top &&
        wheelAnchorRect.top < containerRect.bottom
      );
      const usableWheelAnchor = wheelAnchorIsVisible ? wheelAnchor : null;
      pendingWheelResizeAnchor = null;
      const rememberedElement = lastDetachedVisibleAnchor
        ? getMountedScrollAnchorElement(lastDetachedVisibleAnchor)
        : null;
      const rememberedRect = rememberedElement?.getBoundingClientRect();
      const rememberedElementIsVisible = !!(
        rememberedRect &&
        containerRect &&
        rememberedRect.bottom > containerRect.top &&
        rememberedRect.top < containerRect.bottom
      );
      const rememberedAnchor =
        lastDetachedVisibleAnchor && rememberedElementIsVisible ? lastDetachedVisibleAnchor : null;
      const virtualAnchor =
        containerRef && shouldVirtualize()
          ? captureDetachedVisibleScrollAnchor(containerRef.scrollTop)
          : null;
      widthResizeAnchor =
        usableWheelAnchor ??
        rememberedAnchor ??
        virtualAnchor ??
        captureMountedVisibleScrollAnchor();
      setWidthResizePinnedMessageId(widthResizeAnchor?.messageId ?? null);
      restoreVisibleScrollAnchor(widthResizeAnchor);
    }
    widthResizeActive = true;
    widthResizeIncludesFontChange ||= !!options?.fontChanged;
    pendingWidthStickyRefresh = true;
    if (autoScroll()) pendingWidthFollowCorrection = true;
    const contentFollowRequired = !!(
      state.streamingPartId ||
      state.streamingText.length > 0 ||
      visibleRunningToolPart() ||
      activeSessionWorking() ||
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
    widthResizeAnchor = null;
    setWidthResizePinnedMessageId(null);
  }

  function finishWidthResizeNow() {
    if (!widthResizeActive) return;
    if (widthResizeSettleTimer) clearTimeout(widthResizeSettleTimer);
    finishWidthResize(widthResizeEpoch);
  }

  const measuredHeights = new Map<string, number>();
  const [knownZeroHeightMessageIds, setKnownZeroHeightMessageIds] = createSignal<
    ReadonlySet<string>
  >(new Set());
  const zeroHeightRenderContentSignatures = new Map<string, string>();
  const forcedVirtualContentMessageIds = new Set<string>();
  const viewportForcedVirtualContentMessageIds = new Set<string>();
  const measuredRowInlineSizes = new WeakMap<HTMLElement, number>();
  const appliedRowHeightCorrections = new WeakMap<HTMLElement, number>();
  const pendingRowHeightCorrections = new Map<HTMLElement, number>();
  let rowHeightCorrectionScheduled = false;
  let lastTrackHeight = 0;
  let cachedVirtualMetrics: VirtualMetrics | null = null;
  let cachedVirtualMetricsItemIds: string[] | null = null;
  let dirtyVirtualMetricsFromIndex = Number.POSITIVE_INFINITY;
  let lastVirtualContentOrigin = 0;
  let previousResizeMessageIds: readonly string[] | null = null;
  let loadingRowReappearTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let loadingRowReserveReleaseTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let loadingRowHiddenByVisibleStream = false;
  let loadingRowReservedForMessageHydration = false;
  let appendBottomReserveTarget = 0;

  function getVirtualContentOrigin() {
    if (!containerRef) return lastVirtualContentOrigin;
    if (!trackRef) return lastVirtualContentOrigin;

    const trackOffset =
      trackRef.getBoundingClientRect().top -
      containerRef.getBoundingClientRect().top +
      containerRef.scrollTop;
    // Synthetic/no-layout environments often return a fixed track rect while scrollTop changes.
    // That is not a content origin and must not be allowed to shift every virtual prefix.
    if (!Number.isFinite(trackOffset) || Math.abs(trackOffset) > 1) return 0;

    const trackStyles = getComputedStyle(trackRef);
    let origin = trackOffset + (Number.parseFloat(trackStyles.paddingTop) || 0);
    const historyBanner = trackRef.querySelector<HTMLElement>('.message-history-banner');
    if (historyBanner) {
      const bannerStyles = getComputedStyle(historyBanner);
      origin +=
        historyBanner.getBoundingClientRect().height +
        (Number.parseFloat(bannerStyles.marginTop) || 0) +
        (Number.parseFloat(bannerStyles.marginBottom) || 0);
    }
    if (Number.isFinite(origin)) lastVirtualContentOrigin = origin;
    return lastVirtualContentOrigin;
  }

  function getVirtualScrollTop(containerScrollTop: number) {
    return containerScrollTop - getVirtualContentOrigin();
  }

  function getContainerScrollTopForVirtualOffset(offset: number) {
    return offset + getVirtualContentOrigin();
  }

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

  function markVirtualMetricsDirty(messageId: string) {
    if (dirtyVirtualMetricsFromIndex === 0) return;
    const index = messageIndexById().get(messageId);
    if (!isNumber(index)) return;
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
    getCompactActivityLayoutSignatures(messages())
  );
  let previousCompactActivityLayoutSignatures = new Map<string, string>();
  const thinkingLayoutSignatures = createMemo(() =>
    getThinkingLayoutSignatures(messages(), showThinking())
  );
  let previousThinkingLayoutSignatures = new Map<string, string>();

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
    if (idsChanged && state.activeSessionId) {
      // Yield to both the message and virtual-range reconciliations, but still correct before paint.
      queueMicrotask(() => {
        queueMicrotask(() => {
          restorePendingHistoryAnchorIfMounted();
        });
      });
    }
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
    for (const messageId of forcedVirtualContentMessageIds) {
      if (!currentMessageIdSet.has(messageId)) forcedVirtualContentMessageIds.delete(messageId);
    }
    for (const messageId of viewportForcedVirtualContentMessageIds) {
      if (!currentMessageIdSet.has(messageId)) {
        viewportForcedVirtualContentMessageIds.delete(messageId);
      }
    }
  });

  function scheduleChangedLayoutRowMeasurements(
    previous: ReadonlyMap<string, string>,
    current: ReadonlyMap<string, string>,
    preferredAnchor?: VisibleScrollAnchor | null
  ) {
    const currentMessageIds = new Set(messageIds());
    const mountedRows: Array<{ element: HTMLDivElement; messageId: string }> = [];
    const unmountedMessageIds: string[] = [];

    for (const messageId of getChangedInlinePreviewMessageIds(
      previous,
      current,
      currentMessageIds
    )) {
      const mountedRow = trackRef?.querySelector<HTMLDivElement>(
        `[data-msg-id="${CSS.escape(messageId)}"]`
      );
      if (!mountedRow || mountedRow.classList.contains('interactive-item-virtual-placeholder')) {
        unmountedMessageIds.push(messageId);
        continue;
      }
      mountedRows.push({ element: mountedRow, messageId });
    }

    const invalidatedUnmountedHeight = unmountedMessageIds.some((messageId) =>
      measuredHeights.has(messageId)
    );
    const activeSessionId = state.activeSessionId;
    const invalidatedAnchorOwnershipEpoch = userScrollOwnershipEpoch;
    const preferredLayoutAnchor = preferredAnchor ?? pendingThinkingLayoutAnchor;
    const invalidatedAnchor =
      (invalidatedUnmountedHeight || mountedRows.length > 0) &&
      !autoScroll() &&
      !followModeLocked &&
      !pendingScrollToBottomRequest &&
      appendScrollRafId === 0 &&
      !stickyNavigationOwnsScroll() &&
      !editingMessage() &&
      !pendingExpansionScrollAnchor &&
      !pendingStructuralScrollAnchor &&
      !diffFocusPauseActive &&
      !(activeSessionId && getCurrentPendingHistoryAnchor(activeSessionId))
        ? shouldVirtualize()
          ? (preferredLayoutAnchor ??
            (lastDetachedVisibleAnchor && getMountedScrollAnchorElement(lastDetachedVisibleAnchor)
              ? lastDetachedVisibleAnchor
              : captureDetachedVisibleScrollAnchor(containerRef?.scrollTop ?? 0)))
          : captureVisibleScrollAnchor()
        : null;
    for (const messageId of unmountedMessageIds) {
      if (!measuredHeights.delete(messageId)) continue;
      zeroHeightRenderContentSignatures.delete(messageId);
      markVirtualMetricsDirty(messageId);
    }

    const publishChangedLayout = () => {
      publishMeasurementVersion();
      if (!invalidatedAnchor) return;
      queueMicrotask(() => {
        if (
          userScrollOwnershipEpoch === invalidatedAnchorOwnershipEpoch &&
          !stickyNavigationOwnsScroll() &&
          !pendingExpansionScrollAnchor
        ) {
          restoreVisibleScrollAnchor(invalidatedAnchor, { useMessageOffsetFallback: true });
          void (async () => {
            for (let attempt = 0; attempt < 12; attempt += 1) {
              await waitForAnimationFrame();
              if (
                userScrollOwnershipEpoch !== invalidatedAnchorOwnershipEpoch ||
                stickyNavigationOwnsScroll() ||
                pendingExpansionScrollAnchor
              ) {
                return;
              }
              restoreVisibleScrollAnchor(invalidatedAnchor, { useMessageOffsetFallback: true });
            }
          })();
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
      if (!measuredMountedHeight && !invalidatedUnmountedHeight && !invalidatedAnchor) return;
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
    const current = thinkingLayoutSignatures();
    const preferredAnchor = pendingThinkingLayoutAnchor;
    scheduleChangedLayoutRowMeasurements(
      previousThinkingLayoutSignatures,
      current,
      preferredAnchor
    );
    queueMicrotask(() => {
      if (pendingThinkingLayoutAnchor === preferredAnchor) {
        pendingThinkingLayoutAnchor = null;
      }
    });

    previousThinkingLayoutSignatures = new Map(current);
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
      forcedVirtualContentMessageIds.add(messageId);
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

  const structurallyTrailingFinalResponseCandidateMessageId = createMemo(() => {
    messageStructureVersion();
    messageInfoVersion();

    const entries = messages();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.info.role === 'user') return null;
      if (entry.info.mode === 'subagent') continue;
      if (isContinuationAssistantFinish(entry.info.finish)) return null;

      const finalTextPartId = getFinalAssistantTextPartId(entry.parts, true);
      if (!finalTextPartId) return null;
      const finalTextPartIndex = entry.parts.findIndex((part) => part.id === finalTextPartId);
      const finalTextPart = entry.parts[finalTextPartIndex];
      return finalTextPart?.type === 'text' &&
        !isWorkspaceDirectoryText(finalTextPart.text.trimStart()) &&
        !entry.parts.slice(finalTextPartIndex + 1).some((part) => part.type === 'tool')
        ? entry.info.id
        : null;
    }
    return null;
  });
  const structurallyTrailingFinalResponseMessageId = createMemo(() => {
    const messageId = structurallyTrailingFinalResponseCandidateMessageId();
    if (!messageId) return null;
    const info = messages().find((entry) => entry.info.id === messageId)?.info;
    return info && isAssistantMessage(info) && info.time.completed ? messageId : null;
  });
  const trailingFinalResponseMessageId = createMemo(() => {
    if (state.streamingPartId || state.streamingText.length > 0) return null;
    return structurallyTrailingFinalResponseMessageId();
  });
  const explicitTerminalFinalResponseMessageId = createMemo(() => {
    const messageId = structurallyTrailingFinalResponseMessageId();
    if (!messageId) return null;
    const info = messages().find((entry) => entry.info.id === messageId)?.info;
    return info?.role === 'assistant' &&
      !!info.finish &&
      !isContinuationAssistantFinish(info.finish)
      ? messageId
      : null;
  });
  const structurallyTrailingRejectedInteractionMessageId = createMemo(() => {
    messageStructureVersion();
    messageInfoVersion();

    const entries = messages();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.info.role === 'user') return null;
      if (entry.info.mode === 'subagent') continue;
      return entry.info.time.completed &&
        entry.parts.some(
          (part) =>
            part.type === 'tool' &&
            (isPermissionRejectedToolError(part.state) || isQuestionSkippedToolError(part.state))
        )
        ? entry.info.id
        : null;
    }
    return null;
  });
  const structurallyTrailingInterruptedMessageId = createMemo(() => {
    messageStructureVersion();
    messageInfoVersion();

    const entries = messages();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.info.role === 'user') return null;
      if (entry.info.mode === 'subagent') continue;
      return isAbortedAssistantError(entry.info.error) ? entry.info.id : null;
    }
    return null;
  });
  const trailingSummaryMessageId = createMemo(
    () =>
      structurallyTrailingInterruptedMessageId() ??
      explicitTerminalFinalResponseMessageId() ??
      structurallyTrailingRejectedInteractionMessageId() ??
      trailingSummaryOwner()?.messageId ??
      (!isLoading() && !activeSessionWorking() ? trailingFinalResponseMessageId() : null) ??
      null
  );

  const loadingRowEligible = createMemo(
    () =>
      !!state.activeSessionId &&
      (activeSessionWorking() ||
        activePermissionReviewInFlight() ||
        hasIncompleteLatestVisibleAssistantReply()) &&
      !hasActiveQuestion() &&
      !hasActivePermission() &&
      !activeUsageLimit()
  );

  const shouldShowLoadingRow = createMemo(
    () =>
      loadingRowEligible() &&
      !visibleBlockingStreamingPart() &&
      !committedTextBlocksReappear() &&
      !visibleRunningInlineFileEdit() &&
      !hasVisibleActivityTrayRows()
  );

  createEffect(() => {
    const loadingMessages = state.messagesLoading;
    const hasMessages = messages().length > 0;
    const isReserved = reserveLoadingRow();

    if (loadingMessages && state.activeSessionId && !hasMessages) {
      loadingRowReservedForMessageHydration = true;
      if (!isReserved) setReserveLoadingRow(true);
      return;
    }

    if (!loadingRowReservedForMessageHydration) return;
    if (hasMessages) {
      loadingRowReservedForMessageHydration = false;
      return;
    }
    if (loadingMessages) return;

    loadingRowReservedForMessageHydration = false;
    if (!loadingRowEligible() && isReserved) {
      setReserveLoadingRow(false);
    }
  });

  createEffect(() => {
    const eligible = loadingRowEligible();
    const blockedByVisibleStream = eligible && visibleBlockingStreamingPart();
    const blockedByCommittedText = eligible && committedTextBlocksReappear();
    const blockedByVisibleInlineFileEdit = eligible && visibleRunningInlineFileEdit();
    const blockedByVisibleActivity = eligible && hasVisibleActivityTrayRows();
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

    if (
      blockedByVisibleStream ||
      blockedByCommittedText ||
      blockedByVisibleInlineFileEdit ||
      blockedByVisibleActivity
    ) {
      clearLoadingRowReappearTimer();
      loadingRowHiddenByVisibleStream = blockedByVisibleStream;
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
      knownZeroHeightIds: knownZeroHeightMessageIds(),
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
      loadingOlderHistoryOwners();
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
        scrollTop: getVirtualScrollTop(scrollTop()),
        viewportHeight: viewportHeight(),
      });
      const sessionId = state.activeSessionId;
      const pendingAnchor = sessionId ? getCurrentPendingHistoryAnchor(sessionId) : undefined;
      const structuralAnchor =
        pendingStructuralScrollAnchor?.sessionId === sessionId &&
        pendingStructuralScrollAnchor.ownershipEpoch === userScrollOwnershipEpoch
          ? pendingStructuralScrollAnchor.anchor
          : null;
      const widthAnchorMessageId = widthResizePinnedMessageId();
      const anchorIndex =
        pendingAnchor && !pendingAnchor.invalidated && pendingAnchor.anchor
          ? messageIndexById().get(pendingAnchor.anchor.messageId)
          : structuralAnchor
            ? messageIndexById().get(structuralAnchor.messageId)
            : widthAnchorMessageId
              ? messageIndexById().get(widthAnchorMessageId)
              : undefined;
      if (anchorIndex === undefined) return range;

      // A prepend can temporarily place the old viewport thousands of provisional pixels away.
      // Keep its real anchor mounted so exact DOM geometry is available before the next paint.
      const start = Math.min(range.start, anchorIndex);
      const end = Math.max(range.end, anchorIndex + 1);
      const pinnedGapStart =
        anchorIndex < range.start
          ? anchorIndex + 1
          : anchorIndex >= range.end
            ? range.end
            : undefined;
      const pinnedGapEnd =
        anchorIndex < range.start
          ? range.start
          : anchorIndex >= range.end
            ? anchorIndex
            : undefined;
      return {
        start,
        end,
        coreStart: range.coreStart,
        coreEnd: range.coreEnd,
        pinnedIndex: anchorIndex,
        pinnedGapStart,
        pinnedGapEnd,
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
  const pendingPermissionSequence = createMemo<PendingPermissionSequence>((previous) =>
    reconcilePendingPermissionSequence(previous, state.permissions, state.activeSessionId)
  );
  const renderedMessages = createMemo(() => {
    measurementVersion();
    const activePermissionMessageId = pendingPermissionSequence().activePermission?.messageID;
    return getRenderedMessages(messages(), visibleRange(), shouldVirtualize(), (messageId) => {
      return (
        forcedVirtualContentMessageIds.has(messageId) ||
        viewportForcedVirtualContentMessageIds.has(messageId) ||
        displayedStickyUserMessagePreview()?.id === messageId ||
        activePermissionMessageId === messageId
      );
    });
  });
  const linkedToolCalls = createMemo(() => {
    messageStructureVersion();
    return getLinkedToolCallKeys(renderedMessages());
  });
  let previousActivePermissionId: string | null | undefined;
  createEffect(() => {
    const permissionId = pendingPermissionSequence().activePermission?.id ?? null;
    if (previousActivePermissionId === undefined) {
      previousActivePermissionId = permissionId;
      return;
    }
    if (!permissionId || permissionId === previousActivePermissionId) {
      previousActivePermissionId = permissionId;
      return;
    }
    previousActivePermissionId = permissionId;

    queueMicrotask(() => {
      if (
        pendingPermissionSequence().activePermission?.id !== permissionId ||
        (!autoScroll() && !pinnedToBottom)
      ) {
        return;
      }
      clearActivityExitReserve();
      requestMessageListScrollToBottom();
    });
  });
  const standalonePermissions = createMemo(() => {
    if (state.messagesLoading) return [];
    const activePermission = pendingPermissionSequence().activePermission;
    if (!activePermission) return [];
    return getStandalonePermissionPrompts(
      untrack(() => state.messages),
      [activePermission],
      state.activeSessionId,
      linkedToolCalls()
    );
  });
  const standaloneQuestions = createMemo(() => {
    const questions = getStandaloneQuestionPrompts(
      untrack(() => state.messages),
      state.questions,
      state.activeSessionId,
      linkedToolCalls()
    );
    if (!state.messagesLoading) return questions;

    return questions.filter(
      (question) =>
        getToolCallLookupKey(
          question.sessionID,
          question.tool?.messageID,
          question.tool?.callID
        ) === null
    );
  });
  const activeSessionRootId = createMemo(
    () => getSessionTreeRootId(state.activeSessionId) || state.activeSessionId
  );

  createEffect(() => {
    const sessionId = state.activeSessionId;
    const owner = trailingSummaryOwner();
    const ownerMatchesCurrentResponse =
      owner &&
      owner.sessionId === sessionId &&
      owner.messageId === structurallyTrailingFinalResponseCandidateMessageId();
    if (ownerMatchesCurrentResponse) {
      const streaming = !!state.streamingPartId || state.streamingText.length > 0;
      if (streaming && !trailingSummaryOwnerConfirmed()) {
        trailingSummaryOwnerEpoch += 1;
        batch(() => {
          setTrailingSummarySettled(false);
          setTrailingSummaryOwner(null);
          setTrailingSummaryOwnerConfirmed(false);
        });
        return;
      }
      if (!trailingSummarySettled()) setTrailingSummarySettled(true);
      return;
    }

    const messageId = trailingFinalResponseMessageId();
    const settled = !activeSessionWorking() && messageId !== null;
    const nextOwner = settled && sessionId && messageId ? { sessionId, messageId } : null;
    const ownerEpoch = ++trailingSummaryOwnerEpoch;
    batch(() => {
      setTrailingSummarySettled(settled);
      setTrailingSummaryOwner(nextOwner);
      setTrailingSummaryOwnerConfirmed(false);
      if (settled && !loadingRowEligible()) setReserveLoadingRow(false);
    });
    if (nextOwner) {
      queueMicrotask(() => {
        if (disposed || ownerEpoch !== trailingSummaryOwnerEpoch) return;
        setTrailingSummaryOwnerConfirmed(true);
      });
    }
  });

  const questionRequestsByToolCall = createMemo(() =>
    buildQuestionRequestLookup(state.questions, activeSessionRootId())
  );
  const permissionRequestsByToolCall = createMemo(() => {
    const sequence = pendingPermissionSequence();
    return buildPermissionRequestLookup(
      state.permissions,
      activeSessionRootId(),
      sequence.position,
      sequence.total,
      sequence.activePermission?.id
    );
  });

  function getQuestionRequestForTool(part: Extract<Part, { type: 'tool' }>) {
    const key = getToolCallLookupKey(activeSessionRootId(), part.messageID, part.callID);
    return key ? (questionRequestsByToolCall().get(key) ?? null) : null;
  }

  function getPermissionMatchForTool(part: Extract<Part, { type: 'tool' }>) {
    if (state.messagesLoading) return null;
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
        ? (() => {
            const metrics = virtualMetrics();
            return calculateVirtualRangeFromMetrics({
              metrics,
              scrollTop: getVirtualScrollTop(currentScrollTop),
              viewportHeight: currentViewportHeight,
            });
          })()
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
      const metrics = untrack(virtualMetrics);
      firstVisibleMessageIndex = getFirstVisibleMessageIndexFromVirtualMetrics({
        metrics,
        scrollTop: getVirtualScrollTop(currentScrollTop),
      });
    }

    let preview = getStickyUserMessagePreview(
      visibleMessages,
      firstVisibleMessageIndex,
      subagentSessionIds()
    );
    let usesBoundaryPrompt = false;
    if (
      !preview &&
      firstVisibleMessageIndex !== null &&
      visibleMessages[firstVisibleMessageIndex]?.info.role === 'assistant'
    ) {
      const loadedMessageIds = new Set(visibleMessages.map((entry) => entry.info.id));
      const boundaryPrompts = getSessionHistoryPrompts(state.activeSessionId)
        .filter((entry) => !loadedMessageIds.has(entry.info.id))
        .toSorted((left, right) => left.info.time.created - right.info.time.created);
      if (boundaryPrompts.length > 0) {
        const boundaryPreview = getStickyUserMessagePreview(
          [...boundaryPrompts, visibleMessages[firstVisibleMessageIndex]!],
          boundaryPrompts.length
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
    const currentPreviewIndex = messageIndexById().get(preview.id) ?? preview.index;
    const nextUserMessageTop = getStickyUserMessageNextUserMessageTop(
      currentPreviewIndex,
      containerRect
    );
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
    // A placeholder's block size comes from virtual metrics; recording it as a measurement would
    // promote a provisional estimate to an exact content height.
    if (element.classList.contains('interactive-item-virtual-placeholder')) return false;
    if (height !== 0) {
      zeroHeightRenderContentSignatures.delete(messageId);
      forcedVirtualContentMessageIds.delete(messageId);
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
      : Math.max(1, Math.floor((containerRef?.scrollHeight || 0) / Math.max(1, items.length)));
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
      const height = alignMeasuredRowBlockSize(element, rect.height);
      if (!shouldAcceptRowHeight(element, messageId, height)) return [];
      return [{ messageId, height }];
    });
    if (!applyRowHeightMeasurements(measurements)) return false;
    if (publish) scheduleMeasurementPublish('content');
    return true;
  }

  function measureMountedRow(element: HTMLDivElement, messageId: string) {
    return measureMountedRows([{ element, messageId }]);
  }

  function applyRowHeightMeasurements(
    measurements: Array<{ messageId: string; height: number }>,
    options?: { widthReflow?: boolean }
  ) {
    // ResizeObserver reports after layout. Use the old prefix metrics to offset growth above the
    // viewport before paint, including while the user is actively scrolling.
    const metricsBefore = containerRef && shouldVirtualize() ? virtualMetrics() : null;
    const activeSessionId = state.activeSessionId;
    const historyOwnsAnchor = !!(
      activeSessionId && getCurrentPendingHistoryAnchor(activeSessionId)?.anchor
    );
    let firstVisibleIndex: number | null = null;
    if (metricsBefore && containerRef && !autoScroll() && !historyOwnsAnchor) {
      firstVisibleIndex =
        options?.widthReflow && widthResizeAnchor
          ? (messageIndexById().get(widthResizeAnchor.messageId) ?? null)
          : lastDetachedVisibleAnchor && getMountedScrollAnchorElement(lastDetachedVisibleAnchor)
            ? (messageIndexById().get(lastDetachedVisibleAnchor.messageId) ?? null)
            : getFirstVisibleMessageIndexFromVirtualMetrics({
                metrics: metricsBefore,
                scrollTop: getVirtualScrollTop(containerRef.scrollTop),
              });
    }
    let scrollAdjustment = 0;
    let changed = false;

    for (const { messageId, height } of measurements) {
      const previousHeight = measuredHeights.get(messageId);
      if ((previousHeight ?? -1) === height) continue;

      if (height > 0) {
        zeroHeightRenderContentSignatures.delete(messageId);
      }

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
    if (widthResizeActive && widthResizeAnchor) {
      restoreVisibleScrollAnchor(widthResizeAnchor);
    }

    return changed;
  }

  function setMeasuredHeightsFor(entries: ResizeObserverEntry[]) {
    const measurements: Array<{ messageId: string; height: number }> = [];
    let everyInlineSizeChanged = entries.length > 0;
    for (const entry of entries) {
      // SAFETY: The surrounding shape or discriminator check establishes the HTMLDivElement contract used below.
      const element = entry.target as HTMLDivElement;
      const messageId = element.dataset.msgId;
      const borderBoxSize = entry.borderBoxSize?.[0];
      const rect = borderBoxSize ? null : element.getBoundingClientRect();
      const measuredHeight = borderBoxSize?.blockSize ?? rect?.height ?? 0;
      const inlineSize = borderBoxSize?.inlineSize ?? rect?.width ?? 0;
      if (
        !messageId ||
        !element.isConnected ||
        mountedMessageRows.get(messageId) !== element ||
        measuredHeight < 0
      ) {
        continue;
      }

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
    let widthReflowOnly =
      measurements.length > 0 &&
      (everyInlineSizeChanged || fontChanged || widthResizeIncludesFontChange);

    if (state.streamingPartId || state.streamingText.length > 0 || pendingExpansionScrollAnchor) {
      widthReflowOnly = false;
    }

    if (widthReflowOnly) beginWidthResize();
    if (!applyRowHeightMeasurements(measurements, { widthReflow: widthReflowOnly })) return;

    scheduleMeasurementPublish(widthReflowOnly ? 'width' : 'content');
    restorePendingHistoryAnchorIfMounted();
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

      // Compact activity summaries can move to an older owner after a prepend. Follow their
      // preserved group identity across rows; otherwise prefer stable transcript content.
      for (const element of row.querySelectorAll<HTMLElement>('[data-assistant-render-key]')) {
        const renderKey = element.dataset.assistantRenderKey;
        if (!renderKey || element.getClientRects().length === 0) continue;
        const elementRect = element.getBoundingClientRect();
        if (
          elementRect.bottom <= containerRect.top ||
          elementRect.top >= containerRect.bottom ||
          elementRect.height <= 0
        ) {
          continue;
        }
        const activityGroupKey = element.dataset.assistantActivityGroupKey;
        if (renderKey.startsWith('activity-group:')) {
          if (!activityGroupKey) continue;
          return {
            messageId,
            activityGroupKey,
            top: elementRect.top - containerRect.top,
            messageTop: rowAnchor.top,
            topPad,
          };
        }
        return {
          messageId,
          renderKey,
          top: elementRect.top - containerRect.top,
          messageTop: rowAnchor.top,
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
      scrollTop: getVirtualScrollTop(containerRef.scrollTop),
    });
    const messageId = index === null ? null : messageIds()[index];
    if (index !== null && messageId) {
      return {
        messageId,
        top:
          getContainerScrollTopForVirtualOffset(metrics.prefix[index] ?? 0) -
          containerRef.scrollTop,
        topPad: visibleRange().topPad,
      };
    }
    return null;
  }

  function captureMountedVisibleScrollAnchor() {
    return captureMountedVisibleScrollAnchorWithTopPad(0);
  }

  function captureLastRetainedVisibleScrollAnchor(
    previousIds: readonly string[] | null,
    currentIds: readonly string[]
  ) {
    if (!containerRef || !previousIds) return null;
    let sharedPrefixLength = 0;
    while (
      sharedPrefixLength < previousIds.length &&
      previousIds[sharedPrefixLength] === currentIds[sharedPrefixLength]
    ) {
      sharedPrefixLength += 1;
    }

    const containerRect = containerRef.getBoundingClientRect();
    for (let index = sharedPrefixLength - 1; index >= 0; index -= 1) {
      const messageId = previousIds[index];
      if (!messageId) continue;
      const row =
        mountedMessageRows.get(messageId) ??
        containerRef.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`);
      if (!row) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue;
      return captureMessageScrollAnchor(messageId);
    }
    return null;
  }

  function captureDetachedVisibleScrollAnchor(containerScrollTop: number) {
    if (!shouldVirtualize()) return captureMountedVisibleScrollAnchor();

    const metrics = virtualMetrics();
    const index = getFirstVisibleMessageIndexFromVirtualMetrics({
      metrics,
      scrollTop: containerScrollTop - lastVirtualContentOrigin,
    });
    const messageId = index === null ? null : messageIds()[index];
    if (index === null || !messageId) return null;
    return {
      messageId,
      top: lastVirtualContentOrigin + (metrics.prefix[index] ?? 0) - containerScrollTop,
      topPad: 0,
    };
  }

  function capturePaintedVisibleScrollAnchorFromIndex(startIndex: number) {
    if (!containerRef) return null;
    const startMessageId = messageIds()[startIndex];
    if (!startMessageId) return null;
    const containerRect = containerRef.getBoundingClientRect();
    let fallback: VisibleScrollAnchor | null = null;
    // Prefix lookup can land on a row whose gap is visible after its content has cleared the viewport.
    let row: HTMLElement | null = mountedMessageRows.get(startMessageId) ?? null;
    while (row) {
      const rowRect = row.getBoundingClientRect();
      if (rowRect.top >= containerRect.bottom) break;
      const messageId = row.dataset.msgId;
      if (messageId && rowRect.bottom > containerRect.top) {
        fallback ??= { messageId, top: rowRect.top - containerRect.top, topPad: 0 };
        for (const element of row.querySelectorAll<HTMLElement>('[data-assistant-render-key]')) {
          const renderKey = element.dataset.assistantRenderKey;
          if (!renderKey) continue;
          const elementRect = element.getBoundingClientRect();
          if (
            elementRect.height <= 0 ||
            elementRect.bottom <= containerRect.top ||
            elementRect.top >= containerRect.bottom
          ) {
            continue;
          }
          const activityGroupKey = element.dataset.assistantActivityGroupKey;
          return {
            messageId,
            ...(renderKey.startsWith('activity-group:') && activityGroupKey
              ? { activityGroupKey }
              : { renderKey }),
            top: elementRect.top - containerRect.top,
            messageTop: rowRect.top - containerRect.top,
            topPad: 0,
          };
        }
        for (const child of row.children) {
          if (!(child instanceof HTMLElement)) continue;
          const childRect = child.getBoundingClientRect();
          if (
            childRect.height > 0 &&
            childRect.bottom > containerRect.top &&
            childRect.top < containerRect.bottom
          ) {
            return { messageId, top: rowRect.top - containerRect.top, topPad: 0 };
          }
        }
      }
      row = row.nextElementSibling instanceof HTMLElement ? row.nextElementSibling : null;
    }
    return fallback;
  }

  function captureVisibleUserMessageScrollAnchor() {
    if (!containerRef) return null;
    const containerRect = containerRef.getBoundingClientRect();
    for (const card of containerRef.querySelectorAll<HTMLElement>('.user-message-card')) {
      const row = card.closest<HTMLElement>('[data-msg-id]');
      const messageId = row?.dataset.msgId;
      if (!row || !messageId) continue;
      const cardRect = card.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (
        cardRect.bottom <= containerRect.top ||
        cardRect.top >= containerRect.top + containerRef.clientHeight / 3 ||
        cardRect.bottom <= rowRect.top ||
        cardRect.top >= rowRect.bottom
      ) {
        continue;
      }
      return {
        messageId,
        element: card,
        top: cardRect.top - containerRect.top,
        messageTop: rowRect.top - containerRect.top,
        topPad: 0,
      };
    }
    return null;
  }

  function refineTallRenderItemScrollAnchor(
    anchor: VisibleScrollAnchor | null,
    preferredViewportOffset = 0,
    options?: { includeCompact?: boolean }
  ) {
    if (!containerRef || !anchor) return anchor;
    const containerRect = containerRef.getBoundingClientRect();
    const preferredTop = Math.min(
      containerRect.bottom - 1,
      containerRect.top + Math.max(0, preferredViewportOffset)
    );
    const renderItem = getMountedScrollAnchorElement(
      anchor.element ? { ...anchor, element: undefined } : anchor
    );
    if (
      !renderItem ||
      (!options?.includeCompact &&
        renderItem.getBoundingClientRect().height <= containerRef.clientHeight)
    ) {
      return anchor;
    }
    if (!options?.includeCompact) {
      for (const userCard of containerRef.querySelectorAll<HTMLElement>('.user-message-card')) {
        const rect = userCard.getBoundingClientRect();
        if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) return anchor;
      }
    }

    const candidates = Array.from(
      renderItem.querySelectorAll<HTMLElement>(
        '.rendered-markdown :is(p, li, pre, table, blockquote, h1, h2, h3, h4, h5, h6)'
      )
    );
    let low = 0;
    let high = candidates.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[middle]!.getBoundingClientRect().bottom <= preferredTop) low = middle + 1;
      else high = middle;
    }
    let element = candidates[low];
    if (!element) return anchor;
    let rect = element.getBoundingClientRect();
    while (rect.top < preferredTop && candidates[low + 1]) {
      const next = candidates[low + 1]!;
      const nextRect = next.getBoundingClientRect();
      if (nextRect.top >= containerRect.bottom) break;
      low += 1;
      element = next;
      rect = nextRect;
    }
    if (rect.height <= 0 || rect.top >= containerRect.bottom) return anchor;

    const row = mountedMessageRows.get(anchor.messageId);
    return {
      ...anchor,
      element,
      top: rect.top - containerRect.top,
      messageTop: row ? row.getBoundingClientRect().top - containerRect.top : undefined,
    };
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
      (sessionId && getCurrentPendingHistoryAnchor(sessionId))
    );
  }

  function scheduleStructuralScrollAnchorRestore(
    anchor: VisibleScrollAnchor,
    sessionId: string | null,
    preserveBottom: boolean
  ) {
    const pending: NonNullable<typeof pendingStructuralScrollAnchor> = {
      anchor,
      sessionId,
      ownershipEpoch: userScrollOwnershipEpoch,
      preserveBottom,
      attempts: 0,
      stableFrames: 0,
      rafId: 0,
      observer: null,
    };
    pendingStructuralScrollAnchor = pending;

    // A replacement can temporarily shorten the track and clamp scrollTop. Restore on each DOM
    // mutation before paint; the frame loop below bounds ownership and handles measurement-only work.
    if (trackRef && globalThis.MutationObserver !== undefined) {
      const observer = new globalThis.MutationObserver(() => {
        if (
          pendingStructuralScrollAnchor !== pending ||
          state.activeSessionId !== sessionId ||
          userScrollOwnershipEpoch !== pending.ownershipEpoch ||
          !genericStructuralAnchorCanOwnScroll(sessionId)
        ) {
          clearPendingStructuralScrollAnchor(pending);
          return;
        }
        restoreVisibleScrollAnchor(anchor, {
          useMessageOffsetFallback: true,
          reserveBottomOverflow: preserveBottom,
        });
      });
      pending.observer = observer;
      observer.observe(trackRef, {
        attributes: true,
        attributeFilter: ['class', 'style'],
        childList: true,
        subtree: true,
      });
    }

    const settle = () => {
      pending.rafId = 0;
      if (pendingStructuralScrollAnchor !== pending) return;
      if (
        state.activeSessionId !== sessionId ||
        userScrollOwnershipEpoch !== pending.ownershipEpoch ||
        !genericStructuralAnchorCanOwnScroll(sessionId)
      ) {
        clearPendingStructuralScrollAnchor(pending);
        return;
      }

      pending.attempts += 1;
      restoreVisibleScrollAnchor(anchor, {
        useMessageOffsetFallback: true,
        reserveBottomOverflow: preserveBottom,
      });

      const element = getMountedScrollAnchorElement(anchor);
      if (element && containerRef) {
        const targetTop =
          element.dataset.msgId === anchor.messageId
            ? (anchor.messageTop ?? anchor.top)
            : anchor.top;
        const currentTop =
          element.getBoundingClientRect().top - containerRef.getBoundingClientRect().top;
        pending.stableFrames =
          Math.abs(currentTop - targetTop) <= 0.5 ? pending.stableFrames + 1 : 0;
      } else {
        pending.stableFrames = 0;
      }

      const stableLongEnough =
        pending.stableFrames >= 2 &&
        (!preserveBottom || pending.attempts >= STRUCTURAL_ANCHOR_SETTLE_FRAME_LIMIT);
      if (stableLongEnough || pending.attempts >= STRUCTURAL_ANCHOR_SETTLE_FRAME_LIMIT) {
        clearPendingStructuralScrollAnchor(pending);
        if (preserveBottom && sessionId) {
          appendBottomReserveTarget = 0;
          if (untrack(appendBottomReserve) > 0.5) setAppendBottomReserve(0);
          pinnedToBottom = true;
          setAutoScroll(true);
          queueMicrotask(() => {
            if (state.activeSessionId !== sessionId || !autoScroll()) return;
            performScroll({ force: true });
            startFollowLoop(sessionId);
          });
        }
        return;
      }

      pending.rafId = requestAnimationFrame(settle);
    };

    queueMicrotask(settle);
  }

  function clearPendingStructuralScrollAnchor(pending = pendingStructuralScrollAnchor) {
    if (!pending || pendingStructuralScrollAnchor !== pending) return;
    pending.observer?.disconnect();
    if (pending.rafId) cancelAnimationFrame(pending.rafId);
    pendingStructuralScrollAnchor = null;
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
    const pendingAnchor = getCurrentPendingHistoryAnchor(sessionId);
    if (!pendingAnchor) return false;
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
      : captureVisibleScrollAnchor();
    if (!anchor && preferredMessageId) return false;
    pendingAnchor.anchor = anchor;
    pendingAnchor.previousScrollHeight = containerRef.scrollHeight;
    pendingAnchor.previousScrollTop = containerRef.scrollTop;
    pendingAnchor.ownershipEpoch = userScrollOwnershipEpoch;
    return true;
  }

  function getMountedScrollAnchorElement(anchor: VisibleScrollAnchor) {
    if (!containerRef) return null;
    if (anchor.element?.isConnected && containerRef.contains(anchor.element)) return anchor.element;
    const row =
      mountedMessageRows.get(anchor.messageId) ??
      containerRef.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(anchor.messageId)}"]`);
    if (anchor.activityGroupKey) {
      return (
        row?.querySelector<HTMLElement>(
          `[data-assistant-activity-group-key="${CSS.escape(anchor.activityGroupKey)}"]`
        ) ?? row
      );
    }
    if (anchor.renderKey) {
      return (
        row?.querySelector<HTMLElement>(
          `[data-assistant-render-key="${CSS.escape(anchor.renderKey)}"]`
        ) ?? row
      );
    }
    return row;
  }

  function restorePendingHistoryAnchorIfMounted() {
    if (restoringPendingHistoryAnchor) return false;
    const sessionId = state.activeSessionId;
    if (!sessionId) return false;
    const pendingAnchor = getCurrentPendingHistoryAnchor(sessionId);
    if (
      !pendingAnchor ||
      pendingAnchor.invalidated ||
      pendingAnchor.ownershipEpoch !== userScrollOwnershipEpoch ||
      !pendingAnchor.anchor ||
      !getMountedScrollAnchorElement(pendingAnchor.anchor)
    ) {
      return false;
    }
    restoringPendingHistoryAnchor = true;
    try {
      return restoreVisibleScrollAnchor(pendingAnchor.anchor);
    } finally {
      // Solid flushes row mounts after the setter returns, so cover the rest of this update turn.
      queueMicrotask(() => {
        restoringPendingHistoryAnchor = false;
      });
    }
  }

  function restoreVisibleScrollAnchor(
    anchor: VisibleScrollAnchor | null,
    options?: { useMessageOffsetFallback?: boolean; reserveBottomOverflow?: boolean }
  ) {
    if (!containerRef) return false;
    let delta: number | null = null;
    if (anchor) {
      const element = getMountedScrollAnchorElement(anchor);
      if (element) {
        const containerRect = containerRef.getBoundingClientRect();
        const targetTop =
          element.dataset.msgId === anchor.messageId
            ? (anchor.messageTop ?? anchor.top)
            : anchor.top;
        delta = element.getBoundingClientRect().top - containerRect.top - targetTop;
      } else if (shouldVirtualize()) {
        if (options?.useMessageOffsetFallback) {
          const index = messageIndexById().get(anchor.messageId);
          if (index !== undefined) {
            const metrics = virtualMetrics();
            delta =
              getContainerScrollTopForVirtualOffset(metrics.prefix[index] ?? 0) -
              containerRef.scrollTop -
              anchor.top;
          }
        } else {
          delta = visibleRange().topPad - anchor.topPad;
        }
      }
    }

    if (delta === null) return false;
    if (Math.abs(delta) > 0.5) {
      const nextScrollTop = containerRef.scrollTop + delta;
      let waitForReserveMount = false;
      if (options?.reserveBottomOverflow) {
        // Keep the target reachable while replacement content consumes the temporary deficit.
        const currentReserve = untrack(appendBottomReserve);
        const unreservedBottom = Math.max(0, bottomScrollTop() - currentReserve);
        const requiredReserve = Math.max(0, nextScrollTop - unreservedBottom);
        if (requiredReserve > currentReserve + 0.5) {
          appendBottomReserveTarget = Math.max(appendBottomReserveTarget, nextScrollTop);
          setAppendBottomReserve(requiredReserve);
          waitForReserveMount = true;
        }
      }
      if (waitForReserveMount) {
        queueMicrotask(() => {
          if (!disposed) {
            setPreservedScrollTop(nextScrollTop);
          }
        });
      } else {
        setPreservedScrollTop(nextScrollTop);
      }
    }
    expectedScrollTop = -1;
    ignoreScrollUntil = 0;
    return true;
  }

  function publishMeasurementVersion(options?: { preserveVisibleAnchor?: boolean }) {
    if (!containerRef || options?.preserveVisibleAnchor === false) {
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
      if (!stickyNavigationOwnsScroll() && !userScrollRecentlyActive()) {
        restoreVisibleScrollAnchor(anchor);
      }
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
        shouldHideStickyUserMessagePreviewAfterLayout(currentStickyPreview)
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
    // The solid gap and fade paint below the card. Leave room for a row measurement that settles
    // between the scroll event and the next paint so the prompt cannot enter the overlay for a frame.
    const sticky = containerRef.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
    const stickyRect = sticky?.getBoundingClientRect();
    if (!stickyRect) return null;

    return {
      top: stickyRect.top - containerRect.top,
      bottom: stickyRect.bottom - containerRect.top + STICKY_PREVIEW_COLLISION_BUFFER_PX,
    };
  }

  function handleStickyPreviewGeometryChange() {
    scheduleStickyPreviewGeometryRefresh();
  }

  function getStickyUserMessageSourceElement(messageId: string) {
    const row = mountedMessageRows.get(messageId);
    return row?.querySelector<HTMLElement>('.user-message-card') ?? row;
  }

  function beginUpwardStickyHandoff(
    preview: StickyUserMessagePreview,
    sourceEntered: boolean,
    acceptsBoundaryEntry = false
  ) {
    if (upwardStickyHandoff?.messageId === preview.id) {
      upwardStickyHandoff.preview = preview;
      upwardStickyHandoff.acceptsBoundaryEntry ||= acceptsBoundaryEntry;
      upwardStickyHandoff.sourceEntered ||= sourceEntered;
      upwardStickyHandoff.lastInputAt = performance.now();
      return;
    }
    upwardStickyHandoff = {
      preview,
      messageId: preview.id,
      acceptsBoundaryEntry,
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
    if (getStickyUserMessagePreviewHideReason(handoff.preview) === 'next-prompt') {
      clearUpwardStickyHandoff();
      setStickyUserMessagePreview(null);
      previousStickyPreviewId = handoff.messageId;
      return false;
    }

    const containerRect = containerRef.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    if (handoff.preview.index === 0 && sourceRect.top >= containerRect.top) {
      clearUpwardStickyHandoff();
      setStickyUserMessagePreview(null);
      previousStickyPreviewId = handoff.messageId;
      return false;
    }
    const stickyOverlay = containerRef.querySelector<HTMLElement>(
      '.latest-user-message-sticky-overlay'
    );
    const stickyOverlayRect = stickyOverlay?.getBoundingClientRect();
    if (stickyOverlayRect && sourceRect.bottom > stickyOverlayRect.bottom) {
      clearUpwardStickyHandoff();
      setStickyUserMessagePreview(null);
      previousStickyPreviewId = handoff.messageId;
      return false;
    }
    if (sourceRect.bottom >= containerRect.top) {
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

  function getNextMountedUserMessageTop(messageId: string, containerRect: DOMRect) {
    if (!containerRef) return null;
    for (const row of containerRef.querySelectorAll<HTMLElement>('.interactive-request')) {
      if (row.dataset.msgId === messageId) continue;
      const source = row.querySelector<HTMLElement>('.user-message-card') ?? row;
      const rect = source.getBoundingClientRect();
      if (rect.bottom <= containerRect.top) continue;
      return rect.top - containerRect.top;
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

  function getStickyUserMessagePreviewHideReason(
    preview: StickyUserMessagePreview | null,
    geometry?: {
      containerRect: DOMRect;
      stickyBounds: { top: number; bottom: number };
    }
  ): 'next-prompt' | 'source' | null {
    if (!containerRef || !preview) return null;

    const containerRect = geometry?.containerRect ?? containerRef.getBoundingClientRect();
    const stickyBounds = geometry?.stickyBounds ?? getStickyUserMessagePreviewBounds(containerRect);
    if (!stickyBounds) return null;

    const currentPreviewIndex = messageIndexById().get(preview.id) ?? preview.index;
    const nextUserMessageTop =
      getNextMountedUserMessageTop(preview.id, containerRect) ??
      getStickyUserMessageNextUserMessageTop(currentPreviewIndex, containerRect);
    if (
      nextUserMessageTop !== null &&
      nextUserMessageTop !== undefined &&
      nextUserMessageTop <= stickyBounds.bottom
    ) {
      return 'next-prompt';
    }

    const row = getStickyUserMessageSourceElement(preview.id);
    if (!row) return null;

    if (containerRef.clientHeight <= 0) return null;

    const rowRect = row.getBoundingClientRect();
    const rowBottom = rowRect.bottom - containerRect.top;
    return isMessageHiddenBehindStickyPreview({
      rowBottom,
      nextUserMessageTop,
      stickyPreviewBottom: stickyBounds.bottom,
    })
      ? null
      : 'source';
  }

  function shouldHideStickyUserMessagePreviewImmediately(
    preview: StickyUserMessagePreview | null,
    geometry?: {
      containerRect: DOMRect;
      stickyBounds: { top: number; bottom: number };
    }
  ) {
    return getStickyUserMessagePreviewHideReason(preview, geometry) !== null;
  }

  function shouldHideStickyUserMessagePreviewAfterLayout(
    preview: StickyUserMessagePreview | null,
    geometry?: {
      containerRect: DOMRect;
      stickyBounds: { top: number; bottom: number };
    }
  ) {
    const reason = getStickyUserMessagePreviewHideReason(preview, geometry);
    if (reason !== 'source') return reason === 'next-prompt';
    if (preview?.index === 0 && containerRef) {
      const source = getStickyUserMessageSourceElement(preview.id);
      if (
        source &&
        source.getBoundingClientRect().top >= containerRef.getBoundingClientRect().top
      ) {
        return true;
      }
    }
    return !(activeSessionWorking() && !userScrollRecentlyActive());
  }

  function distanceFromBottom() {
    if (activityExitBottomTarget !== null && containerRef) {
      return Math.max(0, activityExitBottomTarget - containerRef.scrollTop);
    }
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
    if (activityExitBottomTarget !== null) return activityExitBottomTarget;

    return Math.max(0, containerRef.scrollHeight - containerRef.clientHeight);
  }

  function reserveActivityExitSpace(key: string) {
    if (
      !containerRef ||
      !autoScroll() ||
      (!pinnedToBottom && getDistanceFromBottom(containerRef) > 2) ||
      stickyNavigationOwnsScroll()
    ) {
      return;
    }
    const partId = key.slice(key.lastIndexOf('\u0000') + 1);
    const item = containerRef.querySelector<HTMLElement>(
      `[data-activity-part-id="${CSS.escape(partId)}"]`
    );
    if (!item) return;
    const preserveCurrentBottomTarget = () => {
      activityExitBottomTarget ??= containerRef!.scrollTop;
      if (containerRef!.scrollTop > activityExitBottomTarget + 0.5) {
        setPreservedScrollTop(activityExitBottomTarget);
      }
    };

    const tray = item.closest<HTMLElement>('.assistant-active-activity-tray');
    const gap = tray ? Number.parseFloat(getComputedStyle(tray).rowGap) || 0 : 0;
    const summary = tray?.querySelector<HTMLElement>('.assistant-active-activity-summary');
    const itemViewport = tray?.querySelector<HTMLElement>('.assistant-active-activity-items');
    const remainingItems = tray?.querySelectorAll(
      ':scope > .assistant-active-activity-items > .assistant-active-activity-item:not(.is-exiting)'
    );
    const maxVisibleItems = Number.parseInt(itemViewport?.dataset.maxVisibleItems || '', 10);
    if (
      remainingItems &&
      Number.isFinite(maxVisibleItems) &&
      remainingItems.length > maxVisibleItems
    ) {
      preserveCurrentBottomTarget();
      const target = activityExitBottomTarget;
      requestAnimationFrame(() => {
        if (
          target === null ||
          activityExitBottomTarget !== target ||
          !containerRef ||
          userScrollRecentlyActive()
        ) {
          return;
        }
        setPreservedScrollTop(target);
      });
      return;
    }

    let reserve = item.getBoundingClientRect().height + gap;
    if (tray && summary) {
      if (remainingItems?.length === 1 && remainingItems[0] === item) {
        reserve += Number.parseFloat(getComputedStyle(summary).marginBottom) || 0;
      }
    }
    if (tray && !tray.querySelector('.assistant-active-activity-summary')) {
      const flow = tray.parentElement;
      const visibleFlowItems = flow
        ? [...flow.children].filter((element) => element.getClientRects().length > 0)
        : [];
      if (
        remainingItems?.length === 1 &&
        remainingItems[0] === item &&
        visibleFlowItems.length === 1
      ) {
        const row = tray.closest<HTMLElement>('.interactive-item-container');
        if (row) {
          reserve += Math.max(
            0,
            row.getBoundingClientRect().height - tray.getBoundingClientRect().height
          );
        }
      }
    }
    if (reserve <= 0.5) return;

    preserveCurrentBottomTarget();
    captureActivityExitSummaryAnchor();
    if (activityExitSummaryAnchor) {
      startActivityExitSummaryObserver(activityExitSummaryAnchor);
      startActivityExitSummarySettle(activityExitSummaryAnchor);
    }
    setActivityExitBottomReserve((current) => current + reserve);
    queueMicrotask(() => {
      lastAutoScrolledTrackHeight = trackRef?.getBoundingClientRect().height ?? lastTrackHeight;
      lastAutoScrolledBottomScrollTop = activityExitBottomTarget ?? lastAutoScrolledBottomScrollTop;
    });
  }

  function captureActivityExitSummaryAnchor() {
    const sessionId = state.activeSessionId;
    if (!containerRef || !sessionId) return;
    if (activityExitSummaryAnchor?.sessionId === sessionId) return;
    const summaries = containerRef.querySelectorAll<HTMLElement>('.assistant-activity-summary');
    const summary = summaries[summaries.length - 1];
    if (!summary) return;
    activityExitSummaryAnchor = {
      sessionId,
      top: summary.getBoundingClientRect().top - containerRef.getBoundingClientRect().top,
    };
  }

  function startActivityExitSummaryObserver(anchor: { sessionId: string; top: number }) {
    if (!trackRef || activityExitSummaryObserver) return;
    activityExitSummaryObserver = new MutationObserver(() => {
      if (
        activityExitHeldResponseTextSignature !== null &&
        activityExitSummarySettleFrames === 0 &&
        activityExitBottomTarget === null &&
        exitingActivityPartKeys().size === 0 &&
        isLoading() &&
        getResponseTextSignature() !== activityExitHeldResponseTextSignature
      ) {
        clearActivityExitSummaryAnchor();
        performScroll({ force: true });
        startFollowLoop(anchor.sessionId, { observedStreaming: true });
        return;
      }
      cancelAppendScrollTransition();
      if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);
      initialScrollRafId = 0;
      activeFollowLoopSessionId = null;
      restoreActivityExitSummaryAnchor(anchor);
      startActivityExitSummarySettle(anchor);
    });
    activityExitSummaryObserver.observe(trackRef, {
      attributes: true,
      attributeFilter: ['class', 'style'],
      childList: true,
      subtree: true,
    });
  }

  function startActivityExitSummarySettle(anchor: { sessionId: string; top: number }) {
    activityExitSummarySettleFrames = Math.max(activityExitSummarySettleFrames, 30);
    if (activityExitSummarySettleRafId) return;
    const settle = () => {
      activityExitSummarySettleRafId = 0;
      if (
        disposed ||
        !containerRef ||
        state.activeSessionId !== anchor.sessionId ||
        activityExitSummaryAnchor !== anchor
      ) {
        return;
      }
      restoreActivityExitSummaryAnchor(anchor);
      activityExitSummarySettleFrames = Math.max(0, activityExitSummarySettleFrames - 1);
      if (
        activityExitSummarySettleFrames > 0 ||
        activityExitBottomTarget !== null ||
        exitingActivityPartKeys().size > 0
      ) {
        activityExitSummarySettleRafId = requestAnimationFrame(settle);
      } else if (isLoading() && untrack(appendBottomReserve) > 0.5) {
        // Keep ownership without a hot frame loop until completion or response text arrives.
        activityExitSummarySettleFrames = 0;
        activityExitHeldResponseTextSignature = getResponseTextSignature();
      } else {
        clearActivityExitSummaryAnchor();
      }
    };
    activityExitSummarySettleRafId = requestAnimationFrame(settle);
  }

  function restoreActivityExitSummaryAnchor(anchor: { sessionId: string; top: number }) {
    if (!containerRef || state.activeSessionId !== anchor.sessionId) return;
    const summaries = containerRef.querySelectorAll<HTMLElement>('.assistant-activity-summary');
    const summary = summaries[summaries.length - 1];
    if (!summary) return;
    const currentTop =
      summary.getBoundingClientRect().top - containerRef.getBoundingClientRect().top;
    const delta = currentTop - anchor.top;
    if (Math.abs(delta) <= 0.5) return;

    const nextScrollTop = containerRef.scrollTop + delta;
    if (delta > 0) setAppendBottomReserve((current) => current + delta);
    appendBottomReserveTarget = nextScrollTop;
    setPreservedScrollTop(nextScrollTop);
    const shortfall = nextScrollTop - containerRef.scrollTop;
    if (shortfall <= 0.5) return;

    appendBottomReserveTarget += shortfall;
    setAppendBottomReserve((current) => current + shortfall);
    queueMicrotask(() => {
      if (!containerRef || state.activeSessionId !== anchor.sessionId) return;
      setPreservedScrollTop(nextScrollTop);
    });
  }

  function clearActivityExitSummaryAnchor() {
    activityExitSummaryAnchor = null;
    activityExitHeldResponseTextSignature = null;
    stopActivityExitSummaryObserver();
  }

  function getResponseTextSignature() {
    if (!trackRef) return '';
    return [
      ...trackRef.querySelectorAll<HTMLElement>(
        '.assistant-message-flow-item > .rendered-markdown'
      ),
    ]
      .map((element) => {
        const item = element.closest<HTMLElement>('[data-assistant-render-key]');
        return `${item?.dataset.assistantRenderKey ?? ''}:${element.textContent?.length ?? 0}`;
      })
      .join('|');
  }

  function stopActivityExitSummaryObserver() {
    activityExitSummaryObserver?.disconnect();
    activityExitSummaryObserver = null;
    if (activityExitSummarySettleRafId) cancelAnimationFrame(activityExitSummarySettleRafId);
    activityExitSummarySettleRafId = 0;
    activityExitSummarySettleFrames = 0;
  }

  function reserveCollapsedActivityTraySpace(keys: ReadonlySet<string>) {
    if (
      keys.size === 0 ||
      !containerRef ||
      !autoScroll() ||
      (!pinnedToBottom && getDistanceFromBottom(containerRef) > 2) ||
      stickyNavigationOwnsScroll()
    ) {
      return;
    }

    const partIds = new Set([...keys].map((key) => key.slice(key.lastIndexOf('\u0000') + 1)));
    const trays = new Set<HTMLElement>();
    for (const item of containerRef.querySelectorAll<HTMLElement>('[data-activity-part-id]')) {
      if (!partIds.has(item.dataset.activityPartId || '')) continue;
      const tray = item.closest<HTMLElement>('.assistant-active-activity-tray');
      if (tray) trays.add(tray);
    }

    const collapsingTrays: Array<{
      tray: HTMLElement;
      summary: HTMLElement | null;
      flow: HTMLElement;
    }> = [];
    for (const tray of trays) {
      const items = [...tray.querySelectorAll<HTMLElement>('[data-activity-part-id]')];
      if (items.some((item) => !partIds.has(item.dataset.activityPartId || ''))) continue;
      const summary = tray.querySelector<HTMLElement>('.assistant-active-activity-summary');
      const flow = tray.parentElement;
      if (flow) collapsingTrays.push({ tray, summary, flow });
    }

    let reserve = collapsingTrays.reduce(
      (total, { tray, summary }) =>
        total +
        Math.max(
          0,
          tray.getBoundingClientRect().height - (summary?.getBoundingClientRect().height ?? 0)
        ),
      0
    );
    const traysByFlow = new Map<HTMLElement, typeof collapsingTrays>();
    for (const tray of collapsingTrays) {
      const flowTrays = traysByFlow.get(tray.flow);
      if (flowTrays) flowTrays.push(tray);
      else traysByFlow.set(tray.flow, [tray]);
    }
    for (const [flow, flowTrays] of traysByFlow) {
      const visibleChildren = [...flow.children].filter(
        (element) => element.getClientRects().length > 0
      );
      const collapsingTrayElements = new Set(flowTrays.map(({ tray }) => tray));
      const survivingChildCount = visibleChildren.filter((element) => {
        // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
        if (!collapsingTrayElements.has(element as HTMLElement)) return true;
        return flowTrays.some(({ tray, summary }) => tray === element && summary !== null);
      }).length;
      const gap = Number.parseFloat(getComputedStyle(flow).rowGap) || 0;
      reserve +=
        Math.max(0, visibleChildren.length - 1) * gap - Math.max(0, survivingChildCount - 1) * gap;

      if (survivingChildCount === 0 && visibleChildren.length === flowTrays.length) {
        const row = flow.closest<HTMLElement>('.interactive-item-container');
        if (row) {
          reserve += Math.max(
            0,
            row.getBoundingClientRect().height - flow.getBoundingClientRect().height
          );
        }
      }
    }
    if (reserve <= 0.5) return;

    captureActivityExitSummaryAnchor();
    if (activityExitSummaryAnchor) {
      startActivityExitSummaryObserver(activityExitSummaryAnchor);
      startActivityExitSummarySettle(activityExitSummaryAnchor);
    }
    appendBottomReserveTarget = containerRef.scrollTop;
    setAppendBottomReserve((current) => current + reserve);
    activityExitBottomTarget = containerRef.scrollTop;
    if (activityCollapseSettleRafId) cancelAnimationFrame(activityCollapseSettleRafId);
    const collapseTarget = activityExitBottomTarget;
    activityCollapseSettleRafId = requestAnimationFrame(() => {
      activityCollapseSettleRafId = 0;
      if (
        !containerRef ||
        activityExitBottomTarget !== collapseTarget ||
        exitingActivityPartKeys().size > 0
      ) {
        return;
      }
      reconcileAppendBottomReserve();
      setPreservedScrollTop(collapseTarget);
      activityExitBottomTarget = null;
      lastAutoScrolledBottomScrollTop = collapseTarget;
      const sessionId = state.activeSessionId;
      if (sessionId) startFollowLoop(sessionId);
    });
  }

  function clearActivityExitReserve() {
    if (activityCollapseSettleRafId) cancelAnimationFrame(activityCollapseSettleRafId);
    activityCollapseSettleRafId = 0;
    activityExitBottomTarget = null;
    clearActivityExitSummaryAnchor();
    if (untrack(activityExitBottomReserve) > 0.5) setActivityExitBottomReserve(0);
  }

  function preserveActivityExitReserve() {
    const target = activityExitBottomTarget;
    const reserve = untrack(activityExitBottomReserve);
    activityExitBottomTarget = null;
    const canPreserveTarget =
      target !== null &&
      !!containerRef &&
      autoScroll() &&
      (pinnedToBottom || getDistanceFromBottom(containerRef) <= 2) &&
      !stickyNavigationOwnsScroll();
    if (!canPreserveTarget) {
      if (reserve > 0.5) setActivityExitBottomReserve(0);
      return;
    }
    if (reserve <= 0.5) {
      const sessionId = state.activeSessionId;
      requestAnimationFrame(() => {
        if (
          !containerRef ||
          state.activeSessionId !== sessionId ||
          !autoScroll() ||
          userScrollRecentlyActive()
        ) {
          return;
        }
        setPreservedScrollTop(target);
      });
      return;
    }

    captureActivityExitSummaryAnchor();
    appendBottomReserveTarget = Math.min(target, containerRef.scrollTop);
    batch(() => {
      setAppendBottomReserve((current) => current + reserve);
      setActivityExitBottomReserve(0);
    });
  }

  function shouldCorrectBottomAfterResize() {
    if (
      !containerRef ||
      !autoScroll() ||
      stickyNavigationOwnsScroll() ||
      activityExitBottomTarget !== null
    )
      return false;

    const nextBottomScrollTop = bottomScrollTop();
    return (
      nextBottomScrollTop > containerRef.scrollTop + 1 ||
      (nextBottomScrollTop < lastAutoScrolledBottomScrollTop - 1 &&
        containerRef.scrollTop < lastObservedScrollTop - 1 &&
        Math.abs(containerRef.scrollTop - nextBottomScrollTop) <= 1)
    );
  }

  function userScrollRecentlyActive() {
    const now = performance.now();
    return (
      now - lastWheelAt <= USER_SCROLL_IDLE_MS ||
      now - lastUserScrollAt <= USER_SCROLL_IDLE_MS ||
      now - lastScrollInputAt <= USER_SCROLL_IDLE_MS
    );
  }

  function performScroll(options?: { force?: boolean }) {
    if (stickyNavigationOwnsScroll() || activityExitBottomTarget !== null) return;
    if (appendScrollRafId) return;
    if (!options?.force && userScrollRecentlyActive() && !followModeLocked) return;

    reconcileAppendBottomReserve();
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
    if (nextReserve <= 0.5) {
      appendBottomReserveTarget = 0;
    }
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

  function releaseBottomReserveForHostResize() {
    if (!containerRef) return;

    const reserve = untrack(appendBottomReserve);
    const nextBottom = Math.max(0, containerRef.scrollHeight - reserve - containerRef.clientHeight);
    appendBottomReserveTarget = 0;
    if (reserve > 0.5) setAppendBottomReserve(0);
    if (!autoScroll() || !pinnedToBottom || stickyNavigationOwnsScroll()) return;

    setPreservedScrollTop(nextBottom);
    lastAutoScrolledBottomScrollTop = nextBottom;
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
      isFunction(window.matchMedia) &&
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
      const interpolatedTop = startTop + (target - startTop) * progress;
      const nextTop =
        target >= startTop ? Math.max(container.scrollTop, interpolatedTop) : interpolatedTop;
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
    pendingNewTurnMessageId = null;
    if (newTurnAlignmentRafId) {
      cancelAnimationFrame(newTurnAlignmentRafId);
      newTurnAlignmentRafId = 0;
    }
    cancelAppendScrollTransition();
  }

  function startNewTurnAlignment(sessionId: string, messageId: string) {
    if (!containerRef || !trackRef || state.activeSessionId !== sessionId) return false;
    pendingNewTurnMessageId = messageId;
    reserveLostBottomSpace();
    const appendAnchor = pendingMeasuredAppendAnchor;
    cancelAppendScrollTransition();
    restoreVisibleScrollAnchor(appendAnchor, { useMessageOffsetFallback: true });
    if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);
    initialScrollRafId = 0;
    activeFollowLoopSessionId = null;
    if (newTurnAlignmentRafId) cancelAnimationFrame(newTurnAlignmentRafId);

    const inputEpoch = directScrollInputEpoch;
    let attempts = 0;
    let stableFrames = 0;
    const tick = () => {
      newTurnAlignmentRafId = 0;
      if (
        !containerRef ||
        !trackRef ||
        state.activeSessionId !== sessionId ||
        pendingNewTurnMessageId !== messageId ||
        directScrollInputEpoch !== inputEpoch ||
        stickyNavigationOwnsScroll() ||
        editingMessage()
      ) {
        if (pendingNewTurnMessageId === messageId) pendingNewTurnMessageId = null;
        return;
      }

      attempts += 1;
      const row = mountedMessageRows.get(messageId);
      const card = row?.querySelector<HTMLElement>('.user-message-card');
      if (!row || !card || row.classList.contains('interactive-item-virtual-placeholder')) {
        if (attempts < NEW_TURN_ALIGNMENT_FRAME_LIMIT) {
          newTurnAlignmentRafId = requestAnimationFrame(tick);
        } else {
          pendingNewTurnMessageId = null;
          performScroll({ force: true });
          startFollowLoop(sessionId);
        }
        return;
      }

      const containerRect = containerRef.getBoundingClientRect();
      const offset =
        card.getBoundingClientRect().top - containerRect.top - getMessageJumpTopInset();
      const targetScrollTop = Math.max(0, containerRef.scrollTop + offset);
      const currentReserve = untrack(appendBottomReserve);
      const unreservedBottom = Math.max(
        0,
        containerRef.scrollHeight - currentReserve - containerRef.clientHeight
      );
      const requiredReserve = Math.max(0, targetScrollTop - unreservedBottom);
      appendBottomReserveTarget = targetScrollTop;
      if (Math.abs(requiredReserve - currentReserve) > 0.5) {
        const preservedScrollTop = containerRef.scrollTop;
        setAppendBottomReserve(requiredReserve);
        setPreservedScrollTop(preservedScrollTop);
      }
      if (requiredReserve > 0.5) {
        newTurnReserveSessionId = sessionId;
      }

      if (requiredReserve <= currentReserve + 0.5) {
        const scrollDelta = targetScrollTop - containerRef.scrollTop;
        const nextScrollTop =
          containerRef.scrollTop +
          Math.sign(scrollDelta) * Math.min(Math.abs(scrollDelta), NEW_TURN_ALIGNMENT_MAX_STEP_PX);
        setPreservedScrollTop(nextScrollTop);
        expectedScrollTop = nextScrollTop;
        ignoreScrollUntil = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
        lastAutoScrolledTrackHeight = trackRef.getBoundingClientRect().height;
        lastAutoScrolledBottomScrollTop = targetScrollTop;
        pinnedToBottom = true;
      }

      const alignedOffset =
        card.getBoundingClientRect().top -
        containerRef.getBoundingClientRect().top -
        getMessageJumpTopInset();
      stableFrames = Math.abs(alignedOffset) <= 0.5 ? stableFrames + 1 : 0;
      if (stableFrames >= 2 || attempts >= NEW_TURN_ALIGNMENT_FRAME_LIMIT) {
        pendingNewTurnMessageId = null;
        startFollowLoop(sessionId);
        return;
      }
      newTurnAlignmentRafId = requestAnimationFrame(tick);
    };

    newTurnAlignmentRafId = requestAnimationFrame(tick);
    return true;
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
    clearActivityExitReserve();
    cancelPendingScroll();
    if (autoScroll()) setAutoScroll(false);
  }

  function startFollowLoop(
    sessionId: string,
    options?: { immediate?: boolean; observedStreaming?: boolean }
  ) {
    if (appendScrollRafId) return;
    if (stickyNavigationOwnsScroll()) {
      activeFollowLoopSessionId = null;
      return;
    }
    bottomFollowSettleFrames = 0;
    const currentlyStreaming =
      state.streamingText.length > 0 ||
      !!state.streamingPartId ||
      !!visibleRunningToolPart() ||
      activeSessionWorking();
    if (activeFollowLoopSessionId === sessionId) {
      if (currentlyStreaming || options?.observedStreaming) bottomFollowObservedStreaming = true;
      return;
    }
    if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);

    activeFollowLoopSessionId = sessionId;
    bottomFollowObservedStreaming = currentlyStreaming || !!options?.observedStreaming;

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
        state.streamingText.length > 0 ||
        state.streamingPartId ||
        visibleRunningToolPart() ||
        activeSessionWorking();
      if (isStreaming) bottomFollowObservedStreaming = true;
      const stable =
        Math.abs(currentHeight - lastAutoScrolledTrackHeight) <= 1 &&
        Math.abs(currentBottomScrollTop - lastAutoScrolledBottomScrollTop) <= 1 &&
        distanceFromBottom() <= 1;
      if (stable && !isStreaming && !belowBottomTarget && !trackGrew) {
        bottomFollowSettleFrames += 1;
      } else {
        bottomFollowSettleFrames = 0;
      }

      const settleFrameCount = bottomFollowObservedStreaming ? BOTTOM_FOLLOW_SETTLE_FRAME_COUNT : 1;
      if (bottomFollowSettleFrames >= settleFrameCount) {
        const shouldFillInitialViewport =
          pendingInitialHistoryFillSessionId === sessionId &&
          isSessionHistoryTruncated(sessionId) &&
          !isSessionHistoryLoadFailed(sessionId) &&
          containerRef.clientHeight > 1 &&
          containerRef.scrollHeight > 1 &&
          containerRef.scrollHeight <= containerRef.clientHeight + 1;
        pendingInitialHistoryFillSessionId = null;
        if (shouldFillInitialViewport) {
          const generation = activeSessionGeneration;
          activeFollowLoopSessionId = null;
          void handleLoadOlderHistory()?.then(() => {
            if (
              generation !== activeSessionGeneration ||
              state.activeSessionId !== sessionId ||
              !autoScroll()
            ) {
              return;
            }
            pendingInitialHistoryFillSessionId =
              isSessionHistoryTruncated(sessionId) && !isSessionHistoryLoadFailed(sessionId)
                ? sessionId
                : null;
            performScroll({ force: true });
            startFollowLoop(sessionId);
          });
          return;
        }
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

  function scheduleDetachedVisibleAnchorRefresh() {
    if (detachedAnchorRefreshRafId || !containerRef) return;
    const sessionId = state.activeSessionId;
    detachedAnchorRefreshRafId = requestAnimationFrame(() => {
      detachedAnchorRefreshRafId = 0;
      if (
        !containerRef ||
        directMovementAnchor ||
        state.activeSessionId !== sessionId ||
        autoScroll() ||
        widthResizeActive ||
        stickyNavigationOwnsScroll() ||
        editingMessage()
      ) {
        return;
      }
      const containerRect = containerRef.getBoundingClientRect();
      let fallback: VisibleScrollAnchor | null = null;
      let anchor: VisibleScrollAnchor | null = null;
      for (const row of containerRef.querySelectorAll<HTMLElement>('[data-msg-id]')) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue;
        const messageId = row.dataset.msgId;
        if (!messageId) continue;
        const candidate = {
          messageId,
          top: rect.top - containerRect.top,
          topPad: 0,
        };
        fallback ??= candidate;
        if (rect.top >= containerRect.top - 0.5) {
          anchor = candidate;
          break;
        }
      }
      anchor = refineTallRenderItemScrollAnchor(anchor ?? fallback, containerRef.clientHeight / 3, {
        includeCompact: true,
      });
      if (
        anchor &&
        window.innerWidth === lastHostViewportWidth &&
        window.devicePixelRatio === lastHostDevicePixelRatio
      ) {
        lastDetachedVisibleAnchor = anchor;
      }
    });
  }

  function onScroll() {
    if (!containerRef) return;
    const autoScrollEnabled = autoScroll();
    const now = performance.now();
    const top = clampEditScrollTop(containerRef.scrollTop);
    const currentViewportHeight = containerRef.clientHeight;
    const scrollDelta = top - lastObservedScrollTop;
    const mountedDetachedAnchor = (() => {
      if (suppressSyncScrollTop || Math.abs(scrollDelta) <= 0.5) return null;
      if (widthResizeActive || stickyNavigationOwnsScroll() || editingMessage()) return null;
      if (directMovementAnchor) {
        const movement = directMovementAnchor.scrollTop - top;
        const movedAnchor = {
          ...directMovementAnchor.anchor,
          top: directMovementAnchor.anchor.top + movement,
          messageTop:
            directMovementAnchor.anchor.messageTop !== undefined
              ? directMovementAnchor.anchor.messageTop + movement
              : undefined,
        };
        const anchor = refineTallRenderItemScrollAnchor(movedAnchor) ?? movedAnchor;
        const anchorElement = getMountedScrollAnchorElement(anchor);
        const anchorRect = anchorElement?.getBoundingClientRect();
        const containerRect = containerRef!.getBoundingClientRect();
        if (
          !anchorRect ||
          anchorRect.bottom <= containerRect.top ||
          anchorRect.top >= containerRect.bottom
        ) {
          const metrics = shouldVirtualize() ? virtualMetrics() : null;
          const index = metrics
            ? getFirstVisibleMessageIndexFromVirtualMetrics({
                metrics,
                scrollTop: getVirtualScrollTop(top),
              })
            : null;
          const replacement = refineTallRenderItemScrollAnchor(
            index === null
              ? captureVisibleScrollAnchor({ preferStableRenderItem: true })
              : capturePaintedVisibleScrollAnchorFromIndex(index),
            0,
            { includeCompact: true }
          );
          directMovementAnchor = replacement ? { anchor: replacement, scrollTop: top } : null;
          return replacement;
        }
        directMovementAnchor = { anchor, scrollTop: top };
        return anchor;
      }
      const remembered = lastDetachedVisibleAnchor;
      const rememberedElement = remembered ? getMountedScrollAnchorElement(remembered) : null;
      const containerRect = containerRef!.getBoundingClientRect();
      if (remembered && rememberedElement) {
        const rect = rememberedElement.getBoundingClientRect();
        if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
          const row = mountedMessageRows.get(remembered.messageId);
          return {
            ...remembered,
            top: rect.top - containerRect.top,
            messageTop:
              remembered.messageTop !== undefined && row
                ? row.getBoundingClientRect().top - containerRect.top
                : undefined,
          };
        }
      }
      return refineTallRenderItemScrollAnchor(captureMountedVisibleScrollAnchor());
    })();
    const distance = distanceFromBottom();
    const bottomTargetStable = Math.abs(bottomScrollTop() - lastAutoScrolledBottomScrollTop) <= 1;
    let historyAnchorSettling =
      historyAnchorSettleOwner?.sessionId === state.activeSessionId &&
      historyAnchorSettleOwner.generation === activeSessionGeneration &&
      historyAnchorSettleOwner.windowVersion ===
        getSessionMessageWindowStateVersion(historyAnchorSettleOwner.sessionId);
    let structuralAnchorSettling =
      pendingStructuralScrollAnchor?.sessionId === state.activeSessionId &&
      pendingStructuralScrollAnchor.ownershipEpoch === userScrollOwnershipEpoch;
    const userScrollInputActive =
      pointerScrollOwnershipActive ||
      now - lastWheelAt <= ACTIVE_WHEEL_WINDOW_MS ||
      now - lastScrollInputAt <= SCROLL_INPUT_WINDOW_MS ||
      now - lastUserOwnedScrollMovementAt <= USER_SCROLL_IDLE_MS;
    const actualScrollMovement = !suppressSyncScrollTop && Math.abs(scrollDelta) > 0.5;
    if (actualScrollMovement && scrollDelta < 0 && userScrollInputActive) {
      setActiveTurnNavigationTargetId(null);
    }
    if (actualScrollMovement && historyAnchorSettling && userScrollInputActive) {
      historyAnchorSettleOwner = null;
      historyAnchorSettling = false;
    }
    if (actualScrollMovement && structuralAnchorSettling && userScrollInputActive) {
      clearPendingStructuralScrollAnchor();
      structuralAnchorSettling = false;
    }
    // Layout-driven scroll events during history settling belong to the history anchor, not the
    // wheel gesture that originally reached the boundary. Structural reconciliation has the same
    // ownership until direct input supersedes it.
    if (actualScrollMovement && !historyAnchorSettling && !structuralAnchorSettling) {
      userScrollOwnershipEpoch += 1;
    }
    if (
      actualScrollMovement &&
      userScrollInputActive &&
      !historyAnchorSettling &&
      !structuralAnchorSettling
    ) {
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
    const pendingStickyHandoff = upwardStickyHandoff;
    const pendingStickySource = pendingStickyHandoff
      ? getStickyUserMessageSourceElement(pendingStickyHandoff.messageId)
      : null;
    if (
      pendingStickyHandoff &&
      pendingStickySource &&
      !pendingStickyHandoff.acceptsBoundaryEntry &&
      pendingStickySource.getBoundingClientRect().bottom <= containerRef.getBoundingClientRect().top
    ) {
      clearUpwardStickyHandoff();
      setStickyUserMessagePreview(pendingStickyHandoff.preview);
      previousStickyPreviewId = pendingStickyHandoff.preview.id;
    }
    const currentStickyPreview = untrack(stickyUserMessagePreview);
    const currentStickySource = currentStickyPreview
      ? getStickyUserMessageSourceElement(currentStickyPreview.id)
      : null;
    // Do not wait for the coalesced sticky pass when a slow scroll reveals the source card.
    if (
      confirmedManualUpwardMovement &&
      currentStickyPreview &&
      currentStickySource &&
      (currentStickySource.getBoundingClientRect().bottom >
        containerRef.getBoundingClientRect().top ||
        ((!pendingStickyHandoff || pendingStickyHandoff.acceptsBoundaryEntry) &&
          currentStickySource.getBoundingClientRect().bottom >=
            containerRef.getBoundingClientRect().top))
    ) {
      beginUpwardStickyHandoff(currentStickyPreview, true);
      scheduleUpwardStickyHandoffRelease();
      previousStickyPreviewId = currentStickyPreview.id;
    } else if (
      actualScrollMovement &&
      scrollDelta > 0.5 &&
      currentStickyPreview &&
      !shouldDeferStickyDuringUpwardHandoff() &&
      shouldHideStickyUserMessagePreviewImmediately(currentStickyPreview)
    ) {
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
    if (!autoScroll() && !widthResizeActive && !stickyNavigationOwnsScroll() && !editingMessage()) {
      if (mountedDetachedAnchor) {
        lastDetachedVisibleAnchor = mountedDetachedAnchor;
        pendingWheelResizeAnchor = null;
      } else if (
        !lastDetachedVisibleAnchor ||
        !getMountedScrollAnchorElement(lastDetachedVisibleAnchor)
      ) {
        lastDetachedVisibleAnchor = captureDetachedVisibleScrollAnchor(top);
      }
      scheduleDetachedVisibleAnchorRefresh();
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
    if (widthResizeActive) {
      publishPendingWidthMeasurements({ preserveVisibleAnchor: false });
      widthResizeAnchor = null;
      finishWidthResizeNow();
    }
    if (stickyNavigationOwnsScroll()) cancelStickyNavigation();
    if (nestedScrollerWillConsumeWheel(event)) return;
    pendingExpansionScrollAnchor = null;
    directMovementAnchor = null;
    pendingWheelResizeAnchor = null;
    // The container viewport rect cannot change while this handler runs, so read it at most
    // once instead of forcing layout again for the sticky handoff check below.
    let wheelContainerRect: DOMRect | null = null;
    const getWheelContainerRect = () => {
      wheelContainerRect ??= containerRef!.getBoundingClientRect();
      return wheelContainerRect;
    };
    if (containerRef && !editingMessage()) {
      const metrics = shouldVirtualize() ? virtualMetrics() : null;
      const index = metrics
        ? getFirstVisibleMessageIndexFromVirtualMetrics({
            metrics,
            scrollTop: getVirtualScrollTop(containerRef.scrollTop),
          })
        : null;
      const anchor =
        captureVisibleUserMessageScrollAnchor() ??
        refineTallRenderItemScrollAnchor(
          index === null ? null : capturePaintedVisibleScrollAnchorFromIndex(index),
          0,
          { includeCompact: true }
        );
      if (anchor) {
        directMovementAnchor = {
          anchor,
          scrollTop: containerRef.scrollTop,
        };
        lastDetachedVisibleAnchor = anchor;
      }
    }
    clearActivityExitReserve();
    historyAnchorSettleOwner = null;
    const deltaY = getWheelDeltaPixels(event);
    if (
      containerRef &&
      directMovementAnchor?.anchor.element?.classList.contains('user-message-card')
    ) {
      const targetScrollTop = Math.min(
        Math.max(0, containerRef.scrollHeight - containerRef.clientHeight),
        Math.max(0, containerRef.scrollTop + deltaY)
      );
      const movement = targetScrollTop - containerRef.scrollTop;
      pendingWheelResizeAnchor =
        Math.abs(movement) > 1.5
          ? {
              ...directMovementAnchor.anchor,
              top: directMovementAnchor.anchor.top - movement,
              messageTop:
                directMovementAnchor.anchor.messageTop !== undefined
                  ? directMovementAnchor.anchor.messageTop - movement
                  : undefined,
            }
          : null;
    }
    if (containerRef && deltaY < -0.5) {
      const currentStickyPreview = untrack(stickyUserMessagePreview);
      const currentStickySource = currentStickyPreview
        ? getStickyUserMessageSourceElement(currentStickyPreview.id)
        : null;
      const currentStickySourceRect = currentStickySource?.getBoundingClientRect();
      if (
        currentStickyPreview &&
        currentStickySource &&
        currentStickySourceRect &&
        (currentStickySourceRect.bottom - deltaY > getWheelContainerRect().top ||
          (Math.abs(deltaY) < 1 &&
            currentStickySourceRect.bottom - deltaY >= getWheelContainerRect().top - 0.5))
      ) {
        beginUpwardStickyHandoff(currentStickyPreview, false, Math.abs(deltaY) < 1);
        previousStickyPreviewId = currentStickyPreview.id;
        const handoff = upwardStickyHandoff;
        const stickyOverlayRect = containerRef
          .querySelector<HTMLElement>('.latest-user-message-sticky-overlay')
          ?.getBoundingClientRect();
        const firstPromptWillReachTop =
          currentStickyPreview.index === 0 &&
          currentStickySourceRect.top - deltaY >= getWheelContainerRect().top;
        if (
          handoff &&
          (firstPromptWillReachTop ||
            (stickyOverlayRect &&
              currentStickySourceRect.bottom - deltaY > stickyOverlayRect.bottom))
        ) {
          clearUpwardStickyHandoff();
          setStickyUserMessagePreview(null);
        }
      }
    }
    if (containerRef && deltaY > 0.5) {
      if (upwardStickyHandoff?.sourceEntered) {
        upwardStickyHandoff.lastInputAt = performance.now();
        scheduleUpwardStickyHandoffRelease();
      } else {
        clearUpwardStickyHandoff();
      }
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
    directScrollInputEpoch += 1;
    virtualPlaceholderReleaseBlockedUntil = lastWheelAt + USER_SCROLL_IDLE_MS;
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
      if (
        containerRef &&
        containerRef.scrollTop <= 24 &&
        showTruncatedHistoryBanner() &&
        !stickyNavigationOwnsScroll()
      ) {
        void handleLoadOlderHistory();
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
      // Most ancestors cannot scroll at all. Checking overflowing geometry first keeps
      // getComputedStyle - which forces a style recalculation - off the wheel hot path.
      if (element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 1) {
        const styles = getComputedStyle(element);
        const overflowY = styles.overflowY;
        const scrollable = overflowY === 'auto' || overflowY === 'scroll';
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
    // Space activates interactive controls instead of scrolling the list; arming scroll
    // ownership for it would misattribute later programmatic scrolls to user input.
    if (
      event.key === ' ' &&
      target !== containerRef &&
      target.closest('button, a, label, summary, [role="button"], [role="tab"], [role="option"]')
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
    pendingExpansionScrollAnchor = null;
    historyAnchorSettleOwner = null;
    if (stickyNavigationOwnsScroll()) cancelStickyNavigation();
    pendingWheelResizeAnchor = null;
    if (widthResizeActive) {
      publishPendingWidthMeasurements({ preserveVisibleAnchor: false });
      widthResizeAnchor = null;
      finishWidthResizeNow();
    }
    lastScrollInputAt = performance.now();
    directScrollInputEpoch += 1;
    virtualPlaceholderReleaseBlockedUntil = lastScrollInputAt + USER_SCROLL_IDLE_MS;
    const metrics = shouldVirtualize() ? virtualMetrics() : null;
    const index = metrics
      ? getFirstVisibleMessageIndexFromVirtualMetrics({
          metrics,
          scrollTop: getVirtualScrollTop(containerRef.scrollTop),
        })
      : null;
    const inputAnchor = refineTallRenderItemScrollAnchor(
      index === null ? null : capturePaintedVisibleScrollAnchorFromIndex(index)
    );
    directMovementAnchor = inputAnchor
      ? {
          anchor: inputAnchor,
          scrollTop: containerRef.scrollTop,
        }
      : null;
    if (target === containerRef) {
      const pageSize = containerRef.clientHeight;
      const maximumScrollTop = Math.max(0, containerRef.scrollHeight - pageSize);
      let nextScrollTop = containerRef.scrollTop;
      if (event.key === 'ArrowUp') nextScrollTop -= 40;
      else if (event.key === 'ArrowDown') nextScrollTop += 40;
      else if (event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
        nextScrollTop -= pageSize;
      } else if (event.key === 'PageDown' || event.key === ' ') {
        nextScrollTop += pageSize;
      } else if (event.key === 'Home') nextScrollTop = 0;
      else if (event.key === 'End') nextScrollTop = maximumScrollTop;
      event.preventDefault();
      containerRef.scrollTop = Math.min(maximumScrollTop, Math.max(0, nextScrollTop));
      directMovementAnchor = null;
      const sessionId = state.activeSessionId;
      if (keydownDestinationRafId) cancelAnimationFrame(keydownDestinationRafId);
      keydownDestinationRafId = requestAnimationFrame(() => {
        keydownDestinationRafId = 0;
        if (disposed || !containerRef || state.activeSessionId !== sessionId) return;
        const destinationMetrics = shouldVirtualize() ? virtualMetrics() : null;
        const destinationIndex = destinationMetrics
          ? getFirstVisibleMessageIndexFromVirtualMetrics({
              metrics: destinationMetrics,
              scrollTop: getVirtualScrollTop(containerRef.scrollTop),
            })
          : null;
        const anchor = refineTallRenderItemScrollAnchor(
          destinationIndex === null
            ? captureVisibleScrollAnchor({ preferStableRenderItem: true })
            : capturePaintedVisibleScrollAnchorFromIndex(destinationIndex),
          0,
          { includeCompact: true }
        );
        if (!anchor) return;
        directMovementAnchor = {
          anchor,
          scrollTop: containerRef.scrollTop,
        };
        lastDetachedVisibleAnchor = anchor;
      });
    }
  }

  function cancelStickyNavigation() {
    const jump = pendingStickyJump();
    if (jump?.loadingOwner) {
      setLoadingOlderHistory(jump.sessionId, false, jump.loadingOwner);
      delete jump.loadingOwner;
    }
    deferredScrollToBottomRequestKey = null;
    stickyJumpSettleEpoch += 1;
    pendingWheelResizeAnchor = null;
    setStickyNavigationInProgress(false);
    pendingTurnNavigationAnimationMessageId = null;
    setActiveTurnNavigationTargetId(null);
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
    pendingExpansionScrollAnchor = null;
    directMovementAnchor = null;
    pendingWheelResizeAnchor = null;
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
    if (widthResizeActive) {
      publishPendingWidthMeasurements({ preserveVisibleAnchor: false });
      widthResizeAnchor = null;
      finishWidthResizeNow();
    }
    if (stickyNavigationOwnsScroll()) cancelStickyNavigation();
    historyAnchorSettleOwner = null;
    pointerScrollOwnershipActive = true;
    lastScrollInputAt = performance.now();
    directScrollInputEpoch += 1;
    virtualPlaceholderReleaseBlockedUntil = lastScrollInputAt + USER_SCROLL_IDLE_MS;
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

  function reserveExternalBottomCollapse(collapseHeight: number) {
    if (
      !containerRef ||
      collapseHeight <= 0.5 ||
      !autoScroll() ||
      !pinnedToBottom ||
      stickyNavigationOwnsScroll()
    )
      return;

    const existingReserve = untrack(appendBottomReserve);
    const projectedClientHeight = containerRef.clientHeight + collapseHeight;
    if (containerRef.scrollHeight - existingReserve <= projectedClientHeight + 0.5) {
      appendBottomReserveTarget = 0;
      if (existingReserve > 0.5) setAppendBottomReserve(0);
      return;
    }

    appendBottomReserveTarget = bottomScrollTop();
    setAppendBottomReserve((reserve) => reserve + collapseHeight);
  }

  function handleExternalLayoutClickCapture(event: MouseEvent) {
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
    reserveExternalBottomCollapse(collapseHeight);
  }

  function reserveQueuedMessageRemoval(queuedMessageId: string) {
    const row = [...document.querySelectorAll<HTMLElement>('[data-queued-message-id]')].find(
      (element) => element.dataset.queuedMessageId === queuedMessageId
    );
    const queue = row?.closest<HTMLElement>('.chat-queue-container');
    const list = row?.closest<HTMLElement>('.chat-queue-list');
    if (!row || !queue || !list) return;

    const rows = list.querySelectorAll('[data-queued-message-id]');
    if (rows.length === 1) {
      const styles = getComputedStyle(queue);
      reserveExternalBottomCollapse(
        queue.getBoundingClientRect().height +
          (parseFloat(styles.marginTop) || 0) +
          (parseFloat(styles.marginBottom) || 0)
      );
      return;
    }

    reserveExternalBottomCollapse(
      Math.max(0, list.clientHeight - (list.scrollHeight - row.offsetHeight))
    );
  }

  createEffect(() => {
    const container = containerRef;
    if (!container) return;

    const options: AddEventListenerOptions = { passive: !editingMessage() };
    container.addEventListener('wheel', onWheel, options);
    onCleanup(() => container.removeEventListener('wheel', onWheel, options));
  });

  onMount(() => {
    if (!containerRef) return;
    const unregisterQueuedMessageRemoval = registerQueuedMessageRemovalHandler(
      reserveQueuedMessageRemoval
    );
    onCleanup(unregisterQueuedMessageRemoval);
    const stopCapturingThinkingAnchor = onBeforeShowThinkingPreferenceChange(() => {
      pendingThinkingLayoutAnchor =
        !autoScroll() &&
        !stickyNavigationOwnsScroll() &&
        !editingMessage() &&
        !pendingExpansionScrollAnchor
          ? captureMountedVisibleScrollAnchor()
          : null;
    });
    onCleanup(stopCapturingThinkingAnchor);
    // SAFETY: The surrounding shape or discriminator check establishes the EventListener contract used below.
    containerRef.addEventListener('click', handleClickCapture as EventListener, true);
    containerRef.addEventListener('focusin', handleFocusIn);
    containerRef.addEventListener('focusout', handleFocusOut);
    containerRef.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('click', handleExternalLayoutClickCapture, true);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerup', releasePointerScrollOwnership);
    document.addEventListener('pointercancel', releasePointerScrollOwnership);
    lastContainerClientHeight = containerRef.clientHeight;
    lastHostViewportWidth = window.innerWidth;
    lastHostViewportHeight = window.innerHeight;
    lastHostDevicePixelRatio = window.devicePixelRatio;
    const handleHostViewportResize = () => {
      if (
        (window.innerWidth !== lastHostViewportWidth ||
          window.devicePixelRatio !== lastHostDevicePixelRatio) &&
        lastDetachedVisibleAnchor
      ) {
        beginWidthResize();
        const anchor = widthResizeAnchor;
        requestAnimationFrame(() => {
          if (widthResizeActive && widthResizeAnchor === anchor) {
            restoreVisibleScrollAnchor(anchor);
          }
        });
      }
      lastHostViewportWidth = window.innerWidth;
      lastHostViewportHeight = window.innerHeight;
      lastHostDevicePixelRatio = window.devicePixelRatio;
      hostViewportResizeActiveUntil = performance.now() + WIDTH_RESIZE_SETTLE_MS;
    };
    window.addEventListener('resize', handleHostViewportResize);
    lastContainerFontSize = parseFloat(getComputedStyle(containerRef).fontSize) || 0;
    updateScrollbarInset();
    setViewportHeight(containerRef.clientHeight);
    setScrollTop(containerRef.scrollTop);
    setStickyPreviewViewportHeight(containerRef.clientHeight);
    setStickyPreviewScrollTop(containerRef.scrollTop);

    if (globalThis.IntersectionObserver !== undefined) {
      // These cached bounds are only a best-effort scroll anchor. Sticky selection and collision
      // must read live DOM rects because observer thresholds do not report in-viewport movement.
      firstVisibleMessageObserver = new IntersectionObserver(
        (entries) => {
          if (!containerRef) return;
          for (const entry of entries) {
            // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
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

    if (globalThis.ResizeObserver !== undefined) {
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
      const currentHostViewportWidth = window.innerWidth;
      const currentHostViewportHeight = window.innerHeight;
      const hostViewportResizing =
        performance.now() <= hostViewportResizeActiveUntil ||
        currentHostViewportWidth !== lastHostViewportWidth ||
        currentHostViewportHeight !== lastHostViewportHeight;
      lastHostViewportWidth = currentHostViewportWidth;
      lastHostViewportHeight = currentHostViewportHeight;
      const currentContainerClientHeight = containerRef.clientHeight;
      const containerHeightDelta = currentContainerClientHeight - lastContainerClientHeight;
      const containerHeightChanged = currentContainerClientHeight !== lastContainerClientHeight;
      lastContainerClientHeight = currentContainerClientHeight;
      if (hostViewportResizing) {
        clearActivityExitReserve();
        releaseBottomReserveForHostResize();
      } else if (containerHeightDelta > 0.5) {
        const reserve = untrack(appendBottomReserve);
        if (containerRef.scrollHeight - reserve <= currentContainerClientHeight + 0.5) {
          appendBottomReserveTarget = 0;
          if (reserve > 0.5) setAppendBottomReserve(0);
        } else {
          reserveLostBottomSpace();
        }
      } else if (containerHeightDelta < -0.5) {
        consumeBottomReserve(-containerHeightDelta);
      }
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
        if (trackChanged && shouldCorrectBottomAfterResize()) performScroll({ force: true });
        scheduleVisibleMeasurement({ afterResize: true, widthResize: widthChanged });
      }
    });
    observer.observe(containerRef);
    observer.observe(trackRef);
    onCleanup(() => {
      resetPendingHistoryGeneration();
      // SAFETY: The surrounding shape or discriminator check establishes the EventListener contract used below.
      containerRef?.removeEventListener('click', handleClickCapture as EventListener, true);
      containerRef?.removeEventListener('focusin', handleFocusIn);
      containerRef?.removeEventListener('focusout', handleFocusOut);
      containerRef?.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('click', handleExternalLayoutClickCapture, true);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerup', releasePointerScrollOwnership);
      document.removeEventListener('pointercancel', releasePointerScrollOwnership);
      window.removeEventListener('resize', handleHostViewportResize);
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
      if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);
      if (detachedAnchorRefreshRafId) cancelAnimationFrame(detachedAnchorRefreshRafId);
      if (keydownDestinationRafId) cancelAnimationFrame(keydownDestinationRafId);
      cancelScheduledMeasurement();
      cancelScheduledStickyPreviewFrame();
      cancelWidthResize();
      cancelAppendScrollTransition();
      clearPendingStructuralScrollAnchor();
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

    if (current && shouldDeferStickyDuringUpwardHandoff()) return;

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

    if (shouldHideStickyUserMessagePreviewAfterLayout(current)) {
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
      setStickyPreviewGeometryVersion((version) => version + 1);
      if (untrack(stickyUserMessagePreviewCandidate)) return;
      if (stickyPreviewDebounceTimer) {
        clearTimeout(stickyPreviewDebounceTimer);
        stickyPreviewDebounceTimer = 0;
      }
      const activePreview = untrack(stickyUserMessagePreview);
      if (!activePreview) return;
      if (
        containerRef &&
        containerRef.clientHeight >= STICKY_PREVIEW_MIN_VIEWPORT_HEIGHT_PX &&
        !shouldHideStickyUserMessagePreviewAfterLayout(activePreview)
      ) {
        return;
      }
      setStickyUserMessagePreview(null);
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
        !shouldHideStickyUserMessagePreviewAfterLayout(activePreview, {
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
    clearActivityExitReserve();
    appendBottomReserveTarget = 0;
    newTurnReserveSessionId = null;
    lastVirtualContentOrigin = 0;
    lastDetachedVisibleAnchor = null;
    directMovementAnchor = null;
    pendingWheelResizeAnchor = null;
    measuredHeights.clear();
    zeroHeightRenderContentSignatures.clear();
    forcedVirtualContentMessageIds.clear();
    viewportForcedVirtualContentMessageIds.clear();
    setMeasurementVersion((version) => version + 1);
    pendingInitialScrollSessionId = editingAtSessionStart ? null : sessionId;
    pendingInitialHistoryFillSessionId = editingAtSessionStart ? null : sessionId;
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
    if (!editingAtSessionStart && !untrack(() => state.messagesLoading)) {
      queueMicrotask(() => performScroll());
    }
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    const msgs = messages();
    if (state.messagesLoading || msgs.length === 0) return;
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
        if (pendingNewTurnMessageId && startNewTurnAlignment(sessionId, pendingNewTurnMessageId)) {
          return;
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
    const targetMessageId = messageListScrollTargetMessageId();
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

    // Existing chats keep the preceding response visible.
    // Only an empty chat may top-align its first turn.
    const shouldAlignNewTurn = !!targetMessageId && !shouldMeasureRows() && messages().length === 1;
    pendingScrollToBottomRequest = true;
    pendingNewTurnMessageId = shouldAlignNewTurn ? targetMessageId : null;
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
      if (
        state.activeSessionId !== sessionId ||
        messageListScrollRequestKey() !== requestKey ||
        (shouldAlignNewTurn && pendingNewTurnMessageId !== targetMessageId)
      ) {
        return;
      }
      if (shouldAlignNewTurn && startNewTurnAlignment(sessionId, targetMessageId)) return;
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
    const replacementStreaming = !!state.streamingPartId || state.streamingText.length > 0;
    if (!replacementStreaming || exitingActivityPartKeys().size > 0) return;
    clearActivityExitSummaryAnchor();
  });
  createEffect(() => {
    const loading = isLoading();
    if (!prevLoading && loading) {
      clearActivityExitSummaryAnchor();
    }
    if (prevLoading && !loading && autoScroll()) {
      const sessionId = state.activeSessionId;
      const summaryAnchor =
        activityExitSummaryAnchor?.sessionId === sessionId ? activityExitSummaryAnchor : null;
      const activityReserveOwnsCompletion = !!summaryAnchor;
      if (activityReserveOwnsCompletion) {
        startActivityExitSummaryObserver(summaryAnchor);
        if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);
        initialScrollRafId = 0;
        activeFollowLoopSessionId = null;
      }
      if (sessionId && newTurnReserveSessionId === sessionId) {
        pendingNewTurnMessageId = null;
        if (newTurnAlignmentRafId) cancelAnimationFrame(newTurnAlignmentRafId);
        newTurnAlignmentRafId = 0;
        newTurnReserveSessionId = null;
        if (!activityReserveOwnsCompletion) {
          appendBottomReserveTarget = 0;
          if (untrack(appendBottomReserve) > 0.5) setAppendBottomReserve(0);
        }
      }
      queueMicrotask(() => {
        if (!sessionId || state.activeSessionId !== sessionId) return;
        if (activityReserveOwnsCompletion) {
          let attempts = 0;
          const settle = () => {
            if (disposed || !containerRef || state.activeSessionId !== sessionId) {
              return;
            }
            const summaries = containerRef.querySelectorAll<HTMLElement>(
              '.assistant-activity-summary'
            );
            const summary = summaries[summaries.length - 1];
            if (!summary) return;
            restoreActivityExitSummaryAnchor(summaryAnchor);
            attempts += 1;
            if (attempts < 12) requestAnimationFrame(settle);
            else {
              clearActivityExitSummaryAnchor();
            }
          };
          settle();
          return;
        }
        if (startPendingAppendScrollTransition(sessionId)) return;
        performScroll();
        startFollowLoop(sessionId, { observedStreaming: true });
      });
    }
    prevLoading = loading;
  });

  const modelChangeMap = createMemo(() => {
    messageInfoVersion();
    const providerMap = new Map(state.providers.map((p) => [p.id, p]));
    const messagesSnapshot = messages();
    return untrack(() => {
      const result = new Map<string, ModelChangeInfo>();
      let previous: AssistantMessage | undefined;
      for (const msg of messagesSnapshot) {
        if (!isAssistantMessage(msg.info)) continue;
        // SAFETY: The surrounding shape or discriminator check establishes the AssistantMessage contract used below.
        const cur = msg.info as AssistantMessage;
        if (cur.mode === 'subagent') continue;
        if (previous) {
          const previousProvider = providerMap.get(previous.providerID);
          const currentProvider = providerMap.get(cur.providerID);
          const fromProvider = previousProvider?.name || previous.providerID;
          const toProvider = currentProvider?.name || cur.providerID;
          const fromModel = formatModelName(
            previousProvider?.models[previous.modelID]?.name || previous.modelID
          );
          const toModel = formatModelName(
            currentProvider?.models[cur.modelID]?.name || cur.modelID
          );
          const fromReasoning = previous.variant
            ? formatVariantLabel(previous.variant)
            : modelSupportsReasoning(previous.providerID, previous.modelID, state.providers)
              ? 'Default'
              : 'No thinking';
          const toReasoning = cur.variant
            ? formatVariantLabel(cur.variant)
            : modelSupportsReasoning(cur.providerID, cur.modelID, state.providers)
              ? 'Default'
              : 'No thinking';
          const providerChanged = previous.providerID !== cur.providerID;
          const modelChanged = previous.modelID !== cur.modelID;
          const reasoningChanged = fromReasoning !== toReasoning;

          if (providerChanged || modelChanged || reasoningChanged) {
            const normalFrom = providerChanged
              ? formatLabelWithProvider(`${fromModel} ${fromReasoning}`, fromProvider)
              : `${fromModel} ${fromReasoning}`;
            const normalTo = providerChanged
              ? formatLabelWithProvider(`${toModel} ${toReasoning}`, toProvider)
              : modelChanged
                ? `${toModel} ${toReasoning}`
                : toReasoning;
            const narrowFrom = providerChanged
              ? formatLabelWithProvider(fromModel, fromProvider)
              : modelChanged
                ? fromModel
                : fromReasoning;
            const narrowTo = providerChanged
              ? formatLabelWithProvider(
                  `${toModel}${reasoningChanged ? ` ${toReasoning}` : ''}`,
                  toProvider
                )
              : modelChanged
                ? `${toModel}${reasoningChanged ? ` ${toReasoning}` : ''}`
                : toReasoning;
            result.set(msg.info.id, {
              normalFrom,
              normalTo,
              narrowFrom,
              narrowTo,
              from: formatLabelWithProvider(`${fromModel} ${fromReasoning}`, fromProvider),
              to: formatLabelWithProvider(`${toModel} ${toReasoning}`, toProvider),
            });
          }
        }
        previous = cur;
      }
      return result;
    });
  });

  const previousTrailingFileEventSignatureMap = createMemo(() => {
    messageStructureVersion();
    const visibleMessages = messages();
    return untrack(() => {
      const result = new Map<string, string | null>();
      let previousTrailingSignature: string | null = null;

      for (const msg of visibleMessages) {
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
  const trailingAssistantTurn = createMemo(() => {
    messageInfoVersion();
    const visibleMessages = messages();
    let userMessageId: string | null = null;

    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      const info = visibleMessages[index]!.info;
      if (info.role === 'user') {
        userMessageId = info.id;
        break;
      }
      if (info.mode !== 'subagent') {
        userMessageId = info.parentID;
        break;
      }
    }

    if (!userMessageId) return null;

    const assistantMessageIds = new Set<string>();
    let latestAssistant: AssistantMessage | null = null;
    for (const entry of visibleMessages) {
      if (
        entry.info.role !== 'assistant' ||
        entry.info.mode === 'subagent' ||
        entry.info.parentID !== userMessageId
      ) {
        continue;
      }
      assistantMessageIds.add(entry.info.id);
      latestAssistant = entry.info;
    }

    return { userMessageId, assistantMessageIds, latestAssistant };
  });
  const trailingTurnInlineEditRetention = createMemo<{
    sessionId: string | null;
    userMessageId: string | null;
    messageIds: ReadonlySet<string>;
  }>(
    (previous) => {
      const sessionId = state.activeSessionId;
      const turn = trailingAssistantTurn();
      const empty = {
        sessionId,
        userMessageId: null,
        messageIds: new Set<string>(),
      };
      if (!sessionId || messages().length === 0) return empty;
      const retainedMessageIds =
        previous.sessionId === sessionId ? previous.messageIds : new Set<string>();
      const retained = {
        sessionId,
        userMessageId: previous.sessionId === sessionId ? previous.userMessageId : null,
        messageIds: retainedMessageIds,
      };
      if (!turn || turn.assistantMessageIds.size === 0) return retained;

      const awaitingInput = isSessionAwaitingInput(sessionId);
      const treeWorking = isSessionTreeStatusWorking(sessionId);
      const settledWithError = !!turn.latestAssistant?.error && !treeWorking && !awaitingInput;
      if (settledWithError) return retained;
      if (treeWorking || awaitingInput) {
        return {
          sessionId,
          userMessageId: turn.userMessageId,
          messageIds: new Set([...retainedMessageIds, ...turn.assistantMessageIds]),
        };
      }

      const sameTurnCompletedWhileOpen =
        previous.sessionId === sessionId &&
        previous.userMessageId === turn.userMessageId &&
        [...turn.assistantMessageIds].some((messageId) => retainedMessageIds.has(messageId)) &&
        !!turn.latestAssistant?.time.completed;
      return sameTurnCompletedWhileOpen
        ? {
            sessionId,
            userMessageId: turn.userMessageId,
            messageIds: new Set([...retainedMessageIds, ...turn.assistantMessageIds]),
          }
        : retained;
    },
    { sessionId: null, userMessageId: null, messageIds: new Set<string>() }
  );
  const keepTrailingTurnEditMessageIds = createMemo(
    () => trailingTurnInlineEditRetention().messageIds
  );
  const compactActivityMessages = createMemo(() => {
    const previousSignatures = previousTrailingFileEventSignatureMap();
    return messages().map((message) =>
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
  });
  const activityPartKeysBehindStreamingPartState = createMemo<{
    sessionId: string | null;
    userMessageId: string | null;
    keys: ReadonlySet<string>;
  }>(
    (previous) => {
      const sessionId = state.activeSessionId;
      const turn = trailingAssistantTurn();
      const userMessageId = turn?.userMessageId ?? null;
      const retainedKeys =
        previous.sessionId === sessionId && previous.userMessageId === userMessageId
          ? previous.keys
          : new Set<string>();
      const trailingMessageIds = trailingAssistantTurn()?.assistantMessageIds;
      const streamingPartId = state.streamingPartId;
      if (
        !trailingMessageIds?.size ||
        !streamingPartId ||
        state.streamingText.trim().length === 0
      ) {
        return { sessionId, userMessageId, keys: retainedKeys };
      }
      const precedingActivityPartKeys = new Set<string>();
      for (const message of compactActivityMessages()) {
        if (!trailingMessageIds.has(message.info.id)) continue;
        for (const part of message.parts) {
          if (part.id === streamingPartId) {
            const keys =
              part.type === 'text'
                ? new Set([...retainedKeys, ...precedingActivityPartKeys])
                : retainedKeys;
            return { sessionId, userMessageId, keys };
          }
          if (isAssistantActivityPart(part)) {
            precedingActivityPartKeys.add(getAssistantActivityPartKey(part));
          }
        }
      }
      return { sessionId, userMessageId, keys: retainedKeys };
    },
    { sessionId: null, userMessageId: null, keys: new Set<string>() }
  );
  const activityPartKeysBehindStreamingPart = createMemo(
    () => activityPartKeysBehindStreamingPartState().keys
  );
  const filterActivityPartKeysBehindStream = (keys: ReadonlySet<string>) => {
    const hiddenKeys = activityPartKeysBehindStreamingPart();
    if (hiddenKeys.size === 0 || ![...keys].some((key) => hiddenKeys.has(key))) return keys;
    return new Set([...keys].filter((key) => !hiddenKeys.has(key)));
  };
  createComputed<ReadonlySet<string>>((previousHiddenKeys) => {
    const hiddenKeys = activityPartKeysBehindStreamingPart();
    const newlyHiddenTransitionKeys = new Set<string>();
    for (const key of hiddenKeys) {
      if (
        !previousHiddenKeys.has(key) &&
        (visibleActiveActivityPartKeys().has(key) ||
          retainedActivityPartKeys().has(key) ||
          exitingActivityPartKeys().has(key))
      ) {
        newlyHiddenTransitionKeys.add(key);
      }
    }
    reserveCollapsedActivityTraySpace(newlyHiddenTransitionKeys);
    return hiddenKeys;
  }, new Set<string>());
  const renderedVisibleActiveActivityPartKeys = createMemo(() =>
    filterActivityPartKeysBehindStream(visibleActiveActivityPartKeys())
  );
  const renderedRetainedActivityPartKeys = createMemo(() =>
    filterActivityPartKeysBehindStream(retainedActivityPartKeys())
  );
  const renderedExitingActivityPartKeys = createMemo(() =>
    filterActivityPartKeysBehindStream(exitingActivityPartKeys())
  );
  const activeActivityMessageIds = createMemo<ReadonlySet<string>>(() => {
    if (!activeSessionWorking()) return new Set<string>();
    return trailingAssistantTurn()?.assistantMessageIds ?? new Set<string>();
  });
  createEffect(() => {
    if (exitingActivityPartKeys().size === 0) preserveActivityExitReserve();
  });
  const activityPartFirstSeenAt = new Map<string, number>();
  const settledActivityPartKeys = new Set<string>();
  const activityCompletionTimers = new Map<
    string,
    { exitTimer?: ReturnType<typeof setTimeout>; finishTimer: ReturnType<typeof setTimeout> }
  >();
  const activityShowTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const getTrailingVisibleAssistantPartKey = () => {
    let result: string | null = null;
    const streaming = { partId: state.streamingPartId, text: state.streamingText };
    for (const message of compactActivityMessages()) {
      if (!isAssistantMessage(message.info)) continue;
      for (const part of message.parts) {
        if (
          !shouldShowAssistantPartInline(part) ||
          (part.type === 'text' && !hasVisibleProjectedText(part, streaming))
        ) {
          continue;
        }
        result = `${part.messageID}\u0000${part.id}`;
      }
    }
    return result;
  };

  const clearActivityCompletionTimer = (key: string) => {
    const timers = activityCompletionTimers.get(key);
    if (!timers) return;
    if (timers.exitTimer) clearTimeout(timers.exitTimer);
    clearTimeout(timers.finishTimer);
    activityCompletionTimers.delete(key);
  };

  const clearActivityShowTimer = (key: string) => {
    const timer = activityShowTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    activityShowTimers.delete(key);
  };

  const finishActivityExit = (key: string) => {
    batch(() => {
      const exitingKeys = untrack(exitingActivityPartKeys);
      if (exitingKeys.has(key) && exitingKeys.size === 1) preserveActivityExitReserve();
      setSetMembership(setExitingActivityPartKeys, key, false);
    });
  };

  const completeActivityExit = (
    key: string,
    timers: {
      exitTimer?: ReturnType<typeof setTimeout>;
      finishTimer: ReturnType<typeof setTimeout>;
    }
  ) => {
    if (activityCompletionTimers.get(key) !== timers) return;
    clearActivityCompletionTimer(key);
    activityPartFirstSeenAt.delete(key);
    settledActivityPartKeys.add(key);
    finishActivityExit(key);
  };

  const finishActivityExitAfterAnimation = (key: string) => {
    queueMicrotask(() => {
      const timers = activityCompletionTimers.get(key);
      const partId = key.slice(key.lastIndexOf('\u0000') + 1);
      const item = containerRef?.querySelector<HTMLElement>(
        `[data-activity-part-id="${CSS.escape(partId)}"]`
      );
      const animation =
        globalThis.CSSAnimation === undefined
          ? undefined
          : item
              ?.getAnimations()
              .find(
                (candidate): candidate is CSSAnimation =>
                  candidate instanceof globalThis.CSSAnimation &&
                  candidate.animationName === 'assistant-active-activity-out'
              );
      if (!timers || !animation) return;

      clearTimeout(timers.finishTimer);
      timers.finishTimer = setTimeout(
        () => completeActivityExit(key, timers),
        ACTIVITY_EXIT_MS + ACTIVITY_EXIT_CLEANUP_GRACE_MS
      );
      void animation.finished.then(
        () => completeActivityExit(key, timers),
        () => undefined
      );
    });
  };

  const canCompactActivityPart = (part: AssistantActivityPart) =>
    shouldShowAssistantPartInline(part) &&
    shouldCompactAssistantActivityPart(part, {
      keepEditInline: keepTrailingTurnEditMessageIds().has(part.messageID),
    }) &&
    (part.type !== 'tool' ||
      (!getQuestionRequestForTool(part) && !getPermissionMatchForTool(part)));

  createComputed(() => {
    const activityMessages = compactActivityMessages();
    const candidates: AssistantActivityPart[] = [];
    const currentKeys = new Set<string>();
    const now = Date.now();
    const sessionWorking = activeSessionWorking();
    const activeMessageIds = activeActivityMessageIds();
    const lastVisiblePartKey = getTrailingVisibleAssistantPartKey();

    for (const message of activityMessages) {
      if (!isAssistantMessage(message.info)) continue;
      for (const part of message.parts) {
        if (!isAssistantActivityPart(part) || !canCompactActivityPart(part)) {
          continue;
        }

        candidates.push(part);
      }
    }

    const abruptlyGroupedKeys = new Set(
      candidates
        .filter(
          (part) =>
            isAssistantActivityPartRunning(part) &&
            !activeMessageIds.has(part.messageID) &&
            visibleActiveActivityPartKeys().has(getAssistantActivityPartKey(part))
        )
        .map(getAssistantActivityPartKey)
    );
    reserveCollapsedActivityTraySpace(abruptlyGroupedKeys);

    for (let index = 0; index < candidates.length; index += 1) {
      const part = candidates[index]!;
      const key = getAssistantActivityPartKey(part);
      currentKeys.add(key);
      if (
        exitingActivityPartKeys().has(key) &&
        settledActivityPartKeys.has(key) &&
        (lastVisiblePartKey !== key || !sessionWorking)
      ) {
        setSetMembership(setExitingActivityPartKeys, key, false);
      }
      if (isAssistantActivityPartRunning(part)) {
        if (!activeMessageIds.has(part.messageID)) {
          clearActivityCompletionTimer(key);
          clearActivityShowTimer(key);
          activityPartFirstSeenAt.delete(key);
          settledActivityPartKeys.add(key);
          setSetMembership(setVisibleActiveActivityPartKeys, key, false);
          setSetMembership(setRetainedActivityPartKeys, key, false);
          setSetMembership(setExitingActivityPartKeys, key, false);
          continue;
        }
        settledActivityPartKeys.delete(key);
        clearActivityCompletionTimer(key);
        setSetMembership(setRetainedActivityPartKeys, key, false);
        setSetMembership(setExitingActivityPartKeys, key, false);
        if (visibleActiveActivityPartKeys().has(key)) {
          activityPartFirstSeenAt.set(key, activityPartFirstSeenAt.get(key) ?? now);
        } else if (!activityShowTimers.has(key)) {
          const timer = setTimeout(() => {
            activityShowTimers.delete(key);
            const currentPart = compactActivityMessages()
              .flatMap((message) => message.parts)
              .find(
                (candidate): candidate is AssistantActivityPart =>
                  isAssistantActivityPart(candidate) &&
                  getAssistantActivityPartKey(candidate) === key
              );
            if (
              !currentPart ||
              !isAssistantActivityPartRunning(currentPart) ||
              !untrack(activeActivityMessageIds).has(currentPart.messageID)
            ) {
              return;
            }
            activityPartFirstSeenAt.set(key, Date.now());
            setSetMembership(setVisibleActiveActivityPartKeys, key, true);
          }, ACTIVITY_SHOW_DELAY_MS);
          activityShowTimers.set(key, timer);
        }
        continue;
      }

      const completedBeforeShow = activityShowTimers.has(key);
      clearActivityShowTimer(key);
      setSetMembership(setVisibleActiveActivityPartKeys, key, false);
      if (completedBeforeShow) {
        settledActivityPartKeys.add(key);
        activityPartFirstSeenAt.delete(key);
        continue;
      }
      if (settledActivityPartKeys.has(key) || activityCompletionTimers.has(key)) continue;
      const firstSeenAt = activityPartFirstSeenAt.get(key);
      if (firstSeenAt === undefined) {
        settledActivityPartKeys.add(key);
        continue;
      }

      const holdMs =
        state.streamingPartId && state.streamingText.length > 0
          ? 0
          : Math.max(0, firstSeenAt + ACTIVITY_MIN_VISIBLE_MS - now);
      setSetMembership(setRetainedActivityPartKeys, key, true);
      const beginExit = () => {
        reserveActivityExitSpace(key);
        batch(() => {
          setSetMembership(setRetainedActivityPartKeys, key, false);
          setSetMembership(setExitingActivityPartKeys, key, true);
        });
        finishActivityExitAfterAnimation(key);
      };
      const exitTimer = holdMs > 0 ? setTimeout(beginExit, holdMs) : undefined;
      if (holdMs === 0) beginExit();
      const finishTimer = setTimeout(() => {
        const timers = activityCompletionTimers.get(key);
        if (timers) completeActivityExit(key, timers);
      }, holdMs + ACTIVITY_EXIT_MS);
      activityCompletionTimers.set(key, { finishTimer, exitTimer });
    }

    for (const key of new Set([
      ...activityPartFirstSeenAt.keys(),
      ...settledActivityPartKeys,
      ...activityCompletionTimers.keys(),
      ...activityShowTimers.keys(),
    ])) {
      if (currentKeys.has(key)) continue;
      clearActivityCompletionTimer(key);
      clearActivityShowTimer(key);
      activityPartFirstSeenAt.delete(key);
      settledActivityPartKeys.delete(key);
      setSetMembership(setVisibleActiveActivityPartKeys, key, false);
      setSetMembership(setRetainedActivityPartKeys, key, false);
      setSetMembership(setExitingActivityPartKeys, key, false);
    }
  });

  onCleanup(() => {
    for (const key of activityCompletionTimers.keys()) clearActivityCompletionTimer(key);
    for (const key of activityShowTimers.keys()) clearActivityShowTimer(key);
  });
  const assistantActivityGroupMap = createMemo<Map<string, AssistantActivityGroupInfo[]>>(
    (previous) => {
      trackMessageBlockExpansionState();
      const activeMessageIds = activeActivityMessageIds();
      const activityMessages = compactActivityMessages();
      const streaming = { partId: state.streamingPartId, text: state.streamingText };
      const isBoundaryPart = (part: Part) =>
        part.type === 'text'
          ? hasVisibleProjectedText(part, streaming)
          : shouldShowAssistantPartInline(part);
      const isNormallyIncluded = (part: AssistantActivityPart) =>
        canCompactActivityPart(part) &&
        (!isAssistantActivityPartRunning(part) ||
          !activeMessageIds.has(part.messageID) ||
          visibleActiveActivityPartKeys().has(getAssistantActivityPartKey(part)));
      const ownerIsTransitioning = (group: AssistantActivityGroupInfo) => {
        const ownerKey = `${group.ownerMessageId}\u0000${group.ownerPartId}`;
        return retainedActivityPartKeys().has(ownerKey) || exitingActivityPartKeys().has(ownerKey);
      };
      return preserveAssistantActivityGroupKeys(
        getAssistantActivityGroupMap(activityMessages, isNormallyIncluded, isBoundaryPart),
        previous,
        { pinPreviousOwner: ownerIsTransitioning }
      );
    },
    new Map()
  );
  const compactActivityDisclosureLayoutSignatures = createMemo(() => {
    trackMessageBlockExpansionState();
    return getCompactActivityDisclosureLayoutSignatures(
      assistantActivityGroupMap(),
      (key) => getMessageBlockExpanded(key) ?? false,
      (part) => {
        const key = getAssistantActivityPartKey(part);
        if (renderedVisibleActiveActivityPartKeys().has(key)) return 'active';
        if (renderedRetainedActivityPartKeys().has(key)) return 'retained';
        if (renderedExitingActivityPartKeys().has(key)) return 'exiting';
        return 'grouped';
      }
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
    const suppressTrailingSummary = trailingSummaryMessageId() === null;
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
        primarySessionId: state.activeSessionId ?? undefined,
        suppressTrailingSummary,
        collectLeadingSummaryStats,
      })
    );
  });
  const trailingAssistantDialogSummary = createMemo<{
    message: MessageEntry;
    summary: AssistantDialogSummaryInfo;
  } | null>((previous) => {
    const messageId = trailingSummaryMessageId();
    if (!messageId) return null;
    const summary = assistantDialogSummaryMap().get(messageId);
    const message = messages().find((entry) => entry.info.id === messageId);
    if (message && summary) return { message, summary };
    return previous?.message.info.id === messageId && message
      ? { message, summary: previous.summary }
      : null;
  });
  const rowAssistantDialogSummaryMap = createMemo(() => {
    const summaries = assistantDialogSummaryMap();
    if (editingMessage()) return summaries;
    const trailing = trailingAssistantDialogSummary();
    if (!trailing || !summaries.has(trailing.message.info.id)) return summaries;
    const rowSummaries = new Map(summaries);
    rowSummaries.delete(trailing.message.info.id);
    return rowSummaries;
  });
  createEffect(() => {
    trackMessageBlockExpansionState();
    const previous = knownZeroHeightMessageIds();
    const activityMessages = compactActivityMessages();
    const delayedActivityPartKeys = new Set(activityShowTimers.keys());
    const candidates = getRenderEmptyAssistantMessageIds(
      activityMessages,
      assistantActivityGroupMap(),
      (key) => getMessageBlockExpanded(key) ?? false,
      {
        delayed: delayedActivityPartKeys,
        visibleActive: renderedVisibleActiveActivityPartKeys(),
        retained: renderedRetainedActivityPartKeys(),
        exiting: renderedExitingActivityPartKeys(),
      },
      { partId: state.streamingPartId, text: state.streamingText }
    );
    const modelChanges = modelChangeMap();
    const dialogSummaries = rowAssistantDialogSummaryMap();
    const next = new Set(
      [...candidates].filter(
        (messageId) => !modelChanges.has(messageId) && !dialogSummaries.has(messageId)
      )
    );
    if (previous.size === next.size && [...next].every((messageId) => previous.has(messageId))) {
      return;
    }

    const currentMessageIds = new Set(messages().map((message) => message.info.id));
    for (const messageId of new Set([...previous, ...next])) {
      if (previous.has(messageId) === next.has(messageId)) continue;
      if (previous.has(messageId) && currentMessageIds.has(messageId)) {
        measuredHeights.delete(messageId);
        zeroHeightRenderContentSignatures.delete(messageId);
        forcedVirtualContentMessageIds.add(messageId);
      }
      markVirtualMetricsDirty(messageId);
    }
    setKnownZeroHeightMessageIds(next);
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
  const activeTurnMessageId = createMemo(() => {
    scrollTop();
    stickyPreviewGeometryVersion();
    const navigationTargetId = activeTurnNavigationTargetId();
    const sticky = stickyUserMessagePreviewCandidate();
    const visibleMessages = messages();
    if (visibleMessages.length === 0) return null;
    const container = containerRef;
    let firstVisibleIndex: number | null = null;
    if (container) {
      const containerBounds = container.getBoundingClientRect();
      const visibleTop = containerBounds.top + getMessageJumpTopInset();
      const containerBottom = containerBounds.bottom;
      for (const [index, entry] of visibleMessages.entries()) {
        const row = mountedMessageRows.get(entry.info.id);
        if (!row) continue;
        const bubble = row.querySelector<HTMLElement>('.chat-turn-content');
        if (!bubble) continue;
        const bounds = bubble.getBoundingClientRect();
        if (bounds.bottom <= visibleTop || bounds.top >= containerBottom) continue;
        firstVisibleIndex = index;
        break;
      }
    }
    if (firstVisibleIndex === null && shouldVirtualize()) {
      firstVisibleIndex = getFirstVisibleMessageIndexFromVirtualMetrics({
        metrics: virtualMetrics(),
        scrollTop: getVirtualScrollTop(stickyPreviewScrollTop() || scrollTop()),
      });
    }
    const viewportTurnId = getActiveTurnMessageId(
      visibleMessages,
      firstVisibleIndex,
      sticky?.id ?? null,
      turnNavigationPreviews()[0]?.id ?? null
    );
    return getActiveTurnNavigationMessageId(
      turnNavigationPreviews(),
      viewportTurnId,
      navigationTargetId
    );
  });

  async function waitForMessageRow(
    preview: StickyUserMessagePreview,
    isCurrent: () => boolean = () => true
  ): Promise<HTMLElement | null> {
    finishWidthResizeNow();
    const container = containerRef;
    if (!container) return null;
    const sessionId = state.activeSessionId;
    const findRow = () => {
      const row = mountedMessageRows.get(preview.id);
      return row?.classList.contains('interactive-item-virtual-placeholder') ? undefined : row;
    };
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
          const metrics = virtualMetrics();
          const nextScrollTop =
            getContainerScrollTopForVirtualOffset(metrics.prefix[messageIndex] ?? 0) -
            getMessageJumpTopInset();
          container.scrollTop = nextScrollTop;
          setScrollTop(nextScrollTop);
          setStickyPreviewScrollTop(nextScrollTop);
        }
        settleFrames += 1;
        if (settleFrames >= STICKY_NAVIGATION_SETTLE_FRAME_LIMIT) return null;
        await waitForAnimationFrame();
        continue;
      }

      if (shouldMeasureRows()) alignMountedMessage(preview);

      const currentMeasurementVersion = measurementVersion();
      if (
        currentMeasurementVersion === previousMeasurementVersion ||
        settleFrames >= STICKY_NAVIGATION_SETTLE_FRAME_LIMIT - 1
      )
        return row;
      previousMeasurementVersion = currentMeasurementVersion;
      settleFrames += 1;
      await waitForAnimationFrame();
    }
    return null;
  }

  function alignMountedMessage(preview: StickyUserMessagePreview): boolean {
    const row = mountedMessageRows.get(preview.id);
    if (!row || row.classList.contains('interactive-item-virtual-placeholder')) return false;
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
    const aligned = alignMountedMessage(preview);
    if (aligned) {
      directMovementAnchor = null;
      const target = getStickyUserMessageSourceElement(preview.id);
      const row = mountedMessageRows.get(preview.id);
      const containerRect = containerRef?.getBoundingClientRect();
      lastDetachedVisibleAnchor =
        target && row && containerRect
          ? {
              messageId: preview.id,
              element: target,
              top: target.getBoundingClientRect().top - containerRect.top,
              messageTop: row.getBoundingClientRect().top - containerRect.top,
              topPad: visibleRange().topPad,
            }
          : captureMessageScrollAnchor(preview.id);
      animateTurnNavigationDestination(preview.id);
    }
    const currentPreview = untrack(stickyUserMessagePreview);
    if (aligned && currentPreview?.id === preview.id) {
      setStickyUserMessagePreview(null);
      previousStickyPreviewId = preview.id;
      previousStickyPreviewBounds = null;
    }
    return aligned;
  }

  function animateTurnNavigationDestination(messageId: string) {
    if (pendingTurnNavigationAnimationMessageId !== messageId) return;
    pendingTurnNavigationAnimationMessageId = null;
    const target = mountedMessageRows
      .get(messageId)
      ?.querySelector<HTMLElement>('.user-message-card');
    if (!target) return;
    const animationEpoch = ++turnNavigationAnimationEpoch;
    target.classList.remove('turn-navigation-destination');
    void target.offsetWidth;
    target.classList.add('turn-navigation-destination');
    const clear = () => {
      if (turnNavigationAnimationEpoch === animationEpoch) {
        target.classList.remove('turn-navigation-destination');
      }
    };
    target.addEventListener('animationend', clear, { once: true });
    setTimeout(clear, 1_000);
  }

  function handleStickyPreviewClick(preview: StickyUserMessagePreview) {
    if (stickyNavigationOwnsScroll()) cancelStickyNavigation();
    pendingWheelResizeAnchor = null;
    pendingTurnNavigationAnimationMessageId = preview.id;
    setActiveTurnNavigationTargetId(preview.id);
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
        if (stickyJumpSettleEpoch !== settleEpoch) return;
        setStickyNavigationInProgress(false);
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
      const jump = {
        sessionId,
        preview,
        windowVersion: getSessionMessageWindowStateVersion(sessionId),
      };
      setPendingStickyJump(jump);
      void loadAndScrollToStickyPreview(jump);
    } else {
      setActiveTurnNavigationTargetId(null);
    }
  }

  async function settleMountedStickyPreviewJump(
    preview: StickyUserMessagePreview,
    sessionId: string,
    settleEpoch: number
  ) {
    let stableFrames = 0;
    for (let attempt = 0; attempt < STICKY_NAVIGATION_SETTLE_FRAME_LIMIT; attempt += 1) {
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
    windowVersion: number;
    loadingOwner?: HistoryLoadingOwner;
  }) {
    const { sessionId, preview, windowVersion } = jump;
    const releaseLoadingOwner = () => {
      if (!jump.loadingOwner) return;
      setLoadingOlderHistory(sessionId, false, jump.loadingOwner);
      delete jump.loadingOwner;
    };
    const clearPendingJump = () => {
      releaseLoadingOwner();
      if (pendingStickyJump() !== jump) return;
      setPendingStickyJump(null);
    };
    const isCurrentJump = () =>
      pendingStickyJump() === jump &&
      state.activeSessionId === sessionId &&
      getSessionMessageWindowStateVersion(sessionId) === windowVersion;
    const historyLoad = activeOlderHistoryLoads.get(sessionId);
    if (
      historyLoad?.generation === activeSessionGeneration &&
      historyLoad.windowVersion === windowVersion
    ) {
      await historyLoad.promise;
    }
    if (!isCurrentJump()) {
      clearPendingJump();
      return;
    }

    const needsHistory = !messages().some((entry) => entry.info.id === preview.id);
    if (needsHistory && !loadingOlderHistory(sessionId)) {
      jump.loadingOwner = { windowVersion };
      setLoadingOlderHistory(sessionId, true, jump.loadingOwner);
    }
    if (needsHistory) {
      try {
        let staleRetryCount = 0;
        while (isCurrentJump() && !messages().some((entry) => entry.info.id === preview.id)) {
          const cursorBeforeLoad = getSessionHistoryCursor(sessionId);
          const loaded = await loadOlderSessionHistoryPage(sessionId);
          if (!isCurrentJump()) break;
          if (!loaded) {
            if (
              staleRetryCount >= 2 ||
              getSessionHistoryCursor(sessionId) !== cursorBeforeLoad ||
              !isSessionHistoryTruncated(sessionId) ||
              isSessionHistoryLoadFailed(sessionId)
            ) {
              break;
            }
            staleRetryCount += 1;
            await Promise.resolve();
            continue;
          }
          staleRetryCount = 0;
        }
      } finally {
        releaseLoadingOwner();
      }
    }
    if (!isCurrentJump()) {
      clearPendingJump();
      return;
    }
    try {
      const ready = await waitForMessageRow(preview, isCurrentJump);
      if (!ready || !isCurrentJump()) return;
      await waitForAnimationFrame();
      if (isCurrentJump()) {
        const settleEpoch = ++stickyJumpSettleEpoch;
        await waitAndNavigateToMessage(
          preview,
          () => isCurrentJump() && stickyJumpSettleEpoch === settleEpoch
        );
      }
    } finally {
      clearPendingJump();
    }
  }

  function loadingOlderHistory(sessionId = state.activeSessionId) {
    return (
      !!sessionId &&
      loadingOlderHistoryOwners().get(sessionId)?.windowVersion ===
        getSessionMessageWindowStateVersion(sessionId)
    );
  }

  function setLoadingOlderHistory(sessionId: string, loading: boolean, owner: HistoryLoadingOwner) {
    setLoadingOlderHistoryOwners((current) => {
      const currentOwner = current.get(sessionId);
      if (loading ? currentOwner === owner : currentOwner !== owner) {
        return current;
      }
      const next = new Map(current);
      if (loading) next.set(sessionId, owner);
      else next.delete(sessionId);
      return next;
    });
  }

  function resetPendingHistoryGeneration() {
    activeSessionGeneration += 1;
    pendingTurnNavigationAnimationMessageId = null;
    setActiveTurnNavigationTargetId(null);
    historyAnchorSettleOwner = null;
    for (const pendingAnchor of pendingOlderHistoryAnchors.values()) {
      pendingAnchor.invalidated = true;
    }
    pendingOlderHistoryAnchors.clear();
    activeOlderHistoryLoads.clear();
    setLoadingOlderHistoryOwners(new Map<string, HistoryLoadingOwner>());
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
    const windowVersion = getSessionMessageWindowStateVersion(sessionId);
    const existing = activeOlderHistoryLoads.get(sessionId);
    if (existing?.generation === generation && existing.windowVersion === windowVersion) {
      return existing.promise;
    }
    if (loadingOlderHistory(sessionId) && (!existing || existing.windowVersion === windowVersion)) {
      return;
    }
    const loadingOwner: HistoryLoadingOwner = { windowVersion };
    // A prefetched page can publish synchronously. Let the native wheel/scroll event finish first,
    // then capture history ownership before the cached page is allowed to mutate the DOM.
    const load = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
      loadOlderHistoryPreservingScroll(
        sessionId,
        generation,
        windowVersion,
        loadingOwner,
        container
      )
    );
    const activeLoad = { generation, windowVersion, promise: load };
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
    windowVersion: number,
    loadingOwner: HistoryLoadingOwner,
    container: HTMLDivElement
  ): Promise<void> {
    const isCurrentWindow = () =>
      generation === activeSessionGeneration &&
      state.activeSessionId === sessionId &&
      getSessionMessageWindowStateVersion(sessionId) === windowVersion;
    if (!isCurrentWindow()) return;
    markSessionHistoryLoadFailed(sessionId, false);
    const anchor = captureVisibleScrollAnchor({ preferStableRenderItem: true });
    const pendingAnchor = {
      anchor,
      generation,
      invalidated: false,
      owner: 'history' as const,
      previousScrollHeight: container.scrollHeight,
      previousScrollTop: container.scrollTop,
      ownershipEpoch: userScrollOwnershipEpoch,
      inputEpoch: directScrollInputEpoch,
      windowVersion,
    };
    pendingOlderHistoryAnchors.set(sessionId, pendingAnchor);
    setLoadingOlderHistory(sessionId, true, loadingOwner);
    let settleOwner: typeof historyAnchorSettleOwner = null;
    let historyRestoreRafId = 0;
    const initialMessageIds = messageIds();
    const historyStructureChanged = () => messageIds() !== initialMessageIds;
    const canAlignHistoryAnchor = () =>
      isCurrentWindow() &&
      pendingOlderHistoryAnchors.get(sessionId) === pendingAnchor &&
      !pendingAnchor.invalidated &&
      userScrollOwnershipEpoch === pendingAnchor.ownershipEpoch &&
      (!settleOwner || historyAnchorSettleOwner === settleOwner);
    const historyMutationObserver = new MutationObserver(() => {
      if (!canAlignHistoryAnchor() || !historyStructureChanged()) return;
      measureVisibleItems();
      restorePendingHistoryAnchorIfMounted();
    });
    if (trackRef) historyMutationObserver.observe(trackRef, { childList: true, subtree: true });
    const keepHistoryAnchorAlignedBeforePaint = () => {
      historyRestoreRafId = requestAnimationFrame(() => {
        historyRestoreRafId = 0;
        if (!canAlignHistoryAnchor()) return;
        if (historyStructureChanged()) {
          measureVisibleItems();
          restorePendingHistoryAnchorIfMounted();
        }
        keepHistoryAnchorAlignedBeforePaint();
      });
    };
    keepHistoryAnchorAlignedBeforePaint();
    try {
      let loadedAnyPage = false;
      let staleRetryCount = 0;
      while (true) {
        if (!isCurrentWindow()) return;
        const cursorBeforeLoad = getSessionHistoryCursor(sessionId);
        const idsBefore = messages().map((entry) => entry.info.id);
        const loaded = await loadOlderSessionHistoryPage(sessionId);
        if (!isCurrentWindow()) return;
        if (!loaded) {
          if (
            staleRetryCount >= 2 ||
            getSessionHistoryCursor(sessionId) !== cursorBeforeLoad ||
            !isSessionHistoryTruncated(sessionId) ||
            isSessionHistoryLoadFailed(sessionId)
          ) {
            return;
          }
          staleRetryCount += 1;
          await Promise.resolve();
          continue;
        }

        loadedAnyPage = true;
        staleRetryCount = 0;
        const idsAfter = messages().map((entry) => entry.info.id);
        const structureChanged =
          idsBefore.length !== idsAfter.length ||
          idsBefore.some((messageId, index) => messageId !== idsAfter[index]);
        if (!isSessionHistoryTruncated(sessionId)) break;
        if (structureChanged && container.scrollHeight > container.clientHeight + 1) break;
      }
      if (!loadedAnyPage) return;
      settleOwner = { sessionId, generation, windowVersion };
      historyAnchorSettleOwner = settleOwner;
      const canRestoreAnchor = () =>
        isCurrentWindow() &&
        historyAnchorSettleOwner === settleOwner &&
        !!containerRef &&
        !stickyNavigationOwnsScroll() &&
        pendingOlderHistoryAnchors.get(sessionId) === pendingAnchor &&
        !pendingAnchor.invalidated &&
        userScrollOwnershipEpoch === pendingAnchor.ownershipEpoch;
      // The pinned range contains the old viewport. Replace provisional prefix heights and align
      // its stable render item synchronously so the browser never paints the estimated position.
      measureVisibleItems();
      restorePendingHistoryAnchorIfMounted();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await waitForAnimationFrame();
        if (!canRestoreAnchor()) return;
        measureVisibleItems();
        restorePendingHistoryAnchorIfMounted();
      }
      if (!canRestoreAnchor()) return;
      const currentContainer = containerRef;
      if (!currentContainer) return;
      if (!restoreVisibleScrollAnchor(pendingAnchor.anchor, { useMessageOffsetFallback: true })) {
        const heightDelta = currentContainer.scrollHeight - pendingAnchor.previousScrollHeight;
        setPreservedScrollTop(pendingAnchor.previousScrollTop + Math.max(0, heightDelta));
      }
    } finally {
      if (historyRestoreRafId) cancelAnimationFrame(historyRestoreRafId);
      historyMutationObserver.disconnect();
      if (
        settleOwner &&
        historyAnchorSettleOwner === settleOwner &&
        userScrollOwnershipEpoch === pendingAnchor.ownershipEpoch &&
        directScrollInputEpoch === pendingAnchor.inputEpoch &&
        !pendingAnchor.invalidated
      ) {
        virtualPlaceholderReleaseBlockedUntil = Number.NEGATIVE_INFINITY;
      }
      if (settleOwner && historyAnchorSettleOwner === settleOwner) {
        historyAnchorSettleOwner = null;
      }
      if (pendingOlderHistoryAnchors.get(sessionId) === pendingAnchor) {
        pendingOlderHistoryAnchors.delete(sessionId);
      }
      setLoadingOlderHistory(sessionId, false, loadingOwner);
    }
  }

  return (
    <div class="interactive-list-shell min-h-0 flex-1">
      <div
        ref={containerRef}
        class={`interactive-list min-h-0 flex-1 overflow-y-auto${showModelPicker() ? ' showing-model-picker' : ''}${autoScroll() || shouldMeasureRows() || loadingOlderHistory() || exitingActivityPartKeys().size > 0 ? ' managed-scroll-anchor' : ''}${editingMessage() ? ' editing-message' : ''}${state.messagesLoading && messages().length > 0 ? ' is-session-hydrating' : ''}`}
        role="log"
        tabIndex={0}
        aria-live="polite"
        aria-label="Chat messages"
        onScroll={onScroll}
      >
        <div
          ref={trackRef}
          class={`interactive-list-track${shouldVirtualize() ? ' virtualized' : ''}${editingMessage() ? ' editing-message' : ''}`}
        >
          <Show when={displayedStickyUserMessagePreview()}>
            {(preview) => (
              <StickyUserMessagePreviewCard
                preview={preview()}
                parts={messages()[messageIndexById().get(preview().id) ?? -1]?.parts}
                sentAt={messages()[messageIndexById().get(preview().id) ?? -1]?.info.time.created}
                showSentTimestamp={showPromptNumbers()}
                promptNumber={
                  promptNumbersVisible() ? promptNumberMap().get(preview().id) : undefined
                }
                loading={pendingStickyJump()?.preview.id === preview().id}
                onClick={handleStickyPreviewClick}
                onGeometryChange={handleStickyPreviewGeometryChange}
              />
            )}
          </Show>
          <Show
            when={messages().length > 0}
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
                          width="256"
                          height="256"
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
                          <kbd>&amp;</kbd> link sessions
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
              showSentTimestamps={showPromptNumbers()}
              lastAssistantID={lastAssistantID()}
              outerListVirtualized={shouldVirtualize()}
              previousTrailingFileEventSignatureMap={previousTrailingFileEventSignatureMap()}
              assistantDialogSummaryMap={rowAssistantDialogSummaryMap()}
              isFinalAssistantMessage={(messageId) =>
                assistantDialogSummaryMap().has(messageId) ||
                (state.activeSessionId !== null &&
                  state.sessionStatus[state.activeSessionId]?.type !== 'busy' &&
                  state.sessionStatus[state.activeSessionId]?.type !== 'retry' &&
                  !activeSessionWorking() &&
                  trailingFinalResponseMessageId() === messageId)
              }
              assistantActivityGroupMap={assistantActivityGroupMap()}
              retainedActivityPartKeys={renderedRetainedActivityPartKeys()}
              exitingActivityPartKeys={renderedExitingActivityPartKeys()}
              visibleActiveActivityPartKeys={renderedVisibleActiveActivityPartKeys()}
              groupedActiveActivityPartKeys={visibleActiveActivityPartKeys()}
              hasBuildAgent={hasBuildAgent()}
              latestPlanImplementationMessageId={latestPlanImplementationMessageId()}
              visibleRange={visibleRange()}
              virtualMetrics={shouldVirtualize() ? virtualMetrics() : undefined}
              renderEmptyMessageIds={knownZeroHeightMessageIds()}
              forceVirtualContent={(messageId) => {
                measurementVersion();
                return (
                  forcedVirtualContentMessageIds.has(messageId) ||
                  viewportForcedVirtualContentMessageIds.has(messageId) ||
                  displayedStickyUserMessagePreview()?.id === messageId ||
                  pendingPermissionSequence().activePermission?.messageID === messageId
                );
              }}
              canReleaseVirtualPlaceholders={() =>
                performance.now() >= virtualPlaceholderReleaseBlockedUntil &&
                !pointerScrollOwnershipActive &&
                !stickyNavigationOwnsScroll() &&
                !editingMessage()
              }
              claimMessageEntrance={claimMessageEntrance}
              claimAssistantItemReveal={claimAssistantItemReveal}
              observeMeasuredRow={observeMeasuredRow}
              questionRequestForTool={getQuestionRequestForTool}
              permissionMatchForTool={getPermissionMatchForTool}
            />
          </Show>
          <Show when={!editingMessage()}>
            <PendingActionRows
              questions={standaloneQuestions()}
              permissions={standalonePermissions()}
              permissionPosition={pendingPermissionSequence().position}
              permissionTotal={pendingPermissionSequence().total}
            />
          </Show>
          <Show
            when={!editingMessage() ? trailingAssistantDialogSummary() : null}
            fallback={
              <Show when={reserveLoadingRow() && !editingMessage() && !!state.activeSessionId}>
                <LoadingRow
                  compacting={isSessionCompacting()}
                  visible={!state.messagesLoading && showLoadingRow()}
                />
              </Show>
            }
          >
            {(trailing) => (
              <div class="interactive-item-container interactive-response interactive-loading-row trailing-assistant-summary-row">
                <AssistantDialogSummaryForMessage
                  summary={trailing().summary}
                  msg={trailing().message}
                  hasBuildAgent={hasBuildAgent()}
                  latestPlanImplementationMessageId={latestPlanImplementationMessageId()}
                />
              </div>
            )}
          </Show>
          <Show when={appendBottomReserve() > 0.5}>
            <div
              class="append-scroll-bottom-reserve"
              style={{ height: `${appendBottomReserve()}px` }}
              aria-hidden="true"
            />
          </Show>
          <Show when={activityExitBottomReserve() > 0.5}>
            <div
              class="activity-exit-bottom-reserve"
              style={{ height: `${activityExitBottomReserve()}px` }}
              aria-hidden="true"
            />
          </Show>
        </div>
      </div>
      <Show
        when={turnNavigationPreviews().length > 1 && !editingMessage() && !hasExpandedDiffOverlay()}
      >
        <TurnNavigationRail
          turns={turnNavigationPreviews()}
          activeTurnId={activeTurnMessageId()}
          loadingTurnId={pendingStickyJump()?.preview.id}
          onSelect={handleStickyPreviewClick}
        />
      </Show>
      <ChatContentBottomFade />
      <Show when={showJumpToLatest() && !hasExpandedDiffOverlay()}>
        <Tooltip content="Scroll to latest message">
          <button
            type="button"
            class="jump-to-latest-button"
            aria-label="Scroll to latest message"
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
        </Tooltip>
      </Show>
    </div>
  );
}
