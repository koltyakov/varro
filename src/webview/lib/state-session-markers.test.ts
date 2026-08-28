import { describe, expect, it } from 'vitest';
import type { Session } from '../types';
import {
  getSessionMarkerWorkspaceScope,
  isSessionCompletedResponseUnreadMarker,
  isSessionUnreadMarker,
  isSkippedPlanSessionMarker,
  nextCompletedSessionResponses,
  nextSeenSessions,
  nextSkippedPlanSessions,
  pruneSkippedPlanSessions,
  readInitialSessionMarkerScope,
  readMergedSessionMarkerState,
  readScopedSessionMarkerState,
  removeSessionMarker,
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

function session(id: string, updated: number): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: updated - 1, updated },
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

  it('derives next seen, skipped, and pruned marker maps', () => {
    expect(nextSeenSessions({ 'session-1': 100 }, 'session-1', 150, 120)).toEqual({
      'session-1': 150,
    });
    expect(nextSeenSessions({ 'session-1': 150 }, 'session-1', 150, 120)).toBeNull();
    expect(nextCompletedSessionResponses({ 'session-1': 100 }, 'session-1', 150, 120)).toEqual({
      'session-1': 150,
    });
    expect(nextCompletedSessionResponses({ 'session-1': 150 }, 'session-1', 150, 120)).toBeNull();
    // Re-settling an already-seen message must use its real completion time, not `now`,
    // so a session read at 500 stays read when its old (300) completion is replayed.
    expect(nextCompletedSessionResponses({ 'session-1': 500 }, 'session-1', 300, 999)).toBeNull();
    expect(
      isSessionCompletedResponseUnreadMarker(
        { 'session-1': 300 },
        { 'session-1': 500 },
        'session-1'
      )
    ).toBe(false);
    // Completions without a timestamp still fall back to `now`.
    expect(
      nextCompletedSessionResponses({ 'session-1': 100 }, 'session-1', undefined, 999)
    ).toEqual({
      'session-1': 999,
    });

    expect(removeSessionMarker({ 'session-1': 100, 'session-2': 200 }, 'session-1')).toEqual({
      'session-2': 200,
    });

    expect(nextSkippedPlanSessions({}, [session('session-1', 300)], 'session-1')).toEqual({
      'session-1': 300,
    });
    expect(nextSkippedPlanSessions({}, [], 'missing')).toBeNull();

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
