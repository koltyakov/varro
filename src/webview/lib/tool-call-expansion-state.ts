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
// Reasoning blocks that auto-expanded for a streaming run and have not
// settled yet. Rows are recreated on every part commit, so the in-flight
// auto-open must survive the recreation to collapse when the run finishes.
const reasoningPendingAutoCollapseKeys = new Set<string>();
// Tool calls that auto-expanded for a running invocation and have not
// settled yet. Rows are recreated on every part commit, so the in-flight
// auto-open must survive the recreation to collapse when the call finishes.
const toolCallPendingAutoCollapseKeys = new Set<string>();
// Reasoning blocks the user toggled manually; their stored state must survive
// row recreation even after the message settles.
const reasoningUserTouchedKeys = new Set<string>();
// Activity groups the user toggled manually; the auto expand/collapse
// lifecycle leaves those alone for the rest of the session.
const activityGroupUserManagedKeys = new Set<string>();
// Activity groups the lifecycle auto-expanded, so it may collapse them once
// every part in them settles.
const activityGroupAutoExpandedKeys = new Set<string>();
const [messageBlockExpansionVersion, setMessageBlockExpansionVersion] = createSignal(0);
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

export function markReasoningAutoOpened(key: string) {
  reasoningPendingAutoCollapseKeys.add(key);
}

export function clearReasoningAutoOpened(key: string) {
  reasoningPendingAutoCollapseKeys.delete(key);
}

export function takeReasoningAutoOpened(key: string) {
  if (reasoningPendingAutoCollapseKeys.has(key)) {
    reasoningPendingAutoCollapseKeys.delete(key);
    return true;
  }
  return false;
}

export function markReasoningUserTouched(key: string) {
  reasoningUserTouchedKeys.add(key);
}

export function isReasoningUserTouched(key: string) {
  return reasoningUserTouchedKeys.has(key);
}

export function markToolCallAutoOpened(key: string) {
  toolCallPendingAutoCollapseKeys.add(key);
}

export function clearToolCallAutoOpened(key: string) {
  toolCallPendingAutoCollapseKeys.delete(key);
}

export function takeToolCallAutoOpened(key: string) {
  if (toolCallPendingAutoCollapseKeys.has(key)) {
    toolCallPendingAutoCollapseKeys.delete(key);
    return true;
  }
  return false;
}

export function markActivityGroupUserManaged(key: string) {
  activityGroupUserManagedKeys.add(key);
  activityGroupAutoExpandedKeys.delete(key);
}

export function isActivityGroupUserManaged(key: string) {
  return activityGroupUserManagedKeys.has(key);
}

export function markActivityGroupAutoExpanded(key: string) {
  activityGroupAutoExpandedKeys.add(key);
}

export function takeActivityGroupAutoExpanded(key: string) {
  if (activityGroupAutoExpandedKeys.has(key)) {
    activityGroupAutoExpandedKeys.delete(key);
    return true;
  }
  return false;
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
  reasoningPendingAutoCollapseKeys.clear();
  reasoningUserTouchedKeys.clear();
  toolCallPendingAutoCollapseKeys.clear();
  activityGroupUserManagedKeys.clear();
  activityGroupAutoExpandedKeys.clear();
  toolDiffPreviewState.clear();
  setMessageBlockExpansionVersion((version) => version + 1);
}

export function getTrackedToolCallStateSize() {
  return {
    expansions: toolCallExpansionState.size,
    messageBlocks: messageBlockExpansionState.size,
    diffPreviews: toolDiffPreviewState.size,
  };
}
