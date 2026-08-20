import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMessageMock = vi.hoisted(() => vi.fn());

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise provider setup through the bridge module boundary. */
vi.mock('./bridge', () => ({
  postMessage: postMessageMock,
}));

import { openProviderLogout, openProviderSetup } from './provider-setup';

describe('openProviderSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the provider login command in the terminal bridge', () => {
    openProviderSetup();

    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'terminal/run',
      payload: { command: 'opencode auth login', title: 'OpenCode Provider Setup' },
    });
  });

  it('opens the provider logout command in the terminal bridge', () => {
    openProviderLogout();

    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'terminal/run',
      payload: { command: 'opencode providers logout', title: 'OpenCode Provider Logout' },
    });
  });
});
