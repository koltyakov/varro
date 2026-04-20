import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  state,
  isLoading,
  setIsLoading,
  hasActiveQuestion,
  hasActivePermission,
} from '../lib/state';
import { isAssistantMessage } from '../lib/message-metrics';
import { Message } from './Message';
import { recheckSessionStatus } from '../hooks/useOpenCode';
import type { AssistantMessage } from '../types';
import { formatThinkingLabel, modelSupportsReasoning } from './ModelPicker';

const emptyStateLogoUrl = new URL('../../../assets/icon.png', import.meta.url).href;

export function MessageList() {
  // oxlint-disable-next-line no-unassigned-vars
  let containerRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let trackRef: HTMLDivElement | undefined;
  const [autoScroll, setAutoScroll] = createSignal(true);
  const visibleMessages = createMemo(() => state.messages);
  const lastAssistantID = createMemo(() => {
    const msgs = visibleMessages();
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
  const SCROLL_INTERVAL_MS = 700;
  const AUTO_SCROLL_THRESHOLD_PX = 60;
  const PROGRAMMATIC_SCROLL_WINDOW_MS = 200;

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

    if (now <= ignoreScrollUntil) return;

    expectedScrollTop = -1;
    if (near) {
      setAutoScroll(true);
      return;
    }

    // Content growth can emit scroll events while the user is still pinned to the bottom.
    // Only treat movement away from the bottom as intent when the viewport actually moved up.
    if (autoScroll() && delta >= 0) return;

    cancelPendingScroll();
    setAutoScroll(false);
  }

  onMount(() => {
    if (!trackRef) return;
    lastObservedScrollTop = containerRef?.scrollTop ?? 0;
    const observer = new ResizeObserver(() => scrollToBottom());
    observer.observe(trackRef);
    onCleanup(() => {
      observer.disconnect();
      if (scrollTimer) clearTimeout(scrollTimer);
    });
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

  return (
    <div
      ref={containerRef}
      class="interactive-list min-h-0 flex-1 overflow-y-auto"
      onScroll={onScroll}
    >
      <div ref={trackRef} class="interactive-list-track">
        <Show
          when={visibleMessages().length > 0}
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
          <For each={visibleMessages()}>
            {(msg, index) => {
              const modelChange = createMemo(() => {
                if (!isAssistantMessage(msg.info)) return null;
                const cur = msg.info as AssistantMessage;
                if (cur.mode === 'subagent') return null;
                const msgs = visibleMessages();
                for (let i = index() - 1; i >= 0; i--) {
                  if (!isAssistantMessage(msgs[i].info)) continue;
                  const prev = msgs[i].info as AssistantMessage;
                  if (prev.mode === 'subagent') continue;
                  const modelChanged =
                    prev.providerID !== cur.providerID || prev.modelID !== cur.modelID;
                  const variantChanged = (prev.variant || '') !== (cur.variant || '');
                  if (!modelChanged && !variantChanged) return null;
                  const provider = state.providers.find((p) => p.id === cur.providerID);
                  const modelName = provider?.models[cur.modelID]?.name || cur.modelID;
                  const parts: string[] = [];
                  if (modelChanged) parts.push(modelName);
                  if (cur.variant) parts.push(formatThinkingLabel(cur.variant));
                  else if (
                    variantChanged &&
                    !modelSupportsReasoning(cur.providerID, cur.modelID, state.providers)
                  )
                    parts.push('No thinking');
                  return parts.join(' · ');
                }
                return null;
              });

              return (
                <>
                  <Show when={modelChange()}>
                    <div class="model-change-indicator">
                      <span class="model-change-label">Switched to {modelChange()}</span>
                    </div>
                  </Show>
                  <div
                    class={`interactive-item-container ${
                      msg.info.role === 'user' ? 'interactive-request' : 'interactive-response'
                    }`}
                  >
                    <Message
                      info={msg.info}
                      parts={msg.parts}
                      isLastAssistant={msg.info.id === lastAssistantID()}
                    />
                  </div>
                </>
              );
            }}
          </For>
        </Show>
        <Show
          when={
            isLoading() && !hasActiveQuestion() && !hasActivePermission() && !state.streamingPartId
          }
        >
          <LoadingRow />
        </Show>
      </div>
    </div>
  );
}

function LoadingRow() {
  const [elapsed, setElapsed] = createSignal(0);
  const STALE_THRESHOLD = 30;

  const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
  onCleanup(() => clearInterval(timer));

  // Reset elapsed when loading restarts (new message parts arrive)
  createEffect(() => {
    let hasParts = false;
    state.messages.forEach((m) =>
      m.parts.forEach((p) => {
        hasParts = true;
        if ('text' in p) void (p as { text: string }).text.length;
      })
    );
    if (hasParts) setElapsed(0);
  });

  const isStale = () => elapsed() >= STALE_THRESHOLD;

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
  const verb = () => verbs[Math.floor(elapsed() / 3) % verbs.length];

  const formatElapsed = () => {
    const s = elapsed();
    if (s < 10) return null;
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem.toString().padStart(2, '0')}s`;
  };

  return (
    <div class="interactive-item-container interactive-response interactive-loading-row">
      <div class={`loading-indicator ${isStale() ? 'stale' : ''}`}>
        <Show
          when={isStale()}
          fallback={
            <span class="shimmer-progress loading-verb">
              {verb()}
              <span class="chat-animated-ellipsis" />
            </span>
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
            onClick={() => setIsLoading(false)}
            title="Dismiss loading indicator"
          >
            Dismiss
          </button>
        </Show>
      </div>
    </div>
  );
}
