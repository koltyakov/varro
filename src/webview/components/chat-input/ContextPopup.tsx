import { For, Show } from 'solid-js';
import { formatNumber } from '../../lib/message-metrics';

const CONTEXT_USAGE_WARNING_PERCENT = 70;
const CONTEXT_USAGE_ERROR_PERCENT = 90;

export function ContextPopup(props: {
  ref?: HTMLDivElement | ((el: HTMLDivElement) => void);
  usage: { used: number; limit: number; percent: number };
  tokens: {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  model: { providerName: string; modelName: string };
  compactDisabled: boolean;
  onClose: () => void;
  onCompact: () => void;
}) {
  const rows = () => {
    const t = props.tokens;
    const items: Array<{ label: string; value: number; color?: string }> = [
      { label: 'Input', value: t.input },
      { label: 'Output', value: t.output },
    ];
    if (t.reasoning > 0) items.push({ label: 'Reasoning', value: t.reasoning });
    if (t.cacheRead > 0) items.push({ label: 'Cache read', value: t.cacheRead });
    if (t.cacheWrite > 0) items.push({ label: 'Cache write', value: t.cacheWrite });
    return items;
  };

  return (
    <div ref={props.ref} class="context-popup" onClick={(e) => e.stopPropagation()}>
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
          <For each={rows()}>
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
          {props.model.providerName} / {props.model.modelName}
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
