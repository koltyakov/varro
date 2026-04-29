import type * as vscode from 'vscode';
import type {
  DroppedFile,
  ExtensionMessage,
  ServerStatus,
  WebviewMessage,
} from '../shared/protocol';
import type { SidebarProviderBridge } from './sidebar-provider-bridge';
import type { SidebarProviderCommands } from './sidebar-provider-commands';
import type { SidebarProviderCoordinator } from './sidebar-provider-coordinator';
import type { SidebarProviderContextFiles } from './sidebar-provider-context-files';
import type { SidebarProviderLifecycle } from './sidebar-provider-lifecycle';
import type { SidebarProviderOrchestrator } from './sidebar-provider-orchestrator';
import type { SidebarProviderPresenter } from './sidebar-provider-presenter';
import type { SidebarProviderRuntime } from './sidebar-provider-runtime';
import { setupSidebarProvider } from './sidebar-provider-setup';
import type { SidebarProviderUiState } from './sidebar-provider-ui-state';
import type { FileSearchService } from './file-search-service';
import type { ContextProvider } from './context-provider';
import type { MessageRouter } from './message-router';
import type { OpenCodeServer } from './server';
import type { RestProxy } from './rest-proxy';
import type { SessionExportService } from './session-export-service';
import type { SessionStateManager } from './session-state-manager';
import type { SessionTrashManager } from './session-trash-manager';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'varro.chat';
  private static readonly EXPORT_TIMEOUT_MS = 30_000;
  private static readonly RECYCLE_BIN_CLEANUP_INTERVAL_MS = 60_000;
  private view?: vscode.WebviewView;
  private _status: ServerStatus = { state: 'stopped' };
  private themeDisposable?: vscode.Disposable;
  private configDisposable?: vscode.Disposable;
  private readonly fileSearch: FileSearchService;
  private readonly sessionState: SessionStateManager;
  private readonly sessionTrash: SessionTrashManager;
  private webviewDisposables: vscode.Disposable[] = [];
  private windowStateDisposable?: vscode.Disposable;
  private webviewLoadGeneration = 0;
  private readonly messageRouter: MessageRouter;
  private readonly restProxy: RestProxy;
  private readonly sessionExportService: SessionExportService;
  private readonly uiState: SidebarProviderUiState;
  private readonly contextFilesState: SidebarProviderContextFiles;
  private readonly bridge: SidebarProviderBridge;
  private readonly commands: SidebarProviderCommands;
  private readonly lifecycle: SidebarProviderLifecycle;
  private readonly orchestrator: SidebarProviderOrchestrator;
  private readonly presenter: SidebarProviderPresenter;
  private readonly runtime: SidebarProviderRuntime;
  private readonly coordinator: SidebarProviderCoordinator;

  get blockingRequestsForWebview() {
    return this.uiState.blockingRequestsForWebview;
  }

  set blockingRequestsForWebview(value) {
    this.uiState.blockingRequestsForWebview = value;
  }

  get interruptedSessionsForWebview() {
    return this.uiState.interruptedSessionsForWebview;
  }

  set interruptedSessionsForWebview(value) {
    this.uiState.interruptedSessionsForWebview = value;
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    workspaceState: vscode.Memento,
    contextProvider: ContextProvider,
    server: OpenCodeServer,
    private readonly simulateNoProviders = false
  ) {
    const setup = setupSidebarProvider({
      extensionUri: this.extensionUri,
      workspaceState,
      contextProvider,
      server,
      simulateNoProviders: this.simulateNoProviders,
      exportTimeoutMs: SidebarProvider.EXPORT_TIMEOUT_MS,
      recycleBinCleanupIntervalMs: SidebarProvider.RECYCLE_BIN_CLEANUP_INTERVAL_MS,
      callbacks: {
        getView: () => this.view,
        setView: (view) => {
          this.view = view;
        },
        getStatus: () => this._status,
        setStatus: (status) => {
          this._status = status;
        },
        getWebviewLoadGeneration: () => this.webviewLoadGeneration,
        incrementWebviewLoadGeneration: () => ++this.webviewLoadGeneration,
        handleMessage: (message) => this.handleMessage(message),
        renderHtml: () => this.getHtml(),
        post: (message) => this.post(message),
        updateStatusBarItem: () => this.updateStatusBarItem(),
        cleanupExpiredRecycleBin: () => this.cleanupExpiredRecycleBin(),
        ensureServerStarted: () => this.ensureServerStarted(),
        postApiResponse: (requestGeneration, payload) =>
          this.postApiResponse(requestGeneration, payload),
        postRecycleBinUpdate: () => this.postRecycleBinUpdate(),
        handleReadyMessage: () => this.handleReadyMessage(),
        handleDroppedPaths: (paths) => this.handleDroppedPaths(paths),
        handleDroppedContent: (files) => this.handleDroppedContent(files),
        removeContextFile: (path) => this.removeContextFile(path),
        clearContextFiles: () => this.clearContextFiles(),
        pickFiles: () => this.pickFiles(),
        searchFiles: (requestId, query, limit) => this.searchFiles(requestId, query, limit),
        runInTerminal: (command, title) => this.runInTerminal(command, title),
        postContext: () => this.postContext(),
        postTerminalSelection: (selection) => this.postTerminalSelection(selection),
        postConfigState: () => this.postConfigState(),
        getThemeDisposable: () => this.themeDisposable,
        setThemeDisposable: (disposable) => {
          this.themeDisposable = disposable;
        },
        getConfigDisposable: () => this.configDisposable,
        getWindowStateDisposable: () => this.windowStateDisposable,
        disposeWebviewDisposables: () => {
          for (const disposable of this.webviewDisposables) disposable.dispose();
          this.webviewDisposables = [];
        },
      },
    });

    this.fileSearch = setup.fileSearch;
    this.sessionTrash = setup.sessionTrash;
    this.sessionState = setup.sessionState;
    this.uiState = setup.uiState;
    this.commands = setup.commands;
    this.contextFilesState = setup.contextFilesState;
    this.bridge = setup.bridge;
    this.sessionExportService = setup.sessionExportService;
    this.runtime = setup.runtime;
    this.presenter = setup.presenter;
    this.orchestrator = setup.orchestrator;
    this.coordinator = setup.coordinator;
    this.lifecycle = setup.lifecycle;
    this.restProxy = setup.restProxy;
    this.messageRouter = setup.messageRouter;
    this.configDisposable = setup.configDisposable;
    this.windowStateDisposable = setup.windowStateDisposable;

    this.coordinator.attachServerSubscriptions();
  }

  private updateStatusBarItem() {
    this.uiState.updateStatusBarItem(this.coordinator.getStatusBarItem(), this.view);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.lifecycle.resolveWebviewView(
      webviewView,
      () => {
        for (const d of this.webviewDisposables) d.dispose();
        this.webviewDisposables = [];
      },
      (disposable) => {
        this.webviewDisposables.push(disposable);
      },
      this.bridge.webviewOptions()
    );
  }

  private postConfigState() {
    this.orchestrator.postConfigState((message) => this.post(message));
  }

  private async ensureServerStarted() {
    return this.runtime.ensureServerStarted();
  }

  async handleMessage(msg: WebviewMessage) {
    await this.messageRouter.handleMessage(msg);
  }

  private async handleReadyMessage() {
    this.orchestrator.handleReady((message) => this.post(message), this._status, {
      flushPendingInputFocus: () => this.flushPendingInputFocus(),
      flushPendingOpenAttentionSessions: () => this.flushPendingOpenAttentionSessions(),
      cleanupExpiredRecycleBin: () => this.cleanupExpiredRecycleBin(),
      ensureServerStarted: () => this.ensureServerStarted(),
    });
  }

  private postApiResponse(
    requestGeneration: number,
    payload: { id: number; data?: unknown; error?: string }
  ) {
    this.runtime.postApiResponse(
      this.view,
      requestGeneration,
      this.webviewLoadGeneration,
      (message) => this.post(message),
      payload
    );
  }

  private async cleanupExpiredRecycleBin() {
    await this.runtime.cleanupExpiredRecycleBin(this._status, () => this.postRecycleBinUpdate());
  }

  private postRecycleBinUpdate() {
    this.post(this.presenter.buildRecycleBinMessage());
  }

  post(msg: ExtensionMessage) {
    this.bridge.post(this.view, msg);
  }

  async handleDroppedContent(files: Array<{ name: string; content: string; size: number }>) {
    await this.contextFilesState.handleDroppedContent(files, (message) => this.post(message));
  }

  async handleDroppedPaths(paths: string[]) {
    await this.contextFilesState.handleDroppedPaths(paths, (message) => this.post(message));
  }

  setOnContextFilesChanged(fn: () => void) {
    this.contextFilesState.setOnContextFilesChanged(fn);
  }

  removeContextFile(path: string) {
    this.contextFilesState.removeContextFile(path, (message) => this.post(message));
  }

  getContextFiles() {
    return this.contextFilesState.getContextFiles();
  }

  clearContextFiles() {
    this.contextFilesState.clearContextFiles();
  }

  private async pickFiles() {
    await this.contextFilesState.pickFiles((message) => this.post(message));
  }

  private postContext() {
    this.orchestrator.postContext((message) => this.post(message));
  }

  postTerminalSelection(selection: { text: string; terminalName: string } | null) {
    this.orchestrator.postTerminalSelection((message) => this.post(message), selection);
  }

  private runInTerminal(command: string, title = 'OpenCode') {
    this.orchestrator.runInTerminal(command, title);
  }

  private postContextFiles() {
    this.contextFilesState.postContextFiles((message) => this.post(message));
  }

  private searchFiles(requestId: number, query: string, limit = 12) {
    this.fileSearch.search(requestId, query, limit, (result) => {
      this.post({ type: 'files/search-results', payload: result });
    });
  }

  postDroppedFiles(files: Array<Pick<DroppedFile, 'path' | 'relativePath' | 'type'>>) {
    this.contextFilesState.postDroppedFiles(files, (message) => this.post(message));
  }

  postCommand(cmd: 'new-session' | 'abort') {
    this.commands.postCommand((message) => this.post(message), cmd);
  }

  requestInputFocus() {
    this.commands.requestInputFocus(() => this.flushPendingInputFocus());
  }

  hasPendingAttention() {
    return this.commands.hasPendingAttention();
  }

  openAttentionSessions() {
    this.commands.openAttentionSessions(() => this.flushPendingOpenAttentionSessions());
  }

  private flushPendingInputFocus() {
    this.commands.flushPendingInputFocus(this.view, (message) => this.post(message));
  }

  private flushPendingOpenAttentionSessions() {
    this.commands.flushPendingOpenAttentionSessions(this.view, (message) => this.post(message));
  }

  private async getHtml(): Promise<string> {
    const [interruptedSessions, blockingRequests] = await Promise.all([
      this.sessionState.consumeInterruptedSessions(),
      this.sessionState.consumeBlockingRequests(),
    ]);
    this.presenter.restoreBlockingState(interruptedSessions, blockingRequests);
    this.updateStatusBarItem();
    return this.bridge.renderHtml(
      this.view,
      this.presenter.buildInitialState(this._status, this.view)
    );
  }

  async dispose() {
    this.uiState.webviewReady = false;
    await this.coordinator.dispose();
  }
}
