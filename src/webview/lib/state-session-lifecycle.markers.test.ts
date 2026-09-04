import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types';

function session(id: string, directory: string, projectID = 'project'): Session {
  return { id, directory, projectID, title: id, version: '1', time: { created: 1, updated: 100 } };
}

beforeEach(() => vi.resetModules());

describe('catalog marker restoration', () => {
  it('retains nested read and completion markers during workspace restoration', async () => {
    const state = await import('./state');
    state.syncSessionMarkersForWorkspace('/repo', ['/repo']);
    // An event before catalog arrival can leave an older marker in the root scope.
    state.markSessionSeen('nested', 50);
    state.markSessionResponseCompleted('nested', 50);
    state.setSessions([session('nested', '/repo/nested')]);
    state.markSessionSeen('nested', 200);
    state.markSessionResponseCompleted('nested', 100);
    expect(state.isSessionUnread('nested', 100)).toBe(false);
    state.syncSessionMarkersForWorkspace('/repo', ['/repo']);
    expect(state.state.lastSeenSessions.nested).toBe(200);
    expect(state.isSessionUnread('nested', 100)).toBe(false);
    expect(state.state.completedSessionResponses.nested).toBe(100);
    expect(state.isSessionCompletedResponseUnread('nested')).toBe(false);
  });

  it('hydrates only catalog sessions from legacy exact-directory records after reload', async () => {
    window.localStorage.setItem(
      'varro.lastSeenSessions',
      JSON.stringify({
        '/repo/nested': { nested: 200, excluded: 999 },
        '/repo/nested-git': { git: 200 },
        '/second/nested': { second: 200 },
        '/project-sibling': { sibling: 200 },
        '/closed': { closed: 999 },
      })
    );
    window.localStorage.setItem(
      'varro.completedSessionResponses',
      JSON.stringify({
        '/repo/nested': { nested: 100 },
        '/repo/nested-git': { git: 300 },
        '/second/nested': { second: 100 },
        '/closed': { closed: 999 },
      })
    );
    window.localStorage.setItem(
      'varro.skippedPlanSessions',
      JSON.stringify({
        '/repo/nested': { nested: 100, excluded: 999 },
        '/closed': { closed: 999 },
      })
    );
    const catalog = [
      session('nested', '/repo/nested'),
      session('git', '/repo/nested-git', 'nested-git-project'),
      session('second', '/second/nested'),
      session('sibling', '/project-sibling'),
    ];
    for (let reload = 0; reload < 2; reload += 1) {
      vi.resetModules();
      const state = await import('./state');
      state.syncSessionMarkersForWorkspace('/repo', ['/repo', '/second']);
      // The server catalog is the authority for non-root directories, including project siblings.
      expect(state.state.lastSeenSessions).toEqual({});
      state.setSessions(catalog);
      expect(state.state.lastSeenSessions).toEqual({
        nested: 200,
        git: 200,
        second: 200,
        sibling: 200,
      });
      expect(state.isSessionCompletedResponseUnread('nested')).toBe(false);
      expect(state.isSessionCompletedResponseUnread('git')).toBe(true);
      expect(state.state.completedSessionResponses.closed).toBeUndefined();
      expect(state.state.skippedPlanSessions).toEqual({ nested: 100 });
    }
  });

  it('does not restore markers from the old catalog while switching workspace roots', async () => {
    const state = await import('./state');
    state.setSessions([session('nested', '/repo/nested')]);
    state.markSessionSeen('nested', 200);
    state.markSessionResponseCompleted('nested', 300);
    state.syncSessionMarkersForWorkspace('/other', ['/other']);
    expect(state.state.lastSeenSessions).toEqual({});
    expect(state.state.completedSessionResponses).toEqual({});
    state.setSessions([session('other', '/other/nested')]);
    state.syncSessionMarkersForWorkspace('/repo', ['/repo']);
    state.setSessions([session('nested', '/repo/nested')]);
    expect(state.state.lastSeenSessions).toEqual({ nested: 200 });
    expect(state.isSessionCompletedResponseUnread('nested')).toBe(true);
  });
});
