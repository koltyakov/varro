import { Show } from 'solid-js';

export function StopButton(props: { compact: boolean; onStop: () => void }) {
  return (
    <button
      class={`toolbar-picker stop-button ${props.compact ? 'compact' : ''}`}
      onClick={props.onStop}
      title="Stop"
      aria-label="Stop"
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
        <rect x="3" y="3" width="10" height="10" rx="1.5" />
      </svg>
      <Show when={!props.compact}>
        <span class="toolbar-picker-label">Stop</span>
      </Show>
    </button>
  );
}
