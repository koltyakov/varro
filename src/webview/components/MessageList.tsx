import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  state,
  isLoading,
  stopLoading,
  hasActiveQuestion,
  hasActivePermission,
  isSessionCompacting,
  loadingStartedAt,
  loadingLastActivityAt,
} from '../lib/state';
import { isAssistantMessage } from '../lib/message-metrics';
import type { AssistantMessage, Message, Part } from '../types';
import { Message as MessageComponent, type AssistantFileEditStackGroup } from './Message';
import { recheckSessionStatus } from '../hooks/useOpenCode';
import { formatThinkingLabel, modelSupportsReasoning } from './ModelPicker';
import {
  collapseLeadingDuplicateFileEvents,
  getTrailingFileEventSignature,
} from '../lib/message-event-collapse';
import { getToolFileChange, getToolReadPath } from '../lib/tool-file-change';

const emptyStateLogoUrl = new URL('../../../assets/icon.png', import.meta.url).href;

const DEFAULT_ITEM_HEIGHT = 120;
const OVERSCAN = 5;
const VIRTUALIZE_THRESHOLD = 50;

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
  const SCROLL_INTERVAL_MS = 700;
  const INITIAL_SCROLL_MAX_FRAMES = 30;
  const INITIAL_SCROLL_STABLE_FRAMES = 3;
  const AUTO_SCROLL_THRESHOLD_PX = 60;
  const PROGRAMMATIC_SCROLL_WINDOW_MS = 200;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [measurementVersion, setMeasurementVersion] = createSignal(0);

  const messages = createMemo(() => state.messages);

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
    setViewportHeight(containerRef.clientHeight);
    setScrollTop(containerRef.scrollTop);
    lastObservedScrollTop = containerRef.scrollTop ?? 0;
    if (!trackRef) return;
    lastTrackHeight = trackRef.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const previousTrackHeight = lastTrackHeight;
      measureVisibleItems();
      lastTrackHeight = trackRef?.getBoundingClientRect().height ?? previousTrackHeight;
      if (lastTrackHeight > previousTrackHeight + 1) {
        scrollToBottom();
      }
    });
    observer.observe(trackRef);
    onCleanup(() => {
      observer.disconnect();
      if (scrollTimer) clearTimeout(scrollTimer);
      if (initialScrollRafId) cancelAnimationFrame(initialScrollRafId);
    });
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    pendingInitialScrollSessionId = sessionId;
    cancelPendingScroll();
    expectedScrollTop = -1;
    ignoreScrollUntil = 0;
    setAutoScroll(true);
    queueMicrotask(() => performScroll());
  });

  createEffect(() => {
    const sessionId = state.activeSessionId;
    const msgs = messages();
    if (msgs.length === 0) return;
    queueMicrotask(() => {
      measureVisibleItems();
      lastTrackHeight = trackRef?.getBoundingClientRect().height ?? lastTrackHeight;
      if (sessionId && pendingInitialScrollSessionId === sessionId) {
        pendingInitialScrollSessionId = null;
        performScroll();
        scrollToBottomUntilStable(sessionId);
      }
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
    const msgs = state.messages;
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
        if (cur.variant) parts.push(formatThinkingLabel(cur.variant));
        else if (
          variantChanged &&
          !modelSupportsReasoning(cur.providerID, cur.modelID, state.providers)
        )
          parts.push('No thinking');
        result.set(msg.info.id, parts.join(' · '));
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

  const assistantStackGroupMap = createMemo(() => {
    const result = new Map<string, AssistantFileEditStackGroup | null>();
    let index = 0;

    while (index < state.messages.length) {
      const current = state.messages[index];
      const currentKind = getAssistantStackKind(
        current,
        previousTrailingFileEventSignatureMap().get(current.info.id) ?? null
      );

      if (!currentKind) {
        index++;
        continue;
      }

      let end = index;
      while (end + 1 < state.messages.length) {
        const next = state.messages[end + 1];
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
          result.set(state.messages[partIndex].info.id, position);
        }
      }

      index = end + 1;
    }

    return result;
  });

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
        <Show
          when={state.messages.length > 0}
          fallback={
            <div class="chat-empty-state">
              <img
                class="chat-empty-logo"
                src={emptyStateLogoUrl}
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
              <For each={state.messages}>
                {(msg) => {
                  const changeLabel = modelChangeMap().get(msg.info.id) ?? null;
                  return (
                    <div
                      data-msg-id={msg.info.id}
                      class={`interactive-item-container ${
                        msg.info.role === 'user' ? 'interactive-request' : 'interactive-response'
                      } ${
                        assistantStackGroupMap().get(msg.info.id)
                          ? `interactive-response-file-edit-group interactive-response-file-edit-group-${assistantStackGroupMap().get(msg.info.id)}`
                          : ''
                      }`}
                    >
                      <Show when={changeLabel}>
                        <div class="model-change-indicator">
                          <span class="model-change-label">Switched to {changeLabel}</span>
                        </div>
                      </Show>
                      <MessageComponent
                        info={msg.info}
                        parts={msg.parts}
                        isLastAssistant={msg.info.id === lastAssistantID()}
                        previousTrailingFileEventSignature={
                          previousTrailingFileEventSignatureMap().get(msg.info.id) ?? null
                        }
                        fileEditStackGroup={assistantStackGroupMap().get(msg.info.id) ?? null}
                      />
                    </div>
                  );
                }}
              </For>
            }
          >
            <VirtualizedContent
              messages={messages()}
              modelChangeMap={modelChangeMap()}
              lastAssistantID={lastAssistantID()}
              previousTrailingFileEventSignatureMap={previousTrailingFileEventSignatureMap()}
              fileEditStackGroupMap={assistantStackGroupMap()}
              visibleRange={visibleRange()}
            />
          </Show>
        </Show>
        <Show
          when={
            (isLoading() || isSessionCompacting()) &&
            !hasActiveQuestion() &&
            !hasActivePermission() &&
            !state.streamingPartId
          }
        >
          <LoadingRow compacting={isSessionCompacting()} />
        </Show>
      </div>
    </div>
  );
}

function VirtualizedContent(props: {
  messages: Array<{ info: Message; parts: Part[] }>;
  modelChangeMap: Map<string, string>;
  lastAssistantID: string | null;
  previousTrailingFileEventSignatureMap: Map<string, string | null>;
  fileEditStackGroupMap: Map<string, AssistantFileEditStackGroup | null>;
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
      <For each={visible()}>
        {(msg) => {
          const changeLabel = props.modelChangeMap.get(msg.info.id) ?? null;
          return (
            <div
              data-msg-id={msg.info.id}
              class={`interactive-item-container ${
                msg.info.role === 'user' ? 'interactive-request' : 'interactive-response'
              } ${
                props.fileEditStackGroupMap.get(msg.info.id)
                  ? `interactive-response-file-edit-group interactive-response-file-edit-group-${props.fileEditStackGroupMap.get(msg.info.id)}`
                  : ''
              }`}
            >
              <Show when={changeLabel}>
                <div class="model-change-indicator">
                  <span class="model-change-label">Switched to {changeLabel}</span>
                </div>
              </Show>
              <MessageComponent
                info={msg.info}
                parts={msg.parts}
                isLastAssistant={msg.info.id === props.lastAssistantID}
                previousTrailingFileEventSignature={
                  props.previousTrailingFileEventSignatureMap.get(msg.info.id) ?? null
                }
                fileEditStackGroup={props.fileEditStackGroupMap.get(msg.info.id) ?? null}
              />
            </div>
          );
        }}
      </For>
      <Show when={props.visibleRange.bottomPad > 0}>
        <div style={{ height: `${props.visibleRange.bottomPad}px` }} />
      </Show>
    </>
  );
}

function isFileEditPart(part: Part): boolean {
  return part.type === 'tool' && getToolFileChange(part.tool, part.state) !== null;
}

function isFileReadPart(part: Part): boolean {
  return part.type === 'tool' && getToolReadPath(part.tool, part.state) !== null;
}

function isTodoToolPart(part: Extract<Part, { type: 'tool' }>) {
  const toolName = part.tool.trim().toLowerCase();
  if (
    toolName.includes('todo') ||
    toolName === 'update_plan' ||
    toolName === 'updateplan' ||
    toolName === 'todowrite'
  ) {
    return true;
  }

  const title =
    (part.state.status === 'running' || part.state.status === 'completed'
      ? part.state.title
      : undefined) || '';
  const normalizedTitle = title.trim().toLowerCase();
  return (
    normalizedTitle.includes('todo') ||
    normalizedTitle === 'update plan' ||
    normalizedTitle === 'updating plan'
  );
}

function shouldShowAssistantPartInline(part: Part) {
  if (part.type === 'tool') return !isTodoToolPart(part);

  switch (part.type) {
    case 'text':
      return part.text.trim().length > 0;
    case 'reasoning':
    case 'agent':
    case 'retry':
    case 'compaction':
    case 'subtask':
    case 'file':
      return true;
    default:
      return false;
  }
}

function isFileEditOnlyAssistantMessage(
  parts: Part[],
  previousTrailingSignature: string | null
): boolean {
  const visibleParts = collapseLeadingDuplicateFileEvents(parts, previousTrailingSignature).filter(
    shouldShowAssistantPartInline
  );
  return visibleParts.length > 0 && visibleParts.every(isFileEditPart);
}

function isFileReadOnlyAssistantMessage(
  parts: Part[],
  previousTrailingSignature: string | null
): boolean {
  const visibleParts = collapseLeadingDuplicateFileEvents(parts, previousTrailingSignature).filter(
    shouldShowAssistantPartInline
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
