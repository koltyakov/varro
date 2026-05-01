import { describe, expect, it, vi } from 'vitest';
import type { ExtensionMessage } from '../../shared/protocol';
import type { MockedObject } from 'vitest';
import type * as StateModule from '../lib/state';

const {
  setState,
  setError,
  setTheme,
  addContextFiles,
  removeContextFile,
  requestComposerFocus,
  requestOpenAttentionSessions,
  setRecycleBinEntries,
  rememberCurrentDocumentNavigation,
  syncDraftPermissionForWorkspace,
  syncSessionMarkersForWorkspace,
  setExpandThinkingByDefaultPreference,
  setShowStickyUserPromptPreference,
  setDesktopSessionPaneSide,
  setProviderLimitThresholdPercent,
} = vi.hoisted(() => ({
  setState: vi.fn(),
  setError: vi.fn(),
  setTheme: vi.fn(),
  addContextFiles: vi.fn(),
  removeContextFile: vi.fn(),
  requestComposerFocus: vi.fn(),
  requestOpenAttentionSessions: vi.fn(),
  setRecycleBinEntries: vi.fn(),
  rememberCurrentDocumentNavigation: vi.fn(),
  syncDraftPermissionForWorkspace: vi.fn(),
  syncSessionMarkersForWorkspace: vi.fn(),
  setExpandThinkingByDefaultPreference: vi.fn(),
  setShowStickyUserPromptPreference: vi.fn(),
  setDesktopSessionPaneSide: vi.fn(),
  setProviderLimitThresholdPercent: vi.fn(),
}));

vi.mock('../lib/state', async () => {
  const actual = (await vi.importActual('../lib/state')) as MockedObject<typeof StateModule>;
  return {
    ...actual,
    state: {
      ...actual.state,
      editorContext: { ...actual.state.editorContext, activeFile: null },
    },
    setState,
    setError,
    setTheme,
    addContextFiles,
    removeContextFile,
    requestComposerFocus,
    requestOpenAttentionSessions,
    setRecycleBinEntries,
    rememberCurrentDocumentNavigation,
    syncDraftPermissionForWorkspace,
    syncSessionMarkersForWorkspace,
    setExpandThinkingByDefaultPreference,
    setShowStickyUserPromptPreference,
    setDesktopSessionPaneSide,
    setProviderLimitThresholdPercent,
  };
});

import {
  createMountBridgeOperations,
  handleExtensionMessageWithDependencies,
  postFocusStateWithDependencies,
  registerFocusStateTracking,
} from './mount-bridge';

