import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitialWebviewState } from '../../shared/protocol';
import type { UnknownRecord } from '../../shared/type-utils';

let savedState: UnknownRecord;

function installView(workspacePath: string, surface: 'sidebar' | 'editor' = 'sidebar') {
  const initialState: Partial<InitialWebviewState> = {
    editorContext: {
      workspacePath,
      activeFile: null,
      selection: null,
      diagnostics: [],
    },
    webviewContext: {
      viewId: surface === 'sidebar' ? 'sidebar' : 'editor-1',
      surface,
      initialRoute: { type: 'new-session' },
    },
  };
  // SAFETY: This fixture installs the same bootstrap and view-state APIs as the extension host.
  const hostWindow = window as {
    __initialWebviewState?: Partial<InitialWebviewState>;
    __vscodeWebviewState?: {
      getState(): UnknownRecord;
      setState(state: UnknownRecord): void;
    };
  };
  hostWindow.__initialWebviewState = initialState;
  hostWindow.__vscodeWebviewState = {
    getState: () => savedState,
    setState: (value) => {
      savedState = value;
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  flushSolid();
  window.localStorage.clear();
  flushSolid();
  savedState = {};
  installView('/repo-a');
  flushSolid();
});

afterEach(() => {
  // SAFETY: These optional globals belong to this test's host fixture.
  const hostWindow = window as { __initialWebviewState?: unknown };
  delete hostWindow.__initialWebviewState;
  delete window.__vscodeWebviewState;
});

describe('main chat view persistence', () => {
  it('restores the folder view from VS Code state after the webview origin changes', async () => {
    const first = await import('./state-view-persistence');
    flushSolid();
    first.persistLastOpenedView(
      { type: 'session', sessionId: 'session-a', directory: '/repo-a' },
      1
    );
    first.persistActiveSessionId('session-a');

    expect(savedState['varro.lastOpenedView:/repo-a']).toEqual({
      type: 'session',
      sessionId: 'session-a',
      directory: '/repo-a',
      timestamp: 1,
    });
    expect(window.localStorage.getItem('varro.lastOpenedView:/repo-a')).toBeNull();
    window.localStorage.clear();
    flushSolid();
    vi.resetModules();
    flushSolid();

    const restored = await import('./state-view-persistence');
    flushSolid();
    expect(restored.getPersistedLastOpenedView()).toEqual(
      savedState['varro.lastOpenedView:/repo-a']
    );
    expect(restored.getPersistedActiveSessionId()).toBe('session-a');
  });

  it('keeps separate views and active sessions for each selected folder', async () => {
    const persistence = await import('./state-view-persistence');
    flushSolid();
    const { setState } = await import('./app-state');
    flushSolid();
    persistence.persistLastOpenedView(
      { type: 'session', sessionId: 'session-a', directory: '/repo-a' },
      1
    );
    persistence.persistActiveSessionId('session-a');

    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    expect(persistence.getPersistedLastOpenedView()).toBeNull();
    expect(persistence.getPersistedActiveSessionId()).toBeNull();
    persistence.persistLastOpenedView({ type: 'sessions-list' }, 2);
    persistence.persistActiveSessionId('session-b');

    setState(storePath('editorContext', 'workspacePath', '/repo-a'));
    flushSolid();
    expect(persistence.getPersistedLastOpenedView()).toMatchObject({ sessionId: 'session-a' });
    expect(persistence.getPersistedActiveSessionId()).toBe('session-a');
    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    expect(persistence.getPersistedLastOpenedView()).toEqual({
      type: 'sessions-list',
      timestamp: 2,
    });
    expect(persistence.getPersistedActiveSessionId()).toBe('session-b');
  });

  it('normalizes Windows folder identities', async () => {
    installView('C:\\Repo');
    flushSolid();
    const persistence = await import('./state-view-persistence');
    flushSolid();
    const { setState } = await import('./app-state');
    flushSolid();
    persistence.persistLastOpenedView({ type: 'new-session' }, 3);
    setState(storePath('editorContext', 'workspacePath', 'c:/repo/'));
    flushSolid();
    expect(persistence.getPersistedLastOpenedView()).toEqual({ type: 'new-session', timestamp: 3 });
  });

  it('migrates a legacy route only for the folder containing its session directory', async () => {
    const legacy = {
      type: 'session',
      sessionId: 'session-a',
      directory: '/repo-a/subdir',
      timestamp: 1,
    };
    window.localStorage.setItem('varro.lastOpenedView', JSON.stringify(legacy));
    flushSolid();
    const persistence = await import('./state-view-persistence');
    flushSolid();
    const { setState } = await import('./app-state');
    flushSolid();
    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    expect(persistence.getPersistedLastOpenedView()).toBeNull();
    expect(savedState['varro.lastOpenedView:/repo-b']).toBeUndefined();

    setState(storePath('editorContext', 'workspacePath', '/repo-a'));
    flushSolid();
    expect(persistence.getPersistedLastOpenedView()).toEqual(legacy);
    expect(savedState['varro.lastOpenedView:/repo-a']).toEqual(legacy);
  });

  it.each(['new-session', 'sessions-list'])(
    'does not migrate an unscoped %s view into another folder',
    async (type) => {
      window.localStorage.setItem('varro.lastOpenedView', JSON.stringify({ type, timestamp: 1 }));
      flushSolid();
      const persistence = await import('./state-view-persistence');
      flushSolid();
      expect(persistence.getPersistedLastOpenedView()).toBeNull();
    }
  );

  it('keeps editor routes in the unscoped state used by the panel serializer', async () => {
    installView('/repo-a', 'editor');
    flushSolid();
    const persistence = await import('./state-view-persistence');
    flushSolid();
    persistence.persistLastOpenedView(
      { type: 'session', sessionId: 'editor-session', directory: '/repo-a' },
      4
    );
    expect(savedState['varro.lastOpenedView']).toMatchObject({ sessionId: 'editor-session' });
    expect(savedState['varro.lastOpenedView:/repo-a']).toBeUndefined();
    expect(persistence.getPersistedLastOpenedView()).toMatchObject({ sessionId: 'editor-session' });
  });
});
