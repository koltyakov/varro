/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These tests inspect the manager's private state after exercising its public API. */
import { describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../shared/protocol';
import { HiddenSessionManager } from './hidden-session-manager';

const legacyJudgePermission = [
  { permission: 'read', pattern: '*', action: 'deny' },
  { permission: 'edit', pattern: '*', action: 'deny' },
  { permission: 'glob', pattern: '*', action: 'deny' },
  { permission: 'grep', pattern: '*', action: 'deny' },
  { permission: 'list', pattern: '*', action: 'deny' },
  { permission: 'bash', pattern: '*', action: 'deny' },
  { permission: 'shell', pattern: '*', action: 'deny' },
  { permission: 'task', pattern: '*', action: 'deny' },
  { permission: 'external_directory', pattern: '*', action: 'deny' },
  { permission: 'todowrite', pattern: '*', action: 'deny' },
  { permission: 'question', pattern: '*', action: 'deny' },
  { permission: 'webfetch', pattern: '*', action: 'deny' },
  { permission: 'websearch', pattern: '*', action: 'deny' },
  { permission: 'codesearch', pattern: '*', action: 'deny' },
  { permission: 'lsp', pattern: '*', action: 'deny' },
  { permission: 'doom_loop', pattern: '*', action: 'deny' },
  { permission: 'skill', pattern: '*', action: 'deny' },
  { permission: '*', pattern: '*', action: 'deny' },
  { permission: 'StructuredOutput', pattern: '*', action: 'allow' },
];

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

  it('unhides an unconfirmed title collision when the pending helper finishes', () => {
    const manager = new HiddenSessionManager();
    manager.registerPendingTitle('Generated title');
    manager.observeEvent({
      type: 'session.created',
      properties: { info: { id: 'ordinary-session', title: 'Generated title' } },
    });

    manager.forgetPendingTitle('Generated title');

    expect(manager.isHidden('ordinary-session')).toBe(false);
  });

  it('keeps an explicitly confirmed pending helper hidden', () => {
    const manager = new HiddenSessionManager();
    manager.registerPendingTitle('Generated title');
    manager.observeEvent({
      type: 'session.created',
      properties: { info: { id: 'helper-session', title: 'Generated title' } },
    });
    manager.hide('helper-session');

    manager.forgetPendingTitle('Generated title');

    expect(manager.isHidden('helper-session')).toBe(true);
  });

  it('keeps a helper hidden when its pending-title event arrives after confirmation', () => {
    const manager = new HiddenSessionManager();
    manager.registerPendingTitle('Generated title');
    manager.hide('helper-session');
    manager.observeEvent({
      type: 'session.created',
      properties: { info: { id: 'helper-session', title: 'Generated title' } },
    });

    manager.forgetPendingTitle('Generated title');

    expect(manager.isHidden('helper-session')).toBe(true);
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
          permission: legacyJudgePermission,
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
          {
            id: 'legacy-judge',
            title: 'Varro permission judge: per_legacy',
            permission: legacyJudgePermission,
          },
          { id: 'marked-judge', title: 'Internal helper' },
        ])
        .map(({ id }) => id)
    ).toEqual(['visible']);
  });

  it('recognizes commit-message helpers after the extension host restarts', () => {
    const manager = new HiddenSessionManager();
    const now = 1_000_000;
    const visibleSession = {
      id: 'visible',
      title: 'Varro commit message: ordinary-session',
      permission: [{ permission: '*', pattern: '*', action: 'ask' as const }],
    };
    const visibleNumericSession = {
      id: 'visible-numeric',
      title: 'Varro commit message: 2',
      permission: [{ permission: '*', pattern: '*', action: 'allow' as const }],
    };
    const markedHelper = {
      id: 'marked-commit-helper',
      title: 'Internal helper',
      metadata: { varroInternal: 'commit-message' },
      time: { updated: now - 180_000 },
    };
    const legacyHelper = {
      id: 'legacy-commit-helper',
      title: 'Varro commit message: 1',
      permission: legacyJudgePermission,
      time: { updated: now - 180_000 },
    };
    const projectedLegacyHelper = {
      id: 'projected-legacy-commit-helper',
      title: 'Varro commit message: 3',
      time: { updated: now - 180_000 },
    };

    expect(
      manager.observeSessionList(
        [visibleSession, visibleNumericSession, markedHelper, legacyHelper, projectedLegacyHelper],
        now
      )
    ).toEqual(['marked-commit-helper', 'legacy-commit-helper', 'projected-legacy-commit-helper']);
    expect(
      manager
        .filterVisibleSessions([
          visibleSession,
          visibleNumericSession,
          markedHelper,
          legacyHelper,
          projectedLegacyHelper,
        ])
        .map(({ id }) => id)
    ).toEqual(['visible', 'visible-numeric']);
  });

  it('does not hide an ordinary session renamed with the legacy title prefix', () => {
    const manager = new HiddenSessionManager();
    const now = 1_000_000;
    const renamedSession = {
      id: 'renamed-session',
      title: 'Varro permission judge: ordinary-session',
      permission: [{ permission: '*', pattern: '*', action: 'ask' as const }],
      time: { created: now - 240_000, updated: now - 180_000 },
    };

    manager.observeEvent({
      type: 'session.updated',
      properties: { info: renamedSession },
    });

    expect(manager.isHidden(renamedSession.id)).toBe(false);
    expect(manager.observeSessionList([renamedSession], now)).toEqual([]);
    expect(manager.filterVisibleSessions([renamedSession])).toEqual([renamedSession]);
  });

  it('does not recognize a prefixed session with broader rules as a legacy judge', () => {
    const manager = new HiddenSessionManager();
    const session = {
      id: 'broader-session',
      title: 'Varro permission judge: ordinary-session',
      permission: [
        ...legacyJudgePermission,
        { permission: 'bash', pattern: '*', action: 'allow' as const },
      ],
      time: { updated: 1 },
    };

    expect(manager.observeSessionList([session], 1_000_000)).toEqual([]);
    expect(manager.filterVisibleSessions([session])).toEqual([session]);
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
            permission: legacyJudgePermission,
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
