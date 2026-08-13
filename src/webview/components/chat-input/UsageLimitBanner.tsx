import { Show } from 'solid-js';

export function UsageLimitBanner(props: {
  title: string;
  message: string;
  meta: string;
  primaryActionLabel: string;
  onPrimaryAction: () => void;
  externalAction?: { label: string; link: string } | null;
  onExternalAction?: (link: string) => void;
  showStopRetrying: boolean;
  onStopRetrying: () => void;
  onSwitchProvider: () => void;
}) {
  return (
    <div class="chat-usage-limit-banner" role="status" aria-live="polite">
      <div class="chat-usage-limit-copy">
        <span class="chat-usage-limit-title">{props.title}</span>
        <span class="chat-usage-limit-meta">{props.meta}</span>
        <span class="chat-usage-limit-message">{props.message}</span>
      </div>
      <div class="chat-usage-limit-actions">
        <button type="button" class="chat-usage-limit-action" onClick={props.onPrimaryAction}>
          {props.primaryActionLabel}
        </button>
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
        <button type="button" class="chat-usage-limit-action" onClick={props.onSwitchProvider}>
          Switch provider
        </button>
      </div>
    </div>
  );
}
