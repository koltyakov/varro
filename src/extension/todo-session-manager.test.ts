/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The Memento fixture stores opaque persisted values. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { TodoSessionManager } from './todo-session-manager';

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

describe('TodoSessionManager', () => {
  beforeEach(() => {
    stored.value = undefined;
    vi.clearAllMocks();
  });

  it('loads only valid persisted markers', () => {
    stored.value = { 'session-1': 10, '': 5, 'session-2': 'later', 'session-3': Number.NaN };

    expect(new TodoSessionManager(persistence).list()).toEqual(['session-1']);
    stored.value = ['session-1'];
    expect(new TodoSessionManager(persistence).list()).toEqual([]);
  });

  it('persists markers with the time they were set and publishes each change', async () => {
    const changed = vi.fn();
    const manager = new TodoSessionManager(persistence, changed, () => 100);

    await expect(manager.setTodo('session-1', true)).resolves.toEqual(['session-1']);
    expect(stored.value).toEqual({ 'session-1': 100 });
    await expect(manager.setTodo('session-1', false)).resolves.toEqual([]);
    expect(stored.value).toEqual({});
    expect(changed.mock.calls).toEqual([[['session-1']], [[]]]);
  });

  it('clears a marker only for prompts created after it was set', async () => {
    stored.value = { 'session-1': 100 };
    const changed = vi.fn();
    const manager = new TodoSessionManager(persistence, changed);

    await expect(manager.clearForPrompt('session-1', 99)).resolves.toEqual(['session-1']);
    await expect(manager.clearForPrompt('session-2', 200)).resolves.toEqual(['session-1']);
    expect(persistence.set).not.toHaveBeenCalled();

    await expect(manager.clearForPrompt('session-1', 100)).resolves.toEqual([]);
    expect(stored.value).toEqual({});
    expect(changed).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('removes markers of deleted sessions', async () => {
    stored.value = { 'session-1': 1, 'session-2': 2 };
    const manager = new TodoSessionManager(persistence);

    await expect(manager.remove('session-1')).resolves.toEqual(['session-2']);
    await expect(manager.remove('missing')).resolves.toEqual(['session-2']);
    expect(persistence.set).toHaveBeenCalledTimes(1);
  });

  it('keeps memory unchanged when persistence fails', async () => {
    const changed = vi.fn();
    const manager = new TodoSessionManager(persistence, changed);
    persistence.set.mockRejectedValueOnce(new Error('write failed'));

    await expect(manager.setTodo('session-1', true)).rejects.toThrow('write failed');
    expect(manager.list()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });
});
