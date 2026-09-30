/* oxlint-disable anti-slop/no-module-mocking -- Control worker message and exit ordering to verify that read completion waits for SQLite handle cleanup. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacySessionImport } from './legacy-session-import';

const mocks = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
  return { worker };
});

vi.mock('node:worker_threads', () => {
  const Worker = vi.fn(function () {
    return mocks.worker;
  });
  return { Worker, default: { Worker } };
});

beforeEach(() => {
  mocks.worker.removeAllListeners();
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('legacy history reader lifecycle', () => {
  it('waits for worker exit after receiving data', async () => {
    const importer = new LegacySessionImport(vi.fn(), 'fixture.db');
    const settled = vi.fn();
    const reading = importer.list('/fixture').then(settled);
    mocks.worker.emit('message', { data: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    mocks.worker.emit('exit', 0);
    await reading;
    expect(settled).toHaveBeenCalledWith([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for worker exit before reporting a database error', async () => {
    const importer = new LegacySessionImport(vi.fn(), 'fixture.db');
    const settled = vi.fn();
    const reading = importer.list('/fixture').catch(settled);
    mocks.worker.emit('message', { error: 'Invalid history' });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    mocks.worker.emit('exit', 0);
    await reading;
    expect(settled).toHaveBeenCalledWith(new Error('Invalid history'));
  });

  it('rejects a worker that exits without sending a result', async () => {
    const importer = new LegacySessionImport(vi.fn(), 'fixture.db');
    const reading = importer.list('/fixture');
    mocks.worker.emit('exit', 0);
    await expect(reading).rejects.toThrow('Legacy history reader exited without a result');
  });

  it('rejects an abnormal exit even after receiving data', async () => {
    const importer = new LegacySessionImport(vi.fn(), 'fixture.db');
    const reading = importer.list('/fixture');
    mocks.worker.emit('message', { data: [] });
    mocks.worker.emit('exit', 1);
    await expect(reading).rejects.toThrow('Legacy history reader exited with code 1');
  });

  it('waits for exit after a worker error and preserves the error', async () => {
    const importer = new LegacySessionImport(vi.fn(), 'fixture.db');
    const settled = vi.fn();
    const error = new Error('Worker failed');
    const reading = importer.list('/fixture').catch(settled);
    mocks.worker.emit('error', error);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    mocks.worker.emit('exit', 1);
    await reading;
    expect(settled).toHaveBeenCalledWith(error);
  });

  it('keeps the timeout active until the worker exits', async () => {
    const importer = new LegacySessionImport(vi.fn(), 'fixture.db');
    const reading = importer.list('/fixture');
    const rejection = expect(reading).rejects.toThrow('Reading v1 history timed out');
    mocks.worker.emit('message', { data: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.worker.terminate).toHaveBeenCalledOnce();
    mocks.worker.emit('exit', 1);
    await rejection;
  });
});
