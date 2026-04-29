import * as vscode from 'vscode';
import type { ExtensionMessage, ServerStatus, WebviewMessage } from '../shared/protocol';
import type { ContextProvider } from './context-provider';
import { DroppedFilesService } from './dropped-files-service';
import { FileSearchService } from './file-search-service';
import { createSidebarProviderActions } from './sidebar-provider-actions';
import { SidebarProviderBridge } from './sidebar-provider-bridge';
import { SidebarProviderCommands } from './sidebar-provider-commands';
import { SidebarProviderCoordinator } from './sidebar-provider-coordinator';
import { SidebarProviderContextFiles } from './sidebar-provider-context-files';
import {
  createSidebarProviderCoordinatorDeps,
  createSidebarProviderLifecycleDeps,
} from './sidebar-provider-factories';
import { createSidebarProviderHostBindings } from './sidebar-provider-host';
import { SidebarProviderLifecycle } from './sidebar-provider-lifecycle';
import { SidebarProviderOrchestrator } from './sidebar-provider-orchestrator';
import { SidebarProviderPresenter } from './sidebar-provider-presenter';
import { ProviderLimitService } from './provider-limit-service';
import { RestProxy } from './rest-proxy';
import type { OpenCodeServer } from './server';
import { SessionExportService } from './session-export-service';
import { SessionStateManager } from './session-state-manager';
import { SessionTrashManager } from './session-trash-manager';
import { SidebarProviderRuntime } from './sidebar-provider-runtime';
import { SidebarProviderUiState } from './sidebar-provider-ui-state';
import { MessageRouter } from './message-router';

type ApiResponsePayload = { id: number; data?: unknown; error?: string };

export interface SidebarProviderSetupCallbacks {
  getView(): vscode.WebviewView | undefined;
  setView(view: vscode.WebviewView | undefined): void;
  getStatus(): ServerStatus;
  setStatus(status: ServerStatus): void;
  getWebviewLoadGeneration(): number;
  incrementWebviewLoadGeneration(): number;
  handleMessage(message: WebviewMessage): Promise<void>;
  renderHtml(): Promise<string>;
  post(message: ExtensionMessage): void;
  updateStatusBarItem(): void;
  cleanupExpiredRecycleBin(): Promise<void>;
  ensureServerStarted(): Promise<string | undefined>;
  postApiResponse(requestGeneration: number, payload: ApiResponsePayload): void;
  postRecycleBinUpdate(): void;
  handleReadyMessage(): Promise<void>;
  handleDroppedPaths(paths: string[]): Promise<void>;
  handleDroppedContent(
    files: Array<{ name: string; content: string; size: number }>
  ): Promise<void>;
  removeContextFile(path: string): void;
  clearContextFiles(): void;
  pickFiles(): Promise<void>;
  searchFiles(requestId: number, query: string, limit?: number): void;
  runInTerminal(command: string, title?: string): void;
  postContext(): void;
  postTerminalSelection(selection: { text: string; terminalName: string } | null): void;
  postConfigState(): void;
  getThemeDisposable(): vscode.Disposable | undefined;
  setThemeDisposable(disposable: vscode.Disposable | undefined): void;
  getConfigDisposable(): vscode.Disposable | undefined;
  getWindowStateDisposable(): vscode.Disposable | undefined;
  disposeWebviewDisposables(): void;
}

export interface SidebarProviderSetupResult {
  droppedFilesService: DroppedFilesService;
  fileSearch: FileSearchService;
  providerLimitService: ProviderLimitService;
  sessionTrash: SessionTrashManager;
  sessionState: SessionStateManager;
  uiState: SidebarProviderUiState;
  commands: SidebarProviderCommands;
  contextFilesState: SidebarProviderContextFiles;
  bridge: SidebarProviderBridge;
  sessionExportService: SessionExportService;
  runtime: SidebarProviderRuntime;
  presenter: SidebarProviderPresenter;
  orchestrator: SidebarProviderOrchestrator;
  coordinator: SidebarProviderCoordinator;
  lifecycle: SidebarProviderLifecycle;
  restProxy: RestProxy;
  messageRouter: MessageRouter;
  configDisposable: vscode.Disposable;
  windowStateDisposable: vscode.Disposable;
}

