import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMessageMock = vi.hoisted(() => vi.fn());

vi.mock('./bridge', () => ({
  postMessage: postMessageMock,
}));

import { openProviderSetup } from './provider-setup';

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
});
