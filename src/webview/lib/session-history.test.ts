import { describe, expect, it } from 'vitest';
import {
  EMPTY_SESSION_HISTORY,
  SESSION_HISTORY_MAX_ENTRIES,
  canNavigateSessionHistory,
  navigateSessionHistory,
  recordSessionHistory,
  removeFromSessionHistory,
  type SessionHistoryState,
} from './session-history';

function visit(...sessionIds: string[]): SessionHistoryState {
  return sessionIds.reduce(
    (history, sessionId) => recordSessionHistory(history, sessionId),
    EMPTY_SESSION_HISTORY
  );
}

function ids(history: SessionHistoryState) {
  return history.entries.map((entry) => entry.sessionId);
}

describe('session history', () => {
  it('records visits and ignores reopening the current session', () => {
    const history = visit('a', 'b', 'b', 'c');

    expect(ids(history)).toEqual(['a', 'b', 'c']);
    expect(history.index).toBe(2);
    expect(recordSessionHistory(history, 'c')).toBe(history);
  });

  it('moves back and forward without changing entries', () => {
    const history = visit('a', 'b', 'c');

    const back = navigateSessionHistory(history, 'back', 'c');
    expect(back?.entry.sessionId).toBe('b');
    expect(back?.history.index).toBe(1);

    const forward = navigateSessionHistory(back!.history, 'forward', 'b');
    expect(forward?.entry.sessionId).toBe('c');
    expect(ids(forward!.history)).toEqual(['a', 'b', 'c']);
  });

  it('drops forward entries when another session opens after going back', () => {
    const back = navigateSessionHistory(visit('a', 'b', 'c'), 'back', 'c')!;
    const history = recordSessionHistory(back.history, 'd');

    expect(ids(history)).toEqual(['a', 'b', 'd']);
    expect(canNavigateSessionHistory(history, 'forward', 'd')).toBe(false);
  });

  it('keeps forward entries when the target session finishes opening', () => {
    const back = navigateSessionHistory(visit('a', 'b', 'c'), 'back', 'c')!;

    expect(recordSessionHistory(back.history, 'b')).toBe(back.history);
  });

  it('returns to the current entry from a new chat draft', () => {
    const history = visit('a', 'b');

    expect(navigateSessionHistory(history, 'back', null)?.entry.sessionId).toBe('b');
    expect(navigateSessionHistory(history, 'back', 'b')?.entry.sessionId).toBe('a');
  });

  it('reports availability at both ends', () => {
    const history = visit('a', 'b');

    expect(canNavigateSessionHistory(EMPTY_SESSION_HISTORY, 'back', null)).toBe(false);
    expect(canNavigateSessionHistory(visit('a'), 'back', 'a')).toBe(false);
    expect(canNavigateSessionHistory(history, 'back', 'b')).toBe(true);
    expect(canNavigateSessionHistory(history, 'forward', 'b')).toBe(false);
    expect(navigateSessionHistory(history, 'forward', 'b')).toBeNull();
  });

  it('stores and refreshes the session directory', () => {
    let history = recordSessionHistory(EMPTY_SESSION_HISTORY, 'a');
    history = recordSessionHistory(history, 'a', '/repo');
    history = recordSessionHistory(history, 'b', '/other');

    expect(history.entries).toEqual([
      { sessionId: 'a', directory: '/repo' },
      { sessionId: 'b', directory: '/other' },
    ]);
  });

  it('removes deleted sessions and merges adjacent duplicates', () => {
    const history = removeFromSessionHistory(visit('a', 'b', 'a', 'c'), 'b');

    expect(ids(history)).toEqual(['a', 'c']);
    expect(history.index).toBe(1);
  });

  it('moves the current position to the previous entry when its session is deleted', () => {
    const back = navigateSessionHistory(visit('a', 'b', 'c'), 'back', 'c')!;
    const history = removeFromSessionHistory(back.history, 'b');

    expect(ids(history)).toEqual(['a', 'c']);
    expect(history.index).toBe(0);
    expect(navigateSessionHistory(history, 'back', 'b')?.entry.sessionId).toBe('a');
    expect(navigateSessionHistory(history, 'forward', 'b')?.entry.sessionId).toBe('c');
  });

  it('empties when the only session is deleted', () => {
    expect(removeFromSessionHistory(visit('a'), 'a')).toBe(EMPTY_SESSION_HISTORY);
    const history = visit('a');
    expect(removeFromSessionHistory(history, 'missing')).toBe(history);
  });

  it('caps the number of entries', () => {
    const sessionIds = Array.from(
      { length: SESSION_HISTORY_MAX_ENTRIES + 5 },
      (_, index) => `s${index}`
    );
    const history = visit(...sessionIds);

    expect(history.entries).toHaveLength(SESSION_HISTORY_MAX_ENTRIES);
    expect(history.entries[0]?.sessionId).toBe('s5');
    expect(history.index).toBe(SESSION_HISTORY_MAX_ENTRIES - 1);
  });
});
