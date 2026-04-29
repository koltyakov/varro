import type { ExtensionMessage, InitialWebviewState, ServerStatus } from '../shared/protocol';
import type { ContextProvider } from './context-provider';
import type { SidebarProviderBridge } from './sidebar-provider-bridge';
import type { SidebarProviderContextFiles } from './sidebar-provider-context-files';
import type { SidebarProviderRuntime } from './sidebar-provider-runtime';
import type { SidebarProviderUiState } from './sidebar-provider-ui-state';
import type { SessionTrashManager } from './session-trash-manager';
import type { SessionStateManager } from './session-state-manager';

export class SidebarProviderPresenter {
  constructor(
    private readonly uiState: SidebarProviderUiState,
    private readonly contextProvider: ContextProvider,
    private readonly contextFilesState: SidebarProviderContextFiles,
    private readonly bridge: SidebarProviderBridge,
    private readonly runtime: SidebarProviderRuntime,
    private readonly sessionTrash: SessionTrashManager,
    private readonly sessionState: SessionStateManager
  ) {}

  buildConfigMessage(): Extract<ExtensionMessage, { type: 'config/update' }> {
    const config = this.uiState.readConfig();
    return {
      type: 'config/update',
      payload: {
        expandThinkingByDefault: config.expandThinkingByDefault,
        showStickyUserPrompt: config.showStickyUserPrompt,
        desktopSessionPaneSide: config.desktopSessionPaneSide,
      },
    };
  }

  buildRecycleBinMessage(): Extract<ExtensionMessage, { type: 'recycle-bin/update' }> {
    return {
      type: 'recycle-bin/update',
      payload: { entries: this.runtime.recycleBinEntries() },
    };
  }

  buildContextMessage(): Extract<ExtensionMessage, { type: 'context/update' }> {
    return { type: 'context/update', payload: this.contextProvider.context };
  }

  buildTerminalSelectionMessage(
    selection: { text: string; terminalName: string } | null
  ): Extract<ExtensionMessage, { type: 'terminal-selection/update' }> {
    return { type: 'terminal-selection/update', payload: selection };
  }

  buildInitialState(
    serverStatus: ServerStatus,
    view: { webview?: unknown } | undefined
  ): InitialWebviewState {
    const config = this.uiState.readConfig();
    return {
      theme: this.uiState.currentTheme(),
      serverStatus,
      editorContext: this.contextProvider.context,
      terminalSelection: this.contextProvider.terminalSelection,
      droppedFiles: this.contextFilesState.getContextFiles(),
      emptyStateLogoUri: this.bridge.emptyStateLogoUri(view as never) || '',
      expandThinkingByDefault: config.expandThinkingByDefault,
      showStickyUserPrompt: config.showStickyUserPrompt,
      desktopSessionPaneSide: config.desktopSessionPaneSide,
      interruptedSessionIds: this.uiState.interruptedSessionsForWebview.map((item) => item.id),
      pendingPermissions: this.uiState.blockingRequestsForWebview
        .filter((item) => item.kind === 'permission')
        .filter((item) => !this.sessionTrash.isHidden(item.sessionID))
        .map((item) => item.props),
      pendingQuestions: this.uiState.blockingRequestsForWebview
        .filter((item) => item.kind === 'question')
        .filter((item) => !this.sessionTrash.isHidden(item.sessionID))
        .map((item) => item.props),
      recycleBinEntries: this.runtime.recycleBinEntries(),
    } satisfies InitialWebviewState;
  }

  restoreBlockingState(
    interruptedSessions: typeof this.uiState.interruptedSessionsForWebview,
    blockingRequests: typeof this.uiState.blockingRequestsForWebview
  ) {
    this.uiState.interruptedSessionsForWebview = interruptedSessions;
    this.uiState.blockingRequestsForWebview = blockingRequests;
    this.sessionState.restoreBlockingRequests(blockingRequests);
    this.sessionState.publishPendingAttention();
  }
}
