import { createSignal, onCleanup } from 'solid-js';
import { formatClockTime } from '../../lib/message-time';
import type { CompactionPart } from '../../types';

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
    const kind = props.part.auto ? 'auto' : 'manual';
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
  );
}
