import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../types';
import {
  applySessionShareOverride,
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
});
