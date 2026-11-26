import { ariaBoolean } from '../../lib/aria';
import { For, createSignal, onSettled, Show } from 'solid-js';
import {
  checkSquareIcon,
  databaseBackupIcon,
  databaseScriptPlusIcon,
  infoCircleIcon,
  navArrowRightIcon,
  squareIcon,
  reportsIcon,
} from '../../lib/ui-icons';
import { formatCost, formatNumber, formatTokenCount } from '../../lib/message-metrics';
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
import { UiIcon } from '../UiIcon';
import { isFunction } from '../../lib/runtime-values';
import { useSecondClock } from '../../lib/clock';
import { formatDuration } from '../../lib/time-format';
import type { PromptCacheWarmingSession } from '../../../shared/protocol';

const CONTEXT_USAGE_WARNING_PERCENT = 70;
const CONTEXT_USAGE_ERROR_PERCENT = 90;
const CONTEXT_COMPACT_ACTION_PERCENT = 30;
const CACHE_READ_TOOLTIP =
  "Tokens reused from the provider's prompt cache. They count toward the context window but are excluded from session totals.";
/** Common provider default; Anthropic and OpenAI both keep an idle prompt cache about this long. */
export const PROMPT_CACHE_TTL_ESTIMATE_MS = 5 * 60_000;
const PROMPT_CACHE_TOOLTIP =
  "Estimated from the last response that read or wrote the provider's prompt cache. Most providers keep it about 5 minutes after the last request, some longer. Sending while it is warm is usually cheaper and faster.";
const CACHE_WRITE_TOOLTIP =
  "Tokens stored in the provider's prompt cache for reuse by later requests. They count toward session input and totals.";

type ContextBreakdownLabels = Record<ContextBreakdownKey, string>;

const BREAKDOWN_LABELS = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool Calls',
  other: 'Other',
} satisfies ContextBreakdownLabels;

