import { ariaBoolean } from '../../lib/aria';
import { createEffect, createMemo, createSignal, onSettled, Show, untrack } from 'solid-js';
import type { ProviderLimitStatus, ProviderLimitWindow } from '../../../shared/protocol';
import { DEFAULT_RESET_WARNING_DAYS } from '../../../shared/provider-limit-config';
import { useSecondClock } from '../../lib/clock';
import {
  formatProviderLimitWindowValue,
  getProviderLimitTone,
  getProviderLimitWindowRemainingPercent,
} from '../../lib/format';
import { STORAGE_KEYS } from '../../lib/state-storage';
import { formatDuration } from '../../lib/time-format';
import { xmarkIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';
import { CodexLoginWarning } from './CodexLoginWarning';
import { ProviderLimitPopup } from './ProviderLimitPopup';
import {
  getLowQuotaWindows,
  isQuotaWarningDismissed,
  quotaWarningDismissals,
  resetWarningDismissals,
} from './provider-quota-warning';

const WARNING_ROTATION_MS = 15_000;

export function ProviderQuotaWarning(props: {
  limit: ProviderLimitStatus | null;
  modelID: string | null;
  modelName: string;
  providerName: string;
  forceShow?: boolean;
  resetWarningDays?: number;
  onRefresh: () => void;
}) {
  const lowWindows = createMemo(() =>
    getLowQuotaWindows(props.limit, props.modelID, props.modelName, props.forceShow)
  );
  const [debugDismissed, setDebugDismissed] = createSignal(false);
  createEffect(
    () => props.forceShow,
    () => {
      setDebugDismissed(false);
    }
  );
  const resetCredits = createMemo(() => {
    const limit = props.limit;
    return limit?.status === 'available' && (limit.usageLimitResets?.availableCount ?? 0) > 0
      ? (limit.usageLimitResets?.credits ?? [])
      : [];
  });
  const now = useSecondClock(() => lowWindows().length > 0 || resetCredits().length > 0);
  const resetDismissals = createMemo(() => resetWarningDismissals.read());
  const expiringResets = createMemo(() => {
    const groups = new Map<number, number>();
    for (const credit of resetCredits()) {
      const expiresAt = credit.expiresAt;
      if (
        expiresAt === null ||
        expiresAt <= now() ||
        expiresAt - now() >
          (props.resetWarningDays ?? DEFAULT_RESET_WARNING_DAYS) * 24 * 60 * 60_000 ||
        (props.forceShow
          ? debugDismissed()
          : resetDismissals().some(
              (entry) =>
                entry.providerID === props.limit?.providerID &&
                entry.expiresAt === expiresAt &&
                entry.remindAt > now()
            ))
      )
        continue;
      groups.set(expiresAt, (groups.get(expiresAt) ?? 0) + 1);
    }
    return [...groups].toSorted(([left], [right]) => left - right);
  });
  const dismissals = createMemo(() => quotaWarningDismissals.read());
  const visibleWindows = createMemo(() =>
    lowWindows().filter(
      (window) =>
        (window.resetAt === null || window.resetAt > now()) &&
        (props.forceShow
          ? !debugDismissed()
          : !isQuotaWarningDismissed(dismissals(), props.limit!.providerID, window, now()))
    )
  );
  const resetExpiration = createMemo(() => expiringResets()[0]?.[0]);
  const warningCount = createMemo(
    () => visibleWindows().length + Number(resetExpiration() !== undefined)
  );
  const availableResets = createMemo(() => {
    const limit = props.limit;
    return limit?.status === 'available' ? (limit.usageLimitResets?.availableCount ?? 0) : 0;
  });
  const resetLabel = () =>
    `${availableResets()} ${availableResets() === 1 ? 'reset' : 'resets'} available`;
  const [showResetPopup, setShowResetPopup] = createSignal(false);
  let resetPopupAnchor: HTMLDivElement | undefined;
  let resetPopupButton: HTMLButtonElement | undefined;
  createEffect(
    () => availableResets() === 0 || warningCount() === 0,
    (empty) => {
      if (empty) setShowResetPopup(false);
    }
  );
  createEffect(showResetPopup, (shown) => {
    if (!shown) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && resetPopupAnchor?.contains(event.target)) return;
      setShowResetPopup(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setShowResetPopup(false);
      resetPopupButton?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  });
  const isCritical = createMemo(() =>
    visibleWindows().some((window) => getProviderLimitTone(props.limit, window) === 'error')
  );
  const [warningIndex, setWarningIndex] = createSignal(0);
  createEffect(warningCount, (count) => {
    setWarningIndex(0);
    if (count < 2) return;
    const timer = window.setInterval(
      () => setWarningIndex((index) => (index + 1) % count),
      WARNING_ROTATION_MS
    );
    return () => window.clearInterval(timer);
  });
  const activeQuota = createMemo(() => visibleWindows()[warningIndex()]);
  const activeQuotaLabel = createMemo(() => {
    const quota = activeQuota();
    return quota ? formatQuotaWarning(quota) : '';
  });
  const activeCountdown = createMemo(() => {
    const quota = activeQuota();
    const end = quota ? quota.resetAt : resetExpiration();
    return end == null ? '' : formatQuotaReset(end, now());
  });
  const activeIsCritical = createMemo(() => {
    const quota = activeQuota();
    return quota
      ? getProviderLimitTone(props.limit, quota) === 'error'
      : (resetExpiration() ?? Infinity) - now() <= 24 * 60 * 60_000;
  });
  const refreshedResets = new Set<string>();

  createEffect(
    () => {
      const limit = props.limit;
      if (!limit) return;
      // An expired snapshot must not reappear as a fresh warning at the reset boundary.
      // Request once per window cycle; normal provider polling handles retries/reporting delays.
      const expired = lowWindows().filter(
        (window) => window.resetAt !== null && window.resetAt <= now()
      );
      return expired.map((window) =>
        JSON.stringify([limit.providerID, props.modelID, window.id, window.resetAt])
      );
    },
    (keys) => {
      if (!keys) return;
      let refresh = false;
      for (const key of keys) {
        if (refreshedResets.has(key)) continue;
        refreshedResets.add(key);
        refresh = true;
      }
      if (refresh) untrack(props.onRefresh);
    }
  );

  onSettled(() => {
    const cleanups: Array<() => void> = [];

    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEYS.quotaWarningDismissals)
        quotaWarningDismissals.reload();
      if (event.key === null || event.key === STORAGE_KEYS.resetWarningDismissals)
        resetWarningDismissals.reload();
    };
    window.addEventListener('storage', onStorage);
    cleanups.push(() => {
      window.removeEventListener('storage', onStorage);
    });

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });

  return (
    <>
      <CodexLoginWarning limit={props.limit} />
      <Show when={warningCount() > 0}>
        <div class={['chat-quota-warning', { error: activeIsCritical() }]}>
          <div class="chat-quota-warning-copy" role="status" aria-live="polite">
            <div
              class="chat-quota-warning-row"
              title={
                activeQuota()
                  ? activeCountdown()
                    ? `${activeQuotaLabel()} · resets in ${activeCountdown()}`
                    : activeQuotaLabel()
                  : `Reset expires in ${activeCountdown()}`
              }
            >
              <Show
                when={activeQuota()}
                fallback={
                  <span>
                    Reset expires in{' '}
                    <span class="chat-quota-warning-reset">{activeCountdown()}</span>
                  </span>
                }
              >
                <span>{activeQuotaLabel()}</span>
                <Show when={activeCountdown()}>
                  <span class="chat-quota-warning-reset"> · resets in {activeCountdown()}</span>
                </Show>
              </Show>
            </div>
          </div>
          <div class="chat-quota-warning-actions">
            <Show when={availableResets() > 0}>
              <div ref={(el) => (resetPopupAnchor = el)} class="chat-quota-warning-resets">
                <button
                  ref={(el) => (resetPopupButton = el)}
                  type="button"
                  class="chat-quota-warning-usage"
                  aria-expanded={ariaBoolean(showResetPopup())}
                  onClick={() => setShowResetPopup((visible) => !visible)}
                >
                  {resetLabel()}
                </button>
                <Show when={showResetPopup()}>
                  <ProviderLimitPopup
                    limit={props.limit}
                    providerName={props.providerName}
                    resetsOnly
                    onClose={() => setShowResetPopup(false)}
                  />
                </Show>
              </div>
            </Show>
            <button
              type="button"
              class="chat-quota-warning-close"
              aria-label={`Dismiss ${props.providerName} quota warning`}
              title={
                props.forceShow
                  ? 'Dismiss debug preview'
                  : expiringResets().length > 0
                    ? 'Snooze reset reminders until the next milestone and dismiss current quota warnings'
                    : isCritical()
                      ? 'Dismiss until quota resets (1 hour if unknown)'
                      : 'Dismiss until quota becomes critical or resets (1 hour if reset unknown)'
              }
              onClick={() => {
                if (props.forceShow) setDebugDismissed(true);
                else {
                  const providerID = props.limit!.providerID;
                  const windows = visibleWindows();
                  const expirations = expiringResets().map(([expiresAt]) => expiresAt);
                  const dismissedAt = Date.now();
                  (() => {
                    quotaWarningDismissals.dismiss(providerID, windows, dismissedAt);
                    resetWarningDismissals.dismiss(providerID, expirations, dismissedAt);
                  })();
                }
              }}
            >
              <UiIcon source={xmarkIcon} width="12" height="12" />
            </button>
          </div>
        </div>
      </Show>
    </>
  );
}

function formatQuotaWarning(window: ProviderLimitWindow): string {
  const remaining = window.remaining <= 0 ? 0 : getProviderLimitWindowRemainingPercent(window);
  if (remaining === null)
    return `${window.label}: ${formatProviderLimitWindowValue(window, window.remaining)} left`;
  return `${window.label}: ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(remaining)}% left`;
}

function formatQuotaReset(resetAt: number, now: number): string {
  return formatDuration(Math.max(60_000, Math.round((resetAt - now) / 60_000) * 60_000));
}
