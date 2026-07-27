import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../types';
import {
  applySessionShareOverride,
  beginSessionShareUpdate,
  completeSessionShareUpdate,
  markSessionShared,
  markSessionUnshared,
  resetSessionShareOverridesForTests,
} from './session-share-overrides';
import { STORAGE_KEYS } from './state-storage';

const session: Session = {
  id: 'session-1',
  projectID: 'project-1',
  directory: '/repo',
  title: 'Shared session',
  version: '1',
  share: { url: 'https://share.test/session-1' },
  time: { created: 1, updated: 2 },
};

beforeEach(resetSessionShareOverridesForTests);
afterEach(resetSessionShareOverridesForTests);

describe('session share overrides', () => {
  it('persists confirmed unshares until the session is shared again', () => {
    markSessionUnshared(session.id);

    expect(applySessionShareOverride(session).share).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.unsharedSessions) || '[]')).toEqual([
      session.id,
    ]);

    markSessionShared(session.id);

    expect(applySessionShareOverride(session).share).toEqual(session.share);
    expect(localStorage.getItem(STORAGE_KEYS.unsharedSessions)).toBeNull();
  });

  it('preserves the activity time from a share update without hiding later activity', () => {
    beginSessionShareUpdate(session.id, session.time.updated);

    const responseUpdate = { ...session, time: { ...session.time, updated: 8 } };
    const eventUpdate = { ...session, time: { ...session.time, updated: 9 } };

    expect(applySessionShareOverride(eventUpdate).time.updated).toBe(session.time.updated);

    completeSessionShareUpdate(session.id, 10);

    expect(applySessionShareOverride(responseUpdate).time.updated).toBe(session.time.updated);
    expect(applySessionShareOverride(eventUpdate).time.updated).toBe(session.time.updated);
    expect(applySessionShareOverride(responseUpdate).time.updated).toBe(session.time.updated);
    expect(
      applySessionShareOverride({ ...session, time: { ...session.time, updated: 11 } }).time.updated
    ).toBe(11);
  });

  it('does not suppress newer activity when the matching share update was not observed', () => {
    beginSessionShareUpdate(session.id, session.time.updated);
    completeSessionShareUpdate(session.id, 10);

    expect(
      applySessionShareOverride({ ...session, time: { ...session.time, updated: 11 } }).time.updated
    ).toBe(11);
  });

  it('preserves activity across unshare response and event timestamp differences', () => {
    markSessionUnshared(session.id);
    beginSessionShareUpdate(session.id, session.time.updated);

    const response = applySessionShareOverride({
      ...session,
      share: undefined,
      time: { ...session.time, updated: 8 },
    });
    const event = applySessionShareOverride({
      ...session,
      time: { ...session.time, updated: 9 },
    });

    completeSessionShareUpdate(session.id, 10);

    expect(response.time.updated).toBe(session.time.updated);
    expect(event.time.updated).toBe(session.time.updated);
    expect(event.share).toBeUndefined();
  });
});
