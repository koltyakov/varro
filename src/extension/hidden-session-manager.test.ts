import { describe, expect, it } from 'vitest';
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
