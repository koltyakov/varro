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
