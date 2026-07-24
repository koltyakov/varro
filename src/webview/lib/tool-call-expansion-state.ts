// Expansion state is keyed per tool call and only cleared when the session
// changes, so a long-running session (e.g. a Ralph loop) would otherwise
// accumulate entries for the whole run. The cap sits far above what a user can
// realistically have scrolled through, so evicting the least recently touched
// entry never discards state that is still on screen.
const MAX_TRACKED_TOOL_CALLS = 2_000;

function readEntry<T>(store: Map<string, T>, key: string) {
  const value = store.get(key);
  if (value === undefined) return undefined;
  // Refresh recency so entries the user keeps interacting with outlive stale ones.
  store.delete(key);
  store.set(key, value);
  return value;
}

function writeEntry<T>(store: Map<string, T>, key: string, value: T) {
  store.delete(key);
  store.set(key, value);
  while (store.size > MAX_TRACKED_TOOL_CALLS) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

const toolCallExpansionState = new Map<string, boolean>();
const toolDiffPreviewState = new Map<
  string,
  { expanded: boolean; scrollTop: number; scrollLeft: number }
>();

export function getToolCallExpanded(key: string) {
  return readEntry(toolCallExpansionState, key) ?? false;
}

export function setToolCallExpanded(key: string, expanded: boolean) {
  writeEntry(toolCallExpansionState, key, expanded);
}

export function getToolDiffPreviewState(key: string) {
  return readEntry(toolDiffPreviewState, key) ?? null;
}

export function setToolDiffPreviewState(
  key: string,
  state: { expanded: boolean; scrollTop: number; scrollLeft: number }
) {
  writeEntry(toolDiffPreviewState, key, state);
}

export function resetToolCallExpansionState() {
  toolCallExpansionState.clear();
  toolDiffPreviewState.clear();
}

export function getTrackedToolCallStateSize() {
  return {
    expansions: toolCallExpansionState.size,
    diffPreviews: toolDiffPreviewState.size,
  };
}
