import { Show } from 'solid-js';
import { useSecondClock } from '../../lib/clock';
import { formatDuration } from '../../lib/time-format';
import type { UsageLimitKind } from '../../lib/usage-limit';

export function UsageLimitBanner(props: {
  kind: UsageLimitKind;
  title: string;
  /** Provider text; omitted when it only repeats the title. */
  message: string;
  summary: string;
  modelLabel: string | null;
  /** OpenCode is retrying the request on its own. */
  retrying: boolean;
  retryAt: number | null;
  attempt: number | null;
  /** When the exhausted provider quota resets, from the retry time or polled provider limits. */
  resetAt: number | null;
  externalAction?: { label: string; link: string } | null;
  onExternalAction?: (link: string) => void;
  showStopRetrying: boolean;
  onStopRetrying: () => void;
  onContinue: () => void;
  onSwitchModel: () => void;
}) {
  const countdownTarget = () => (props.retrying ? props.retryAt : props.resetAt);
  const now = useSecondClock(() => countdownTarget() !== null);
  const tone = () => (props.kind === 'quota' ? 'error' : 'warning');
  const waitingForReset = () => {
    const resetAt = props.resetAt;
    return !props.retrying && resetAt !== null && resetAt > now();
  };
  const meta = () => {
    const parts = props.modelLabel ? [props.modelLabel] : [];
    if (props.retrying) {
      const retryAt = props.retryAt;
      if (retryAt !== null && retryAt > now()) {
        parts.push(`retrying in ${formatCountdown(retryAt - now())}`);
      } else {
        parts.push('retrying now');
      }
      if (props.attempt) parts.push(`attempt ${props.attempt}`);
      return parts.join(' · ');
    }
    const resetAt = props.resetAt;
    if (resetAt !== null && resetAt > now()) {
      parts.push(
        `resets ${formatResetClock(resetAt, now())} (in ${formatResetIn(resetAt - now())})`
      );
    } else if (resetAt !== null) {
      parts.push('limit window has reset');
    } else {
      parts.push(props.summary);
    }
    return parts.join(' · ');
  };
  const message = () => {
    const text = props.message.trim();
    return text && text.toLowerCase() !== props.title.trim().toLowerCase() ? text : '';
  };
  const switchModelTitle =
    'Pick another model. A retrying turn stops and continues on the new model.';

  return (
    <div
      class="chat-usage-limit-banner"
      data-tone={tone()}
      data-state={props.retrying ? 'retrying' : waitingForReset() ? 'waiting' : 'stopped'}
      role="status"
      aria-live="polite"
    >
      <div class="chat-usage-limit-copy">
        <span class="chat-usage-limit-title">{props.title}</span>
        <span class="chat-usage-limit-meta">{meta()}</span>
        <Show when={message()}>
          {(text) => <span class="chat-usage-limit-message">{text()}</span>}
        </Show>
      </div>
      <div class="chat-usage-limit-actions">
        <Show when={!props.retrying && !waitingForReset()}>
          <button
            type="button"
            class="chat-usage-limit-action primary"
            title="Send Continue to retry the interrupted turn"
            onClick={props.onContinue}
          >
            Continue
          </button>
        </Show>
        <button
          type="button"
          class={['chat-usage-limit-action', { primary: props.retrying || waitingForReset() }]}
          title={switchModelTitle}
          onClick={props.onSwitchModel}
        >
          Switch model…
        </button>
        <Show when={waitingForReset()}>
          <button
            type="button"
            class="chat-usage-limit-action"
            title="Send Continue now. It may fail again until the limit resets."
            onClick={props.onContinue}
          >
            Try anyway
          </button>
        </Show>
        <Show when={props.externalAction} keyed>
          {(action) => (
            <button
              type="button"
              class="chat-usage-limit-action"
              onClick={() => props.onExternalAction?.(action.link)}
            >
              {action.label}
            </button>
          )}
        </Show>
        <Show when={props.showStopRetrying}>
          <button
            type="button"
            class="chat-usage-limit-action danger"
            onClick={props.onStopRetrying}
          >
            Stop retrying
          </button>
        </Show>
      </div>
    </div>
  );
}

function formatCountdown(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds >= 3600) return formatResetIn(ms);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatResetIn(ms: number): string {
  // Minute precision; the second-level countdown is only useful for imminent retries.
  return ms < 60_000 ? 'under a minute' : formatDuration(Math.ceil(ms / 60_000) * 60_000);
}

function formatResetClock(resetAt: number, now: number): string {
  const reset = new Date(resetAt);
  const time = reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === reset.toDateString()
    ? `at ${time}`
    : `${reset.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
