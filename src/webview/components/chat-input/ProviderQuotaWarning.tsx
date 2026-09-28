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
import { useSecondClock } from '../../lib/clock';
import { getProviderLimitTone, getProviderLimitWindowUsedPercent } from '../../lib/format';
import { STORAGE_KEYS } from '../../lib/state-storage';
import { formatDuration } from '../../lib/time-format';
import { xmarkIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';
import { ProviderLimitPopup } from './ProviderLimitPopup';
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
  onOpenUsage: () => void;
  onRefresh: () => void;
}) {
  const lowWindows = createMemo(() =>
    getLowQuotaWindows(props.limit, props.modelID, props.modelName)
  );
  const now = useSecondClock(() => lowWindows().length > 0);
  const dismissals = createMemo(() => quotaWarningDismissals.read());
  const visibleWindows = createMemo(() =>
    lowWindows().filter(
      (window) =>
        (window.resetAt === null || window.resetAt > now()) &&
        !isQuotaWarningDismissed(dismissals(), props.limit!.providerID, window, now())
    )
  );
  const [showUsage, setShowUsage] = createSignal(false);
  let bannerRef: HTMLDivElement | undefined;
  let usageButtonRef: HTMLButtonElement | undefined;
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

  createEffect(() => {
    void props.limit?.providerID;
    void props.modelID;
    setShowUsage(false);
  });

  onMount(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEYS.quotaWarningDismissals)
        quotaWarningDismissals.reload();
    };
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !bannerRef?.contains(event.target)) setShowUsage(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !showUsage()) return;
      event.stopPropagation();
      setShowUsage(false);
      usageButtonRef?.focus();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKeyDown);
    });
  });

  return (
    <Show when={visibleWindows().length > 0}>
      <div
        ref={bannerRef}
        class="chat-quota-warning"
        classList={{
          error: visibleWindows().some(
            (window) => getProviderLimitTone(props.limit, window) === 'error'
          ),
        }}
      >
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
          <button
            ref={usageButtonRef}
            type="button"
            class="chat-quota-warning-usage"
            aria-expanded={showUsage()}
            onClick={() => {
              props.onOpenUsage();
              setShowUsage((value) => !value);
            }}
          >
            View usage
          </button>
          <button
            type="button"
            class="chat-quota-warning-close"
            aria-label={`Dismiss ${props.providerName} quota warning`}
            title="Dismiss until quota resets (1 hour if unknown)"
            onClick={() => {
              quotaWarningDismissals.dismiss(props.limit!.providerID, visibleWindows(), Date.now());
              setShowUsage(false);
            }}
          >
            <UiIcon source={xmarkIcon} width="12" height="12" />
          </button>
        </div>
        <Show when={showUsage()}>
          <ProviderLimitPopup
            limit={props.limit}
            providerName={props.providerName}
            boundaryRef={bannerRef}
            onClose={() => setShowUsage(false)}
          />
        </Show>
      </div>
    </Show>
  );
}

function formatQuotaWarning(window: ProviderLimitWindow): string {
  const used = getProviderLimitWindowUsedPercent(window);
  if (window.remaining <= 0) return `${window.label}: limit reached`;
  return `${window.label}: ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Math.min(100, Math.max(0, used ?? 100)))}% used`;
}

function formatQuotaReset(resetAt: number, now: number): string {
  return formatDuration(Math.max(60_000, Math.ceil((resetAt - now) / 60_000) * 60_000));
}
