import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMessageMock = vi.hoisted(() => vi.fn());
const authorizeProviderMock = vi.hoisted(() => vi.fn());

vi.mock('./bridge', () => ({
  postMessage: postMessageMock,
}));

vi.mock('./client', () => ({
  client: {
    config: {
      authorizeProvider: authorizeProviderMock,
    },
  },
}));

import { beginProviderAuthorization, openProviderSetup } from './provider-setup';

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

  it('opens browser auth for supported providers', async () => {
    authorizeProviderMock.mockResolvedValue({
      url: 'https://auth.example.com/start',
      method: 'auto',
      instructions: 'Sign in',
    });

    await beginProviderAuthorization('openai', 0);

    expect(authorizeProviderMock).toHaveBeenCalledWith({ providerID: 'openai', method: 0 });
    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://auth.example.com/start' },
    });
  });
});
