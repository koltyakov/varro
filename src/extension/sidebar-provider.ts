import * as vscode from 'vscode';
import { statSync } from 'fs';
import { basename, dirname } from 'path';
import type { DroppedFile, ExtensionMessage, WebviewMessage } from '../shared/protocol';
import { AutoApproveJudge } from './auto-approve-judge';
import type { ContextProvider } from './context-provider';
import { DroppedFilesService } from './dropped-files-service';
import { FileSearchService } from './file-search-service';
import { HiddenSessionManager } from './hidden-session-manager';
import { HostPersistence } from './host-persistence';
import { MessageRouter } from './message-router';
import { getOpenCodeConfigPath } from './open-code-process';
import { readExtensionConfigState } from './provider-limit-config';
import { ProviderLimitService } from './provider-limit-service';
import { RestProxy } from './rest-proxy';
import type { OpenCodeServer } from './server';
import { ServerEventBridge } from './server-event-bridge';
import { SessionExportService } from './session-export-service';
import { SessionStateManager } from './session-state-manager';
import { SessionTrashManager } from './session-trash-manager';
import { createSidebarProviderActions } from './sidebar-provider-actions';
import { SidebarProviderBridge } from './sidebar-provider-bridge';
import { SidebarProviderContextFiles } from './sidebar-provider-context-files';
import { SidebarProviderRuntime } from './sidebar-provider-runtime';
import { getOpenCodeAuthFilePath } from './util/provider-limit';
import { WebviewSession } from './webview-session';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'varro.chat';
  private static readonly EXPORT_TIMEOUT_MS = 30_000;
  private static readonly RECYCLE_BIN_CLEANUP_INTERVAL_MS = 60_000;

  private lastStatusBarStateKey = '';
  private readonly fileSearch: FileSearchService;
  private readonly sessionState: SessionStateManager;
  private readonly sessionTrash: SessionTrashManager;
  private readonly hiddenSessions: HiddenSessionManager;
  private readonly autoApproveJudge: AutoApproveJudge;
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
  private readonly configDisposable: vscode.Disposable;
  private readonly windowStateDisposable: vscode.Disposable;
  private providerConfigWatcher: vscode.FileSystemWatcher | null = null;
  private providerAuthWatcher: vscode.FileSystemWatcher | null = null;
  private providerRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private providerFilesSignature = this.readProviderFilesSignature();
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
    private readonly simulateNoProviders = false
  ) {
    this.contextProvider = contextProvider;
    const persistence = new HostPersistence(workspaceState);
    this.droppedFilesService = new DroppedFilesService(contextProvider);
    this.fileSearch = new FileSearchService();
    this.providerLimitService = new ProviderLimitService(server);
    this.bridge = new SidebarProviderBridge(extensionUri);
    this.sessionTrash = new SessionTrashManager(persistence);
    this.hiddenSessions = new HiddenSessionManager();
    this.autoApproveJudge = new AutoApproveJudge(server, this.hiddenSessions);
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
      () => this.updateStatusBarItem()
    );

    this.webviewSession = new WebviewSession(
      this.bridge,
      this.sessionState,
      this.sessionTrash,
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
      hiddenSessions: this.hiddenSessions,
      autoApproveJudge: this.autoApproveJudge,
      simulateNoProviders: this.simulateNoProviders,
      getRequestGeneration: () => this.webviewSession.getRequestGeneration(),
      getStatus: () => this.serverEventBridge.getStatus(),
      ensureServerStarted: () => this.runtime.ensureServerStarted(),
      cleanupExpiredRecycleBin: () => this.cleanupExpiredRecycleBin(),
      postApiResponse: (requestGeneration, payload) =>
        this.webviewSession.postApiResponse(payload, requestGeneration),
    });

    this.messageRouter = new MessageRouter(
      createSidebarProviderActions({
        contextProvider,
        webviewSession: {
          setFocus: (focused) => this.webviewSession.setFocus(focused),
        },
        setProviderWatchActive: (active) => this.setProviderWatchActive(active),
        contextFilesState: this.contextFilesState,
        sessionExportService: this.sessionExportService,
        restProxy: this.restProxy,
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
    void this.webviewSession.resolve(webviewView);
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

  requestInputFocus() {
    this.webviewSession.requestInputFocus();
  }

  hasPendingAttention() {
    return this.sessionState.pending.size > 0;
  }

  openAttentionSessions() {
    this.webviewSession.openAttentionSessions();
  }

  async dispose() {
    if (this.providerRefreshTimer) {
      clearTimeout(this.providerRefreshTimer);
      this.providerRefreshTimer = null;
    }
    await this.webviewSession.dispose();
    await this.serverEventBridge.dispose();
    this.configDisposable.dispose();
    this.windowStateDisposable.dispose();
    this.disposeProviderFileWatchers();
    this.fileSearch.dispose();
    await this.droppedFilesService.dispose();
  }

  private createProviderFileWatcher(path: string) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dirname(path)), basename(path))
    );
    watcher.onDidCreate(() => this.scheduleProviderRefresh());
    watcher.onDidChange(() => this.scheduleProviderRefresh());
    watcher.onDidDelete(() => this.scheduleProviderRefresh());
    return watcher;
  }

  private setProviderWatchActive(active: boolean) {
    if (active) {
      if (this.providerConfigWatcher || this.providerAuthWatcher) return;
      this.providerConfigWatcher = this.createProviderFileWatcher(getOpenCodeConfigPath());
      this.providerAuthWatcher = this.createProviderFileWatcher(getOpenCodeAuthFilePath());
      if (this.providerFilesSignature !== this.readProviderFilesSignature()) {
        void this.refreshProviderState();
      } else {
        this.post({ type: 'providers/refresh' });
      }
      return;
    }

    this.disposeProviderFileWatchers();
  }

  private disposeProviderFileWatchers() {
    if (this.providerRefreshTimer) {
      clearTimeout(this.providerRefreshTimer);
      this.providerRefreshTimer = null;
    }
    this.providerConfigWatcher?.dispose();
    this.providerAuthWatcher?.dispose();
    this.providerConfigWatcher = null;
    this.providerAuthWatcher = null;
  }

  private scheduleProviderRefresh() {
    if (this.providerRefreshTimer) clearTimeout(this.providerRefreshTimer);
    this.providerRefreshTimer = setTimeout(() => {
      this.providerRefreshTimer = null;
      void this.refreshProviderState();
    }, 250);
  }

  private async refreshProviderState() {
    this.providerLimitService.clearCache();
    if (this.server.status.state === 'running') {
      try {
        await this.server.restart();
      } catch {}
    }
    this.providerFilesSignature = this.readProviderFilesSignature();
    this.post({ type: 'providers/refresh' });
  }

  private readProviderFilesSignature() {
    return [getOpenCodeConfigPath(), getOpenCodeAuthFilePath()]
      .map((path) => {
        try {
          const stat = statSync(path);
          return `${path}:${stat.mtimeMs}:${stat.size}`;
        } catch {
          return `${path}:missing`;
        }
      })
      .join('|');
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
