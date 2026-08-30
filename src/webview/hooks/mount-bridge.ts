import { reconcile } from 'solid-js/store';
import type {
  ExtensionMessage,
  WebviewThemeKind,
  WorkspaceFolderContext,
} from '../../shared/protocol';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../../shared/workspace-path';
import { appStore } from '../lib/stores/app-store';
import { composerStore } from '../lib/stores/composer-store';
import { permissionsStore } from '../lib/stores/permissions-store';
import { ralphStore } from '../lib/stores/ralph-store';
import { sessionStore } from '../lib/stores/session-store';
import { uiStore } from '../lib/stores/ui-store';
import { postMessage } from '../lib/bridge';
import { applyChatFontConfig } from '../lib/chat-font-config';
import { getWorkspaceStatusEventSummary } from '../lib/client';
import { isString } from '../lib/runtime-values';
import { STORAGE_KEYS, writeStored } from '../lib/state-storage';
import {
  applyModelPreferencesSnapshot,
  applySessionSelectedAgentUpdate,
  applySessionPlanStateUpdate,
  applySessionPermissionModesSnapshot,
  applySessionSelectedModelsSnapshot,
  syncSessionMarkersForWorkspace,
} from '../lib/state';
import {
  applyQueuedMessageClaimResult,
  applyQueuedMessagesSnapshot,
} from '../lib/state-queued-messages';
import { normalizeProjectPath } from './session/session-lifecycle';

