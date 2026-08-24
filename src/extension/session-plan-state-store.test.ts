/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Test persistence returns fixtures through the generic storage boundary. */
import { describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { SessionPlanStateStore } from './session-plan-state-store';

describe('SessionPlanStateStore', () => {
  it('persists skipped markers and clear tombstones for later webviews', async () => {
    const set = vi.fn(() => Promise.resolve());
    const persistence: Persistence = {
      get: vi.fn(),
      set,
      remove: vi.fn(),
    };
    const store = new SessionPlanStateStore(persistence);

    await store.set('session-1', 200);
    await store.set('session-1', null);

    expect(store.list()).toEqual({ 'session-1': null });
    expect(set).toHaveBeenLastCalledWith('varro.sessionPlanState', { 'session-1': null });
  });

  it('drops invalid persisted entries', () => {
    const persistence: Persistence = {
      get<T>() {
        return {
          'session-1': 200,
          'session-2': 'invalid',
          '': 300,
        } as T;
      },
      set: vi.fn(),
      remove: vi.fn(),
    };

    expect(new SessionPlanStateStore(persistence).list()).toEqual({ 'session-1': 200 });
  });
});
