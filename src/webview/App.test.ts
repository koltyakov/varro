import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { AppRoot } from './App';
import { setError, setState, state } from './lib/state';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function mountAppRoot() {
  cleanup = render(() => AppRoot(), container!);
}

describe('AppRoot', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    container?.remove();
    container = null;
  });

  it('creates fresh webview state for each mount', () => {
    mountAppRoot();

    setState('serverStatus', { state: 'error', message: 'boom' });
    setState('activeSessionId', 'session-1');
    setState('messages', [
      {
        info: {
          id: 'message-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 0 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        },
        parts: [],
      },
    ]);
    setError('test error');

    expect(state.serverStatus).toEqual({ state: 'error', message: 'boom' });
    expect(state.serverStatus.state).toBe('error');
    expect(state.activeSessionId).toBe('session-1');

    cleanup();
    mountAppRoot();

    expect(state.serverStatus).toEqual({ state: 'stopped' });
    expect(state.activeSessionId).toBeNull();
    expect(state.messages).toEqual([]);
  });
});
