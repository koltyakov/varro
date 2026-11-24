const COPYING_CLASS = 'is-copying-truncated-paths';
const WRAPPER_SELECTOR = '.path-middle-truncate';

let serializationBound = false;

function selectionHasTruncatedPath(selection = window.getSelection()): boolean {
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const node = selection.getRangeAt(index).commonAncestorContainer;
    const element = node instanceof Element ? node : node.parentElement;
    if (element?.closest(WRAPPER_SELECTOR) || element?.querySelector(WRAPPER_SELECTOR)) return true;
  }
  return false;
}

// Flex items serialize as blocks, which adds line breaks around the path in copied text.
// Inline layout is restored only while the browser serializes the selection, then reverted
// before the next frame paints or reports a resize.
function restoreInlineLayoutForSerialization(): void {
  const root = document.documentElement;
  if (root.classList.contains(COPYING_CLASS) || !selectionHasTruncatedPath()) return;
  root.classList.add(COPYING_CLASS);
  requestAnimationFrame(() => root.classList.remove(COPYING_CLASS));
}

/**
 * Read selection text as it would be copied. Inline layout is applied and reverted
 * synchronously, so it never paints or reaches resize observers.
 */
export function selectionText(selection: Selection): string {
  const root = document.documentElement;
  if (root.classList.contains(COPYING_CLASS) || !selectionHasTruncatedPath(selection))
    return selection.toString();
  root.classList.add(COPYING_CLASS);
  try {
    return selection.toString();
  } finally {
    root.classList.remove(COPYING_CLASS);
  }
}

function bindSerialization(): void {
  if (serializationBound) return;
  serializationBound = true;
  document.addEventListener('copy', restoreInlineLayoutForSerialization, true);
  document.addEventListener('dragstart', restoreInlineLayoutForSerialization, true);
}

/**
 * Split a path label after the icon so CSS can elide its middle and keep the file name.
 * Table cells keep wrapping the full path.
 */
export function middleTruncatePathLabel(anchor: HTMLAnchorElement): void {
  const [leadingContent, rest, ...extra] = Array.from(anchor.childNodes);
  if (
    anchor.closest('table') ||
    !(leadingContent instanceof HTMLElement) ||
    !leadingContent.classList.contains('link-leading-content') ||
    extra.length > 0 ||
    (rest && !(rest instanceof Text))
  )
    return;
  const label = leadingContent.querySelector('.link-leading-label');
  const text = label?.textContent ?? '';
  const end = text.replace(/[\\/]+$/, '').length;
  const separator = Math.max(text.lastIndexOf('/', end - 1), text.lastIndexOf('\\', end - 1));
  if (!label || separator <= 0) return;

  label.textContent = text.slice(0, separator);
  const trailing = document.createElement('span');
  trailing.className = 'link-trailing-label';
  trailing.textContent = `${text.slice(separator)}${rest?.data ?? ''}`;
  rest?.remove();
  const wrapper = document.createElement('span');
  wrapper.className = 'path-middle-truncate';
  wrapper.append(leadingContent, trailing);
  anchor.append(wrapper);
  bindSerialization();
}
