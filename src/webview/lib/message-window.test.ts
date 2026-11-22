import { flush as flushSolid, createStore } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MessageEntry, Part } from '../types';
import {
  advanceSessionHistoryCursor,
  advanceSessionHistoryPromptCursor,
  cacheSessionHistoryPage,
  clearSessionMessageWindowState,
  getCachedSessionMessages,
  getSessionMessageSnapshotMutationRevision,
  getSessionMessageWindowRevision,
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
  recordSessionMessageSnapshotMutation,
  setSessionHistoryCursor,
  setSessionHistoryPromptCursor,
  setSessionHistoryPrompts,
  setCachedSessionMessages,
  takeCachedSessionHistoryPage,
} from './message-window';

function entry(id: string, sessionID = 'session-1'): MessageEntry {
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
  flushSolid();
});

describe('message snapshot mutation revisions', () => {
  it('advance independently without invalidating pagination requests', () => {
    const windowRevision = getSessionMessageWindowRevision('session-1');

    recordSessionMessageSnapshotMutation('session-1');
    flushSolid();
    recordSessionMessageSnapshotMutation('session-2');
    flushSolid();
    recordSessionMessageSnapshotMutation('session-1');
    flushSolid();

    expect(getSessionMessageSnapshotMutationRevision('session-1')).toBeGreaterThan(
      getSessionMessageSnapshotMutationRevision('session-2')
    );
    expect(getSessionMessageWindowRevision('session-1')).toBe(windowRevision);
  });

  it('resets with message window state', () => {
    recordSessionMessageSnapshotMutation('session-1');
    flushSolid();
    resetMessageWindowState();
    flushSolid();
    expect(getSessionMessageSnapshotMutationRevision('session-1')).toBe(0);
  });
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
  it('retains the replacement cursor after a same-turn history reset', () => {
    setSessionHistoryCursor('session-1', 'first-cursor');
    flushSolid();
    clearSessionMessageWindowState('session-1');
    setSessionHistoryCursor('session-1', 'replacement-cursor');
    flushSolid();
    expect(getSessionHistoryCursor('session-1')).toBe('replacement-cursor');
    expect(isSessionHistoryTruncated('session-1')).toBe(true);
  });

  it('combines same-turn history flags and prompt updates across sessions', () => {
    markSessionHistoryTruncated('session-1', true);
    markSessionHistoryTruncated('session-2', true);
    markSessionHistoryLoadFailed('session-1', true);
    markSessionHistoryLoadFailed('session-2', true);
    setSessionHistoryPrompts('session-1', [entry('one', 'session-1')]);
    setSessionHistoryPrompts('session-2', [entry('two', 'session-2')]);
    flushSolid();
    expect(isSessionHistoryTruncated('session-1')).toBe(true);
    expect(isSessionHistoryTruncated('session-2')).toBe(true);
    expect(isSessionHistoryLoadFailed('session-1')).toBe(true);
    expect(isSessionHistoryLoadFailed('session-2')).toBe(true);
    expect(getSessionHistoryPrompts('session-1').map((message) => message.info.id)).toEqual([
      'one',
    ]);
    expect(getSessionHistoryPrompts('session-2').map((message) => message.info.id)).toEqual([
      'two',
    ]);
  });
  it('bounds cached transcript bytes across sessions and pages without clearing cursors', () => {
    const large = (id: string): MessageEntry => ({
      ...entry(id),
      parts: [
        {
          id: `${id}-text`,
          sessionID: 'session-1',
          messageID: id,
          type: 'text',
          text: 'x'.repeat(7 * 1024 * 1024),
        },
      ],
    });
    setSessionHistoryCursor('session-1', 'older');
    flushSolid();
    setCachedSessionMessages('session-1', [large('first')]);
    flushSolid();
    cacheSessionHistoryPage('session-2', 'page', [large('second')]);
    flushSolid();
    expect(getCachedSessionMessages('session-1')).toEqual([]);
    expect(getSessionHistoryCursor('session-1')).toBe('older');
    expect(takeCachedSessionHistoryPage('session-2', 'page')).toHaveLength(1);
    setCachedSessionMessages('session-1', [large('third')]);
    flushSolid();
    expect(getCachedSessionMessages('session-1')).toHaveLength(1);
  });

  it('tracks truncated sessions', () => {
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
    markSessionHistoryTruncated('session-1', true);
    flushSolid();
    expect(isSessionHistoryTruncated('session-1')).toBe(true);
    expect(isSessionHistoryTruncated('session-2')).toBe(false);
    expect(isSessionHistoryTruncated(null)).toBe(false);
    markSessionHistoryTruncated('session-1', false);
    flushSolid();
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
  });

  it('accounts for updated store snapshots without replacing cached proxy identities', () => {
    const message = entry('m1');
    message.parts = [
      { id: 'p1', sessionID: 'session-1', messageID: 'm1', type: 'text', text: 'Short' },
    ];
    flushSolid();
    const [store, setStore] = createStore({ messages: [message] });
    const snapshot = [...store.messages];
    const proxy = store.messages[0];
    setCachedSessionMessages('session-1', snapshot);
    flushSolid();
    expect(getCachedSessionMessages('session-1')[0]).toBe(proxy);
    setStore(
      storePath('messages', 0, 'parts', 0, (part) => {
        if (part.type !== 'text') throw new Error('Expected text fixture');
        return { ...part, text: 'x'.repeat(13 * 1024 * 1024) };
      })
    );
    flushSolid();
    setCachedSessionMessages('session-1', snapshot);
    flushSolid();
    expect(getCachedSessionMessages('session-1')).toEqual([]);
    expect(snapshot[0]).toBe(proxy);
    expect(store.messages[0]!.parts[0]).toHaveProperty('text', 'x'.repeat(13 * 1024 * 1024));
  });

  it('sizes retained store records in a merged older page like their plain values', () => {
    const MiB = 1024 * 1024;
    // Strings count two bytes per character; per-record overhead is far below the 64 KiB margin.
    const underHalfBudget = (12 * MiB - 64 * 1024) / 2;
    const textEntry = (id: string): MessageEntry => ({
      ...entry(id),
      parts: [
        {
          id: `${id}-text`,
          sessionID: 'session-1',
          messageID: id,
          type: 'text',
          text: 'x'.repeat(underHalfBudget),
        },
      ],
    });
    flushSolid();
    const [store, setStore] = createStore({ messages: [textEntry('retained')] });
    const retained = store.messages[0]!;
    const page = textEntry('older');
    const mergedHistories = () => [
      [textEntry('older'), textEntry('retained')],
      mergeOlderHistory([retained], [page]),
      // A plain record can also hold a retained store part.
      [page, { ...entry('nested'), parts: [retained.parts[0]!] }],
    ];
    for (const merged of mergedHistories()) {
      setCachedSessionMessages('session-1', merged);
      flushSolid();
      expect(getCachedSessionMessages('session-1')).toHaveLength(2);
    }

    // A retained record that grows in place is sized from its current value on the next merge.
    setStore((draft) => {
      const part = draft.messages[0]!.parts[0]!;
      if (part.type !== 'text') throw new Error('Expected text fixture');
      part.text += 'x'.repeat(64 * 1024);
    });
    flushSolid();
    for (const merged of mergedHistories().slice(1)) {
      setCachedSessionMessages('session-1', merged);
      flushSolid();
      expect(getCachedSessionMessages('session-1')).toEqual([]);
    }
    expect(store.messages[0]!.parts[0]).toHaveProperty(
      'text',
      'x'.repeat(underHalfBudget + 64 * 1024)
    );
  });

  it('sizes a mutated store record repeated within one cached entry once', () => {
    const MiB = 1024 * 1024;
    const message: MessageEntry = {
      ...entry('repeated'),
      parts: [
        {
          id: 'repeated-text',
          sessionID: 'session-1',
          messageID: 'repeated',
          type: 'text',
          text: '',
        },
      ],
    };
    flushSolid();
    const [store, setStore] = createStore({ messages: [message] });
    // Grow the record in place, as streamed text does: 14 MiB fits once but not twice.
    setStore((draft) => {
      const part = draft.messages[0]!.parts[0]!;
      if (part.type !== 'text') throw new Error('Expected text fixture');
      part.text = 'x'.repeat(7 * MiB);
    });
    flushSolid();
    const retained = store.messages[0]!;
    setCachedSessionMessages('session-1', [retained, retained]);
    flushSolid();
    expect(getCachedSessionMessages('session-1')).toHaveLength(2);
  });

  it('counts the same retained records separately in each cached entry', () => {
    const MiB = 1024 * 1024;
    const message: MessageEntry = {
      ...entry('shared'),
      parts: [
        {
          id: 'shared-text',
          sessionID: 'session-1',
          messageID: 'shared',
          type: 'text',
          text: 'x'.repeat(7 * MiB),
        },
      ],
    };
    flushSolid();
    const [store] = createStore({ messages: [message] });
    const retained = [...store.messages];
    setCachedSessionMessages('session-1', retained);
    flushSolid();
    cacheSessionHistoryPage('session-1', 'older', retained);
    flushSolid();

    // Two 14 MiB estimates exceed the shared budget even though they reference one store record.
    expect(getCachedSessionMessages('session-1')).toEqual([]);
    expect(getPrefetchedSessionHistory('session-1')).toHaveLength(1);
  });

  it('tracks opaque history cursors until reset', () => {
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    setSessionHistoryCursor('session-1', 'cursor-1');
    flushSolid();
    expect(getSessionHistoryCursor('session-1')).toBe('cursor-1');
    expect(isSessionHistoryTruncated('session-1')).toBe(true);
    resetMessageWindowState();
    flushSolid();
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
  });

  it('clears truncation when the cursor reaches the final page', () => {
    setSessionHistoryCursor('session-1', 'cursor-1');
    flushSolid();
    setSessionHistoryCursor('session-1');
    flushSolid();
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(isSessionHistoryTruncated('session-1')).toBe(false);
  });

  it('terminates opaque history and prompt cursor cycles across separate advances', () => {
    setSessionHistoryCursor('session-1', 'cursor-a');
    flushSolid();
    setSessionHistoryPromptCursor('session-1', 'prompt-a');
    flushSolid();

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
    flushSolid();

    expect(getSessionHistoryPrompts('session-1')).toEqual(prompts);
    resetMessageWindowState();
    flushSolid();
    expect(getSessionHistoryPrompts('session-1')).toEqual([]);
  });

  it('stores prefetched history pages until the visible history consumes them', () => {
    const page = [entry('user-1')];
    cacheSessionHistoryPage('session-1', 'cursor-1', page);
    flushSolid();

    expect(takeCachedSessionHistoryPage('session-1', 'cursor-1')).toBe(page);
    expect(takeCachedSessionHistoryPage('session-1', 'cursor-1')).toBeUndefined();
  });

  it('keeps a bounded cache of loaded session windows', () => {
    for (let index = 1; index <= 4; index += 1) {
      setCachedSessionMessages(`session-${index}`, [entry(`message-${index}`, `session-${index}`)]);
      flushSolid();
    }

    expect(getCachedSessionMessages('session-1')).toEqual([]);
    expect(getCachedSessionMessages('session-2').map((item) => item.info.id)).toEqual([
      'message-2',
    ]);
    clearSessionMessageWindowState('session-2');
    flushSolid();
    expect(getCachedSessionMessages('session-2')).toEqual([]);
  });

  it('returns prefetched pages in chronological order', () => {
    cacheSessionHistoryPage('session-1', 'cursor-1', [entry('m3'), entry('m4')]);
    flushSolid();
    cacheSessionHistoryPage('session-1', 'cursor-2', [entry('m1'), entry('m2')]);
    flushSolid();

    expect(getPrefetchedSessionHistory('session-1').map((item) => item.info.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);

    takeCachedSessionHistoryPage('session-1', 'cursor-1');
    flushSolid();
    expect(getPrefetchedSessionHistory('session-1').map((item) => item.info.id)).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('deduplicates overlapping prefetched pages while preserving the newer cached entry', () => {
    const newerM2 = entry('m2');
    cacheSessionHistoryPage('session-1', 'cursor-newer', [newerM2, entry('m3')]);
    flushSolid();
    cacheSessionHistoryPage('session-1', 'cursor-older', [entry('m1'), entry('m2')]);
    flushSolid();

    const history = getPrefetchedSessionHistory('session-1');
    expect(history.map((item) => item.info.id)).toEqual(['m1', 'm2', 'm3']);
    expect(history[1]).toBe(newerM2);
  });

  it('clears every cached value for one session', () => {
    setSessionHistoryCursor('session-1', 'history-cursor');
    flushSolid();
    setSessionHistoryPromptCursor('session-1', 'prompt-cursor');
    flushSolid();
    setSessionHistoryPrompts('session-1', [entry('prompt-1')]);
    flushSolid();
    cacheSessionHistoryPage('session-1', 'page-cursor', [entry('message-1')]);
    flushSolid();
    markSessionHistoryLoadFailed('session-1', true);
    flushSolid();
    setSessionHistoryCursor('session-2', 'other-cursor');
    flushSolid();

    clearSessionMessageWindowState('session-1');
    flushSolid();

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
      flushSolid();
    }
    expect(getSessionHistoryCursor('session-0')).toBe('cursor-0');

    setSessionHistoryCursor('session-overflow', 'cursor-overflow');
    flushSolid();

    expect(getSessionHistoryCursor('session-0')).toBe('cursor-0');
    expect(getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(getSessionHistoryCursor('session-overflow')).toBe('cursor-overflow');
  });

  it('bounds prefetched history pages across cursors', () => {
    for (let index = 0; index <= MESSAGE_HISTORY_PAGE_CACHE_LIMIT; index += 1) {
      cacheSessionHistoryPage('session-1', `cursor-${index}`, [entry(`message-${index}`)]);
      flushSolid();
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
    // SAFETY: The fixture provides the Part fields read by this statement.
    olderDuplicate.parts = [{ id: 'old-part' } as Part];
    flushSolid();

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
