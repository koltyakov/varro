import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { isString } from '../shared/type-utils';
import { THUMBNAIL_MAX_OUTPUT_BYTES } from './image-thumbnail-protocol';
import type {
  ThumbnailFormat,
  ThumbnailInput,
  ThumbnailRequest,
  ThumbnailResponse,
} from './image-thumbnail-protocol';

type Job = {
  request: ThumbnailRequest;
  size: number;
  resolve: (value: string | null) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** One serial codec worker is shared by the extension's views. It never receives file paths or URLs. */
export class ThumbnailWorkerClient {
  private worker: Worker | undefined;
  private stopping = false;
  private active: Job | undefined;
  private readonly queue: Job[] = [];
  private bytes = 0;
  private nextID = 0;
  private deadline: NodeJS.Timeout | undefined;
  private idle: NodeJS.Timeout | undefined;
  private disposed = false;
  private cancellationDeadline: NodeJS.Timeout | undefined;
  private module: WebAssembly.Module | undefined;

  constructor(private readonly workerPath = join(__dirname, 'thumbnail-worker.js')) {}

  convert(
    bytes: ThumbnailInput,
    format: ThumbnailFormat,
    signal: AbortSignal
  ): Promise<string | null> {
    signal.throwIfAborted();
    if (this.disposed) return Promise.reject(new Error('Thumbnail worker client disposed'));
    const size = isString(bytes)
      ? Math.ceil((bytes.length * 3) / 4)
      : 'base64' in bytes
        ? Math.ceil((bytes.base64.byteLength * 3) / 4)
        : bytes.byteLength;
    if (this.queue.length >= 8 || this.bytes + size > 64 * 1024 * 1024) {
      return Promise.reject(new Error('Thumbnail queue is full; retry when previews finish'));
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        request: { id: ++this.nextID, bytes, format },
        size,
        resolve,
        reject,
        cleanup: () => signal.removeEventListener('abort', abort),
      };
      const abort = () => {
        if (this.active === job) {
          // Settle the caller immediately, but let a nearly-complete conversion release the
          // worker normally. Fast viewport churn must not repeatedly compile/allocate WASM.
          job.cleanup();
          job.reject(new Error('Thumbnail request cancelled'));
          this.cancellationDeadline = setTimeout(() => {
            if (this.active === job) this.fail(new Error('Thumbnail request cancelled'));
          }, 250).unref();
        } else {
          const index = this.queue.indexOf(job);
          if (index !== -1) {
            this.queue.splice(index, 1);
            this.finish(job, new Error('Thumbnail request cancelled'));
          }
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      this.bytes += job.size;
      this.queue.push(job);
      this.pump();
    });
  }

  dispose() {
    this.disposed = true;
    this.module = undefined;
    const queued = this.queue.splice(0);
    for (const job of queued) this.finish(job, new Error('Thumbnail worker client disposed'));
    this.fail(new Error('Thumbnail worker client disposed'));
  }

  private pump() {
    if (this.active || this.stopping) return;
    clearTimeout(this.idle);
    const job = this.queue.shift();
    if (!job) {
      if (this.worker) this.idle = setTimeout(() => this.stop(), 30_000).unref();
      return;
    }
    this.active = job;
    this.deadline = setTimeout(
      () => this.fail(new Error('Thumbnail processing timed out')),
      10_000
    ).unref();
    try {
      if (!this.worker) {
        const worker = new Worker(this.workerPath, { workerData: { module: this.module } });
        this.worker = worker;
        worker.on('message', (response: ThumbnailResponse | { module: WebAssembly.Module }) => {
          if (this.worker !== worker || !this.active) return;
          if ('module' in response && response.module instanceof WebAssembly.Module) {
            this.module = response.module;
            return;
          }
          if (!('id' in response)) {
            this.fail(new Error('Invalid thumbnail worker response'));
            return;
          }
          if (
            response.id !== this.active.request.id ||
            (response.bytes !== null &&
              (!(response.bytes instanceof Uint8Array) ||
                response.bytes.byteLength > THUMBNAIL_MAX_OUTPUT_BYTES))
          ) {
            this.fail(new Error('Invalid thumbnail worker response'));
            return;
          }
          const result =
            response.bytes === null
              ? null
              : `data:image/webp;base64,${Buffer.from(response.bytes).toString('base64')}`;
          this.finish(this.active, undefined, result);
        });
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node's worker error event is an untyped runtime boundary.
        worker.on('error', (error: unknown) => {
          if (this.worker === worker)
            this.fail(error instanceof Error ? error : new Error(String(error)));
        });
        worker.on('exit', (code) => {
          if (this.worker === worker) this.fail(new Error(`Thumbnail worker exited (${code})`));
        });
      }
      this.worker.ref();
      // Input arrays own their buffers; transferring releases host-side compressed bytes.
      this.worker.postMessage(
        job.request,
        isString(job.request.bytes)
          ? []
          : [
              'base64' in job.request.bytes
                ? job.request.bytes.base64.buffer
                : job.request.bytes.buffer,
            ]
      );
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private finish(job: Job, error?: Error, result: string | null = null) {
    if (this.active === job) {
      clearTimeout(this.deadline);
      clearTimeout(this.cancellationDeadline);
      this.active = undefined;
      this.worker?.unref();
    }
    this.bytes -= job.size;
    job.cleanup();
    if (error) job.reject(error);
    else job.resolve(result);
    this.pump();
  }

  private fail(error: Error) {
    this.stop();
    if (this.active) this.finish(this.active, error);
  }

  private stop() {
    clearTimeout(this.idle);
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    // Wait for termination before admitting another large WASM heap.
    this.stopping = true;
    void worker.terminate().finally(() => {
      this.stopping = false;
      this.pump();
    });
  }
}