export function createMountBridgeOperations(deps: {
  ensureConnectionInitialized(): void;
  reloadSessionCatalog?(): Promise<void>;
  getServerState(): Extract<ExtensionMessage, { type: 'server/status' }>['payload']['state'];
  invalidateConnection(): void;
  getCurrentWorkspacePath(): string | null | undefined;
  setCurrentWorkspacePath(path: string | null): void;
  resetWorkspaceForChange(options?: {
    workspaceMembershipChanged?: boolean;
    nextWorkspacePath?: string | null;
    executionDirectoryChanged?: boolean;
  }): void;
  reloadWorkspaceAfterChange(wasInitialized: boolean): void;
  isInitialized(): boolean;
  createSession(prefill?: string): void;
  openSession?(sessionId: string, directory?: string): void;
  abortSession(): void;
  refreshMcps(): void;
  refreshLsps?(): void;
  refreshProviders(): void;
  revalidateProviderAuth?(): void;
  applyTheme(theme: WebviewThemeKind): void;
  setPermissionAutomation?(owner: boolean, lease: number): void;
  permissionModesSynced?(): void;
  revealPermission?(permissionId: string): void;
  queueInterruptedSessionRecovery?(claimId: number, sessionIds: string[]): void;
}) {
  let visibleEditorSessionIds = appStore.state.editorSessionIds;
  const handleExtensionMessage = (msg: ExtensionMessage) => {
    handleExtensionMessageWithDependencies(
      {
        setServerStatus: (payload) => appStore.setState('serverStatus', payload),
        setServerReconnecting: (reconnecting) =>
          appStore.setState('serverReconnecting', reconnecting),
        setRestartBlocked: (payload) => {
          if (payload?.checkId !== undefined && appStore.state.restartBlocked === null) return;
          appStore.setState('restartBlocked', payload);
        },
        clearError: () => uiStore.setError(null),
        ensureConnectionInitialized: deps.ensureConnectionInitialized,
        reloadSessionCatalog: deps.reloadSessionCatalog,
        getServerState: deps.getServerState,
        invalidateConnection: deps.invalidateConnection,
        clearProvidersState: () => {
          appStore.setState('providersLoaded', false);
          appStore.setState('providerLimits', reconcile({}));
        },
        setTheme: (payload) => {
          uiStore.setTheme(payload.theme);
          deps.applyTheme(payload.theme);
        },
        setConfig: (payload) => {
          applyChatFontConfig(payload);
          if (payload.showFileDiffs !== undefined) {
            uiStore.setShowFileDiffs(payload.showFileDiffs);
          }
          if (payload.expandThinking !== undefined) {
            uiStore.setExpandThinking(payload.expandThinking);
          }
          if (payload.showChangedFiles !== undefined) {
            uiStore.setShowChangedFiles(payload.showChangedFiles);
          }
          uiStore.setDesktopSessionPaneSide(payload.desktopSessionPaneSide);
          permissionsStore.setDefaultPermissionModePreference(payload.defaultPermissionMode);
        },
        getPreviousActiveFilePath: () => appStore.state.editorContext.activeFile?.path ?? null,
        getCurrentWorkspacePath: deps.getCurrentWorkspacePath,
        getCurrentWorkspaceFolders: () => appStore.state.editorContext.workspaceFolders ?? [],
        setCurrentWorkspacePath: deps.setCurrentWorkspacePath,
        persistWorkspacePath: (path) => writeStored(STORAGE_KEYS.workspacePath, path),
        setEditorContext: composerStore.setEditorContext,
        rememberCurrentDocumentNavigation: composerStore.rememberCurrentDocumentNavigation,
        syncWorkspaceState: (path) => {
          sessionStore.syncWorkspaceState(path);
          composerStore.syncCurrentDocumentForWorkspace(path);
          syncSessionMarkersForWorkspace(
            path,
            (appStore.state.editorContext.workspaceFolders ?? []).map((folder) => folder.path)
          );
        },
        resetWorkspaceForChange: deps.resetWorkspaceForChange,
        reloadWorkspaceAfterChange: deps.reloadWorkspaceAfterChange,
        isInitialized: deps.isInitialized,
        setTerminalSelection: composerStore.setTerminalSelection,
        syncClipboardImages: composerStore.syncClipboardImages,
        addContextFiles: composerStore.addContextFiles,
        removeContextFile: composerStore.removeContextFile,
        createSession: deps.createSession,
        openSession: deps.openSession,
        requestComposerFocus: uiStore.requestComposerFocus,
        requestOpenAttentionSessions: uiStore.requestOpenAttentionSessions,
        requestOpenCompletedSessions: uiStore.requestOpenCompletedSessions,
        requestSessionSearchFocus: uiStore.requestSessionSearchFocus,
        abortSession: deps.abortSession,
        refreshMcps: deps.refreshMcps,
        refreshLsps: deps.refreshLsps,
        refreshProviders: deps.refreshProviders,
        setProviderRefreshPending: (pending) =>
          appStore.setState('providerRefreshPending', pending),
        revalidateProviderAuth: deps.revalidateProviderAuth,
        openExternal: (url) => postMessage({ type: 'vscode/open-external', payload: { url } }),
        setWorkspaceStatusSummary: (summary) =>
          appStore.setState('workspaceStatusSummary', summary),
        setWorkspaceStatuses: (entries) => appStore.setState('workspaceStatuses', entries),
        setEditorTabsState: (open, sessionIds) => {
          const seenSessionIds = new Set([...visibleEditorSessionIds, ...sessionIds]);
          for (const rootSessionId of seenSessionIds) {
            for (const sessionId of sessionStore.getSessionTreeIds(rootSessionId)) {
              sessionStore.markSessionSeen(sessionId);
            }
          }
          visibleEditorSessionIds = sessionIds;
          appStore.setState('editorTabsOpen', open);
          appStore.setState('editorSessionIds', sessionIds);
        },
        setSiblingWorkspaceAlerts: (alerts) => appStore.setState('siblingWorkspaceAlerts', alerts),
        setPermissionAutomation: deps.setPermissionAutomation,
        permissionModesSynced: deps.permissionModesSynced,
        revealPermission: deps.revealPermission,
        queueInterruptedSessionRecovery: deps.queueInterruptedSessionRecovery,
      },
      msg
    );
  };

  return { handleExtensionMessage };
}

