import { describe, expect, it, vi } from 'vitest';
import {
  getSessionMarkerWorkspaceScope,
  isSessionCompletedResponseUnreadMarker,
  isSessionUnreadMarker,
  isSkippedPlanSessionMarker,
  nextSessionMarkerTimestamp,
  pruneSkippedPlanSessions,
  readInitialSessionMarkerScope,
  readMergedSessionMarkerState,
  readScopedSessionMarkerState,
  updateScopedSessionMarker,
  writeScopedSessionMarkerState,
} from './state-session-markers';

type TestRuntimeValue =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | TestRuntimeObject
  | readonly TestRuntimeValue[];
interface TestRuntimeObject {
  readonly [key: string]: TestRuntimeValue;
  readonly type?: string;
  readonly id?: string | number;
  readonly message?: string;
}
interface TestRuntimeRecord {
  [key: string]: TestRuntimeValue;
}

function createStorage(initial: TestRuntimeRecord = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    readStored<T>(key: string): T | null {
      // SAFETY: The fixture provides the T | undefined fields read by this statement.
      return (store.get(key) as T | undefined) ?? null;
    },
    writeStored<T>(key: string, value: T) {
      store.set(key, value);
    },
    get(key: string) {
      return store.get(key);
    },
  };
}

describe('state session markers', () => {
  it('normalizes workspace scopes and migrates legacy marker storage', () => {
    const storage = createStorage({
      'varro.lastSeenSessions': { legacy: 123 },
    });

    expect(getSessionMarkerWorkspaceScope('/repo//')).toBe('/repo');
    expect(getSessionMarkerWorkspaceScope(null)).toBe('__varro.no-workspace__');
    expect(readInitialSessionMarkerScope(storage, 'varro.lastSeenSessions', '/repo')).toEqual({
      legacy: 123,
    });
    expect(storage.get('varro.lastSeenSessions')).toEqual({ '/repo': { legacy: 123 } });
  });

  it('uses one marker scope for equivalent Windows workspace paths', () => {
    const storage = createStorage({
      'varro.lastSeenSessions': {
        'c:/users/andrew/repo': { 'session-1': 100 },
      },
    });

    expect(getSessionMarkerWorkspaceScope('C:\\Users\\Andrew\\Repo\\')).toBe(
      'c:/users/andrew/repo'
    );
    expect(
      readScopedSessionMarkerState(
        storage,
        'varro.lastSeenSessions',
        getSessionMarkerWorkspaceScope('C:\\Users\\Andrew\\Repo\\')
      )
    ).toEqual({ 'session-1': 100 });
  });

  it('reads and writes markers by workspace scope', () => {
    const storage = createStorage({
      'varro.lastSeenSessions': {
        '/repo-a': { 'session-a': 100 },
        '/repo-b': { 'session-b': 200 },
      },
    });

    expect(readScopedSessionMarkerState(storage, 'varro.lastSeenSessions', '/repo-b')).toEqual({
      'session-b': 200,
    });

    writeScopedSessionMarkerState(storage, 'varro.lastSeenSessions', '/repo-a', {});

    expect(storage.get('varro.lastSeenSessions')).toEqual({
      '/repo-b': { 'session-b': 200 },
    });
  });

  it.each([
    null,
    [],
    7,
    { legacy: 123 },
    {
      '/repo': { retained: 100, invalid: 'bad', infinite: Number.POSITIVE_INFINITY },
      '/other': { another: 200 },
      '/invalid': [],
    },
  ])('preserves the existing scoped-write result for storage %j', (initial) => {
    const storage = createStorage({ markers: initial });
    const previousStorage = createStorage({ markers: initial });
    const reads = vi.spyOn(storage, 'readStored');
    for (const timestamp of [300, 0, undefined]) {
      const previous = { ...readScopedSessionMarkerState(previousStorage, 'markers', '/repo') };
      if (timestamp === undefined) delete previous.target;
      else previous.target = timestamp;
      writeScopedSessionMarkerState(previousStorage, 'markers', '/repo', previous);
      reads.mockClear();

      updateScopedSessionMarker(storage, 'markers', '/repo', 'target', timestamp);

      expect(reads).toHaveBeenCalledTimes(1);
      expect(storage.get('markers')).toEqual(previousStorage.get('markers'));
    }
  });

  it('preserves interleaved clients and removes only the requested marker or empty scope', () => {
    const storage = createStorage({ markers: { '/repo': { retained: 100 } } });
    const firstClient = { readStored: storage.readStored, writeStored: storage.writeStored };
    const secondClient = { readStored: storage.readStored, writeStored: storage.writeStored };

    updateScopedSessionMarker(firstClient, 'markers', '/repo', 'first', 200);
    updateScopedSessionMarker(secondClient, 'markers', '/other', 'second', 300);
    updateScopedSessionMarker(firstClient, 'markers', '/repo', 'first', undefined);
    expect(storage.get('markers')).toEqual({
      '/repo': { retained: 100 },
      '/other': { second: 300 },
    });
    updateScopedSessionMarker(secondClient, 'markers', '/other', 'second', undefined);
    expect(storage.get('markers')).toEqual({ '/repo': { retained: 100 } });
  });

  it('merges markers from open workspace roots using the latest timestamp', () => {
    const storage = createStorage({
      'varro.lastSeenSessions': {
        '/repo-a': { shared: 100, 'session-a': 150 },
        '/repo-b': { shared: 200, 'session-b': 250 },
        '/closed': { closed: 300 },
      },
    });

    expect(
      readMergedSessionMarkerState(storage, 'varro.lastSeenSessions', ['/repo-a', '/repo-b'])
    ).toEqual({ shared: 200, 'session-a': 150, 'session-b': 250 });
  });

  it('derives monotonic timestamps and pruned marker maps', () => {
    expect(nextSessionMarkerTimestamp(100, 150, 120)).toBe(150);
    expect(nextSessionMarkerTimestamp(150, 150, 120)).toBeNull();
    expect(nextSessionMarkerTimestamp(150, 150, 999)).toBeNull();
    expect(nextSessionMarkerTimestamp(undefined, 0, 999)).toBe(0);
    // Re-settling an already-seen message must use its real completion time, not `now`,
    // so a session read at 500 stays read when its old (300) completion is replayed.
    expect(nextSessionMarkerTimestamp(500, 300, 999)).toBeNull();
    expect(
      isSessionCompletedResponseUnreadMarker(
        { 'session-1': 300 },
        { 'session-1': 500 },
        'session-1'
      )
    ).toBe(false);
    // Completions without a timestamp still fall back to `now`.
    expect(nextSessionMarkerTimestamp(100, undefined, 999)).toBe(999);

    expect(isSkippedPlanSessionMarker({ 'session-1': 300 }, 'session-1', 250)).toBe(true);
    expect(isSkippedPlanSessionMarker({ 'session-1': 300 }, 'session-1', 301)).toBe(false);
    expect(isSessionUnreadMarker({ 'session-1': 200 }, 'session-1', 201)).toBe(true);
    expect(isSessionUnreadMarker({ 'session-1': 200 }, 'session-1', 200)).toBe(false);
    expect(
      isSessionCompletedResponseUnreadMarker(
        { 'session-1': 250 },
        { 'session-1': 200 },
        'session-1'
      )
    ).toBe(true);
    expect(
      isSessionCompletedResponseUnreadMarker(
        { 'session-1': 250 },
        { 'session-1': 250 },
        'session-1'
      )
    ).toBe(false);

    expect(pruneSkippedPlanSessions({ stale: 1, 'session-1': 2 }, new Set(['session-1']))).toEqual({
      'session-1': 2,
    });
    expect(pruneSkippedPlanSessions({ 'session-1': 2 }, new Set(['session-1']))).toBeNull();
  });
});
