import type { SessionListFilter } from '../components/chat/SessionListView';

export type SessionHistoryEntry =
  | { type: 'session'; sessionId: string; directory?: string }
  | { type: 'list'; filter: SessionListFilter | null; subagentParentId: string | null };

/** What the chat currently shows; `null` is an unsent new-chat draft, which is not an entry. */
export type SessionHistoryView = SessionHistoryEntry | null;

export type SessionHistoryState = {
  entries: readonly SessionHistoryEntry[];
  /** Index of the entry for the view shown most recently, or -1 when empty. */
  index: number;
};

export type SessionHistoryDirection = 'back' | 'forward';

export type SessionHistoryNavigationOptions = {
  /** Whether the full session list can be shown; list entries are skipped otherwise. */
  canShowList: boolean;
};

export const SESSION_HISTORY_MAX_ENTRIES = 100;

export const EMPTY_SESSION_HISTORY: SessionHistoryState = { entries: [], index: -1 };

/** Entries in the same slot are one history step; list filter changes update the entry. */
function isSameSlot(left: SessionHistoryEntry | undefined, right: SessionHistoryEntry): boolean {
  if (!left || left.type !== right.type) return false;
  return left.type === 'list' || (right.type === 'session' && left.sessionId === right.sessionId);
}

function isSameEntry(left: SessionHistoryEntry, right: SessionHistoryEntry): boolean {
  if (left.type === 'session' && right.type === 'session') {
    return left.sessionId === right.sessionId && left.directory === right.directory;
  }
  if (left.type === 'list' && right.type === 'list') {
    return left.filter === right.filter && left.subagentParentId === right.subagentParentId;
  }
  return false;
}

/**
 * Records a shown view like a browser page visit: staying in the current slot
 * updates its entry, while moving to another view drops forward entries.
 */
export function recordSessionHistory(
  history: SessionHistoryState,
  view: SessionHistoryEntry
): SessionHistoryState {
  const current = history.entries[history.index];
  if (current && isSameSlot(current, view)) {
    // A session can report its directory after it opens; keep the known one until then.
    const next =
      view.type === 'session' && current.type === 'session' && !view.directory ? current : view;
    if (isSameEntry(current, next)) return history;
    const entries = history.entries.slice();
    entries[history.index] = next;
    return { entries, index: history.index };
  }

  const entries = [...history.entries.slice(0, history.index + 1), view];
  const overflow = Math.max(0, entries.length - SESSION_HISTORY_MAX_ENTRIES);
  const trimmed = overflow > 0 ? entries.slice(overflow) : entries;
  return { entries: trimmed, index: trimmed.length - 1 };
}

/**
 * Drops a deleted session, widens sub-agent lists it owned to the full list,
 * and merges neighbours that become the same step.
 */
export function removeFromSessionHistory(
  history: SessionHistoryState,
  sessionId: string
): SessionHistoryState {
  const affected = history.entries.some((entry) =>
    entry.type === 'session' ? entry.sessionId === sessionId : entry.subagentParentId === sessionId
  );
  if (!affected) return history;

  const entries: SessionHistoryEntry[] = [];
  let index = -1;
  history.entries.forEach((entry, entryIndex) => {
    if (entry.type !== 'session' || entry.sessionId !== sessionId) {
      const kept: SessionHistoryEntry =
        entry.type === 'list' && entry.subagentParentId === sessionId
          ? { type: 'list', filter: null, subagentParentId: null }
          : entry;
      const previous = entries.at(-1);
      if (previous && isSameSlot(previous, kept)) {
        // Prefer the later view of a merged step, as reopening it would have.
        entries[entries.length - 1] = kept;
      } else {
        entries.push(kept);
      }
    }
    if (entryIndex === history.index) index = entries.length - 1;
  });
  if (entries.length === 0) return EMPTY_SESSION_HISTORY;
  return { entries, index: Math.max(0, index) };
}

function findTargetIndex(
  history: SessionHistoryState,
  direction: SessionHistoryDirection,
  view: SessionHistoryView,
  options: SessionHistoryNavigationOptions
): number {
  const step = direction === 'back' ? -1 : 1;
  const current = history.entries[history.index];
  // A view that is not an entry (such as a new-chat draft) returns to the current entry first.
  let index =
    direction === 'back' && !(current && view && isSameSlot(current, view))
      ? history.index
      : history.index + step;
  while (index >= 0 && index < history.entries.length) {
    const entry = history.entries[index]!;
    if (entry.type === 'session' || options.canShowList) return index;
    index += step;
  }
  return -1;
}

export function canNavigateSessionHistory(
  history: SessionHistoryState,
  direction: SessionHistoryDirection,
  view: SessionHistoryView,
  options: SessionHistoryNavigationOptions
): boolean {
  return findTargetIndex(history, direction, view, options) !== -1;
}

export function navigateSessionHistory(
  history: SessionHistoryState,
  direction: SessionHistoryDirection,
  view: SessionHistoryView,
  options: SessionHistoryNavigationOptions
): { history: SessionHistoryState; entry: SessionHistoryEntry } | null {
  const targetIndex = findTargetIndex(history, direction, view, options);
  const entry = history.entries[targetIndex];
  if (!entry) return null;
  return { history: { entries: history.entries, index: targetIndex }, entry };
}
