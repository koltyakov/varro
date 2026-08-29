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
    ];
    pending.resolve([
      { id: 'session-1', directory: '/repo' },
      { id: 'session-2', directory: '/repo' },
    ]);

    const [left, right] = await Promise.all(refreshes);
    expect(left).toBe(right);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
