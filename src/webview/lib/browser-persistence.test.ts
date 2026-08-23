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

  it('mirrors values into VSCode webview state', () => {
    const storage = new BrowserPersistence();
    let vscodeState: TestRuntimeRecord = {};
    window.__vscodeWebviewState = {
      getState: () => vscodeState,
      setState: (state) => {
        vscodeState = state;
      },
    };

    storage.set('varro.lastOpenedView', { type: 'session', sessionId: 'session-1' });

    expect(vscodeState).toEqual({
      'varro.lastOpenedView': { type: 'session', sessionId: 'session-1' },
    });
    expect(storage.get('varro.lastOpenedView')).toEqual({
      type: 'session',
      sessionId: 'session-1',
    });

    storage.remove('varro.lastOpenedView');

    expect(vscodeState).toEqual({});
    expect(storage.get('varro.lastOpenedView')).toBeUndefined();
  });

  it("loads another view's canonical shared write instead of stale private VSCode state", () => {
    let firstViewState: TestRuntimeRecord = {};
    window.__vscodeWebviewState = {
      getState: () => firstViewState,
      setState: (state) => {
        firstViewState = state;
      },
    };
    new BrowserPersistence().set('varro.selectedModel', {
      providerID: 'openai',
      modelID: 'stale-model',
    });

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
    expect(window.localStorage.getItem('varro.lastOpenedView')).toBeNull();
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
      expect(vscodeState).toEqual({
        'varro.lastOpenedView': { type: 'sessions-list' },
      });
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
    }
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
    storage.set('varro.composerDraft', 'a');
    storage.set('varro.composerDraft', 'ab');

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
    storage.remove('varro.composerDraft');

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
