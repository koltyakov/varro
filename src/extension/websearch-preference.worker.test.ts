/* oxlint-disable anti-slop/no-module-mocking -- Model worker failures and deadlines without opening a database. */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasStoredWebSearchPreference } from './websearch-preference';

const { createWorker } = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock('node:worker_threads', () => ({
  Worker: function Worker() {
    return createWorker();
  },
}));

describe('web search preference worker lifecycle', () => {
  let worker: EventEmitter & { terminate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('OPENCODE_DB', '/fixture/never-opened.db');
    worker = Object.assign(new EventEmitter(), { terminate: vi.fn() });
    createWorker.mockReturnValue(worker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('terminates a stalled reader after two seconds', async () => {
    const result = expect(hasStoredWebSearchPreference()).rejects.toThrow('Timed out');
    await vi.advanceTimersByTimeAsync(2_000);
    await result;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['exit', 'error'])('rejects an early worker %s', async (event) => {
    const result = expect(hasStoredWebSearchPreference()).rejects.toThrow();
    worker.emit(event, event === 'error' ? new Error('reader failed') : 0);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline after a result', async () => {
    const result = hasStoredWebSearchPreference();
    worker.emit('message', true);
    await expect(result).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