export function setupSidebarProvider(options: {
  extensionUri: vscode.Uri;
  workspaceState: vscode.Memento;
  contextProvider: ContextProvider;
  server: OpenCodeServer;
  simulateNoProviders: boolean;
  exportTimeoutMs: number;
  recycleBinCleanupIntervalMs: number;
  callbacks: SidebarProviderSetupCallbacks;
}): SidebarProviderSetupResult {
  const droppedFilesService = new DroppedFilesService(options.contextProvider);
  const fileSearch = new FileSearchService();
  const providerLimitService = new ProviderLimitService(options.server);
  const sessionTrash = new SessionTrashManager(options.workspaceState);
  const sessionState = new SessionStateManager(
    options.workspaceState,
    {
      onPendingAttentionChange: (sessionIds) => {
        options.callbacks.post({
          type: 'pending-attention/update',
          payload: {
            sessionIds: sessionIds.filter((sessionId) => !sessionTrash.isHidden(sessionId)),
          },
        });
      },
      onStatusChange: () => options.callbacks.updateStatusBarItem(),
    },
    {
      shouldShow: () => !options.callbacks.getView()?.visible,
    }
  );
  const uiState = new SidebarProviderUiState(sessionState, sessionTrash);
  const commands = new SidebarProviderCommands(uiState, sessionState);
  const contextFilesState = new SidebarProviderContextFiles(droppedFilesService);
  const bridge = new SidebarProviderBridge(options.extensionUri);
  const sessionExportService = new SessionExportService(options.server, options.exportTimeoutMs);
  const runtime = new SidebarProviderRuntime(
    options.server,
    sessionState,
    sessionTrash,
    options.recycleBinCleanupIntervalMs
  );
  const presenter = new SidebarProviderPresenter(
    uiState,
    options.contextProvider,
    contextFilesState,
    bridge,
    runtime,
    sessionTrash,
    sessionState
  );
  const orchestrator = new SidebarProviderOrchestrator(
    options.contextProvider,
    uiState,
    presenter,
    contextFilesState,
    sessionState
  );
  const coordinator = new SidebarProviderCoordinator(
    createSidebarProviderCoordinatorDeps({
      server: options.server,
      sessionState,
      runtime,
      providerLimitService,
      getStatus: options.callbacks.getStatus,
      setStatus: options.callbacks.setStatus,
      post: options.callbacks.post,
      updateStatusBarItem: options.callbacks.updateStatusBarItem,
      themeDisposable: options.callbacks.getThemeDisposable,
      configDisposable: options.callbacks.getConfigDisposable,
      windowStateDisposable: options.callbacks.getWindowStateDisposable,
      disposeWebviewDisposables: options.callbacks.disposeWebviewDisposables,
      disposeSearch: () => {
        fileSearch.dispose();
      },
      disposeDroppedFiles: () => droppedFilesService.dispose(),
    })
  );
  const lifecycle = new SidebarProviderLifecycle(
    createSidebarProviderLifecycleDeps({
      getView: options.callbacks.getView,
      setView: options.callbacks.setView,
      uiState,
      getWebviewLoadGeneration: options.callbacks.getWebviewLoadGeneration,
      incrementWebviewLoadGeneration: options.callbacks.incrementWebviewLoadGeneration,
      handleMessage: (message) => {
        void options.callbacks.handleMessage(message);
      },
      renderHtml: options.callbacks.renderHtml,
      orchestrator,
      commands,
      contextProvider: options.contextProvider,
      post: options.callbacks.post,
      status: options.callbacks.getStatus,
      updateStatusBarItem: options.callbacks.updateStatusBarItem,
      cleanupExpiredRecycleBin: options.callbacks.cleanupExpiredRecycleBin,
      ensureServerStarted: options.callbacks.ensureServerStarted,
      disposeThemeListener: () => {
        options.callbacks.getThemeDisposable()?.dispose();
      },
      createThemeListener: () => {
        const disposable = vscode.window.onDidChangeActiveColorTheme(() => {
          options.callbacks.post({
            type: 'theme/update',
            payload: { theme: uiState.currentTheme() },
          });
        });
        options.callbacks.setThemeDisposable(disposable);
        return disposable;
      },
    })
  );
  const restProxy = new RestProxy({
    server: options.server,
    contextProvider: options.contextProvider,
    providerLimitService,
    sessionState,
    sessionTrash,
    simulateNoProviders: options.simulateNoProviders,
    getRequestGeneration: options.callbacks.getWebviewLoadGeneration,
    getStatus: options.callbacks.getStatus,
    ensureServerStarted: options.callbacks.ensureServerStarted,
    cleanupExpiredRecycleBin: options.callbacks.cleanupExpiredRecycleBin,
    postApiResponse: options.callbacks.postApiResponse,
    postRecycleBinUpdate: options.callbacks.postRecycleBinUpdate,
  });
  const messageRouter = new MessageRouter(
    createSidebarProviderActions({
      contextProvider: options.contextProvider,
      uiState,
      contextFilesState,
      sessionExportService,
      restProxy,
      postContext: options.callbacks.postContext,
      postTerminalSelection: options.callbacks.postTerminalSelection,
      postConfigState: options.callbacks.postConfigState,
      handleReadyMessage: options.callbacks.handleReadyMessage,
      handleDroppedPaths: options.callbacks.handleDroppedPaths,
      handleDroppedContent: options.callbacks.handleDroppedContent,
      removeContextFile: options.callbacks.removeContextFile,
      clearContextFiles: options.callbacks.clearContextFiles,
      pickFiles: options.callbacks.pickFiles,
      searchFiles: options.callbacks.searchFiles,
      runInTerminal: options.callbacks.runInTerminal,
    })
  );
  const hostBindings = createSidebarProviderHostBindings({
    updateStatusBarItem: options.callbacks.updateStatusBarItem,
    postConfigState: options.callbacks.postConfigState,
  });

  return {
    droppedFilesService,
    fileSearch,
    providerLimitService,
    sessionTrash,
    sessionState,
    uiState,
    commands,
    contextFilesState,
    bridge,
    sessionExportService,
    runtime,
    presenter,
    orchestrator,
    coordinator,
    lifecycle,
    restProxy,
    messageRouter,
    configDisposable: hostBindings.configDisposable,
    windowStateDisposable: hostBindings.windowStateDisposable,
  };
}
