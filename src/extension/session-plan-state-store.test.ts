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

  it('persists selected agents for later webviews', async () => {
    const set = vi.fn(() => Promise.resolve());
    const persistence: Persistence = {
      get: vi.fn(),
      set,
      remove: vi.fn(),
    };
    const store = new SessionPlanStateStore(persistence);

    await store.setAgent('session-1', 'build');

    expect(store.listAgents()).toEqual({ 'session-1': 'build' });
    expect(set).toHaveBeenLastCalledWith('varro.sessionPlanAgentState', {
      'session-1': 'build',
    });
  });

  it('applies combined plan updates in one queued mutation', async () => {
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(),
    };
    const store = new SessionPlanStateStore(persistence);

    await store.update('session-1', { skippedAt: null, agent: 'build' });

    expect(store.list()).toEqual({ 'session-1': null });
    expect(store.listAgents()).toEqual({ 'session-1': 'build' });
  });

  it.each(['varro.sessionPlanState', 'varro.sessionPlanAgentState'])(
    'keeps the last saved value when an update to %s fails',
    async (failedKey) => {
      const saved = new Map<string, unknown>();
      const persistence: Persistence = {
        get<T>(key: string) {
          return saved.get(key) as T | undefined;
        },
        set: vi.fn<Persistence['set']>(async (key, value) => {
          if (key === failedKey && value !== undefined && saved.has(key)) {
            throw new Error('Storage unavailable');
          }
          saved.set(key, value);
        }),
        remove: vi.fn(),
      };
      const store = new SessionPlanStateStore(persistence);
      await store.update('session-1', { skippedAt: 100, agent: 'plan' });

      await expect(store.update('session-1', { skippedAt: 200, agent: 'build' })).rejects.toThrow(
        'Storage unavailable'
      );
      expect(store.list()).toEqual({
        'session-1': failedKey === 'varro.sessionPlanState' ? 100 : 200,
      });
      expect(store.listAgents()).toEqual({ 'session-1': 'plan' });
    }
  );

  it('removes all persisted state for a deleted session', async () => {
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(),
    };
    const store = new SessionPlanStateStore(persistence);
    await store.update('session-1', { skippedAt: 100, agent: 'build' });

    await store.removeSession('session-1');

    expect(store.list()).toEqual({});
    expect(store.listAgents()).toEqual({});
    expect(persistence.set).toHaveBeenCalledWith('varro.sessionPlanState', {});
    expect(persistence.set).toHaveBeenCalledWith('varro.sessionPlanAgentState', {});
  });

  it('keeps agent restoration for another session while deletion is saving', async () => {
    const persistence: Persistence = { get: vi.fn(), set: vi.fn(async () => {}), remove: vi.fn() };
    const store = new SessionPlanStateStore(persistence);
    await store.setAgent('session-1', 'build');
    let resume!: () => void;
    let begin!: () => void;
    const pending = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    vi.mocked(persistence.set).mockImplementationOnce(() => {
      begin();
      return pending;
    });

    const removal = store.removeSession('session-1');
    await started;
    store.restoreAgent('session-2', 'plan');
    resume();
    await removal;

    expect(store.listAgents()).toEqual({ 'session-2': 'plan' });
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

  it.each(['varro.sessionPlanState', 'varro.sessionPlanAgentState'])(
    'retries deletion after saving %s fails',
    async (failedKey) => {
      const saved = new Map<string, unknown>();
      const persistence: Persistence = {
        get<T>(key: string) {
          return saved.get(key) as T | undefined;
        },
        set: vi.fn<Persistence['set']>(async (key, value) => {
          saved.set(key, value);
        }),
        remove: vi.fn(),
      };
      const store = new SessionPlanStateStore(persistence);
      await store.update('session-1', { skippedAt: 100, agent: 'build' });
      let failed = false;
      vi.mocked(persistence.set).mockImplementation(async (key, value) => {
        if (key === failedKey && !failed) {
          failed = true;
          throw new Error('Storage unavailable');
        }
        saved.set(key, value);
      });

      await expect(store.removeSession('session-1')).rejects.toThrow('Storage unavailable');
      await store.removeSession('session-1');

      const restored = new SessionPlanStateStore(persistence);
      expect(restored.list()).toEqual({});
      expect(restored.listAgents()).toEqual({});
    }
  );
});
