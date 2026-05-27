import { describe, expect, it } from 'vitest';
import { createScopedCache } from './scoped-cache';

describe('createScopedCache', () => {
  it('creates and caches values by key', () => {
    let calls = 0;
    const cache = createScopedCache((key) => {
      calls++;
      return { key };
    });

    const a = cache.get('a');
    expect(a.key).toBe('a');
    expect(calls).toBe(1);

    const a2 = cache.get('a');
    expect(a2).toBe(a);
    expect(calls).toBe(1);
  });

  it('evicts least-recently-used entry when max is reached', () => {
    const disposed: string[] = [];
    const cache = createScopedCache((key) => ({ key }), {
      maxEntries: 2,
      dispose: (value) => disposed.push(value.key),
    });

    const a = cache.get('a');
    const b = cache.get('b');
    expect(a.key).toBe('a');
    expect(b.key).toBe('b');

    cache.get('a');
    const c = cache.get('c');

    expect(c.key).toBe('c');
    expect(cache.peek('a')?.key).toBe('a');
    expect(cache.peek('b')).toBeUndefined();
    expect(cache.peek('c')?.key).toBe('c');
    expect(disposed).toEqual(['b']);
  });

  it('disposes entries on delete and clear', () => {
    const disposed: string[] = [];
    const cache = createScopedCache((key) => ({ key }), {
      dispose: (value) => disposed.push(value.key),
    });

    cache.get('a');
    cache.get('b');

    const removed = cache.delete('a');
    expect(removed?.key).toBe('a');
    expect(cache.peek('a')).toBeUndefined();

    cache.clear();
    expect(cache.peek('b')).toBeUndefined();
    expect(disposed).toEqual(['a', 'b']);
  });

  it('expires stale entries with ttl and recreates on get', () => {
    let clock = 0;
    let count = 0;
    const disposed: string[] = [];
    const cache = createScopedCache((key) => ({ key, count: ++count }), {
      ttlMs: 10,
      now: () => clock,
      dispose: (value) => disposed.push(`${value.key}:${value.count}`),
    });

    const first = cache.get('a');
    expect(first.count).toBe(1);

    clock = 9;
    expect(cache.peek('a')?.count).toBe(1);

    clock = 11;
    expect(cache.peek('a')).toBeUndefined();
    expect(disposed).toEqual(['a:1']);

    const second = cache.get('a');
    expect(second.count).toBe(2);
    expect(disposed).toEqual(['a:1']);
  });

  it('returns undefined for delete of nonexistent key', () => {
    const cache = createScopedCache((key) => key);
    expect(cache.delete('missing')).toBeUndefined();
  });

  it('returns undefined for peek of nonexistent key', () => {
    const cache = createScopedCache((key) => key);
    expect(cache.peek('missing')).toBeUndefined();
  });

  it('get refreshes LRU order to prevent eviction', () => {
    const cache = createScopedCache((key) => ({ key }), { maxEntries: 2 });

    cache.get('a');
    cache.get('b');
    cache.get('a');
    cache.get('c');

    expect(cache.peek('a')?.key).toBe('a');
    expect(cache.peek('b')).toBeUndefined();
    expect(cache.peek('c')?.key).toBe('c');
  });

  it('works without options', () => {
    const cache = createScopedCache((key) => key.toUpperCase());
    expect(cache.get('hello')).toBe('HELLO');
    expect(cache.peek('hello')).toBe('HELLO');
    cache.clear();
    expect(cache.peek('hello')).toBeUndefined();
  });
});
