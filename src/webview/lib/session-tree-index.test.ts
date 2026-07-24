import { describe, expect, it } from 'vitest';
import type { Session } from '../types';
import type { UsageLimitNotice } from './usage-limit';
import { collectSessionTreeIds, createSessionTreeIndex } from './session-tree-index';

function makeSession(id: string, opts?: { parentID?: string }): Session {
  return {
    id,
    projectID: 'proj',
    directory: '/tmp',
    parentID: opts?.parentID,
    title: id,
    version: '1',
    time: { created: 0, updated: 0 },
  };
}

function makeNotice(sessionId: string): UsageLimitNotice {
  return {
    source: 'status',
    statusCode: 429,
    message: 'rate limit',
    unit: 'day',
    retryAt: null,
    attempt: null,
    sessionID: sessionId,
  };
}

const emptyLimits: Record<string, UsageLimitNotice | null> = {};

describe('collectSessionTreeIds', () => {
  it('returns empty for null rootId', () => {
    expect(collectSessionTreeIds(null, [])).toEqual([]);
  });

  it('returns empty for undefined rootId', () => {
    expect(collectSessionTreeIds(undefined, [])).toEqual([]);
  });

  it('returns just the root when no children exist', () => {
    const sessions = [makeSession('a')];
    const result = collectSessionTreeIds('a', sessions);
    expect(result.toSorted()).toEqual(['a']);
  });

  it('collects children and grandchildren', () => {
    const sessions = [
      makeSession('root'),
      makeSession('c1', { parentID: 'root' }),
      makeSession('c2', { parentID: 'root' }),
      makeSession('gc1', { parentID: 'c1' }),
    ];
    const result = collectSessionTreeIds('root', sessions);
    expect(result.toSorted()).toEqual(['c1', 'c2', 'gc1', 'root']);
  });

  it('ignores sessions unreachable from root', () => {
    const sessions = [
      makeSession('root'),
      makeSession('orphan'),
      makeSession('c1', { parentID: 'root' }),
    ];
    const result = collectSessionTreeIds('root', sessions);
    expect(result.toSorted()).toEqual(['c1', 'root']);
  });

  it('handles cycles without infinite loop', () => {
    const sessions = [
      makeSession('a'),
      makeSession('b', { parentID: 'a' }),
      makeSession('a', { parentID: 'b' }),
    ];
    const result = collectSessionTreeIds('a', sessions);
    expect(result.toSorted()).toEqual(['a', 'b']);
  });
});

