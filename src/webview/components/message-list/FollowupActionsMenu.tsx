import { For, onSettled } from 'solid-js';
import { observePopupViewport } from '../../lib/popup-position';

export type ActionsMenuItem = { label: string; title?: string; onSelect: () => void };

export function FollowupActionsMenu(props: {
  x: number;
  y: number;
  onClose: () => void;
  onCopy: () => void;
  onQueue: () => void;
  onRunInNewSession: () => void;
}) {
  return (
    <ActionsMenu
      x={props.x}
      y={props.y}
      label="Follow-up actions"
      onClose={props.onClose}
      items={[
        { label: 'Copy description', onSelect: props.onCopy },
        { label: 'Add to queue (paused)', onSelect: props.onQueue },
        { label: 'Run in new session', onSelect: props.onRunInNewSession },
      ]}
    />
  );
}

/** A floating menu that takes focus, supports arrow keys, and closes on outside interaction. */
export function ActionsMenu(props: {
  x: number;
  y: number;
  label: string;
  items: ActionsMenuItem[];
  onClose: () => void;
}) {
  let menu!: HTMLDivElement;
  const previousFocus = document.activeElement;
  onSettled(() => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
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
    cleanups.push(() => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('contextmenu', outside, true);
      window.removeEventListener('focusin', outside);
      const lostFocusOnRemoval = !menu.isConnected && document.activeElement === document.body;
      if (
        (menu.contains(document.activeElement) || lostFocusOnRemoval) &&
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected
      )
        previousFocus.focus({ preventScroll: true });
    });

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });
  return (
    <div
      ref={(element) => {
        menu = element;
      }}
      class="session-item-actions-menu"
      role="menu"
      aria-label={props.label}
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
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="menuitem"
            title={item.title}
            onClick={(event) => {
              event.stopPropagation();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        )}
      </For>
    </div>
  );
}
