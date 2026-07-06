import type { ExtensionMessage, WebviewThemeKind } from '../../shared/protocol';
import { appStore } from '../lib/stores/app-store';
import { composerStore } from '../lib/stores/composer-store';
import { permissionsStore } from '../lib/stores/permissions-store';
import { ralphStore } from '../lib/stores/ralph-store';
import { sessionStore } from '../lib/stores/session-store';
import { uiStore } from '../lib/stores/ui-store';
import { getWorkspaceStatusEventSummary } from '../lib/client';
import { syncSessionMarkersForWorkspace } from '../lib/state';
import { normalizeProjectPath } from './session/session-lifecycle';

export function createMountBridgeOperations(deps: {
  ensureConnectionInitialized(): void;
  getCurrentWorkspacePath(): string | null;
  setCurrentWorkspacePath(path: string | null): void;
  reloadSessionsForWorkspaceChange(): void;
  isInitialized(): boolean;
  createSession(): void;
  abortSession(): void;
  refreshMcps(): void;
  refreshProviders(): void;
  applyTheme(theme: WebviewThemeKind): void;
}) {
  const handleExtensionMessage = (msg: ExtensionMessage) => {
    handleExtensionMessageWithDependencies(
      {
        setServerStatus: (payload) => appStore.setState('serverStatus', payload),
        clearError: () => uiStore.setError(null),
        ensureConnectionInitialized: deps.ensureConnectionInitialized,
        clearProvidersState: () => {
          appStore.setState('providersLoaded', false);
          appStore.setState('providerLimits', {});
        },
        setTheme: (payload) => {
          uiStore.setTheme(payload.theme);
          deps.applyTheme(payload.theme);
        },
        setConfig: (payload) => {
          uiStore.setExpandThinkingByDefaultPreference(payload.expandThinkingByDefault);
          uiStore.setShowStickyUserPromptPreference(payload.showStickyUserPrompt);
          uiStore.setDesktopSessionPaneSide(payload.desktopSessionPaneSide);
          permissionsStore.setDefaultPermissionModePreference(payload.defaultPermissionMode);
          if (payload.providerLimitThresholdPercent !== undefined) {
            uiStore.setProviderLimitThresholdPercent(payload.providerLimitThresholdPercent);
          }
          if (
            payload.providerLimitsDisabled !== undefined ||
            payload.providerLimitPollIntervalSeconds !== undefined
          ) {
            uiStore.setProviderLimitPollIntervalSeconds(
              payload.providerLimitPollIntervalSeconds !== undefined
                ? payload.providerLimitPollIntervalSeconds
                : payload.providerLimitsDisabled === true
                  ? -1
                  : 120
            );
          }
        },
        getPreviousActiveFilePath: () => appStore.state.editorContext.activeFile?.path ?? null,
        getCurrentWorkspacePath: deps.getCurrentWorkspacePath,
        setCurrentWorkspacePath: deps.setCurrentWorkspacePath,
        setEditorContext: composerStore.setEditorContext,
        rememberCurrentDocumentNavigation: composerStore.rememberCurrentDocumentNavigation,
        syncWorkspaceState: (path) => {
          sessionStore.syncWorkspaceState(path);
          syncSessionMarkersForWorkspace(path);
        },
        reloadSessionsForWorkspaceChange: deps.reloadSessionsForWorkspaceChange,
        isInitialized: deps.isInitialized,
        setTerminalSelection: composerStore.setTerminalSelection,
        addContextFiles: composerStore.addContextFiles,
        removeContextFile: composerStore.removeContextFile,
        createSession: deps.createSession,
        requestComposerFocus: uiStore.requestComposerFocus,
        requestOpenAttentionSessions: uiStore.requestOpenAttentionSessions,
        abortSession: deps.abortSession,
        refreshMcps: deps.refreshMcps,
        refreshProviders: deps.refreshProviders,
        setWorkspaceStatusSummary: (summary) =>
          appStore.setState('workspaceStatusSummary', summary),
        setWorkspaceStatuses: (entries) => appStore.setState('workspaceStatuses', entries),
      },
      msg
    );
  };

  return { handleExtensionMessage };
}

