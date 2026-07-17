import { For, Show, createSignal } from 'solid-js';
import type { QueuedMessage } from '../../lib/app-state-types';

export const QUEUED_MESSAGE_DRAG_TYPE = 'application/x-varro-queued-message';

export type QueuedMessageItem = Pick<
  QueuedMessage,
  'id' | 'sessionId' | 'text' | 'droppedFiles' | 'clipboardImages' | 'terminalSelection'
>;

export function QueuedMessages(props: {
  items: QueuedMessageItem[];
  dispatchingItemId?: string | null;
  failedDispatchItemIds?: ReadonlySet<string>;
  steeringItemIds?: ReadonlySet<string>;
  failedSteerItemIds?: ReadonlySet<string>;
  editingItemId?: string | null;
  canEdit: boolean;
  onRetryDispatch: (item: QueuedMessageItem) => void;
  onSendAsSteer: (item: QueuedMessageItem) => void;
  onReorder: (id: string, targetId: string) => void;
  onEdit: (item: QueuedMessageItem) => void;
  onCancelEdit: () => void;
  onRemove: (id: string) => void;
}) {
  const [draggedItemId, setDraggedItemId] = createSignal<string | null>(null);
  const [dragOverItemId, setDragOverItemId] = createSignal<string | null>(null);

  return (
    <div class="chat-queue-container" role="list" aria-label="Queued messages">
      <For each={props.items}>
        {(item, index) => {
          const isDispatching = () => props.dispatchingItemId === item.id;
          const isSteering = () => props.steeringItemIds?.has(item.id) ?? false;
          const isInFlight = () => isDispatching() || isSteering();
          const isEditing = () => props.editingItemId === item.id;
          const isLocked = () => isInFlight() || isEditing();
          const didDispatchFail = () => props.failedDispatchItemIds?.has(item.id) ?? false;
          const didSteerFail = () => props.failedSteerItemIds?.has(item.id) ?? false;
          const attachmentCount =
            (item.droppedFiles?.length || 0) +
            (item.clipboardImages?.length || 0) +
            (item.terminalSelection ? 1 : 0);
          const label =
            item.text ||
            (attachmentCount === 1 ? '1 attachment' : `${attachmentCount} attachments`);
          const startDragging = (event: DragEvent) => {
            if (isLocked() || !event.dataTransfer) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(QUEUED_MESSAGE_DRAG_TYPE, item.id);
            const row = (event.currentTarget as HTMLElement).closest<HTMLElement>(
              '.chat-queue-item'
            );
            if (row) event.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2);
            setDraggedItemId(item.id);
          };
          const dragOverItem = (event: DragEvent) => {
            const sourceId =
              draggedItemId() || event.dataTransfer?.getData(QUEUED_MESSAGE_DRAG_TYPE);
            if (!sourceId || sourceId === item.id) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            setDragOverItemId(item.id);
          };
          const dropOnItem = (event: DragEvent) => {
            const sourceId =
              draggedItemId() || event.dataTransfer?.getData(QUEUED_MESSAGE_DRAG_TYPE);
            if (!sourceId) return;
            event.preventDefault();
            event.stopPropagation();
            if (sourceId !== item.id) props.onReorder(sourceId, item.id);
            setDraggedItemId(null);
            setDragOverItemId(null);
          };
          const reorderWithKeyboard = (event: KeyboardEvent) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            const targetIndex = index() + (event.key === 'ArrowUp' ? -1 : 1);
            const targetId = props.items[targetIndex]?.id;
            if (!targetId) return;
            event.preventDefault();
            props.onReorder(item.id, targetId);
          };
          return (
            <div
              class={`chat-queue-item${draggedItemId() === item.id ? ' is-dragging' : ''}${dragOverItemId() === item.id ? ' is-drag-over' : ''}${isEditing() ? ' is-editing' : ''}`}
              role="listitem"
              title={item.text || label}
              onDragEnter={dragOverItem}
              onDragOver={dragOverItem}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                if (dragOverItemId() === item.id) setDragOverItemId(null);
              }}
              onDrop={dropOnItem}
            >
              <div class="chat-queue-body">
                <button
                  type="button"
                  class="chat-queue-drag-handle"
                  draggable={!isLocked()}
                  disabled={isLocked()}
                  onDragStart={startDragging}
                  onDragEnd={() => {
                    setDraggedItemId(null);
                    setDragOverItemId(null);
                  }}
                  onKeyDown={reorderWithKeyboard}
                  title="Drag to reorder queued message"
                  aria-label={`Reorder queued message: ${label}`}
                  aria-grabbed={draggedItemId() === item.id}
                >
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="5" cy="3" r="1" />
                    <circle cx="11" cy="3" r="1" />
                    <circle cx="5" cy="8" r="1" />
                    <circle cx="11" cy="8" r="1" />
                    <circle cx="5" cy="13" r="1" />
                    <circle cx="11" cy="13" r="1" />
                  </svg>
                </button>
                <span class="chat-queue-label">{label}</span>
                <Show when={isEditing()}>
                  <span class="chat-queue-editing-label">Editing</span>
                </Show>
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
                  onClick={() =>
                    didDispatchFail() ? props.onRetryDispatch(item) : props.onSendAsSteer(item)
                  }
                  disabled={isLocked()}
                  title={
                    isDispatching()
                      ? 'Sending queued message'
                      : isEditing()
                        ? 'Cancel editing before sending as Steer'
                        : didDispatchFail()
                          ? 'Retry queued message'
                          : isSteering()
                            ? 'Sending as Steer'
                            : didSteerFail()
                              ? 'Retry send as Steer'
                              : 'Send now as Steer'
                  }
                  aria-label={didDispatchFail() ? 'Retry queued message' : 'Send as Steer'}
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
                  <span class="chat-queue-action-label">
                    {isDispatching()
                      ? 'Sending...'
                      : didDispatchFail()
                        ? 'Retry'
                        : isSteering()
                          ? 'Steering...'
                          : didSteerFail()
                            ? 'Retry Steer'
                            : 'Steer'}
                  </span>
                </button>
                <button
                  class={`chat-queue-icon-action${isEditing() ? ' is-active' : ''}`}
                  onClick={() => (isEditing() ? props.onCancelEdit() : props.onEdit(item))}
                  disabled={isInFlight() || (!isEditing() && !props.canEdit)}
                  title={
                    isEditing()
                      ? 'Cancel queued message edit'
                      : props.canEdit
                        ? 'Edit queued message'
                        : 'Clear the current prompt before editing a queued message'
                  }
                  aria-label={isEditing() ? 'Cancel queued message edit' : 'Edit queued message'}
                >
                  <Show
                    when={isEditing()}
                    fallback={
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M10.5 2.5l3 3L5 14H2v-3zM9 4l3 3" />
                      </svg>
                    }
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M3 4v4h4M3.5 7.5a5 5 0 119 3" />
                    </svg>
                  </Show>
                </button>
                <button
                  class="chat-queue-remove"
                  onClick={() => props.onRemove(item.id)}
                  disabled={isLocked()}
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
