import { describe, expect, it, vi } from 'vitest';
import { SessionWorkspaceScopeStore } from './session-workspace-scope-store';

describe('SessionWorkspaceScopeStore', () => {
  it('restores valid scopes and ignores malformed entries', () => {
    // SAFETY: The store requests this fixture as unknown and validates every entry before use.
    const store = new SessionWorkspaceScopeStore({
      get: <T>() => ({ workspace: 'workspace', folder: 'folder', invalid: 'other' }) as T,
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    });

    expect(store.get('workspace')).toBe('workspace');
    expect(store.get('folder')).toBe('folder');
    expect(store.get('invalid')).toBe('folder');
  });

  it('persists workspace scope and removal', async () => {
    const set = vi.fn(() => Promise.resolve());
    const store = new SessionWorkspaceScopeStore({
      get: vi.fn(),
      set,
      remove: vi.fn(() => Promise.resolve()),
    });

    await store.set('session-1', 'workspace');
    expect(store.get('session-1')).toBe('workspace');
    expect(set).toHaveBeenLastCalledWith('varro.sessionWorkspaceScopes', {
      'session-1': 'workspace',
    });

    await store.set('session-1', null);
    expect(store.get('session-1')).toBe('folder');
    expect(set).toHaveBeenLastCalledWith('varro.sessionWorkspaceScopes', {});
  });
});
