import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';

const appMocks = vi.hoisted(() => ({
  apiCall: vi.fn(),
  cleanupBridge: vi.fn(),
  onMessage: vi.fn(() => vi.fn()),
  postMessage: vi.fn(() => true),
  ralphError: { current: null as Error | null },
  useOpenCode: vi.fn(),
}));

vi.mock('./hooks/useOpenCode', () => ({
  useOpenCode: appMocks.useOpenCode,
}));

vi.mock('./lib/bridge', () => ({
  apiCall: appMocks.apiCall,
  cleanupBridge: appMocks.cleanupBridge,
  onMessage: appMocks.onMessage,
  postMessage: appMocks.postMessage,
}));

vi.mock('./components/ralph/RalphForm', () => ({
  RalphForm: () => {
    if (appMocks.ralphError.current) throw appMocks.ralphError.current;
    return null;
  },
}));

import { AppRoot } from './App';
import { resetDefaultAppState, setError, setState, state } from './lib/state';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function mountAppRoot() {
  cleanup = render(() => AppRoot(), container!);
}

describe('AppRoot', () => {
  beforeEach(() => {
    resetDefaultAppState();
    appMocks.ralphError.current = null;
    appMocks.cleanupBridge.mockReset();
    appMocks.useOpenCode.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    container?.remove();
    container = null;
    resetDefaultAppState();
  });

  it('does not reset singleton state during render', () => {
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

    expect(state.serverStatus).toEqual({ state: 'error', message: 'boom' });
    expect(state.activeSessionId).toBe('session-1');
    expect(state.messages).toHaveLength(1);
  });

  it('cleans up the bridge only when the Solid root is disposed', () => {
    mountAppRoot();

    expect(appMocks.cleanupBridge).not.toHaveBeenCalled();
    cleanup?.();
    cleanup = undefined;

    expect(appMocks.cleanupBridge).toHaveBeenCalledOnce();
  });

  it('renders the root fallback when app initialization throws', () => {
    appMocks.useOpenCode.mockImplementationOnce(() => {
      throw new Error('initialization failed');
    });

    expect(() => mountAppRoot()).not.toThrow();
    expect(container?.textContent).toContain('Something went wrong');
    expect(container?.textContent).toContain('initialization failed');
    expect(container?.textContent).not.toContain('Error: initialization failed');
  });

  it('keeps RalphForm failures inside the root boundary', () => {
    appMocks.ralphError.current = new Error('ralph failed');

    expect(() => mountAppRoot()).not.toThrow();
    expect(container?.textContent).toContain('Something went wrong');
    expect(container?.textContent).toContain('ralph failed');
  });
});
