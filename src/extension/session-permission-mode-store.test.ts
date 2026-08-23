/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Test persistence returns a fixture through the generic storage boundary. */
import { describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { SessionPermissionModeStore } from './session-permission-mode-store';

describe('SessionPermissionModeStore', () => {
  it('restores valid modes and persists updates', async () => {
    const persistence: Persistence = {
      get<T>() {
        return { valid: 'auto', invalid: 'unknown' } as T;
      },
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionPermissionModeStore(persistence);

    expect(store.list()).toEqual({ valid: 'auto' });
    await expect(store.set('session-1', 'full')).resolves.toEqual({
      valid: 'auto',
      'session-1': 'full',
    });
    await expect(store.set('valid', null)).resolves.toEqual({ 'session-1': 'full' });
    expect(persistence.set).toHaveBeenLastCalledWith('varro.sessionPermissionModes', {
      'session-1': 'full',
    });
  });
});
