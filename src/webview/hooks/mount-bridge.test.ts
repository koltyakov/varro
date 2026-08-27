import { describe, expect, it, vi } from 'vitest';
import type {
  ExtensionMessage,
  WebviewMessage,
  WorkspaceStatusEventSummary,
} from '../../shared/protocol';
import type { MockedObject } from 'vitest';
import type * as StateModule from '../lib/state';
import { sessionStore } from '../lib/stores/session-store';

const {
  setState,
  setError,
  setTheme,
  addContextFiles,
  removeContextFile,
  requestComposerFocus,
  requestOpenAttentionSessions,
  requestOpenCompletedSessions,
  setRecycleBinEntries,
  rememberCurrentDocumentNavigation,
  syncDraftPermissionForWorkspace,
  syncSessionMarkersForWorkspace,
  setShowFileDiffs,
  setExpandThinking,
  setShowChangedFiles,
  setDesktopSessionPaneSide,
  setDefaultPermissionModePreference,
  setWorkspaceStatusSummary,
  setWorkspaceStatuses,
  applyModelPreferencesSnapshot,
  applySessionSelectedAgentUpdate,
  applySessionPlanStateUpdate,
} = vi.hoisted(() => ({
  setState: vi.fn(),
  setError: vi.fn(),
  setTheme: vi.fn(),
  addContextFiles: vi.fn(),
  removeContextFile: vi.fn(),
  requestComposerFocus: vi.fn(),
  requestOpenAttentionSessions: vi.fn(),
  requestOpenCompletedSessions: vi.fn(),
  setRecycleBinEntries: vi.fn(),
  rememberCurrentDocumentNavigation: vi.fn(),
  syncDraftPermissionForWorkspace: vi.fn(),
  syncSessionMarkersForWorkspace: vi.fn(),
  setShowFileDiffs: vi.fn(),
  setExpandThinking: vi.fn(),
  setShowChangedFiles: vi.fn(),
  setDesktopSessionPaneSide: vi.fn(),
  setDefaultPermissionModePreference: vi.fn(),
  setWorkspaceStatusSummary: vi.fn(),
  setWorkspaceStatuses: vi.fn(),
  applyModelPreferencesSnapshot: vi.fn(),
  applySessionSelectedAgentUpdate: vi.fn(),
  applySessionPlanStateUpdate: vi.fn(),
}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise mount-bridge integration with state and client modules. */
vi.mock('../lib/state', async () => {
  // SAFETY: The test installs the typed mock implementation before this statement.
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
    requestOpenCompletedSessions,
    setRecycleBinEntries,
    rememberCurrentDocumentNavigation,
    syncDraftPermissionForWorkspace,
    syncSessionMarkersForWorkspace,
    setShowFileDiffs,
    setExpandThinking,
    setShowChangedFiles,
    setDesktopSessionPaneSide,
    setDefaultPermissionModePreference,
    applyModelPreferencesSnapshot,
    applySessionSelectedAgentUpdate,
    applySessionPlanStateUpdate,
  };
});

const getWorkspaceStatusEventSummaryMock = vi.hoisted(() =>
  vi.fn<() => WorkspaceStatusEventSummary>(() => ({ entries: [], latest: undefined }))
);

import {
  createMountBridgeOperations,
  handleExtensionMessageWithDependencies,
  postFocusStateWithDependencies,
  registerFocusStateTracking,
} from './mount-bridge';

vi.mock('../lib/client', () => ({
  getWorkspaceStatusEventSummary: getWorkspaceStatusEventSummaryMock,
}));

type MessageDependencies = Parameters<typeof handleExtensionMessageWithDependencies>[0];

function createMessageDependencies(
  overrides: Partial<MessageDependencies> = {}
): MessageDependencies {
  return {
    setServerStatus: vi.fn(),
    clearError: vi.fn(),
    ensureConnectionInitialized: vi.fn(),
    getServerState: () => 'stopped',
    invalidateConnection: vi.fn(),
    clearProvidersState: vi.fn(),
    setTheme: vi.fn(),
    setConfig: vi.fn(),
    getPreviousActiveFilePath: () => null,
    getCurrentWorkspacePath: () => null,
    setCurrentWorkspacePath: vi.fn(),
    setEditorContext: vi.fn(),
    rememberCurrentDocumentNavigation: vi.fn(),
    syncWorkspaceState: vi.fn(),
    resetWorkspaceForChange: vi.fn(),
    reloadWorkspaceAfterChange: vi.fn(),
    isInitialized: () => false,
    setTerminalSelection: vi.fn(),
    addContextFiles: vi.fn(),
    removeContextFile: vi.fn(),
    createSession: vi.fn(),
    requestComposerFocus: vi.fn(),
    requestOpenAttentionSessions: vi.fn(),
    requestOpenCompletedSessions: vi.fn(),
    abortSession: vi.fn(),
    refreshMcps: vi.fn(),
    refreshProviders: vi.fn(),
    setWorkspaceStatusSummary: vi.fn(),
    setWorkspaceStatuses: vi.fn(),
    ...overrides,
  };
}

describe('mount bridge helpers', () => {
  it('applies sibling workspace alert snapshots', () => {
    const setSiblingWorkspaceAlerts = vi.fn();
    const alerts = [{ name: 'Repo B', path: '/repo-b', kinds: ['attention' as const], count: 1 }];

    handleExtensionMessageWithDependencies(
      createMessageDependencies({ setSiblingWorkspaceAlerts }),
      { type: 'sibling-workspace-alerts/update', payload: alerts }
    );

    expect(setSiblingWorkspaceAlerts).toHaveBeenCalledWith(alerts);
  });

  it('applies host model preferences to the current webview', () => {
    const preferences = {
      modelVariantSelections: {},
      hiddenProviders: [],
      hiddenModels: [],
      addedModels: [],
      pinnedModels: ['openai:gpt-5.6-sol'],
      modelDisplayNames: {},
    };

    handleExtensionMessageWithDependencies(createMessageDependencies(), {
      type: 'model-preferences/sync',
      payload: preferences,
    });

    expect(applyModelPreferencesSnapshot).toHaveBeenCalledWith(preferences);
  });

  it('reprocesses pending permissions after a host permission-mode snapshot', () => {
    const permissionModesSynced = vi.fn();

    handleExtensionMessageWithDependencies(createMessageDependencies({ permissionModesSynced }), {
      type: 'permission-modes/sync',
      payload: { modes: { 'session-1': 'full' } },
    });

    expect(permissionModesSynced).toHaveBeenCalledOnce();
  });

  it('applies plan state resolved in another webview', () => {
    handleExtensionMessageWithDependencies(createMessageDependencies(), {
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', skippedAt: 200, agent: 'build' },
    });

    expect(applySessionPlanStateUpdate).toHaveBeenCalledWith('session-1', 200);
    expect(applySessionSelectedAgentUpdate).toHaveBeenCalledWith('session-1', 'build');
  });

  it('replays persisted agent selections when a webview becomes ready', () => {
    handleExtensionMessageWithDependencies(createMessageDependencies(), {
      type: 'session-plan-state/sync',
      payload: { state: {}, agents: { 'session-1': 'build' } },
    });

    expect(applySessionSelectedAgentUpdate).toHaveBeenCalledWith('session-1', 'build');
  });

  it('queues interrupted recovery without acknowledging volatile receipt', () => {
    const queueInterruptedSessionRecovery = vi.fn();
    // SAFETY: The webview bootstrap installs this optional typed host bridge on Window.
    const bridgeWindow = window as Window & {
      __sendToExtension?: (message: WebviewMessage) => void;
    };
    const originalSend = bridgeWindow.__sendToExtension;
    const sendToExtension = vi.fn();
    bridgeWindow.__sendToExtension = sendToExtension;
    try {
      handleExtensionMessageWithDependencies(
        createMessageDependencies({
          queueInterruptedSessionRecovery,
        }),
        {
          type: 'recovery/interrupted-sessions',
          payload: { claimId: 4, sessionIds: ['session-1'] },
        }
      );
    } finally {
      if (originalSend) bridgeWindow.__sendToExtension = originalSend;
      else delete bridgeWindow.__sendToExtension;
    }

    expect(queueInterruptedSessionRecovery).toHaveBeenCalledWith(4, ['session-1']);
    expect(sendToExtension).not.toHaveBeenCalled();
  });

  it('starts connection initialization when server status becomes running', () => {
    const setServerStatus = vi.fn();
    const clearError = vi.fn();
    const ensureConnectionInitialized = vi.fn();

    handleExtensionMessageWithDependencies(
      {
        setServerStatus,
        clearError,
        ensureConnectionInitialized,
        getServerState: () => 'stopped',
        invalidateConnection: vi.fn(),
        clearProvidersState: vi.fn(),
        setTheme: vi.fn(),
        setConfig: vi.fn(),
        getPreviousActiveFilePath: () => null,
        getCurrentWorkspacePath: () => null,
        setCurrentWorkspacePath: vi.fn(),
        setEditorContext: vi.fn(),
        rememberCurrentDocumentNavigation: vi.fn(),
        syncWorkspaceState: vi.fn(),
        resetWorkspaceForChange: vi.fn(),
        reloadWorkspaceAfterChange: vi.fn(),
        isInitialized: () => false,
        setTerminalSelection: vi.fn(),
        addContextFiles: vi.fn(),
        removeContextFile: vi.fn(),
        createSession: vi.fn(),
        requestComposerFocus: vi.fn(),
        requestOpenAttentionSessions: vi.fn(),
        requestOpenCompletedSessions: vi.fn(),
        abortSession: vi.fn(),
        refreshMcps: vi.fn(),
        refreshProviders: vi.fn(),
        setWorkspaceStatusSummary: vi.fn(),
        setWorkspaceStatuses: vi.fn(),
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

  it('invalidates a stopped connection and initializes again after restart', () => {
    const clearProvidersState = vi.fn();
    const clearError = vi.fn();
    const invalidateConnection = vi.fn();
    const ensureConnectionInitialized = vi.fn();
    let serverState: Extract<ExtensionMessage, { type: 'server/status' }>['payload']['state'] =
      'running';
    const setServerStatus = vi.fn(
      (payload: Extract<ExtensionMessage, { type: 'server/status' }>['payload']) => {
        serverState = payload.state;
      }
    );
    const deps = {
      setServerStatus,
      clearError,
      ensureConnectionInitialized,
      getServerState: () => serverState,
      invalidateConnection,
      clearProvidersState,
      setTheme: vi.fn(),
      setConfig: vi.fn(),
      getPreviousActiveFilePath: () => null,
      getCurrentWorkspacePath: () => null,
      setCurrentWorkspacePath: vi.fn(),
      setEditorContext: vi.fn(),
      rememberCurrentDocumentNavigation: vi.fn(),
      syncWorkspaceState: vi.fn(),
      resetWorkspaceForChange: vi.fn(),
      reloadWorkspaceAfterChange: vi.fn(),
      isInitialized: () => false,
      setTerminalSelection: vi.fn(),
      addContextFiles: vi.fn(),
      removeContextFile: vi.fn(),
      createSession: vi.fn(),
      requestComposerFocus: vi.fn(),
      requestOpenAttentionSessions: vi.fn(),
      requestOpenCompletedSessions: vi.fn(),
      abortSession: vi.fn(),
      refreshMcps: vi.fn(),
      refreshProviders: vi.fn(),
      setWorkspaceStatusSummary: vi.fn(),
      setWorkspaceStatuses: vi.fn(),
    };

    handleExtensionMessageWithDependencies(deps, {
      type: 'server/status',
      payload: { state: 'stopped' },
    });

    expect(clearProvidersState).toHaveBeenCalledTimes(1);
    expect(clearError).toHaveBeenCalledTimes(1);
    expect(invalidateConnection).toHaveBeenCalledTimes(1);

    handleExtensionMessageWithDependencies(deps, {
      type: 'server/status',
      payload: { state: 'running', url: 'http://127.0.0.1:4096' },
    });

    expect(ensureConnectionInitialized).toHaveBeenCalledTimes(1);
  });

  it('resets workspace state before reconciling a context workspace change', () => {
    const setCurrentWorkspacePath = vi.fn();
    const setEditorContext = vi.fn();
    const rememberNavigation = vi.fn();
    const syncWorkspaceState = vi.fn();
    const resetWorkspaceForChange = vi.fn();
    const reloadWorkspaceAfterChange = vi.fn();
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
        getServerState: () => 'running',
        invalidateConnection: vi.fn(),
        clearProvidersState: vi.fn(),
        setTheme: vi.fn(),
        setConfig: vi.fn(),
        getPreviousActiveFilePath: () => '/repo/src/old.ts',
        getCurrentWorkspacePath: () => '/repo',
        setCurrentWorkspacePath,
        setEditorContext,
        rememberCurrentDocumentNavigation: rememberNavigation,
        syncWorkspaceState,
        resetWorkspaceForChange,
        reloadWorkspaceAfterChange,
        isInitialized: () => true,
        setTerminalSelection: vi.fn(),
        addContextFiles: vi.fn(),
        removeContextFile: vi.fn(),
        createSession: vi.fn(),
        requestComposerFocus: vi.fn(),
        requestOpenAttentionSessions: vi.fn(),
        requestOpenCompletedSessions: vi.fn(),
        abortSession: vi.fn(),
        refreshMcps: vi.fn(),
        refreshProviders: vi.fn(),
        setWorkspaceStatusSummary: vi.fn(),
        setWorkspaceStatuses: vi.fn(),
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
    expect(syncWorkspaceState.mock.invocationCallOrder[0]).toBeLessThan(
      rememberNavigation.mock.invocationCallOrder[0] ?? Infinity
    );
    expect(resetWorkspaceForChange).toHaveBeenCalledTimes(1);
    expect(reloadWorkspaceAfterChange).toHaveBeenCalledWith(true);
    expect(syncWorkspaceState.mock.invocationCallOrder[0]).toBeLessThan(
      resetWorkspaceForChange.mock.invocationCallOrder[0] ?? Infinity
    );
    expect(resetWorkspaceForChange.mock.invocationCallOrder[0]).toBeLessThan(
      reloadWorkspaceAfterChange.mock.invocationCallOrder[0] ?? Infinity
    );
  });

  it('treats the first context update as a seed without resetting workspace state', () => {
    const syncWorkspaceState = vi.fn();
    const resetWorkspaceForChange = vi.fn();
    const reloadWorkspaceAfterChange = vi.fn();

    handleExtensionMessageWithDependencies(
      {
        setServerStatus: vi.fn(),
        clearError: vi.fn(),
        ensureConnectionInitialized: vi.fn(),
        getServerState: () => 'running',
        invalidateConnection: vi.fn(),
        clearProvidersState: vi.fn(),
        setTheme: vi.fn(),
        setConfig: vi.fn(),
        getPreviousActiveFilePath: () => null,
        getCurrentWorkspacePath: () => undefined,
        setCurrentWorkspacePath: vi.fn(),
        setEditorContext: vi.fn(),
        rememberCurrentDocumentNavigation: vi.fn(),
        syncWorkspaceState,
        resetWorkspaceForChange,
        reloadWorkspaceAfterChange,
        isInitialized: () => false,
        setTerminalSelection: vi.fn(),
        addContextFiles: vi.fn(),
        removeContextFile: vi.fn(),
        createSession: vi.fn(),
        requestComposerFocus: vi.fn(),
        requestOpenAttentionSessions: vi.fn(),
        requestOpenCompletedSessions: vi.fn(),
        abortSession: vi.fn(),
        refreshMcps: vi.fn(),
        refreshProviders: vi.fn(),
        setWorkspaceStatusSummary: vi.fn(),
        setWorkspaceStatuses: vi.fn(),
      },
      {
        type: 'context/update',
        payload: {
          workspacePath: '/repo',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      }
    );

    expect(syncWorkspaceState).toHaveBeenCalledWith('/repo');
    expect(resetWorkspaceForChange).not.toHaveBeenCalled();
    expect(reloadWorkspaceAfterChange).not.toHaveBeenCalled();
  });

  it('resets and schedules fresh initialization when context changes during initialization', () => {
    const resetWorkspaceForChange = vi.fn();
    const reloadWorkspaceAfterChange = vi.fn();

    handleExtensionMessageWithDependencies(
      {
        setServerStatus: vi.fn(),
        clearError: vi.fn(),
        ensureConnectionInitialized: vi.fn(),
        getServerState: () => 'running',
        invalidateConnection: vi.fn(),
        clearProvidersState: vi.fn(),
        setTheme: vi.fn(),
        setConfig: vi.fn(),
        getPreviousActiveFilePath: () => null,
        getCurrentWorkspacePath: () => '/repo-old',
        setCurrentWorkspacePath: vi.fn(),
        setEditorContext: vi.fn(),
        rememberCurrentDocumentNavigation: vi.fn(),
        syncWorkspaceState: vi.fn(),
        resetWorkspaceForChange,
        reloadWorkspaceAfterChange,
        isInitialized: () => false,
        setTerminalSelection: vi.fn(),
        addContextFiles: vi.fn(),
        removeContextFile: vi.fn(),
        createSession: vi.fn(),
        requestComposerFocus: vi.fn(),
        requestOpenAttentionSessions: vi.fn(),
        requestOpenCompletedSessions: vi.fn(),
        abortSession: vi.fn(),
        refreshMcps: vi.fn(),
        refreshProviders: vi.fn(),
        setWorkspaceStatusSummary: vi.fn(),
        setWorkspaceStatuses: vi.fn(),
      },
      {
        type: 'context/update',
        payload: {
          workspacePath: '/repo-new',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      }
    );

    expect(resetWorkspaceForChange).toHaveBeenCalledOnce();
    expect(reloadWorkspaceAfterChange).toHaveBeenCalledWith(false);
  });

  it('routes command and server-event messages to the expected actions', () => {
    const createSession = vi.fn();
    const openSession = vi.fn();
    const focusComposer = vi.fn();
    const openAttentionSessions = vi.fn();
    const openCompletedSessions = vi.fn();
    const searchSessions = vi.fn();
    const abortSession = vi.fn();
    const refreshMcps = vi.fn();
    const refreshLsps = vi.fn();
    const refreshProviders = vi.fn();
    const setProviderRefreshPending = vi.fn();
    const revalidateProviderAuth = vi.fn();
    const openExternal = vi.fn();
    const addDroppedContextFiles = vi.fn();
    const removeDroppedContextFile = vi.fn();
    const deps = {
      setServerStatus: vi.fn(),
      clearError: vi.fn(),
      ensureConnectionInitialized: vi.fn(),
      getServerState: () => 'running' as const,
      invalidateConnection: vi.fn(),
      clearProvidersState: vi.fn(),
      setTheme: vi.fn(),
      setConfig: vi.fn(),
      getPreviousActiveFilePath: () => null,
      getCurrentWorkspacePath: () => null,
      setCurrentWorkspacePath: vi.fn(),
      setEditorContext: vi.fn(),
      rememberCurrentDocumentNavigation: vi.fn(),
      syncWorkspaceState: vi.fn(),
      resetWorkspaceForChange: vi.fn(),
      reloadWorkspaceAfterChange: vi.fn(),
      isInitialized: () => false,
      setTerminalSelection: vi.fn(),
      addContextFiles: addDroppedContextFiles,
      removeContextFile: removeDroppedContextFile,
      createSession,
      openSession,
      requestComposerFocus: focusComposer,
      requestOpenAttentionSessions: openAttentionSessions,
      requestOpenCompletedSessions: openCompletedSessions,
      requestSessionSearchFocus: searchSessions,
      abortSession,
      refreshMcps,
      refreshLsps,
      refreshProviders,
      setProviderRefreshPending,
      revalidateProviderAuth,
      openExternal,
      setWorkspaceStatusSummary: vi.fn(),
      setWorkspaceStatuses: vi.fn(),
    };

    handleExtensionMessageWithDependencies(deps, { type: 'command/new-session' });
    handleExtensionMessageWithDependencies(deps, {
      type: 'command/new-session',
      payload: { prefill: '/init' },
    });
    handleExtensionMessageWithDependencies(deps, {
      type: 'command/open-session',
      payload: { sessionId: 'session-1' },
    });
    handleExtensionMessageWithDependencies(deps, { type: 'command/focus-input' });
    handleExtensionMessageWithDependencies(deps, { type: 'command/open-attention-sessions' });
    handleExtensionMessageWithDependencies(deps, { type: 'command/open-completed-sessions' });
    handleExtensionMessageWithDependencies(deps, { type: 'command/search-sessions' });
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
    handleExtensionMessageWithDependencies(deps, {
      type: 'server/event',
      payload: { type: 'lsp.updated', properties: {} },
    });
    handleExtensionMessageWithDependencies(deps, {
      type: 'server/event',
      payload: {
        type: 'mcp.browser.open.failed',
        properties: { mcpName: 'docs', url: 'https://mcp.example.com/authorize' },
      },
    });
    for (const type of [
      'catalog.updated',
      'models-dev.refreshed',
      'integration.updated',
      'integration.connection.updated',
    ] as const) {
      handleExtensionMessageWithDependencies(deps, {
        type: 'server/event',
        payload: { type, properties: {} },
      });
    }
    handleExtensionMessageWithDependencies(deps, { type: 'providers/refresh' });
    handleExtensionMessageWithDependencies(deps, {
      type: 'providers/refresh',
      payload: { revalidateAuth: true },
    });
    handleExtensionMessageWithDependencies(deps, {
      type: 'providers/status',
      payload: { pending: true },
    });

    expect(createSession).toHaveBeenNthCalledWith(1, undefined);
    expect(createSession).toHaveBeenNthCalledWith(2, '/init');
    expect(openSession).toHaveBeenCalledWith('session-1');
    expect(focusComposer).toHaveBeenCalledTimes(1);
    expect(openAttentionSessions).toHaveBeenCalledTimes(1);
    expect(openCompletedSessions).toHaveBeenCalledTimes(1);
    expect(searchSessions).toHaveBeenCalledTimes(1);
    expect(abortSession).toHaveBeenCalledTimes(1);
    expect(addDroppedContextFiles).toHaveBeenCalledTimes(1);
    expect(removeDroppedContextFile).toHaveBeenCalledWith('/repo/file.ts');
    expect(refreshMcps).toHaveBeenCalledTimes(2);
    expect(refreshLsps).toHaveBeenCalledOnce();
    expect(refreshProviders).toHaveBeenCalledTimes(6);
    expect(setProviderRefreshPending).toHaveBeenCalledWith(true);
    expect(revalidateProviderAuth).toHaveBeenCalledTimes(3);
    expect(openExternal).toHaveBeenCalledWith('https://mcp.example.com/authorize');
  });

  it('binds extension message handling to shared webview state', () => {
    const ensureConnectionInitialized = vi.fn();
    const applyTheme = vi.fn();
    const operations = createMountBridgeOperations({
      ensureConnectionInitialized,
      getServerState: () => 'stopped',
      invalidateConnection: vi.fn(),
      getCurrentWorkspacePath: () => null,
      setCurrentWorkspacePath: vi.fn(),
      resetWorkspaceForChange: vi.fn(),
      reloadWorkspaceAfterChange: vi.fn(),
      isInitialized: () => false,
      createSession: vi.fn(),
      abortSession: vi.fn(),
      refreshMcps: vi.fn(),
      refreshProviders: vi.fn(),
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
        showFileDiffs: true,
        expandThinking: true,
        showChangedFiles: true,
        desktopSessionPaneSide: 'right',
        defaultPermissionMode: 'full',
        chatFontSize: 16,
        chatEditorFontSize: 15,
        chatFontFamily: 'Iosevka, monospace',
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
    expect(setDefaultPermissionModePreference).toHaveBeenCalledWith('full');
    expect(setShowFileDiffs).toHaveBeenCalledWith(true);
    expect(setExpandThinking).toHaveBeenCalledWith(true);
    expect(setShowChangedFiles).toHaveBeenCalledWith(true);
    expect(document.documentElement.style.getPropertyValue('--varro-chat-font-size')).toBe('16px');
    expect(document.documentElement.style.getPropertyValue('--varro-chat-editor-font-size')).toBe(
      '15px'
    );
    expect(document.documentElement.style.getPropertyValue('--varro-chat-font-family')).toBe(
      'Iosevka, monospace'
    );

    operations.handleExtensionMessage({
      type: 'config/update',
      payload: {
        desktopSessionPaneSide: 'right',
        defaultPermissionMode: 'full',
        chatFontSize: 13,
        chatEditorFontSize: 12,
        chatFontFamily: 'default',
      },
    });
    expect(document.documentElement.style.getPropertyValue('--varro-chat-font-family')).toBe('');
    document.documentElement.style.removeProperty('--varro-chat-font-size');
    document.documentElement.style.removeProperty('--varro-chat-editor-font-size');
  });

  it('marks visible editor session trees seen as visibility changes', () => {
    const getSessionTreeIds = vi
      .spyOn(sessionStore, 'getSessionTreeIds')
      .mockImplementation((sessionId) =>
        sessionId === 'session-1' ? ['session-1', 'child-1'] : [sessionId!]
      );
    const markSessionSeen = vi
      .spyOn(sessionStore, 'markSessionSeen')
      .mockImplementation(() => undefined);
    const operations = createMountBridgeOperations({
      ensureConnectionInitialized: vi.fn(),
      getServerState: () => 'stopped',
      invalidateConnection: vi.fn(),
      getCurrentWorkspacePath: () => null,
      setCurrentWorkspacePath: vi.fn(),
      resetWorkspaceForChange: vi.fn(),
      reloadWorkspaceAfterChange: vi.fn(),
      isInitialized: () => false,
      createSession: vi.fn(),
      abortSession: vi.fn(),
      refreshMcps: vi.fn(),
      refreshProviders: vi.fn(),
      applyTheme: vi.fn(),
    });

    operations.handleExtensionMessage({
      type: 'editor-tabs/state',
      payload: { open: true, sessionIds: ['session-1'] },
    });
    expect(markSessionSeen).toHaveBeenCalledWith('session-1');
    expect(markSessionSeen).toHaveBeenCalledWith('child-1');

    markSessionSeen.mockClear();
    operations.handleExtensionMessage({
      type: 'editor-tabs/state',
      payload: { open: false, sessionIds: [] },
    });
    expect(markSessionSeen).toHaveBeenCalledWith('session-1');
    expect(markSessionSeen).toHaveBeenCalledWith('child-1');

    getSessionTreeIds.mockRestore();
    markSessionSeen.mockRestore();
  });

  it('routes workspace status events into shared workspace state', () => {
    getWorkspaceStatusEventSummaryMock.mockReturnValue({
      entries: [{ workspaceID: 'ws-1', status: 'connected' }],
      latest: undefined,
    });

    const deps = {
      setServerStatus: vi.fn(),
      clearError: vi.fn(),
      ensureConnectionInitialized: vi.fn(),
      getServerState: () => 'running' as const,
      invalidateConnection: vi.fn(),
      clearProvidersState: vi.fn(),
      setTheme: vi.fn(),
      setConfig: vi.fn(),
      getPreviousActiveFilePath: () => null,
      getCurrentWorkspacePath: () => null,
      setCurrentWorkspacePath: vi.fn(),
      setEditorContext: vi.fn(),
      rememberCurrentDocumentNavigation: vi.fn(),
      syncWorkspaceState: vi.fn(),
      resetWorkspaceForChange: vi.fn(),
      reloadWorkspaceAfterChange: vi.fn(),
      isInitialized: () => false,
      setTerminalSelection: vi.fn(),
      addContextFiles: vi.fn(),
      removeContextFile: vi.fn(),
      createSession: vi.fn(),
      requestComposerFocus: vi.fn(),
      requestOpenAttentionSessions: vi.fn(),
      requestOpenCompletedSessions: vi.fn(),
      abortSession: vi.fn(),
      refreshMcps: vi.fn(),
      refreshProviders: vi.fn(),
      setWorkspaceStatusSummary,
      setWorkspaceStatuses,
    };

    handleExtensionMessageWithDependencies(deps, {
      type: 'server/event',
      payload: {
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'connected' },
      },
    });

    expect(setWorkspaceStatuses).toHaveBeenCalledWith([
      { workspaceID: 'ws-1', status: 'connected' },
    ]);
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
    const refreshProviders = vi.fn();

    const dispose = registerFocusStateTracking({
      setDocumentVisible,
      postFocusState,
      isLoading: () => true,
      getActiveSessionId: () => 'session-1',
      recheckSessionStatus,
      refreshProviders,
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
      expect(refreshProviders).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
    }
  });
});
