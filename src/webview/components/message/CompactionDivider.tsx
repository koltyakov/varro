import { Show, createSignal, onCleanup } from 'solid-js';
import { formatClockTime } from '../../lib/message-time';
import { compressIcon } from '../../lib/ui-icons';
import type { CompactionPart } from '../../types';
import { UiIcon } from '../UiIcon';

const HOVER_INTENT_DELAY_MS = 300;

export function CompactionDivider(props: {
  part: CompactionPart;
  timestamp: number;
  showTimestamp?: boolean;
  suppressTimestampAnimation?: boolean;
}) {
  let hoverIntentTimer: ReturnType<typeof setTimeout> | undefined;
  const [isHoverIntentActive, setIsHoverIntentActive] = createSignal(false);
  const label = () => {
    if (!props.part.auto) {
      if (props.part.status === 'running') return 'Compacting context';
      if (props.part.status === 'failed') {
        return `Context compaction failed${props.part.error ? `: ${props.part.error}` : ''}`;
      }
      return 'Context compacted manually';
    }
    const kind = props.part.auto ? 'auto' : 'manual';
    if (props.part.status === 'running') return `Compacting context (${kind})`;
    if (props.part.status === 'failed') {
      return `Context compaction failed (${kind})${props.part.error ? `: ${props.part.error}` : ''}`;
    }
    return props.part.overflow
      ? `Context compacted (${kind}, after overflow)`
      : `Context compacted (${kind})`;
  };
  const setHovering = (hovering: boolean) => {
    if (hoverIntentTimer) {
      clearTimeout(hoverIntentTimer);
      hoverIntentTimer = undefined;
    }
    if (!hovering) {
      setIsHoverIntentActive(false);
      return;
    }
    hoverIntentTimer = setTimeout(() => {
      hoverIntentTimer = undefined;
      setIsHoverIntentActive(true);
    }, HOVER_INTENT_DELAY_MS);
  };
  onCleanup(() => {
    if (hoverIntentTimer) clearTimeout(hoverIntentTimer);
  });

  return (
    <Show
      when={props.part.auto}
      fallback={
        <div
          class="chat-turn chat-turn-user chat-turn-manual-compaction"
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
        >
          <div class="value chat-turn-content chat-turn-card user-message-card user-message-card-wrapperless manual-compaction-action">
            <span class="manual-compaction-action-label" role="note">
              <UiIcon source={compressIcon} width={14} height={14} />
              {label()}
            </span>
          </div>
          <time
            class={`message-sent-time${props.showTimestamp || isHoverIntentActive() ? ' is-visible' : ''}${props.suppressTimestampAnimation ? ' is-animation-suppressed' : ''}`}
            dateTime={new Date(props.timestamp).toISOString()}
            aria-hidden={!props.showTimestamp && !isHoverIntentActive()}
          >
            {formatClockTime(props.timestamp)}
          </time>
        </div>
      }
    >
      <div
        class={`model-change-indicator assistant-dialog-summary message-compaction-divider${props.showTimestamp || isHoverIntentActive() ? ' is-completion-time-visible' : ''}${isHoverIntentActive() ? ' is-hover-intent-active' : ''}`}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <div class="assistant-dialog-summary-content">
          <time
            class={`assistant-dialog-summary-completed-time${props.suppressTimestampAnimation ? ' is-animation-suppressed' : ''}`}
            dateTime={new Date(props.timestamp).toISOString()}
          >
            <span class="assistant-dialog-summary-completed-time-text">
              {formatClockTime(props.timestamp)}
            </span>
          </time>
          <span class="model-change-label">{label()}</span>
        </div>
      </div>
    </Show>
  );
}
