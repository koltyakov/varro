import { Show } from 'solid-js';
import { getSpinnerPhaseDelayStyle } from './spinner-phase';

const RUNNING_BADGE_SPINNER_DURATION_MS = 900;

export function RunningSessionsBadge(props: { count: number; onClick: () => void }) {
  const label = () => `${props.count} running session${props.count === 1 ? '' : 's'}`;

  return (
    <Show when={props.count > 0}>
      <button
        type="button"
        class="chat-header-running-badge"
        title={label()}
        aria-label={label()}
        onClick={props.onClick}
      >
        <span
          class="chat-header-running-spinner"
          style={getSpinnerPhaseDelayStyle(RUNNING_BADGE_SPINNER_DURATION_MS)}
          aria-hidden="true"
        />
        <span class="chat-header-running-count">{props.count}</span>
      </button>
    </Show>
  );
}

export function AttentionSessionsBadge(props: { count: number; onClick: () => void }) {
  const label = 'Sessions waiting for input or permission';

  return (
    <Show when={props.count > 0}>
      <button
        type="button"
        class="chat-header-attention-badge"
        title={label}
        aria-label={label}
        onClick={props.onClick}
      >
        <span class="chat-header-attention-dot" aria-hidden="true" />
      </button>
    </Show>
  );
}

export function FailedSessionsBadge(props: { count: number; onClick: () => void }) {
  const label = 'Failed sessions';

  return (
    <Show when={props.count > 0}>
      <button
        type="button"
        class="chat-header-failed-badge"
        title={label}
        aria-label={label}
        onClick={props.onClick}
      >
        <span class="chat-header-failed-dot" aria-hidden="true" />
      </button>
    </Show>
  );
}

export function PlanReadyBadge(props: { count: number; onClick: () => void }) {
  const label = 'Completed plans ready in another chat';

  return (
    <Show when={props.count > 0}>
      <button
        type="button"
        class="chat-header-plan-badge"
        title={label}
        aria-label={label}
        onClick={props.onClick}
      >
        <span class="chat-header-plan-dot" aria-hidden="true" />
      </button>
    </Show>
  );
}

export function CompletedSessionsBadge(props: { count: number; onClick: () => void }) {
  const label = 'Completed sessions';

  return (
    <Show when={props.count > 0}>
      <button
        type="button"
        class="chat-header-completed-badge"
        title={label}
        aria-label={label}
        onClick={props.onClick}
      >
        <span class="chat-header-completed-dot" aria-hidden="true" />
      </button>
    </Show>
  );
}
