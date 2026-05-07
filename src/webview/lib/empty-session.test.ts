import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../types';
import {
  EMPTY_SESSION_PRUNE_GRACE_MS,
  isEmptySession,
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

  it('exports the grace period constant', () => {
    expect(EMPTY_SESSION_PRUNE_GRACE_MS).toBe(5_000);
  });
});
