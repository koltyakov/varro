const roots = new Set<HTMLElement>();
const painted = new Set<HTMLElement>();
let pendingFrame: number | undefined;

function clearHighlight(element: HTMLElement): void {
  element.classList.remove('file-icon-selected');
  element.style.removeProperty('--file-selection-width');
  painted.delete(element);
}

function update(): void {
  pendingFrame = undefined;
  const selection = window.getSelection();
  const ranges =
    selection && !selection.isCollapsed
      ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
      : [];
  const highlights = new Map<HTMLElement, number>();

  // Read every selected label before writing styles. Unselected roots need no geometry reads.
  for (const root of roots) {
    if (!root.isConnected || !ranges.some((range) => range.intersectsNode(root))) continue;
    for (const icon of root.querySelectorAll('.link-leading-content > img.file-path-icon')) {
      const wrapper = icon.parentElement;
      const label = wrapper?.querySelector('.link-leading-label');
      const text = label?.firstChild;
      if (!wrapper || !label || !(text instanceof Text) || !text.length) continue;
      const firstCharacterLength = Array.from(text.data)[0]?.length ?? 1;
      if (
        !ranges.some(
          (range) =>
            range.comparePoint(text, 0) === 0 &&
            range.comparePoint(text, firstCharacterLength) === 0
        )
      )
        continue;

      const labelBox = label.getBoundingClientRect();
      const wrapperBox = wrapper.getBoundingClientRect();
      highlights.set(wrapper, labelBox.left - wrapperBox.left);
    }
  }

  for (const element of painted) {
    if (!highlights.has(element)) clearHighlight(element);
  }
  for (const [element, width] of highlights) {
    const pixels = `${width}px`;
    if (element.style.getPropertyValue('--file-selection-width') !== pixels)
      element.style.setProperty('--file-selection-width', pixels);
    if (!painted.has(element)) element.classList.add('file-icon-selected');
    painted.add(element);
  }
}

function schedule(): void {
  if (pendingFrame === undefined) pendingFrame = requestAnimationFrame(update);
}

// All mounted renderers share one listener and one read/write pass per selection frame.
export const markdownCitationSelection = {
  bind(root: HTMLElement): () => void {
    if (!roots.size) {
      document.addEventListener('selectionchange', schedule);
      window.addEventListener('resize', schedule);
    }
    roots.add(root);
    if (window.getSelection()?.rangeCount) schedule();
    return () => {
      roots.delete(root);
      for (const element of painted) {
        if (root.contains(element) || !element.isConnected) clearHighlight(element);
      }
      if (roots.size) return;
      document.removeEventListener('selectionchange', schedule);
      window.removeEventListener('resize', schedule);
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
      pendingFrame = undefined;
    };
  },
};
