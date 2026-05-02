import { For, Show } from 'solid-js';
import type { QueuedMessage } from '../../lib/app-state-types';

export type QueuedMessageItem = Pick<
  QueuedMessage,
  'id' | 'sessionId' | 'text' | 'droppedFiles' | 'clipboardImages' | 'terminalSelection'
>;

export function QueuedMessages(props: {
  items: QueuedMessageItem[];
  onSendAsSteer: (item: QueuedMessageItem) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div class="chat-queue-container" role="list" aria-label="Queued messages">
      <For each={props.items}>
        {(item) => {
          const attachmentCount =
            (item.droppedFiles?.length || 0) +
            (item.clipboardImages?.length || 0) +
            (item.terminalSelection ? 1 : 0);
          const label =
            item.text ||
            (attachmentCount === 1 ? '1 attachment' : `${attachmentCount} attachments`);
          return (
            <div class="chat-queue-item" role="listitem" title={item.text || label}>
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
                <span class="chat-queue-label">{label}</span>
                <Show when={attachmentCount > 0}>
                  <span class="chat-queue-meta">
                    <span class="chat-queue-attachment-icon" aria-hidden="true">
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
                        <path d="M10.5 5.5l-4.24 4.24a2 2 0 102.83 2.83l4.6-4.59a3 3 0 00-4.24-4.24L4.5 8.69a4 4 0 105.66 5.66l4.1-4.1" />
                      </svg>
                    </span>
                    <span>{attachmentCount}</span>
                  </span>
                </Show>
              </div>
              <div class="chat-queue-actions">
                <button
                  class="chat-queue-action"
                  onClick={() => props.onSendAsSteer(item)}
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
          );
        }}
      </For>
    </div>
  );
}
