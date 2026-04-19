import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { state, isLoading, setIsLoading, hasActiveQuestion } from '../lib/state';
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
  const SCROLL_INTERVAL_MS = 700;

  function performScroll() {
    if (!containerRef) return;
    const target = containerRef.scrollHeight - containerRef.clientHeight;
    expectedScrollTop = target;
    containerRef.scrollTop = target;
    lastScrollAt = performance.now();
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
    if (expectedScrollTop !== -1 && Math.abs(containerRef.scrollTop - expectedScrollTop) < 2) {
      expectedScrollTop = -1;
      return;
    }
    expectedScrollTop = -1;
    const near =
      containerRef.scrollHeight - containerRef.scrollTop - containerRef.clientHeight < 60;
    if (!near) cancelPendingScroll();
    setAutoScroll(near);
  }

  onMount(() => {
    if (!trackRef) return;
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
                  const modelChanged = prev.providerID !== cur.providerID || prev.modelID !== cur.modelID;
                  const variantChanged = (prev.variant || '') !== (cur.variant || '');
                  if (!modelChanged && !variantChanged) return null;
                  const provider = state.providers.find((p) => p.id === cur.providerID);
                  const modelName = provider?.models[cur.modelID]?.name || cur.modelID;
                  const parts: string[] = [];
                  if (modelChanged) parts.push(modelName);
                  if (cur.variant) parts.push(formatThinkingLabel(cur.variant));
                  else if (variantChanged && !modelSupportsReasoning(cur.providerID, cur.modelID, state.providers)) parts.push('No thinking');
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
                    <Message info={msg.info} parts={msg.parts} isLastAssistant={msg.info.id === lastAssistantID()} />
                  </div>
                </>
              );
            }}
          </For>
        </Show>
        <Show when={isLoading() && !hasActiveQuestion() && !state.streamingPartId}>
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
    // Track the latest part count to detect new activity
    const partCount = state.messages.reduce((sum, m) => sum + m.parts.length, 0);
    if (partCount) setElapsed(0);
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
        <Show when={isStale()} fallback={
          <span class="shimmer-progress loading-verb">
            {verb()}
            <span class="chat-animated-ellipsis" />
          </span>
        }>
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
