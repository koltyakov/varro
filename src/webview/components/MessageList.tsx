import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  on,
  untrack,
} from 'solid-js';
import {
  getSelectedAgentForSession,
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
  messageStructureVersion,
  getChildRunsByParentId,
  getActiveUsageLimitNotice,
  showStickyUserPrompt,
  skipPlanSession,
} from '../lib/state';
import {
  formatDuration,
  formatNumber,
  isAssistantMessage,
  sumAssistantTokens,
} from '../lib/message-metrics';
import type { AssistantMessage, Message, Part, Permission, QuestionRequest } from '../types';
import {
  Message as MessageComponent,
  getUserMessagePreviewText,
  type AssistantFileEditStackGroup,
} from './Message';
import { implementPlan, recheckSessionStatus } from '../hooks/useOpenCode';
import { modelSupportsReasoning } from '../lib/model-capabilities';
import { formatLabelWithProvider, formatVariantLabel } from '../lib/format';
import {
  collapseLeadingDuplicateFileEvents,
  getTrailingFileEventSignature,
} from '../lib/message-event-collapse';
import { isFileEditPart, isFileReadPart, shouldShowAssistantPartInline } from '../lib/part-utils';
import { PermissionPrompt } from './PermissionPrompt';
import { QuestionPrompt } from './QuestionPrompt';

function getAssistantTurnSubagentCount(messages: Array<{ info: Message; parts: Part[] }>): number {
  let count = 0;

  for (const message of messages) {
    if (!isAssistantMessage(message.info) || message.info.mode === 'subagent') continue;

    for (const part of message.parts) {
      if (part.type === 'agent' && part.name.trim()) {
        count++;
        continue;
      }

      if (part.type === 'subtask') {
        count++;
      }
    }
  }

  return count;
}

function isPlanningAssistantMessage(info: AssistantMessage): boolean {
  return info.agent === 'plan' || getSelectedAgentForSession(info.sessionID) === 'plan';
}

function hasLinkedToolCall(
  messages: Array<{ info: Message; parts: Part[] }>,
  sessionId: string,
  messageId: string | null | undefined,
  callId: string | null | undefined
) {
  if (!messageId || !callId) return false;

  return messages.some(
    (entry) =>
      entry.info.sessionID === sessionId &&
      entry.info.id === messageId &&
      entry.parts.some(
        (part) => part.type === 'tool' && part.messageID === messageId && part.callID === callId
      )
  );
}

export function getStandalonePermissionPrompts(
  messages: Array<{ info: Message; parts: Part[] }>,
  permissions: Permission[],
  activeSessionId: string | null
) {
  if (!activeSessionId) return [];

  return permissions.filter(
    (permission) =>
      permission.sessionID === activeSessionId &&
      !hasLinkedToolCall(messages, permission.sessionID, permission.messageID, permission.callID)
  );
}

export function getStandaloneQuestionPrompts(
  messages: Array<{ info: Message; parts: Part[] }>,
  questions: QuestionRequest[],
  activeSessionId: string | null
) {
  if (!activeSessionId) return [];

  return questions.filter(
    (question) =>
      question.sessionID === activeSessionId &&
      !hasLinkedToolCall(
        messages,
        question.sessionID,
        question.tool?.messageID,
        question.tool?.callID
      )
  );
}

