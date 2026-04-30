import { For } from 'solid-js';

export type QueuedMessageItem = {
  id: string;
  text: string;
};

export function QueuedMessages(props: {
  items: QueuedMessageItem[];
  onSendAsSteer: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div class="chat-queue-container" role="list" aria-label="Queued messages">
      <For each={props.items}>
        {(item) => (
          <div class="chat-queue-item" role="listitem" title={item.text}>
            <div class="chat-queue-body">
              <span class="chat-queue-icon" aria-hidden="true">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M3 4h10M3 8h10M3 12h6" />
                </svg>
              </span>
              <span class="chat-queue-label">{item.text}</span>
            </div>
            <div class="chat-queue-actions">
              <button
                class="chat-queue-action"
                onClick={() => props.onSendAsSteer(item.id, item.text)}
                title="Send now as Steer"
                aria-label="Send as Steer"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.75"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M8 13V3M4 7l4-4 4 4" />
                </svg>
                <span class="chat-queue-action-label">Steer</span>
              </button>
              <button
                class="chat-queue-remove"
                onClick={() => props.onRemove(item.id)}
                title="Remove from queue"
                aria-label="Remove from queue"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
