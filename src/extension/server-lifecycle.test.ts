import { describe, expect, it, vi } from 'vitest';
import { ServerLifecycleStateMachine } from './server-lifecycle';

describe('ServerLifecycleStateMachine', () => {
  it('tracks start attempts and cancels stale starts after dispose', () => {
    const lifecycle = new ServerLifecycleStateMachine();
    const disposeGeneration = lifecycle.beginStart();
    const attemptId = lifecycle.beginStartAttempt();

    expect(lifecycle.phase).toBe('starting');
    expect(lifecycle.isCurrentStartAttempt(attemptId, disposeGeneration)).toBe(true);

    lifecycle.beginDispose();

    expect(lifecycle.phase).toBe('disposing');
    expect(lifecycle.isDisposing).toBe(true);
    expect(lifecycle.isCurrentStartAttempt(attemptId, disposeGeneration)).toBe(false);
    expect(() => lifecycle.throwIfStartCancelled(disposeGeneration, 'cancelled')).toThrow(
      'cancelled'
    );
  });

  it('caches a start promise until it settles', async () => {
    const lifecycle = new ServerLifecycleStateMachine();
    lifecycle.beginStart();

    const factory = vi.fn(async () => 'http://127.0.0.1:4096');
    const first = lifecycle.setStartPromise(factory);
    const second = lifecycle.setStartPromise(factory);

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);

    await expect(first).resolves.toBe('http://127.0.0.1:4096');
    expect(lifecycle.phase).toBe('idle');
  });

  it('marks managed restarts explicitly and resets when finished', () => {
    const lifecycle = new ServerLifecycleStateMachine();

    expect(lifecycle.beginManagedRestart()).toBe(1);
    expect(lifecycle.phase).toBe('restarting');
    expect(lifecycle.beginManagedRestart()).toBeNull();

    lifecycle.finishManagedRestart();

    expect(lifecycle.phase).toBe('idle');
  });
});
