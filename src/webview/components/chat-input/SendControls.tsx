import { Show } from 'solid-js';

function SendIcon(props: { size: number }) {
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 32 32" fill="currentColor">
      <polygon
        points="15.707,3.293 14.293,4.707 24.586,15 4,15 4,17 24.586,17 14.293,27.293 15.707,28.707 28.414,16"
        transform="rotate(-90 16 16)"
      />
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
          class="send-mode-options"
          onClick={props.onToggleBusyMenu}
          title="More send options"
        >
          <svg width="12" height="12" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true">
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M8.625 2.5C8.625 3.12132 8.12132 3.625 7.5 3.625C6.87868 3.625 6.375 3.12132 6.375 2.5C6.375 1.87868 6.87868 1.375 7.5 1.375C8.12132 1.375 8.625 1.87868 8.625 2.5ZM8.625 7.5C8.625 8.12132 8.12132 8.625 7.5 8.625C6.87868 8.625 6.375 8.12132 6.375 7.5C6.375 6.87868 6.87868 6.375 7.5 6.375C8.12132 6.375 8.625 6.87868 8.625 7.5ZM7.5 13.625C8.12132 13.625 8.625 13.1213 8.625 12.5C8.625 11.8787 8.12132 11.375 7.5 11.375C6.87868 11.375 6.375 11.8787 6.375 12.5C6.375 13.1213 6.87868 13.625 7.5 13.625Z"
            />
          </svg>
        </button>
      </div>
    </Show>
  );
}
