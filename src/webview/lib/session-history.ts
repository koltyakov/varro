export type SessionHistoryEntry = {
  sessionId: string;
  directory?: string;
};

export type SessionHistoryState = {
  entries: readonly SessionHistoryEntry[];
  /** Index of the entry that matches the session opened most recently, or -1 when empty. */
  index: number;
};

export type SessionHistoryDirection = 'back' | 'forward';

export const SESSION_HISTORY_MAX_ENTRIES = 100;

export const EMPTY_SESSION_HISTORY: SessionHistoryState = { entries: [], index: -1 };

/**
 * Records an opened session like a browser page visit: reopening the current
 * entry is a no-op, while opening another session drops forward entries.
 */
export function recordSessionHistory(
  history: SessionHistoryState,
  sessionId: string,
  directory?: string
): SessionHistoryState {
  const current = history.entries[history.index];
  if (current?.sessionId === sessionId) {
    if (!directory || current.directory === directory) return history;
    const entries = history.entries.slice();
    entries[history.index] = { sessionId, directory };
    return { entries, index: history.index };
  }

  const entries = [
    ...history.entries.slice(0, history.index + 1),
    directory ? { sessionId, directory } : { sessionId },
  ];
  const overflow = Math.max(0, entries.length - SESSION_HISTORY_MAX_ENTRIES);
  const trimmed = overflow > 0 ? entries.slice(overflow) : entries;
  return { entries: trimmed, index: trimmed.length - 1 };
}

/** Drops a deleted session and merges neighbours that become duplicates. */
export function removeFromSessionHistory(
  history: SessionHistoryState,
  sessionId: string
): SessionHistoryState {
  if (!history.entries.some((entry) => entry.sessionId === sessionId)) return history;

  const entries: SessionHistoryEntry[] = [];
  let index = -1;
  history.entries.forEach((entry, entryIndex) => {
    if (entry.sessionId !== sessionId) {
      if (entries.at(-1)?.sessionId !== entry.sessionId) entries.push(entry);
    }
    if (entryIndex === history.index) index = entries.length - 1;
  });
  if (entries.length === 0) return EMPTY_SESSION_HISTORY;
  return { entries, index: Math.max(0, index) };
}

function getTargetIndex(
  history: SessionHistoryState,
  direction: SessionHistoryDirection,
  activeSessionId: string | null
): number {
  if (direction === 'forward') return history.index + 1;
  // A new-chat draft is not an entry, so Back first returns to the current entry.
  return history.entries[history.index]?.sessionId === activeSessionId
    ? history.index - 1
    : history.index;
}

export function canNavigateSessionHistory(
  history: SessionHistoryState,
  direction: SessionHistoryDirection,
  activeSessionId: string | null
): boolean {
  const targetIndex = getTargetIndex(history, direction, activeSessionId);
  return targetIndex >= 0 && targetIndex < history.entries.length;
}

export function navigateSessionHistory(
  history: SessionHistoryState,
  direction: SessionHistoryDirection,
  activeSessionId: string | null
): { history: SessionHistoryState; entry: SessionHistoryEntry } | null {
  const targetIndex = getTargetIndex(history, direction, activeSessionId);
  const entry = history.entries[targetIndex];
  if (!entry) return null;
  return { history: { entries: history.entries, index: targetIndex }, entry };
}
