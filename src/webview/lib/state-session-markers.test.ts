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
  readScopedSessionMarkerState,
  removeSessionMarker,
  writeScopedSessionMarkerState,
} from './state-session-markers';

function createStorage(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    readStored<T>(key: string): T | null {
      return (store.get(key) as T | undefined) ?? null;
    },
    writeStored(key: string, value: unknown) {
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

  it('derives next seen, skipped, and pruned marker maps', () => {
    expect(nextSeenSessions({ 'session-1': 100 }, 'session-1', 150, 120)).toEqual({
      'session-1': 150,
    });
    expect(nextSeenSessions({ 'session-1': 150 }, 'session-1', 150, 120)).toBeNull();
    expect(nextCompletedSessionResponses({ 'session-1': 100 }, 'session-1', 150, 120)).toEqual({
      'session-1': 150,
    });
    expect(nextCompletedSessionResponses({ 'session-1': 150 }, 'session-1', 150, 120)).toBeNull();

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
