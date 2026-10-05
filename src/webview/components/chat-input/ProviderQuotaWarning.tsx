import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from 'solid-js';
import type { ProviderLimitStatus, ProviderLimitWindow } from '../../../shared/protocol';
import { DEFAULT_RESET_WARNING_DAYS } from '../../../shared/provider-limit-config';
import { postMessage } from '../../lib/bridge';
import { useSecondClock } from '../../lib/clock';
import {
  formatProviderLimitWindowValue,
  getProviderLimitTone,
  getProviderLimitWindowRemainingPercent,
} from '../../lib/format';
import { getProviderUsageLink } from '../../lib/provider-usage';
import { STORAGE_KEYS } from '../../lib/state-storage';
import { formatDuration } from '../../lib/time-format';
import { xmarkIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';
import {
  getLowQuotaWindows,
  isQuotaWarningDismissed,
  quotaWarningDismissals,
  resetWarningDismissals,
} from './provider-quota-warning';

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
  createEffect(() => {
    void props.forceShow;
    setDebugDismissed(false);
  });
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
  const usageLink = createMemo(() => getProviderUsageLink(props.limit?.providerID));
  const availableResets = createMemo(() => {
    const limit = props.limit;
    return limit?.status === 'available' ? (limit.usageLimitResets?.availableCount ?? 0) : 0;
  });
  const resetLabel = () =>
    `${availableResets()} ${availableResets() === 1 ? 'reset' : 'resets'} available`;
  const isCritical = createMemo(() =>
    visibleWindows().some((window) => getProviderLimitTone(props.limit, window) === 'error')
  );
  const [showResetExpirations, setShowResetExpirations] = createSignal(false);
  const warningMode = createMemo(() =>
    visibleWindows().length === 0 ? 'resets' : expiringResets().length > 0 ? 'rotate' : 'quota'
  );
  createEffect(() => {
    const mode = warningMode();
    setShowResetExpirations(mode === 'resets');
    if (mode !== 'rotate') return;
    const timer = window.setInterval(() => setShowResetExpirations((value) => !value), 15_000);
    onCleanup(() => window.clearInterval(timer));
  });
  const refreshedResets = new Set<string>();

  createEffect(() => {
    const limit = props.limit;
    if (!limit) return;
    // An expired snapshot must not reappear as a fresh warning at the reset boundary.
    // Request once per window cycle; normal provider polling handles retries/reporting delays.
    const expired = lowWindows().filter(
      (window) => window.resetAt !== null && window.resetAt <= now()
    );
    let refresh = false;
    for (const window of expired) {
      const key = JSON.stringify([limit.providerID, props.modelID, window.id, window.resetAt]);
      if (refreshedResets.has(key)) continue;
      refreshedResets.add(key);
      refresh = true;
    }
    if (refresh) untrack(props.onRefresh);
  });

  onMount(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEYS.quotaWarningDismissals)
        quotaWarningDismissals.reload();
      if (event.key === null || event.key === STORAGE_KEYS.resetWarningDismissals)
        resetWarningDismissals.reload();
    };
    window.addEventListener('storage', onStorage);
    onCleanup(() => {
      window.removeEventListener('storage', onStorage);
    });
  });

  return (
    <Show when={visibleWindows().length > 0 || expiringResets().length > 0}>
      <div
        class="chat-quota-warning"
        classList={{
          error: showResetExpirations()
            ? (expiringResets()[0]?.[0] ?? Infinity) - now() <= 24 * 60 * 60_000
            : isCritical(),
        }}
      >
        <div class="chat-quota-warning-copy" role="status" aria-live="polite">
          <Show when={!showResetExpirations()}>
            <For each={visibleWindows()}>
              {(window) => (
                <div class="chat-quota-warning-row">
                  <span>{formatQuotaWarning(window)}</span>
                  <Show when={window.resetAt !== null}>
                    <span class="chat-quota-warning-reset">
                      {' '}
                      · resets in {formatQuotaReset(window.resetAt!, now())}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </Show>
          <Show when={showResetExpirations()}>
            <For each={expiringResets().slice(0, 1)}>
              {([expiresAt]) => (
                <div class="chat-quota-warning-row">
                  <span>
                    Reset expires in{' '}
                    <span class="chat-quota-warning-reset">
                      {formatQuotaReset(expiresAt, now())}
                    </span>
                  </span>
                </div>
              )}
            </For>
          </Show>
        </div>
        <div class="chat-quota-warning-actions">
          <Show when={availableResets() > 0}>
            <Show when={usageLink()} fallback={<span>{resetLabel()}</span>}>
              {(link) => (
                <a
                  class="chat-quota-warning-usage"
                  href={link().url}
                  onClick={(event) => {
                    event.preventDefault();
                    // VS Code's window-level link handler also opens clicks with default prevented.
                    event.stopPropagation();
                    postMessage({ type: 'vscode/open-external', payload: { url: link().url } });
                  }}
                >
                  {resetLabel()}
                </a>
              )}
            </Show>
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
                batch(() => {
                  quotaWarningDismissals.dismiss(providerID, windows, dismissedAt);
                  resetWarningDismissals.dismiss(providerID, expirations, dismissedAt);
                });
              }
            }}
          >
            <UiIcon source={xmarkIcon} width="12" height="12" />
          </button>
        </div>
      </div>
    </Show>
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
