/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The Memento fixture stores opaque persisted values and the tests inspect controlled private state. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { PinnedSessionManager } from './pinned-session-manager';

const stored = { value: undefined as unknown };
const persistence = {
  get<T>(_key: string): T | undefined {
    return stored.value as T | undefined;
  },
  set: vi.fn(async (_key: string, value: unknown) => {
    stored.value = value;
  }),
  remove: vi.fn((_key: string) => undefined),
} satisfies Persistence;

describe('PinnedSessionManager', () => {
  beforeEach(() => {
    stored.value = undefined;
    vi.clearAllMocks();
  });

  it('loads unique valid session ids', () => {
    stored.value = ['session-1', '', 42, 'session-1', 'session-2'];

    expect(new PinnedSessionManager(persistence).list()).toEqual(['session-1', 'session-2']);
  });

  it('persists pin and unpin changes', async () => {
    const manager = new PinnedSessionManager(persistence);

    await expect(manager.setPinned('session-1', true)).resolves.toEqual(['session-1']);
    await expect(manager.setPinned('session-2', true)).resolves.toEqual(['session-2', 'session-1']);
    await expect(manager.setPinned('session-1', false)).resolves.toEqual(['session-2']);
    expect(stored.value).toEqual(['session-2']);
  });

  it('reorders pinned sessions', async () => {
    stored.value = ['session-1', 'session-2', 'session-3'];
    const manager = new PinnedSessionManager(persistence);

    await expect(manager.reorder('session-1', 'session-3')).resolves.toEqual([
      'session-2',
      'session-3',
      'session-1',
    ]);
    await expect(manager.reorder('session-1', 'session-2')).resolves.toEqual([
      'session-1',
      'session-2',
      'session-3',
    ]);
    expect(stored.value).toEqual(['session-1', 'session-2', 'session-3']);
  });

  it('rejects reorder requests for unpinned sessions', async () => {
    stored.value = ['session-1'];
    const manager = new PinnedSessionManager(persistence);

    await expect(manager.reorder('session-1', 'session-2')).rejects.toThrow(
      'Pinned session not found'
    );
    expect(persistence.set).not.toHaveBeenCalled();
  });

  it('keeps memory unchanged when persistence fails', async () => {
    stored.value = ['session-1'];
    const manager = new PinnedSessionManager(persistence);
    persistence.set.mockRejectedValueOnce(new Error('write failed'));

    await expect(manager.setPinned('session-2', true)).rejects.toThrow('write failed');
    expect(manager.list()).toEqual(['session-1']);
  });

  it('keeps reorder state unchanged when persistence fails', async () => {
    stored.value = ['session-1', 'session-2'];
    const manager = new PinnedSessionManager(persistence);
    persistence.set.mockRejectedValueOnce(new Error('write failed'));

    await expect(manager.reorder('session-1', 'session-2')).rejects.toThrow('write failed');
    expect(manager.list()).toEqual(['session-1', 'session-2']);
  });
});
