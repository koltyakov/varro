import { createSignal } from 'solid-js';

const expandedOwners = new Map<symbol, (() => void) | undefined>();
const [expandedOwnerCount, setExpandedOwnerCount] = createSignal(0);

export function hasExpandedDiffOverlay() {
  return expandedOwnerCount() > 0;
}

export function collapseExpandedDiffOverlays() {
  for (const collapse of expandedOwners.values()) collapse?.();
}

export function setExpandedDiffOverlay(owner: symbol, expanded: boolean, collapse?: () => void) {
  const wasExpanded = expandedOwners.has(owner);
  if (expanded) expandedOwners.set(owner, collapse);
  else expandedOwners.delete(owner);
  if (expanded === wasExpanded) return;
  setExpandedOwnerCount(expandedOwners.size);
}
