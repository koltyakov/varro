import { flush as flushSolid } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type {
  ExtensionMessage,
  WebviewMessage,
  WorkspaceStatusEventSummary,
} from '../../shared/protocol';
import { setState, state } from '../lib/state';
import { sessionStore } from '../lib/stores/session-store';

const {
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
  setShowTurnTimer,
  setGroupComposerBlocks,
  setShowEmptyStateHistogram,
  setDesktopSessionPaneSide,
  setDefaultPermissionModePreference,
  setWorkspaceStatusSummary,
  setWorkspaceStatuses,
  applyModelPreferencesSnapshot,
  applySessionSelectedAgentUpdate,
  applySessionPlanStateUpdate,
  setProviderLimit,
} = vi.hoisted(() => ({
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
  setShowTurnTimer: vi.fn(),
  setGroupComposerBlocks: vi.fn(),
  setShowEmptyStateHistogram: vi.fn(),
  setDesktopSessionPaneSide: vi.fn(),
  setDefaultPermissionModePreference: vi.fn(),
  setWorkspaceStatusSummary: vi.fn(),
  setWorkspaceStatuses: vi.fn(),
  applyModelPreferencesSnapshot: vi.fn(),
  applySessionSelectedAgentUpdate: vi.fn(),
  applySessionPlanStateUpdate: vi.fn(),
  setProviderLimit: vi.fn(),
}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise mount-bridge integration with state and client modules. */
vi.mock(import('../lib/state'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    setProviderLimit,
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
    setShowTurnTimer,
    setGroupComposerBlocks,
    setShowEmptyStateHistogram,
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
    syncClipboardImages: vi.fn(),
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
  it('reloads sessions when the host invalidates the catalog', () => {
    const reloadSessionCatalog = vi.fn(() => Promise.resolve());

    handleExtensionMessageWithDependencies(createMessageDependencies({ reloadSessionCatalog }), {
      type: 'session/catalog-invalidated',
    });

    expect(reloadSessionCatalog).toHaveBeenCalledOnce();
  });

  it('applies host clipboard image snapshots', () => {
    const syncClipboardImages = vi.fn();
    const images = [
      {
        id: 'image-1',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'image.png',
        size: 1,
      },
    ];

    handleExtensionMessageWithDependencies(createMessageDependencies({ syncClipboardImages }), {
      type: 'composer/images-sync',
      payload: { images },
    });

    expect(syncClipboardImages).toHaveBeenCalledWith(images);
  });

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
      providerOrder: ['openai'],
      modelOrder: ['openai:gpt-5.6-sol'],
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
    expect(applySessionSelectedAgentUpdate).toHaveBeenCalledWith('session-1', 'build', undefined);
  });

  it('settles an agent selection when host persistence fails', () => {
    handleExtensionMessageWithDependencies(createMessageDependencies(), {
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', selectionId: 'selection-4' },
    });
    expect(applySessionSelectedAgentUpdate).toHaveBeenCalledWith(
      'session-1',
      undefined,
      'selection-4'
    );
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
      createMessageDependencies({
        setServerStatus,
        clearError,
        ensureConnectionInitialized,
      }),
      {
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      }
    );

    expect(setServerStatus).toHaveBeenCalledWith({
      state: 'running',
      url: 'http://127.0.0.1:4096',
    });
    expect(clearError).not.toHaveBeenCalled();
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
    const deps = createMessageDependencies({
      setServerStatus,
      clearError,
      ensureConnectionInitialized,
      getServerState: () => serverState,
      invalidateConnection,
      clearProvidersState,
    });

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

  it('marks only a running-to-starting transition as a reconnect', () => {
    const setServerReconnecting = vi.fn();
    let serverState: Extract<ExtensionMessage, { type: 'server/status' }>['payload']['state'] =
      'running';
    const deps = createMessageDependencies({
      setServerStatus: (
        payload: Extract<ExtensionMessage, { type: 'server/status' }>['payload']
      ) => {
        serverState = payload.state;
      },
      setServerReconnecting,
      getServerState: () => serverState,
    });

    handleExtensionMessageWithDependencies(deps, {
      type: 'server/status',
      payload: { state: 'starting' },
    });
    expect(setServerReconnecting).toHaveBeenCalledWith(true);

    handleExtensionMessageWithDependencies(deps, {
      type: 'server/status',
      payload: { state: 'error', message: 'restart failed' },
    });
    expect(setServerReconnecting).toHaveBeenLastCalledWith(false);
  });

  it('routes correlated workspace selection failures', () => {
    const workspaceSelectionFailed = vi.fn();
    const payload = { requestId: 12, path: '/repo-b', error: 'Folder is not open' };
    handleExtensionMessageWithDependencies(
      createMessageDependencies({ workspaceSelectionFailed }),
      {
        type: 'workspace/select-failed',
        payload,
      }
    );
    expect(workspaceSelectionFailed).toHaveBeenCalledWith(payload);
  });

  it('acknowledges context even when the workspace has not changed', () => {
    const acknowledgeWorkspaceSelection = vi.fn();
    const resetWorkspaceForChange = vi.fn();
    handleExtensionMessageWithDependencies(
      createMessageDependencies({
        getCurrentWorkspacePath: () => '/repo-b',
        acknowledgeWorkspaceSelection,
        resetWorkspaceForChange,
      }),
      {
        type: 'context/update',
        payload: { workspacePath: '/repo-b', activeFile: null, selection: null, diagnostics: [] },
      }
    );
    expect(acknowledgeWorkspaceSelection).toHaveBeenCalledWith('/repo-b');
    expect(resetWorkspaceForChange).not.toHaveBeenCalled();
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
      createMessageDependencies({
        getServerState: () => 'running',
        getPreviousActiveFilePath: () => '/repo/src/old.ts',
        getCurrentWorkspacePath: () => '/repo',
        setCurrentWorkspacePath,
        setEditorContext,
        rememberCurrentDocumentNavigation: rememberNavigation,
        syncWorkspaceState,
        resetWorkspaceForChange,
        reloadWorkspaceAfterChange,
        isInitialized: () => true,
      }),
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

  it('does not reset workspace state for an equivalent Windows path', () => {
    const setCurrentWorkspacePath = vi.fn();
    const syncWorkspaceState = vi.fn();
    const resetWorkspaceForChange = vi.fn();
    const reloadWorkspaceAfterChange = vi.fn();

    handleExtensionMessageWithDependencies(
      createMessageDependencies({
        getServerState: () => 'running',
        getCurrentWorkspacePath: () => 'C:\\Users\\Andrew\\Repo',
        setCurrentWorkspacePath,
        syncWorkspaceState,
        resetWorkspaceForChange,
        reloadWorkspaceAfterChange,
        isInitialized: () => true,
      }),
      {
        type: 'context/update',
        payload: {
          workspacePath: 'c:/users/andrew/repo/',
          workspaceFolders: [],
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      }
    );

    expect(setCurrentWorkspacePath).toHaveBeenCalledWith('c:/users/andrew/repo');
    expect(syncWorkspaceState).not.toHaveBeenCalled();
    expect(resetWorkspaceForChange).not.toHaveBeenCalled();
    expect(reloadWorkspaceAfterChange).not.toHaveBeenCalled();
  });

  it('treats the first context update as a seed without resetting workspace state', () => {
    const syncWorkspaceState = vi.fn();
    const resetWorkspaceForChange = vi.fn();
    const reloadWorkspaceAfterChange = vi.fn();

    handleExtensionMessageWithDependencies(
      createMessageDependencies({
        getServerState: () => 'running',
        getCurrentWorkspacePath: () => undefined,
        syncWorkspaceState,
        resetWorkspaceForChange,
        reloadWorkspaceAfterChange,
      }),
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
      createMessageDependencies({
        getServerState: () => 'running',
        getCurrentWorkspacePath: () => '/repo-old',
        resetWorkspaceForChange,
        reloadWorkspaceAfterChange,
      }),
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
    const deps = createMessageDependencies({
      getServerState: () => 'running' as const,
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
    });

    const quotaUpdate: ExtensionMessage = {
      type: 'provider-limit/updated',
      payload: {
        directory: '/repo',
        status: {
          providerID: 'openai',
          modelID: 'gpt',
          source: 'provider',
          status: 'error',
          checkedAt: 10,
          note: 'Quota unavailable',
        },
      },
    };
    handleExtensionMessageWithDependencies(deps, quotaUpdate);
    expect(setProviderLimit).not.toHaveBeenCalled();
    handleExtensionMessageWithDependencies(
      { ...deps, getCurrentWorkspacePath: () => '/other' },
      quotaUpdate
    );
    expect(setProviderLimit).not.toHaveBeenCalled();
    handleExtensionMessageWithDependencies(
      { ...deps, getCurrentWorkspacePath: () => '/repo/' },
      quotaUpdate
    );
    expect(setProviderLimit).toHaveBeenCalledExactlyOnceWith(
      'openai',
      'gpt',
      quotaUpdate.payload.status
    );
    expect(refreshProviders).not.toHaveBeenCalled();

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
      'plugin.added',
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
    expect(openSession).toHaveBeenCalledWith('session-1', undefined);
    expect(focusComposer).toHaveBeenCalledTimes(1);
    expect(openAttentionSessions).toHaveBeenCalledTimes(1);
    expect(openCompletedSessions).toHaveBeenCalledTimes(1);
    expect(searchSessions).toHaveBeenCalledTimes(1);
    expect(abortSession).toHaveBeenCalledTimes(1);
    expect(addDroppedContextFiles).toHaveBeenCalledTimes(1);
    expect(removeDroppedContextFile).toHaveBeenCalledWith('/repo/file.ts');
    expect(refreshMcps).toHaveBeenCalledTimes(2);
    expect(refreshLsps).toHaveBeenCalledOnce();
    expect(refreshProviders).toHaveBeenCalledTimes(7);
    expect(setProviderRefreshPending).toHaveBeenCalledWith(true);
    expect(revalidateProviderAuth).toHaveBeenCalledTimes(3);
    expect(openExternal).toHaveBeenCalledWith('https://mcp.example.com/authorize');
  });

  it('applies committed pins independently of an expired API response', () => {
    const deps = createMessageDependencies();
    handleExtensionMessageWithDependencies(deps, {
      type: 'pinned-sessions/sync',
      payload: { sessionIds: ['session-2', 'session-1'] },
    });
    flushSolid();
    expect([...state.pinnedSessionIds]).toEqual(['session-2', 'session-1']);

    handleExtensionMessageWithDependencies(deps, {
      type: 'pinned-sessions/sync',
      payload: { sessionIds: [] },
    });
    flushSolid();
    expect([...state.pinnedSessionIds]).toEqual([]);
    expect(deps.ensureConnectionInitialized).not.toHaveBeenCalled();
    expect(deps.clearError).not.toHaveBeenCalled();
  });

  it('applies host todo marks, including marks cleared by a new prompt', () => {
    const deps = createMessageDependencies();
    handleExtensionMessageWithDependencies(deps, {
      type: 'todo-sessions/sync',
      payload: { sessionIds: ['session-1'] },
    });
    flushSolid();
    expect([...state.todoSessionIds]).toEqual(['session-1']);

    handleExtensionMessageWithDependencies(deps, {
      type: 'todo-sessions/sync',
      payload: { sessionIds: [] },
    });
    flushSolid();
    expect([...state.todoSessionIds]).toEqual([]);
  });

  it('binds extension message handling to shared webview state', () => {
    setState((draft) => {
      draft.remoteImages = 'off';
    });
    flushSolid();
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
        showTurnTimer: true,
        groupComposerBlocks: true,
        showEmptyStateHistogram: true,
        followupsEnabled: false,
        remoteImages: 'ask',
        debugShowQuotaWarning: true,
        autoAttachProblems: false,
        autoAttachActiveFile: false,
        desktopSessionPaneSide: 'right',
        defaultPermissionMode: 'full',
        chatFontSize: 16,
        chatEditorFontSize: 15,
        chatFontFamily: 'Iosevka, monospace',
      },
    });

    flushSolid();
    expect(setTheme).toHaveBeenCalledWith('light');
    expect(applyTheme).toHaveBeenCalledWith('light');
    expect(state.serverStatus).toEqual({
      state: 'running',
      url: 'http://127.0.0.1:4096',
    });
    expect(setError).not.toHaveBeenCalled();
    expect(ensureConnectionInitialized).toHaveBeenCalledTimes(1);
    expect(setDefaultPermissionModePreference).toHaveBeenCalledWith('full');
    expect(state.remoteImages).toBe('ask');
    expect(setShowFileDiffs).toHaveBeenCalledWith(true);
    expect(setExpandThinking).toHaveBeenCalledWith(true);
    expect(setShowChangedFiles).toHaveBeenCalledWith(true);
    expect(setShowTurnTimer).toHaveBeenCalledWith(true);
    expect(setGroupComposerBlocks).toHaveBeenCalledWith(true);
    expect(setShowEmptyStateHistogram).toHaveBeenCalledWith(true);
    expect(state.followupsEnabled).toBe(false);
    expect(state.debugShowQuotaWarning).toBe(true);
    expect(state.autoAttachProblems).toBe(false);
    expect(state.autoAttachActiveFile).toBe(false);
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
    expect(setShowEmptyStateHistogram).toHaveBeenCalledTimes(1);
    operations.handleExtensionMessage({
      type: 'config/update',
      payload: {
        showEmptyStateHistogram: false,
        followupsEnabled: true,
        desktopSessionPaneSide: 'right',
        defaultPermissionMode: 'full',
        chatFontSize: 13,
        chatEditorFontSize: 12,
        chatFontFamily: 'default',
      },
    });
    expect(setShowEmptyStateHistogram).toHaveBeenLastCalledWith(false);
    flushSolid();
    expect(state.followupsEnabled).toBe(true);
    document.documentElement.style.removeProperty('--varro-chat-font-size');
    flushSolid();
    document.documentElement.style.removeProperty('--varro-chat-editor-font-size');
    flushSolid();
  });

  it('marks visible editor session trees seen as visibility changes', () => {
    const getSessionTreeIds = vi
      .spyOn(sessionStore, 'getSessionTreeIds')
      .mockImplementation((sessionId) =>
        sessionId === 'session-1' ? ['session-1', 'child-1'] : [sessionId!]
      );
    const markSessionSeen = vi
      .spyOn(sessionStore, 'markSessionSeen')
      .mockImplementation(() => false);
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
      payload: {
        open: true,
        sessionIds: ['session-1'],
        openSessionIds: ['session-1', 'session-2'],
      },
    });
    expect(markSessionSeen).toHaveBeenCalledWith('session-1');
    expect(markSessionSeen).toHaveBeenCalledWith('child-1');

    markSessionSeen.mockClear();
    operations.handleExtensionMessage({
      type: 'editor-tabs/state',
      payload: { open: false, sessionIds: [], openSessionIds: [] },
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

    const deps = createMessageDependencies({
      getServerState: () => 'running' as const,
      setWorkspaceStatusSummary,
      setWorkspaceStatuses,
    });

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
    const syncSessionMessages = vi.fn();
    const refreshProviders = vi.fn();

    const dispose = registerFocusStateTracking({
      setDocumentVisible,
      postFocusState,
      isLoading: () => true,
      getActiveSessionId: () => 'session-1',
      recheckSessionStatus,
      syncSessionMessages,
      refreshProviders,
    });

    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      flushSolid();
      window.dispatchEvent(new Event('focus'));
      flushSolid();
      window.dispatchEvent(new Event('blur'));
      flushSolid();

      expect(setDocumentVisible).toHaveBeenCalledWith(true);
      expect(postFocusState).toHaveBeenCalledTimes(3);
      expect(recheckSessionStatus).toHaveBeenCalledWith('session-1');
      expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
      expect(refreshProviders).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      flushSolid();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
    }
  });

  it('syncs the active transcript when an idle webview becomes visible again', () => {
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    const syncSessionMessages = vi.fn();
    const dispose = registerFocusStateTracking({
      setDocumentVisible: vi.fn(),
      postFocusState: vi.fn(),
      isLoading: () => false,
      getActiveSessionId: () => 'session-1',
      recheckSessionStatus: vi.fn(),
      syncSessionMessages,
      refreshProviders: vi.fn(),
    });

    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      flushSolid();

      expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
    } finally {
      dispose();
      flushSolid();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
    }
  });
});