type ContextTokens = {
  cost?: number;
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ContextPopupModel = { providerName: string; modelName: string };

/** When the session's latest completed response last used the prompt cache. */
export type PromptCacheActivity = { lastUsedAt: number; inUse: boolean };

/** Keep-alive state for the composer's root session; absent when warming is off or unavailable. */
export type PromptCacheWarmingView =
  | { kind: 'opencode' }
  | {
      kind: 'chosen';
      enabled: boolean;
      session: PromptCacheWarmingSession | null;
      intervalMs: number;
      durationMs: number;
    };

const PROMPT_CACHE_WARMING_TOOLTIP =
  "Sends a short keep-alive with the whole session context just before the provider's cache would expire, for a while after each reply. Each keep-alive re-reads the context from the cache, which costs money or subscription quota. With typical pricing, about twelve keep-alives cost as much as re-sending the context once uncached, so long windows only pay off if you come back soon.";

type ContextTokenRow = {
  key: 'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite';
  label: string;
  value: number;
};

function getSessionInputTokens(tokens: ContextTokens) {
  return tokens.input + tokens.cacheWrite;
}

function getSessionOutputTokens(tokens: ContextTokens) {
  return tokens.output + tokens.reasoning;
}

function getSessionTotalTokens(tokens: ContextTokens) {
  return getSessionInputTokens(tokens) + getSessionOutputTokens(tokens);
}

function getTokenRows(tokens: ContextTokens): ContextTokenRow[] {
  const items: ContextTokenRow[] = [
    { key: 'input', label: 'Input', value: getSessionInputTokens(tokens) },
    { key: 'output', label: 'Output', value: getSessionOutputTokens(tokens) },
  ];
  if (tokens.reasoning > 0) {
    items.push({ key: 'reasoning', label: 'Reasoning', value: tokens.reasoning });
  }
  if (tokens.cacheRead > 0) {
    items.push({ key: 'cacheRead', label: 'Cache read', value: tokens.cacheRead });
  }
  if (tokens.cacheWrite > 0) {
    items.push({ key: 'cacheWrite', label: 'Cache write', value: tokens.cacheWrite });
  }
  return items;
}

function formatCountdown(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function PromptCacheRow(props: { activity: PromptCacheActivity }) {
  const now = useSecondClock(() => !props.activity.inUse);
  const remaining = () => props.activity.lastUsedAt + PROMPT_CACHE_TTL_ESTIMATE_MS - now();
  const status = () => {
    if (props.activity.inUse) return { tone: 'warm', text: 'In use', countdown: '' };
    const left = remaining();
    return left > 0
      ? { tone: 'warm', text: 'Warm', countdown: formatCountdown(left) }
      : { tone: 'cold', text: 'Likely expired', countdown: '' };
  };

  return (
    <div class="context-popup-row context-popup-prompt-cache" data-tone={status().tone}>
      <span class="context-popup-row-label">
        Prompt cache
        <Tooltip content={PROMPT_CACHE_TOOLTIP}>
          <span class="context-popup-cost-info" tabindex="0" aria-label="Prompt cache estimate">
            <UiIcon source={infoCircleIcon} width="11" height="11" />
          </span>
        </Tooltip>
      </span>
      <span class="context-popup-row-value">
        {status().text}
        <Show when={status().countdown}>
          {(countdown) => <span class="context-popup-prompt-cache-countdown">{countdown()}</span>}
        </Show>
      </span>
    </div>
  );
}

type WarmingDescription = { status: string; detail: string | null };

function describeWarming(
  view: Extract<PromptCacheWarmingView, { kind: 'chosen' }>,
  contextTokens: number,
  now: number
): WarmingDescription {
  const session = view.session;
  if (!view.enabled || !session) {
    const tokens = contextTokens > 0 ? `~${formatTokenCount(contextTokens)}` : 'the';
    return {
      status: 'Off',
      detail: `Re-reads ${tokens} cached tokens every ${Math.round(view.intervalMs / 60_000)} min while on`,
    };
  }
  if (session.stopped === 'cache-miss') {
    return { status: 'Stopped', detail: 'The cache had already expired' };
  }
  if (session.stopped === 'failed') return { status: 'Stopped', detail: 'A keep-alive failed' };
  if (session.warmUntil === null) return { status: 'After reply', detail: null };
  if (session.stopped === 'expired' || session.warmUntil <= now) {
    return { status: 'Ended', detail: 'Restarts after the next reply' };
  }
  return {
    status: `${formatDuration(Math.ceil((session.warmUntil - now) / 60_000) * 60_000)} left`,
    detail: null,
  };
}

function PromptCacheWarmingRow(props: {
  view: PromptCacheWarmingView;
  contextTokens: number;
  onToggle?: (enabled: boolean) => void;
}) {
  const chosen = () => (props.view.kind === 'chosen' ? props.view : null);
  const now = useSecondClock(() => !!chosen()?.session?.warmUntil);
  return (
    <div class="context-popup-row context-popup-prompt-cache-warming">
      <span class="context-popup-row-label">
        <Show when={chosen()} fallback={<span>Kept warm by OpenCode</span>}>
          {(view) => (
            <label class="context-breakdown-nested context-popup-warming-toggle">
              <input
                type="checkbox"
                checked={view().enabled}
                onChange={(event) => props.onToggle?.(event.currentTarget.checked)}
              />
              <UiIcon
                source={view().enabled ? checkSquareIcon : squareIcon}
                class="context-breakdown-checkbox"
                width="16"
                height="16"
              />
              <span>Keep warm</span>
            </label>
          )}
        </Show>
        <Tooltip
          content={
            chosen()
              ? PROMPT_CACHE_WARMING_TOOLTIP
              : "OpenCode's warming setting keeps every session's cache alive after each reply."
          }
        >
          <span class="context-popup-cost-info" tabindex="0" aria-label="Keep warm details">
            <UiIcon source={infoCircleIcon} width="11" height="11" />
          </span>
        </Tooltip>
      </span>
      <Show when={chosen()}>
        {(view) => {
          const description = () => describeWarming(view(), props.contextTokens, now());
          return (
            <>
              <span class="context-popup-row-value context-popup-warming-status">
                {description().status}
              </span>
              <Show when={description().detail}>
                {(detail) => <span class="context-popup-warming-detail">{detail()}</span>}
              </Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}

function formatModelName(model: ContextPopupModel) {
  return `${model.providerName} / ${model.modelName}`;
}

function CacheReadInfo() {
  return (
    <Tooltip content={CACHE_READ_TOOLTIP}>
      <span class="context-popup-cache-read-info" tabindex="0" aria-label="Cache read details">
        <UiIcon source={databaseBackupIcon} width="11" height="11" />
      </span>
    </Tooltip>
  );
}

function CacheWriteInfo() {
  return (
    <Tooltip content={CACHE_WRITE_TOOLTIP}>
      <span class="context-popup-cache-write-info" tabindex="0" aria-label="Cache write details">
        <UiIcon source={databaseScriptPlusIcon} width="11" height="11" />
      </span>
    </Tooltip>
  );
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
  /** Models with recorded usage across the session tree; more than one marks mixed usage. */
  models?: ContextPopupModel[];
  promptCache?: PromptCacheActivity | null;
  warming?: PromptCacheWarmingView | null;
  onToggleWarming?: (enabled: boolean) => void;
  compactDisabled: boolean;
  showCompactAction?: boolean;
  onClose: () => void;
  onCompact: () => void;
  onOpenUsageReport?: () => void;
}) {
  const [subagentsExpanded, setSubagentsExpanded] = createSignal(false);
  const [nestedBreakdown, setNestedBreakdown] = createSignal(true);
  const visibleBreakdown = () =>
    nestedBreakdown() && props.nestedBreakdown.length > 0 ? props.nestedBreakdown : props.breakdown;
  const contextUsageAvailable = () => props.usage.used > 0;
  const sessionTotal = () => getSessionTotalTokens(props.tokens);
  const subagentTotal = () => getSessionTotalTokens(props.subagentTokens);
  const sessionTokensAvailable = () => sessionTotal() > 0;
  const overallTotal = () => sessionTotal() + subagentTotal();
  const showUsageReport = () => !!props.onOpenUsageReport && overallTotal() > 0;
  const mixedModels = () => {
    const models = props.models ?? [];
    return models.length > 1 ? models : undefined;
  };
  let popupEl: HTMLDivElement | undefined;

  const setRef = (el: HTMLDivElement) => {
    popupEl = el;
    const forwarded = props.ref;
    if (isFunction(forwarded)) forwarded(el);
  };

  onSettled(() => {
    const cleanups: Array<() => void> = [];

    if (!popupEl || !props.boundaryRef)
      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
      };

    const reposition = () => {
      if (!popupEl || !props.boundaryRef) return;
      flipPopupDownIfNeeded(popupEl);
      alignPopupToBoundary(popupEl, props.boundaryRef, props.alignTo ?? 'right');
      clampPopupToViewport(popupEl);
    };

    cleanups.push(observePopupViewport(popupEl, reposition));

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
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
            <div
              class={[
                'context-popup-row',
                {
                  'context-popup-row-cache-read': row.key === 'cacheRead',
                  'context-popup-row-cache-write': row.key === 'cacheWrite',
                },
              ]}
            >
              <span class="context-popup-row-label">{row.label}</span>
              <span
                class={`context-popup-row-value${sessionTokensAvailable() ? '' : ' unavailable'}`}
              >
                <Show when={row.key === 'cacheRead'}>
                  <CacheReadInfo />
                </Show>
                <Show when={row.key === 'cacheWrite'}>
                  <CacheWriteInfo />
                </Show>
                {sessionTokensAvailable() ? formatNumber(row.value) : '--'}
              </span>
            </div>
          )}
        </For>
        <div class="context-popup-row context-popup-row-total">
          <span class="context-popup-row-label">Total</span>
          <span class={`context-popup-row-value${sessionTokensAvailable() ? '' : ' unavailable'}`}>
            {sessionTokensAvailable() ? formatNumber(sessionTotal()) : '--'}
          </span>
        </div>
        <Show
          when={formatCost(
            Math.max(props.cost ?? 0, props.tokens.cost ?? 0) + (props.subagentTokens.cost ?? 0)
          )}
        >
          {(cost) => (
            <div class="context-popup-row context-popup-cost-row">
              <span class="context-popup-row-label">
                Cost
                <Show when={props.subagentCount > 0}>
                  <Tooltip content="Cost includes all subagents.">
                    <span
                      class="context-popup-cost-info"
                      tabindex="0"
                      aria-label="Cost includes all subagents"
                    >
                      <UiIcon source={infoCircleIcon} width="11" height="11" />
                    </span>
                  </Tooltip>
                </Show>
              </span>
              <span class="context-popup-row-value">{cost()}</span>
            </div>
          )}
        </Show>
        <Show when={props.promptCache}>
          {(activity) => <PromptCacheRow activity={activity()} />}
        </Show>
        <Show when={props.promptCache && props.warming}>
          {(view) => (
            <PromptCacheWarmingRow
              view={view()}
              contextTokens={props.usage.used}
              onToggle={props.onToggleWarming}
            />
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
              <UiIcon
                source={nestedBreakdown() ? checkSquareIcon : squareIcon}
                class={`context-breakdown-checkbox context-breakdown-checkbox-${nestedBreakdown() ? 'checked' : 'unchecked'}`}
                width="16"
                height="16"
              />
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

      <Show when={subagentTotal() > 0}>
        <button
          type="button"
          class="context-popup-section context-popup-section-toggle"
          aria-expanded={ariaBoolean(subagentsExpanded())}
          onClick={() => setSubagentsExpanded((expanded) => !expanded)}
        >
          <span>Agents{props.subagentCount > 0 ? ` (${props.subagentCount})` : ''}</span>
          <UiIcon
            source={navArrowRightIcon}
            class={`context-popup-section-chevron${subagentsExpanded() ? ' expanded' : ''}`}
            width="10"
            height="10"
          />
          <Show when={!subagentsExpanded()}>
            <span class="context-popup-section-summary">{formatNumber(subagentTotal())}</span>
          </Show>
        </button>
        <Show when={subagentsExpanded()}>
          <div class="context-popup-rows context-popup-subagent-rows">
            <For each={getTokenRows(props.subagentTokens)}>
              {(row) => (
                <div
                  class={[
                    'context-popup-row',
                    {
                      'context-popup-row-cache-read': row.key === 'cacheRead',
                      'context-popup-row-cache-write': row.key === 'cacheWrite',
                    },
                  ]}
                >
                  <span class="context-popup-row-label">{row.label}</span>
                  <span class="context-popup-row-value">
                    <Show when={row.key === 'cacheRead'}>
                      <CacheReadInfo />
                    </Show>
                    <Show when={row.key === 'cacheWrite'}>
                      <CacheWriteInfo />
                    </Show>
                    {formatNumber(row.value)}
                  </span>
                </div>
              )}
            </For>
            <div class="context-popup-row context-popup-row-total">
              <span class="context-popup-row-label">Total</span>
              <span class="context-popup-row-value">{formatNumber(subagentTotal())}</span>
            </div>
          </div>
        </Show>
        <div class="context-popup-row context-popup-overall-total">
          <span class="context-popup-row-label">Overall</span>
          <span class="context-popup-row-value">{formatNumber(overallTotal())}</span>
        </div>
      </Show>

      <Show
        when={
          props.showCompactAction !== false &&
          !props.compactDisabled &&
          shouldShowContextCompact(props.usage.percent)
        }
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

      <Show when={props.model.modelName || mixedModels() || showUsageReport()}>
        <div class="context-popup-footer">
          <Show
            when={mixedModels()}
            fallback={
              <Show when={props.model.modelName}>
                <div class="context-popup-model">{formatModelName(props.model)}</div>
              </Show>
            }
          >
            {(models) => (
              <Tooltip
                content={
                  <div class="context-popup-models-tooltip">
                    <div>Models used in this session:</div>
                    <For each={models()}>{(model) => <div>{formatModelName(model)}</div>}</For>
                  </div>
                }
              >
                <div
                  class="context-popup-model context-popup-models-mixed"
                  tabindex="0"
                  aria-label={`Models used in this session: ${models()
                    .map((model) => formatModelName(model))
                    .join(', ')}`}
                >
                  Mixed models ({models().length})
                </div>
              </Tooltip>
            )}
          </Show>
          <Show when={showUsageReport()}>
            <Tooltip content="Usage by model and session, including nested sessions">
              <button
                type="button"
                class="context-popup-report-button"
                aria-label="Open session usage report"
                onClick={() => {
                  props.onClose();
                  props.onOpenUsageReport?.();
                }}
              >
                <UiIcon source={reportsIcon} width="11" height="11" />
                <span>Report</span>
              </button>
            </Tooltip>
          </Show>
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

function getContextUsageTone(percent: number) {
  if (percent >= CONTEXT_USAGE_ERROR_PERCENT) return 'error';
  if (percent >= CONTEXT_USAGE_WARNING_PERCENT) return 'warning';
  return '';
}

export function formatContextUsageTitle(percent: number, available = true) {
  return available ? `Context usage (${Math.round(percent)}%)` : 'Context usage unavailable';
}

function shouldShowContextCompact(percent: number) {
  return percent >= CONTEXT_COMPACT_ACTION_PERCENT;
}
