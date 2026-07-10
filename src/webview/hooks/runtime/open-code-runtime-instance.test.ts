import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDefaultAppState, state } from '../../lib/state';
import { sessionStore } from '../../lib/stores/session-store';
import type { SessionStatus } from '../../types';
import {
  createPerSessionMessageSyncGenerations,
  createSessionStatusSnapshotCoordinator,
} from './open-code-runtime-instance';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('open code runtime synchronization', () => {
  beforeEach(() => {
    resetDefaultAppState();
  });

  it('retains the original request timestamp for cached status snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const pendingStatuses = deferred<Record<string, SessionStatus>>();
    const loadSessionStatuses = vi.fn(() => pendingStatuses.promise);
    const snapshots = createSessionStatusSnapshotCoordinator(loadSessionStatuses);

    try {
      const firstLoad = snapshots.load();
      await Promise.resolve();
      expect(loadSessionStatuses).toHaveBeenCalledTimes(1);

      vi.setSystemTime(2_000);
      sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
      pendingStatuses.resolve({ 'session-1': { type: 'idle' } });
      const firstSnapshot = await firstLoad;

      vi.setSystemTime(2_050);
      const cachedSnapshot = await snapshots.load();

      expect(cachedSnapshot).toBe(firstSnapshot);
      expect(cachedSnapshot.startedAt).toBe(1_000);
      expect(loadSessionStatuses).toHaveBeenCalledTimes(1);

      sessionStore.setSessionStatuses(cachedSnapshot.statuses, {
        snapshotStartedAt: cachedSnapshot.startedAt,
      });
      expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows message responses for different sessions to apply out of order', async () => {
    const generations = createPerSessionMessageSyncGenerations();
    const sessionA = deferred<void>();
    const sessionB = deferred<void>();
    const applied: string[] = [];
    const sync = (sessionId: string, pending: Promise<void>) =>
      generations.run(sessionId, async (token) => {
        await pending;
        if (generations.isCurrent(token)) applied.push(sessionId);
      });

    const syncA = sync('session-a', sessionA.promise);
    const syncB = sync('session-b', sessionB.promise);

    sessionB.resolve();
    await expect(syncB).resolves.toBe(true);
    sessionA.resolve();
    await expect(syncA).resolves.toBe(true);

    expect(applied).toEqual(['session-b', 'session-a']);
  });

  it('ignores an older message response for the same session', async () => {
    const generations = createPerSessionMessageSyncGenerations();
    const responseA = deferred<void>();
    const responseB = deferred<void>();
    const applied: string[] = [];
    const sync = (label: string, pending: Promise<void>) =>
      generations.run('session-1', async (token) => {
        await pending;
        if (generations.isCurrent(token)) applied.push(label);
      });

    const syncA = sync('a', responseA.promise);
    const syncB = sync('b', responseB.promise);
    responseB.resolve();
    await expect(syncB).resolves.toBe(true);
    responseA.resolve();
    await expect(syncA).resolves.toBe(false);

    expect(applied).toEqual(['b']);
  });
});
