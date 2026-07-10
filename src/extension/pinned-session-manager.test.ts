import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PinnedSessionManager } from './pinned-session-manager';

const stored = { value: undefined as unknown };
const persistence = {
  get: vi.fn(() => stored.value),
  set: vi.fn(async (_key: string, value: unknown) => {
    stored.value = value;
  }),
  remove: vi.fn(),
};

describe('PinnedSessionManager', () => {
  beforeEach(() => {
    stored.value = undefined;
    vi.clearAllMocks();
  });

  it('loads unique valid session ids', () => {
    stored.value = ['session-1', '', 42, 'session-1', 'session-2'];

    expect(new PinnedSessionManager(persistence).list()).toEqual(['session-1', 'session-2']);
  });

  it('persists pin and unpin changes', async () => {
    const manager = new PinnedSessionManager(persistence);

    await expect(manager.setPinned('session-1', true)).resolves.toEqual(['session-1']);
    await expect(manager.setPinned('session-2', true)).resolves.toEqual(['session-2', 'session-1']);
    await expect(manager.setPinned('session-1', false)).resolves.toEqual(['session-2']);
    expect(stored.value).toEqual(['session-2']);
  });

  it('keeps memory unchanged when persistence fails', async () => {
    stored.value = ['session-1'];
    const manager = new PinnedSessionManager(persistence);
    persistence.set.mockRejectedValueOnce(new Error('write failed'));

    await expect(manager.setPinned('session-2', true)).rejects.toThrow('write failed');
    expect(manager.list()).toEqual(['session-1']);
  });
});
