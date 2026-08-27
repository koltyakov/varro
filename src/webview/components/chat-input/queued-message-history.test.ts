/* oxlint-disable anti-slop/no-module-mocking -- This test verifies the bridge metadata used to authorize cross-workspace history reads. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiCall: vi.fn(),
}));

vi.mock('../../lib/bridge', () => ({ apiCall: mocks.apiCall }));

import { queuedMessageWasAdmitted } from './queued-message-history';

describe('queuedMessageWasAdmitted', () => {
  beforeEach(() => mocks.apiCall.mockReset());

  it('authorizes each workspace-scoped history page with the queue lease and message id', async () => {
    mocks.apiCall
      .mockResolvedValueOnce({ items: [], nextCursor: 'older' })
      .mockResolvedValueOnce({ items: [{ info: { id: 'message-1' }, parts: [] }] });

    await expect(
      queuedMessageWasAdmitted('session/1', 'message-1', '/repo-a', {
        itemId: 'queue-1',
        lease: 7,
      })
    ).resolves.toBe(true);

    expect(mocks.apiCall).toHaveBeenNthCalledWith(
      1,
      'GET',
      '/session/session%2F1/message?limit=200',
      { messageID: 'message-1', workspaceDirectory: '/repo-a' },
      { queuedMessageDispatch: { itemId: 'queue-1', lease: 7 } }
    );
    expect(mocks.apiCall).toHaveBeenNthCalledWith(
      2,
      'GET',
      '/session/session%2F1/message?limit=200&before=older',
      { messageID: 'message-1', workspaceDirectory: '/repo-a' },
      { queuedMessageDispatch: { itemId: 'queue-1', lease: 7 } }
    );
  });
});