export function handleExtensionMessageWithDependencies(
  deps: {
    setServerStatus(payload: Extract<ExtensionMessage, { type: 'server/status' }>['payload']): void;
    setServerReconnecting?(reconnecting: boolean): void;
    setRestartBlocked?(
      payload: Extract<ExtensionMessage, { type: 'server/restart-blocked' }>['payload'] | null
    ): void;
    clearError(): void;
    ensureConnectionInitialized(): void;
    reloadSessionCatalog?(): Promise<void>;
    getServerState(): Extract<ExtensionMessage, { type: 'server/status' }>['payload']['state'];
    invalidateConnection(): void;
    clearProvidersState(): void;
    setTheme(payload: Extract<ExtensionMessage, { type: 'theme/update' }>['payload']): void;
    setConfig(payload: Extract<ExtensionMessage, { type: 'config/update' }>['payload']): void;
    getPreviousActiveFilePath(): string | null;
    getCurrentWorkspacePath(): string | null | undefined;
    setCurrentWorkspacePath(path: string | null): void;
    persistWorkspacePath?(path: string | null): void;
    setEditorContext(
      payload: Extract<ExtensionMessage, { type: 'context/update' }>['payload']
    ): void;
    rememberCurrentDocumentNavigation(previousPath: string | null, nextPath: string | null): void;
    syncWorkspaceState(path: string | null): void;
    getCurrentWorkspaceFolders?(): readonly WorkspaceFolderContext[];
    resetWorkspaceForChange(options?: {
      workspaceMembershipChanged?: boolean;
      nextWorkspacePath?: string | null;
      executionDirectoryChanged?: boolean;
    }): void;
    reloadWorkspaceAfterChange(wasInitialized: boolean): void;
    isInitialized(): boolean;
    setTerminalSelection(
      payload: Extract<ExtensionMessage, { type: 'terminal-selection/update' }>['payload']
    ): void;
    syncClipboardImages?(
      images: Extract<ExtensionMessage, { type: 'composer/images-sync' }>['payload']['images']
    ): void;
    addContextFiles(payload: Extract<ExtensionMessage, { type: 'files/dropped' }>['payload']): void;
    removeContextFile(path: string): void;
    createSession(prefill?: string): void;
    openSession?(sessionId: string, directory?: string): void;
    requestComposerFocus(): void;
    requestOpenAttentionSessions(): void;
    requestOpenCompletedSessions(): void;
    requestSessionSearchFocus?(): void;
    abortSession(): void;
    refreshMcps(): void;
    refreshLsps?(): void;
    refreshProviders(): void;
    setProviderRefreshPending?(pending: boolean): void;
    revalidateProviderAuth?(): void;
    openExternal?(url: string): void;
    setWorkspaceStatusSummary(summary: ReturnType<typeof getWorkspaceStatusEventSummary>): void;
    setWorkspaceStatuses(
      payload: {
        workspaceID: string;
        status: 'connected' | 'connecting' | 'disconnected' | 'error';
      }[]
    ): void;
    setEditorTabsState?(open: boolean, sessionIds: string[]): void;
    setSiblingWorkspaceAlerts?(
      alerts: Extract<ExtensionMessage, { type: 'sibling-workspace-alerts/update' }>['payload']
    ): void;
    setPermissionAutomation?(owner: boolean, lease: number): void;
    permissionModesSynced?(): void;
    revealPermission?(permissionId: string): void;
    queueInterruptedSessionRecovery?(claimId: number, sessionIds: string[]): void;
  },
  msg: ExtensionMessage
) {
  switch (msg.type) {
    case 'server/status': {
      const previousServerState = deps.getServerState();
      if (previousServerState === 'running' && msg.payload.state === 'starting') {
        deps.setServerReconnecting?.(true);
      } else if (msg.payload.state === 'stopped' || msg.payload.state === 'error') {
        deps.setServerReconnecting?.(false);
      }
      deps.setServerStatus(msg.payload);
      if (msg.payload.state === 'starting' || msg.payload.state === 'running') {
        deps.setRestartBlocked?.(null);
      }
      if (msg.payload.state === 'running') {
        deps.clearError();
        deps.ensureConnectionInitialized();
      } else {
        if (previousServerState === 'running') deps.invalidateConnection();
        deps.clearProvidersState();
        deps.clearError();
      }
      break;
    }
    case 'server/restart-blocked':
      deps.setRestartBlocked?.(msg.payload);
      break;
    case 'theme/update':
      deps.setTheme(msg.payload);
      break;
    case 'config/update':
      deps.setConfig(msg.payload);
      break;
    case 'session/catalog-invalidated':
      void deps.reloadSessionCatalog?.();
      break;
    case 'context/update': {
      const previousActiveFilePath = deps.getPreviousActiveFilePath();
      const previousWorkspaceFolders = deps.getCurrentWorkspaceFolders?.() ?? [];
      const nextWorkspacePath = normalizeProjectPath(msg.payload.workspacePath);
      const previousWorkspacePath = deps.getCurrentWorkspacePath();
      const initialWorkspaceContext = previousWorkspacePath === undefined;
      const workspaceChanged =
        !initialWorkspaceContext &&
        nextWorkspacePath !== previousWorkspacePath &&
        !isSameWorkspacePath(nextWorkspacePath, previousWorkspacePath);
      const workspaceMembershipChanged = !haveSameWorkspaceRoots(
        previousWorkspaceFolders,
        msg.payload.workspaceFolders ?? []
      );
      deps.setCurrentWorkspacePath(nextWorkspacePath);
      deps.persistWorkspacePath?.(nextWorkspacePath);
      deps.setEditorContext(msg.payload);
      if (initialWorkspaceContext || workspaceChanged || workspaceMembershipChanged) {
        deps.syncWorkspaceState(nextWorkspacePath);
      }
      deps.rememberCurrentDocumentNavigation(
        previousActiveFilePath,
        msg.payload.activeFile?.path ?? null
      );
      if (workspaceChanged || (!initialWorkspaceContext && workspaceMembershipChanged)) {
        const wasInitialized = deps.isInitialized();
        deps.resetWorkspaceForChange({
          workspaceMembershipChanged,
          nextWorkspacePath,
          executionDirectoryChanged: workspaceChanged,
        });
        deps.reloadWorkspaceAfterChange(wasInitialized);
      }
      break;
    }
    case 'terminal-selection/update':
      deps.setTerminalSelection(msg.payload);
      break;
    case 'composer/images-sync':
      deps.syncClipboardImages?.(msg.payload.images);
      break;
    case 'files/dropped':
      deps.addContextFiles(msg.payload);
      break;
    case 'files/removed':
      deps.removeContextFile(msg.payload.path);
      break;
    case 'command/new-session':
      deps.createSession(msg.payload?.prefill);
      break;
    case 'command/open-session':
      deps.openSession?.(msg.payload.sessionId, msg.payload.directory);
      break;
    case 'command/focus-input':
      deps.requestComposerFocus();
      break;
    case 'command/open-attention-sessions':
      deps.requestOpenAttentionSessions();
      break;
    case 'command/open-completed-sessions':
      deps.requestOpenCompletedSessions();
      break;
    case 'command/search-sessions':
      deps.requestSessionSearchFocus?.();
      break;
    case 'command/abort':
      deps.abortSession();
      break;
    case 'server/event':
      if (
        msg.payload.type === 'workspace.ready' ||
        msg.payload.type === 'workspace.failed' ||
        msg.payload.type === 'workspace.status'
      ) {
        const summary = getWorkspaceStatusEventSummary();
        deps.setWorkspaceStatusSummary(summary);
        deps.setWorkspaceStatuses(summary.entries);
      }
      if (
        msg.payload.type === 'mcp.tools.changed' ||
        msg.payload.type === 'mcp.browser.open.failed'
      ) {
        deps.refreshMcps();
      }
      if (msg.payload.type === 'lsp.updated') {
        deps.refreshLsps?.();
      }
      if (msg.payload.type === 'mcp.browser.open.failed' && isString(msg.payload.properties?.url)) {
        deps.openExternal?.(msg.payload.properties.url);
      }
      if (
        msg.payload.type === 'catalog.updated' ||
        msg.payload.type === 'models-dev.refreshed' ||
        msg.payload.type === 'integration.updated' ||
        msg.payload.type === 'integration.connection.updated'
      ) {
        deps.refreshProviders();
      }
      if (
        msg.payload.type === 'integration.updated' ||
        msg.payload.type === 'integration.connection.updated'
      ) {
        deps.revalidateProviderAuth?.();
      }
      break;
    case 'providers/refresh':
      deps.refreshProviders();
      if (msg.payload?.revalidateAuth) deps.revalidateProviderAuth?.();
      break;
    case 'providers/status':
      deps.setProviderRefreshPending?.(msg.payload.pending);
      break;
    case 'queued-messages/sync':
      applyQueuedMessagesSnapshot(msg.payload.messages);
      break;
    case 'queued-messages/claim-result':
      applyQueuedMessageClaimResult(msg.payload);
      break;
    case 'permission-modes/sync':
      applySessionPermissionModesSnapshot(
        msg.payload.modes,
        msg.payload.recoveringSessionIds ?? []
      );
      deps.permissionModesSynced?.();
      break;
    case 'session-models/sync':
      applySessionSelectedModelsSnapshot(msg.payload.models);
      break;
    case 'session-plan-state/sync':
      for (const [sessionId, skippedAt] of Object.entries(msg.payload.state)) {
        applySessionPlanStateUpdate(sessionId, skippedAt);
      }
      for (const [sessionId, agent] of Object.entries(msg.payload.agents)) {
        applySessionSelectedAgentUpdate(sessionId, agent);
      }
      break;
    case 'session-plan-state/update':
      if (msg.payload.skippedAt !== undefined) {
        applySessionPlanStateUpdate(msg.payload.sessionId, msg.payload.skippedAt);
      }
      if (msg.payload.agent !== undefined) {
        applySessionSelectedAgentUpdate(msg.payload.sessionId, msg.payload.agent);
      }
      break;
    case 'model-preferences/sync':
      applyModelPreferencesSnapshot(msg.payload);
      break;
    case 'editor-tabs/state':
      deps.setEditorTabsState?.(msg.payload.open, msg.payload.sessionIds);
      break;
    case 'sibling-workspace-alerts/update':
      deps.setSiblingWorkspaceAlerts?.(msg.payload);
      break;
    case 'permission-automation/update':
      deps.setPermissionAutomation?.(msg.payload.owner, msg.payload.lease);
      break;
    case 'permission/actionable':
      deps.revealPermission?.(msg.payload.permissionId);
      break;
    case 'recovery/interrupted-sessions':
      deps.queueInterruptedSessionRecovery?.(msg.payload.claimId, msg.payload.sessionIds);
      break;
    case 'ralph/state':
      ralphStore.applyHostState(msg.payload.runs, msg.payload.activeIds);
      break;
  }
}

