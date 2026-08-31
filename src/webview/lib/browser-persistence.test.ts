import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPersistence } from './browser-persistence';
import { fixture } from '../test-fixtures';

type TestRuntimeValue =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | TestRuntimeObject
  | readonly TestRuntimeValue[];
interface TestRuntimeObject {
  readonly [key: string]: TestRuntimeValue;
  readonly type?: string;
  readonly id?: string | number;
  readonly message?: string;
}
interface TestRuntimeRecord {
  [key: string]: TestRuntimeValue;
}

declare global {
  interface Window {
    __vscodeWebviewState?: {
      getState(): TestRuntimeRecord;
      setState(state: TestRuntimeRecord): void;
    };
    __sendToExtension?: (message: TestRuntimeValue) => void;
  }
}

function setInitialWebviewState(value?: TestRuntimeRecord) {
  // SAFETY: Tests own this optional host bootstrap field and restore it after each case.
  const hostWindow = window as typeof window & { __initialWebviewState?: unknown };
  if (value === undefined) delete hostWindow.__initialWebviewState;
  else hostWindow.__initialWebviewState = value;
}

beforeEach(() => {
  window.localStorage.clear();
  setInitialWebviewState();
  delete window.__vscodeWebviewState;
  delete window.__sendToExtension;
});

afterEach(() => {
  setInitialWebviewState();
  delete window.__vscodeWebviewState;
  delete window.__sendToExtension;
  vi.restoreAllMocks();
});

