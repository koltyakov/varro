// Focus management for `aria-modal="true"` overlays. Declaring a dialog modal tells assistive
// technology that the rest of the page is inert, so the dialog has to actually hold focus:
// move focus in on open, keep Tab inside, and hand focus back to the opener on close.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute('aria-hidden') !== 'true' && !element.hasAttribute('hidden')
  );
}

function focusFirst(container: HTMLElement) {
  const focusable = getFocusableElements(container);
  (focusable[0] ?? container).focus();
}

// Overlays can stack (an image preview opened from inside read mode), and two backstops both
// reclaiming focus would ping-pong forever. Only the most recently opened dialog enforces.
const openTraps: HTMLElement[] = [];

/**
 * Traps keyboard focus inside a modal overlay for as long as it is mounted.
 *
 * Returns a cleanup function that restores focus to whatever was focused when the trap was
 * installed, matching the `prepareMeasuredEntrance` convention so callers can pass it straight
 * to `onCleanup`.
 */
export function trapModalFocus(container: HTMLElement): () => void {
  const previouslyFocused =
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;

  // The container itself is the fallback focus target when it holds no focusable controls, so it
  // needs to be programmatically focusable without entering the tab order.
  if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;

    const focusable = getFocusableElements(container);
    if (focusable.length === 0) {
      // Nothing to cycle through; keep focus pinned to the dialog rather than letting Tab
      // walk into the page behind it.
      event.preventDefault();
      container.focus();
      return;
    }

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === container)) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Backstop for focus that arrives from outside the keydown path, such as a programmatic
  // focus() elsewhere in the app or the browser restoring focus after a window switch.
  const handleFocusIn = (event: FocusEvent) => {
    if (openTraps[openTraps.length - 1] !== container) return;
    const target = event.target;
    if (target instanceof Node && container.contains(target)) return;
    focusFirst(container);
  };

  openTraps.push(container);
  container.addEventListener('keydown', handleKeydown);
  document.addEventListener('focusin', handleFocusIn);

  // `ref` callbacks fire before the element is attached to the document, and focus() does
  // nothing on a detached node, so entry focus waits for the element to land in the DOM.
  let released = false;
  queueMicrotask(() => {
    if (released || !container.isConnected) return;
    focusFirst(container);
  });

  return () => {
    if (released) return;
    released = true;
    const index = openTraps.lastIndexOf(container);
    if (index !== -1) openTraps.splice(index, 1);
    container.removeEventListener('keydown', handleKeydown);
    document.removeEventListener('focusin', handleFocusIn);
    // Only reclaim focus if the dialog still owns it. If something else took focus in the
    // meantime, moving it again would be the more surprising behavior.
    if (previouslyFocused?.isConnected && container.contains(document.activeElement)) {
      previouslyFocused.focus();
    }
  };
}
