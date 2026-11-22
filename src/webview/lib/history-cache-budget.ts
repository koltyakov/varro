import { $TARGET } from '@solidjs/signals';
import { snapshot } from 'solid-js';
import { isObject, isString } from './runtime-values';
import type { UnknownRecord } from '../../shared/type-utils';
import type { MessageEntry } from '../types';

const MAX_HISTORY_CACHE_BYTES = 24 * 1024 * 1024;

// Conservative retained-size estimate, without serializing payloads or allocating string copies.
// Count shared values separately across snapshots; live transcript ownership is outside this cache.
function estimateBytes(value: readonly MessageEntry[]): number {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let bytes = 0;
  while (pending.length && bytes <= MAX_HISTORY_CACHE_BYTES) {
    const item = pending.pop();
    if (isString(item)) bytes += item.length * 2;
    else if (isObject(item) && !seen.has(item)) {
      seen.add(item);
      // Cached rows are store records. Read each one through its current plain snapshot, including
      // pending writes of the enclosing transaction, instead of walking every field through proxies.
      const record: object = $TARGET in item ? snapshot(item) : item;
      if (record !== item) {
        if (seen.has(record)) {
          bytes += 8;
          continue;
        }
        seen.add(record);
      }
      bytes += 64;
      // SAFETY: Object.keys lists only own string keys of this plain object or array.
      const fields = record as UnknownRecord;
      // Avoid Object.entries' per-field pair arrays; each prepend walks every retained record.
      for (const key of Object.keys(fields)) {
        bytes += key.length * 2 + 16;
        pending.push(fields[key]);
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
