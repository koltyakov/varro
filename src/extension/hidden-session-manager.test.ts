import { describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../shared/protocol';
import { HiddenSessionManager } from './hidden-session-manager';

describe('HiddenSessionManager', () => {
  it('hides sessions whose create or update event matches a pending title', () => {
    const manager = new HiddenSessionManager();
    manager.registerPendingTitle('Generated title');
    manager.registerPendingTitle('Fallback title');

    manager.observeEvent({
      type: 'session.created',
      properties: { info: { id: 'generated-session', title: 'Generated title' } },
    });
    manager.observeEvent({
      type: 'session.updated',
      properties: { sessionID: 'fallback-session', info: { title: 'Fallback title' } },
    });

    expect(manager.isHidden('generated-session')).toBe(true);
    expect(manager.isHidden('fallback-session')).toBe(true);
  });

  it('ignores forgotten pending titles and unrelated events', () => {
    const manager = new HiddenSessionManager();
    manager.registerPendingTitle('Temporary title');
    manager.forgetPendingTitle('Temporary title');

    manager.observeEvent({
      type: 'session.created',
      properties: { info: { id: 'visible-session', title: 'Temporary title' } },
    });
    manager.observeEvent({
      type: 'session.status',
      properties: { sessionID: 'other-session', status: { type: 'idle' } },
    } as ServerEvent);

    expect(manager.isHidden('visible-session')).toBe(false);
    expect(manager.isHidden('other-session')).toBe(false);
  });

  it('recognizes permission judges after the extension host restarts', () => {
    const manager = new HiddenSessionManager();
    const now = 1_000_000;

    manager.observeEvent({
      type: 'session.updated',
      properties: {
        info: {
          id: 'marked-judge',
          title: 'Internal helper',
          metadata: { varroInternal: 'permission-judge' },
        },
      },
    });
    const stale = manager.observeSessionList(
      [
        { id: 'visible', title: 'Visible session' },
        {
          id: 'legacy-judge',
          title: 'Varro permission judge: per_legacy',
          time: { updated: now - 180_000 },
        },
        {
          id: 'marked-judge',
          title: 'Internal helper',
          metadata: { varroInternal: 'permission-judge' },
          time: { created: now - 180_000 },
        },
      ],
      now
    );

    expect(stale).toEqual(['legacy-judge', 'marked-judge']);
    expect(
      manager
        .filterVisibleSessions([
          { id: 'visible', title: 'Visible session' },
          { id: 'legacy-judge', title: 'Varro permission judge: per_legacy' },
          { id: 'marked-judge', title: 'Internal helper' },
        ])
        .map(({ id }) => id)
    ).toEqual(['visible']);
  });

  it('does not classify an active permission judge as stale', () => {
    const manager = new HiddenSessionManager();
    const title = 'Varro permission judge: per_active';
    manager.registerPendingTitle(title);

    expect(manager.observeSessionList([{ id: 'active-judge', title }])).toEqual([]);
    expect(manager.isHidden('active-judge')).toBe(true);
  });

  it('hides but does not delete a recent judge owned by another window', () => {
    const manager = new HiddenSessionManager();
    const now = 1_000_000;

    expect(
      manager.observeSessionList(
        [
          {
            id: 'recent-judge',
            title: 'Varro permission judge: per_recent',
            time: { updated: now - 30_000 },
          },
        ],
        now
      )
    ).toEqual([]);
    expect(manager.isHidden('recent-judge')).toBe(true);
  });

  it('supports hide and unhide without exposing its internal set', () => {
    const manager = new HiddenSessionManager();
    manager.hide('hidden-session');

    const copy = manager.hiddenSessionIds();
    copy.delete('hidden-session');
    copy.add('copy-only-session');

    expect(manager.isHidden('hidden-session')).toBe(true);
    expect(manager.isHidden('copy-only-session')).toBe(false);

    manager.unhide('hidden-session');
    manager.hide(null);
    manager.unhide(undefined);

    expect(manager.isHidden('hidden-session')).toBe(false);
  });

  it('keeps deletion tombstones hidden through queued events until session.deleted', () => {
    vi.useFakeTimers();
    try {
      const manager = new HiddenSessionManager();
      manager.hide('helper-session');
      manager.retainUntilDeleted('helper-session');

      manager.observeEvent({
        type: 'session.updated',
        properties: { info: { id: 'helper-session', title: 'Queued helper update' } },
      });

      expect(manager.isHidden('helper-session')).toBe(true);
      expect(manager.filterVisibleSessions([{ id: 'helper-session' }])).toEqual([]);

      manager.observeEvent({
        type: 'session.deleted',
        properties: { info: { id: 'helper-session' } },
      });

      expect(manager.isHidden('helper-session')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not recreate a tombstone when session.deleted arrives before the delete response', () => {
    vi.useFakeTimers();
    try {
      const manager = new HiddenSessionManager();
      manager.hide('helper-session');
      manager.observeEvent({
        type: 'session.deleted',
        properties: { info: { id: 'helper-session' } },
      });

      manager.retainUntilDeleted('helper-session');

      expect(manager.isHidden('helper-session')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires deletion tombstones when session.deleted is missed', () => {
    vi.useFakeTimers();
    try {
      const manager = new HiddenSessionManager();
      manager.hide('helper-session');
      manager.retainUntilDeleted('helper-session');

      vi.advanceTimersByTime(60_000);

      expect(manager.isHidden('helper-session')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds deletion tombstones under sustained missed events', () => {
    vi.useFakeTimers();
    try {
      const manager = new HiddenSessionManager();
      for (let index = 0; index < 1_000; index += 1) {
        const sessionID = `helper-${index}`;
        manager.hide(sessionID);
        manager.retainUntilDeleted(sessionID);
      }

      expect(manager.hiddenSessionIds().size).toBe(256);
      expect(manager.isHidden('helper-0')).toBe(false);
      expect(manager.isHidden('helper-999')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters hidden sessions, statuses, and requests', () => {
    const manager = new HiddenSessionManager();
    manager.hide('hidden-session');

    expect(
      manager
        .filterVisibleSessions([{ id: 'visible-session' }, { id: 'hidden-session' }])
        .map(({ id }) => id)
    ).toEqual(['visible-session']);
    expect(
      manager.filterVisibleSessionStatuses({
        'visible-session': { type: 'idle' },
        'hidden-session': { type: 'busy' },
      })
    ).toEqual({ 'visible-session': { type: 'idle' } });
    expect(
      manager.filterVisibleSessionRequests([
        { id: 'visible-request', sessionID: 'visible-session' },
        { id: 'hidden-request', sessionID: 'hidden-session' },
      ])
    ).toEqual([{ id: 'visible-request', sessionID: 'visible-session' }]);
  });
});
