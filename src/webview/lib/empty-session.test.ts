import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../types';
import {
  EMPTY_SESSION_PRUNE_GRACE_MS,
  isEmptySession,
  shouldHideEmptySessionFromList,
  shouldPruneEmptySession,
} from './empty-session';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    projectID: 'proj-1',
    directory: '/tmp',
    title: 'Test',
    version: '1',
    time: { created: 1000, updated: 1000 },
    ...overrides,
  };
}

function makeOptions(overrides: Partial<Parameters<typeof shouldPruneEmptySession>[1]> = {}) {
  return {
    activeSessionId: null as string | null,
    isQueued: vi.fn(() => false),
    isAwaitingInput: vi.fn(() => false),
    isRunning: vi.fn(() => false),
    needsAttention: vi.fn(() => false),
    isFailed: vi.fn(() => false),
    isPlanReady: vi.fn(() => false),
    ...overrides,
  };
}

describe('isEmptySession', () => {
  it('returns true when created === updated', () => {
    expect(isEmptySession(makeSession({ time: { created: 1000, updated: 1000 } }))).toBe(true);
  });

  it('returns false when created !== updated', () => {
    expect(isEmptySession(makeSession({ time: { created: 1000, updated: 2000 } }))).toBe(false);
  });
});

describe('shouldHideEmptySessionFromList', () => {
  it('returns true for fresh empty sessions', () => {
    const now = Date.now();
    const session = makeSession({ time: { created: now, updated: now } });
    expect(shouldHideEmptySessionFromList(session, makeOptions())).toBe(true);
  });

  it('returns false for non-empty sessions', () => {
    const session = makeSession({ time: { created: 1000, updated: 2000 } });
    expect(shouldHideEmptySessionFromList(session, makeOptions())).toBe(false);
  });

  it('returns false when preserve is true', () => {
    const session = makeSession({ time: { created: 1000, updated: 1000 } });
    expect(shouldHideEmptySessionFromList(session, makeOptions({ preserve: true }))).toBe(false);
  });
});

describe('shouldPruneEmptySession', () => {
  it('returns false for non-empty sessions', () => {
    const session = makeSession({ time: { created: 1000, updated: 2000 } });
    expect(shouldPruneEmptySession(session, makeOptions())).toBe(false);
  });

  it('returns false when within grace period', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const session = makeSession({ time: { created: now - 1000, updated: now - 1000 } });
    expect(shouldPruneEmptySession(session, makeOptions())).toBe(false);
    vi.restoreAllMocks();
  });

  it('returns false when preserve is true', () => {
    const session = makeSession({ time: { created: 0, updated: 0 } });
    expect(shouldPruneEmptySession(session, makeOptions({ preserve: true }))).toBe(false);
  });

  it('returns false when session is the active session', () => {
    const session = makeSession({ id: 'active', time: { created: 0, updated: 0 } });
    expect(shouldPruneEmptySession(session, makeOptions({ activeSessionId: 'active' }))).toBe(
      false
    );
  });

  it('returns false when isQueued returns true', () => {
    const session = makeSession({ time: { created: 0, updated: 0 } });
    expect(shouldPruneEmptySession(session, makeOptions({ isQueued: vi.fn(() => true) }))).toBe(
      false
    );
  });

  it('returns false when isAwaitingInput returns true', () => {
    const session = makeSession({ time: { created: 0, updated: 0 } });
    expect(
      shouldPruneEmptySession(session, makeOptions({ isAwaitingInput: vi.fn(() => true) }))
    ).toBe(false);
  });

  it('returns false when isRunning returns true', () => {
    const session = makeSession({ time: { created: 0, updated: 0 } });
    expect(shouldPruneEmptySession(session, makeOptions({ isRunning: vi.fn(() => true) }))).toBe(
      false
    );
  });

  it('returns false when needsAttention returns true', () => {
    const session = makeSession({ time: { created: 0, updated: 0 } });
    expect(
      shouldPruneEmptySession(session, makeOptions({ needsAttention: vi.fn(() => true) }))
    ).toBe(false);
  });

  it('returns false when isFailed returns true', () => {
    const session = makeSession({ time: { created: 0, updated: 0 } });
    expect(shouldPruneEmptySession(session, makeOptions({ isFailed: vi.fn(() => true) }))).toBe(
      false
    );
  });

  it('returns false when isPlanReady returns true', () => {
    const session = makeSession({ time: { created: 0, updated: 0 } });
    expect(shouldPruneEmptySession(session, makeOptions({ isPlanReady: vi.fn(() => true) }))).toBe(
      false
    );
  });

  it('returns false when statusType is busy', () => {
    const session = makeSession({ time: { created: 0, updated: 0 } });
    expect(shouldPruneEmptySession(session, makeOptions({ statusType: 'busy' }))).toBe(false);
  });

  it('returns false when statusType is retry', () => {
    const session = makeSession({ time: { created: 0, updated: 0 } });
    expect(shouldPruneEmptySession(session, makeOptions({ statusType: 'retry' }))).toBe(false);
  });

  it('returns true when all conditions pass', () => {
    const session = makeSession({ time: { created: 0, updated: 0 } });
    expect(shouldPruneEmptySession(session, makeOptions())).toBe(true);
  });

  it('prunes empty sessions at the grace period boundary', () => {
    const now = 10_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const fresh = makeSession({
      time: {
        created: now - EMPTY_SESSION_PRUNE_GRACE_MS + 1,
        updated: now - EMPTY_SESSION_PRUNE_GRACE_MS + 1,
      },
    });
    const stale = makeSession({
      time: {
        created: now - EMPTY_SESSION_PRUNE_GRACE_MS,
        updated: now - EMPTY_SESSION_PRUNE_GRACE_MS,
      },
    });

    expect(shouldPruneEmptySession(fresh, makeOptions())).toBe(false);
    expect(shouldPruneEmptySession(stale, makeOptions())).toBe(true);

    vi.restoreAllMocks();
  });
});
