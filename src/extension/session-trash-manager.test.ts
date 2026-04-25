import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTrashManager } from './session-trash-manager';

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
  get: vi.fn((_key: string, fallback: StoredEntry[]) => mementoState.stored ?? fallback),
  update: vi.fn(async (_key: string, value: StoredEntry[]) => {
    mementoState.stored = value;
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
    const deleteSession = vi.fn(async () => undefined);

    await manager.moveToTrash('root', sessions as never[], 5_000);
    await manager.deletePermanently('root', deleteSession);

    expect(deleteSession).toHaveBeenCalledTimes(3);
    expect(deleteSession.mock.calls.map(([id]) => id)).toEqual(['root', 'child-1', 'child-2']);
    expect(manager.list()).toEqual([]);
  });

  it('ignores missing sessions while emptying the recycle bin', async () => {
    const manager = new SessionTrashManager(workspaceState as never);
    const sessions = [session('root', 2_000), session('child', 1_000, { parentID: 'root' })];
    const deleteSession = vi.fn(async (id: string) => {
      if (id === 'child') throw new Error('404 Session not found');
    });

    await manager.moveToTrash('root', sessions as never[], 5_000);
    const removed = await manager.empty(deleteSession);

    expect(deleteSession.mock.calls.map(([id]) => id)).toEqual(['root', 'child']);
    expect(removed).toHaveLength(1);
    expect(manager.list()).toEqual([]);
  });
});
