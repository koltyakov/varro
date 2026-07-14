import { For, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { formatNumber } from '../../lib/message-metrics';
import { formatModelName } from '../../lib/format';
import {
  alignPopupToBoundary,
  clampPopupToViewport,
  flipPopupDownIfNeeded,
  observePopupViewport,
} from '../../lib/popup-position';

const CONTEXT_USAGE_WARNING_PERCENT = 70;
const CONTEXT_USAGE_ERROR_PERCENT = 90;

type ContextTokens = {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

function getTokenRows(tokens: ContextTokens) {
  const items: Array<{ label: string; value: number }> = [
    { label: 'Input', value: tokens.input },
    { label: 'Output', value: tokens.output },
  ];
  if (tokens.reasoning > 0) items.push({ label: 'Reasoning', value: tokens.reasoning });
  if (tokens.cacheRead > 0) items.push({ label: 'Cache read', value: tokens.cacheRead });
  if (tokens.cacheWrite > 0) items.push({ label: 'Cache write', value: tokens.cacheWrite });
  return items;
}

export function ContextPopup(props: {
  ref?: HTMLDivElement | ((el: HTMLDivElement) => void);
  boundaryRef?: HTMLElement;
  alignTo?: 'left' | 'right';
  usage: { used: number; limit: number; percent: number };
  tokens: ContextTokens;
  subagentTokens: ContextTokens;
  subagentCount: number;
  model: { providerName: string; modelName: string };
  compactDisabled: boolean;
  onClose: () => void;
  onCompact: () => void;
}) {
  const [subagentsExpanded, setSubagentsExpanded] = createSignal(false);
  const overallTotal = () => props.tokens.total + props.subagentTokens.total;
  let popupEl: HTMLDivElement | undefined;

  const setRef = (el: HTMLDivElement) => {
    popupEl = el;
    const forwarded = props.ref;
    if (typeof forwarded === 'function') forwarded(el);
  };

  onMount(() => {
    if (!popupEl || !props.boundaryRef) return;

    const reposition = () => {
      if (!popupEl || !props.boundaryRef) return;
      flipPopupDownIfNeeded(popupEl);
      alignPopupToBoundary(popupEl, props.boundaryRef, props.alignTo ?? 'right');
      clampPopupToViewport(popupEl);
    };

    onCleanup(observePopupViewport(popupEl, reposition));
  });

  return (
    <div ref={setRef} class="context-popup" onClick={(e) => e.stopPropagation()}>
      <div class="context-popup-header">
        <span class="context-popup-title">Context Window</span>
        <span class="context-popup-pct">{Math.round(props.usage.percent)}%</span>
      </div>

      <div class="context-popup-bar">
        <div
          class={`context-popup-bar-fill ${getContextUsageTone(props.usage.percent)}`}
          style={{ width: `${Math.min(props.usage.percent, 100)}%` }}
        />
      </div>

      <div class="context-popup-stat">
        <span>{formatNumber(props.usage.used)}</span>
        <span class="context-popup-sep">/</span>
        <span>{formatNumber(props.usage.limit)}</span>
        <span class="context-popup-unit">tokens</span>
      </div>

      <Show when={props.tokens.total > 0}>
        <div class="context-popup-section">Session Tokens</div>
        <div class="context-popup-rows">
          <For each={getTokenRows(props.tokens)}>
            {(row) => (
              <div class="context-popup-row">
                <span class="context-popup-row-label">{row.label}</span>
                <span class="context-popup-row-value">{formatNumber(row.value)}</span>
              </div>
            )}
          </For>
          <div class="context-popup-row context-popup-row-total">
            <span class="context-popup-row-label">Total</span>
            <span class="context-popup-row-value">{formatNumber(props.tokens.total)}</span>
          </div>
        </div>
      </Show>

      <Show when={props.subagentTokens.total > 0}>
        <button
          type="button"
          class="context-popup-section context-popup-section-toggle"
          aria-expanded={subagentsExpanded()}
          onClick={() => setSubagentsExpanded((expanded) => !expanded)}
        >
          <span>Agents{props.subagentCount > 0 ? ` (${props.subagentCount})` : ''}</span>
          <svg
            class={`context-popup-section-chevron${subagentsExpanded() ? ' expanded' : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="10"
            height="10"
            aria-hidden="true"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
          <Show when={!subagentsExpanded()}>
            <span class="context-popup-section-summary">
              {formatNumber(props.subagentTokens.total)}
            </span>
          </Show>
        </button>
        <Show when={subagentsExpanded()}>
          <div class="context-popup-rows context-popup-subagent-rows">
            <For each={getTokenRows(props.subagentTokens)}>
              {(row) => (
                <div class="context-popup-row">
                  <span class="context-popup-row-label">{row.label}</span>
                  <span class="context-popup-row-value">{formatNumber(row.value)}</span>
                </div>
              )}
            </For>
            <div class="context-popup-row context-popup-row-total">
              <span class="context-popup-row-label">Total</span>
              <span class="context-popup-row-value">
                {formatNumber(props.subagentTokens.total)}
              </span>
            </div>
          </div>
        </Show>
        <div class="context-popup-row context-popup-overall-total">
          <span class="context-popup-row-label">Overall</span>
          <span class="context-popup-row-value">{formatNumber(overallTotal())}</span>
        </div>
      </Show>

      <Show when={shouldShowContextCompact(props.usage.percent)}>
        <div class="context-popup-actions">
          <button
            type="button"
            class="context-popup-action"
            disabled={props.compactDisabled}
            onClick={() => {
              props.onClose();
              props.onCompact();
            }}
          >
            Compact session
          </button>
        </div>
      </Show>

      <Show when={props.model.modelName}>
        <div class="context-popup-model">
          {props.model.providerName} / {formatModelName(props.model.modelName)}
        </div>
      </Show>
    </div>
  );
}

export function ContextUsageButton(props: {
  ref?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  percent: number;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      ref={props.ref}
      class={`chat-context-usage ${getContextUsageTone(props.percent)}`}
      onClick={props.onClick}
      title={props.title}
      aria-label={formatContextUsageTitle(props.percent)}
    >
      <svg class="circular-progress" viewBox="0 0 36 36">
        <circle class="progress-bg" cx="18" cy="18" r="14" />
        <circle
          class="progress-arc"
          cx="18"
          cy="18"
          r="14"
          stroke-dasharray="87.96"
          stroke-dashoffset={`${87.96 - (props.percent / 100) * 87.96}`}
        />
      </svg>
    </button>
  );
}

export function getContextUsageTone(percent: number) {
  if (percent >= CONTEXT_USAGE_ERROR_PERCENT) return 'error';
  if (percent >= CONTEXT_USAGE_WARNING_PERCENT) return 'warning';
  return '';
}

export function formatContextUsageTitle(percent: number) {
  return `Context usage (${Math.round(percent)}%)`;
}

function shouldShowContextCompact(percent: number) {
  return percent >= CONTEXT_USAGE_WARNING_PERCENT;
}
