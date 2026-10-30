/* oxlint-disable anti-slop/no-module-mocking -- Model a native worker stuck in SQLite so timeout behavior is deterministic without touching real databases. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { AboutDatabase } from './about-database';

type WorkerMessage = {
  oldestAt?: number;
  sizeBytes?: number;
  projects?: number;
  sessions?: number;
  complete?: boolean;
  error?: string;
};
type ControlledWorker = {
  emit(event: 'message', payload: WorkerMessage): boolean;
  emit(event: 'exit', code: number): boolean;
  terminate: Mock<() => Promise<number>>;
};
const workers = vi.hoisted(() => {
  const instances: ControlledWorker[] = [];
  return { instances };
});
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      readonly terminate = vi.fn<() => Promise<number>>(() => new Promise(() => {}));
      constructor() {
        super();
        workers.instances.push(this);
      }
    },
  };
});

afterEach(() => {
  for (const worker of workers.instances.splice(0)) worker.emit('exit', 0);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('About database worker deadlines', () => {
  it('does not recache an old worker after cleanup invalidates its snapshot', async () => {
    const reader = new AboutDatabase({ isAttachOnly: false });
    const old = reader.read();
    const first = workers.instances[0]!;
    reader.invalidate();
    first.emit('message', { sizeBytes: 1000, projects: 1, sessions: 9, complete: true });
    await old;
    expect(reader.snapshot().sessions).toBe('Loading...');
    const current = reader.read();
    workers.instances[1]!.emit('message', {
      sizeBytes: 1000,
      projects: 1,
      sessions: 2,
      complete: true,
    });
    expect((await current).sessions).toBe('2');
  });

  it('refreshes after invalidation without joining a pre-cleanup worker still in flight', async () => {
    const reader = new AboutDatabase({ isAttachOnly: false });
    const old = reader.read();
    reader.invalidate();
    const current = reader.read();
    expect(workers.instances).toHaveLength(2);
    workers.instances[1]!.emit('message', {
      sizeBytes: 1000,
      projects: 1,
      sessions: 2,
      complete: true,
    });
    await current;
    workers.instances[0]!.emit('message', {
      sizeBytes: 1000,
      projects: 1,
      sessions: 9,
      complete: true,
    });
    await old;
    expect(reader.snapshot().sessions).toBe('2');
  });

  it.each([
    [Date.UTC(2026, 0, 29, 12), '9 months'],
    [Date.UTC(2026, 8, 29, 12), '1 month'],
    [Date.UTC(2023, 8, 29, 12), '37 months'],
    [Date.UTC(2026, 9, 28, 12), '1 day'],
    [Date.UTC(2026, 9, 29, 11), '<1 day'],
    [Date.UTC(2026, 9, 29, 11) + 0.5, '<1 day'],
    [Date.UTC(2026, 9, 30, 12), 'Unknown'],
    [0, 'Unknown'],
    [Number.MAX_SAFE_INTEGER, 'Unknown'],
  ])('formats oldest stored history time %s as %s', async (oldestAt, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 29, 12));
    const reading = new AboutDatabase({ isAttachOnly: false }).read();
    workers.instances[0]!.emit('message', {
      sizeBytes: 1_000_000,
      oldestAt,
      projects: 1,
      sessions: 2,
      complete: true,
    });
    expect((await reading).age).toBe(expected);
  });

  it('clamps the creation-day anniversary at the end of a shorter month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 1, 28, 12));
    const reading = new AboutDatabase({ isAttachOnly: false }).read();
    workers.instances[0]!.emit('message', {
      sizeBytes: 1_000_000,
      oldestAt: Date.UTC(2026, 0, 31, 12),
      projects: 1,
      sessions: 2,
      complete: true,
    });
    expect((await reading).age).toBe('1 month');
  });
  it('returns partial details at the deadline without waiting for native worker teardown', async () => {
    vi.useFakeTimers();
    const reader = new AboutDatabase({ isAttachOnly: false });
    let resolved = false;
    const reading = reader.read().then((details) => {
      resolved = true;
      return details;
    });
    const worker = workers.instances[0]!;
    worker.emit('message', { sizeBytes: 1_500_000_000, complete: false });
    worker.emit('message', { projects: 7, complete: false });
    expect(reader.snapshot().size).toBe('1.5 GB');
    expect(reader.snapshot().projects).toBe('7');
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(resolved).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
    const result = await reading;
    expect(result.size).toBe('1.5 GB');
    expect(result.projects).toBe('7');
    expect(result.sessions).toBe('Unknown');
    expect(result.note).toContain('timed out');
  });

  it('does not pile up workers while a timed-out native query is still stopping', async () => {
    vi.useFakeTimers();
    const reader = new AboutDatabase({ isAttachOnly: false });
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(3_000);
    await first;
    await vi.advanceTimersByTimeAsync(30_001);
    await reader.read();
    expect(workers.instances).toHaveLength(1);
    workers.instances[0]!.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(30_001);
    const second = reader.read();
    expect(workers.instances).toHaveLength(2);
    workers.instances[1]!.emit('message', {
      sizeBytes: 1_000_000,
      projects: 2,
      sessions: 3,
      complete: true,
    });
    expect((await second).sessions).toBe('3');
  });

  it('retains known size and project counts when later queries fail', async () => {
    const reader = new AboutDatabase({ isAttachOnly: false });
    const reading = reader.read();
    workers.instances[0]!.emit('message', { sizeBytes: 2_000_000, projects: 4, complete: false });
    workers.instances[0]!.emit('message', { error: 'database is locked', complete: true });
    const result = await reading;
    expect(result.size).toBe('2.0 MB');
    expect(result.projects).toBe('4');
    expect(result.note).toContain('database is locked');
  });
});
