import { describe, expect, it } from 'vitest';
import type { RecycleBinEntry, RecycleBinSession } from './protocol';
import { normalizeRecycleBinEntries, normalizeRecycleBinEntry } from './recycle-bin';

function session(id: string, parentID?: string): RecycleBinSession {
  const value: RecycleBinSession = {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: 100, updated: 200 },
  };
  if (parentID) value.parentID = parentID;
  return value;
}

type EntryOverrides = Partial<Omit<RecycleBinEntry, 'root' | 'sessions'>> & {
  root?: RecycleBinSession;
  sessions?: object[];
};

function entry(overrides: EntryOverrides = {}) {
  const root = session('root');
  return {
    rootID: 'root',
    deletedAt: 1_000,
    expiresAt: 2_000,
    root,
    sessions: [root, session('child', 'root'), session('grandchild', 'child')],
    ...overrides,
  };
}

describe('normalizeRecycleBinEntry', () => {
  it('accepts a connected session tree containing its declared root', () => {
    expect(normalizeRecycleBinEntry(entry())).toMatchObject({
      rootID: 'root',
      sessions: [{ id: 'root' }, { id: 'child' }, { id: 'grandchild' }],
    });
  });

  it.each([
    ['a root ID that differs from root.id', entry({ rootID: 'other-root' })],
    ['a sessions list without the root', entry({ sessions: [session('child', 'root')] })],
    [
      'a listed root that differs from the declared root',
      entry({ sessions: [{ ...session('root'), directory: '/other' }] }),
    ],
    [
      'a root whose parent points into its own subtree',
      entry({
        root: session('root', 'child'),
        sessions: [session('root', 'child'), session('child', 'root')],
      }),
    ],
    ['duplicate session IDs', entry({ sessions: [session('root'), session('root')] })],
    ['an unrelated listed session', entry({ sessions: [session('root'), session('unrelated')] })],
    [
      'a disconnected parent cycle',
      entry({
        sessions: [session('root'), session('child-a', 'child-b'), session('child-b', 'child-a')],
      }),
    ],
    ['non-finite entry timestamps', entry({ deletedAt: Number.POSITIVE_INFINITY })],
    ['entry timestamps in reverse order', entry({ deletedAt: 2_001, expiresAt: 2_000 })],
    [
      'invalid session timestamps',
      entry({
        sessions: [
          session('root'),
          { ...session('child', 'root'), time: { created: 300, updated: 200 } },
        ],
      }),
    ],
    [
      'a descendant from another project',
      entry({
        sessions: [session('root'), { ...session('child', 'root'), projectID: 'project-2' }],
      }),
    ],
    [
      'a descendant from another workspace directory',
      entry({
        sessions: [session('root'), { ...session('child', 'root'), directory: '/other' }],
      }),
    ],
  ])('rejects %s', (_label, value) => {
    expect(normalizeRecycleBinEntry(value)).toBeNull();
  });

  it('rejects the whole entry when any listed session is malformed', () => {
    expect(
      normalizeRecycleBinEntry(
        entry({ sessions: [session('root'), session('child', 'root'), { id: 'malformed' }] })
      )
    ).toBeNull();
  });

  it('accepts normalized descendant workspace directory spelling', () => {
    expect(
      normalizeRecycleBinEntry(
        entry({
          root: { ...session('root'), directory: 'C:\\Repo' },
          sessions: [
            { ...session('root'), directory: 'C:\\Repo' },
            { ...session('child', 'root'), directory: 'c:/repo/' },
          ],
        })
      )
    ).not.toBeNull();
  });

  it('validates a long descendant chain without repeated ancestor walks', () => {
    const sessions = [session('root')];
    for (let index = 1; index < 5_000; index += 1) {
      sessions.push(session(`session-${index}`, index === 1 ? 'root' : `session-${index - 1}`));
    }

    expect(normalizeRecycleBinEntry(entry({ sessions }))).not.toBeNull();
  });

  it('rejects persisted recycle-bin collections above their safety limits', () => {
    expect(normalizeRecycleBinEntries(Array.from({ length: 1_001 }, () => entry()))).toEqual([]);
    expect(
      normalizeRecycleBinEntry(
        entry({ sessions: Array.from({ length: 10_001 }, () => session('root')) })
      )
    ).toBeNull();
  });

  it('rejects every persisted entry involved in an overlap', () => {
    const child = session('child', 'root');
    const childRoot = session('child', 'root');
    expect(
      normalizeRecycleBinEntries([
        entry({ sessions: [session('root'), child] }),
        {
          rootID: 'child',
          deletedAt: 1_100,
          expiresAt: 2_100,
          root: childRoot,
          sessions: [childRoot],
        },
      ])
    ).toEqual([]);
  });
});
