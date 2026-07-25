import { describe, expect, it } from 'vitest';
import { planMessageHistoryNavigation } from './message-history-navigation';
import type { MessageHistoryNavigationInput } from './message-history-navigation';

const OLDER = -1 as const;
const NEWER = 1 as const;

function plan(overrides: Partial<MessageHistoryNavigationInput> = {}) {
  return planMessageHistoryNavigation({
    history: ['first', 'second', 'third'],
    currentIndex: null,
    inputText: '',
    sessionId: 'session-1',
    direction: OLDER,
    ...overrides,
  });
}

describe('planMessageHistoryNavigation', () => {
  describe('with a draft in the composer', () => {
    it('ignores navigation so unsent text is never discarded', () => {
      expect(plan({ inputText: 'half-written prompt' })).toEqual({ kind: 'ignore' });
    });

    it('ignores navigation in both directions', () => {
      expect(plan({ inputText: 'draft', direction: NEWER })).toEqual({ kind: 'ignore' });
    });

    it('still navigates when already inside history, since the text came from history', () => {
      expect(plan({ inputText: 'second', currentIndex: 1 })).toEqual({
        kind: 'select',
        index: 0,
        stashDraft: false,
      });
    });
  });

  describe('entering history from an empty composer', () => {
    it('selects the newest prompt and stashes the draft', () => {
      expect(plan()).toEqual({ kind: 'select', index: 2, stashDraft: true });
    });

    it('stashes the draft without moving when walking toward newer prompts', () => {
      expect(plan({ direction: NEWER })).toEqual({ kind: 'stash-draft' });
    });
  });

  describe('walking through loaded history', () => {
    it('steps to the previous prompt without re-stashing the draft', () => {
      expect(plan({ currentIndex: 2 })).toEqual({ kind: 'select', index: 1, stashDraft: false });
    });

    it('steps back toward newer prompts', () => {
      expect(plan({ currentIndex: 0, direction: NEWER })).toEqual({
        kind: 'select',
        index: 1,
        stashDraft: false,
      });
    });

    it('restores the draft when walking past the newest prompt', () => {
      expect(plan({ currentIndex: 2, direction: NEWER })).toEqual({ kind: 'restore-draft' });
    });
  });

  describe('paging in older prompts', () => {
    it('requests older prompts when walking past the oldest loaded one', () => {
      expect(plan({ currentIndex: 0 })).toEqual({
        kind: 'load-older',
        sessionId: 'session-1',
        previousLength: 3,
        previousIndex: 0,
        stashDraft: false,
      });
    });

    it('does not request older prompts without a session', () => {
      expect(plan({ currentIndex: 0, sessionId: null })).toEqual({ kind: 'ignore' });
    });

    it('requests the first page when history is empty and stashes the draft', () => {
      expect(plan({ history: [], currentIndex: null })).toEqual({
        kind: 'load-older',
        sessionId: 'session-1',
        previousLength: 0,
        previousIndex: null,
        stashDraft: true,
      });
    });

    it('does not page in on an empty history when walking toward newer prompts', () => {
      expect(plan({ history: [], direction: NEWER })).toEqual({ kind: 'ignore' });
    });

    it('does not page in on an empty history without a session', () => {
      expect(plan({ history: [], sessionId: null })).toEqual({ kind: 'ignore' });
    });

    it('ignores an empty history when the composer holds a draft', () => {
      expect(plan({ history: [], inputText: 'draft' })).toEqual({ kind: 'ignore' });
    });
  });

  describe('single-entry history', () => {
    it('selects the only prompt on the way in', () => {
      expect(plan({ history: ['only'] })).toEqual({ kind: 'select', index: 0, stashDraft: true });
    });

    it('pages older from the only prompt', () => {
      expect(plan({ history: ['only'], currentIndex: 0 })).toEqual({
        kind: 'load-older',
        sessionId: 'session-1',
        previousLength: 1,
        previousIndex: 0,
        stashDraft: false,
      });
    });

    it('restores the draft when leaving the only prompt', () => {
      expect(plan({ history: ['only'], currentIndex: 0, direction: NEWER })).toEqual({
        kind: 'restore-draft',
      });
    });
  });

  it('round-trips from the draft to the oldest prompt and back', () => {
    const history = ['first', 'second', 'third'];
    let currentIndex: number | null = null;
    const visited: (number | null)[] = [];

    for (let step = 0; step < 3; step += 1) {
      const action = planMessageHistoryNavigation({
        history,
        currentIndex,
        inputText: '',
        sessionId: 'session-1',
        direction: OLDER,
      });
      if (action.kind !== 'select') break;
      currentIndex = action.index;
      visited.push(currentIndex);
    }

    expect(visited).toEqual([2, 1, 0]);

    const backToDraft: (number | null)[] = [];
    for (let step = 0; step < 4; step += 1) {
      const action = planMessageHistoryNavigation({
        history,
        currentIndex,
        inputText: '',
        sessionId: 'session-1',
        direction: NEWER,
      });
      if (action.kind === 'restore-draft') {
        currentIndex = null;
        backToDraft.push(null);
        break;
      }
      if (action.kind !== 'select') break;
      currentIndex = action.index;
      backToDraft.push(currentIndex);
    }

    expect(backToDraft).toEqual([1, 2, null]);
  });
});
