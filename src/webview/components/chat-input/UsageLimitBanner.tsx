import { Show } from 'solid-js';

export function UsageLimitBanner(props: {
  message: string;
  meta: string;
  showStopRetrying: boolean;
  onStopRetrying: () => void;
  onSwitchProvider: () => void;
}) {
  return (
    <div class="chat-usage-limit-banner" role="status" aria-live="polite">
      <div class="chat-usage-limit-copy">
        <span class="chat-usage-limit-title">Usage limit reached</span>
        <span class="chat-usage-limit-meta">{props.meta}</span>
        <span class="chat-usage-limit-message">{props.message}</span>
      </div>
      <div class="chat-usage-limit-actions">
        <Show when={props.showStopRetrying}>
          <button class="chat-usage-limit-action danger" onClick={props.onStopRetrying}>
            Stop retrying
          </button>
        </Show>
        <button class="chat-usage-limit-action" onClick={props.onSwitchProvider}>
          Switch provider
        </button>
      </div>
    </div>
  );
}
