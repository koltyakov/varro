import { Show } from 'solid-js';

function SendIcon(props: { size: number }) {
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 2.5L3.5 7H6v6.5h4V7h2.5L8 2.5z" />
    </svg>
  );
}

export function SendControls(props: {
  showBusyControls: boolean;
  canSend: boolean;
  busyToggleRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  onSend: () => void;
  onToggleBusyMenu: () => void;
}) {
  return (
    <Show
      when={props.showBusyControls}
      fallback={
        <button
          class={`chat-send-button ${props.canSend ? 'enabled' : 'disabled'}`}
          onClick={() => props.canSend && props.onSend()}
          disabled={!props.canSend}
          title="Send (Enter)"
        >
          <SendIcon size={14} />
        </button>
      }
    >
      <div class="send-button-group">
        <button
          class="chat-send-button enabled send-main"
          onClick={props.onSend}
          title="Add to queue (Enter)"
        >
          <SendIcon size={14} />
        </button>
        <button
          ref={props.busyToggleRef}
          class="send-mode-chevron"
          onClick={props.onToggleBusyMenu}
          title="More send options"
        >
          <svg
            width="8"
            height="8"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 10l4-4 4 4" />
          </svg>
        </button>
      </div>
    </Show>
  );
}
