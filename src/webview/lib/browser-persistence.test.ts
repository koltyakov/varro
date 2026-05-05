import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPersistence } from './browser-persistence';

declare global {
  interface Window {
    __vscodeWebviewState?: {
      getState(): Record<string, unknown>;
      setState(state: Record<string, unknown>): void;
    };
  }
}

beforeEach(() => {
  window.localStorage.clear();
  delete window.__vscodeWebviewState;
});

afterEach(() => {
  delete window.__vscodeWebviewState;
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
});
