import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { QueuedMessage } from '../../lib/app-state-types';
import { observeSettledResize } from '../../lib/settled-resize-observer';

export const QUEUED_MESSAGE_DRAG_TYPE = 'application/x-varro-queued-message';

export type QueuedMessageItem = Pick<
  QueuedMessage,
  'id' | 'sessionId' | 'text' | 'droppedFiles' | 'clipboardImages' | 'terminalSelection'
>;

function bindQueueOverflowFade(element: HTMLElement, trackItemCount: () => number) {
  const update = () => {
    const maxScrollTop = element.scrollHeight - element.clientHeight;
    element.classList.toggle('has-more-above', element.scrollTop > 1);
    element.classList.toggle('has-more-below', element.scrollTop < maxScrollTop - 1);
  };

  element.addEventListener('scroll', update, { passive: true });
  const stopObservingResize = observeSettledResize(element, update);
  createEffect(() => {
    trackItemCount();
    queueMicrotask(update);
  });
  onCleanup(() => {
    element.removeEventListener('scroll', update);
    stopObservingResize();
  });
}

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
    <div class={`chat-queue-container${draggedItemId() ? ' is-reordering' : ''}`}>
      <div
        class="chat-queue-list"
        role="list"
        aria-label="Queued messages"
        ref={(element) => bindQueueOverflowFade(element, () => props.items.length)}
      >
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
                    class="chat-queue-control chat-queue-drag-handle"
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
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
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
                </div>
                <Show when={attachmentCount > 0}>
                  <span
                    class="chat-queue-meta"
                    title={`${attachmentCount} ${attachmentCount === 1 ? 'attachment' : 'attachments'}`}
                  >
                    <span class="chat-queue-attachment-icon" aria-hidden="true">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.25"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M10.5 5.5l-4.24 4.24a2 2 0 102.83 2.83l4.6-4.59a3 3 0 00-4.24-4.24L4.5 8.69a4 4 0 105.66 5.66l4.1-4.1" />
                      </svg>
                    </span>
                    <span>{attachmentCount}</span>
                  </span>
                </Show>
                <div class="chat-queue-actions">
                  <button
                    class={`chat-queue-control chat-queue-action${isInFlight() ? ' is-pending' : ''}${didDispatchFail() || didSteerFail() ? ' is-error' : ''}`}
                    onClick={() =>
                      didDispatchFail() ? props.onRetryDispatch(item) : props.onSendAsSteer(item)
                    }
                    disabled={isLocked()}
                    hidden={isLocked()}
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
                    aria-label={
                      didDispatchFail()
                        ? 'Retry queued message'
                        : didSteerFail()
                          ? 'Retry send as Steer'
                          : 'Send as Steer'
                    }
                    aria-busy={isInFlight()}
                  >
                    <Show
                      when={didDispatchFail() || didSteerFail()}
                      fallback={
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.6"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M12 21V3M12 3l8.5 8.5M12 3l-8.5 8.5" />
                        </svg>
                      }
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M19.5 9A8 8 0 105 17.5M19.5 4.5V9H15" />
                      </svg>
                    </Show>
                  </button>
                  <button
                    class={`chat-queue-control chat-queue-icon-action${isEditing() ? ' is-active' : ''}`}
                    onClick={() => (isEditing() ? props.onCancelEdit() : props.onEdit(item))}
                    disabled={isInFlight() || (!isEditing() && !props.canEdit)}
                    hidden={isInFlight() || (!isEditing() && !props.canEdit)}
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
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.6"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M14.3632 5.65156l1.4799-1.47999a2 2 0 012.8285 0l1.4142 1.41422a2 2 0 010 2.82842l-1.48 1.47999M14.3632 5.65156l-9.61571 9.61564a2 2 0 00-.57802 1.2382l-.24209 2.7405a1 1 0 001.08412 1.0841l2.74041-.2421a2 2 0 001.23822-.578l9.61567-9.6157M14.3632 5.65156l4.2426 4.24264" />
                        </svg>
                      }
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M4.5 8H15s5 0 5 4.7059C20 18 15 18 15 18H6.28571" />
                        <path d="M7.5 11.5L4 8l3.5-3.5" />
                      </svg>
                    </Show>
                  </button>
                  <button
                    class="chat-queue-control chat-queue-remove"
                    onClick={() => props.onRemove(item.id)}
                    disabled={isLocked()}
                    hidden={isLocked()}
                    title="Remove from queue"
                    aria-label="Remove from queue"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 9l-1.995 11.3463A2 2 0 0116.0353 22H7.96474a2 2 0 01-1.96978-1.6537L4 9" />
                      <path d="M21 6h-5.625M3 6h5.625m0 0V4a2 2 0 012-2h2.75a2 2 0 012 2v2m-6.75 0h6.75" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
