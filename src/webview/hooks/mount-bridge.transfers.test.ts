import { flush as flushSolid, reconcile } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  appStore.setState(storePath('sessions', []));
  flushSolid();
  appStore.setState(storePath('activeSessionId', null));
  flushSolid();
  appStore.setState((draft) => {
    const current = draft['transferredSessions'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['transferredSessions'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  appStore.setState(storePath('messagesLoading', false));
  flushSolid();
  composerStore.setInputText('');
  flushSolid();
  uiStore.stopLoading();
  flushSolid();
  uiStore.setError(null);
  flushSolid();
});

describe('session transfer bridge', () => {
  it('refreshes location metadata after an active move without clearing the transcript', () => {
    const { operations, openSession, reloadSessionCatalog } = createOperations();
    appStore.setState(
      storePath('sessions', [
        {
          id: 'session-1',
          projectID: 'project-1',
          title: 'Active chat',
          version: '2',
          directory: '/repo',
          isGitWorktree: false,
          time: { created: 1, updated: 2 },
        },
      ])
    );
    flushSolid();
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();

    operations.handleExtensionMessage({
      type: 'session/transferred',
      payload: { sessionId: 'session-1', directory: '/worktrees/feature', available: true },
    });
    flushSolid();

    expect(appStore.state.sessions[0]?.directory).toBe('/worktrees/feature');
    expect(appStore.state.sessions[0]?.transfer).toEqual({
      originDirectory: '/repo',
      available: true,
    });
    expect(appStore.state.sessions[0]?.isGitWorktree).toBeUndefined();
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1', '/worktrees/feature', true);
    expect(reloadSessionCatalog).toHaveBeenCalledOnce();
  });

  it('clears stale worktree metadata immediately when the chat returns to its origin', () => {
    const { operations, openSession } = createOperations();
    appStore.setState(
      storePath('sessions', [
        {
          id: 'session-1',
          projectID: 'project-1',
          title: 'Worktree chat',
          version: '2',
          directory: '/worktrees/feature',
          isGitWorktree: true,
          time: { created: 1, updated: 2 },
          transfer: { originDirectory: '/repo', available: true },
        },
      ])
    );
    flushSolid();
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    composerStore.setInputText('Keep this draft');
    flushSolid();
    const messages = appStore.state.messages;
    openSession.mockImplementation(() => {
      flushSolid();
      expect(appStore.state.sessions[0]?.directory).toBe('/repo');
      expect(appStore.state.sessions[0]?.isGitWorktree).toBeUndefined();
    });
    operations.handleExtensionMessage({
      type: 'session/transferred',
      payload: { sessionId: 'session-1', directory: '/repo', available: true },
    });
    expect(appStore.state.sessions[0]?.isGitWorktree).toBeUndefined();
    expect(appStore.state.sessions[0]?.transfer).toEqual({
      originDirectory: '/repo',
      available: true,
    });
    expect(appStore.state.messages).toBe(messages);
    expect(composerStore.inputText()).toBe('Keep this draft');
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1', '/repo', true);
  });

  it('keeps verified worktree metadata for a same-directory availability refresh', () => {
    const { operations } = createOperations();
    appStore.setState(
      storePath('sessions', [
        {
          id: 'session-1',
          projectID: 'project-1',
          title: 'Worktree chat',
          version: '2',
          directory: '/worktrees/feature',
          isGitWorktree: true,
          time: { created: 1, updated: 2 },
          transfer: { originDirectory: '/repo', available: false },
        },
      ])
    );
    flushSolid();
    operations.handleExtensionMessage({
      type: 'session/transferred',
      payload: { sessionId: 'session-1', directory: '/worktrees/feature', available: true },
    });
    flushSolid();
    expect(appStore.state.sessions[0]?.isGitWorktree).toBe(true);
  });

  it('keeps the active transcript and draft when the destination is not open', () => {
    const { operations, openSession, reloadSessionCatalog } = createOperations();
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(storePath('messagesLoading', true));
    flushSolid();
    composerStore.setInputText('Unsent draft');
    flushSolid();
    uiStore.startLoading();
    flushSolid();
    const messages = appStore.state.messages;
    operations.handleExtensionMessage({
      type: 'session/transferred',
      payload: { sessionId: 'session-1', directory: '/outside', available: false },
    });
    flushSolid();
    expect(appStore.state.activeSessionId).toBe('session-1');
    expect(appStore.state.messages).toBe(messages);
    expect(composerStore.inputText()).toBe('Unsent draft');
    expect(appStore.state.transferredSessions['session-1']).toBe('/outside');
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1', '/outside', true);
    expect(reloadSessionCatalog).toHaveBeenCalledOnce();
  });

  it('follows the same active session into a verified worktree when its destination becomes available', () => {
    const { operations, openSession } = createOperations();
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(storePath('transferredSessions', { 'session-1': '/outside' }));
    flushSolid();
    operations.handleExtensionMessage({
      type: 'session/transferred',
      payload: { sessionId: 'session-1', directory: '/worktrees/feature', available: true },
    });
    flushSolid();
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1', '/worktrees/feature', true);
    expect(appStore.state.transferredSessions['session-1']).toBeUndefined();
    expect(appStore.state.activeSessionId).toBe('session-1');
  });

  it('refreshes an inactive moved session without stealing the selected conversation', () => {
    const { operations, openSession, reloadSessionCatalog } = createOperations();
    appStore.setState(storePath('activeSessionId', 'selected'));
    flushSolid();
    operations.handleExtensionMessage({
      type: 'session/transferred',
      payload: { sessionId: 'background', directory: '/other', available: true },
    });
    flushSolid();
    expect(appStore.state.activeSessionId).toBe('selected');
    expect(openSession).not.toHaveBeenCalled();
    expect(reloadSessionCatalog).toHaveBeenCalledOnce();
  });
});
