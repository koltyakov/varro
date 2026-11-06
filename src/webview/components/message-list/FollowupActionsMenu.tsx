import { onCleanup, onMount } from 'solid-js';
import { observePopupViewport } from '../../lib/popup-position';

export function FollowupActionsMenu(props: {
  x: number;
  y: number;
  onClose: () => void;
  onCopy: () => void;
  onQueue: () => void;
}) {
  let menu!: HTMLDivElement;
  const previousFocus = document.activeElement;
  onMount(() => {
    onCleanup(
      observePopupViewport(menu, () => {
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(props.x, window.innerWidth - rect.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(props.y, window.innerHeight - rect.height - 8))}px`;
      })
    );
    // Positioning reveals the menu in a microtask. Hidden menu items cannot receive focus.
    queueMicrotask(() => {
      if (menu.isConnected)
        menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    });
    const outside = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      props.onClose();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('contextmenu', outside, true);
    window.addEventListener('focusin', outside);
    onCleanup(() => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('contextmenu', outside, true);
      window.removeEventListener('focusin', outside);
      if (menu.contains(document.activeElement) && previousFocus instanceof HTMLElement)
        previousFocus.focus({ preventScroll: true });
    });
  });
  return (
    <div
      ref={(element) => {
        menu = element;
      }}
      class="session-item-actions-menu"
      role="menu"
      aria-label="Follow-up actions"
      data-popup-position-pending
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button'));
          const index = items.findIndex((item) => item === document.activeElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus({ preventScroll: true });
        }
      }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={(event) => {
          event.stopPropagation();
          props.onCopy();
        }}
      >
        Copy description
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={(event) => {
          event.stopPropagation();
          props.onQueue();
        }}
      >
        Add to queue (paused)
      </button>
    </div>
  );
}
