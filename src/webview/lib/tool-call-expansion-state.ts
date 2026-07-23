const toolCallExpansionState = new Map<string, boolean>();
const toolDiffPreviewState = new Map<
  string,
  { expanded: boolean; scrollTop: number; scrollLeft: number }
>();

export function getToolCallExpanded(key: string) {
  return toolCallExpansionState.get(key) ?? false;
}

export function setToolCallExpanded(key: string, expanded: boolean) {
  toolCallExpansionState.set(key, expanded);
}

export function getToolDiffPreviewState(key: string) {
  return toolDiffPreviewState.get(key) ?? null;
}

export function setToolDiffPreviewState(
  key: string,
  state: { expanded: boolean; scrollTop: number; scrollLeft: number }
) {
  toolDiffPreviewState.set(key, state);
}

export function resetToolCallExpansionState() {
  toolCallExpansionState.clear();
  toolDiffPreviewState.clear();
}