function workspaceRootIdentities(folders: readonly WorkspaceFolderContext[]) {
  return new Set(
    folders
      .map((folder) => normalizeWorkspaceIdentity(folder.path))
      .filter((identity): identity is string => identity !== null)
  );
}

function haveSameWorkspaceRoots(
  left: readonly WorkspaceFolderContext[],
  right: readonly WorkspaceFolderContext[]
) {
  const leftIdentities = workspaceRootIdentities(left);
  const rightIdentities = workspaceRootIdentities(right);
  return (
    leftIdentities.size === rightIdentities.size &&
    [...leftIdentities].every((identity) => rightIdentities.has(identity))
  );
}

export function postFocusStateWithDependencies(deps: {
  sendMessage(message: { type: 'webview/focus'; payload: { focused: boolean } }): void;
  isVisible(): boolean;
  hasFocus(): boolean;
}) {
  deps.sendMessage({
    type: 'webview/focus',
    payload: { focused: deps.isVisible() && deps.hasFocus() },
  });
}

export function registerFocusStateTracking(deps: {
  setDocumentVisible(visible: boolean): void;
  postFocusState(): void;
  isLoading(): boolean;
  getActiveSessionId(): string | null;
  recheckSessionStatus(sessionId: string): void;
  refreshProviders(): void;
}) {
  const handleVisibilityChange = () => {
    const visible = document.visibilityState === 'visible';
    deps.setDocumentVisible(visible);
    deps.postFocusState();
    if (visible) deps.refreshProviders();

    const sessionId = deps.getActiveSessionId();
    if (visible && deps.isLoading() && sessionId) {
      deps.recheckSessionStatus(sessionId);
    }
  };

  const handleFocus = () => {
    deps.postFocusState();
    deps.refreshProviders();
  };
  const handleBlur = () => deps.postFocusState();

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleFocus);
  window.addEventListener('blur', handleBlur);

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('focus', handleFocus);
    window.removeEventListener('blur', handleBlur);
  };
}
