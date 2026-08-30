/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Test persistence returns a fixture through the generic storage boundary. */
import { describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { SessionHistoryScopeStore } from './session-history-scope-store';

describe('SessionHistoryScopeStore', () => {
  it('restores valid scopes and persists updates', async () => {
    const persistence: Persistence = {
      get<T>(key: string) {
        return (
          key === 'varro.sessionHistoryScopes'
            ? {
                'project:one': 'project',
                'directory:/tmp': 'descendants',
                invalid: 'workspace',
              }
            : { '/repo': 'project:one' }
        ) as T;
      },
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionHistoryScopeStore(persistence);

    expect(store.get('project:one')).toBe('project');
    expect(store.getForRoot('/repo')).toBe('project');
    expect(store.get('invalid')).toBe('directory');
    await store.set('project:two', 'descendants');

    expect(persistence.set).toHaveBeenCalledWith('varro.sessionHistoryScopes', {
      'project:one': 'project',
      'directory:/tmp': 'descendants',
      'project:two': 'descendants',
    });
  });

  it('persists root-to-project associations', async () => {
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(),
    };
    const store = new SessionHistoryScopeStore(persistence);

    await store.associate('/repo', 'project:one');
    await store.set('project:one', 'project');

    expect(store.getForRoot('/repo')).toBe('project');
    expect(persistence.set).toHaveBeenCalledWith('varro.sessionHistoryScopeProjects', {
      '/repo': 'project:one',
    });
  });

  it('serializes concurrent updates', async () => {
    const writes: unknown[] = [];
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi.fn(async <T>(_key: string, value: T) => {
        writes.push(value);
      }),
      remove: vi.fn(),
    };
    const store = new SessionHistoryScopeStore(persistence);

    await Promise.all([
      store.set('project:one', 'project'),
      store.set('project:two', 'descendants'),
    ]);

    expect(writes.at(-1)).toEqual({
      'project:one': 'project',
      'project:two': 'descendants',
    });
  });
});
