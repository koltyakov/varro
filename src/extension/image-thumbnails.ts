import { THUMBNAIL_MAX_INPUT_BYTES } from './image-thumbnail-protocol';
import type { ThumbnailFormat } from './image-thumbnail-protocol';
import { ThumbnailWorkerClient } from './image-thumbnail-worker-client';

const worker = new ThumbnailWorkerClient();
const CACHE_TTL_MS = 5 * 60_000;
type PendingThumbnail = {
  controller: AbortController;
  promise: Promise<string | null>;
  users: number;
};

/** Memory-only, bounded previews. Empty caches always fall back to generation from originals. */
export class ImageThumbnails {
  private readonly cache = new Map<string, { url: string; expires: number }>();
  private readonly pending = new Map<string, PendingThumbnail>();
  private bytes = 0;
  private disposed = false;
  private sweep: NodeJS.Timeout | undefined;

  constructor(private readonly client = worker) {}

  peek(key: string): string | undefined {
    const value = this.cache.get(key);
    if (!value) return undefined;
    if (value.expires <= Date.now()) {
      this.remove(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, value);
    return value.url;
  }

  async get(key: string, source: string, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error('Thumbnail service disposed');
    const cached = this.peek(key);
    if (cached !== undefined) return cached;
    let pending = this.pending.get(key);
    if (!pending) {
      if (source.length > (THUMBNAIL_MAX_INPUT_BYTES * 4) / 3 + 64) return null;
      const match = /^data:image\/(png|jpeg|webp|gif|avif);base64,/i.exec(source);
      if (!match) return null;
      const bytes = Uint8Array.from(Buffer.from(source.slice(match[0].length), 'base64'));
      if (!bytes.length || bytes.length > THUMBNAIL_MAX_INPUT_BYTES) return null;
      const controller = new AbortController();
      pending = {
        controller,
        users: 0,
        // SAFETY: The anchored regex above accepts exactly the ThumbnailFormat members.
        promise: this.client
          .convert(bytes, match[1]!.toLowerCase() as ThumbnailFormat, controller.signal)
          .then((url) => {
            if (url && !controller.signal.aborted && !this.disposed) this.remember(key, url);
            return url;
          })
          .finally(() => {
            if (this.pending.get(key)?.controller === controller) this.pending.delete(key);
          }),
      };
      this.pending.set(key, pending);
    }
    const request = pending;
    request.users += 1;
    try {
      return await new Promise<string | null>((resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new Error('Thumbnail request cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        void request.promise
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener('abort', abort));
      });
    } finally {
      request.users -= 1;
      if (!request.users && this.pending.get(key) === request) {
        this.pending.delete(key);
        request.controller.abort();
      }
    }
  }

  dispose() {
    this.disposed = true;
    for (const request of this.pending.values()) request.controller.abort();
    this.pending.clear();
    this.cache.clear();
    this.bytes = 0;
    clearInterval(this.sweep);
    this.sweep = undefined;
  }

  private remove(key: string) {
    this.bytes -= (this.cache.get(key)?.url.length ?? 0) * 2;
    this.cache.delete(key);
    if (!this.cache.size) {
      clearInterval(this.sweep);
      this.sweep = undefined;
    }
  }

  private remember(key: string, url: string) {
    this.remove(key);
    this.cache.set(key, { url, expires: Date.now() + CACHE_TTL_MS });
    this.bytes += url.length * 2;
    while (this.bytes > 4 * 1024 * 1024 || this.cache.size > 64) {
      this.remove(this.cache.keys().next().value!);
    }
    this.sweep ??= setInterval(() => {
      for (const [cacheKey, value] of this.cache) {
        if (value.expires <= Date.now()) this.remove(cacheKey);
      }
    }, 60_000).unref();
  }
}
