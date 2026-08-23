import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { QueuedMessage } from '../../lib/app-state-types';
import {
  arrowUpIcon,
  attachmentIcon,
  editPencilIcon,
  mediaImageIcon,
  pauseIcon,
  playIcon,
  trashIcon,
  undoIcon,
} from '../../lib/ui-icons';
import { observeSettledResize } from '../../lib/settled-resize-observer';
import { UiIcon } from '../UiIcon';
import { RefreshIcon } from '../ControlIcons';

export const QUEUED_MESSAGE_DRAG_TYPE = 'application/x-varro-queued-message';

export type QueuedMessageItem = Pick<
  QueuedMessage,
  | 'id'
  | 'ownerViewId'
  | 'sessionId'
  | 'text'
  | 'paused'
  | 'droppedFiles'
  | 'clipboardImages'
  | 'terminalSelection'
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
            const [labelTruncated, setLabelTruncated] = createSignal(false);
            let labelRef: HTMLSpanElement | undefined;
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
              // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
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
                data-queued-message-id={item.id}
                data-queued-message-owner={item.ownerViewId ?? 'sidebar'}
                data-queued-message-session-id={item.sessionId}
                class={`chat-queue-item${item.paused ? ' is-paused' : ''}${draggedItemId() === item.id ? ' is-dragging' : ''}${dragOverItemId() === item.id ? ' is-drag-over' : ''}${isEditing() ? ' is-editing' : ''}`}
                role="listitem"
                onDragEnter={dragOverItem}
                onDragOver={dragOverItem}
                onDragLeave={(event) => {
                  // SAFETY: The surrounding shape or discriminator check establishes the Node contract used below.
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
                  <span
                    class="chat-queue-label"
                    title={labelTruncated() ? label : undefined}
                    ref={(element) => {
                      labelRef = element;
                    }}
                    onMouseEnter={() => {
                      setLabelTruncated(!!labelRef && labelRef.scrollWidth > labelRef.clientWidth);
                    }}
                  >
                    {label}
                  </span>
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
                          <UiIcon source={mediaImageIcon} width={12} height={12} />
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
                          <UiIcon source={attachmentIcon} width={12} height={12} />
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
                      fallback={<UiIcon source={pauseIcon} width={16} height={16} />}
                    >
                      <UiIcon source={playIcon} width={16} height={16} />
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
                      fallback={<UiIcon source={arrowUpIcon} width={14} height={14} />}
                    >
                      <RefreshIcon />
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
                      fallback={<UiIcon source={editPencilIcon} width={14} height={14} />}
                    >
                      <UiIcon source={undoIcon} width={14} height={14} />
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
                    <UiIcon source={trashIcon} width={14} height={14} />
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
