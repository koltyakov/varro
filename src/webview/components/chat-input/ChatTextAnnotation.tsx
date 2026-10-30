import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { createChatAnnotation } from '../../../shared/chat-annotation';
import type { DroppedFile } from '../../../shared/protocol';
import { observePopupViewport } from '../../lib/popup-position';
import { writeClipboard } from '../../lib/write-clipboard';

type AnnotationSelection = {
  sessionId: string;
  text: string;
  x: number;
  y: number;
  bounds?: { top: number; bottom: number };
};

const SELECTION_HIGHLIGHT = 'varro-chat-annotation-selection';

export function ChatTextAnnotation(props: {
  chatRoot: () => HTMLElement | null;
  sessionId: string | null;
  onSave: (file: DroppedFile) => void;
}) {
  const [selection, setSelection] = createSignal<AnnotationSelection | null>(null);
  const [editing, setEditing] = createSignal(false);
  const [note, setNote] = createSignal('');
  const [error, setError] = createSignal('');
  let popup: HTMLDivElement | undefined;
  let selectionHighlight: Highlight | undefined;

  const clearHighlight = () => {
    if (
      selectionHighlight &&
      globalThis.CSS?.highlights?.get(SELECTION_HIGHLIGHT) === selectionHighlight
    ) {
      CSS.highlights.delete(SELECTION_HIGHLIGHT);
    }
    selectionHighlight = undefined;
  };
  onCleanup(clearHighlight);

  const close = () => {
    clearHighlight();
    if (popup?.contains(document.activeElement)) {
      props
        .chatRoot()
        ?.querySelector<HTMLElement>('.interactive-list')
        ?.focus({ preventScroll: true });
    }
    setSelection(null);
  };

  function open(event: MouseEvent) {
    if (event.defaultPrevented || !props.sessionId || !(event.target instanceof Element)) return;
    const root = props.chatRoot();
    const log = event.target.closest('.interactive-list');
    if (!root || !log || !root.contains(log)) return;
    if (event.target.closest('input, textarea, [contenteditable="true"], .chat-input-container'))
      return;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || selected.rangeCount === 0) return;
    const range = selected.getRangeAt(0);
    const inMessage = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement;
      return (
        log.contains(node) &&
        !!element?.closest('.interactive-item-container') &&
        !element?.closest('input, textarea, [contenteditable="true"], .chat-input-container')
      );
    };
    if (!inMessage(range.startContainer) || !inMessage(range.endContainer)) return;
    if (!range.intersectsNode(event.target)) return;
    const text = selected.toString().trim();
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    setNote('');
    setError('');
    setEditing(false);
    clearHighlight();
    if (globalThis.CSS?.highlights && globalThis.Highlight) {
      selectionHighlight = new Highlight(range.cloneRange());
      CSS.highlights.set(SELECTION_HIGHLIGHT, selectionHighlight);
    }
    const bounds = range.getBoundingClientRect?.();
    // Saved content is a text snapshot. The temporary highlight may collapse if virtual rows unmount.
    setSelection({
      sessionId: props.sessionId,
      text,
      x: event.clientX,
      y: event.clientY,
      bounds: bounds ? { top: bounds.top, bottom: bounds.bottom } : undefined,
    });
  }

  onMount(() => {
    let root = props.chatRoot();
    let disposed = false;
    root?.addEventListener('contextmenu', open);
    // The composer Portal attaches to its host after child mount callbacks run.
    queueMicrotask(() => {
      if (disposed || root) return;
      root = props.chatRoot();
      root?.addEventListener('contextmenu', open);
    });
    onCleanup(() => {
      disposed = true;
      root?.removeEventListener('contextmenu', open);
    });
  });

  createEffect(() => {
    const current = selection();
    if (current && current.sessionId !== props.sessionId) close();
  });

  createEffect(() => {
    if (!selection()) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && popup?.contains(event.target)) return;
      close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('contextmenu', outside, true);
    window.addEventListener('focusin', outside);
    window.addEventListener('keydown', escape, true);
    onCleanup(() => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('contextmenu', outside, true);
      window.removeEventListener('focusin', outside);
      window.removeEventListener('keydown', escape, true);
    });
  });

  createEffect(() => {
    const current = selection();
    const isEditing = editing();
    if (!current) return;
    let disposed = false;
    let stopObserving: (() => void) | undefined;
    queueMicrotask(() => {
      if (disposed || !popup) return;
      stopObserving = observePopupViewport(popup, () => {
        if (!popup) return;
        const rect = popup.getBoundingClientRect();
        const bounds = current.bounds;
        const top =
          isEditing && bounds
            ? bounds.bottom + 8 + rect.height <= window.innerHeight - 8
              ? bounds.bottom + 8
              : bounds.top - rect.height - 8 >= 8
                ? bounds.top - rect.height - 8
                : current.y
            : current.y;
        popup.style.left = `${Math.max(8, Math.min(current.x, window.innerWidth - rect.width - 8))}px`;
        popup.style.top = `${Math.max(8, Math.min(top, window.innerHeight - rect.height - 8))}px`;
      });
      popup.querySelector<HTMLElement>(isEditing ? 'textarea' : '[role="menuitem"]')?.focus({
        preventScroll: true,
      });
    });
    onCleanup(() => {
      disposed = true;
      stopObserving?.();
    });
  });

  function save() {
    const current = selection();
    if (!current || current.sessionId !== props.sessionId || !note().trim()) return;
    try {
      props.onSave(createChatAnnotation(current.text, note(), current.sessionId));
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save annotation.');
    }
  }

  return (
    <Show when={selection()}>
      {(current) => (
        <Portal>
          {/* The installed CSS optimizer does not recognize the Custom Highlight selector yet. */}
          <style data-chat-annotation-highlight>{`
            .interactive-list ::highlight(${SELECTION_HIGHLIGHT}) {
              background-color: var(--vscode-editor-selectionBackground, color-mix(in srgb, var(--color-vscode-accent) 30%, transparent));
              color: var(--color-vscode-fg);
            }
          `}</style>
          <div
            ref={(element) => {
              popup = element;
            }}
            class={`chat-annotation-popup dropdown-menu${editing() ? ' chat-annotation-editor' : ''}`}
            role={editing() ? 'dialog' : 'menu'}
            aria-label={editing() ? 'Annotate selected text' : 'Selected text actions'}
            data-popup-position-pending
            style={{ left: `${current().x}px`, top: `${current().y}px` }}
            onKeyDown={(event) => {
              if (editing() || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
              );
              const index = items.findIndex((item) => item === document.activeElement);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
              items[next]?.focus({ preventScroll: true });
            }}
          >
            <Show
              when={editing()}
              fallback={
                <>
                  <button
                    type="button"
                    class="dropdown-item"
                    role="menuitem"
                    onClick={() => setEditing(true)}
                  >
                    Annotate
                  </button>
                  <button
                    type="button"
                    class="dropdown-item"
                    role="menuitem"
                    onClick={() => {
                      void writeClipboard(current().text);
                      close();
                    }}
                  >
                    Copy
                  </button>
                </>
              }
            >
              <textarea
                aria-label="Annotation"
                placeholder="Add a note..."
                value={note()}
                onInput={(event) => {
                  setNote(event.currentTarget.value);
                  setError('');
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.ctrlKey || event.metaKey) &&
                    !event.isComposing
                  ) {
                    event.preventDefault();
                    save();
                  }
                }}
              />
              <Show when={error()}>
                <div class="chat-annotation-error" role="alert">
                  {error()}
                </div>
              </Show>
              <div class="chat-annotation-actions">
                <span class="chat-annotation-hint">
                  <kbd>Esc</kbd> to cancel
                </span>
                <button type="button" onClick={close}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="chat-annotation-save"
                  disabled={!note().trim()}
                  onClick={save}
                >
                  Save
                </button>
              </div>
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  );
}
