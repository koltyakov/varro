import { For, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { formatCost, formatNumber } from '../../lib/message-metrics';
import {
  alignPopupToBoundary,
  clampPopupToViewport,
  flipPopupDownIfNeeded,
  observePopupViewport,
} from '../../lib/popup-position';
import type {
  ContextBreakdownKey,
  ContextBreakdownSegment,
} from '../../../shared/context-breakdown';
import { Tooltip } from '../Tooltip';

const CONTEXT_USAGE_WARNING_PERCENT = 70;
const CONTEXT_USAGE_ERROR_PERCENT = 90;

const BREAKDOWN_LABELS: Record<ContextBreakdownKey, string> = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool Calls',
  other: 'Other',
};

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
  breakdown: ContextBreakdownSegment[];
  nestedBreakdown: ContextBreakdownSegment[];
  tokens: ContextTokens;
  cost?: number | null;
  subagentTokens: ContextTokens;
  subagentCount: number;
  model: { providerName: string; modelName: string };
  compactDisabled: boolean;
  showCompactAction?: boolean;
  onClose: () => void;
  onCompact: () => void;
}) {
  const [subagentsExpanded, setSubagentsExpanded] = createSignal(false);
  const [nestedBreakdown, setNestedBreakdown] = createSignal(true);
  const visibleBreakdown = () =>
    nestedBreakdown() && props.nestedBreakdown.length > 0 ? props.nestedBreakdown : props.breakdown;
  const contextUsageAvailable = () => props.usage.used > 0;
  const sessionTokensAvailable = () => props.tokens.total > 0;
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
        <span class={`context-popup-pct${contextUsageAvailable() ? '' : ' unavailable'}`}>
          {contextUsageAvailable() ? `${Math.round(props.usage.percent)}%` : '--'}
        </span>
      </div>

      <div class="context-popup-bar">
        <div
          class={`context-popup-bar-fill ${getContextUsageTone(props.usage.percent)}`}
          style={{ width: `${Math.min(props.usage.percent, 100)}%` }}
        />
      </div>

      <div class="context-popup-stat">
        <span class={`context-popup-stat-value${contextUsageAvailable() ? '' : ' unavailable'}`}>
          {contextUsageAvailable() ? formatNumber(props.usage.used) : '--'}
        </span>
        <span class="context-popup-sep">/</span>
        <span>{formatNumber(props.usage.limit)}</span>
        <span class="context-popup-unit">tokens</span>
      </div>

      <div class="context-popup-section">Session Tokens</div>
      <div class="context-popup-rows">
        <For each={getTokenRows(props.tokens)}>
          {(row) => (
            <div class="context-popup-row">
              <span class="context-popup-row-label">{row.label}</span>
              <span
                class={`context-popup-row-value${sessionTokensAvailable() ? '' : ' unavailable'}`}
              >
                {sessionTokensAvailable() ? formatNumber(row.value) : '--'}
              </span>
            </div>
          )}
        </For>
        <div class="context-popup-row context-popup-row-total">
          <span class="context-popup-row-label">Total</span>
          <span class={`context-popup-row-value${sessionTokensAvailable() ? '' : ' unavailable'}`}>
            {sessionTokensAvailable() ? formatNumber(props.tokens.total) : '--'}
          </span>
        </div>
        <Show when={formatCost(props.cost ?? undefined)}>
          {(cost) => (
            <div class="context-popup-row context-popup-cost-row">
              <span class="context-popup-row-label">Cost</span>
              <span class="context-popup-row-value">{cost()}</span>
            </div>
          )}
        </Show>
      </div>

      <Show when={visibleBreakdown().length > 0}>
        <div class="context-popup-breakdown-header">
          <div class="context-popup-breakdown-title">Context Breakdown</div>
          <Show when={props.subagentCount > 0 && props.nestedBreakdown.length > 0}>
            <label class="context-breakdown-nested">
              <input
                type="checkbox"
                checked={nestedBreakdown()}
                onChange={(event) => setNestedBreakdown(event.currentTarget.checked)}
              />
              <svg
                class="context-breakdown-checkbox context-breakdown-checkbox-unchecked"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M21 3.6V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4V3.6C3 3.26863 3.26863 3 3.6 3H20.4C20.7314 3 21 3.26863 21 3.6Z"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <svg
                class="context-breakdown-checkbox context-breakdown-checkbox-checked"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M3 20.4V3.6C3 3.26863 3.26863 3 3.6 3H20.4C20.7314 3 21 3.26863 21 3.6V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4Z"
                  stroke="currentColor"
                  stroke-width="1.6"
                />
                <path
                  d="M7 12.5L10 15.5L17 8.5"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span>nested</span>
            </label>
          </Show>
        </div>
        <div class="context-breakdown-bar" aria-label="Estimated context breakdown">
          <For each={visibleBreakdown()}>
            {(segment) => (
              <div
                class={`context-breakdown-segment ${segment.key}`}
                style={{ width: `${segment.percent}%` }}
              />
            )}
          </For>
        </div>
        <div class="context-breakdown-legend">
          <For each={visibleBreakdown()}>
            {(segment) => (
              <div class="context-breakdown-item">
                <span class={`context-breakdown-dot ${segment.key}`} />
                <span>{BREAKDOWN_LABELS[segment.key]}</span>
                <span class="context-breakdown-percent">{segment.percent.toFixed(1)}%</span>
              </div>
            )}
          </For>
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

      <Show
        when={props.showCompactAction !== false && shouldShowContextCompact(props.usage.percent)}
      >
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
          {props.model.providerName} / {props.model.modelName}
        </div>
      </Show>
    </div>
  );
}

export function ContextUsageButton(props: {
  ref?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  percent: number;
  available: boolean;
  title?: string;
  onClick: () => void;
}) {
  const label = () => formatContextUsageTitle(props.percent, props.available);

  return (
    <Tooltip content={props.title ?? label()} disabled={!props.title}>
      <button
        ref={props.ref}
        class={`chat-context-usage ${getContextUsageTone(props.percent)}`}
        onClick={props.onClick}
        aria-label={label()}
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
    </Tooltip>
  );
}

export function getContextUsageTone(percent: number) {
  if (percent >= CONTEXT_USAGE_ERROR_PERCENT) return 'error';
  if (percent >= CONTEXT_USAGE_WARNING_PERCENT) return 'warning';
  return '';
}

export function formatContextUsageTitle(percent: number, available = true) {
  return available ? `Context usage (${Math.round(percent)}%)` : 'Context usage unavailable';
}

function shouldShowContextCompact(percent: number) {
  return percent >= CONTEXT_USAGE_WARNING_PERCENT;
}
