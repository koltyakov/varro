import { $RAW } from 'solid-js/store';
import { isObject, isString } from './runtime-values';
import type { MessageEntry } from '../types';

const MAX_HISTORY_CACHE_BYTES = 24 * 1024 * 1024;

// Conservative retained-size estimate, without serializing payloads or allocating string copies.
// Count shared values separately across snapshots; live transcript ownership is outside this cache.
function estimateBytes(value: readonly MessageEntry[]): number {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let bytes = 0;
  while (pending.length && bytes <= MAX_HISTORY_CACHE_BYTES) {
    const candidate = pending.pop();
    // Counting a store snapshot must not create proxies and reactive nodes for every
    // historical field. Read its backing object without changing the cached entries.
    // SAFETY: isObject narrows to an object; Solid's optional $RAW value remains unknown.
    const item = isObject(candidate)
      ? ((candidate as { [$RAW]?: unknown })[$RAW] ?? candidate)
      : candidate;
    if (isString(item)) bytes += item.length * 2;
    else if (isObject(item) && !seen.has(item)) {
      seen.add(item);
      bytes += 64;
      for (const [key, child] of Object.entries(item)) {
        bytes += key.length * 2 + 16;
        pending.push(child);
      }
    } else bytes += 8;
  }
  return bytes;
}

export class HistoryCacheBudget {
  private entries = new Map<string, { bytes: number; evict: () => void }>();
  private bytes = 0;

  retain(key: string, value: readonly MessageEntry[], evict: () => void) {
    this.delete(key);
    const bytes = estimateBytes(value);
    if (bytes > MAX_HISTORY_CACHE_BYTES) {
      evict();
      return;
    }
    this.entries.set(key, { bytes, evict });
    this.bytes += bytes;
    while (this.bytes > MAX_HISTORY_CACHE_BYTES) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.delete(oldest[0]);
      oldest[1].evict();
    }
  }

  touch(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  delete(key: string) {
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
