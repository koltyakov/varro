import * as vscode from 'vscode';
import type {
  BlockingRequestSnapshot,
  InterruptedSessionSnapshot,
  SessionStateManager,
} from './session-state-manager';
import type { ContextProvider } from './context-provider';
import type { HiddenSessionManager } from './hidden-session-manager';
import type { SidebarProviderBridge } from './sidebar-provider-bridge';
import type { SidebarProviderContextFiles } from './sidebar-provider-context-files';
import type { SessionTrashManager } from './session-trash-manager';
import { logger } from './logger';
import { parseWebviewMessage } from './util/webview-message';
import { DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS } from '../shared/provider-limit-config';
import type {
  InitialWebviewState,
  PermissionMode,
  ServerStatus,
  WebviewMessage,
} from '../shared/protocol';

export class WebviewSession {
  public interruptedSessionsForWebview: InterruptedSessionSnapshot[] = [];
  public blockingRequestsForWebview: BlockingRequestSnapshot[] = [];

  private webviewHasFocus = false;
  private webviewReady = false;
  private pendingInputFocus = false;
  private pendingOpenAttentionSessions = false;
  private webviewLoadGeneration = 0;
  private themeDisposable?: vscode.Disposable;
  private webviewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly bridge: SidebarProviderBridge,
    private readonly sessionState: Pick<
      SessionStateManager,
      | 'clearCompleted'
      | 'consumeBlockingRequests'
      | 'consumeInterruptedSessions'
      | 'replayBlockingRequests'
      | 'restoreBlockingRequests'
    >,
    private readonly sessionTrash: Pick<
      SessionTrashManager,
      'hiddenSessionIds' | 'isHidden' | 'list'
    >,
    private readonly hiddenSessions: Pick<HiddenSessionManager, 'hiddenSessionIds' | 'isHidden'>,
    private readonly contextProvider: Pick<ContextProvider, 'context' | 'terminalSelection'>,
    private readonly contextFilesState: Pick<
      SidebarProviderContextFiles,
      'getContextFiles' | 'postContextFiles'
    >,
    private readonly deps: {
      handleMessage(message: WebviewMessage): Promise<void>;
      ensureServerStarted(): Promise<unknown>;
      readConfig(): {
        expandThinkingByDefault: boolean;
        showStickyUserPrompt: boolean;
        desktopSessionPaneSide: 'left' | 'right';
        defaultPermissionMode: PermissionMode;
        providerLimitPollIntervalSeconds: number;
        providerLimitThresholdPercent: number;
        providerLimitsDisabled?: boolean;
      };
      currentTheme(): InitialWebviewState['theme'];
      renderStatus(): ServerStatus;
      handleReadySideEffects(): Promise<void>;
      handleVisibleSideEffects(): Promise<void>;
      updateStatusBarItem(): void;
      postThemeUpdate(): void;
      onHidden(): void;
      resetStatusBarCache(): void;
    }
  ) {}

  getRequestGeneration() {
    return this.webviewLoadGeneration;
  }

  postApiResponse(
    payload: { id: number; data?: unknown; error?: string },
    requestGeneration: number
  ) {
    if (!this.bridge.getView() || requestGeneration !== this.webviewLoadGeneration) return;
    this.bridge.post({ type: 'api/response', payload });
  }

  setFocus(focused: boolean) {
    this.webviewHasFocus = focused;
  }

  requestInputFocus() {
    this.pendingInputFocus = true;
    this.flushPendingInputFocus();
  }

  openAttentionSessions() {
    this.pendingOpenAttentionSessions = true;
    this.flushPendingOpenAttentionSessions();
  }

  async resolve(webviewView: vscode.WebviewView) {
    this.bridge.setView(webviewView);
    this.webviewReady = false;
    const webviewLoadGeneration = ++this.webviewLoadGeneration;

    webviewView.webview.options = this.bridge.webviewOptions();
    this.disposeWebviewDisposables();

    this.webviewDisposables.push(
      webviewView.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseWebviewMessage(raw);
        if (!message) {
          logger.warn('Ignoring invalid webview message');
          return;
        }
        void this.deps.handleMessage(message);
      })
    );

    this.webviewDisposables.push(
      webviewView.onDidDispose(() => {
        if (this.bridge.getView() === webviewView) {
          this.bridge.setView(undefined);
          this.webviewReady = false;
          this.webviewHasFocus = false;
          this.deps.updateStatusBarItem();
        }
      })
    );

    void this.renderHtml()
      .then((html) => {
        if (
          this.bridge.getView() !== webviewView ||
          webviewLoadGeneration !== this.webviewLoadGeneration
        ) {
          return;
        }
        webviewView.webview.html = html;
      })
      .catch((err) => {
        if (
          this.bridge.getView() !== webviewView ||
          webviewLoadGeneration !== this.webviewLoadGeneration
        ) {
          return;
        }
        logger.error(`getHtml failed: ${err instanceof Error ? err.message : String(err)}`);
        webviewView.webview.html = '<p>Failed to load Varro webview. Please reload.</p>';
      });

    this.webviewDisposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.handleVisible();
        } else {
          this.webviewHasFocus = false;
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
    const status = this.deps.renderStatus();
    this.webviewReady = true;
    this.webviewHasFocus = false;
    this.postBootMessages(status, { clearResolvedEmbedded: true });
    this.handleInterruptedSessionNotification();
    void this.deps.handleReadySideEffects().catch(() => {});
    void this.deps.ensureServerStarted().catch(() => {});
  }

  handleVisible() {
    const status = this.deps.renderStatus();
    this.sessionState.clearCompleted();
    this.postBootMessages(status);
    void this.deps.handleVisibleSideEffects().catch(() => {});
    void this.deps.ensureServerStarted().catch(() => {});
  }

  async dispose() {
    this.webviewReady = false;
    this.disposeWebviewDisposables();
    this.themeDisposable?.dispose();
    this.themeDisposable = undefined;
    this.bridge.setView(undefined);
  }

  private async renderHtml() {
    const [interruptedSessions, blockingRequests] = await Promise.all([
      this.sessionState.consumeInterruptedSessions(),
      this.sessionState.consumeBlockingRequests(),
    ]);
    this.restoreBlockingState(interruptedSessions, blockingRequests);
    this.deps.updateStatusBarItem();
    return this.bridge.renderHtml(this.buildInitialState(this.deps.renderStatus()));
  }

  private buildInitialState(serverStatus: ServerStatus): InitialWebviewState {
    const config = this.deps.readConfig();
    return {
      theme: this.deps.currentTheme(),
      serverStatus,
      editorContext: this.contextProvider.context,
      terminalSelection: this.contextProvider.terminalSelection,
      droppedFiles: this.contextFilesState.getContextFiles(),
      emptyStateLogoUri: this.bridge.emptyStateLogoUri() || '',
      expandThinkingByDefault: config.expandThinkingByDefault,
      showStickyUserPrompt: config.showStickyUserPrompt,
      desktopSessionPaneSide: config.desktopSessionPaneSide,
      defaultPermissionMode: config.defaultPermissionMode,
      providerLimitPollIntervalSeconds: config.providerLimitPollIntervalSeconds,
      providerLimitThresholdPercent: config.providerLimitThresholdPercent,
      providerLimitsDisabled:
        config.providerLimitPollIntervalSeconds === DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS,
      interruptedSessionIds: this.interruptedSessionsForWebview.map((item) => item.id),
      pendingPermissions: this.blockingRequestsForWebview
        .filter((item) => item.kind === 'permission')
        .filter((item) => !this.isHiddenSession(item.sessionID))
        .map((item) => item.props),
      pendingQuestions: this.blockingRequestsForWebview
        .filter((item) => item.kind === 'question')
        .filter((item) => !this.isHiddenSession(item.sessionID))
        .map((item) => item.props),
    };
  }

  private isHiddenSession(sessionID: string) {
    return this.sessionTrash.isHidden(sessionID) || this.hiddenSessions.isHidden(sessionID);
  }

  private postBootMessages(status: ServerStatus, options?: { clearResolvedEmbedded?: boolean }) {
    this.bridge.post({ type: 'context/update', payload: this.contextProvider.context });
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
    this.sessionState.replayBlockingRequests(
      this.bridge.post.bind(this.bridge),
      new Set([...this.sessionTrash.hiddenSessionIds(), ...this.hiddenSessions.hiddenSessionIds()]),
      {
        previousRequests: this.blockingRequestsForWebview,
        clearResolvedEmbedded: options?.clearResolvedEmbedded,
      }
    );
    this.flushPendingInputFocus();
    this.flushPendingOpenAttentionSessions();
  }

  private restoreBlockingState(
    interruptedSessions: InterruptedSessionSnapshot[],
    blockingRequests: BlockingRequestSnapshot[]
  ) {
    this.interruptedSessionsForWebview = interruptedSessions;
    this.blockingRequestsForWebview = blockingRequests;
    this.sessionState.restoreBlockingRequests(blockingRequests);
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

  private disposeWebviewDisposables() {
    for (const disposable of this.webviewDisposables) disposable.dispose();
    this.webviewDisposables = [];
  }
}