export function buildPlanImplementationPrompt(parts: Part[]) {
  void parts;
  return 'Implement the plan from your last response in the current workspace. Make the code changes instead of revising the plan.';
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

const DEFAULT_ITEM_HEIGHT = 120;
const OVERSCAN = 5;
const VIRTUALIZE_THRESHOLD = 50;

type MessageRowSharedProps = {
  modelChangeMap: Map<string, string>;
  lastAssistantID: string | null;
  previousTrailingFileEventSignatureMap: Map<string, string | null>;
  fileEditStackGroupMap: Map<string, AssistantFileEditStackGroup | null>;
  assistantDialogSummaryMap: Map<string, AssistantDialogSummaryInfo>;
  hasBuildAgent: boolean;
  latestPlanImplementationMessageId: string | null;
};

type StickyUserMessagePreview = {
  id: string;
  index: number;
  text: string;
};

const STICKY_PREVIEW_VISIBILITY_BUFFER_PX = 12;
const STICKY_PREVIEW_DISPLAY_DEBOUNCE_MS = 90;
const STICKY_PREVIEW_MIN_VIEWPORT_HEIGHT_PX = 480;

export function getStickyUserMessagePreview(
  messages: Array<{ info: Message; parts: Part[] }>,
  firstVisibleMessageIndex: number | null
): StickyUserMessagePreview | null {
  if (firstVisibleMessageIndex === null || firstVisibleMessageIndex < 0) return null;
  if (messages[firstVisibleMessageIndex]?.info.role === 'user') return null;

  for (let i = firstVisibleMessageIndex; i >= 0; i--) {
    const entry = messages[i];
    if (entry.info.role !== 'user') continue;
    return {
      id: entry.info.id,
      index: i,
      text: getUserMessagePreviewText(entry.parts),
    };
  }

  return null;
}

export function shouldShowStickyUserMessagePreview(args: {
  preview: StickyUserMessagePreview | null;
  shouldVirtualize: boolean;
  visibleRange: { start: number; end: number };
  rowTop: number | null;
  rowBottom: number | null;
  viewportHeight: number;
  previousPreviewId?: string | null;
}) {
  const { preview } = args;
  if (!preview) return false;
  if (args.viewportHeight <= 0) return false;
  if (args.viewportHeight < STICKY_PREVIEW_MIN_VIEWPORT_HEIGHT_PX) return false;

  const isPreviousPreview = args.previousPreviewId === preview.id;
  const showThreshold = isPreviousPreview
    ? STICKY_PREVIEW_VISIBILITY_BUFFER_PX
    : -STICKY_PREVIEW_VISIBILITY_BUFFER_PX;

  if (args.shouldVirtualize && preview.index < args.visibleRange.start) return true;

  if (args.rowTop === null || args.rowBottom === null) return false;
  return args.rowBottom <= showThreshold;
}

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
  let stickyPreviewDebounceTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const SCROLL_INTERVAL_MS = 700;
  const INITIAL_SCROLL_MAX_FRAMES = 30;
  const INITIAL_SCROLL_STABLE_FRAMES = 3;
  const AUTO_SCROLL_THRESHOLD_PX = 60;
  const PROGRAMMATIC_SCROLL_WINDOW_MS = 200;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [measurementVersion, setMeasurementVersion] = createSignal(0);
  const [stickyUserMessagePreview, setStickyUserMessagePreview] =
    createSignal<StickyUserMessagePreview | null>(null);
  const activeUsageLimit = createMemo(() => getActiveUsageLimitNotice(state.activeSessionId));

  const messages = createMemo(on(messageStructureVersion, () => state.messages));
  const latestPlanImplementationMessageId = createMemo(() =>
    getLatestPlanImplementationMessageId(messages())
  );
  const standalonePermissions = createMemo(() =>
    getStandalonePermissionPrompts(messages(), state.permissions, state.activeSessionId)
  );
  const standaloneQuestions = createMemo(() =>
    getStandaloneQuestionPrompts(messages(), state.questions, state.activeSessionId)
  );
  const messageIndexById = createMemo(() => {
    const result = new Map<string, number>();
    for (const [index, entry] of messages().entries()) {
      result.set(entry.info.id, index);
    }
    return result;
  });
  const stickyUserMessagePreviewCandidate = createMemo(() => {
    const currentScrollTop = scrollTop();
    const currentViewportHeight = viewportHeight();
    if (!containerRef || currentViewportHeight <= 0) return null;

    const containerRect = containerRef.getBoundingClientRect();
    const rows = containerRef.querySelectorAll<HTMLElement>('[data-msg-id]');
    let firstVisibleMessageIndex: number | null = null;
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
    void currentScrollTop;

    const preview = getStickyUserMessagePreview(messages(), firstVisibleMessageIndex);
    if (!preview) return null;

    const row = containerRef.querySelector<HTMLElement>(`[data-msg-id="${preview.id}"]`);
    const rowRect = row?.getBoundingClientRect();
    const shouldShow = shouldShowStickyUserMessagePreview({
      preview,
      shouldVirtualize: shouldVirtualize(),
      visibleRange: visibleRange(),
      rowTop: rowRect ? rowRect.top - containerRect.top : null,
      rowBottom: rowRect ? rowRect.bottom - containerRect.top : null,
      viewportHeight: currentViewportHeight,
      previousPreviewId: previousStickyPreviewId,
    });
    return shouldShow ? preview : null;
  });
  const shouldVirtualize = createMemo(() => messages().length >= VIRTUALIZE_THRESHOLD);

  const measuredHeights = new Map<string, number>();
  let lastTrackHeight = 0;

  const visibleRange = createMemo(() => {
    const msgs = messages();
    measurementVersion();
    if (!shouldVirtualize() || msgs.length === 0) {
      return { start: 0, end: msgs.length, topPad: 0, bottomPad: 0 };
    }

    const st = scrollTop();
    const vh = viewportHeight();
    let acc = 0;
    let start = -1;
    let end = msgs.length;

    for (let i = 0; i < msgs.length; i++) {
      const h = measuredHeights.get(msgs[i].info.id) ?? DEFAULT_ITEM_HEIGHT;
      if (start === -1 && acc + h > st - OVERSCAN * DEFAULT_ITEM_HEIGHT) {
        start = i;
      }
      if (acc > st + vh + OVERSCAN * DEFAULT_ITEM_HEIGHT) {
        end = i;
        break;
      }
      acc += h;
    }
    if (start === -1) start = 0;

    let topPad = 0;
    for (let i = 0; i < start; i++) {
      topPad += measuredHeights.get(msgs[i].info.id) ?? DEFAULT_ITEM_HEIGHT;
    }

    let bottomPad = 0;
    for (let i = end; i < msgs.length; i++) {
      bottomPad += measuredHeights.get(msgs[i].info.id) ?? DEFAULT_ITEM_HEIGHT;
    }

    return { start, end, topPad, bottomPad };
  });

  function measureVisibleItems() {
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

  function updateScrollbarInset() {
    if (!containerRef) return;
    const scrollbarInset = Math.max(0, containerRef.offsetWidth - containerRef.clientWidth);
    containerRef.parentElement?.style.setProperty(
      '--interactive-list-scrollbar-inset',
      `${scrollbarInset}px`
    );
  }

  function distanceFromBottom() {
    if (!containerRef) return Number.POSITIVE_INFINITY;
    return Math.max(
      0,
      containerRef.scrollHeight - containerRef.scrollTop - containerRef.clientHeight
    );
  }

  function performScroll() {
    if (!containerRef) return;
    const now = performance.now();
    const target = Math.max(0, containerRef.scrollHeight - containerRef.clientHeight);
    expectedScrollTop = target;
    ignoreScrollUntil = now + PROGRAMMATIC_SCROLL_WINDOW_MS;
    containerRef.scrollTop = target;
    lastObservedScrollTop = target;
    lastScrollAt = now;
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

      measureVisibleItems();
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
    setScrollTop(top);
    setViewportHeight(containerRef.clientHeight);
    const near = distanceFromBottom() < AUTO_SCROLL_THRESHOLD_PX;
    const delta = top - lastObservedScrollTop;
    const now = performance.now();
    lastObservedScrollTop = top;

    const matchesExpected =
      expectedScrollTop !== -1 &&
      (Math.abs(top - expectedScrollTop) < 2 ||
        (near && top >= expectedScrollTop - AUTO_SCROLL_THRESHOLD_PX));

    if (matchesExpected) {
      expectedScrollTop = -1;
      return;
    }

    if (now <= ignoreScrollUntil) {
      const userMovedAwayFromTarget =
        expectedScrollTop !== -1 && top < expectedScrollTop - AUTO_SCROLL_THRESHOLD_PX;
      if (!userMovedAwayFromTarget) return;
      cancelPendingScroll();
      expectedScrollTop = -1;
      ignoreScrollUntil = 0;
      setAutoScroll(false);
      return;
    }

    expectedScrollTop = -1;
    if (near) {
      setAutoScroll(true);
      return;
    }

    if (autoScroll() && delta >= 0) return;

    cancelPendingScroll();
    setAutoScroll(false);
  }

  onMount(() => {
    if (!containerRef) return;
    updateScrollbarInset();
    setViewportHeight(containerRef.clientHeight);
    setScrollTop(containerRef.scrollTop);
    lastObservedScrollTop = containerRef.scrollTop ?? 0;
    if (!trackRef) return;
    lastTrackHeight = trackRef.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      if (!containerRef) return;
      updateScrollbarInset();
      setViewportHeight(containerRef.clientHeight);
      const previousTrackHeight = lastTrackHeight;
      measureVisibleItems();
      lastTrackHeight = trackRef?.getBoundingClientRect().height ?? previousTrackHeight;
      if (lastTrackHeight > previousTrackHeight + 1) {
        scrollToBottom();
      }
    });
    observer.observe(containerRef);
    observer.observe(trackRef);
    onCleanup(() => {
      observer.disconnect();
      if (scrollTimer) clearTimeout(scrollTimer);
      if (stickyPreviewDebounceTimer) clearTimeout(stickyPreviewDebounceTimer);
      if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);
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
      setStickyUserMessagePreview(candidate);
      previousStickyPreviewId = candidate.id;
      return;
    }

    stickyPreviewDebounceTimer = setTimeout(() => {
      stickyPreviewDebounceTimer = 0;
      setStickyUserMessagePreview(candidate);
      previousStickyPreviewId = null;
    }, STICKY_PREVIEW_DISPLAY_DEBOUNCE_MS);
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
    setAutoScroll(true);
    queueMicrotask(() => performScroll());
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    const msgs = messages();
    if (msgs.length === 0) return;
    queueMicrotask(() => {
      if (state.activeSessionId !== sessionId) return;
      measureVisibleItems();
      lastTrackHeight = trackRef?.getBoundingClientRect().height ?? lastTrackHeight;
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
      measureVisibleItems();
      lastTrackHeight = trackRef?.getBoundingClientRect().height ?? lastTrackHeight;
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
    const msgs = messages();
    const providerMap = new Map(state.providers.map((p) => [p.id, p]));
    const result = new Map<string, string>();
    let prevProvider: string | undefined;
    let prevModel: string | undefined;
    let prevVariant: string | undefined;
    for (const msg of msgs) {
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
        )
          parts.push('No thinking');
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

  const previousTrailingFileEventSignatureMap = createMemo(() => {
    const result = new Map<string, string | null>();
    let previousTrailingSignature: string | null = null;

    for (const msg of messages()) {
      result.set(msg.info.id, previousTrailingSignature);

      if (!isAssistantMessage(msg.info)) {
        previousTrailingSignature = null;
        continue;
      }

      previousTrailingSignature = getTrailingFileEventSignature(msg.parts);
    }

    return result;
  });

  const assistantStackGroupMap = createMemo(() => {
    const result = new Map<string, AssistantFileEditStackGroup | null>();
    const messageEntries = messages();
    let index = 0;

    while (index < messageEntries.length) {
      const current = messageEntries[index];
      const currentKind = getAssistantStackKind(
        current,
        previousTrailingFileEventSignatureMap().get(current.info.id) ?? null
      );

      if (!currentKind) {
        index++;
        continue;
      }

      let end = index;
      while (end + 1 < messageEntries.length) {
        const next = messageEntries[end + 1];
        if (
          getAssistantStackKind(
            next,
            previousTrailingFileEventSignatureMap().get(next.info.id) ?? null
          ) !== currentKind
        ) {
          break;
        }
        end++;
      }

      if (end > index) {
        for (let partIndex = index; partIndex <= end; partIndex++) {
          const position = partIndex === index ? 'start' : partIndex === end ? 'end' : 'middle';
          result.set(messageEntries[partIndex].info.id, position);
        }
      }

      index = end + 1;
    }

    return result;
  });

  const assistantDialogSummaryMap = createMemo(() => getAssistantDialogSummaryMap(messages()));
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
            <div class="chat-empty-state">
              <img
                class="chat-empty-logo"
                src={state.emptyStateLogoUri}
                alt=""
                aria-hidden="true"
                draggable="false"
              />
            </div>
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
            !state.streamingPartId &&
            !activeUsageLimit()
          }
        >
          <LoadingRow compacting={isSessionCompacting()} />
        </Show>
      </div>
    </div>
  );
}

function StickyUserMessagePreviewCard(props: { preview: StickyUserMessagePreview }) {
  return (
    <div class="latest-user-message-sticky-wrap" aria-hidden="true">
      <div class="latest-user-message-sticky-overlay">
        <div class="latest-user-message-sticky-top" />
        <div class="latest-user-message-sticky-shell">
          <div class="latest-user-message-sticky">
            <div class="latest-user-message-sticky-text" title={props.preview.text}>
              {props.preview.text}
            </div>
          </div>
        </div>
        <div class="latest-user-message-sticky-bottom-solid" />
        <div class="latest-user-message-sticky-bottom-fade" />
      </div>
    </div>
  );
}

function PendingActionRows(props: { questions: QuestionRequest[]; permissions: Permission[] }) {
  return (
    <>
      <For each={props.questions}>
        {(question) => (
          <div class="interactive-item-container interactive-response">
            <QuestionPrompt request={question} />
          </div>
        )}
      </For>
      <For each={props.permissions}>
        {(permission) => (
          <div class="interactive-item-container interactive-response">
            <PermissionPrompt permission={permission} />
          </div>
        )}
      </For>
    </>
  );
}

function VirtualizedContent(props: {
  messages: Array<{ info: Message; parts: Part[] }>;
  modelChangeMap: Map<string, string>;
  lastAssistantID: string | null;
  previousTrailingFileEventSignatureMap: Map<string, string | null>;
  fileEditStackGroupMap: Map<string, AssistantFileEditStackGroup | null>;
  assistantDialogSummaryMap: Map<string, AssistantDialogSummaryInfo>;
  hasBuildAgent: boolean;
  latestPlanImplementationMessageId: string | null;
  visibleRange: { start: number; end: number; topPad: number; bottomPad: number };
}) {
  const visible = createMemo(() =>
    props.messages.slice(props.visibleRange.start, props.visibleRange.end)
  );

  return (
    <>
      <Show when={props.visibleRange.topPad > 0}>
        <div style={{ height: `${props.visibleRange.topPad}px` }} />
      </Show>
      <MessageRows
        messages={visible()}
        modelChangeMap={props.modelChangeMap}
        lastAssistantID={props.lastAssistantID}
        previousTrailingFileEventSignatureMap={props.previousTrailingFileEventSignatureMap}
        fileEditStackGroupMap={props.fileEditStackGroupMap}
        assistantDialogSummaryMap={props.assistantDialogSummaryMap}
        hasBuildAgent={props.hasBuildAgent}
        latestPlanImplementationMessageId={props.latestPlanImplementationMessageId}
      />
      <Show when={props.visibleRange.bottomPad > 0}>
        <div style={{ height: `${props.visibleRange.bottomPad}px` }} />
      </Show>
    </>
  );
}

function MessageRows(
  props: { messages: Array<{ info: Message; parts: Part[] }> } & MessageRowSharedProps
) {
  return <For each={props.messages}>{(msg) => <MessageRow msg={msg} {...props} />}</For>;
}

function MessageRow(props: { msg: { info: Message; parts: Part[] } } & MessageRowSharedProps) {
  const changeLabel = () => props.modelChangeMap.get(props.msg.info.id) ?? null;
  const fileEditStackGroup = () => props.fileEditStackGroupMap.get(props.msg.info.id) ?? null;
  const summary = () => props.assistantDialogSummaryMap.get(props.msg.info.id);
  const highlightPlanningAnswer = () =>
    props.assistantDialogSummaryMap.has(props.msg.info.id) &&
    isAssistantMessage(props.msg.info) &&
    isPlanningAssistantMessage(props.msg.info);

  return (
    <div
      data-msg-id={props.msg.info.id}
      class={`interactive-item-container ${
        props.msg.info.role === 'user' ? 'interactive-request' : 'interactive-response'
      } ${
        fileEditStackGroup()
          ? `interactive-response-file-edit-group interactive-response-file-edit-group-${fileEditStackGroup()}`
          : ''
      }`}
    >
      <Show when={changeLabel()}>
        <div class="model-change-indicator">
          <span class="model-change-label">Switched to {changeLabel()}</span>
        </div>
      </Show>
      <MessageComponent
        info={props.msg.info}
        parts={props.msg.parts}
        isLastAssistant={props.msg.info.id === props.lastAssistantID}
        highlightFinalAnswer={props.assistantDialogSummaryMap.has(props.msg.info.id)}
        highlightPlanningAnswer={highlightPlanningAnswer()}
        previousTrailingFileEventSignature={
          props.previousTrailingFileEventSignatureMap.get(props.msg.info.id) ?? null
        }
        fileEditStackGroup={fileEditStackGroup()}
        streamingPartId={state.streamingPartId}
        streamingText={state.streamingText}
      />
      <Show when={summary()}>
        {(assistantSummary) => (
          <AssistantDialogSummary
            summary={assistantSummary()}
            showImplementPlanAction={shouldShowPlanImplementationAction({
              hasBuildAgent: props.hasBuildAgent,
              info: props.msg.info,
              latestPlanImplementationMessageId: props.latestPlanImplementationMessageId,
            })}
            onImplementPlan={() =>
              void implementPlan(
                buildPlanImplementationPrompt(props.msg.parts),
                props.msg.info.sessionID
              )
            }
            onSkipPlan={() => skipPlanSession(props.msg.info.sessionID)}
          />
        )}
      </Show>
    </div>
  );
}

type AssistantDialogSummaryInfo = {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  agentCount: number;
};

function getAssistantDialogSummaryMap(messages: Array<{ info: Message; parts: Part[] }>) {
  const result = new Map<string, AssistantDialogSummaryInfo>();
  let currentMessages: AssistantMessage[] = [];
  let currentEntries: Array<{ info: Message; parts: Part[] }> = [];

  const flush = () => {
    if (currentMessages.length === 0) {
      currentMessages = [];
      currentEntries = [];
      return;
    }

    const lastMessage = currentMessages[currentMessages.length - 1];
    if (!lastMessage?.time.completed) {
      currentMessages = [];
      currentEntries = [];
      return;
    }

    const completedMessages = currentMessages.filter((message) => !!message.time.completed);
    const end = Math.max(...completedMessages.map((message) => message.time.completed || 0));
    const tokens = sumAssistantTokens(currentMessages);
    const childRunsByParentId = getChildRunsByParentId(currentEntries);
    const primaryMessages = currentMessages.filter((message) => message.mode !== 'subagent');
    const childRunCount = primaryMessages.reduce(
      (count, message) => count + (childRunsByParentId.get(message.id)?.length || 0),
      0
    );
    const handoffCount = getAssistantTurnSubagentCount(currentEntries);
    const agentCount = Math.max(childRunCount, handoffCount);
    result.set(lastMessage.id, {
      durationMs: Math.max(0, end - currentMessages[0].time.created),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      agentCount,
    });

    currentMessages = [];
    currentEntries = [];
  };

  for (const entry of messages) {
    if (!isAssistantMessage(entry.info)) {
      flush();
      continue;
    }

    const assistant = entry.info as AssistantMessage;
    currentMessages.push(assistant);
    currentEntries.push(entry);
  }

  flush();
  return result;
}

function AssistantDialogSummary(props: {
  summary: AssistantDialogSummaryInfo;
  showImplementPlanAction?: boolean;
  onImplementPlan?: () => void;
  onSkipPlan?: () => void;
}) {
  const agentSuffix =
    props.summary.agentCount > 0 ? ` - Agents ${formatNumber(props.summary.agentCount)}` : '';

  return (
    <div class="model-change-indicator assistant-dialog-summary">
      <div class="assistant-dialog-summary-content">
        <span class="model-change-label">
          {`Worked for ${formatDuration(props.summary.durationMs)} - Tokens ↑ ${formatNumber(props.summary.inputTokens)} | ↓ ${formatNumber(props.summary.outputTokens)}${agentSuffix}`}
        </span>
      </div>
      <Show when={props.showImplementPlanAction}>
        <div class="assistant-dialog-summary-actions">
          <button
            type="button"
            class="assistant-dialog-summary-action assistant-dialog-summary-action-implement"
            disabled={isLoading()}
            onClick={() => props.onImplementPlan?.()}
          >
            Implement the plan
          </button>
          <button
            type="button"
            class="assistant-dialog-summary-action assistant-dialog-summary-action-secondary"
            onClick={() => props.onSkipPlan?.()}
          >
            Skip for now
          </button>
        </div>
      </Show>
    </div>
  );
}

function isFileEditOnlyAssistantMessage(
  parts: Part[],
  previousTrailingSignature: string | null
): boolean {
  const visibleParts = collapseLeadingDuplicateFileEvents(parts, previousTrailingSignature).filter(
    (p) => shouldShowAssistantPartInline(p, false)
  );
  return visibleParts.length > 0 && visibleParts.every(isFileEditPart);
}

function isFileReadOnlyAssistantMessage(
  parts: Part[],
  previousTrailingSignature: string | null
): boolean {
  const visibleParts = collapseLeadingDuplicateFileEvents(parts, previousTrailingSignature).filter(
    (p) => shouldShowAssistantPartInline(p, false)
  );
  return visibleParts.length > 0 && visibleParts.every(isFileReadPart);
}

function getAssistantStackKind(
  msg: { info: Message; parts: Part[] },
  previousTrailingSignature: string | null
): 'file-edit' | 'file-read' | null {
  if (!isAssistantMessage(msg.info)) return null;
  if (isFileEditOnlyAssistantMessage(msg.parts, previousTrailingSignature)) return 'file-edit';
  if (isFileReadOnlyAssistantMessage(msg.parts, previousTrailingSignature)) return 'file-read';
  return null;
}

function LoadingRow(props: { compacting: boolean }) {
  const [now, setNow] = createSignal(Date.now());
  const STALE_TOTAL_THRESHOLD_MS = 90_000;
  const STALE_INACTIVITY_THRESHOLD_MS = 60_000;

  const isStale = () => {
    const startedAt = loadingStartedAt();
    if (!startedAt) return false;
    const total = Date.now() - startedAt;
    if (total < STALE_TOTAL_THRESHOLD_MS) return false;
    const lastActivity = loadingLastActivityAt() ?? startedAt;
    return Date.now() - lastActivity >= STALE_INACTIVITY_THRESHOLD_MS;
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
    return startedAt ? Math.max(0, now() - startedAt) : 0;
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
