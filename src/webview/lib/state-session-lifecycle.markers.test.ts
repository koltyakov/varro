import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types';

function session(id: string, directory: string, projectID = 'project'): Session {
  return { id, directory, projectID, title: id, version: '1', time: { created: 1, updated: 100 } };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe('catalog marker restoration', () => {
  it('keeps the newest timestamp for consecutive read, completion and interruption events', async () => {
    const state = await import('./state');
    state.setSessions([session('chat', '/repo')]);
    const post = vi.spyOn(await import('./bridge'), 'postMessage');
    expect(state.markSessionSeen('chat', 200)).toBe(true);
    expect(state.markSessionSeen('chat', 100)).toBe(false);
    state.markSessionResponseCompleted('chat', 200);
    state.markSessionResponseCompleted('chat', 100);
    state.markSessionResponseInterrupted('chat', 200);
    state.markSessionResponseInterrupted('chat', 100);
    flushSolid();
    for (const field of [
      'lastSeenSessions',
      'completedSessionResponses',
      'interruptedSessionResponses',
    ] as const) {
      expect(state.state[field].chat).toBe(200);
      expect(JSON.parse(localStorage.getItem(`varro.${field}`)!)).toEqual({
        '/repo': { chat: 200 },
      });
    }
    expect(post.mock.calls).toEqual([
      [{ type: 'session-read-state/update', payload: { sessionId: 'chat', seenAt: 200 } }],
    ]);
  });

  it('clears a just-written read and skipped plan before the next render', async () => {
    const state = await import('./state');
    const post = vi.spyOn(await import('./bridge'), 'postMessage');
    state.setSessions([session('chat', '/repo')]);
    state.markSessionSeen('chat', 200);
    state.clearSessionSeen('chat');
    state.markSessionResponseCompleted('chat', 300);
    state.skipPlanSession('chat');
    state.clearSkippedPlanSession('chat');
    flushSolid();
    for (const field of ['lastSeenSessions', 'skippedPlanSessions'] as const) {
      expect(state.state[field]).toEqual({});
      expect(JSON.parse(localStorage.getItem(`varro.${field}`)!)).toEqual({});
    }
    expect(post.mock.calls).toEqual([
      [{ type: 'session-read-state/update', payload: { sessionId: 'chat', seenAt: 200 } }],
      [{ type: 'session-plan-state/update', payload: { sessionId: 'chat', skippedAt: 300 } }],
      [{ type: 'session-plan-state/update', payload: { sessionId: 'chat', skippedAt: null } }],
    ]);
  });

  it('persists unread interruptions across reloads without treating them as completions', async () => {
    let state = await import('./state');
    flushSolid();
    state.setSessions([session('chat', '/repo')]);
    flushSolid();
    state.markSessionResponseInterrupted('chat', 300);
    flushSolid();
    expect(state.isSessionInterruptedResponseUnread('chat')).toBe(true);
    expect(state.isSessionCompletedResponseUnread('chat')).toBe(false);

    vi.resetModules();
    flushSolid();
    state = await import('./state');
    flushSolid();
    state.syncSessionMarkersForWorkspace('/repo', ['/repo']);
    flushSolid();
    state.setSessions([session('chat', '/repo')]);
    flushSolid();
    expect(state.isSessionInterruptedResponseUnread('chat')).toBe(true);
    state.markSessionSeen('chat', 300);
    flushSolid();
    expect(state.isSessionInterruptedResponseUnread('chat')).toBe(false);
    state.markSessionResponseInterrupted('chat', 400);
    flushSolid();
    expect(state.isSessionInterruptedResponseUnread('chat')).toBe(true);
    state.markSessionResponseCompleted('chat', 500);
    flushSolid();
    expect(state.isSessionInterruptedResponseUnread('chat')).toBe(false);
  });

  it('acknowledges a child interruption even when the server clock is ahead', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const state = await import('./state');
    flushSolid();
    state.setSessions([
      session('root', '/repo'),
      { ...session('child', '/repo'), parentID: 'root' },
    ]);
    flushSolid();
    state.markSessionResponseInterrupted('child', 3_000);
    state.markSessionSeen('root');
    flushSolid();
    expect(state.state.lastSeenSessions.root).toBe(3_000);
    expect(state.isSessionInterruptedResponseUnread('child')).toBe(false);
  });

  it('imports folder reads and restores them in a workspace with separate browser storage', async () => {
    const bridge = await import('./bridge');
    flushSolid();
    const post = vi.spyOn(bridge, 'postMessage');
    window.localStorage.setItem(
      'varro.lastSeenSessions',
      JSON.stringify({ '/repo': { chat: 200 } })
    );
    flushSolid();
    const folder = await import('./state');
    flushSolid();
    folder.syncSessionMarkersForWorkspace('/repo', ['/repo']);
    flushSolid();
    folder.setSessions([session('chat', '/repo')]);
    flushSolid();
    expect(post).toHaveBeenCalledWith({
      type: 'session-read-state/update',
      payload: { sessionId: 'chat', seenAt: 200 },
    });

    vi.resetModules();
    flushSolid();
    window.localStorage.clear();
    flushSolid();
    Object.assign(window, {
      __initialWebviewState: { sessionReadState: { chat: 200, closed: 999 } },
    });
    try {
      const workspace = await import('./state');
      flushSolid();
      workspace.syncSessionMarkersForWorkspace('/second', ['/second', '/repo']);
      flushSolid();
      workspace.setSessions([session('chat', '/repo'), session('other', '/second')]);
      flushSolid();
      workspace.markSessionResponseCompleted('chat', 100);
      flushSolid();
      expect(workspace.isSessionUnread('chat', 100)).toBe(false);
      expect(workspace.isSessionCompletedResponseUnread('chat')).toBe(false);
      expect(workspace.state.lastSeenSessions.closed).toBeUndefined();
      expect(workspace.isSessionUnread('chat', 300)).toBe(true);
      workspace.syncSessionMarkersForWorkspace('/repo', ['/repo', '/second']);
      flushSolid();
      expect(workspace.state.lastSeenSessions.chat).toBe(200);
      expect(JSON.parse(window.localStorage.getItem('varro.lastSeenSessions')!)).toEqual({
        '/repo': { chat: 200 },
      });
    } finally {
      Reflect.deleteProperty(window, '__initialWebviewState');
      flushSolid();
    }
  });

  it('keeps newer local reads when the shared snapshot is older', async () => {
    Object.assign(window, { __initialWebviewState: { sessionReadState: { chat: 100 } } });
    window.localStorage.setItem(
      'varro.lastSeenSessions',
      JSON.stringify({ '/repo': { chat: 200 } })
    );
    flushSolid();
    try {
      const bridge = await import('./bridge');
      flushSolid();
      const post = vi.spyOn(bridge, 'postMessage');
      const state = await import('./state');
      flushSolid();
      state.setSessions([session('chat', '/repo')]);
      flushSolid();
      expect(state.state.lastSeenSessions.chat).toBe(200);
      expect(post).toHaveBeenCalledWith({
        type: 'session-read-state/update',
        payload: { sessionId: 'chat', seenAt: 200 },
      });
    } finally {
      Reflect.deleteProperty(window, '__initialWebviewState');
      flushSolid();
    }
  });

  it('reads persisted markers once per update without copying unrelated in-memory markers', async () => {
    const state = await import('./state');
    flushSolid();
    const { BrowserPersistence } = await import('./browser-persistence');
    flushSolid();
    state.setSessions([session('active', '/repo')]);
    flushSolid();
    let unrelatedReads = 0;
    state.setState(
      storePath('lastSeenSessions', {
        get unrelated() {
          unrelatedReads += 1;
          return 100;
        },
      })
    );
    flushSolid();
    unrelatedReads = 0;
    const reads = vi.spyOn(BrowserPersistence.prototype, 'get');

    expect(state.markSessionSeen('active', 200)).toBe(true);
    flushSolid();

    expect(reads.mock.calls.filter(([key]) => key === 'varro.lastSeenSessions')).toHaveLength(1);
    expect(unrelatedReads).toBe(0);
    expect(JSON.parse(window.localStorage.getItem('varro.lastSeenSessions')!)).toEqual({
      '/repo': { active: 200 },
    });
    reads.mockClear();
    expect(state.markSessionSeen('active', 100)).toBe(false);
    flushSolid();
    expect(reads).not.toHaveBeenCalled();
    expect(state.state.lastSeenSessions.active).toBe(200);
  });

  it('clears known unread markers on the first read when the server clock is ahead', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const state = await import('./state');
    flushSolid();
    state.setSessions([{ ...session('chat', '/repo'), time: { created: 1, updated: 2_000 } }]);
    flushSolid();
    state.markSessionResponseCompleted('chat', 3_000);
    flushSolid();

    state.markSessionSeen('chat');
    flushSolid();

    expect(state.isSessionUnread('chat', 2_000)).toBe(false);
    expect(state.isSessionCompletedResponseUnread('chat')).toBe(false);
    expect(state.state.lastSeenSessions.chat).toBe(3_000);

    state.markSessionResponseCompleted('chat', 3_001);
    flushSolid();
    expect(state.isSessionCompletedResponseUnread('chat')).toBe(true);
  });

  it('does not acknowledge a newer completion when only an older message was seen', async () => {
    const state = await import('./state');
    flushSolid();
    state.setSessions([session('chat', '/repo')]);
    flushSolid();
    state.markSessionResponseCompleted('chat', 300);
    flushSolid();

    state.markSessionSeen('chat', 200);
    flushSolid();

    expect(state.state.lastSeenSessions.chat).toBe(200);
    expect(state.isSessionCompletedResponseUnread('chat')).toBe(true);
  });

  it('uses the latest completion or metadata timestamp for plan markers', async () => {
    const state = await import('./state');
    flushSolid();
    state.setSessions([session('plan', '/repo')]);
    flushSolid();
    expect(state.getSessionPlanUpdatedAt('plan', 200)).toBe(200);
    state.markSessionResponseCompleted('plan', 300);
    flushSolid();
    expect(state.getSessionPlanUpdatedAt('plan', 200)).toBe(300);
    expect(state.getSessionPlanUpdatedAt('plan', 400)).toBe(400);
    state.skipPlanSession('plan');
    flushSolid();
    expect(state.isSkippedPlanSession('plan', state.getSessionPlanUpdatedAt('plan', 200))).toBe(
      true
    );
    state.markSessionSeen('plan', 300);
    flushSolid();
    expect(state.isSessionUnread('plan', state.getSessionPlanUpdatedAt('plan', 200))).toBe(false);
    state.markSessionResponseCompleted('plan', 301);
    flushSolid();
    expect(state.isSessionUnread('plan', state.getSessionPlanUpdatedAt('plan', 200))).toBe(true);
    expect(state.isSkippedPlanSession('plan', state.getSessionPlanUpdatedAt('plan', 200))).toBe(
      false
    );
  });

  it('keeps zero timestamps, skipped-plan updates, and selective removal synchronous', async () => {
    const state = await import('./state');
    flushSolid();
    state.setSessions([session('first', '/repo'), session('second', '/repo')]);
    flushSolid();
    state.markSessionSeen('first', 0);
    flushSolid();
    state.markSessionSeen('second', 100);
    flushSolid();
    state.clearSessionSeen('first');
    flushSolid();
    expect(JSON.parse(window.localStorage.getItem('varro.lastSeenSessions')!)).toEqual({
      '/repo': { second: 100 },
    });
    state.markSessionResponseCompleted('first', 0);
    flushSolid();
    expect(state.state.completedSessionResponses.first).toBe(0);
    state.skipPlanSession('first');
    state.skipPlanSession('second', 0);
    state.skipPlanSession('missing');
    flushSolid();
    expect(state.state.skippedPlanSessions).toEqual({ first: 100, second: 0 });
    state.clearSkippedPlanSession('first');
    flushSolid();
    expect(JSON.parse(window.localStorage.getItem('varro.skippedPlanSessions')!)).toEqual({
      '/repo': { second: 0 },
    });
  });

  it('preserves unloaded markers and storage until an authoritative complete catalog arrives', async () => {
    const keys = [
      'varro.skippedPlanSessions',
      'varro.completedSessionResponses',
      'varro.interruptedSessionResponses',
    ];
    for (const key of keys) {
      window.localStorage.setItem(key, JSON.stringify({ '/repo': { older: 100, deleted: 100 } }));
      flushSolid();
    }
    const state = await import('./state');
    flushSolid();
    state.setState(
      storePath('editorContext', 'workspaceFolders', [{ name: 'repo', path: '/repo' }])
    );
    flushSolid();
    state.syncSessionMarkersForWorkspace('/repo', ['/repo']);
    flushSolid();
    const firstPage = Array.from({ length: 100 }, (_, i) => session(`recent-${i}`, '/repo'));
    state.setSessions(firstPage, false);
    flushSolid();
    // Local updates must not upgrade a partial catalog to an authoritative snapshot.
    state.setSessions([...firstPage, session('created', '/repo')]);
    flushSolid();
    for (const key of keys) {
      expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({
        '/repo': { older: 100, deleted: 100 },
      });
    }
    expect(state.state.skippedPlanSessions).toEqual({ older: 100, deleted: 100 });
    expect(state.state.completedSessionResponses).toEqual({ older: 100, deleted: 100 });
    state.setSessions([...firstPage, session('older', '/repo')], true);
    flushSolid();
    expect(state.state.skippedPlanSessions).toEqual({ older: 100 });
    expect(state.state.completedSessionResponses).toEqual({ older: 100 });
    for (const key of keys) {
      expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ '/repo': { older: 100 } });
    }
  });

  it('prunes a just-restored catalog without losing markers in another open folder', async () => {
    const key = 'varro.completedSessionResponses';
    localStorage.setItem(
      key,
      JSON.stringify({
        '/first': { removed: 30 },
        '/second': { retained: 40 },
        '/closed': { unrelated: 50 },
      })
    );
    const state = await import('./state');
    state.setState(
      storePath('editorContext', 'workspaceFolders', [
        { name: 'first', path: '/first' },
        { name: 'second', path: '/second' },
      ])
    );
    state.syncSessionMarkersForWorkspace('/first', ['/first', '/second']);
    state.setSessions([session('retained', '/second')], true);
    flushSolid();
    expect(state.state.completedSessionResponses).toEqual({ retained: 40 });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      '/second': { retained: 40 },
      '/closed': { unrelated: 50 },
    });
  });

  it('retains nested read and completion markers during workspace restoration', async () => {
    const state = await import('./state');
    flushSolid();
    state.syncSessionMarkersForWorkspace('/repo', ['/repo']);
    flushSolid();
    // An event before catalog arrival can leave an older marker in the root scope.
    state.markSessionSeen('nested', 50);
    flushSolid();
    state.markSessionResponseCompleted('nested', 50);
    flushSolid();
    state.setSessions([session('nested', '/repo/nested')]);
    flushSolid();
    state.markSessionSeen('nested', 200);
    flushSolid();
    state.markSessionResponseCompleted('nested', 100);
    flushSolid();
    expect(state.isSessionUnread('nested', 100)).toBe(false);
    state.syncSessionMarkersForWorkspace('/repo', ['/repo']);
    flushSolid();
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
    flushSolid();
    window.localStorage.setItem(
      'varro.completedSessionResponses',
      JSON.stringify({
        '/repo/nested': { nested: 100 },
        '/repo/nested-git': { git: 300 },
        '/second/nested': { second: 100 },
        '/closed': { closed: 999 },
      })
    );
    flushSolid();
    window.localStorage.setItem(
      'varro.skippedPlanSessions',
      JSON.stringify({
        '/repo/nested': { nested: 100, excluded: 999 },
        '/closed': { closed: 999 },
      })
    );
    flushSolid();
    const catalog = [
      session('nested', '/repo/nested'),
      session('git', '/repo/nested-git', 'nested-git-project'),
      session('second', '/second/nested'),
      session('sibling', '/project-sibling'),
    ];
    for (let reload = 0; reload < 2; reload += 1) {
      vi.resetModules();
      flushSolid();
      const state = await import('./state');
      flushSolid();
      state.syncSessionMarkersForWorkspace('/repo', ['/repo', '/second']);
      flushSolid();
      // The server catalog is the authority for non-root directories, including project siblings.
      expect(state.state.lastSeenSessions).toEqual({});
      state.setSessions(catalog);
      flushSolid();
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

  it('restores nested markers if the workspace notification follows the catalog in one turn', async () => {
    localStorage.setItem(
      'varro.lastSeenSessions',
      JSON.stringify({ '/repo/nested': { chat: 200 } })
    );
    const state = await import('./state');
    state.setSessions([session('chat', '/repo/nested')]);
    state.syncSessionMarkersForWorkspace('/repo', ['/repo']);
    flushSolid();
    expect(state.state.lastSeenSessions).toEqual({ chat: 200 });
  });

  it('does not restore markers from the old catalog while switching workspace roots', async () => {
    const state = await import('./state');
    flushSolid();
    state.setSessions([session('nested', '/repo/nested')]);
    flushSolid();
    state.markSessionSeen('nested', 200);
    flushSolid();
    state.markSessionResponseCompleted('nested', 300);
    flushSolid();
    state.syncSessionMarkersForWorkspace('/other', ['/other']);
    flushSolid();
    expect(state.state.lastSeenSessions).toEqual({});
    expect(state.state.completedSessionResponses).toEqual({});
    state.setSessions([session('other', '/other/nested')]);
    flushSolid();
    state.syncSessionMarkersForWorkspace('/repo', ['/repo']);
    flushSolid();
    state.setSessions([session('nested', '/repo/nested')]);
    flushSolid();
    expect(state.state.lastSeenSessions).toEqual({ nested: 200 });
    expect(state.isSessionCompletedResponseUnread('nested')).toBe(true);
  });
});
