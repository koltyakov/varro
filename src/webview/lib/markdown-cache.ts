type CacheEntry = { cache: MarkdownStringCache; key: string; value: string; bytes: number };
export type MarkdownStringCache = Map<string, CacheEntry>;

const BYTE_BUDGET = 2 * 1024 * 1024;
const ENTRY_LIMIT = 100;
const lru = new Map<CacheEntry, true>();
let bytes = 0;

export function getUtf8ByteLength(value: string): number {
  let size = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) size++;
    else if (code <= 0x7ff) size += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      size += 4;
      index++;
    } else size += 3;
  }
  return size;
}

function remove(entry: CacheEntry) {
  entry.cache.delete(entry.key);
  lru.delete(entry);
  bytes -= entry.bytes;
}

export function getCachedValue(cache: MarkdownStringCache, key: string): string | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  lru.delete(entry);
  lru.set(entry, true);
  return entry.value;
}

export function setCachedValue(cache: MarkdownStringCache, key: string, value: string): void {
  const existing = cache.get(key);
  if (existing) remove(existing);
  const size = getUtf8ByteLength(key) + getUtf8ByteLength(value);
  if (size > BYTE_BUDGET) return;
  while (cache.size >= ENTRY_LIMIT) remove(cache.values().next().value!);
  while (bytes + size > BYTE_BUDGET) remove(lru.keys().next().value!);
  const entry = { cache, key, value, bytes: size };
  cache.set(key, entry);
  lru.set(entry, true);
  bytes += size;
}

export function resetMarkdownCaches(): void {
  for (const entry of lru.keys()) entry.cache.clear();
  lru.clear();
  bytes = 0;
}

export function markdownCacheStats() {
  return { bytes, byteBudget: BYTE_BUDGET, entries: lru.size };
}
