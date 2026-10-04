import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ThumbnailWorkerClient } from './image-thumbnail-worker-client';

type MockWorker = EventEmitter & {
  postMessage: Mock;
  ref: Mock;
  unref: Mock;
  terminate: Mock<() => Promise<number>>;
  options: { workerData: { module?: WebAssembly.Module } };
};
const workers = vi.hoisted(() => {
  const instances: MockWorker[] = [];
  return { instances };
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise process failures and deadlines at the Node worker boundary without hanging real threads.
vi.mock('node:worker_threads', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    Worker: class extends Emitter {
      postMessage = vi.fn();
      ref = vi.fn();
      unref = vi.fn();
      terminate = vi.fn(async () => 0);
      constructor(
        _path: string,
        readonly options: { workerData: { module?: WebAssembly.Module } }
      ) {
        super();
        workers.instances.push(this);
      }
    },
  };
});

let client: ThumbnailWorkerClient;
const input = () => new Uint8Array([1, 2, 3]);
const signal = () => new AbortController().signal;
const response = (id: number) => ({ id, bytes: new Uint8Array([4, 5, 6]) });

beforeEach(() => {
  vi.useFakeTimers();
  workers.instances.length = 0;
  client = new ThumbnailWorkerClient();
});
afterEach(() => {
  client.dispose();
  vi.useRealTimers();
});

describe('thumbnail worker lifecycle', () => {
  it('settles active cancellation immediately but reuses a worker that finishes during the grace period', async () => {
    const controller = new AbortController();
    const first = client.convert(input(), 'png', controller.signal);
    const rejected = expect(first).rejects.toThrow('cancelled');
    controller.abort();
    await rejected;
    const next = client.convert(input(), 'png', signal());
    const worker = workers.instances[0]!;
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit('message', response(1));
    worker.emit('message', response(2));
    await expect(next).resolves.toMatch(/^data:image\/webp/);
    await vi.advanceTimersByTimeAsync(250);
    expect(workers.instances).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('terminates cancelled work that exceeds the grace period and recovers', async () => {
    const controller = new AbortController();
    const first = client.convert('AAAA', 'png', controller.signal);
    const rejected = expect(first).rejects.toThrow('cancelled');
    controller.abort();
    await rejected;
    const next = client.convert(input(), 'png', signal());
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    workers.instances[0]!.emit('message', { module });
    await vi.advanceTimersByTimeAsync(250);
    expect(workers.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(workers.instances[1]!.options.workerData.module).toBe(module);
    workers.instances[1]!.emit('message', response(2));
    await expect(next).resolves.toMatch(/^data:image\/webp/);
  });

  it('starts lazily, serializes jobs and releases the idle WASM heap', async () => {
    expect(workers.instances).toHaveLength(0);
    const first = client.convert(input(), 'png', signal());
    const second = client.convert(input(), 'jpeg', signal());
    const worker = workers.instances[0]!;
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.emit('message', response(1));
    expect(await first).toMatch(/^data:image\/webp/);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.emit('message', response(2));
    await second;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const third = client.convert(input(), 'webp', signal());
    expect(workers.instances).toHaveLength(2);
    workers.instances[1]!.emit('message', response(3));
    await third;
  });

  it('removes cancelled queued work without interrupting the active job', async () => {
    const active = client.convert(input(), 'png', signal());
    const controller = new AbortController();
    const cancelled = client.convert(input(), 'png', controller.signal);
    const rejected = expect(cancelled).rejects.toThrow('cancelled');
    controller.abort();
    await rejected;
    expect(workers.instances[0]!.terminate).not.toHaveBeenCalled();
    workers.instances[0]!.emit('message', response(1));
    await active;
    expect(workers.instances[0]!.postMessage).toHaveBeenCalledTimes(1);
  });

  it('kills stalled work, waits for termination and ignores late responses', async () => {
    const stalled = client.convert(input(), 'png', signal());
    const rejected = expect(stalled).rejects.toThrow('timed out');
    const next = client.convert(input(), 'png', signal());
    const oldWorker = workers.instances[0]!;
    let terminate: (code: number) => void = () => {};
    oldWorker.terminate.mockImplementation(
      () =>
        new Promise((resolve) => {
          terminate = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(workers.instances).toHaveLength(1);
    oldWorker.emit('message', response(1));
    terminate(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(workers.instances).toHaveLength(2);
    workers.instances[1]!.emit('message', response(2));
    await expect(next).resolves.toMatch(/^data:image\/webp/);
  });

  it('recovers from worker startup errors without caching a failed preview', async () => {
    const first = client.convert(input(), 'png', signal());
    const rejected = expect(first).rejects.toThrow('missing WASM');
    workers.instances[0]!.emit('error', new Error('missing WASM'));
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    const retry = client.convert(input(), 'png', signal());
    workers.instances[1]!.emit('message', response(2));
    await expect(retry).resolves.toMatch(/^data:image\/webp/);
  });

  it('rejects queue overflow and settles all consumers on disposal', async () => {
    const requests = Array.from({ length: 9 }, () => client.convert(input(), 'png', signal()));
    await expect(client.convert(input(), 'png', signal())).rejects.toThrow('queue is full');
    const rejected = requests.map((request) => expect(request).rejects.toThrow('disposed'));
    client.dispose();
    await Promise.all(rejected);
    await expect(client.convert(input(), 'png', signal())).rejects.toThrow('disposed');
    expect(workers.instances).toHaveLength(1);
  });
});
