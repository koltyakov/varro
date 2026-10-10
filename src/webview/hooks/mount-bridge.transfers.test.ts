import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { createMountBridgeOperations } from './mount-bridge';
import { appStore } from '../lib/stores/app-store';
import { uiStore } from '../lib/stores/ui-store';
import { composerStore } from '../lib/stores/composer-store';

function createOperations() {
  const openSession = vi.fn();
  const reloadSessionCatalog = vi.fn(async () => {});
  const operations = createMountBridgeOperations({
    ensureConnectionInitialized: vi.fn(),
    getServerState: () => 'running',
    invalidateConnection: vi.fn(),
    getCurrentWorkspacePath: () => '/repo',
    setCurrentWorkspacePath: vi.fn(),
    resetWorkspaceForChange: vi.fn(),
    reloadWorkspaceAfterChange: vi.fn(),
    isInitialized: () => true,
    createSession: vi.fn(),
    openSession,
    reloadSessionCatalog,
    abortSession: vi.fn(),
    refreshMcps: vi.fn(),
    refreshProviders: vi.fn(),
    applyTheme: vi.fn(),
  });
  return { operations, openSession, reloadSessionCatalog };
}

afterEach(() => {
  appStore.setState('activeSessionId', null);
  appStore.setState('transferredSessions', reconcile({}));
  appStore.setState('messagesLoading', false);
  composerStore.setInputText('');
  uiStore.stopLoading();
  uiStore.setError(null);
});

describe('session transfer bridge', () => {
  it('keeps the active transcript and draft when the destination is not open', () => {
    const { operations, openSession, reloadSessionCatalog } = createOperations();
    appStore.setState('activeSessionId', 'session-1');
    appStore.setState('messagesLoading', true);
    composerStore.setInputText('Unsent draft');
    uiStore.startLoading();
    const messages = appStore.state.messages;
    operations.handleExtensionMessage({
      type: 'session/transferred',
      payload: { sessionId: 'session-1', directory: '/outside', available: false },
    });
    expect(appStore.state.activeSessionId).toBe('session-1');
    expect(appStore.state.messages).toBe(messages);
    expect(composerStore.inputText()).toBe('Unsent draft');
    expect(appStore.state.transferredSessions['session-1']).toBe('/outside');
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1', '/outside', true);
    expect(reloadSessionCatalog).not.toHaveBeenCalled();
  });

  it('follows the same active session when its destination becomes available', () => {
    const { operations, openSession } = createOperations();
    appStore.setState('activeSessionId', 'session-1');
    appStore.setState('transferredSessions', { 'session-1': '/outside' });
    operations.handleExtensionMessage({
      type: 'session/transferred',
      payload: { sessionId: 'session-1', directory: '/other', available: true },
    });
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1', '/other', true);
    expect(appStore.state.transferredSessions['session-1']).toBeUndefined();
    expect(appStore.state.activeSessionId).toBe('session-1');
  });

  it('refreshes an inactive moved session without stealing the selected conversation', () => {
    const { operations, openSession, reloadSessionCatalog } = createOperations();
    appStore.setState('activeSessionId', 'selected');
    operations.handleExtensionMessage({
      type: 'session/transferred',
      payload: { sessionId: 'background', directory: '/other', available: true },
    });
    expect(appStore.state.activeSessionId).toBe('selected');
    expect(openSession).not.toHaveBeenCalled();
    expect(reloadSessionCatalog).toHaveBeenCalledOnce();
  });
});
