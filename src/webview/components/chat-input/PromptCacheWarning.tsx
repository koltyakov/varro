import { createEffect, createSignal, Show } from 'solid-js';
import { formatTokenCount } from '../../lib/message-metrics';
import { xmarkIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';
import { PROMPT_CACHE_TTL_ESTIMATE_MS, type PromptCacheActivity } from './ContextPopup';

// Dismissals last for the webview's lifetime and cover one cache expiry per session. A newer
// cached response is a new expiry and may warn again.
const [dismissedExpiries, setDismissedExpiries] = createSignal<ReadonlySet<string>>(new Set());

function expiryKey(sessionId: string, activity: PromptCacheActivity) {
  return `${sessionId}:${activity.lastUsedAt}`;
}

/**
 * Warns before the next message in a large idle session whose prompt cache has likely expired, so
 * the user knows the whole context is about to be re-sent at the uncached rate.
 */
export function PromptCacheWarning(props: {
  sessionId: string | null;
  activity: PromptCacheActivity | null;
  contextTokens: number;
  /** `varro.chat.promptCacheWarningTokens`; `0` turns the warning off. */
  thresholdTokens: number;
}) {
  const [expired, setExpired] = createSignal(false);
  createEffect(
    () => (props.activity && !props.activity.inUse ? props.activity.lastUsedAt : null),
    (lastUsedAt) => {
      setExpired(false);
      if (lastUsedAt === null) return;
      const remaining = lastUsedAt + PROMPT_CACHE_TTL_ESTIMATE_MS - Date.now();
      if (remaining <= 0) {
        setExpired(true);
        return;
      }
      // One timer per expiry instead of a running clock; the warning only needs the boundary.
      const timer = window.setTimeout(() => setExpired(true), remaining);
      return () => window.clearTimeout(timer);
    }
  );
  const visible = () => {
    const sessionId = props.sessionId;
    const activity = props.activity;
    return (
      !!sessionId &&
      !!activity &&
      !activity.inUse &&
      expired() &&
      props.thresholdTokens > 0 &&
      props.contextTokens >= props.thresholdTokens &&
      !dismissedExpiries().has(expiryKey(sessionId, activity))
    );
  };
  const dismiss = () => {
    const sessionId = props.sessionId;
    const activity = props.activity;
    if (!sessionId || !activity) return;
    setDismissedExpiries((current) => new Set(current).add(expiryKey(sessionId, activity)));
  };

  return (
    <Show when={visible()}>
      <div class="chat-quota-warning chat-prompt-cache-warning">
        <div class="chat-quota-warning-copy" role="status" aria-live="polite">
          <div
            class="chat-quota-warning-row"
            title="No cached response for over 5 minutes, so the provider has likely dropped its prompt cache. The next message re-sends the whole context at the uncached rate. This is an estimate."
          >
            <span>Prompt cache likely expired</span>
            <span class="chat-quota-warning-reset">
              {' '}
              · next message re-sends {formatTokenCount(props.contextTokens)} tokens uncached
            </span>
          </div>
        </div>
        <div class="chat-quota-warning-actions">
          <button
            type="button"
            class="chat-quota-warning-close"
            aria-label="Dismiss prompt cache warning"
            title="Dismiss until the cache is used again"
            onClick={dismiss}
          >
            <UiIcon source={xmarkIcon} width="12" height="12" />
          </button>
        </div>
      </div>
    </Show>
  );
}
