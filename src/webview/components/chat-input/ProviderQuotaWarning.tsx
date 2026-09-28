import {
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
} from './provider-quota-warning';

export function ProviderQuotaWarning(props: {
  limit: ProviderLimitStatus | null;
  modelID: string | null;
  modelName: string;
  providerName: string;
  forceShow?: boolean;
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
  const now = useSecondClock(() => lowWindows().length > 0);
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
    };
    window.addEventListener('storage', onStorage);
    onCleanup(() => {
      window.removeEventListener('storage', onStorage);
    });
  });

  return (
    <Show when={visibleWindows().length > 0}>
      <div class="chat-quota-warning" classList={{ error: isCritical() }}>
        <div class="chat-quota-warning-copy" role="status" aria-live="polite">
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
                : isCritical()
                  ? 'Dismiss until quota resets (1 hour if unknown)'
                  : 'Dismiss until quota becomes critical or resets (1 hour if reset unknown)'
            }
            onClick={() => {
              if (props.forceShow) setDebugDismissed(true);
              else
                quotaWarningDismissals.dismiss(
                  props.limit!.providerID,
                  visibleWindows(),
                  Date.now()
                );
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
