import * as vscode from 'vscode';
import type { ExtensionMessage, ServerStatus } from '../shared/protocol';
import type { ContextProvider } from './context-provider';
import type { SidebarProviderContextFiles } from './sidebar-provider-context-files';
import type { SidebarProviderPresenter } from './sidebar-provider-presenter';
import type { SidebarProviderUiState } from './sidebar-provider-ui-state';
import type { SessionStateManager } from './session-state-manager';

export class SidebarProviderOrchestrator {
  constructor(
    private readonly contextProvider: ContextProvider,
    private readonly uiState: SidebarProviderUiState,
    private readonly presenter: SidebarProviderPresenter,
    private readonly contextFilesState: SidebarProviderContextFiles,
    private readonly sessionState: SessionStateManager
  ) {}

  postContext(post: (message: ExtensionMessage) => void) {
    post(this.presenter.buildContextMessage());
  }

  postTerminalSelection(
    post: (message: ExtensionMessage) => void,
    selection: { text: string; terminalName: string } | null
  ) {
    post(this.presenter.buildTerminalSelectionMessage(selection));
  }

  postConfigState(post: (message: ExtensionMessage) => void) {
    post(this.presenter.buildConfigMessage());
  }

  postRecycleBinUpdate(post: (message: ExtensionMessage) => void) {
    post(this.presenter.buildRecycleBinMessage());
  }

  postContextFiles(post: (message: ExtensionMessage) => void) {
    this.contextFilesState.postContextFiles(post);
  }

  runInTerminal(command: string, title = 'OpenCode') {
    const text = command.trim();
    if (!text) return;

    const cwd = this.contextProvider.context.workspacePath || undefined;
    const terminal = vscode.window.createTerminal({ name: title, cwd });
    terminal.show(false);
    terminal.sendText(text, true);
  }

  handleReady(
    post: (message: ExtensionMessage) => void,
    status: ServerStatus,
    callbacks: {
      flushPendingInputFocus(): void;
      flushPendingOpenAttentionSessions(): void;
      cleanupExpiredRecycleBin(): Promise<void>;
      ensureServerStarted(): Promise<unknown>;
    }
  ) {
    this.uiState.webviewReady = true;
    this.uiState.webviewHasFocus = false;
    this.postContext(post);
    this.postTerminalSelection(post, this.contextProvider.terminalSelection);
    this.postContextFiles(post);
    this.postConfigState(post);
    this.postRecycleBinUpdate(post);
    post({ type: 'server/status', payload: status });
    post({ type: 'theme/update', payload: { theme: this.uiState.currentTheme() } });
    this.uiState.replayBlockingRequests(post, { clearResolvedEmbedded: true });
    this.sessionState.publishPendingAttention();
    callbacks.flushPendingInputFocus();
    callbacks.flushPendingOpenAttentionSessions();
    this.uiState.showInterruptedSessionNotification();
    void callbacks.cleanupExpiredRecycleBin().catch(() => {});
    void callbacks.ensureServerStarted().catch(() => {});
  }

  postVisibleState(
    post: (message: ExtensionMessage) => void,
    status: ServerStatus,
    callbacks: {
      flushPendingInputFocus(): void;
      flushPendingOpenAttentionSessions(): void;
      cleanupExpiredRecycleBin(): Promise<void>;
      ensureServerStarted(): Promise<unknown>;
    }
  ) {
    this.sessionState.clearCompleted();
    this.postContext(post);
    this.postTerminalSelection(post, this.contextProvider.terminalSelection);
    this.postConfigState(post);
    this.postRecycleBinUpdate(post);
    post({ type: 'server/status', payload: status });
    this.uiState.replayBlockingRequests(post);
    this.sessionState.publishPendingAttention();
    callbacks.flushPendingInputFocus();
    callbacks.flushPendingOpenAttentionSessions();
    void callbacks.cleanupExpiredRecycleBin().catch(() => {});
    void callbacks.ensureServerStarted().catch(() => {});
  }

  onHidden() {
    this.uiState.webviewHasFocus = false;
  }
}