describe('BrowserPersistence', () => {
  it('keeps editor route and draft state out of shared local storage', () => {
    setInitialWebviewState({
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
    });
    let vscodeState: TestRuntimeRecord = {};
    window.__vscodeWebviewState = {
      getState: () => vscodeState,
      setState: (state) => {
        vscodeState = state;
      },
    };
    window.localStorage.setItem(
      'varro.lastOpenedView',
      JSON.stringify({ type: 'session', sessionId: 'sidebar-session' })
    );
    const storage = new BrowserPersistence();

    expect(storage.get('varro.lastOpenedView')).toBeUndefined();
    storage.set('varro.lastOpenedView', { type: 'new-session' });

    expect(vscodeState['varro.lastOpenedView']).toEqual({ type: 'new-session' });
    expect(JSON.parse(window.localStorage.getItem('varro.lastOpenedView') || 'null')).toEqual({
      type: 'session',
      sessionId: 'sidebar-session',
    });
  });

  it('does not mirror successful shared writes into VS Code webview state', () => {
    const storage = new BrowserPersistence();
    let vscodeState: TestRuntimeRecord = {};
    const setState = vi.fn((state: TestRuntimeRecord) => {
      vscodeState = state;
    });
    window.__vscodeWebviewState = {
      getState: () => vscodeState,
      setState,
    };

    storage.set('varro.lastOpenedView', { type: 'session', sessionId: 'session-1' });
    storage.set('varro.lastOpenedView', { type: 'session', sessionId: 'session-2' });

    expect(setState).not.toHaveBeenCalled();
    expect(vscodeState).toEqual({});
    expect(storage.get('varro.lastOpenedView')).toEqual({
      type: 'session',
      sessionId: 'session-2',
    });

    storage.remove('varro.lastOpenedView');

    expect(setState).not.toHaveBeenCalled();
    expect(vscodeState).toEqual({});
    expect(storage.get('varro.lastOpenedView')).toBeUndefined();
  });

  it('cleans a stale shared mirror once without recurring VS Code writes', () => {
    let vscodeState: TestRuntimeRecord = {
      'varro.selectedAgent': 'stale',
    };
    const setState = vi.fn((state: TestRuntimeRecord) => {
      vscodeState = state;
    });
    window.__vscodeWebviewState = {
      getState: () => vscodeState,
      setState,
    };
    const storage = new BrowserPersistence();

    storage.set('varro.selectedAgent', 'build');
    storage.set('varro.selectedAgent', 'plan');

    expect(setState).toHaveBeenCalledOnce();
    expect(vscodeState).toEqual({});
    expect(storage.get('varro.selectedAgent')).toBe('plan');
  });

  it("loads another view's canonical shared write instead of stale private VSCode state", () => {
    let firstViewState: TestRuntimeRecord = {
      'varro.selectedModel': {
        providerID: 'openai',
        modelID: 'stale-model',
      },
    };
    let secondViewState: TestRuntimeRecord = {};
    window.__vscodeWebviewState = {
      getState: () => secondViewState,
      setState: (state) => {
        secondViewState = state;
      },
    };
    new BrowserPersistence().set('varro.selectedModel', {
      providerID: 'anthropic',
      modelID: 'canonical-model',
    });

    window.__vscodeWebviewState = {
      getState: () => firstViewState,
      setState: (state) => {
        firstViewState = state;
      },
    };

    expect(new BrowserPersistence().get('varro.selectedModel')).toEqual({
      providerID: 'anthropic',
      modelID: 'canonical-model',
    });
    expect(firstViewState['varro.selectedModel']).toEqual({
      providerID: 'openai',
      modelID: 'stale-model',
    });
  });

  it('keeps editor-instance state private across two view writes and reloads', () => {
    setInitialWebviewState({
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
    });
    let firstViewState: TestRuntimeRecord = {};
    window.__vscodeWebviewState = {
      getState: () => firstViewState,
      setState: (state) => {
        firstViewState = state;
      },
    };
    new BrowserPersistence().set('varro.lastOpenedView', {
      type: 'session',
      sessionId: 'session-1',
    });
    new BrowserPersistence().set('varro.workspacePath', '/repo-a');
    new BrowserPersistence().set('varro.manualWorkspaceSelection', true);

    let secondViewState: TestRuntimeRecord = {};
    window.__vscodeWebviewState = {
      getState: () => secondViewState,
      setState: (state) => {
        secondViewState = state;
      },
    };
    new BrowserPersistence().set('varro.lastOpenedView', {
      type: 'session',
      sessionId: 'session-2',
    });
    new BrowserPersistence().set('varro.workspacePath', '/repo-b');
    new BrowserPersistence().set('varro.manualWorkspaceSelection', false);

    window.__vscodeWebviewState = {
      getState: () => firstViewState,
      setState: (state) => {
        firstViewState = state;
      },
    };

    expect(new BrowserPersistence().get('varro.lastOpenedView')).toEqual({
      type: 'session',
      sessionId: 'session-1',
    });
    expect(new BrowserPersistence().get('varro.workspacePath')).toBe('/repo-a');
    expect(new BrowserPersistence().get('varro.manualWorkspaceSelection')).toBe(true);
    expect(window.localStorage.getItem('varro.lastOpenedView')).toBeNull();
    expect(window.localStorage.getItem('varro.workspacePath')).toBeNull();
  });

  it('keeps sidebar composer state private across two webview instances', () => {
    setInitialWebviewState({
      webviewContext: {
        viewId: 'sidebar',
        surface: 'sidebar',
        initialRoute: { type: 'new-session' },
      },
    });
    window.localStorage.setItem(
      'varro.inputDraftFiles',
      JSON.stringify([{ path: '/stale/file.ts', relativePath: 'file.ts', type: 'file' }])
    );
    window.localStorage.setItem('varro.inputDraft', JSON.stringify('stale draft'));
    window.localStorage.setItem(
      'varro.queuedMessageEdit',
      JSON.stringify({ id: 'stale-message', sessionId: 'stale-session' })
    );
    window.localStorage.setItem(
      'varro.queuedMessages',
      JSON.stringify([{ id: 'stale-message', sessionId: 'stale-session', text: 'stale queue' }])
    );
    let firstViewState: TestRuntimeRecord = {};
    window.__vscodeWebviewState = {
      getState: () => firstViewState,
      setState: (state) => {
        firstViewState = state;
      },
    };
    const firstFiles = [{ path: '/repo-a/file.ts', relativePath: 'file.ts', type: 'file' }];
    const firstEdit = { id: 'message-1', sessionId: 'session-1' };
    const firstQueue = [{ id: 'message-1', sessionId: 'session-1', text: 'queued message' }];
    const firstStorage = new BrowserPersistence();

    expect(firstStorage.get('varro.inputDraft')).toBeUndefined();
    expect(firstStorage.get('varro.inputDraftFiles')).toBeUndefined();
    expect(firstStorage.get('varro.queuedMessageEdit')).toBeUndefined();
    expect(firstStorage.get('varro.queuedMessages')).toBeUndefined();
    firstStorage.set('varro.inputDraft', 'first draft');
    firstStorage.set('varro.inputDraftFiles', firstFiles);
    firstStorage.set('varro.queuedMessageEdit', firstEdit);
    firstStorage.set('varro.queuedMessages', firstQueue);

    let secondViewState: TestRuntimeRecord = {};
    window.__vscodeWebviewState = {
      getState: () => secondViewState,
      setState: (state) => {
        secondViewState = state;
      },
    };

    expect(new BrowserPersistence().get('varro.inputDraft')).toBeUndefined();
    expect(new BrowserPersistence().get('varro.inputDraftFiles')).toBeUndefined();
    expect(new BrowserPersistence().get('varro.queuedMessageEdit')).toBeUndefined();
    expect(new BrowserPersistence().get('varro.queuedMessages')).toBeUndefined();

    window.__vscodeWebviewState = {
      getState: () => firstViewState,
      setState: (state) => {
        firstViewState = state;
      },
    };

    expect(new BrowserPersistence().get('varro.inputDraft')).toBe('first draft');
    expect(new BrowserPersistence().get('varro.inputDraftFiles')).toEqual(firstFiles);
    expect(new BrowserPersistence().get('varro.queuedMessageEdit')).toEqual(firstEdit);
    expect(new BrowserPersistence().get('varro.queuedMessages')).toEqual(firstQueue);
    expect(JSON.parse(window.localStorage.getItem('varro.inputDraft') || 'null')).toBe(
      'stale draft'
    );
    expect(JSON.parse(window.localStorage.getItem('varro.inputDraftFiles') || 'null')).toEqual([
      { path: '/stale/file.ts', relativePath: 'file.ts', type: 'file' },
    ]);
    expect(JSON.parse(window.localStorage.getItem('varro.queuedMessageEdit') || 'null')).toEqual({
      id: 'stale-message',
      sessionId: 'stale-session',
    });
    expect(JSON.parse(window.localStorage.getItem('varro.queuedMessages') || 'null')).toEqual([
      { id: 'stale-message', sessionId: 'stale-session', text: 'stale queue' },
    ]);
  });

  it('continues with VSCode state when localStorage acquisition is denied', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    let vscodeState: TestRuntimeRecord = {};
    window.__vscodeWebviewState = {
      getState: () => vscodeState,
      setState: (state) => {
        vscodeState = state;
      },
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied');
      },
    });

    try {
      const storage = new BrowserPersistence();
      storage.set('varro.lastOpenedView', { type: 'sessions-list' });

      expect(storage.get('varro.lastOpenedView')).toEqual({ type: 'sessions-list' });
      expect(vscodeState['varro.lastOpenedView']).toEqual({ type: 'sessions-list' });
      expect(vscodeState['__varroLocalStorageFailures']).toEqual({
        'varro.lastOpenedView': null,
      });
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
    }
  });

  it('prefers newer VSCode state when a shared localStorage write fails', () => {
    let vscodeState: TestRuntimeRecord = {};
    const setState = vi.fn((state: TestRuntimeRecord) => {
      vscodeState = state;
    });
    window.__vscodeWebviewState = {
      getState: () => vscodeState,
      setState,
    };
    const values = new Map([['varro.selectedModel', JSON.stringify({ modelID: 'old' })]]);
    const failingStorage = fixture<Storage>({
      getItem: (key) => values.get(key) ?? null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {
        throw new Error('quota exceeded');
      },
    });

    new BrowserPersistence(failingStorage).set('varro.selectedModel', { modelID: 'new' });

    expect(new BrowserPersistence(failingStorage).get('varro.selectedModel')).toEqual({
      modelID: 'new',
    });
    expect(setState).toHaveBeenCalledOnce();
    expect(vscodeState['__varroLocalStorageFailures']).toEqual({
      'varro.selectedModel': JSON.stringify({ modelID: 'old' }),
    });
  });

  it('falls back to VS Code state when a shared value cannot be serialized', () => {
    let vscodeState: TestRuntimeRecord = {};
    const setState = vi.fn((state: TestRuntimeRecord) => {
      vscodeState = state;
    });
    window.__vscodeWebviewState = {
      getState: () => vscodeState,
      setState,
    };
    const storage = new BrowserPersistence();

    storage.set('varro.unsupportedValue', 1n);

    expect(setState).toHaveBeenCalledOnce();
    expect(storage.get('varro.unsupportedValue')).toBe(1n);
    expect(window.localStorage.getItem('varro.unsupportedValue')).toBeNull();
  });

  it('warns once when storage removal keeps failing', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const failingStorage = fixture<Storage>({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('quota exceeded');
      },
    });
    const storage = new BrowserPersistence(failingStorage);

    storage.remove('varro.lastOpenedView');
    storage.remove('varro.composerDraft');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'log',
      payload: {
        msg: 'browser-persistence:remove:varro.lastOpenedView',
        error: 'quota exceeded',
        level: 'warn',
      },
    });
  });

  it('warns once when writing the VSCode webview state keeps failing', () => {
    setInitialWebviewState({
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
    });
    const send = vi.fn();
    window.__sendToExtension = send;
    window.__vscodeWebviewState = {
      getState: () => {
        throw new Error('state unavailable');
      },
      setState: vi.fn(),
    };
    const storage = new BrowserPersistence();

    storage.set('varro.lastOpenedView', { type: 'sessions-list' });
    storage.set('varro.workspacePath', '/repo-a');
    storage.set('varro.manualWorkspaceSelection', true);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'log',
      payload: {
        msg: 'browser-persistence:vscode-state-write:varro.lastOpenedView',
        error: 'state unavailable',
        level: 'warn',
      },
    });
  });

  it('warns once when removing from the VSCode webview state keeps failing', () => {
    setInitialWebviewState({
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
    });
    const send = vi.fn();
    window.__sendToExtension = send;
    window.__vscodeWebviewState = {
      getState: () => {
        throw new Error('state unavailable');
      },
      setState: vi.fn(),
    };
    const storage = new BrowserPersistence();

    storage.remove('varro.lastOpenedView');
    storage.remove('varro.workspacePath');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'log',
      payload: {
        msg: 'browser-persistence:vscode-state-remove:varro.lastOpenedView',
        error: 'state unavailable',
        level: 'warn',
      },
    });
  });
});
