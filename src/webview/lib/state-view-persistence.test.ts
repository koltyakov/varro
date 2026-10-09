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
  window.localStorage.clear();
  savedState = {};
  installView('/repo-a');
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
    vi.resetModules();

    const restored = await import('./state-view-persistence');
    expect(restored.getPersistedLastOpenedView()).toEqual(
      savedState['varro.lastOpenedView:/repo-a']
    );
    expect(restored.getPersistedActiveSessionId()).toBe('session-a');
  });

  it('keeps separate views and active sessions for each selected folder', async () => {
    const persistence = await import('./state-view-persistence');
    const { setState } = await import('./app-state');
    persistence.persistLastOpenedView(
      { type: 'session', sessionId: 'session-a', directory: '/repo-a' },
      1
    );
    persistence.persistActiveSessionId('session-a');

    setState('editorContext', 'workspacePath', '/repo-b');
    expect(persistence.getPersistedLastOpenedView()).toBeNull();
    expect(persistence.getPersistedActiveSessionId()).toBeNull();
    persistence.persistLastOpenedView({ type: 'sessions-list' }, 2);
    persistence.persistActiveSessionId('session-b');

    setState('editorContext', 'workspacePath', '/repo-a');
    expect(persistence.getPersistedLastOpenedView()).toMatchObject({ sessionId: 'session-a' });
    expect(persistence.getPersistedActiveSessionId()).toBe('session-a');
    setState('editorContext', 'workspacePath', '/repo-b');
    expect(persistence.getPersistedLastOpenedView()).toEqual({
      type: 'sessions-list',
      timestamp: 2,
    });
    expect(persistence.getPersistedActiveSessionId()).toBe('session-b');
  });

  it('normalizes Windows folder identities', async () => {
    installView('C:\\Repo');
    const persistence = await import('./state-view-persistence');
    const { setState } = await import('./app-state');
    persistence.persistLastOpenedView({ type: 'new-session' }, 3);
    setState('editorContext', 'workspacePath', 'c:/repo/');
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
    const persistence = await import('./state-view-persistence');
    const { setState } = await import('./app-state');
    setState('editorContext', 'workspacePath', '/repo-b');
    expect(persistence.getPersistedLastOpenedView()).toBeNull();
    expect(savedState['varro.lastOpenedView:/repo-b']).toBeUndefined();

    setState('editorContext', 'workspacePath', '/repo-a');
    expect(persistence.getPersistedLastOpenedView()).toEqual(legacy);
    expect(savedState['varro.lastOpenedView:/repo-a']).toEqual(legacy);
  });

  it.each(['new-session', 'sessions-list'])(
    'does not migrate an unscoped %s view into another folder',
    async (type) => {
      window.localStorage.setItem('varro.lastOpenedView', JSON.stringify({ type, timestamp: 1 }));
      const persistence = await import('./state-view-persistence');
      expect(persistence.getPersistedLastOpenedView()).toBeNull();
    }
  );

  it('keeps editor routes in the unscoped state used by the panel serializer', async () => {
    installView('/repo-a', 'editor');
    const persistence = await import('./state-view-persistence');
    persistence.persistLastOpenedView(
      { type: 'session', sessionId: 'editor-session', directory: '/repo-a' },
      4
    );
    expect(savedState['varro.lastOpenedView']).toMatchObject({ sessionId: 'editor-session' });
    expect(savedState['varro.lastOpenedView:/repo-a']).toBeUndefined();
    expect(persistence.getPersistedLastOpenedView()).toMatchObject({ sessionId: 'editor-session' });
  });
});
