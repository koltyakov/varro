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

  it('migrates only modes still absent when the operation runs', async () => {
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionPermissionModeStore(persistence);

    await store.set('session-1', 'full');
    await expect(
      store.setIfAbsent({ 'session-1': 'auto', 'session-legacy': 'default' })
    ).resolves.toEqual({
      'session-1': 'full',
      'session-legacy': 'default',
    });
  });

  it('migrates removed edit modes to recoverable defaults', async () => {
    const values = new Map<string, unknown>([
      ['varro.sessionPermissionModes', { 'session-legacy': 'edits' }],
    ]);
    const persistence: Persistence = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: vi.fn(async <T>(key: string, value: T) => {
        values.set(key, value);
      }),
      remove: vi.fn(),
    };

    const store = new SessionPermissionModeStore(persistence);
    await store.dispose();

    expect(store.list()).toEqual({ 'session-legacy': 'default' });
    expect(store.pendingSafeFallbackSessionIds()).toEqual(['session-legacy']);
    expect(values.get('varro.sessionPermissionModes')).toEqual({
      'session-legacy': 'default',
    });
    expect(values.get('varro.sessionPermissionModeFallbacks')).toEqual(['session-legacy']);
  });

  it('removes the persisted mode for a deleted session', async () => {
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionPermissionModeStore(persistence);
    await store.set('session-1', 'full');

    await store.removeSession('session-1');

    expect(store.list()).toEqual({});
  });

  it('drops unsafe persisted session IDs and rejects new ones', async () => {
    const overlong = 'x'.repeat(513);
    const stored = JSON.parse(
      JSON.stringify({
        valid: 'auto',
        constructor: 'full',
        prototype: 'auto',
        [overlong]: 'auto',
      })
    );
    Object.defineProperty(stored, '__proto__', { value: 'full', enumerable: true });
    const persistence: Persistence = {
      get: vi.fn(() => stored) as Persistence['get'],
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionPermissionModeStore(persistence);

    expect(store.list()).toEqual({ valid: 'auto' });
    for (const sessionId of ['__proto__', 'constructor', 'prototype', overlong]) {
      await expect(store.set(sessionId, 'full')).rejects.toThrow('Invalid persisted session ID');
    }
  });

  it('retains a server-confirmed mode in memory when persistence fails', async () => {
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi.fn(() => Promise.reject(new Error('disk full'))),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionPermissionModeStore(persistence);

    await expect(store.set('session-1', 'full')).rejects.toThrow('disk full');

    expect(store.list()).toEqual({ 'session-1': 'full' });
  });

  it('keeps a staged fallback conservative until remote recovery is durable', async () => {
    const values = new Map<string, unknown>([
      ['varro.sessionPermissionModes', { 'session-1': 'full' }],
    ]);
    const persistence: Persistence = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: vi.fn(async <T>(key: string, value: T) => {
        if (key === 'varro.sessionPermissionModes') throw new Error('disk full');
        values.set(key, value);
      }),
      remove: vi.fn(),
    };
    const store = new SessionPermissionModeStore(persistence);

    await store.stageSafeFallback('session-1');
    await expect(store.set('session-1', 'default')).rejects.toThrow('disk full');

    expect(store.list()).toEqual({ 'session-1': 'default' });
    expect(store.pendingSafeFallbackSessionIds()).toEqual(['session-1']);

    const restored = new SessionPermissionModeStore(persistence);
    const pending = restored.pendingSafeFallbackSessionIds();
    pending.length = 0;
    expect(restored.list()).toEqual({ 'session-1': 'default' });
    expect(restored.pendingSafeFallbackSessionIds()).toEqual(['session-1']);
  });
});
