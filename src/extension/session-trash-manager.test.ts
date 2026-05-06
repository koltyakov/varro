import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_TRASH_RETENTION_MS, SessionTrashManager } from './session-trash-manager';

type StoredEntry = Awaited<ReturnType<SessionTrashManager['list']>>[number];

function session(id: string, updated: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: updated - 1_000, updated },
    ...overrides,
  };
}

const mementoState = {
  stored: [] as StoredEntry[],
};

const workspaceState = {
  get: vi.fn(() => mementoState.stored),
  set: vi.fn(async (_key: string, value: StoredEntry[]) => {
    mementoState.stored = value;
  }),
  remove: vi.fn(async () => {
    mementoState.stored = [];
  }),
};

describe('SessionTrashManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mementoState.stored = [];
  });

  it('permanently deletes every session in a trashed tree', async () => {
    const manager = new SessionTrashManager(workspaceState as never);
    const sessions = [
      session('root', 3_000),
      session('child-1', 2_000, { parentID: 'root' }),
      session('child-2', 1_000, { parentID: 'child-1' }),
    ];
    const deleteSession = vi.fn(async (_target: { id: string; directory?: string }) => undefined);

    await manager.moveToTrash('root', sessions as never[], 5_000);
    await manager.deletePermanently('root', deleteSession);

    expect(deleteSession).toHaveBeenCalledTimes(3);
    expect(deleteSession.mock.calls.map(([target]) => target)).toEqual([
      { id: 'root', directory: '/repo' },
      { id: 'child-1', directory: '/repo' },
      { id: 'child-2', directory: '/repo' },
    ]);
    expect(manager.list()).toEqual([]);
  });

  it('ignores missing sessions while emptying the recycle bin', async () => {
    const manager = new SessionTrashManager(workspaceState as never);
    const sessions = [session('root', 2_000), session('child', 1_000, { parentID: 'root' })];
    const deleteSession = vi.fn(async (target: { id: string; directory?: string }) => {
      if (target.id === 'child') throw new Error('404 Session not found');
    });

    await manager.moveToTrash('root', sessions as never[], 5_000);
    const removed = await manager.empty(deleteSession);

    expect(deleteSession.mock.calls.map(([target]) => target)).toEqual([
      { id: 'root', directory: '/repo' },
      { id: 'child', directory: '/repo' },
    ]);
    expect(removed).toHaveLength(1);
    expect(manager.list()).toEqual([]);
  });

  it('restores trashed trees and unhides their sessions', async () => {
    const manager = new SessionTrashManager(workspaceState as never);
    const sessions = [
      session('root', 3_000, { summary: { additions: 1, deletions: 2, files: 3 } }),
      session('child', 2_000, { parentID: 'root' }),
      session('visible', 1_000),
    ];

    const entry = await manager.moveToTrash('root', sessions as never[], 5_000);

    expect(entry?.sessions.map(({ id }) => id)).toEqual(['root', 'child']);
    expect([...manager.hiddenSessionIds()].toSorted()).toEqual(['child', 'root']);
    expect(manager.filterVisibleSessions(sessions).map(({ id }) => id)).toEqual(['visible']);
    expect(
      Object.keys(
        manager.filterVisibleSessionStatuses({
          root: 'busy',
          child: 'idle',
          visible: 'idle',
        })
      )
    ).toEqual(['visible']);
    expect(
      manager
        .filterVisibleSessionRequests([
          { id: 'request-1', sessionID: 'root' },
          { id: 'request-2', sessionID: 'visible' },
        ])
        .map(({ id }) => id)
    ).toEqual(['request-2']);

    const restored = await manager.restore('root');

    expect(restored).toEqual(entry);
    expect(manager.isHidden('root')).toBe(false);
    expect(manager.list()).toEqual([]);
  });

  it('cleans up only expired entries and retries failed evictions later', async () => {
    const manager = new SessionTrashManager(workspaceState as never);
    await manager.moveToTrash('expired', [session('expired', 1_000)] as never[], 10_000);
    await manager.moveToTrash('fresh', [session('fresh', 2_000)] as never[], 50_000);

    const deleteSession = vi
      .fn(async (_target: { id: string; directory?: string }) => undefined)
      .mockRejectedValueOnce(new Error('temporary failure'));
    const now = 10_000 + SESSION_TRASH_RETENTION_MS + 1;

    await expect(manager.cleanupExpired(deleteSession, now)).resolves.toEqual([]);
    expect(manager.list().map(({ rootID }) => rootID)).toEqual(['fresh', 'expired']);

    await expect(manager.cleanupExpired(deleteSession, now)).resolves.toMatchObject([
      { rootID: 'expired' },
    ]);
    expect(deleteSession.mock.calls.map(([target]) => target)).toEqual([
      { id: 'expired', directory: '/repo' },
      { id: 'expired', directory: '/repo' },
    ]);
    expect(manager.list().map(({ rootID }) => rootID)).toEqual(['fresh']);
  });

  it('drops corrupted persisted entries while loading valid recycle-bin state', () => {
    mementoState.stored = [
      {
        rootID: 'broken-root',
        deletedAt: 1,
        expiresAt: 2,
        root: null,
        sessions: [],
      } as never,
      {
        rootID: 'root',
        deletedAt: 10,
        expiresAt: 20,
        root: session('root', 3_000),
        sessions: [session('root', 3_000), { id: 'bad-session' }],
      } as never,
      {
        rootID: 'missing-fields',
        deletedAt: 'nope',
      } as never,
    ];

    const manager = new SessionTrashManager(workspaceState as never);

    expect(manager.list()).toMatchObject([
      {
        rootID: 'root',
        sessions: [{ id: 'root' }],
      },
    ]);
  });
});