describe('mount bridge helpers', () => {
  it('starts connection initialization when server status becomes running', () => {
    const setServerStatus = vi.fn();
    const clearError = vi.fn();
    const ensureConnectionInitialized = vi.fn();

    handleExtensionMessageWithDependencies(
      {
        setServerStatus,
        clearError,
        ensureConnectionInitialized,
        clearProvidersState: vi.fn(),
        setTheme: vi.fn(),
        setConfig: vi.fn(),
        getPreviousActiveFilePath: () => null,
        getCurrentWorkspacePath: () => null,
        setCurrentWorkspacePath: vi.fn(),
        setEditorContext: vi.fn(),
        rememberCurrentDocumentNavigation: vi.fn(),
        syncWorkspaceState: vi.fn(),
        reloadSessionsForWorkspaceChange: vi.fn(),
        isInitialized: () => false,
        setTerminalSelection: vi.fn(),
        addContextFiles: vi.fn(),
        removeContextFile: vi.fn(),
        createSession: vi.fn(),
        requestComposerFocus: vi.fn(),
        requestOpenAttentionSessions: vi.fn(),
        abortSession: vi.fn(),
        refreshMcps: vi.fn(),
      },
      {
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      }
    );

    expect(setServerStatus).toHaveBeenCalledWith({
      state: 'running',
      url: 'http://127.0.0.1:4096',
    });
    expect(clearError).toHaveBeenCalledTimes(1);
    expect(ensureConnectionInitialized).toHaveBeenCalledTimes(1);
  });

  it('clears provider state when server status leaves running', () => {
    const clearProvidersState = vi.fn();
    const clearError = vi.fn();

    handleExtensionMessageWithDependencies(
      {
        setServerStatus: vi.fn(),
        clearError,
        ensureConnectionInitialized: vi.fn(),
        clearProvidersState,
        setTheme: vi.fn(),
        setConfig: vi.fn(),
        getPreviousActiveFilePath: () => null,
        getCurrentWorkspacePath: () => null,
        setCurrentWorkspacePath: vi.fn(),
        setEditorContext: vi.fn(),
        rememberCurrentDocumentNavigation: vi.fn(),
        syncWorkspaceState: vi.fn(),
        reloadSessionsForWorkspaceChange: vi.fn(),
        isInitialized: () => false,
        setTerminalSelection: vi.fn(),
        addContextFiles: vi.fn(),
        removeContextFile: vi.fn(),
        createSession: vi.fn(),
        requestComposerFocus: vi.fn(),
        requestOpenAttentionSessions: vi.fn(),
        abortSession: vi.fn(),
        refreshMcps: vi.fn(),
      },
      {
        type: 'server/status',
        payload: { state: 'stopped' },
      }
    );

    expect(clearProvidersState).toHaveBeenCalledTimes(1);
    expect(clearError).toHaveBeenCalledTimes(1);
  });

  it('syncs workspace state and reloads sessions after a context workspace change', () => {
    const setCurrentWorkspacePath = vi.fn();
    const setEditorContext = vi.fn();
    const rememberNavigation = vi.fn();
    const syncWorkspaceState = vi.fn();
    const reloadSessionsForWorkspaceChange = vi.fn();
    const payload: Extract<ExtensionMessage, { type: 'context/update' }>['payload'] = {
      workspacePath: '/repo-next/',
      activeFile: { path: '/repo-next/src/app.ts', relativePath: 'src/app.ts', language: 'ts' },
      selection: null,
      diagnostics: [],
    };

    handleExtensionMessageWithDependencies(
      {
        setServerStatus: vi.fn(),
        clearError: vi.fn(),
        ensureConnectionInitialized: vi.fn(),
        clearProvidersState: vi.fn(),
        setTheme: vi.fn(),
        setConfig: vi.fn(),
        getPreviousActiveFilePath: () => '/repo/src/old.ts',
        getCurrentWorkspacePath: () => '/repo',
        setCurrentWorkspacePath,
        setEditorContext,
        rememberCurrentDocumentNavigation: rememberNavigation,
        syncWorkspaceState,
        reloadSessionsForWorkspaceChange,
        isInitialized: () => true,
        setTerminalSelection: vi.fn(),
        addContextFiles: vi.fn(),
        removeContextFile: vi.fn(),
        createSession: vi.fn(),
        requestComposerFocus: vi.fn(),
        requestOpenAttentionSessions: vi.fn(),
        abortSession: vi.fn(),
        refreshMcps: vi.fn(),
      },
      {
        type: 'context/update',
        payload,
      }
    );

    expect(setCurrentWorkspacePath).toHaveBeenCalledWith('/repo-next');
    expect(setEditorContext).toHaveBeenCalledWith(payload);
    expect(rememberNavigation).toHaveBeenCalledWith('/repo/src/old.ts', '/repo-next/src/app.ts');
    expect(syncWorkspaceState).toHaveBeenCalledWith('/repo-next');
    expect(reloadSessionsForWorkspaceChange).toHaveBeenCalledTimes(1);
  });

  it('routes command and server-event messages to the expected actions', () => {
    const createSession = vi.fn();
    const focusComposer = vi.fn();
    const openAttentionSessions = vi.fn();
    const abortSession = vi.fn();
    const refreshMcps = vi.fn();
    const addDroppedContextFiles = vi.fn();
    const removeDroppedContextFile = vi.fn();
    const deps = {
      setServerStatus: vi.fn(),
      clearError: vi.fn(),
      ensureConnectionInitialized: vi.fn(),
      clearProvidersState: vi.fn(),
      setTheme: vi.fn(),
      setConfig: vi.fn(),
      getPreviousActiveFilePath: () => null,
      getCurrentWorkspacePath: () => null,
      setCurrentWorkspacePath: vi.fn(),
      setEditorContext: vi.fn(),
      rememberCurrentDocumentNavigation: vi.fn(),
      syncWorkspaceState: vi.fn(),
      reloadSessionsForWorkspaceChange: vi.fn(),
      isInitialized: () => false,
      setTerminalSelection: vi.fn(),
      addContextFiles: addDroppedContextFiles,
      removeContextFile: removeDroppedContextFile,
      createSession,
      requestComposerFocus: focusComposer,
      requestOpenAttentionSessions: openAttentionSessions,
      abortSession,
      refreshMcps,
    };

    handleExtensionMessageWithDependencies(deps, { type: 'command/new-session' });
    handleExtensionMessageWithDependencies(deps, { type: 'command/focus-input' });
    handleExtensionMessageWithDependencies(deps, { type: 'command/open-attention-sessions' });
    handleExtensionMessageWithDependencies(deps, { type: 'command/abort' });
    handleExtensionMessageWithDependencies(deps, {
      type: 'files/dropped',
      payload: [{ path: '/repo/file.ts', relativePath: 'file.ts', type: 'file' }],
    });
    handleExtensionMessageWithDependencies(deps, {
      type: 'files/removed',
      payload: { path: '/repo/file.ts' },
    });
    handleExtensionMessageWithDependencies(deps, {
      type: 'server/event',
      payload: { type: 'mcp.tools.changed', properties: {} },
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(focusComposer).toHaveBeenCalledTimes(1);
    expect(openAttentionSessions).toHaveBeenCalledTimes(1);
    expect(abortSession).toHaveBeenCalledTimes(1);
    expect(addDroppedContextFiles).toHaveBeenCalledTimes(1);
    expect(removeDroppedContextFile).toHaveBeenCalledWith('/repo/file.ts');
    expect(refreshMcps).toHaveBeenCalledTimes(1);
  });

  it('binds extension message handling to shared webview state', () => {
    const ensureConnectionInitialized = vi.fn();
    const applyTheme = vi.fn();
    const operations = createMountBridgeOperations({
      ensureConnectionInitialized,
      getCurrentWorkspacePath: () => null,
      setCurrentWorkspacePath: vi.fn(),
      reloadSessionsForWorkspaceChange: vi.fn(),
      isInitialized: () => false,
      createSession: vi.fn(),
      abortSession: vi.fn(),
      refreshMcps: vi.fn(),
      applyTheme,
    });

    operations.handleExtensionMessage({
      type: 'theme/update',
      payload: { theme: 'light' },
    });
    operations.handleExtensionMessage({
      type: 'server/status',
      payload: { state: 'running', url: 'http://127.0.0.1:4096' },
    });
    operations.handleExtensionMessage({
      type: 'config/update',
      payload: {
        expandThinkingByDefault: true,
        showStickyUserPrompt: true,
        desktopSessionPaneSide: 'right',
        providerLimitsDisabled: false,
        providerLimitThresholdPercent: 25,
      },
    });

    expect(setTheme).toHaveBeenCalledWith('light');
    expect(applyTheme).toHaveBeenCalledWith('light');
    expect(setState).toHaveBeenCalledWith('serverStatus', {
      state: 'running',
      url: 'http://127.0.0.1:4096',
    });
    expect(setError).toHaveBeenCalledWith(null);
    expect(ensureConnectionInitialized).toHaveBeenCalledTimes(1);
    expect(setProviderLimitThresholdPercent).toHaveBeenCalledWith(25);
  });

  it('posts focus state based on visibility and document focus', () => {
    const sendMessage = vi.fn();

    postFocusStateWithDependencies({
      sendMessage,
      isVisible: () => true,
      hasFocus: () => false,
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'webview/focus',
      payload: { focused: false },
    });
  });

  it('tracks focus and visibility changes and rechecks loading sessions when visible again', () => {
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    const setDocumentVisible = vi.fn();
    const postFocusState = vi.fn();
    const recheckSessionStatus = vi.fn();

    const dispose = registerFocusStateTracking({
      setDocumentVisible,
      postFocusState,
      isLoading: () => true,
      getActiveSessionId: () => 'session-1',
      recheckSessionStatus,
    });

    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('blur'));

      expect(setDocumentVisible).toHaveBeenCalledWith(true);
      expect(postFocusState).toHaveBeenCalledTimes(3);
      expect(recheckSessionStatus).toHaveBeenCalledWith('session-1');
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
    }
  });
});
