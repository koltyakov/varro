import { Show } from 'solid-js';
import { Tooltip } from '../Tooltip';
import { UiIcon } from '../UiIcon';
import { hourglassIcon } from '../../lib/ui-icons';

const HEADER_BADGE_TOOLTIP_DELAY_MS = 1000;

type SessionsBadgeProps = { count: number; onClick: () => void };

export function PendingSessionsBadge(props: SessionsBadgeProps) {
  const label = 'Sessions pending background tasks';
  return (
    <Show when={props.count > 0}>
      <Tooltip content={label} delay={HEADER_BADGE_TOOLTIP_DELAY_MS}>
        <button
          type="button"
          class="chat-header-pending-badge"
          aria-label={label}
          onClick={props.onClick}
        >
          <UiIcon source={hourglassIcon} width={14} height={14} />
        </button>
      </Tooltip>
    </Show>
  );
}

export function RunningSessionsBadge(props: SessionsBadgeProps) {
  const label = () => `${props.count} running session${props.count === 1 ? '' : 's'}`;

  return (
    <Show when={props.count > 0}>
      <Tooltip content={label()} delay={HEADER_BADGE_TOOLTIP_DELAY_MS}>
        <button
          type="button"
          class="chat-header-running-badge"
          aria-label={label()}
          onClick={props.onClick}
        >
          <span class="chat-header-running-spinner" aria-hidden="true" />
          <span class="chat-header-running-count">{props.count}</span>
        </button>
      </Tooltip>
    </Show>
  );
}

function DotBadge(props: SessionsBadgeProps & { label: string; class: string; dotClass: string }) {
  return (
    <Show when={props.count > 0}>
      <Tooltip content={props.label} delay={HEADER_BADGE_TOOLTIP_DELAY_MS}>
        <button type="button" class={props.class} aria-label={props.label} onClick={props.onClick}>
          <span class={props.dotClass} aria-hidden="true" />
        </button>
      </Tooltip>
    </Show>
  );
}

export function AttentionSessionsBadge(props: SessionsBadgeProps) {
  return (
    <DotBadge
      {...props}
      label="Sessions waiting for input or permission"
      class="chat-header-attention-badge"
      dotClass="chat-header-attention-dot"
    />
  );
}

export function FailedSessionsBadge(props: SessionsBadgeProps) {
  return (
    <DotBadge
      {...props}
      label="Failed sessions"
      class="chat-header-failed-badge"
      dotClass="chat-header-failed-dot"
    />
  );
}

export function PlanReadyBadge(props: SessionsBadgeProps) {
  return (
    <DotBadge
      {...props}
      label="Completed plans ready in another chat"
      class="chat-header-plan-badge"
      dotClass="chat-header-plan-dot"
    />
  );
}

export function CompletedSessionsBadge(props: SessionsBadgeProps) {
  return (
    <DotBadge
      {...props}
      label="Completed sessions"
      class="chat-header-completed-badge"
      dotClass="chat-header-completed-dot"
    />
  );
}
