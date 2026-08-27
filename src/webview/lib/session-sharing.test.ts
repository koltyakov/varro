/* oxlint-disable anti-slop/no-module-mocking -- These tests drive the sharing flow against stubbed transport and clipboard collaborators. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types';

const mocks = vi.hoisted(() => ({
  share: vi.fn(),
  unshare: vi.fn(),
  writeClipboard: vi.fn(),
  setError: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('./client', () => ({
  client: { session: { share: mocks.share, unshare: mocks.unshare } },
}));
vi.mock('./write-clipboard', () => ({ writeClipboard: mocks.writeClipboard }));
vi.mock('./state', () => ({ setError: mocks.setError, setState: mocks.setState }));

import {
  applySessionShareOverride,
  resetSessionShareOverridesForTests,
} from './session-share-overrides';
import { shareSession, unshareSession } from './session-sharing';

const SHARE_URL = 'https://share.test/session-1';

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    projectID: 'project-1',
    directory: '/repo',
    title: 'Session',
    version: '1',
    time: { created: 1, updated: 100 },
    ...overrides,
  };
}

beforeEach(() => {
  resetSessionShareOverridesForTests();
  mocks.writeClipboard.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
  resetSessionShareOverridesForTests();
});

describe('shareSession', () => {
  it('shares an unshared session and copies the returned link', async () => {
    const session = createSession();
    mocks.share.mockResolvedValue({
      ...session,
      share: { url: SHARE_URL },
      time: { created: 1, updated: 200 },
    });

    await expect(shareSession(session)).resolves.toBe(true);

    expect(mocks.share).toHaveBeenCalledWith('session-1', { directory: '/repo' });
    expect(mocks.writeClipboard).toHaveBeenCalledWith(SHARE_URL);
    expect(mocks.setError).not.toHaveBeenCalled();
  });

  it('copies an existing link without asking the server to share again', async () => {
    const session = createSession({ share: { url: SHARE_URL } });

    await expect(shareSession(session)).resolves.toBe(true);

    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.writeClipboard).toHaveBeenCalledWith(SHARE_URL);
  });

  it('reports a failure when the clipboard write is refused', async () => {
    mocks.writeClipboard.mockResolvedValue(false);

    await expect(shareSession(createSession({ share: { url: SHARE_URL } }))).resolves.toBe(false);

    expect(mocks.setError).toHaveBeenCalledWith('Failed to copy session share link');
  });

  it('reports a failure when the server shares without returning a link', async () => {
    const session = createSession();
    mocks.share.mockResolvedValue({ ...session, time: { created: 1, updated: 200 } });

    await expect(shareSession(session)).resolves.toBe(false);

    expect(mocks.setError).toHaveBeenCalledWith('OpenCode did not return a session share link');
    expect(mocks.writeClipboard).not.toHaveBeenCalled();
  });

  it('cancels the pending activity-time hold when sharing fails', async () => {
    const session = createSession();
    mocks.share.mockRejectedValue(new Error('network down'));

    await expect(shareSession(session)).resolves.toBe(false);

    expect(mocks.setError).toHaveBeenCalledWith('network down');
    // With the hold cancelled, a later activity time is shown as-is rather than
    // being pinned to the pre-share value.
    const later = { ...session, time: { created: 1, updated: 500 } };
    expect(applySessionShareOverride(later).time.updated).toBe(500);
  });

  it('stringifies a non-Error share rejection', async () => {
    mocks.share.mockRejectedValue('boom');

    await expect(shareSession(createSession())).resolves.toBe(false);

    expect(mocks.setError).toHaveBeenCalledWith('boom');
  });

  it('keeps the completed hold when only the clipboard step fails', async () => {
    const session = createSession();
    mocks.share.mockResolvedValue({
      ...session,
      share: { url: SHARE_URL },
      time: { created: 1, updated: 200 },
    });
    mocks.writeClipboard.mockResolvedValue(false);

    await expect(shareSession(session)).resolves.toBe(false);

    // The share itself succeeded, so the activity-time hold must survive: the
    // bump the share caused is still suppressed in the session list.
    expect(mocks.setError).toHaveBeenCalledWith('Failed to copy session share link');
    expect(
      applySessionShareOverride({ ...session, time: { created: 1, updated: 150 } }).time.updated
    ).toBe(100);
  });
});

describe('unshareSession', () => {
  it('unshares a session and clears its share state', async () => {
    const session = createSession({ share: { url: SHARE_URL } });
    mocks.unshare.mockResolvedValue({ ...session, time: { created: 1, updated: 200 } });

    await expect(unshareSession(session)).resolves.toBe(true);

    expect(mocks.unshare).toHaveBeenCalledWith('session-1', { directory: '/repo' });
    expect(mocks.setError).not.toHaveBeenCalled();
    // The confirmed unshare survives a stale server snapshot that still carries a link.
    expect(applySessionShareOverride(session).share).toBeUndefined();
  });

  it('cancels the hold and reports the error when unsharing fails', async () => {
    const session = createSession({ share: { url: SHARE_URL } });
    mocks.unshare.mockRejectedValue(new Error('server refused'));

    await expect(unshareSession(session)).resolves.toBe(false);

    expect(mocks.setError).toHaveBeenCalledWith('server refused');
    // No unshare was recorded, so the existing link stays visible.
    expect(applySessionShareOverride(session).share).toEqual({ url: SHARE_URL });
    expect(
      applySessionShareOverride({ ...session, time: { created: 1, updated: 500 } }).time.updated
    ).toBe(500);
  });

  it('stringifies a non-Error unshare rejection', async () => {
    mocks.unshare.mockRejectedValue({ code: 500 });

    await expect(unshareSession(createSession())).resolves.toBe(false);

    expect(mocks.setError).toHaveBeenCalledWith('[object Object]');
  });
});
