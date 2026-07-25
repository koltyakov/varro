export type MessageHistoryNavigationInput = {
  /** Prompts for the active session, oldest first. */
  history: string[];
  /** Index into `history` the composer is currently showing, or null when showing the draft. */
  currentIndex: number | null;
  /** Current composer text. */
  inputText: string;
  sessionId: string | null;
  /** -1 walks toward older prompts, 1 walks back toward the draft. */
  direction: -1 | 1;
};

export type MessageHistoryNavigation =
  /** Navigation does not apply; leave the composer untouched. */
  | { kind: 'ignore' }
  /** Stash the draft but go no further, because there is nothing newer to move to. */
  | { kind: 'stash-draft' }
  /** Page in older prompts from the server before a target index can be chosen. */
  | {
      kind: 'load-older';
      sessionId: string;
      previousLength: number;
      previousIndex: number | null;
      stashDraft: boolean;
    }
  /** Walked past the newest prompt; put the stashed draft back. */
  | { kind: 'restore-draft' }
  /** Show `history[index]` in the composer. */
  | { kind: 'select'; index: number; stashDraft: boolean };

/**
 * Decides what an up/down history keypress should do, without touching composer state.
 *
 * Keeping this pure makes the index arithmetic and its edge cases (empty history, walking off
 * either end, an in-progress draft) testable in isolation; the caller applies the result.
 */
export function planMessageHistoryNavigation(
  input: MessageHistoryNavigationInput
): MessageHistoryNavigation {
  const { history, currentIndex, inputText, sessionId, direction } = input;

  // Typing something new takes precedence: history navigation must not discard it.
  if (currentIndex === null && inputText.length > 0) return { kind: 'ignore' };

  if (history.length === 0) {
    if (direction !== -1 || !sessionId) return { kind: 'ignore' };
    return {
      kind: 'load-older',
      sessionId,
      previousLength: 0,
      previousIndex: null,
      stashDraft: true,
    };
  }

  const stashDraft = currentIndex === null;

  if (currentIndex === null) {
    // Moving newer from the draft has nowhere to go, but the draft is still stashed to match
    // the behavior of entering history from the composer.
    if (direction !== -1) return { kind: 'stash-draft' };
    return { kind: 'select', index: history.length - 1, stashDraft };
  }

  const nextIndex = currentIndex + direction;

  if (nextIndex < 0) {
    if (!sessionId) return { kind: 'ignore' };
    return {
      kind: 'load-older',
      sessionId,
      previousLength: history.length,
      previousIndex: currentIndex,
      stashDraft: false,
    };
  }

  if (nextIndex >= history.length) return { kind: 'restore-draft' };

  return { kind: 'select', index: nextIndex, stashDraft };
}
