import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSessionStatusCoordinator } from './workspace-session-status-coordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('WorkspaceSessionStatusCoordinator', () => {
  it('shares concurrent status reads without coupling consumer cancellation', async () => {
    const coordinator = new WorkspaceSessionStatusCoordinator();
    const pending = deferred<unknown>();
    const load = vi.fn(() => pending.promise);
    const firstController = new AbortController();

    const first = coordinator.requestStatus('/repo', load, firstController.signal);
    const second = coordinator.requestStatus('/repo', load);
    firstController.abort(new Error('first view reloaded'));
    pending.resolve({ session: { type: 'busy' } });

    await expect(first).rejects.toThrow('first view reloaded');
    await expect(second).resolves.toEqual({ session: { type: 'busy' } });
    expect(load).toHaveBeenCalledOnce();
  });

  it('shares a raw catalog and deduplicates forced refreshes', async () => {
    const coordinator = new WorkspaceSessionStatusCoordinator();
    const initialLoad = vi.fn(async () => [{ id: 'session-1', directory: '/repo' }]);

    const first = await coordinator.requestCatalog('/repo', initialLoad);
    const cached = await coordinator.requestCatalog('/repo', initialLoad);

    expect(cached).toBe(first);
    expect(initialLoad).toHaveBeenCalledOnce();

    const pending = deferred<unknown>();
    const refresh = vi.fn(() => pending.promise);
    const refreshes = [
      coordinator.requestCatalog('/repo', refresh, { force: true }),
      coordinator.requestCatalog('/repo', refresh, { force: true }),
      coordinator.requestCatalog('/repo', initialLoad),
    ];
    pending.resolve([
      { id: 'session-1', directory: '/repo' },
      { id: 'session-2', directory: '/repo' },
    ]);

    const [left, right, poll] = await Promise.all(refreshes);
    expect(left).toBe(right);
    expect(poll).toBe(left);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('expires catalogs without extending their lifetime on cache hits', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const coordinator = new WorkspaceSessionStatusCoordinator();
      const load = vi.fn(async () => []);
      const initial = await coordinator.requestCatalog('/repo', load);
      now.mockReturnValue(5_999);
      expect(await coordinator.requestCatalog('/repo', load)).toBe(initial);
      now.mockReturnValue(6_000);
      expect(await coordinator.requestCatalog('/repo', load)).not.toBe(initial);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it.each(['all', 'outside'])(
    'does not reuse or cache an invalidated %s in-flight catalog',
    async (kind) => {
      const coordinator = new WorkspaceSessionStatusCoordinator();
      const pending = deferred<unknown>();
      const oldRequest = coordinator.requestCatalog('/repo', () => pending.promise);
      if (kind === 'all') coordinator.clearCatalogs();
      else coordinator.clearCatalogsOutside(new Set(['/other']));

      const load = vi.fn(async () => [{ id: 'new-session' }]);
      const current = await coordinator.requestCatalog('/repo', load);
      pending.resolve([{ id: 'old-session' }]);
      await oldRequest;

      expect(await coordinator.requestCatalog('/repo', load)).toBe(current);
      expect(current.sessions).toEqual([{ id: 'new-session' }]);
      expect(load).toHaveBeenCalledOnce();
    }
  );

  it('retries failed refreshes instead of falling back to an expired catalog', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const coordinator = new WorkspaceSessionStatusCoordinator();
      await coordinator.requestCatalog('/repo', async () => []);
      now.mockReturnValue(6_000);
      const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
      await expect(coordinator.requestCatalog('/repo', load)).rejects.toThrow('offline');
      await expect(coordinator.requestCatalog('/repo', load)).resolves.toMatchObject({
        sessions: [],
      });
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
});
