import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';

// SAFETY: The fixture provides the Error | null fields read by this statement.
const appMocks = vi.hoisted(() => ({
  apiCall: vi.fn(),
  cleanupBridge: vi.fn(),
  onMessage: vi.fn(() => vi.fn()),
  postMessage: vi.fn(() => true),
  logError: vi.fn(),
  ralphError: { current: null as Error | null },
  useOpenCode: vi.fn(),
}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise App's module-level view routing integration. */
vi.mock('./hooks/useOpenCode', () => ({
  useOpenCode: appMocks.useOpenCode,
}));

vi.mock('./lib/bridge', () => ({
  apiCall: appMocks.apiCall,
  cleanupBridge: appMocks.cleanupBridge,
  onMessage: appMocks.onMessage,
  postMessage: appMocks.postMessage,
}));

vi.mock('./lib/log', () => ({
  logError: appMocks.logError,
}));

vi.mock('./components/Chat', () => ({
  Chat: () => 'New Chat',
}));

vi.mock('./components/ralph/RalphForm', () => ({
  RalphForm: () => {
    if (appMocks.ralphError.current) throw appMocks.ralphError.current;
    return 'Ralph Form';
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
import { showSessionActionFeedback } from './components/chat/SessionActionFeedback';

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
    appMocks.logError.mockReset();
    appMocks.postMessage.mockReset().mockReturnValue(true);
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
    vi.useRealTimers();
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

    expect(container?.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(
      'Loading workspace'
    );
    expect(container?.textContent?.trim()).toBe('');
    expect(container?.textContent).not.toContain('New Chat');

    setConnectionInitialized(true);

    expect(container?.querySelector('[role="status"]')).toBeNull();
    expect(container?.textContent).toContain('New Chat');
  });

  it('suggests opening a folder and opens the native folder picker', () => {
    setState('serverStatus', { state: 'running', url: 'http://127.0.0.1:4096' });
    setConnectionInitialized(true);
    setState('editorContext', {
      ...state.editorContext,
      workspacePath: null,
      workspaceFolders: [],
    });
    mountAppRoot();

    expect(container?.textContent).toContain('Open a folder to use Varro');
    expect(container?.textContent).not.toContain('New Chat');
    const folderIcon = container?.querySelector<HTMLElement>('.ui-icon.text-vscode-muted');
    expect(folderIcon?.style.getPropertyValue('--ui-icon-width')).toBe('40px');
    expect(folderIcon?.style.getPropertyValue('--ui-icon-height')).toBe('40px');

    const openFolderButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Open Folder'
    );
    openFolderButton?.click();
    expect(appMocks.postMessage).toHaveBeenCalledWith({ type: 'vscode/open-folder' });

    setState('editorContext', 'workspaceFolders', [{ name: 'repo', path: '/repo' }]);
    expect(container?.textContent).not.toContain('Open a folder to use Varro');
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
    expect(appMocks.logError).toHaveBeenCalledWith(
      'app:error-boundary',
      expect.stringContaining('Error: initialization failed')
    );
    expect(appMocks.cleanupBridge).not.toHaveBeenCalled();
    const errorIcon = container?.querySelector<HTMLElement>('.ui-icon.text-vscode-error');
    expect(errorIcon?.style.getPropertyValue('--ui-icon-width')).toBe('32px');
    expect(errorIcon?.getAttribute('aria-hidden')).toBe('true');

    const reloadButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Reload sidebar'
    );
    reloadButton?.click();
    expect(appMocks.postMessage).toHaveBeenCalledWith({ type: 'webview/reload' });
    cleanup?.();
    cleanup = undefined;
    expect(appMocks.cleanupBridge).toHaveBeenCalledOnce();
  });

  it('reports and displays non-Error initialization failures', () => {
    appMocks.useOpenCode.mockImplementationOnce(() => {
      throw { reason: 'invalid startup state' };
    });

    expect(() => mountAppRoot()).not.toThrow();
    expect(container?.textContent).toContain('{"reason":"invalid startup state"}');
    expect(container?.textContent).not.toContain('Unknown error');
    expect(appMocks.logError).toHaveBeenCalledWith(
      'app:error-boundary',
      expect.stringContaining('Cause: {"reason":"invalid startup state"}')
    );
  });

  it('reports an undefined initialization failure from its wrapped cause', () => {
    appMocks.useOpenCode.mockImplementationOnce(() => {
      throw undefined;
    });

    expect(() => mountAppRoot()).not.toThrow();
    expect(container?.textContent).toContain('Something went wrongundefined');
    expect(container?.textContent).not.toContain('Unknown error');
    expect(appMocks.logError).toHaveBeenCalledWith(
      'app:error-boundary',
      expect.stringContaining('Cause: undefined')
    );
  });

  it('identifies a Promise initialization failure', () => {
    appMocks.useOpenCode.mockImplementationOnce(() => {
      throw Promise.resolve();
    });

    expect(() => mountAppRoot()).not.toThrow();
    expect(container?.textContent).toContain('[object Promise]');
    expect(appMocks.logError).toHaveBeenCalledWith(
      'app:error-boundary',
      expect.stringContaining('Cause: [object Promise]')
    );
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

  it('renders RalphForm synchronously the first time it is opened', () => {
    ralphStore.setShowRalphForm(true);

    mountAppRoot();

    expect(container?.textContent).toContain('Ralph Form');
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

  it('shows transient warnings with warning semantics', () => {
    vi.useFakeTimers();
    setState('serverStatus', { state: 'running', url: 'http://127.0.0.1:4096' });
    setConnectionInitialized(true);
    mountAppRoot();

    showSessionActionFeedback('This image is already attached', 'warning');

    const warningToast = document.body.querySelector<HTMLElement>('.session-action-feedback');
    expect(warningToast?.textContent).toContain('This image is already attached');
    expect(warningToast?.classList.contains('is-warning')).toBe(true);
    expect(warningToast?.getAttribute('role')).toBe('status');
    expect(warningToast?.getAttribute('aria-live')).toBe('polite');
    expect(
      warningToast?.querySelector('.session-action-feedback-attention-glyph')?.textContent
    ).toBe('!');
    expect(warningToast?.querySelector('.session-action-feedback-glyph')).toBeNull();

    vi.advanceTimersByTime(1_600);
    expect(document.body.querySelector('.session-action-feedback')).not.toBeNull();

    vi.advanceTimersByTime(3_400);
    expect(warningToast?.classList.contains('is-leaving')).toBe(true);

    vi.advanceTimersByTime(160);
    expect(document.body.querySelector('.session-action-feedback')).toBeNull();
  });

  it('clears the retry action whenever the error changes', () => {
    setErrorRetry(vi.fn());
    expect(errorRetry()).not.toBeNull();

    setError('another failure');
    expect(errorRetry()).toBeNull();
  });
});
