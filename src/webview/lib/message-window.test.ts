import { beforeEach, describe, expect, it } from 'vitest';
import type { Message, Part } from '../types';
import {
  advanceSessionHistoryCursor,
  advanceSessionHistoryPromptCursor,
  cacheSessionHistoryPage,
  clearSessionMessageWindowState,
  getCachedSessionMessages,
  getPrefetchedSessionHistory,
  getSessionHistoryCursor,
  getSessionHistoryPromptCursor,
  getSessionHistoryPrompts,
  isSessionHistoryLoadFailed,
  isSessionHistoryTruncated,
  markSessionHistoryLoadFailed,
  markSessionHistoryTruncated,
  MESSAGE_HISTORY_CACHE_SESSION_LIMIT,
  MESSAGE_HISTORY_PAGE_CACHE_LIMIT,
  mergeOlderHistory,
  mergeWindowedHistory,
  resetMessageWindowState,
  setSessionHistoryCursor,
  setSessionHistoryPromptCursor,
  setSessionHistoryPrompts,
  setCachedSessionMessages,
  takeCachedSessionHistoryPage,
} from './message-window';

function entry(id: string, sessionID = 'session-1'): { info: Message; parts: Part[] } {
  return {
    info: {
      id,
      sessionID,
      role: 'user',
      time: { created: 0 },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
    parts: [],
  };
}

beforeEach(() => {
  resetMessageWindowState();
});

describe('mergeWindowedHistory', () => {
  it('returns the incoming window when nothing was loaded before', () => {
    const incoming = [entry('m1'), entry('m2')];
    expect(mergeWindowedHistory([], incoming)).toBe(incoming);
  });

  it('returns the incoming window when it becomes empty', () => {
    expect(mergeWindowedHistory([entry('m1')], [])).toEqual([]);
  });

  it('returns the incoming window when it starts at or before the loaded head', () => {
    const incoming = [entry('m1'), entry('m2'), entry('m3')];
    expect(mergeWindowedHistory([entry('m1'), entry('m2')], incoming)).toBe(incoming);
  });

  it('stitches previously loaded older entries in front of an overlapping window', () => {
    const current = [entry('m1'), entry('m2'), entry('m3')];
    const incoming = [entry('m2'), entry('m3'), entry('m4')];

    expect(mergeWindowedHistory(current, incoming).map((item) => item.info.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
  });

  it('returns the incoming window when the windows do not overlap', () => {
    const current = [entry('m1'), entry('m2')];
    const incoming = [entry('m8'), entry('m9')];
    expect(mergeWindowedHistory(current, incoming)).toBe(incoming);
  });

  it('does not stitch entries from a different session', () => {
    const current = [entry('m1', 'session-other'), entry('m2', 'session-other')];
    const incoming = [entry('m2'), entry('m3')];
    expect(mergeWindowedHistory(current, incoming)).toBe(incoming);
  });
});

describe('history window state', () => {
  it('tracks truncated sessions', () => {
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
    markSessionHistoryTruncated('session-1', true);
    expect(isSessionHistoryTruncated('session-1')).toBe(true);
    expect(isSessionHistoryTruncated('session-2')).toBe(false);
    expect(isSessionHistoryTruncated(null)).toBe(false);
    markSessionHistoryTruncated('session-1', false);
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
  });

  it('tracks opaque history cursors until reset', () => {
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    setSessionHistoryCursor('session-1', 'cursor-1');
    expect(getSessionHistoryCursor('session-1')).toBe('cursor-1');
    expect(isSessionHistoryTruncated('session-1')).toBe(true);
    resetMessageWindowState();
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
  });

  it('clears truncation when the cursor reaches the final page', () => {
    setSessionHistoryCursor('session-1', 'cursor-1');
    setSessionHistoryCursor('session-1');
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
  });

  it('terminates opaque history and prompt cursor cycles across separate advances', () => {
    setSessionHistoryCursor('session-1', 'cursor-a');
    setSessionHistoryPromptCursor('session-1', 'prompt-a');

    expect(advanceSessionHistoryCursor('session-1', 'cursor-a', 'cursor-b')).toBe('cursor-b');
    expect(advanceSessionHistoryPromptCursor('session-1', 'prompt-a', 'prompt-b')).toBe('prompt-b');
    expect(advanceSessionHistoryCursor('session-1', 'cursor-b', 'cursor-a')).toBeUndefined();
    expect(advanceSessionHistoryPromptCursor('session-1', 'prompt-b', 'prompt-a')).toBeUndefined();
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(getSessionHistoryPromptCursor('session-1')).toBeUndefined();
  });

  it('tracks user prompts fetched from behind the visible history boundary', () => {
    const prompts = [entry('user-1')];
    setSessionHistoryPrompts('session-1', prompts);

    expect(getSessionHistoryPrompts('session-1')).toEqual(prompts);
    resetMessageWindowState();
    expect(getSessionHistoryPrompts('session-1')).toEqual([]);
  });

  it('stores prefetched history pages until the visible history consumes them', () => {
    const page = [entry('user-1')];
    cacheSessionHistoryPage('session-1', 'cursor-1', page);

    expect(takeCachedSessionHistoryPage('session-1', 'cursor-1')).toBe(page);
    expect(takeCachedSessionHistoryPage('session-1', 'cursor-1')).toBeUndefined();
  });

  it('keeps a bounded cache of loaded session windows', () => {
    for (let index = 1; index <= 4; index += 1) {
      setCachedSessionMessages(`session-${index}`, [entry(`message-${index}`, `session-${index}`)]);
    }

    expect(getCachedSessionMessages('session-1')).toEqual([]);
    expect(getCachedSessionMessages('session-2').map((item) => item.info.id)).toEqual([
      'message-2',
    ]);
    clearSessionMessageWindowState('session-2');
    expect(getCachedSessionMessages('session-2')).toEqual([]);
  });

  it('returns prefetched pages in chronological order', () => {
    cacheSessionHistoryPage('session-1', 'cursor-1', [entry('m3'), entry('m4')]);
    cacheSessionHistoryPage('session-1', 'cursor-2', [entry('m1'), entry('m2')]);

    expect(getPrefetchedSessionHistory('session-1').map((item) => item.info.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);

    takeCachedSessionHistoryPage('session-1', 'cursor-1');
    expect(getPrefetchedSessionHistory('session-1').map((item) => item.info.id)).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('deduplicates overlapping prefetched pages while preserving the newer cached entry', () => {
    const newerM2 = entry('m2');
    cacheSessionHistoryPage('session-1', 'cursor-newer', [newerM2, entry('m3')]);
    cacheSessionHistoryPage('session-1', 'cursor-older', [entry('m1'), entry('m2')]);

    const history = getPrefetchedSessionHistory('session-1');
    expect(history.map((item) => item.info.id)).toEqual(['m1', 'm2', 'm3']);
    expect(history[1]).toBe(newerM2);
  });

  it('clears every cached value for one session', () => {
    setSessionHistoryCursor('session-1', 'history-cursor');
    setSessionHistoryPromptCursor('session-1', 'prompt-cursor');
    setSessionHistoryPrompts('session-1', [entry('prompt-1')]);
    cacheSessionHistoryPage('session-1', 'page-cursor', [entry('message-1')]);
    markSessionHistoryLoadFailed('session-1', true);
    setSessionHistoryCursor('session-2', 'other-cursor');

    clearSessionMessageWindowState('session-1');

    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(getSessionHistoryPromptCursor('session-1')).toBeUndefined();
    expect(getSessionHistoryPrompts('session-1')).toEqual([]);
    expect(getPrefetchedSessionHistory('session-1')).toEqual([]);
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
    expect(isSessionHistoryLoadFailed('session-1')).toBe(false);
    expect(getSessionHistoryCursor('session-2')).toBe('other-cursor');
  });

  it('evicts the least recently used inactive session state', () => {
    for (let index = 0; index < MESSAGE_HISTORY_CACHE_SESSION_LIMIT; index += 1) {
      setSessionHistoryCursor(`session-${index}`, `cursor-${index}`);
    }
    expect(getSessionHistoryCursor('session-0')).toBe('cursor-0');

    setSessionHistoryCursor('session-overflow', 'cursor-overflow');

    expect(getSessionHistoryCursor('session-0')).toBe('cursor-0');
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(getSessionHistoryCursor('session-overflow')).toBe('cursor-overflow');
  });

  it('bounds prefetched history pages across cursors', () => {
    for (let index = 0; index <= MESSAGE_HISTORY_PAGE_CACHE_LIMIT; index += 1) {
      cacheSessionHistoryPage('session-1', `cursor-${index}`, [entry(`message-${index}`)]);
    }

    expect(takeCachedSessionHistoryPage('session-1', 'cursor-0')).toBeUndefined();
    expect(
      takeCachedSessionHistoryPage('session-1', `cursor-${MESSAGE_HISTORY_PAGE_CACHE_LIMIT}`)?.[0]
        ?.info.id
    ).toBe(`message-${MESSAGE_HISTORY_PAGE_CACHE_LIMIT}`);
  });
});

describe('mergeOlderHistory', () => {
  it('prepends older entries while preserving current duplicates', () => {
    const current = [entry('m2'), entry('m3')];
    const olderDuplicate = entry('m2');
    olderDuplicate.parts = [{ id: 'old-part' } as Part];

    const merged = mergeOlderHistory(current, [entry('m1'), olderDuplicate]);

    expect(merged.map((item) => item.info.id)).toEqual(['m1', 'm2', 'm3']);
    expect(merged[1]).toBe(current[0]);
  });

  it('keeps identical message IDs from different sessions distinct', () => {
    const current = [entry('shared-id', 'session-current')];
    const older = entry('shared-id', 'session-older');

    expect(mergeOlderHistory(current, [older])).toEqual([older, current[0]]);
  });
});
