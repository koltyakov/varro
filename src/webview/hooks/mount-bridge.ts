import type { ExtensionMessage, WebviewThemeKind } from '../../shared/protocol';
import {
  addContextFiles,
  rememberCurrentDocumentNavigation,
  removeContextFile,
  requestComposerFocus,
  requestOpenAttentionSessions,
  setDesktopSessionPaneSide,
  setError,
  setExpandThinkingByDefaultPreference,
  setRecycleBinEntries,
  setShowStickyUserPromptPreference,
  setState,
  setTheme,
  state,
  syncDraftPermissionForWorkspace,
  syncSessionMarkersForWorkspace,
} from '../lib/state';
import { normalizeProjectPath } from './session-lifecycle';

export function createMountBridgeOperations(deps: {
  ensureConnectionInitialized(): void;
  getCurrentWorkspacePath(): string | null;
  setCurrentWorkspacePath(path: string | null): void;
  reloadSessionsForWorkspaceChange(): void;
  isInitialized(): boolean;
  createSession(): void;
  abortSession(): void;
  refreshMcps(): void;
  applyTheme(theme: WebviewThemeKind): void;
}) {
  const handleExtensionMessage = (msg: ExtensionMessage) => {
    handleExtensionMessageWithDependencies(
      {
        setServerStatus: (payload) => setState('serverStatus', payload),
        clearError: () => setError(null),
        ensureConnectionInitialized: deps.ensureConnectionInitialized,
        clearProvidersState: () => {
          setState('providersLoaded', false);
          setState('providerLimits', {});
        },
        setTheme: (payload) => {
          setTheme(payload.theme);
          deps.applyTheme(payload.theme);
        },
        setConfig: (payload) => {
          setExpandThinkingByDefaultPreference(payload.expandThinkingByDefault);
          setShowStickyUserPromptPreference(payload.showStickyUserPrompt);
          setDesktopSessionPaneSide(payload.desktopSessionPaneSide);
        },
        setPendingAttentionSessionIds: (sessionIds) =>
          setState('pendingAttentionSessionIds', sessionIds),
        getPreviousActiveFilePath: () => state.editorContext.activeFile?.path ?? null,
        getCurrentWorkspacePath: deps.getCurrentWorkspacePath,
        setCurrentWorkspacePath: deps.setCurrentWorkspacePath,
        setEditorContext: (payload) => setState('editorContext', payload),
        rememberCurrentDocumentNavigation,
        syncWorkspaceState: (path) => {
          syncDraftPermissionForWorkspace(path);
          syncSessionMarkersForWorkspace(path);
        },
        reloadSessionsForWorkspaceChange: deps.reloadSessionsForWorkspaceChange,
        isInitialized: deps.isInitialized,
        setTerminalSelection: (payload) => setState('terminalSelection', payload),
        addContextFiles,
        removeContextFile,
        createSession: deps.createSession,
        requestComposerFocus,
        requestOpenAttentionSessions,
        abortSession: deps.abortSession,
        refreshMcps: deps.refreshMcps,
        setRecycleBinEntries,
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
    setPendingAttentionSessionIds(sessionIds: string[]): void;
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
    setRecycleBinEntries(
      entries: Extract<ExtensionMessage, { type: 'recycle-bin/update' }>['payload']['entries']
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
    case 'pending-attention/update':
      deps.setPendingAttentionSessionIds(msg.payload.sessionIds);
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
        msg.payload.type === 'mcp.tools.changed' ||
        msg.payload.type === 'mcp.browser.open.failed'
      ) {
        deps.refreshMcps();
      }
      break;
    case 'recycle-bin/update':
      deps.setRecycleBinEntries(msg.payload.entries);
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
}) {
  const handleVisibilityChange = () => {
    const visible = document.visibilityState === 'visible';
    deps.setDocumentVisible(visible);
    deps.postFocusState();

    const sessionId = deps.getActiveSessionId();
    if (visible && deps.isLoading() && sessionId) {
      deps.recheckSessionStatus(sessionId);
    }
  };

  const handleFocus = () => deps.postFocusState();
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
