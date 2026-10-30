/* oxlint-disable anti-slop/no-module-mocking -- Exercise worker cancellation, deadlines, teardown and malformed replies without waiting on real deadlines. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalSessionTranscriptReader } from './local-session-transcript';
import { SessionTranscriptArchive } from './session-transcript-archive';
import type { TranscriptArchiveSession } from './session-transcript-archive';

const workers = vi.hoisted(() => {
  class FakeWorker {
    readonly listeners = new Map<string, (...args: unknown[]) => void>();
    readonly terminate = vi.fn(async () => 0);
    constructor() {
      instances.push(this);
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, listener);
      return this;
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      return this.on(event, listener);
    }
  }
  const instances: FakeWorker[] = [];
  return { FakeWorker, instances };
});
vi.mock('node:worker_threads', () => ({ Worker: workers.FakeWorker }));

const directories: string[] = [];
beforeEach(() => {
  workers.instances.length = 0;
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture() {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'transcript-worker-'));
  directories.push(root);
  const path = join(root, 'opencode.db');
  await writeFile(path, '');
  vi.stubEnv('OPENCODE_DB', path);
  const session: TranscriptArchiveSession = { id: 'test', directory: root, updated: 100 };
  const progress = vi.fn();
  const controller = new AbortController();
  const archive = new SessionTranscriptArchive({ apiVersion: 1, request: async () => [] });
  return { session, progress, controller, archive };
}

describe('transcript worker lifetime', () => {
  it('does not start local reading for a pre-cancelled operation', async () => {
    const f = await fixture();
    f.controller.abort();
    await expect(
      new LocalSessionTranscriptReader().read([f.session], f.progress, f.controller.signal)
    ).rejects.toThrow();
    expect(workers.instances).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels local reading once and ignores late results and progress', async () => {
    const f = await fixture();
    const operation = new LocalSessionTranscriptReader().read(
      [f.session],
      f.progress,
      f.controller.signal
    );
    const rejected = expect(operation).rejects.toThrow('cancelled');
    const worker = workers.instances[0]!;
    worker.listeners.get('message')?.({ progress: 'Reading parts' });
    f.controller.abort();
    await rejected;
    worker.listeners.get('message')?.({ histories: [{ id: 'test', messages: [] }] });
    worker.listeners.get('message')?.({ progress: 'Late progress' });
    expect(f.progress).toHaveBeenCalledExactlyOnceWith('Reading parts');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds local reading to 60 seconds even with progress', async () => {
    const f = await fixture();
    const operation = new LocalSessionTranscriptReader().read([f.session], f.progress);
    const rejected = expect(operation).rejects.toThrow('timed out after 60 seconds');
    const worker = workers.instances[0]!;
    await vi.advanceTimersByTimeAsync(30_000);
    worker.listeners.get('message')?.({ progress: 'Read 1000 messages' });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { histories: [{ id: 'unrequested', messages: [] }] },
    {
      histories: [
        { id: 'test', messages: [] },
        { id: 'test', messages: [] },
      ],
    },
    { histories: [{ id: 'test', messages: null }] },
    { saved: 1 },
  ])('rejects malformed local replies %#', async (reply) => {
    const f = await fixture();
    const operation = new LocalSessionTranscriptReader().read([f.session]);
    const rejected = expect(operation).rejects.toThrow('Malformed local transcript');
    workers.instances[0]!.listeners.get('message')?.(reply);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues listening after writer progress until the commit acknowledgement', async () => {
    const f = await fixture();
    const operation = f.archive.archive([f.session], { onProgress: f.progress });
    await vi.advanceTimersByTimeAsync(0);
    const worker = workers.instances[0]!;
    worker.listeners.get('message')?.({ progress: 'Writing 1000 turns' });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.listeners.get('message')?.({ saved: 1 });
    await operation;
    expect(f.progress).toHaveBeenCalledWith('Writing 1000 turns');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for writer teardown on cancellation and ignores a late commit reply', async () => {
    const f = await fixture();
    const operation = f.archive.archive([f.session], {
      signal: f.controller.signal,
      onProgress: f.progress,
    });
    const rejected = expect(operation).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(0);
    const worker = workers.instances[0]!;
    let release = () => {};
    worker.terminate.mockImplementation(
      () =>
        new Promise((resolveTeardown) => {
          release = () => resolveTeardown(0);
        })
    );
    let finished = false;
    const completion = operation.catch(() => {
      finished = true;
    });
    f.controller.abort();
    worker.listeners.get('message')?.({ saved: 1 });
    worker.listeners.get('message')?.({ progress: 'Late progress' });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(f.progress).not.toHaveBeenCalledWith('Late progress');
    release();
    await rejected;
    await completion;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the 30-second write deadline after history reading', async () => {
    const f = await fixture();
    const operation = f.archive.archive([f.session]);
    const rejected = expect(operation).rejects.toThrow('write timed out');
    await vi.advanceTimersByTimeAsync(0);
    const worker = workers.instances[0]!;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
