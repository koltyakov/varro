import { describe, expect, it } from 'vitest';
import { isString } from '../../shared/type-utils';
import {
  EMPTY_SESSION_HISTORY,
  SESSION_HISTORY_MAX_ENTRIES,
  canNavigateSessionHistory,
  navigateSessionHistory,
  recordSessionHistory,
  removeFromSessionHistory,
  type SessionHistoryEntry,
  type SessionHistoryState,
} from './session-history';

const LIST: SessionHistoryEntry = { type: 'list', filter: null, subagentParentId: null };
const NARROW = { canShowList: true };
const WIDE = { canShowList: false };

function session(sessionId: string, directory?: string): SessionHistoryEntry {
  return directory ? { type: 'session', sessionId, directory } : { type: 'session', sessionId };
}

function visit(...views: Array<string | SessionHistoryEntry>): SessionHistoryState {
  return views.reduce<SessionHistoryState>(
    (history, view) => recordSessionHistory(history, isString(view) ? session(view) : view),
    EMPTY_SESSION_HISTORY
  );
}

function labels(history: SessionHistoryState) {
  return history.entries.map((entry) => (entry.type === 'session' ? entry.sessionId : 'list'));
}

describe('session history', () => {
  it('records visits and ignores reopening the current session', () => {
    const history = visit('a', 'b', 'b', 'c');

    expect(labels(history)).toEqual(['a', 'b', 'c']);
    expect(history.index).toBe(2);
    expect(recordSessionHistory(history, session('c'))).toBe(history);
  });

  it('moves back and forward without changing entries', () => {
    const history = visit('a', 'b', 'c');

    const back = navigateSessionHistory(history, 'back', session('c'), NARROW);
    expect(back?.entry).toEqual(session('b'));
    expect(back?.history.index).toBe(1);

    const forward = navigateSessionHistory(back!.history, 'forward', session('b'), NARROW);
    expect(forward?.entry).toEqual(session('c'));
    expect(labels(forward!.history)).toEqual(['a', 'b', 'c']);
  });

  it('records the session list as a step before the session opened from it', () => {
    const history = visit(LIST, 'a', LIST, 'b');

    expect(labels(history)).toEqual(['list', 'a', 'list', 'b']);
    expect(navigateSessionHistory(history, 'back', session('b'), NARROW)?.entry).toEqual(LIST);
  });

  it('updates the current list entry when its filter changes', () => {
    const running: SessionHistoryEntry = {
      type: 'list',
      filter: 'running',
      subagentParentId: null,
    };
    const history = visit('a', LIST, running);

    expect(history.entries).toEqual([session('a'), running]);
    expect(recordSessionHistory(history, { ...running })).toBe(history);
  });

  it('skips list entries when the list cannot replace the chat', () => {
    const history = visit('a', LIST, 'b', LIST);
    const atB = navigateSessionHistory(history, 'back', LIST, NARROW)!;

    expect(navigateSessionHistory(atB.history, 'back', session('b'), WIDE)?.entry).toEqual(
      session('a')
    );
    expect(canNavigateSessionHistory(atB.history, 'forward', session('b'), WIDE)).toBe(false);
    expect(canNavigateSessionHistory(visit(LIST, 'a'), 'back', session('a'), WIDE)).toBe(false);
  });

  it('drops forward entries when another view opens after going back', () => {
    const back = navigateSessionHistory(visit('a', 'b', 'c'), 'back', session('c'), NARROW)!;
    const history = recordSessionHistory(back.history, session('d'));

    expect(labels(history)).toEqual(['a', 'b', 'd']);
    expect(canNavigateSessionHistory(history, 'forward', session('d'), NARROW)).toBe(false);
  });

  it('keeps forward entries when the target view finishes opening', () => {
    const back = navigateSessionHistory(visit('a', LIST, 'b'), 'back', session('b'), NARROW)!;

    expect(recordSessionHistory(back.history, LIST)).toBe(back.history);
  });

  it('returns to the current entry from a new chat draft', () => {
    const history = visit(LIST, 'a');

    expect(navigateSessionHistory(history, 'back', null, NARROW)?.entry).toEqual(session('a'));
    expect(navigateSessionHistory(history, 'back', session('a'), NARROW)?.entry).toEqual(LIST);
  });

  it('reports availability at both ends', () => {
    const history = visit('a', 'b');

    expect(canNavigateSessionHistory(EMPTY_SESSION_HISTORY, 'back', null, NARROW)).toBe(false);
    expect(canNavigateSessionHistory(visit('a'), 'back', session('a'), NARROW)).toBe(false);
    expect(canNavigateSessionHistory(history, 'back', session('b'), NARROW)).toBe(true);
    expect(canNavigateSessionHistory(history, 'forward', session('b'), NARROW)).toBe(false);
    expect(navigateSessionHistory(history, 'forward', session('b'), NARROW)).toBeNull();
  });

  it('stores the session directory without losing it to a later bare visit', () => {
    let history = recordSessionHistory(EMPTY_SESSION_HISTORY, session('a'));
    history = recordSessionHistory(history, session('a', '/repo'));
    history = recordSessionHistory(history, session('a'));
    history = recordSessionHistory(history, session('b', '/other'));

    expect(history.entries).toEqual([session('a', '/repo'), session('b', '/other')]);
  });

  it('removes deleted sessions and merges adjacent duplicates', () => {
    const history = removeFromSessionHistory(visit('a', 'b', 'a', 'c'), 'b');

    expect(labels(history)).toEqual(['a', 'c']);
    expect(history.index).toBe(1);
    expect(labels(removeFromSessionHistory(visit(LIST, 'a', LIST, 'b'), 'a'))).toEqual([
      'list',
      'b',
    ]);
  });

  it('widens a deleted session sub-agent list to the full list', () => {
    const subagents: SessionHistoryEntry = { type: 'list', filter: null, subagentParentId: 'a' };
    const history = removeFromSessionHistory(visit('a', subagents, 'b'), 'a');

    expect(history.entries).toEqual([LIST, session('b')]);
  });

  it('moves the current position to the previous entry when its session is deleted', () => {
    const back = navigateSessionHistory(visit('a', 'b', 'c'), 'back', session('c'), NARROW)!;
    const history = removeFromSessionHistory(back.history, 'b');

    expect(labels(history)).toEqual(['a', 'c']);
    expect(history.index).toBe(0);
    expect(navigateSessionHistory(history, 'back', session('b'), NARROW)?.entry).toEqual(
      session('a')
    );
    expect(navigateSessionHistory(history, 'forward', session('b'), NARROW)?.entry).toEqual(
      session('c')
    );
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
    expect(history.entries[0]).toEqual(session('s5'));
    expect(history.index).toBe(SESSION_HISTORY_MAX_ENTRIES - 1);
  });
});
