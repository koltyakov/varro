import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { QueuedMessage } from '../../lib/app-state-types';
import { observeSettledResize } from '../../lib/settled-resize-observer';

export const QUEUED_MESSAGE_DRAG_TYPE = 'application/x-varro-queued-message';

export type QueuedMessageItem = Pick<
  QueuedMessage,
  'id' | 'sessionId' | 'text' | 'paused' | 'droppedFiles' | 'clipboardImages' | 'terminalSelection'
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
  canSendImmediately: boolean;
  onRetryDispatch: (item: QueuedMessageItem) => void;
  onSendAsSteer: (item: QueuedMessageItem) => void;
  onSetPaused: (item: QueuedMessageItem, paused: boolean, allRows: boolean) => void;
  onReorder: (id: string, targetId: string) => void;
  onEdit: (item: QueuedMessageItem) => void;
  onCancelEdit: () => void;
  onRemove: (id: string) => void;
}) {
  const [draggedItemId, setDraggedItemId] = createSignal<string | null>(null);
  const [dragOverItemId, setDragOverItemId] = createSignal<string | null>(null);
  const [isAltPressed, setIsAltPressed] = createSignal(false);

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Alt') setIsAltPressed(true);
  };
  const handleKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'Alt') setIsAltPressed(false);
  };
  const handleBlur = () => setIsAltPressed(false);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleBlur);
  onCleanup(() => {
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    window.removeEventListener('blur', handleBlur);
  });

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
            const imageCount = item.clipboardImages?.length || 0;
            const attachmentCount =
              (item.droppedFiles?.length || 0) + (item.terminalSelection ? 1 : 0);
            const label =
              item.text ||
              [
                imageCount > 0 ? `${imageCount} ${imageCount === 1 ? 'image' : 'images'}` : '',
                attachmentCount > 0
                  ? `${attachmentCount} ${attachmentCount === 1 ? 'attachment' : 'attachments'}`
                  : '',
              ]
                .filter(Boolean)
                .join(', ');
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
                class={`chat-queue-item${item.paused ? ' is-paused' : ''}${draggedItemId() === item.id ? ' is-dragging' : ''}${dragOverItemId() === item.id ? ' is-drag-over' : ''}${isEditing() ? ' is-editing' : ''}`}
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
                    <Show
                      when={draggedItemId() || isAltPressed()}
                      fallback={
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                          <circle cx="5" cy="3" r="1" />
                          <circle cx="11" cy="3" r="1" />
                          <circle cx="5" cy="8" r="1" />
                          <circle cx="11" cy="8" r="1" />
                          <circle cx="5" cy="13" r="1" />
                          <circle cx="11" cy="13" r="1" />
                        </svg>
                      }
                    >
                      <span class="chat-queue-position" aria-hidden="true">
                        {index() + 1}
                      </span>
                    </Show>
                  </button>
                  <span class="chat-queue-label">{label}</span>
                  <Show when={item.paused}>
                    <span class="chat-queue-paused-label">Paused</span>
                  </Show>
                </div>
                <Show when={attachmentCount > 0 || imageCount > 0}>
                  <span class="chat-queue-meta">
                    <Show when={imageCount > 0}>
                      <span
                        class="chat-queue-meta-item"
                        title={`${imageCount} ${imageCount === 1 ? 'image' : 'images'}`}
                        aria-label={`${imageCount} ${imageCount === 1 ? 'image' : 'images'}`}
                      >
                        <span class="chat-queue-image-icon" aria-hidden="true">
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <rect x="2" y="3" width="12" height="10" rx="1.5" />
                            <circle cx="5.5" cy="6.5" r="1" />
                            <path d="M3 11l3-3 2.5 2.5L11 7l2 2" />
                          </svg>
                        </span>
                        <span>{imageCount}</span>
                      </span>
                    </Show>
                    <Show when={attachmentCount > 0}>
                      <span
                        class="chat-queue-meta-item"
                        title={`${attachmentCount} ${attachmentCount === 1 ? 'attachment' : 'attachments'}`}
                        aria-label={`${attachmentCount} ${attachmentCount === 1 ? 'attachment' : 'attachments'}`}
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
                  </span>
                </Show>
                <div class="chat-queue-actions">
                  <Show when={isEditing()}>
                    <span class="chat-queue-editing-label">Editing</span>
                  </Show>
                  <button
                    class={`chat-queue-control chat-queue-icon-action${item.paused ? ' is-active' : ''}`}
                    onClick={(event) => props.onSetPaused(item, !item.paused, event.altKey)}
                    disabled={isLocked()}
                    hidden={isLocked()}
                    title={`${item.paused ? 'Play' : 'Pause'} queued message (Option/Alt-click for all)`}
                    aria-label={`${item.paused ? 'Play' : 'Pause'} queued message`}
                    aria-pressed={item.paused === true}
                  >
                    <Show
                      when={item.paused}
                      fallback={
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.6"
                          aria-hidden="true"
                        >
                          <path d="M6 18.4V5.6C6 5.26863 6.26863 5 6.6 5H9.4C9.73137 5 10 5.26863 10 5.6V18.4C10 18.7314 9.73137 19 9.4 19H6.6C6.26863 19 6 18.7314 6 18.4Z" />
                          <path d="M14 18.4V5.6C14 5.26863 14.2686 5 14.6 5H17.4C17.7314 5 18 5.26863 18 5.6V18.4C18 18.7314 17.7314 19 17.4 19H14.6C14.2686 19 14 18.7314 14 18.4Z" />
                        </svg>
                      }
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M6.90588 4.53682C6.50592 4.2998 6 4.58808 6 5.05299V18.947C6 19.4119 6.50592 19.7002 6.90588 19.4632L18.629 12.5162C19.0211 12.2838 19.0211 11.7162 18.629 11.4838L6.90588 4.53682Z" />
                      </svg>
                    </Show>
                  </button>
                  <button
                    class={`chat-queue-control chat-queue-action${isInFlight() ? ' is-pending' : ''}${didDispatchFail() || didSteerFail() ? ' is-error' : ''}`}
                    onClick={() =>
                      didDispatchFail() ? props.onRetryDispatch(item) : props.onSendAsSteer(item)
                    }
                    disabled={isLocked() || !props.canSendImmediately}
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
                                : !props.canSendImmediately
                                  ? 'Resolve the pending request before sending immediately'
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