describe('createSessionTreeIndex', () => {
  it('getTreeIds returns tree for a root session', () => {
    const idx = createSessionTreeIndex();
    const sessions = [
      makeSession('root'),
      makeSession('c1', { parentID: 'root' }),
      makeSession('c2', { parentID: 'root' }),
    ];
    const result = idx.getTreeIds('root', sessions, emptyLimits);
    expect(result.toSorted()).toEqual(['c1', 'c2', 'root']);
  });

  it('getTreeIds returns empty for null rootId', () => {
    const idx = createSessionTreeIndex();
    expect(idx.getTreeIds(null, [], emptyLimits)).toEqual([]);
  });

  it('getTreeIds returns [rootId] for unknown session (fallback)', () => {
    const idx = createSessionTreeIndex();
    const result = idx.getTreeIds('unknown', [], emptyLimits);
    expect(result).toEqual(['unknown']);
  });

  it('getRootId returns root for a nested child', () => {
    const idx = createSessionTreeIndex();
    const sessions = [
      makeSession('root'),
      makeSession('c1', { parentID: 'root' }),
      makeSession('gc1', { parentID: 'c1' }),
    ];
    expect(idx.getRootId('gc1', sessions, emptyLimits)).toBe('root');
    expect(idx.getRootId('c1', sessions, emptyLimits)).toBe('root');
    expect(idx.getRootId('root', sessions, emptyLimits)).toBe('root');
  });

  it('getRootId returns null for null sessionId', () => {
    const idx = createSessionTreeIndex();
    expect(idx.getRootId(null, [], emptyLimits)).toBeNull();
  });

  it('getRootId falls back to sessionId when not in index', () => {
    const idx = createSessionTreeIndex();
    expect(idx.getRootId('missing', [makeSession('other')], emptyLimits)).toBe('missing');
  });

  it('handles sessions with no primary sessions (all have parentID)', () => {
    const idx = createSessionTreeIndex();
    const sessions = [makeSession('a', { parentID: 'b' }), makeSession('b', { parentID: 'a' })];
    expect(idx.getRootId('a', sessions, emptyLimits)).toBe('a');
    expect(idx.getTreeIds('b', sessions, emptyLimits)).toEqual(['b']);
  });

  it('indexes a subtree whose parent is missing from the session list', () => {
    const idx = createSessionTreeIndex();
    // `orphan`'s parent is hidden/trashed/out-of-workspace and so absent here.
    const sessions = [
      makeSession('orphan', { parentID: 'filtered-out' }),
      makeSession('c1', { parentID: 'orphan' }),
      makeSession('gc1', { parentID: 'c1' }),
    ];

    expect(idx.getTreeIds('orphan', sessions, emptyLimits).toSorted()).toEqual([
      'c1',
      'gc1',
      'orphan',
    ]);
    expect(idx.getRootId('gc1', sessions, emptyLimits)).toBe('orphan');
  });

  it('matches collectSessionTreeIds for a subtree with a missing parent', () => {
    const idx = createSessionTreeIndex();
    const sessions = [
      makeSession('root'),
      makeSession('orphan', { parentID: 'filtered-out' }),
      makeSession('c1', { parentID: 'orphan' }),
    ];

    expect(idx.getTreeIds('orphan', sessions, emptyLimits).toSorted()).toEqual(
      collectSessionTreeIds('orphan', sessions).toSorted()
    );
  });

  it('getActiveUsageLimitNotice covers a tree whose parent is missing', () => {
    const idx = createSessionTreeIndex();
    const sessions = [
      makeSession('orphan', { parentID: 'filtered-out' }),
      makeSession('c1', { parentID: 'orphan' }),
    ];
    const limits: Record<string, UsageLimitNotice | null> = { c1: makeNotice('c1') };

    expect(idx.getActiveUsageLimitNotice('orphan', sessions, limits)).toEqual(
      expect.objectContaining({ sessionID: 'c1' })
    );
  });

  it('indexes trees deeper than the recursion limit', () => {
    const idx = createSessionTreeIndex();
    const depth = 60_000;
    const sessions = [makeSession('s0')];
    for (let index = 1; index < depth; index += 1) {
      sessions.push(makeSession(`s${index}`, { parentID: `s${index - 1}` }));
    }

    expect(idx.getTreeIds('s0', sessions, emptyLimits)).toHaveLength(depth);
    expect(idx.getRootId(`s${depth - 1}`, sessions, emptyLimits)).toBe('s0');
  });

  it('indexes a leaf-first cycle component in linear time', () => {
    const idx = createSessionTreeIndex();
    const depth = 20_000;
    // Leaf first, then its ancestors, ending in a two-node parent cycle. Walking
    // from each unindexed session in list order would re-walk the whole suffix.
    const sessions: Session[] = [];
    for (let index = depth; index >= 2; index -= 1) {
      sessions.push(makeSession(`c${index}`, { parentID: `c${index - 1}` }));
    }
    sessions.push(makeSession('c1', { parentID: 'c0' }));
    sessions.push(makeSession('c0', { parentID: 'c1' }));

    const started = Date.now();
    expect(idx.getTreeIds('c1', sessions, emptyLimits)).toHaveLength(depth + 1);
    expect(idx.getRootId(`c${depth}`, sessions, emptyLimits)).toBe('c1');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('deduplicates a root-reachable duplicate-ID cycle', () => {
    const idx = createSessionTreeIndex();
    const sessions = [
      makeSession('root'),
      makeSession('child', { parentID: 'root' }),
      makeSession('root', { parentID: 'child' }),
      makeSession('leaf', { parentID: 'child' }),
    ];

    expect(idx.getTreeIds('root', sessions, emptyLimits)).toEqual(['root', 'child', 'leaf']);
  });

  it('getActiveUsageLimitNotice finds notice from any session in tree', () => {
    const idx = createSessionTreeIndex();
    const sessions = [makeSession('root'), makeSession('c1', { parentID: 'root' })];
    const limits: Record<string, UsageLimitNotice | null> = {
      c1: makeNotice('c1'),
    };
    expect(idx.getActiveUsageLimitNotice('root', sessions, limits)).toEqual(
      expect.objectContaining({ sessionID: 'c1' })
    );
    expect(idx.getActiveUsageLimitNotice('c1', sessions, limits)).toEqual(
      expect.objectContaining({ sessionID: 'c1' })
    );
  });

  it('getActiveUsageLimitNotice returns null when no limits exist', () => {
    const idx = createSessionTreeIndex();
    const sessions = [makeSession('root')];
    expect(idx.getActiveUsageLimitNotice('root', sessions, emptyLimits)).toBeNull();
  });

  it('getActiveUsageLimitNotice returns null for null sessionId', () => {
    const idx = createSessionTreeIndex();
    expect(idx.getActiveUsageLimitNotice(null, [], emptyLimits)).toBeNull();
  });

  it('caches index when called with same refs', () => {
    const idx = createSessionTreeIndex();
    const sessions = [makeSession('root')];
    const result1 = idx.getTreeIds('root', sessions, emptyLimits);
    const result2 = idx.getTreeIds('root', sessions, emptyLimits);
    expect(result1).toEqual(result2);
  });

  it('invalidate forces re-index on next call with same ref', () => {
    const idx = createSessionTreeIndex();
    const sessions: Session[] = [makeSession('root')];
    expect(idx.getTreeIds('root', sessions, emptyLimits)).toEqual(['root']);

    sessions.push(makeSession('c1', { parentID: 'root' }));
    expect(idx.getTreeIds('root', sessions, emptyLimits)).toEqual(['root']);

    idx.invalidate();
    expect(idx.getTreeIds('root', sessions, emptyLimits).toSorted()).toEqual(['c1', 'root']);
  });

  it('getActiveUsageLimitNotice picks first notice found in tree order', () => {
    const idx = createSessionTreeIndex();
    const sessions = [
      makeSession('root'),
      makeSession('c1', { parentID: 'root' }),
      makeSession('c2', { parentID: 'root' }),
    ];
    const limits: Record<string, UsageLimitNotice | null> = {
      root: makeNotice('root'),
      c1: makeNotice('c1'),
    };
    const result = idx.getActiveUsageLimitNotice('c2', sessions, limits);
    expect(result).toEqual(expect.objectContaining({ sessionID: 'root' }));
  });
});
