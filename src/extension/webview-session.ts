/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Webview and OpenCode callbacks cross protocol boundaries and validate values before use. */
import * as vscode from 'vscode';
import type {
  BlockingRequestSnapshot,
  InterruptedSessionSnapshot,
  RecoverySnapshot,
  SessionStateManager,
} from './session-state-manager';
import type { ContextProvider } from './context-provider';
import type { HiddenSessionManager } from './hidden-session-manager';
import type { SidebarProviderBridge } from './sidebar-provider-bridge';
import type { SidebarProviderContextFiles } from './sidebar-provider-context-files';
import type { SessionTrashManager } from './session-trash-manager';
import type { PinnedSessionManager } from './pinned-session-manager';
import { logger } from './logger';
import { parseWebviewMessage } from './util/webview-message';
import { renderEditorWebviewPlaceholderHtml, renderWebviewLoadingHtml } from './webview-html';
import type {
  ExtensionMessage,
  InitialWebviewState,
  ServerStatus,
  WebviewMessage,
  WebviewInstanceContext,
} from '../shared/protocol';
import type { ExtensionConfigState } from '../shared/provider-limit-config';

export type WebviewHost = vscode.WebviewView | vscode.WebviewPanel;

export class WebviewSession {
  public interruptedSessionsForWebview: InterruptedSessionSnapshot[] = [];
  public blockingRequestsForWebview: BlockingRequestSnapshot[] = [];

