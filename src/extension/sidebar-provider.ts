import * as vscode from 'vscode';
import type { DroppedFile, ExtensionMessage, WebviewMessage } from '../shared/protocol';
import { AutoApproveJudge } from './auto-approve-judge';
import type { ContextProvider } from './context-provider';
import { DroppedFilesService } from './dropped-files-service';
import { FileSearchService } from './file-search-service';
import { HiddenSessionManager } from './hidden-session-manager';
import { HostPersistence } from './host-persistence';
import { logger } from './logger';
import { MessageRouter } from './message-router';
import {
  nodeProviderSignatureFileSystem,
  ProviderFileRefreshController,
} from './provider-file-refresh-controller';
import type { ProviderSignatureFileSystem } from './provider-file-refresh-controller';
import { readExtensionConfigState } from './provider-limit-config';
import { ProviderLimitService } from './provider-limit-service';
import { PinnedSessionManager } from './pinned-session-manager';
import { RalphHost } from './ralph-host';
import { RestProxy } from './rest-proxy';
import type { OpenCodeServer } from './server';
import { ServerEventBridge } from './server-event-bridge';
import { SessionExportService } from './session-export-service';
import { SessionStateManager } from './session-state-manager';
import { SessionTitleFallback } from './session-title-fallback';
import { SessionTrashManager } from './session-trash-manager';
import { createSidebarProviderActions } from './sidebar-provider-actions';
import { SidebarProviderBridge } from './sidebar-provider-bridge';
import { SidebarProviderContextFiles } from './sidebar-provider-context-files';
import { SidebarProviderRuntime } from './sidebar-provider-runtime';
import { WebviewSession } from './webview-session';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'varro.chat';
  private static readonly EXPORT_TIMEOUT_MS = 30_000;
  private static readonly RECYCLE_BIN_CLEANUP_INTERVAL_MS = 60_000;
  private static readonly SESSION_RECONCILE_INTERVAL_MS = 10_000;
  private static readonly SESSION_RECONCILE_GRACE_MS = 10_000;

  private lastStatusBarStateKey = '';
  private readonly fileSearch: FileSearchService;
  private readonly sessionState: SessionStateManager;
  private readonly sessionTrash: SessionTrashManager;
  private readonly pinnedSessions: PinnedSessionManager;
  private readonly hiddenSessions: HiddenSessionManager;
  private readonly autoApproveJudge: AutoApproveJudge;
  private readonly sessionTitleFallback: SessionTitleFallback;
  private readonly ralphHost: RalphHost;
  private readonly messageRouter: MessageRouter;
  private readonly restProxy: RestProxy;
  public readonly sessionExportService: SessionExportService;
  private readonly contextFilesState: SidebarProviderContextFiles;
  private readonly bridge: SidebarProviderBridge;
  private readonly runtime: SidebarProviderRuntime;
  private readonly providerLimitService: ProviderLimitService;
  private readonly webviewSession: WebviewSession;
  private readonly serverEventBridge: ServerEventBridge;
  private readonly droppedFilesService: DroppedFilesService;
  private readonly providerFileRefresh: ProviderFileRefreshController;
  private readonly configDisposable: vscode.Disposable;
  private readonly windowStateDisposable: vscode.Disposable;
  private sessionReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private readonly contextProvider: ContextProvider;

  get view() {
    return this.bridge.getView();
  }

  set view(value) {
    this.bridge.setView(value);
  }

  get blockingRequestsForWebview() {
    return this.webviewSession.blockingRequestsForWebview;
  }

  set blockingRequestsForWebview(value) {
    this.webviewSession.blockingRequestsForWebview = value;
  }

  get interruptedSessionsForWebview() {
    return this.webviewSession.interruptedSessionsForWebview;
  }

  set interruptedSessionsForWebview(value) {
    this.webviewSession.interruptedSessionsForWebview = value;
  }

  constructor(
    extensionUri: vscode.Uri,
    workspaceState: vscode.Memento,
    contextProvider: ContextProvider,
    private readonly server: OpenCodeServer,
    private readonly extensionId: string,
    private readonly simulateNoProviders = false,
    providerSignatureFileSystem: ProviderSignatureFileSystem = nodeProviderSignatureFileSystem
  ) {
    this.contextProvider = contextProvider;
    const persistence = new HostPersistence(workspaceState);
    this.droppedFilesService = new DroppedFilesService(contextProvider);
    this.fileSearch = new FileSearchService();
    this.providerLimitService = new ProviderLimitService(server);
    this.bridge = new SidebarProviderBridge(extensionUri);
    this.sessionTrash = new SessionTrashManager(persistence);
    this.pinnedSessions = new PinnedSessionManager(persistence);
    this.hiddenSessions = new HiddenSessionManager();
    this.autoApproveJudge = new AutoApproveJudge(server, this.hiddenSessions);
    this.sessionTitleFallback = new SessionTitleFallback(server, this.hiddenSessions, () =>
      vscode.workspace
        .getConfiguration('varro')
        .get<boolean>('chat.autoRenameUntitledSessions', true)
    );
    this.sessionState = new SessionStateManager(
      persistence,
      {
        onStatusChange: () => this.updateStatusBarItem(),
      },
      {
        shouldShow: () => !this.bridge.getView()?.visible,
      }
    );
    this.contextFilesState = new SidebarProviderContextFiles(this.droppedFilesService);
    this.sessionExportService = new SessionExportService(server, SidebarProvider.EXPORT_TIMEOUT_MS);
    this.runtime = new SidebarProviderRuntime(
      server,
      this.sessionState,
      this.sessionTrash,
      SidebarProvider.RECYCLE_BIN_CLEANUP_INTERVAL_MS
    );

    this.serverEventBridge = new ServerEventBridge(
      server,
      this.sessionState,
      {
        isHidden: (sessionID) =>
          this.sessionTrash.isHidden(sessionID) || this.hiddenSessions.isHidden(sessionID),
        observeEvent: (event) => this.hiddenSessions.observeEvent(event),
      },
      this.providerLimitService,
      (message) => this.post(message),
      () => this.updateStatusBarItem(),
      { getPath: () => this.contextProvider.context.workspacePath }
    );

    this.webviewSession = new WebviewSession(
      this.bridge,
      this.sessionState,
      this.sessionTrash,
      this.pinnedSessions,
      this.hiddenSessions,
      contextProvider,
      this.contextFilesState,
      {
        handleMessage: (message) => this.handleMessage(message),
        ensureServerStarted: () => this.runtime.ensureServerStarted(),
        readConfig: () => this.readConfig(),
        currentTheme: () => this.currentTheme(),
        renderStatus: () => this.serverEventBridge.getStatus(),
        handleReadySideEffects: () => this.cleanupExpiredRecycleBin(),
        handleVisibleSideEffects: () => this.cleanupExpiredRecycleBin(),
        updateStatusBarItem: () => this.updateStatusBarItem(),
        postThemeUpdate: () =>
          this.post({ type: 'theme/update', payload: { theme: this.currentTheme() } }),
        onHidden: () => undefined,
        resetStatusBarCache: () => {
          this.lastStatusBarStateKey = '';
        },
      }
    );

    this.restProxy = new RestProxy({
      server,
      contextProvider,
      providerLimitService: this.providerLimitService,
      sessionState: this.sessionState,
      sessionTrash: this.sessionTrash,
      pinnedSessions: this.pinnedSessions,
      hiddenSessions: this.hiddenSessions,
      autoApproveJudge: this.autoApproveJudge,
      sessionTitleFallback: this.sessionTitleFallback,
      simulateNoProviders: this.simulateNoProviders,
      getRequestGeneration: () => this.webviewSession.getRequestGeneration(),
      getStatus: () => this.serverEventBridge.getStatus(),
      ensureServerStarted: () => this.runtime.ensureServerStarted(),
      cleanupExpiredRecycleBin: () => this.cleanupExpiredRecycleBin(),
      postApiResponse: (requestGeneration, payload) =>
        this.webviewSession.postApiResponse(payload, requestGeneration),
    });

    this.ralphHost = new RalphHost({
      server,
      contextProvider,
      persistence,
      ensureServerStarted: () => this.runtime.ensureServerStarted(),
      broadcastState: (payload) => this.post({ type: 'ralph/state', payload }),
    });

    this.providerFileRefresh = new ProviderFileRefreshController(
      {
        server,
        hasLocallyActiveWork: () =>
          this.sessionState.busy.size > 0 ||
          this.sessionState.pending.size > 0 ||
          this.ralphHost.getStatePayload().activeIds.length > 0,
        clearProviderLimitCache: () => this.providerLimitService.clearCache(),
        postRefresh: () => this.post({ type: 'providers/refresh' }),
      },
      providerSignatureFileSystem
    );

    this.messageRouter = new MessageRouter(
      createSidebarProviderActions({
        contextProvider,
        extensionId: this.extensionId,
        webviewSession: {
          setFocus: (focused) => this.webviewSession.setFocus(focused),
        },
        setProviderWatchActive: (active) => this.setProviderWatchActive(active),
        contextFilesState: this.contextFilesState,
        sessionExportService: this.sessionExportService,
        restProxy: this.restProxy,
        refreshProviders: () => this.refreshProviderState(),
        postContext: () => this.postContext(),
        postTerminalSelection: (selection) => this.postTerminalSelection(selection),
        postConfigState: () => this.postConfigState(),
        handleReadyMessage: () => this.handleReadyMessage(),
        handleDroppedPaths: (paths) => this.handleDroppedPaths(paths),
        handleDroppedContent: (files) => this.handleDroppedContent(files),
        removeContextFile: (path) => this.removeContextFile(path),
        clearContextFiles: () => this.clearContextFiles(),
        pickFiles: () => this.pickFiles(),
        searchFiles: (requestId, query, limit) => this.searchFiles(requestId, query, limit),
        runInTerminal: (command, title) => this.runInTerminal(command, title),
        handleRalphMessage: (msg) => this.ralphHost.handleMessage(msg),
      })
    );

    this.windowStateDisposable = vscode.window.onDidChangeWindowState(() => {
      this.updateStatusBarItem();
    });
    this.configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('varro.providerLimits.enabledAdapters')) {
        this.providerLimitService.clearCache();
      }
      if (
        event.affectsConfiguration('varro.chat.expandThinkingByDefault') ||
        event.affectsConfiguration('varro.chat.showStickyUserPrompt') ||
        event.affectsConfiguration('varro.chat.desktopSessionPaneSide') ||
        event.affectsConfiguration('varro.chat.defaultPermissionMode') ||
        event.affectsConfiguration('varro.providerLimits.disabled') ||
        event.affectsConfiguration('varro.providerLimits.thresholdPercent') ||
        event.affectsConfiguration('varro.providerLimits.pollIntervalSeconds')
      ) {
        this.postConfigState();
      }
    });

    this.serverEventBridge.attach();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    return this.webviewSession.resolve(webviewView).catch((err) => {
      logger.error(
        `resolveWebviewView failed: ${err instanceof Error ? err.message : String(err)}`
      );
      if (this.bridge.getView() === webviewView) {
        webviewView.webview.html = '<p>Failed to load Varro webview. Please reload.</p>';
      }
    });
  }

  async initializeProviderFileSignature() {
    await this.providerFileRefresh.initializeSignature();
  }

  startProviderFileObservation() {
    this.providerFileRefresh.setActive(true);
  }

  async handleMessage(msg: WebviewMessage) {
    await this.messageRouter.handleMessage(msg);
  }

  post(msg: ExtensionMessage) {
    this.bridge.post(msg);
  }

  setOnContextFilesChanged(fn: () => void) {
    this.contextFilesState.setOnContextFilesChanged(fn);
  }

  getContextFiles() {
    return this.contextFilesState.getContextFiles();
  }

  postDroppedFiles(files: Array<Pick<DroppedFile, 'path' | 'relativePath' | 'type'>>) {
    this.contextFilesState.postDroppedFiles(files, (message) => this.post(message));
  }

  postTerminalSelection(selection: { text: string; terminalName: string } | null) {
    this.post({ type: 'terminal-selection/update', payload: selection });
  }

  postCommand(cmd: 'new-session' | 'abort') {
    this.post({ type: `command/${cmd}` } as ExtensionMessage);
  }

  switchSession(direction: 'previous' | 'next') {
    this.post({ type: 'command/switch-session', payload: { direction } });
  }

  requestInputFocus() {
    this.webviewSession.requestInputFocus();
  }

  searchSessions() {
    this.webviewSession.searchSessions();
  }

  hasPendingAttention() {
    return this.sessionState.pending.size > 0;
  }

  openAttentionSessions() {
    this.webviewSession.openAttentionSessions();
  }

  async dispose() {
    this.providerFileRefresh.beginDispose();
    if (this.sessionReconcileTimer) {
      clearInterval(this.sessionReconcileTimer);
      this.sessionReconcileTimer = null;
    }
    await this.webviewSession.dispose();
    await this.ralphHost.dispose();
    await this.serverEventBridge.dispose();
    this.configDisposable.dispose();
    this.windowStateDisposable.dispose();
    this.providerFileRefresh.dispose();
    this.fileSearch.dispose();
    await this.droppedFilesService.dispose();
  }

  private setProviderWatchActive(active: boolean) {
    this.providerFileRefresh.setActive(active);
  }

  private async refreshProviderState(generation?: number, requireSignatureChange = false) {
    await this.providerFileRefresh.refreshState(generation, requireSignatureChange);
  }

  private async readProviderFilesSignature() {
    return this.providerFileRefresh.readFilesSignature();
  }

  private async handleReadyMessage() {
    await this.webviewSession.handleReady();
  }

  private async cleanupExpiredRecycleBin() {
    await this.runtime.cleanupExpiredRecycleBin(this.serverEventBridge.getStatus());
  }

  private postConfigState() {
    this.post({ type: 'config/update', payload: this.readConfig() });
  }

  private postContext() {
    this.post({ type: 'context/update', payload: this.getEditorContext() });
  }

  private getEditorContext() {
    return this.contextProvider.context;
  }

  private async handleDroppedContent(
    files: Array<{ name: string; content: string; size: number }>
  ) {
    await this.contextFilesState.handleDroppedContent(files, (message) => this.post(message));
  }

  private async handleDroppedPaths(paths: string[]) {
    await this.contextFilesState.handleDroppedPaths(paths, (message) => this.post(message));
  }

  private removeContextFile(path: string) {
    this.contextFilesState.removeContextFile(path, (message) => this.post(message));
  }

  private clearContextFiles() {
    this.contextFilesState.clearContextFiles();
  }

  private async pickFiles() {
    await this.contextFilesState.pickFiles((message) => this.post(message));
  }

  private searchFiles(requestId: number, query: string, limit = 12) {
    this.fileSearch.search(requestId, query, limit, (result) => {
      this.post({ type: 'files/search-results', payload: result });
    });
  }

  private runInTerminal(command: string, title = 'OpenCode') {
    const text = command.trim();
    if (!text) return;

    const cwd = this.contextProvider.context.workspacePath || undefined;
    const terminal = vscode.window.createTerminal({ name: title, cwd });
    terminal.show(false);
    terminal.sendText(text, true);
  }

  private currentTheme() {
    const kind = vscode.window.activeColorTheme.kind;
    switch (kind) {
      case vscode.ColorThemeKind.Light:
        return 'light' as const;
      case vscode.ColorThemeKind.Dark:
        return 'dark' as const;
      case vscode.ColorThemeKind.HighContrast:
        return 'high-contrast' as const;
      case vscode.ColorThemeKind.HighContrastLight:
        return 'high-contrast-light' as const;
      default:
        return 'dark' as const;
    }
  }

  private readConfig() {
    return readExtensionConfigState();
  }

  private updateStatusBarItem() {
    this.updateSessionReconcileTimer();
    const next = this.getStatusBarState();
    const nextKey = JSON.stringify(next);
    if (nextKey === this.lastStatusBarStateKey) return;
    this.lastStatusBarStateKey = nextKey;

    const statusBarItem = this.serverEventBridge.getStatusBarItem();
    if (!next.visible) {
      statusBarItem.hide();
      return;
    }

    statusBarItem.text = next.text;
    statusBarItem.backgroundColor = next.backgroundColor;
    statusBarItem.tooltip = next.tooltip;
    statusBarItem.show();
  }

  /**
   * Starts a periodic reconciliation poll whenever the extension tracks busy
   * sessions and the server is running. This is the fallback that recovers
   * sessions whose completion event was lost — the webview-side watchdog only
   * runs while the panel is visible, so a hidden webview would never recover.
   * The poll asks the server (authoritative) which sessions are idle and, for
   * any that disagree with our busy set past the grace window, posts a
   * synthetic `session.idle` so the webview converges.
   */
  private updateSessionReconcileTimer() {
    const shouldRun =
      this.sessionState.busy.size > 0 && this.serverEventBridge.getStatus().state === 'running';
    if (shouldRun && !this.sessionReconcileTimer) {
      this.sessionReconcileTimer = setInterval(
        () => void this.runSessionReconcile(),
        SidebarProvider.SESSION_RECONCILE_INTERVAL_MS
      );
    } else if (!shouldRun && this.sessionReconcileTimer) {
      clearInterval(this.sessionReconcileTimer);
      this.sessionReconcileTimer = null;
    }
  }

  private async runSessionReconcile() {
    if (this.sessionState.busy.size === 0) return;
    let serverStatuses: Record<string, unknown>;
    try {
      const result = await this.server.request('GET', '/session/status');
      serverStatuses =
        result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    } catch {
      return;
    }
    const stale = this.sessionState.reconcileStaleBusySessions(
      serverStatuses,
      SidebarProvider.SESSION_RECONCILE_GRACE_MS
    );
    for (const sessionID of stale) {
      this.post({
        type: 'server/event',
        payload: {
          type: 'session.idle',
          properties: { sessionID },
        },
      });
    }
  }

  private getStatusBarState():
    | { visible: false }
    | { visible: true; text: string; tooltip: string; backgroundColor?: vscode.ThemeColor } {
    if (this.bridge.getView()?.visible) {
      return { visible: false };
    }

    const pendingRequests = [...this.sessionState.pending.values()].filter(
      (request) =>
        !this.sessionTrash.isHidden(request.sessionID) &&
        !this.hiddenSessions.isHidden(request.sessionID) &&
        this.sessionState.isSessionInWorkspace(
          request.sessionID,
          this.contextProvider.context.workspacePath
        )
    );
    if (pendingRequests.length > 0) {
      return {
        visible: true,
        text: `$(bell-dot) Varro: ${pendingRequests.length} waiting`,
        backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
        tooltip: [
          'Varro is waiting for your input.',
          ...pendingRequests.slice(0, 3).map((request) => {
            const title = this.sessionState.titleFor(request.sessionID);
            return title ? `${title}: ${request.label}` : request.label;
          }),
          ...(pendingRequests.length > 3 ? [`+${pendingRequests.length - 3} more`] : []),
          '',
          'Click to open chat.',
        ].join('\n'),
      };
    }

    const completedSessions = [...this.sessionState.completed].filter(
      (sessionID) =>
        !this.sessionTrash.isHidden(sessionID) &&
        !this.hiddenSessions.isHidden(sessionID) &&
        this.sessionState.isSessionInWorkspace(
          sessionID,
          this.contextProvider.context.workspacePath
        )
    );
    if (completedSessions.length > 0) {
      return {
        visible: true,
        text: `$(check-all) Varro: ${completedSessions.length} completed`,
        tooltip: [
          'Varro finished background work.',
          ...completedSessions
            .slice(0, 3)
            .map((sessionID) => this.sessionState.titleFor(sessionID) || sessionID),
          ...(completedSessions.length > 3 ? [`+${completedSessions.length - 3} more`] : []),
          '',
          'Click to open chat.',
        ].join('\n'),
      };
    }

    return { visible: false };
  }
}
