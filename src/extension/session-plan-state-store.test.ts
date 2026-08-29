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
