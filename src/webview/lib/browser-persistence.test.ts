import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPersistence } from './browser-persistence';

declare global {
  interface Window {
    __vscodeWebviewState?: {
      getState(): Record<string, unknown>;
      setState(state: Record<string, unknown>): void;
    };
    __sendToExtension?: (message: unknown) => void;
  }
}

beforeEach(() => {
  window.localStorage.clear();
  delete window.__vscodeWebviewState;
  delete window.__sendToExtension;
});

afterEach(() => {
  delete window.__vscodeWebviewState;
  delete window.__sendToExtension;
  vi.restoreAllMocks();
});

describe('BrowserPersistence', () => {
  it('mirrors values into VSCode webview state', () => {
    const storage = new BrowserPersistence();
    let vscodeState: Record<string, unknown> = {};
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

  it('prefers VSCode webview state after a webview reload', () => {
    const storage = new BrowserPersistence();
    window.localStorage.setItem('varro.lastOpenedView', JSON.stringify({ type: 'sessions-list' }));
    window.__vscodeWebviewState = {
      getState: () => ({
        'varro.lastOpenedView': { type: 'session', sessionId: 'session-1' },
      }),
      setState: vi.fn(),
    };

    expect(storage.get('varro.lastOpenedView')).toEqual({
      type: 'session',
      sessionId: 'session-1',
    });
  });

  it('continues with VSCode state when localStorage acquisition is denied', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    let vscodeState: Record<string, unknown> = {};
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
    const failingStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('quota exceeded');
      },
    } as unknown as Storage;
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