  private webviewReady = false;
  private pendingInputFocus = false;
  private pendingSearchSessions = false;
  private pendingOpenAttentionSessions = false;
  private pendingOpenCompletedSessions = false;
  private pendingCommands: Array<
    Extract<
      ExtensionMessage,
      {
        type:
          | 'command/new-session'
          | 'command/abort'
          | 'command/switch-session'
          | 'command/open-session';
      }
    >
  > = [];
  private commandStateReady = false;
  private webviewLoadGeneration = 0;
  private webviewRenderGeneration = 0;
  private recoverySnapshotLoad?: Promise<RecoverySnapshot>;
  private themeDisposable?: vscode.Disposable;
  private messageDisposable?: vscode.Disposable;
  private webviewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly bridge: SidebarProviderBridge,
    private readonly sessionState: Pick<
      SessionStateManager,
      | 'clearCompletedInWorkspace'
      | 'consumeRecoverySnapshot'
      | 'isSessionInWorkspace'
      | 'replayBlockingRequests'
    >,
    private readonly sessionTrash: Pick<
      SessionTrashManager,
      'hiddenSessionIds' | 'isHidden' | 'list'
    >,
    private readonly pinnedSessions: Pick<PinnedSessionManager, 'list'>,
    private readonly hiddenSessions: Pick<HiddenSessionManager, 'hiddenSessionIds' | 'isHidden'>,
    private readonly contextProvider: Pick<ContextProvider, 'context' | 'terminalSelection'>,
    private readonly contextFilesState: Pick<
      SidebarProviderContextFiles,
      'getContextFiles' | 'postContextFiles'
    >,
    private readonly deps: {
      handleMessage(message: WebviewMessage): Promise<void>;
      ensureServerStarted(): Promise<unknown>;
      readConfig(): ExtensionConfigState;
      currentTheme(): InitialWebviewState['theme'];
      renderStatus(): ServerStatus;
      handleReadySideEffects(): Promise<void>;
      handleVisibleSideEffects(): Promise<void>;
      updateStatusBarItem(): void;
      postThemeUpdate(): void;
      onHidden(): void;
      resetStatusBarCache(): void;
      queuedMessages(): InitialWebviewState['queuedMessages'];
      sessionPermissionModes(): InitialWebviewState['sessionPermissionModes'];
      sessionSelectedModels(): InitialWebviewState['sessionSelectedModels'];
      sessionPlanState(): InitialWebviewState['sessionPlanState'];
      sessionPlanAgents(): Record<string, string>;
      sessionModelMigrationPending(): boolean;
      modelPreferences(): InitialWebviewState['modelPreferences'];
      modelPreferencesMigrationPending(): boolean;
      editorTabsOpen(): boolean;
      editorSessionIds(): string[];
      permissionAutomation(): NonNullable<InitialWebviewState['permissionAutomation']>;
      draftImages(): InitialWebviewState['clipboardImages'];
      flushPendingServerEvents(): void;
      cancelApiRequestsBeforeGeneration(generation: number): void;
      handleUnavailableSideEffects(): void;
      handleDisposedSideEffects(): void;
      editorContext?(): InitialWebviewState['editorContext'];
    },
    private readonly webviewContext?: WebviewInstanceContext,
    private readonly manageCommandContext = true
  ) {
    this.bridge.onDeliveryFailure(() => {
      this.deliveryRecoveryPending = true;
      this.webviewReady = false;
      this.deps.handleUnavailableSideEffects();
    });
  }

  private getEditorContext() {
    return this.deps.editorContext?.() ?? this.contextProvider.context;
  }

  private deliveryRecoveryPending = false;

  getRequestGeneration() {
    return this.webviewLoadGeneration;
  }

  setInitialRoute(route: WebviewInstanceContext['initialRoute']) {
    if (this.webviewContext?.surface === 'editor') this.webviewContext.initialRoute = route;
  }

  postApiResponse(
    payload: { id: number; data?: unknown; error?: string },
    requestGeneration: number
  ) {
    if (!this.bridge.getView() || requestGeneration !== this.webviewLoadGeneration) return;
    this.deps.flushPendingServerEvents();
    if (this.deliveryRecoveryPending) {
      this.deliveryRecoveryPending = false;
      this.postBootMessages(this.deps.renderStatus());
    }
    this.bridge.post({ type: 'api/response', payload });
  }

  requestInputFocus() {
    this.pendingInputFocus = true;
    this.flushPendingInputFocus();
  }

  searchSessions() {
    this.pendingSearchSessions = true;
    this.flushPendingSearchSessions();
  }

  openAttentionSessions() {
    this.pendingOpenAttentionSessions = true;
    this.flushPendingOpenAttentionSessions();
  }

  openCompletedSessions() {
    this.pendingOpenCompletedSessions = true;
    this.flushPendingOpenCompletedSessions();
  }

  queueCommand(
    message: Extract<
      ExtensionMessage,
      {
        type:
          | 'command/new-session'
          | 'command/abort'
          | 'command/switch-session'
          | 'command/open-session';
      }
    >
  ) {
    this.pendingCommands.push(message);
    this.flushPendingCommands();
  }

  updateCommandState(canAbort: boolean, canSwitchSessions: boolean) {
    this.commandStateReady = true;
    if (this.manageCommandContext) {
      void vscode.commands.executeCommand('setContext', 'varro:canAbortSession', canAbort);
      void vscode.commands.executeCommand(
        'setContext',
        'varro:canSwitchSessions',
        canSwitchSessions
      );
    }
    this.flushPendingCommands();
  }

  async reload() {
    const view = this.bridge.getView();
    if (!view) return;
    await this.resolve(view);
  }

  suspend() {
    if (this.webviewContext?.surface !== 'editor') return;
    const view = this.bridge.getView();
    if (!view) return;
    const nextGeneration = ++this.webviewLoadGeneration;
    this.deps.cancelApiRequestsBeforeGeneration(nextGeneration);
    this.bridge.invalidatePendingDeliveries();
    this.disposeMessageListener();
    this.webviewReady = false;
    this.resetCommandState();
  }

  async resolve(webviewView: WebviewHost) {
    this.deps.handleUnavailableSideEffects();
    this.bridge.setView(webviewView);
    this.webviewReady = false;
    this.resetCommandState();
    const webviewLoadGeneration = ++this.webviewLoadGeneration;
    const webviewRenderGeneration = ++this.webviewRenderGeneration;
    this.deps.cancelApiRequestsBeforeGeneration(webviewLoadGeneration);

    webviewView.webview.options = this.bridge.webviewOptions();
    webviewView.webview.html =
      this.webviewContext?.surface === 'editor'
        ? renderEditorWebviewPlaceholderHtml()
        : renderWebviewLoadingHtml();
    this.disposeWebviewDisposables();

    this.registerMessageListener(webviewView, webviewLoadGeneration);

    this.webviewDisposables.push(
      webviewView.onDidDispose(() => {
        if (this.bridge.getView() === webviewView) {
          const nextGeneration = ++this.webviewLoadGeneration;
          this.deps.cancelApiRequestsBeforeGeneration(nextGeneration);
          this.disposeMessageListener();
          this.bridge.setView(undefined);
          this.webviewReady = false;
          this.resetCommandState();
          this.deps.handleDisposedSideEffects();
          this.deps.updateStatusBarItem();
        }
      })
    );

    void this.renderHtml(webviewRenderGeneration, webviewView)
      .then((html) => {
        if (
          html === undefined ||
          this.bridge.getView() !== webviewView ||
          webviewRenderGeneration !== this.webviewRenderGeneration
        ) {
          return;
        }
        webviewView.webview.html = html;
      })
      .catch((err) => {
        if (
          this.bridge.getView() !== webviewView ||
          webviewRenderGeneration !== this.webviewRenderGeneration
        ) {
          return;
        }
        logger.error(`getHtml failed: ${err instanceof Error ? err.message : String(err)}`);
        this.webviewReady = false;
        this.deps.handleUnavailableSideEffects();
        webviewView.webview.html = '<p>Failed to load Varro webview. Please reload.</p>';
      });

    let wasVisible = webviewView.visible;
    const onDidChangeVisibility =
      'onDidChangeVisibility' in webviewView
        ? webviewView.onDidChangeVisibility.bind(webviewView)
        : (listener: () => void) =>
            webviewView.onDidChangeViewState(() => {
              listener();
            });
    this.webviewDisposables.push(
      onDidChangeVisibility(() => {
        if (webviewView.visible === wasVisible) return;
        wasVisible = webviewView.visible;
        if (webviewView.visible) {
          this.handleVisible();
        } else {
          this.deps.onHidden();
        }
        this.deps.updateStatusBarItem();
      })
    );

    this.themeDisposable?.dispose();
    this.themeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
      this.deps.postThemeUpdate();
    });
  }

  async handleReady() {
    this.bridge.invalidatePendingDeliveries();
    const status = this.deps.renderStatus();
    this.webviewReady = true;
    this.deliveryRecoveryPending = false;
    this.postBootMessages(status, { clearResolvedEmbedded: true });
    this.flushPendingCommands();
    this.handleInterruptedSessionNotification();
    void this.deps.handleReadySideEffects().catch((err) => {
      logger.error(
        `Webview ready side effects failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    void this.deps.ensureServerStarted().catch(() => {});
  }

  resume() {
    if (this.webviewContext?.surface !== 'editor') return;
    const view = this.bridge.getView();
    if (!view) return;
    this.registerMessageListener(view, this.webviewLoadGeneration);
  }

  async deliverInterruptedSessions(claimId: number, sessions: InterruptedSessionSnapshot[]) {
    if (sessions.length === 0 || !this.webviewReady) return false;
    const generation = this.webviewLoadGeneration;
    const view = this.bridge.getView();
    const message = {
      type: 'recovery/interrupted-sessions',
      payload: { claimId, sessionIds: sessions.map((session) => session.id) },
    } satisfies ExtensionMessage;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (
        !this.webviewReady ||
        this.webviewLoadGeneration !== generation ||
        this.bridge.getView() !== view
      ) {
        return false;
      }
      if (await this.bridge.deliver(message)) return true;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.webviewLoadGeneration === generation && this.bridge.getView() === view) {
      this.webviewReady = false;
      this.deps.handleUnavailableSideEffects();
    }
    return false;
  }

  handleVisible() {
    const status = this.deps.renderStatus();
    this.sessionState.clearCompletedInWorkspace(this.getEditorContext().workspacePath);
    this.deliveryRecoveryPending = false;
    this.postBootMessages(status);
    void this.deps.handleVisibleSideEffects().catch((err) => {
      logger.error(
        `Webview visible side effects failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    void this.deps.ensureServerStarted().catch(() => {});
  }

  async dispose() {
    if (this.bridge.getView()) {
      const nextGeneration = ++this.webviewLoadGeneration;
      this.deps.cancelApiRequestsBeforeGeneration(nextGeneration);
      this.webviewRenderGeneration += 1;
    }
    this.webviewReady = false;
    this.resetCommandState();
    this.disposeMessageListener();
    this.disposeWebviewDisposables();
    this.themeDisposable?.dispose();
    this.themeDisposable = undefined;
    this.bridge.setView(undefined);
  }

  private async renderHtml(
    webviewRenderGeneration: number,
    webviewView: WebviewHost
  ): Promise<string | undefined> {
    const recoverySnapshotLoad =
      this.recoverySnapshotLoad ??
      (this.recoverySnapshotLoad = this.sessionState.consumeRecoverySnapshot());
    try {
      const snapshot = await recoverySnapshotLoad;
      if (
        this.bridge.getView() !== webviewView ||
        webviewRenderGeneration !== this.webviewRenderGeneration
      ) {
        return undefined;
      }
      this.commitRecoverySnapshot(snapshot);
      this.deps.updateStatusBarItem();
      return await this.bridge.renderHtml(this.buildInitialState(this.deps.renderStatus()));
    } finally {
      if (this.recoverySnapshotLoad === recoverySnapshotLoad) {
        this.recoverySnapshotLoad = undefined;
      }
    }
  }

  private buildInitialState(serverStatus: ServerStatus): InitialWebviewState {
    const config = this.deps.readConfig();
    const editorContext = this.getEditorContext();
    return {
      webviewContext: this.webviewContext,
      theme: this.deps.currentTheme(),
      serverStatus,
      editorContext,
      terminalSelection: this.contextProvider.terminalSelection,
      droppedFiles: this.contextFilesState.getContextFiles(),
      clipboardImages: this.deps.draftImages(),
      emptyStateLogoUri: this.bridge.emptyStateLogoUri() || '',
      remoteExtensionHost: Boolean(vscode.env?.remoteName),
      showFileDiffs: config.showFileDiffs,
      expandThinking: config.expandThinking,
      showChangedFiles: config.showChangedFiles,
      desktopSessionPaneSide: config.desktopSessionPaneSide,
      defaultPermissionMode: config.defaultPermissionMode,
      chatFontSize: config.chatFontSize,
      chatEditorFontSize: config.chatEditorFontSize,
      chatFontFamily: config.chatFontFamily,
      sessionPermissionModes: this.deps.sessionPermissionModes(),
      sessionSelectedModels: this.deps.sessionSelectedModels(),
      sessionPlanState: this.deps.sessionPlanState(),
      sessionModelMigrationPending: this.deps.sessionModelMigrationPending(),
      modelPreferences: this.deps.modelPreferences(),
      modelPreferencesMigrationPending: this.deps.modelPreferencesMigrationPending(),
      editorTabsOpen: this.deps.editorTabsOpen(),
      editorSessionIds: this.deps.editorSessionIds(),
      permissionAutomation: this.deps.permissionAutomation(),
      interruptedSessionIds: [],
      pendingPermissions: this.blockingRequestsForWebview
        .filter((item) => item.kind === 'permission')
        .filter((item) => !this.isHiddenSession(item.sessionID))
        .filter((item) =>
          this.sessionState.isSessionInWorkspace(item.sessionID, editorContext.workspacePath)
        )
        .map((item) => item.props),
      pendingQuestions: this.blockingRequestsForWebview
        .filter((item) => item.kind === 'question')
        .filter((item) => !this.isHiddenSession(item.sessionID))
        .filter((item) =>
          this.sessionState.isSessionInWorkspace(item.sessionID, editorContext.workspacePath)
        )
        .map((item) => item.props),
      pinnedSessionIds: this.pinnedSessions.list(),
      queuedMessages: this.deps.queuedMessages(),
    };
  }

  private isHiddenSession(sessionID: string) {
    return this.sessionTrash.isHidden(sessionID) || this.hiddenSessions.isHidden(sessionID);
  }

  private postBootMessages(status: ServerStatus, options?: { clearResolvedEmbedded?: boolean }) {
    const editorContext = this.getEditorContext();
    this.bridge.post({ type: 'context/update', payload: editorContext });
    this.bridge.post({
      type: 'terminal-selection/update',
      payload: this.contextProvider.terminalSelection,
    });
    this.contextFilesState.postContextFiles((message) => this.bridge.post(message));
    this.bridge.post({
      type: 'config/update',
      payload: this.deps.readConfig(),
    });
    this.bridge.post({ type: 'server/status', payload: status });
    this.bridge.post({ type: 'theme/update', payload: { theme: this.deps.currentTheme() } });
    this.bridge.post({
      type: 'queued-messages/sync',
      payload: { messages: this.deps.queuedMessages() ?? [] },
    });
    this.bridge.post({
      type: 'permission-modes/sync',
      payload: { modes: this.deps.sessionPermissionModes() ?? {} },
    });
    if (!this.deps.sessionModelMigrationPending()) {
      this.bridge.post({
        type: 'session-models/sync',
        payload: { models: this.deps.sessionSelectedModels() ?? {} },
      });
    }
    this.bridge.post({
      type: 'session-plan-state/sync',
      payload: {
        state: this.deps.sessionPlanState() ?? {},
        agents: this.deps.sessionPlanAgents(),
      },
    });
    if (!this.deps.modelPreferencesMigrationPending()) {
      const modelPreferences = this.deps.modelPreferences();
      if (modelPreferences) {
        this.bridge.post({ type: 'model-preferences/sync', payload: modelPreferences });
      }
    }
    const editorSessionIds = this.deps.editorSessionIds();
    this.bridge.post({
      type: 'editor-tabs/state',
      payload: { open: this.deps.editorTabsOpen(), sessionIds: editorSessionIds },
    });
    this.bridge.post({
      type: 'permission-automation/update',
      payload: this.deps.permissionAutomation(),
    });
    this.sessionState.replayBlockingRequests(
      this.bridge.post.bind(this.bridge),
      new Set([...this.sessionTrash.hiddenSessionIds(), ...this.hiddenSessions.hiddenSessionIds()]),
      {
        previousRequests: this.blockingRequestsForWebview,
        clearResolvedEmbedded: options?.clearResolvedEmbedded,
        workspacePath: editorContext.workspacePath,
      }
    );
    this.flushPendingInputFocus();
    this.flushPendingSearchSessions();
    this.flushPendingOpenAttentionSessions();
    this.flushPendingOpenCompletedSessions();
  }

  private commitRecoverySnapshot(snapshot: RecoverySnapshot) {
    this.interruptedSessionsForWebview = snapshot.interruptedSessions;
    this.blockingRequestsForWebview = snapshot.blockingRequests;
    this.deps.resetStatusBarCache();
  }

  private handleInterruptedSessionNotification() {
    if (this.interruptedSessionsForWebview.length === 0) return;
    this.interruptedSessionsForWebview = [];
  }

  private flushPendingInputFocus() {
    if (!this.pendingInputFocus || !this.bridge.isVisible() || !this.webviewReady) return;
    this.pendingInputFocus = false;
    this.bridge.post({ type: 'command/focus-input' });
  }

  private flushPendingOpenAttentionSessions() {
    if (!this.pendingOpenAttentionSessions || !this.bridge.isVisible() || !this.webviewReady)
      return;
    this.pendingOpenAttentionSessions = false;
    this.bridge.post({ type: 'command/open-attention-sessions' });
  }

  private flushPendingOpenCompletedSessions() {
    if (!this.pendingOpenCompletedSessions || !this.bridge.isVisible() || !this.webviewReady)
      return;
    this.pendingOpenCompletedSessions = false;
    this.bridge.post({ type: 'command/open-completed-sessions' });
  }

  private flushPendingSearchSessions() {
    if (!this.pendingSearchSessions || !this.bridge.isVisible() || !this.webviewReady) return;
    this.pendingSearchSessions = false;
    this.bridge.post({ type: 'command/search-sessions' });
  }

  private flushPendingCommands() {
    if (!this.bridge.getView() || !this.webviewReady || !this.commandStateReady) return;
    const commands = this.pendingCommands.splice(0);
    for (const command of commands) this.bridge.post(command);
  }

  private resetCommandState() {
    this.commandStateReady = false;
    if (!this.manageCommandContext) return;
    void vscode.commands.executeCommand('setContext', 'varro:canAbortSession', false);
    void vscode.commands.executeCommand('setContext', 'varro:canSwitchSessions', false);
  }

  private registerMessageListener(webviewView: WebviewHost, generation: number) {
    this.disposeMessageListener();
    this.messageDisposable = webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      if (this.bridge.getView() !== webviewView || generation !== this.webviewLoadGeneration)
        return;
      const message = parseWebviewMessage(raw);
      if (!message) {
        logger.warn('Ignoring invalid webview message');
        return;
      }
      void this.deps.handleMessage(message);
    });
  }

  private disposeMessageListener() {
    this.messageDisposable?.dispose();
    this.messageDisposable = undefined;
  }

  private disposeWebviewDisposables() {
    for (const disposable of this.webviewDisposables) disposable.dispose();
    this.webviewDisposables = [];
  }
}
