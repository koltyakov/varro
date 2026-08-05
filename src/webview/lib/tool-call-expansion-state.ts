import { createSignal } from 'solid-js';

// Interactive block state is only cleared when the session changes, so a
// long-running session (e.g. a Ralph loop) would otherwise accumulate entries
// for the whole run. The cap sits far above what a user can realistically have
// scrolled through, so evicting the least recently touched entry never discards
// state that is still on screen.
const MAX_TRACKED_ENTRIES = 2_000;

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
  while (store.size > MAX_TRACKED_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

const toolCallExpansionState = new Map<string, boolean>();
const messageBlockExpansionState = new Map<string, boolean>();
const [messageBlockExpansionVersion, setMessageBlockExpansionVersion] = createSignal(0);
const fileEditPagerSelectionState = new Map<string, string>();
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

export function getMessageBlockExpanded(key: string) {
  return readEntry(messageBlockExpansionState, key);
}

export function setMessageBlockExpanded(key: string, expanded: boolean) {
  writeEntry(messageBlockExpansionState, key, expanded);
  setMessageBlockExpansionVersion((version) => version + 1);
}

export function trackMessageBlockExpansionState() {
  messageBlockExpansionVersion();
}

export function getFileEditPagerSelection(key: string) {
  return readEntry(fileEditPagerSelectionState, key) ?? null;
}

export function setFileEditPagerSelection(key: string, pageId: string) {
  writeEntry(fileEditPagerSelectionState, key, pageId);
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
  messageBlockExpansionState.clear();
  fileEditPagerSelectionState.clear();
  toolDiffPreviewState.clear();
  setMessageBlockExpansionVersion((version) => version + 1);
}

export function getTrackedToolCallStateSize() {
  return {
    expansions: toolCallExpansionState.size,
    messageBlocks: messageBlockExpansionState.size,
    fileEditPages: fileEditPagerSelectionState.size,
    diffPreviews: toolDiffPreviewState.size,
  };
}
