const toolCallExpansionState = new Map<string, boolean>();

export function getToolCallExpanded(key: string) {
  return toolCallExpansionState.get(key) ?? false;
}

export function setToolCallExpanded(key: string, expanded: boolean) {
  toolCallExpansionState.set(key, expanded);
}

export function resetToolCallExpansionState() {
  toolCallExpansionState.clear();
}