export function handleExtensionMessageWithDependencies(
  deps: {
    setServerStatus(payload: Extract<ExtensionMessage, { type: 'server/status' }>['payload']): void;
    clearError(): void;
    ensureConnectionInitialized(): void;
    clearProvidersState(): void;
    setTheme(payload: Extract<ExtensionMessage, { type: 'theme/update' }>['payload']): void;
    setConfig(payload: Extract<ExtensionMessage, { type: 'config/update' }>['payload']): void;
    getPreviousActiveFilePath(): string | null;
    getCurrentWorkspacePath(): string | null;
    setCurrentWorkspacePath(path: string | null): void;
    setEditorContext(
      payload: Extract<ExtensionMessage, { type: 'context/update' }>['payload']
    ): void;
    rememberCurrentDocumentNavigation(previousPath: string | null, nextPath: string | null): void;
    syncWorkspaceState(path: string | null): void;
    reloadSessionsForWorkspaceChange(): void;
    isInitialized(): boolean;
    setTerminalSelection(
      payload: Extract<ExtensionMessage, { type: 'terminal-selection/update' }>['payload']
    ): void;
    addContextFiles(payload: Extract<ExtensionMessage, { type: 'files/dropped' }>['payload']): void;
    removeContextFile(path: string): void;
    createSession(): void;
    requestComposerFocus(): void;
    requestOpenAttentionSessions(): void;
    abortSession(): void;
    refreshMcps(): void;
    refreshProviders(): void;
    setWorkspaceStatusSummary(summary: ReturnType<typeof getWorkspaceStatusEventSummary>): void;
    setWorkspaceStatuses(
      payload: {
        workspaceID: string;
        status: 'connected' | 'connecting' | 'disconnected' | 'error';
      }[]
    ): void;
  },
  msg: ExtensionMessage
) {
  switch (msg.type) {
    case 'server/status':
      deps.setServerStatus(msg.payload);
      if (msg.payload.state === 'running') {
        deps.clearError();
        deps.ensureConnectionInitialized();
      } else {
        deps.clearProvidersState();
        deps.clearError();
      }
      break;
    case 'theme/update':
      deps.setTheme(msg.payload);
      break;
    case 'config/update':
      deps.setConfig(msg.payload);
      break;
    case 'context/update': {
      const previousActiveFilePath = deps.getPreviousActiveFilePath();
      const nextWorkspacePath = normalizeProjectPath(msg.payload.workspacePath);
      const workspaceChanged = nextWorkspacePath !== deps.getCurrentWorkspacePath();
      deps.setCurrentWorkspacePath(nextWorkspacePath);
      deps.setEditorContext(msg.payload);
      deps.rememberCurrentDocumentNavigation(
        previousActiveFilePath,
        msg.payload.activeFile?.path ?? null
      );
      if (workspaceChanged) {
        deps.syncWorkspaceState(nextWorkspacePath);
      }
      if (workspaceChanged && deps.isInitialized()) {
        deps.reloadSessionsForWorkspaceChange();
      }
      break;
    }
    case 'terminal-selection/update':
      deps.setTerminalSelection(msg.payload);
      break;
    case 'files/dropped':
      deps.addContextFiles(msg.payload);
      break;
    case 'files/removed':
      deps.removeContextFile(msg.payload.path);
      break;
    case 'command/new-session':
      deps.createSession();
      break;
    case 'command/focus-input':
      deps.requestComposerFocus();
      break;
    case 'command/open-attention-sessions':
      deps.requestOpenAttentionSessions();
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
      break;
    case 'providers/refresh':
      deps.refreshProviders();
      break;
    case 'ralph/state':
      ralphStore.applyHostState(msg.payload.runs, msg.payload.activeIds);
      break;
  }
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
