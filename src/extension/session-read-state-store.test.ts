import { describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { SessionReadStateStore } from './session-read-state-store';

function storage() {
  const values = new Map<string, unknown>();
  const persistence: Persistence = {
    // SAFETY: This in-memory fixture stores the values supplied by Persistence callers.
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: vi.fn(<T>(key: string, value: T) => {
      values.set(key, value);
    }),
    remove: (key: string) => {
      values.delete(key);
    },
  };
  return { persistence, values };
}

describe('SessionReadStateStore', () => {
  it('shares read timestamps across folder and workspace instances without regressing imported markers', async () => {
    const { persistence } = storage();
    const folder = new SessionReadStateStore(persistence);
    const workspace = new SessionReadStateStore(persistence);
    await folder.set('project-chat', 200);
    expect(workspace.list()).toEqual({ 'project-chat': 200 });
    await workspace.set('project-chat', 100);
    await workspace.set('second-folder-chat', 300);
    await folder.set('project-chat', 400);
    expect(new SessionReadStateStore(persistence).list()).toEqual({
      'project-chat': 400,
      'second-folder-chat': 300,
    });
  });

  it('validates saved timestamps and continues after a failed write', async () => {
    const { persistence, values } = storage();
    values.set('varro.sessionReadState', {
      valid: 0,
      negative: -1,
      invalid: '100',
      infinite: Infinity,
    });
    const store = new SessionReadStateStore(persistence);
    expect(store.list()).toEqual({ valid: 0 });
    vi.mocked(persistence.set).mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    await expect(store.set('chat', 100)).rejects.toThrow('write failed');
    await store.set('chat', 200);
    await store.dispose();
    expect(store.list()).toEqual({ valid: 0, chat: 200 });
  });
});
