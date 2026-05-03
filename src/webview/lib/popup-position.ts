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

  if (rect.top < margin) {
    dy = margin - rect.top;
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

/**
 * Cap an upward-opening popup to the space available above its anchored bottom edge.
 *
 * This preserves the popup's bottom alignment and only enables scrolling when the
 * natural height would overflow past the top viewport margin.
 */
export function clampAnchoredPopupHeight(el: HTMLElement, margin = 8): void {
  el.style.maxHeight = '';

  const rect = el.getBoundingClientRect();
  const maxHeight = Math.max(0, rect.bottom - margin);

  if (rect.top < margin) {
    el.style.maxHeight = `${maxHeight}px`;
  }
}

export function observePopupViewport(
  el: HTMLElement,
  reposition: () => void
): () => void {
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
