/**
 * Top edge of the visually usable area for a popup, in viewport coordinates.
 *
 * The viewport top alone is not a safe bound: when the composer relocates
 * inline for message editing it lives inside the scrollable message list,
 * and the sticky chat header stacks above popups. Scrollable ancestors mark
 * where that chrome begins, so popups are kept below it.
 */
function getPopupTopBound(el: HTMLElement, margin: number): number {
  let bound = margin;
  let node = el.parentElement;
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') {
      bound = Math.max(bound, node.getBoundingClientRect().top + margin);
    }
    node = node.parentElement;
  }
  return bound;
}

/**
 * Adjust an absolutely positioned popup so it stays within the viewport.
 *
 * Resets any prior inline shifts before measuring, then applies horizontal
 * and vertical translations to keep the popup inside the viewport with a
 * small margin.
 */
export function clampPopupToViewport(el: HTMLElement, margin = 8): void {
  el.style.transform = '';
  el.style.maxHeight = '';

  const rect = el.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let dx = 0;
  let dy = 0;

  if (rect.right > viewportWidth - margin) {
    dx = viewportWidth - margin - rect.right;
  }
  if (rect.left + dx < margin) {
    dx += margin - (rect.left + dx);
  }

  const topBound = getPopupTopBound(el, margin);
  if (rect.top < topBound) {
    dy = topBound - rect.top;
  }

  const transforms: string[] = [];
  if (dx !== 0) transforms.push(`translateX(${dx}px)`);
  if (dy !== 0) transforms.push(`translateY(${dy}px)`);
  if (transforms.length > 0) el.style.transform = transforms.join(' ');

  // Cap height if even after translating the popup still overflows vertically.
  const adjustedRect = el.getBoundingClientRect();
  if (adjustedRect.bottom > viewportHeight - margin) {
    const maxHeight = Math.max(0, viewportHeight - margin - adjustedRect.top);
    el.style.maxHeight = `${maxHeight}px`;
  }
}

export function alignPopupToBoundary(
  el: HTMLElement,
  boundaryEl: HTMLElement,
  side: 'left' | 'right'
): void {
  const positionedAncestor =
    el.offsetParent instanceof HTMLElement
      ? el.offsetParent
      : el.parentElement instanceof HTMLElement
        ? el.parentElement
        : null;
  if (!positionedAncestor) return;

  const parentRect = positionedAncestor.getBoundingClientRect();
  const boundaryRect = boundaryEl.getBoundingClientRect();

  if (side === 'left') {
    el.style.right = 'auto';
    el.style.left = `${Math.round(boundaryRect.left - parentRect.left)}px`;
    return;
  }

  el.style.left = 'auto';
  el.style.right = `${Math.round(parentRect.right - boundaryRect.right)}px`;
}

/**
 * Flip an upward-opening popup (anchored `bottom: 100%` inside a relative
 * trigger wrapper) to open downward when it would be clipped above and there
 * is more room below the trigger. Returns whether the popup now opens down.
 *
 * Resets any previous flip before measuring so the stylesheet's upward
 * anchoring is what gets measured, and mirrors the popup's natural gap from
 * its trigger when flipped.
 */
export function flipPopupDownIfNeeded(el: HTMLElement, margin = 8): boolean {
  el.style.top = '';
  el.style.bottom = '';

  const anchor = el.offsetParent;
  if (!(anchor instanceof HTMLElement)) return false;

  const rect = el.getBoundingClientRect();
  const topBound = getPopupTopBound(el, margin);
  if (rect.top >= topBound) return false;

  const anchorRect = anchor.getBoundingClientRect();
  const spaceAbove = anchorRect.top - topBound;
  const spaceBelow = window.innerHeight - margin - anchorRect.bottom;
  if (spaceBelow <= spaceAbove) return false;

  const gap = Math.max(0, Math.round(anchorRect.top - rect.bottom));
  el.style.bottom = 'auto';
  el.style.top = `calc(100% + ${gap}px)`;
  return true;
}

/**
 * Position a full-width dropdown (a `.dropdown-anchor` wrapping a
 * `.dropdown-menu`) that opens above its host input container by default.
 *
 * Flips the anchor below the host when the menu would be clipped above and
 * there is more room below, moving the gap padding to the matching side, and
 * caps the menu height to whichever side it ends up on.
 *
 * When `liftAboveEl` is given, an upward-opening menu is raised so its bottom
 * clears that element's top instead of the host's top. The composer relocates
 * inline for message editing with an "Editing message" banner stacked above
 * the input host; without this the menu would paint on top of that banner
 * rather than above the whole editing block.
 */
export function placeDropdownAnchor(
  anchorEl: HTMLElement,
  menuEl: HTMLElement,
  gap: number,
  margin = 8,
  liftAboveEl?: HTMLElement | null
): void {
  let lift = 0;
  if (liftAboveEl) {
    const host = anchorEl.offsetParent;
    if (host instanceof HTMLElement) {
      lift = Math.max(
        0,
        Math.round(host.getBoundingClientRect().top - liftAboveEl.getBoundingClientRect().top)
      );
    }
  }

  anchorEl.style.bottom = lift > 0 ? `calc(100% + ${lift}px)` : '100%';
  anchorEl.style.top = 'auto';
  anchorEl.style.paddingTop = '0px';
  anchorEl.style.paddingBottom = `${gap}px`;
  menuEl.style.maxHeight = '';

  const rect = menuEl.getBoundingClientRect();
  const topBound = getPopupTopBound(menuEl, margin);
  if (rect.top >= topBound) return;

  const host = anchorEl.offsetParent instanceof HTMLElement ? anchorEl.offsetParent : null;
  if (host) {
    const hostRect = host.getBoundingClientRect();
    const bottomBound = window.innerHeight - margin;
    const spaceAbove = hostRect.top - topBound;
    const spaceBelow = bottomBound - hostRect.bottom;
    if (spaceBelow > spaceAbove) {
      anchorEl.style.bottom = 'auto';
      anchorEl.style.top = '100%';
      anchorEl.style.paddingTop = `${gap}px`;
      anchorEl.style.paddingBottom = '0px';
      const flippedRect = menuEl.getBoundingClientRect();
      if (flippedRect.bottom > bottomBound) {
        menuEl.style.maxHeight = `${Math.max(0, bottomBound - flippedRect.top)}px`;
      }
      return;
    }
  }

  // Stay anchored above; cap the menu to the space between the top bound and
  // its bottom edge so it scrolls instead of escaping the safe area.
  menuEl.style.maxHeight = `${Math.max(0, rect.bottom - topBound)}px`;
}

export function observePopupViewport(el: HTMLElement, reposition: () => void): () => void {
  const run = () => queueMicrotask(reposition);

  run();
  window.addEventListener('resize', run);

  if (typeof ResizeObserver === 'undefined') {
    return () => window.removeEventListener('resize', run);
  }

  const observer = new ResizeObserver(run);
  observer.observe(el);

  return () => {
    window.removeEventListener('resize', run);
    observer.disconnect();
  };
}
