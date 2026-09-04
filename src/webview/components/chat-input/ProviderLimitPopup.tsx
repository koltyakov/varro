import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
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
import { postMessage } from '../../lib/bridge';
import { isFunction } from '../../lib/runtime-values';
import { navArrowRightIcon, openNewWindowIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';

const PROVIDER_LIMIT_WARNING_PERCENT = 75;
const PROVIDER_LIMIT_ERROR_PERCENT = 90;
const OPENAI_USAGE_URL = 'https://chatgpt.com/#settings/Usage';

export function ProviderLimitPopup(props: {
  ref?: HTMLDivElement | ((el: HTMLDivElement) => void);
  boundaryRef?: HTMLElement;
  alignTo?: 'left' | 'right';
  limit: ProviderLimitStatus | null;
  providerName: string;
  onClose: () => void;
}) {
  const [resetCreditsExpanded, setResetCreditsExpanded] = createSignal(false);
  const windows = () => getOrderedProviderLimitWindows(props.limit);
  const planName = () =>
    props.limit?.status === 'available' ? props.limit.planName || null : null;
  const resetCredits = () => {
    if (props.limit?.status !== 'available' || props.limit.providerID !== 'openai') return null;
    const resets = props.limit.usageLimitResets;
    return resets && resets.availableCount > 0 ? resets : null;
  };
  let popupEl: HTMLDivElement | undefined;

  const setRef = (el: HTMLDivElement) => {
    popupEl = el;
    const forwarded = props.ref;
    if (isFunction(forwarded)) forwarded(el);
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

      <Show when={resetCredits()}>
        {(resets) => {
          const unavailableCount = () =>
            Math.max(resets().availableCount - (resets().credits?.length ?? 0), 0);
          return (
            <div class="provider-limit-reset-section">
              <button
                type="button"
                class="provider-limit-reset-toggle"
                aria-expanded={resetCreditsExpanded()}
                onClick={() => setResetCreditsExpanded((expanded) => !expanded)}
              >
                <span>Usage limit resets ({resets().availableCount})</span>
                <UiIcon
                  source={navArrowRightIcon}
                  class={`provider-limit-reset-chevron${resetCreditsExpanded() ? ' expanded' : ''}`}
                  width="10"
                  height="10"
                />
              </button>
              <Show when={resetCreditsExpanded()}>
                <div class="provider-limit-reset-content">
                  <ul class="provider-limit-reset-rows" aria-label="Available usage limit resets">
                    <For each={resets().credits ?? []}>
                      {(credit) => (
                        <li class="provider-limit-reset-row">
                          <Show when={!isGenericResetCreditTitle(credit.title)}>
                            <span class="provider-limit-reset-title">{credit.title}: </span>
                          </Show>
                          <span class="provider-limit-reset-expiration">
                            {credit.expiresAt == null
                              ? 'Does not expire'
                              : `Expires ${formatResetCreditExpiration(credit.expiresAt)}`}
                          </span>
                        </li>
                      )}
                    </For>
                    <Show when={unavailableCount() > 0}>
                      <li class="provider-limit-reset-unavailable">
                        Expiration details unavailable for {unavailableCount()}{' '}
                        {unavailableCount() === 1 ? 'reset' : 'resets'}.
                      </li>
                    </Show>
                  </ul>
                  <a
                    class="provider-limit-reset-link"
                    href={OPENAI_USAGE_URL}
                    onClick={(event) => {
                      event.preventDefault();
                      postMessage({
                        type: 'vscode/open-external',
                        payload: { url: OPENAI_USAGE_URL },
                      });
                    }}
                  >
                    ChatGPT Usage
                    <UiIcon source={openNewWindowIcon} width="11" height="11" />
                  </a>
                </div>
              </Show>
            </div>
          );
        }}
      </Show>

      <Show when={props.providerName}>
        <div class="provider-limit-popup-provider">
          {props.providerName}
          <Show when={planName()}>{(name) => <> · {name()}</>}</Show>
        </div>
      </Show>
    </div>
  );
}

function formatResetCreditExpiration(expiresAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(expiresAt);
}

function isGenericResetCreditTitle(title: string) {
  return title.trim().toLowerCase() === 'full reset';
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
          fallback={<span class="provider-limit-row-pct">-</span>}
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
