import { For, onCleanup, onMount, Show } from 'solid-js';
import type { ProviderLimitStatus, ProviderLimitWindow } from '../../../shared/protocol';
import {
  alignPopupToBoundary,
  clampPopupToViewport,
  observePopupViewport,
} from '../../lib/popup-position';
import {
  formatProviderLimitWindowReset,
  formatProviderLimitWindowValue,
  getOrderedProviderLimitWindows,
  getProviderLimitWindowRemainingPercent,
  getProviderLimitWindowUsedPercent,
} from '../../lib/format';

const PROVIDER_LIMIT_WARNING_PERCENT = 75;
const PROVIDER_LIMIT_ERROR_PERCENT = 90;

export function ProviderLimitPopup(props: {
  ref?: HTMLDivElement | ((el: HTMLDivElement) => void);
  boundaryRef?: HTMLElement;
  alignTo?: 'left' | 'right';
  limit: ProviderLimitStatus | null;
  model: { providerName: string; modelName: string };
  onClose: () => void;
}) {
  const windows = () => getOrderedProviderLimitWindows(props.limit);
  let popupEl: HTMLDivElement | undefined;

  const setRef = (el: HTMLDivElement) => {
    popupEl = el;
    const forwarded = props.ref;
    if (typeof forwarded === 'function') forwarded(el);
  };

  onMount(() => {
    if (!popupEl) return;
    const reposition = () => {
      if (!popupEl) return;
      if (props.boundaryRef)
        alignPopupToBoundary(popupEl, props.boundaryRef, props.alignTo ?? 'right');
      clampPopupToViewport(popupEl);
    };
    onCleanup(observePopupViewport(popupEl, reposition));
  });

  return (
    <div ref={setRef} class="provider-limit-popup" onClick={(e) => e.stopPropagation()}>
      <div class="provider-limit-popup-header">
        <span class="provider-limit-popup-title">Provider Limits</span>
      </div>

      <Show
        when={props.limit?.status === 'available' && windows().length > 0}
        fallback={
          <div class="provider-limit-popup-empty">
            {props.limit?.status === 'unsupported' || props.limit?.status === 'error'
              ? props.limit.note || 'Limits unavailable'
              : 'No active limits'}
          </div>
        }
      >
        <div class="provider-limit-popup-rows">
          <For each={windows()}>{(window) => <ProviderLimitRow window={window} />}</For>
        </div>
      </Show>

      <Show when={props.model.modelName}>
        <div class="provider-limit-popup-model">
          {props.model.providerName} / {props.model.modelName}
        </div>
      </Show>
    </div>
  );
}

function ProviderLimitRow(props: { window: ProviderLimitWindow }) {
  const remainingPercent = () => getProviderLimitWindowRemainingPercent(props.window);
  const usedPercent = () => getProviderLimitWindowUsedPercent(props.window);
  const tone = () => {
    const used = usedPercent();
    if (props.window.remaining <= 0) return 'error';
    if (used == null) return '';
    if (used >= PROVIDER_LIMIT_ERROR_PERCENT) return 'error';
    if (used >= PROVIDER_LIMIT_WARNING_PERCENT) return 'warning';
    return '';
  };
  const reset = () =>
    props.window.resetAt ? formatProviderLimitWindowReset(props.window.resetAt) : null;
  const remainingLabel = () => formatProviderLimitWindowValue(props.window, props.window.remaining);
  const limitLabel = () =>
    props.window.limit != null
      ? formatProviderLimitWindowValue(props.window, props.window.limit)
      : null;

  return (
    <div class="provider-limit-row">
      <div class="provider-limit-row-head">
        <span class="provider-limit-row-label">{props.window.label}</span>
        <Show
          when={remainingPercent() != null}
          fallback={<span class="provider-limit-row-pct">—</span>}
        >
          <span class="provider-limit-row-pct">{Math.round(remainingPercent()!)}%</span>
        </Show>
      </div>
      <Show when={usedPercent() != null}>
        <div class="provider-limit-row-bar">
          <div
            class={`provider-limit-row-bar-fill ${tone()}`}
            style={{ width: `${Math.min(usedPercent()!, 100)}%` }}
          />
        </div>
      </Show>
      <div class="provider-limit-row-meta">
        <span>
          {remainingLabel()}
          <Show when={limitLabel()}>
            <span class="provider-limit-row-sep">/</span>
            {limitLabel()}
          </Show>
          <span class="provider-limit-row-unit"> left</span>
        </span>
        <Show when={reset()}>
          <span class="provider-limit-row-reset">resets in {reset()}</span>
        </Show>
      </div>
    </div>
  );
}
