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

vi.mock('./components/Chat', () => ({
  Chat: () => 'New Chat',
}));

vi.mock('./components/ralph/RalphForm', () => ({
  RalphForm: () => {
    if (appMocks.ralphError.current) throw appMocks.ralphError.current;
    return null;
  },
}));

import { AppRoot } from './App';
import {
  errorRetry,
  resetDefaultAppState,
  setConnectionInitialized,
  setError,
  setErrorRetry,
  setState,
  state,
} from './lib/state';
import { ralphStore } from './lib/stores/ralph-store';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function mountAppRoot() {
  cleanup = render(() => AppRoot(), container!);
}

describe('AppRoot', () => {
  beforeEach(() => {
    resetDefaultAppState();
    appMocks.ralphError.current = null;
    ralphStore.setShowRalphForm(false);
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

    const dispose = cleanup;
    if (!dispose) throw new Error('Expected AppRoot to be mounted');
    dispose();
    cleanup = undefined;
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

  it('shows a loading screen until the recent view is restored', () => {
    setState('serverStatus', { state: 'running', url: 'http://127.0.0.1:4096' });
    mountAppRoot();

    expect(container?.textContent).toContain('Loading workspace...');
    expect(container?.textContent).not.toContain('New Chat');

    setConnectionInitialized(true);

    expect(container?.textContent).not.toContain('Loading workspace...');
    expect(container?.textContent).toContain('New Chat');
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

  it('keeps RalphForm failures inside the root boundary', async () => {
    appMocks.ralphError.current = new Error('ralph failed');
    ralphStore.setShowRalphForm(true);

    expect(() => mountAppRoot()).not.toThrow();
    await vi.waitFor(() => {
      expect(container?.textContent).toContain('Something went wrong');
      expect(container?.textContent).toContain('ralph failed');
    });
  });

  it('shows app errors in a toast and runs its retry action', () => {
    setState('serverStatus', { state: 'running', url: 'http://127.0.0.1:4096' });
    setConnectionInitialized(true);
    setError('Failed to send message');
    mountAppRoot();

    const errorToast = document.body.querySelector<HTMLElement>('.session-action-feedback');
    expect(errorToast?.textContent).toContain('Failed to send message');
    expect(errorToast?.getAttribute('role')).toBe('alert');
    expect(errorToast?.getAttribute('aria-live')).toBe('assertive');
    expect(container?.textContent).not.toContain('Failed to send message');
    expect(errorToast?.textContent).not.toContain('Retry');

    const retry = vi.fn();
    setErrorRetry(retry);
    const retryButton = Array.from(errorToast?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Retry'
    );
    expect(retryButton).toBeDefined();

    retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(retry).toHaveBeenCalledTimes(1);

    errorToast
      ?.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.body.querySelector('.session-action-feedback')).toBeNull();
  });

  it('clears the retry action whenever the error changes', () => {
    setErrorRetry(vi.fn());
    expect(errorRetry()).not.toBeNull();

    setError('another failure');
    expect(errorRetry()).toBeNull();
  });
});
