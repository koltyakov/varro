/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- VS Code and OpenCode boundary values are validated before provider actions. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Provider responses are parsed before command-specific use. */
import * as vscode from 'vscode';
import { replacesOpenCodeBinary } from '../shared/opencode-install';
import type { OpenCodeModelRouting } from '../shared/opencode-types';
import { getSessionPermissionRulesForMode } from '../shared/permission-rules';
import type {
  ChatModelSelection,
  DroppedFile,
  ExtensionMessage,
  QueuedMessageSnapshot,
  PermissionMode,
  WebviewInstanceContext,
  WebviewMessage,
  WebviewRoute,
} from '../shared/protocol';
import { AutoApproveJudge } from './auto-approve-judge';
import { CommitMessageService } from './commit-message-service';
import type { ContextProvider } from './context-provider';
import { DroppedFilesService } from './dropped-files-service';
import { DraftImageStore } from './draft-image-store';
import { readExtensionConfigState } from './extension-config';
import { readMaximumTestedOpenCodeVersion } from './extension-manifest';
import { FileSearchService } from './file-search-service';
import { GeneratedDependencyTreeGuard } from './generated-dependency-tree-guard';
import { HiddenSessionManager } from './hidden-session-manager';
import { HostPersistence } from './host-persistence';
import { logger } from './logger';
import { MessageRouter } from './message-router';
import {
  nodeProviderSignatureFileSystem,
  ProviderFileRefreshController,
} from './provider-file-refresh-controller';
import type { ProviderSignatureFileSystem } from './provider-file-refresh-controller';
import { ProviderLimitService } from './provider-limit-service';
import { PinnedSessionManager } from './pinned-session-manager';
import { QueuedMessageStore } from './queued-message-store';
import { RalphHost } from './ralph-host';
import { RestProxy } from './rest-proxy';
import type { OpenCodeServer } from './server';
import { ServerEventBridge } from './server-event-bridge';
import { SessionExportService } from './session-export-service';
import { SessionDiffDocumentProvider } from './session-diff-document-provider';
import { ToolOutputDocumentProvider } from './tool-output-document-provider';
import { SessionStateManager } from './session-state-manager';
import { SessionPermissionModeStore } from './session-permission-mode-store';
import { SessionModelSelectionStore } from './session-model-selection-store';
import { SessionTitleFallback } from './session-title-fallback';
import { SessionTrashManager } from './session-trash-manager';
import { createSidebarProviderActions } from './sidebar-provider-actions';
import { SidebarProviderBridge } from './sidebar-provider-bridge';
import { SidebarProviderContextFiles } from './sidebar-provider-context-files';
import { SidebarProviderRuntime } from './sidebar-provider-runtime';
import { WebviewSession } from './webview-session';
import { UsageReportService } from './usage-report-service';
import { resolveServerLaunch } from './util/server-launch';

const maximumTestedOpenCodeVersion = readMaximumTestedOpenCodeVersion();

interface WebviewEndpoint {
  bridge: SidebarProviderBridge;
  contextFilesState: SidebarProviderContextFiles;
  fileSearch: FileSearchService;
  messageRouter: MessageRouter;
  restProxy: RestProxy;
  webviewSession: WebviewSession;
  viewId: string;
  surface: WebviewInstanceContext['surface'];
  route: WebviewRoute;
  ready: boolean;
}

interface EditorEndpoint extends WebviewEndpoint {
  key: string;
  panel: vscode.WebviewPanel;
  route: WebviewRoute;
  restoringSessionId?: string;
  panelDisposables: vscode.Disposable[];
}

interface EndpointRef {
  restProxy?: RestProxy;
}

type PersistedEditorState = Record<string, unknown> | null | undefined;

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'varro.chat';
  public static readonly editorViewType = 'varro.editor';
  private static readonly EXPORT_TIMEOUT_MS = 30_000;
  private static readonly RECYCLE_BIN_CLEANUP_INTERVAL_MS = 60_000;
  private static readonly SESSION_RECONCILE_INTERVAL_MS = 10_000;
  private static readonly SESSION_RECONCILE_GRACE_MS = 10_000;

  private lastStatusBarStateKey = '';
  private activeChatModel: ChatModelSelection | null = null;
  private readonly fileSearch: FileSearchService;
  private readonly sessionState: SessionStateManager;
  private readonly sessionTrash: SessionTrashManager;
  private readonly pinnedSessions: PinnedSessionManager;
  private readonly queuedMessages: QueuedMessageStore;
  private readonly sessionPermissionModes: SessionPermissionModeStore;
  private readonly sessionSelectedModels: SessionModelSelectionStore;
  private readonly draftImages: DraftImageStore;
  private readonly hiddenSessions: HiddenSessionManager;
  private readonly autoApproveJudge: AutoApproveJudge;
  private readonly commitMessageService: CommitMessageService;
  private readonly sessionTitleFallback: SessionTitleFallback;
  private readonly ralphHost: RalphHost;
  private readonly messageRouter: MessageRouter;
  private readonly restProxy: RestProxy;
  public readonly sessionExportService: SessionExportService;
  private readonly usageReportService: UsageReportService;
  private readonly contextFilesState: SidebarProviderContextFiles;
  private readonly bridge: SidebarProviderBridge;
  private readonly runtime: SidebarProviderRuntime;
  private readonly providerLimitService: ProviderLimitService;
  private readonly webviewSession: WebviewSession;
  private readonly serverEventBridge: ServerEventBridge;
  private readonly droppedFilesService: DroppedFilesService;
  private readonly providerFileRefresh: ProviderFileRefreshController;
  private readonly sessionDiffProvider: SessionDiffDocumentProvider;
  private readonly toolOutputProvider: ToolOutputDocumentProvider;
  private readonly configDisposable: vscode.Disposable;
  private readonly windowStateDisposable: vscode.Disposable;
  private sessionReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private mermaidPreviewMaximized = false;
  private mermaidPreviewLayoutQueue: Promise<void> = Promise.resolve();
  private readonly contextProvider: ContextProvider;
  private readonly generatedDependencyTreeGuard: GeneratedDependencyTreeGuard;
  private readonly endpoints = new Set<WebviewEndpoint>();
  private readonly editorPanels = new Map<string, EditorEndpoint>();
  private readonly permissionModeQueues = new Map<string, Promise<unknown>>();
  private permissionAutomationOwnerViewId: string | null = null;
  private permissionAutomationLease = 0;
  private interruptedRecoveryClaim: {
    claimId: number;
    sessionIds: string[];
    viewId: string;
  } | null = null;
  private interruptedRecoveryOwnerViewId: string | null = null;
  private readonly deferredInterruptedRecoveryIds = new Set<string>();
  private nextInterruptedRecoveryClaimId = 0;
  private nextEditorId = 0;
  private disposing = false;

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
    private readonly extensionUri: vscode.Uri,
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
    const isOpenAIPro = async () => {
      const status = await this.providerLimitService.get('openai', null);
      return status.status === 'available' && status.planName?.trim().toLowerCase() === 'pro';
    };
    this.bridge = new SidebarProviderBridge(extensionUri);
    this.sessionTrash = new SessionTrashManager(persistence);
    this.pinnedSessions = new PinnedSessionManager(persistence);
    this.queuedMessages = new QueuedMessageStore(persistence);
    this.sessionPermissionModes = new SessionPermissionModeStore(persistence);
    this.sessionSelectedModels = new SessionModelSelectionStore(persistence);
    this.draftImages = new DraftImageStore(persistence);
    this.hiddenSessions = new HiddenSessionManager();
    this.autoApproveJudge = new AutoApproveJudge(server, this.hiddenSessions, isOpenAIPro, () =>
      vscode.workspace.getConfiguration('varro').get<string>('chat.autoApproveModel', '')
    );
    this.sessionTitleFallback = new SessionTitleFallback(server, this.hiddenSessions, () =>
      vscode.workspace
        .getConfiguration('varro')
        .get<boolean>('chat.autoRenameUntitledSessions', true)
    );
    this.generatedDependencyTreeGuard = new GeneratedDependencyTreeGuard();
    this.sessionState = new SessionStateManager(
      persistence,
      {
        onStatusChange: () => this.updateStatusBarItem(),
      },
      {
        shouldShow: (sessionId) => !this.isSessionAttentionVisible(sessionId),
      }
    );
    this.contextFilesState = new SidebarProviderContextFiles(this.droppedFilesService);
    this.sessionExportService = new SessionExportService(server, SidebarProvider.EXPORT_TIMEOUT_MS);
    this.sessionDiffProvider = new SessionDiffDocumentProvider(server);
    this.toolOutputProvider = new ToolOutputDocumentProvider();
    this.usageReportService = new UsageReportService(
      server,
      () => this.runtime.ensureServerStarted(),
      undefined,
      async (content, title) => {
        const uri = await this.openMarkdownDocument(content, title, false);
        if (!uri) throw new Error('Could not open the generated usage report.');
        return uri;
      }
    );
    this.runtime = new SidebarProviderRuntime(
      server,
      this.sessionState,
      this.sessionTrash,
      SidebarProvider.RECYCLE_BIN_CLEANUP_INTERVAL_MS
    );
    this.commitMessageService = new CommitMessageService(
      server,
      this.hiddenSessions,
      () => this.runtime.ensureServerStarted(),
      () => this.contextProvider.context.workspacePath || undefined,
      () => this.activeChatModel,
      isOpenAIPro,
      () => vscode.workspace.getConfiguration('varro').get<string>('commitMessage.model', '')
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
        persistence,
        clearProviderLimitCache: () => this.providerLimitService.clearCache(),
        postRefresh: (options) =>
          this.post(
            options?.revalidateAuth
              ? { type: 'providers/refresh', payload: { revalidateAuth: true } }
              : { type: 'providers/refresh' }
          ),
        postPendingStatus: (pending) =>
          this.post({ type: 'providers/status', payload: { pending } }),
      },
      providerSignatureFileSystem
    );

    const sidebarEndpoint = this.createEndpoint(this.bridge, this.generatedDependencyTreeGuard, {
      viewId: 'sidebar',
      surface: 'sidebar',
      initialRoute: { type: 'new-session' },
    });
    this.webviewSession = sidebarEndpoint.webviewSession;
    this.restProxy = sidebarEndpoint.restProxy;
    this.messageRouter = sidebarEndpoint.messageRouter;

    this.windowStateDisposable = vscode.window.onDidChangeWindowState(() => {
      this.updateStatusBarItem();
    });
    this.configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('varro.chat.showInlineFileChanges') ||
        event.affectsConfiguration('varro.chat.showChangedFiles') ||
        event.affectsConfiguration('varro.chat.desktopSessionPaneSide') ||
        event.affectsConfiguration('varro.chat.defaultPermissionMode')
      ) {
        this.postConfigState();
      }
    });

    this.serverEventBridge.attach();
  }

  private createEndpoint(
    bridge: SidebarProviderBridge,
    generatedDependencyTreeGuard: GeneratedDependencyTreeGuard,
    webviewContext: WebviewInstanceContext,
    contextFilesState = this.contextFilesState
  ): WebviewEndpoint {
    const endpointRef: EndpointRef & { endpoint?: WebviewEndpoint } = {};
    const post = (message: ExtensionMessage) => bridge.post(message);
    const fileSearch =
      webviewContext.surface === 'sidebar' ? this.fileSearch : new FileSearchService();

    const webviewSession = new WebviewSession(
      bridge,
      this.sessionState,
      this.sessionTrash,
      this.pinnedSessions,
      this.hiddenSessions,
      this.contextProvider,
      contextFilesState,
      {
        handleMessage: (message) => messageRouter.handleMessage(message),
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
        queuedMessages: () => this.queuedMessagesFor(webviewContext.viewId),
        sessionPermissionModes: () => this.sessionPermissionModes.list(),
        sessionSelectedModels: () => this.sessionSelectedModels.list(),
        sessionModelMigrationPending: () => this.sessionSelectedModels.needsMigration(),
        editorTabsOpen: () => this.editorPanels.size > 0,
        editorSessionIds: () => this.visibleEditorSessionIds(),
        permissionAutomation: () => this.permissionAutomationFor(webviewContext.viewId),
        draftImages: () => this.draftImages.list(webviewContext.viewId),
        flushPendingServerEvents: () => this.serverEventBridge.flushPendingEvents(),
        cancelApiRequestsBeforeGeneration: (generation) =>
          endpointRef.restProxy?.cancelRequestsBeforeGeneration(generation),
        handleDisposedSideEffects: () => {
          if (endpointRef.endpoint) this.setEndpointReady(endpointRef.endpoint, false);
        },
        handleUnavailableSideEffects: () => {
          if (endpointRef.endpoint) this.setEndpointReady(endpointRef.endpoint, false);
        },
      },
      webviewContext,
      webviewContext.surface === 'sidebar'
    );

    const restProxy = new RestProxy({
      server: this.server,
      contextProvider: this.contextProvider,
      providerLimitService: this.providerLimitService,
      sessionState: this.sessionState,
      sessionTrash: this.sessionTrash,
      pinnedSessions: this.pinnedSessions,
      hiddenSessions: this.hiddenSessions,
      autoApproveJudge: this.autoApproveJudge,
      sessionTitleFallback: this.sessionTitleFallback,
      simulateNoProviders: this.simulateNoProviders,
      getRequestGeneration: () => webviewSession.getRequestGeneration(),
      getStatus: () => this.serverEventBridge.getStatus(),
      ensureServerStarted: () => this.runtime.ensureServerStarted(),
      confirmPromptAdmission: (workspacePath) =>
        generatedDependencyTreeGuard.confirmPromptAdmission(workspacePath),
      refreshOpenCodeConfig: (previousRouting, currentRouting) =>
        this.refreshOpenCodeWorkspaceState(previousRouting, currentRouting),
      cleanupExpiredRecycleBin: () => this.cleanupExpiredRecycleBin(),
      removeSessionImages: (sessionIds) =>
        this.droppedFilesService.removeSessionOwnedFiles(sessionIds),
      postApiResponse: (requestGeneration, payload) =>
        webviewSession.postApiResponse(payload, requestGeneration),
      isPermissionAutomationLeaseCurrent: (lease) =>
        this.permissionAutomationOwnerViewId === webviewContext.viewId &&
        this.permissionAutomationLease === lease,
      beginQueuedMessageDispatchClaim: async (sessionId, itemId, lease, requestId, messageId) =>
        endpointRef.endpoint?.ready === true &&
        (await this.queuedMessages.beginDispatchAdmission(
          webviewContext.viewId,
          sessionId,
          itemId,
          lease,
          requestId,
          messageId
        )),
      isQueuedMessageDispatchClaimCurrent: (sessionId, itemId, lease, requestId) =>
        endpointRef.endpoint?.ready === true &&
        this.queuedMessages.isDispatchAdmissionCurrent(
          webviewContext.viewId,
          sessionId,
          itemId,
          lease,
          requestId
        ),
      completeQueuedMessageDispatchClaim: async (sessionId, itemId, lease, requestId) => {
        const persistence = this.queuedMessages.completeDispatchAdmission(
          webviewContext.viewId,
          sessionId,
          itemId,
          lease,
          requestId
        );
        if (!persistence) return false;
        this.postQueuedMessageSnapshots();
        await persistence;
        return true;
      },
      releaseQueuedMessageDispatchClaim: (sessionId, itemId, lease, requestId) =>
        this.queuedMessages.releaseDispatchAdmission(
          webviewContext.viewId,
          sessionId,
          itemId,
          lease,
          requestId
        ),
      updatePermissionMode: (sessionID, mode) =>
        this.updateConfirmedPermissionMode(sessionID, mode),
    });
    endpointRef.restProxy = restProxy;

    const messageRouter = new MessageRouter(
      createSidebarProviderActions({
        contextProvider: this.contextProvider,
        extensionId: this.extensionId,
        webviewSession,
        setProviderWatchActive: (active) => this.setProviderWatchActive(active),
        setActiveChatModel: (model) => {
          if (webviewContext.surface === 'sidebar') this.activeChatModel = model;
        },
        revealPermission: (permissionId) => this.revealPermission(permissionId),
        contextFilesState,
        sessionExportService: this.sessionExportService,
        usageReportService: this.usageReportService,
        restProxy,
        sessionDiffProvider: this.sessionDiffProvider,
        toolOutputProvider: this.toolOutputProvider,
        server: this.server,
        post,
        refreshProviders: () => this.refreshProviderState(),
        providerReauthenticated: () => this.providerReauthenticated(),
        postContext: () => post({ type: 'context/update', payload: this.getEditorContext() }),
        postTerminalSelection: (selection) =>
          post({ type: 'terminal-selection/update', payload: selection }),
        postConfigState: () => this.postConfigState(),
        handleReadyMessage: async () => {
          try {
            await webviewSession.handleReady();
            if (endpointRef.endpoint) this.setEndpointReady(endpointRef.endpoint, true);
          } catch (err) {
            if (endpointRef.endpoint) this.setEndpointReady(endpointRef.endpoint, false);
            throw err;
          }
          this.providerFileRefresh.postStatus();
        },
        handleDroppedPaths: (paths) =>
          contextFilesState.handleDroppedPaths(paths, (message) => post(message)),
        handleDroppedContent: (files) =>
          contextFilesState.handleDroppedContent(files, (message) => post(message)),
        storePdf: (payload) => {
          const generation = webviewSession.getRequestGeneration();
          return this.storePdf(payload, post, () =>
            this.isEndpointGenerationAvailable(endpointRef.endpoint, generation)
          );
        },
        storeImage: (payload) => {
          const generation = webviewSession.getRequestGeneration();
          return this.storeImage(payload, post, () =>
            this.isEndpointGenerationAvailable(endpointRef.endpoint, generation)
          );
        },
        releaseImages: (payload) => this.releaseImages(payload),
        removeContextFile: (path) =>
          contextFilesState.removeContextFile(path, (message) => post(message)),
        clearContextFiles: () => contextFilesState.clearContextFiles(),
        pickFiles: () => contextFilesState.pickFiles((message) => post(message)),
        searchFiles: (requestId, query, limit) =>
          this.searchFiles(requestId, query, limit, post, fileSearch),
        runInTerminal: (command, title) => this.runInTerminal(command, title),
        openSessionInTerminal: (sessionId) => this.openSessionInTerminal(sessionId),
        openSessionInEditor: (sessionId, title, model, rootSessionId) =>
          this.openSessionInEditor(sessionId, title, model, rootSessionId),
        openNewEditor: () => this.openNewEditor(),
        editorRouteChanged: (route) => this.editorRouteChanged(webviewContext.viewId, route),
        handleRalphMessage: (msg) => this.ralphHost.handleMessage(msg),
        updateQueuedMessages: ({ messages }) =>
          this.updateQueuedMessages(webviewContext.viewId, messages),
        claimQueuedMessage: (payload) => this.claimQueuedMessage(webviewContext.viewId, payload),
        releaseQueuedMessage: (payload) =>
          this.queuedMessages.releaseDispatchClaim(
            webviewContext.viewId,
            payload.sessionId,
            payload.itemId,
            payload.lease
          ),
        acknowledgeInterruptedSessions: ({ claimId, consumedSessionIds }) =>
          this.acknowledgeInterruptedSessions(webviewContext.viewId, claimId, consumedSessionIds),
        updatePermissionMode: async ({ sessionId, mode }) => {
          const modes = await this.sessionPermissionModes.set(sessionId, mode);
          this.post({ type: 'permission-modes/sync', payload: { modes } });
        },
        migratePermissionModes: async ({ modes: legacyModes }) => {
          const modes = await this.sessionPermissionModes.setIfAbsent(legacyModes);
          this.post({ type: 'permission-modes/sync', payload: { modes } });
        },
        updateSessionModel: async ({ sessionId, model }) => {
          const models = await this.sessionSelectedModels.set(sessionId, model);
          this.post({ type: 'session-models/sync', payload: { models } });
        },
        migrateSessionModels: async ({ models }) => {
          const migrated = await this.sessionSelectedModels.migrateLegacy(models);
          this.post({ type: 'session-models/sync', payload: { models: migrated } });
        },
        updateDraftImages: ({ images }) => this.draftImages.update(images, webviewContext.viewId),
        setMermaidPreviewOpen: (open) => this.setMermaidPreviewOpen(open),
        setActiveRoute: (sessionId) => {
          const endpoint = endpointRef.endpoint;
          if (!endpoint || endpoint.surface !== 'sidebar' || sessionId === undefined) return;
          endpoint.route = sessionId
            ? {
                type: 'session',
                sessionId,
              }
            : { type: 'new-session' };
        },
      })
    );
    const endpoint = {
      bridge,
      contextFilesState,
      fileSearch,
      messageRouter,
      restProxy,
      webviewSession,
      viewId: webviewContext.viewId,
      surface: webviewContext.surface,
      route: webviewContext.initialRoute,
      ready: false,
    };
    endpointRef.endpoint = endpoint;
    this.endpoints.add(endpoint);
    return endpoint;
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

  async openSessionInEditor(
    sessionId: string,
    title?: string,
    model?: ChatModelSelection,
    rootSessionId?: string
  ) {
    if (model) {
      try {
        const models = await this.sessionSelectedModels.setIfAbsent(sessionId, model);
        this.post({ type: 'session-models/sync', payload: { models } });
      } catch (err) {
        logger.warn(
          `Failed to persist editor session model: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const rootId = rootSessionId || this.sessionState.rootSessionIdFor(sessionId);
    const key = `session:${rootId}`;
    const existing = this.editorPanels.get(key);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, false);
      if (existing.route.type !== 'session' || existing.route.sessionId !== sessionId) {
        const nextRoute: WebviewRoute = {
          type: 'session',
          sessionId,
          rootSessionId: rootId,
          title,
        };
        existing.route = nextRoute;
        existing.webviewSession.setInitialRoute(nextRoute);
        existing.panel.title = this.editorTitle(nextRoute);
        existing.webviewSession.queueCommand({
          type: 'command/open-session',
          payload: { sessionId },
        });
      }
      return;
    }
    await this.openEditorPanel({ type: 'session', sessionId, rootSessionId: rootId, title });
  }

  async openNewEditor() {
    await this.openEditorPanel({ type: 'new-session' });
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PersistedEditorState) {
    const route = this.readPersistedEditorRoute(state);
    const viewId = this.readPersistedEditorViewId(state);
    await this.attachEditorPanel(
      panel,
      route,
      viewId ?? `editor-${Date.now()}-${++this.nextEditorId}`
    );
  }

  private async openEditorPanel(route: WebviewRoute) {
    const panel = vscode.window.createWebviewPanel(
      SidebarProvider.editorViewType,
      this.editorTitle(route),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    await this.attachEditorPanel(panel, route, `editor-${Date.now()}-${++this.nextEditorId}`);
  }

  private async attachEditorPanel(panel: vscode.WebviewPanel, route: WebviewRoute, viewId: string) {
    const key = this.editorKey(route, viewId);
    const existing = this.editorPanels.get(key);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, false);
      panel.dispose();
      return;
    }

    panel.title = this.editorTitle(route);
    panel.iconPath = new vscode.ThemeIcon('chat-sparkle');
    const bridge = new SidebarProviderBridge(this.extensionUri);
    const endpoint = this.createEndpoint(
      bridge,
      this.generatedDependencyTreeGuard,
      {
        viewId,
        surface: 'editor',
        initialRoute: route,
      },
      new SidebarProviderContextFiles(this.droppedFilesService)
    );
    const editorEndpoint: EditorEndpoint = {
      ...endpoint,
      key,
      panel,
      route,
      restoringSessionId: route.type === 'session' ? route.sessionId : undefined,
      panelDisposables: [],
    };
    this.editorPanels.set(key, editorEndpoint);
    this.postEditorTabsState();
    let wasVisible = panel.visible;
    const viewStateDisposable = panel.onDidChangeViewState(({ webviewPanel }) => {
      if (this.disposing) return;
      if (webviewPanel.visible === wasVisible) return;
      wasVisible = webviewPanel.visible;
      if (webviewPanel.visible) {
        void endpoint.webviewSession.resolve(webviewPanel);
      } else {
        this.setEndpointReady(endpoint, false);
        endpoint.webviewSession.suspend();
      }
      this.postEditorTabsState();
    });
    const disposeDisposable = panel.onDidDispose(() => {
      if (this.disposing) return;
      let removed = false;
      for (const [registeredKey, registeredEndpoint] of this.editorPanels) {
        if (registeredEndpoint !== editorEndpoint) continue;
        this.editorPanels.delete(registeredKey);
        removed = true;
      }
      if (removed) this.postEditorTabsState();
      this.endpoints.delete(endpoint);
      this.setEndpointReady(endpoint, false);
      endpoint.fileSearch.dispose();
      endpoint.restProxy.dispose();
      void endpoint.webviewSession.dispose();
      for (const disposable of editorEndpoint.panelDisposables) disposable.dispose();
      editorEndpoint.panelDisposables = [];
      void this.transferEditorDraftState(viewId);
    });
    editorEndpoint.panelDisposables.push(viewStateDisposable, disposeDisposable);
    await endpoint.webviewSession.resolve(panel);
    if (!panel.visible) endpoint.webviewSession.suspend();
  }

  private editorRouteChanged(viewId: string, route: WebviewRoute) {
    const endpoint = [...this.editorPanels.values()].find((item) => item.viewId === viewId);
    if (!endpoint) return;
    if (route.type === 'session' && !route.rootSessionId) {
      route = {
        ...route,
        rootSessionId: this.sessionState.rootSessionIdFor(route.sessionId),
      };
    }
    if (endpoint.restoringSessionId) {
      if (route.type === 'session' && route.sessionId === endpoint.restoringSessionId) {
        endpoint.restoringSessionId = undefined;
      } else {
        endpoint.bridge.post({
          type: 'command/open-session',
          payload: { sessionId: endpoint.restoringSessionId },
        });
        return;
      }
    }
    const nextKey = this.editorKey(route, viewId);
    if (nextKey !== endpoint.key) {
      if (this.editorPanels.get(endpoint.key) === endpoint) this.editorPanels.delete(endpoint.key);
      const existing = this.editorPanels.get(nextKey);
      if (existing && existing !== endpoint) {
        existing.panel.reveal(existing.panel.viewColumn, false);
        endpoint.panel.dispose();
        return;
      }
      endpoint.key = nextKey;
      this.editorPanels.set(nextKey, endpoint);
    }
    endpoint.panel.title = this.editorTitle(route);
    endpoint.route = route;
    endpoint.webviewSession.setInitialRoute(route);
    this.postEditorTabsState();
    this.updateStatusBarItem();
  }

  private postEditorTabsState() {
    const sessionIds = this.visibleEditorSessionIds();
    this.post({
      type: 'editor-tabs/state',
      payload: { open: this.editorPanels.size > 0, sessionIds },
    });
  }

  private editorKey(route: WebviewRoute, viewId: string) {
    return route.type === 'session'
      ? `session:${route.rootSessionId || route.sessionId}`
      : `draft:${viewId}`;
  }

  private editorTitle(route: WebviewRoute) {
    if (route.type === 'new-session') return 'Varro: New Session';
    return route.title?.trim() || this.sessionState.titleFor(route.sessionId) || 'Varro: Session';
  }

  private readPersistedEditorRoute(state: PersistedEditorState): WebviewRoute {
    if (!state) return { type: 'new-session' };
    const persisted = state['varro.lastOpenedView'];
    if (!persisted || typeof persisted !== 'object') return { type: 'new-session' };
    const route = persisted as Record<string, unknown>;
    return route.type === 'session' && typeof route.sessionId === 'string'
      ? {
          type: 'session',
          sessionId: route.sessionId,
          rootSessionId: this.sessionState.rootSessionIdFor(route.sessionId),
        }
      : { type: 'new-session' };
  }

  private readPersistedEditorViewId(state: PersistedEditorState) {
    const value = state?.['varro.editorViewId'];
    return typeof value === 'string' && /^editor-[A-Za-z0-9-]+$/.test(value) ? value : null;
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
    for (const endpoint of this.endpoints) endpoint.bridge.post(msg);
    if (msg.type === 'server/event') this.updateEditorPanelTitles();
  }

  private permissionAutomationFor(viewId: string) {
    return {
      owner: this.permissionAutomationOwnerViewId === viewId,
      lease: this.permissionAutomationLease,
    };
  }

  private setEndpointReady(endpoint: WebviewEndpoint, ready: boolean) {
    if (endpoint.ready === ready) return;
    endpoint.ready = ready;
    if (!ready) this.queuedMessages.releaseDispatchClaimsForView(endpoint.viewId);
    if (!this.disposing) this.reconcileQueuedMessageOwners();
    this.reconcilePermissionAutomationOwner();
  }

  private reconcilePermissionAutomationOwner() {
    const current = [...this.endpoints].find(
      (endpoint) => endpoint.ready && endpoint.viewId === this.permissionAutomationOwnerViewId
    );
    const next =
      [...this.endpoints].find((endpoint) => endpoint.ready && endpoint.surface === 'sidebar') ??
      current ??
      [...this.endpoints].find((endpoint) => endpoint.ready);
    const nextViewId = next?.viewId ?? null;
    if (nextViewId === this.permissionAutomationOwnerViewId) return;
    this.permissionAutomationOwnerViewId = nextViewId;
    this.permissionAutomationLease += 1;
    for (const endpoint of this.endpoints) {
      if (!endpoint.ready) continue;
      endpoint.bridge.post({
        type: 'permission-automation/update',
        payload: this.permissionAutomationFor(endpoint.viewId),
      });
    }
    if (next) {
      for (const [permissionId, request] of this.sessionState.pending) {
        if (request.kind !== 'permission') continue;
        next.bridge.post({ type: 'permission/actionable', payload: { permissionId } });
      }
    }
    this.reconcileInterruptedRecoveryOwner(next);
  }

  private reconcileInterruptedRecoveryOwner(owner: WebviewEndpoint | undefined) {
    const ownerViewId = owner?.viewId ?? null;
    if (this.interruptedRecoveryOwnerViewId !== ownerViewId) {
      this.interruptedRecoveryOwnerViewId = ownerViewId;
      this.interruptedRecoveryClaim = null;
      this.deferredInterruptedRecoveryIds.clear();
    }
    if (!owner || this.interruptedRecoveryClaim) return;
    const sessions = this.sessionState
      .claimInterruptedSessions()
      .filter((session) => !this.deferredInterruptedRecoveryIds.has(session.id));
    if (sessions.length === 0) return;
    const claim = {
      claimId: ++this.nextInterruptedRecoveryClaimId,
      sessionIds: sessions.map((session) => session.id),
      viewId: owner.viewId,
    };
    this.interruptedRecoveryClaim = claim;
    void owner.webviewSession.deliverInterruptedSessions(claim.claimId, sessions);
  }

  private async acknowledgeInterruptedSessions(
    viewId: string,
    claimId: number,
    consumedSessionIds: readonly string[]
  ) {
    const claim = this.interruptedRecoveryClaim;
    if (!claim || claim.viewId !== viewId || claim.claimId !== claimId) return;
    const claimSessionIds = new Set(claim.sessionIds);
    const consumed = [...new Set(consumedSessionIds)].filter((id) => claimSessionIds.has(id));
    const consumedSet = new Set(consumed);
    await this.sessionState.acknowledgeInterruptedSessions(consumed);
    this.interruptedRecoveryClaim = null;
    for (const sessionId of claim.sessionIds) {
      if (consumedSet.has(sessionId)) this.deferredInterruptedRecoveryIds.delete(sessionId);
      else this.deferredInterruptedRecoveryIds.add(sessionId);
    }
    const owner = [...this.endpoints].find(
      (endpoint) => endpoint.ready && endpoint.viewId === this.permissionAutomationOwnerViewId
    );
    this.reconcileInterruptedRecoveryOwner(owner);
  }

  private claimQueuedMessage(
    viewId: string,
    payload: Extract<WebviewMessage, { type: 'queued-messages/claim' }>['payload']
  ) {
    const endpoint = [...this.endpoints].find((item) => item.viewId === viewId);
    const claim = endpoint?.ready
      ? this.queuedMessages.claimDispatch(
          viewId,
          payload.sessionId,
          payload.itemId,
          (candidateViewId) => this.isQueueViewEligible(candidateViewId),
          payload.mode
        )
      : null;
    const result: Extract<ExtensionMessage, { type: 'queued-messages/claim-result' }>['payload'] = {
      ...payload,
      granted: claim !== null,
    };
    if (claim) result.lease = claim.lease;
    endpoint?.bridge.post({
      type: 'queued-messages/claim-result',
      payload: result,
    });
  }

  private isQueueViewEligible(viewId: string) {
    return [...this.endpoints].some((endpoint) => endpoint.viewId === viewId && endpoint.ready);
  }

  private revealPermission(permissionId: string) {
    this.sessionState.revealPermission(permissionId);
    const owner = [...this.endpoints].find(
      (endpoint) => endpoint.ready && endpoint.viewId === this.permissionAutomationOwnerViewId
    );
    owner?.bridge.post({ type: 'permission/actionable', payload: { permissionId } });
  }

  private updateConfirmedPermissionMode(sessionID: string, mode: PermissionMode) {
    const previous = this.permissionModeQueues.get(sessionID) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const session = await this.server.request(
          'PATCH',
          `/session/${encodeURIComponent(sessionID)}`,
          { permission: getSessionPermissionRulesForMode(mode, 'update') }
        );
        let modes: Record<string, PermissionMode>;
        try {
          modes = await this.sessionPermissionModes.set(sessionID, mode);
        } catch (err) {
          modes = this.sessionPermissionModes.list();
          logger.warn(
            `Failed to persist confirmed permission mode: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        this.post({ type: 'permission-modes/sync', payload: { modes } });
        return session;
      });
    this.permissionModeQueues.set(sessionID, operation);
    const clearQueue = () => {
      if (this.permissionModeQueues.get(sessionID) === operation) {
        this.permissionModeQueues.delete(sessionID);
      }
    };
    void operation.then(clearQueue, clearQueue);
    return operation;
  }

  private updateEditorPanelTitles() {
    for (const endpoint of this.editorPanels.values()) {
      if (endpoint.route.type !== 'session') continue;
      const title = this.sessionState.titleFor(endpoint.route.sessionId) ?? endpoint.route.title;
      endpoint.route = { ...endpoint.route, title };
      endpoint.panel.title = this.editorTitle(endpoint.route);
    }
  }

  private isSessionAttentionVisible(sessionId: string) {
    const rootSessionId = this.sessionState.rootSessionIdFor(sessionId);
    return [...this.endpoints].some(
      (endpoint) =>
        endpoint.ready &&
        endpoint.bridge.isVisible() &&
        endpoint.route.type === 'session' &&
        (endpoint.route.rootSessionId ||
          this.sessionState.rootSessionIdFor(endpoint.route.sessionId)) === rootSessionId
    );
  }

  private visibleEditorSessionIds() {
    return [
      ...new Set(
        [...this.editorPanels.values()].flatMap((endpoint) =>
          endpoint.panel.visible && endpoint.route.type === 'session'
            ? [endpoint.route.rootSessionId || endpoint.route.sessionId]
            : []
        )
      ),
    ];
  }

  setOnContextFilesChanged(fn: () => void) {
    this.contextFilesState.setOnContextFilesChanged(fn);
  }

  getContextFiles() {
    return this.contextFilesState.getContextFiles();
  }

  postDroppedFiles(files: Array<Pick<DroppedFile, 'path' | 'relativePath' | 'type'>>) {
    this.contextFilesState.postDroppedFiles(files, (message) => this.bridge.post(message));
  }

  postTerminalSelection(selection: { text: string; terminalName: string } | null) {
    this.post({ type: 'terminal-selection/update', payload: selection });
  }

  postCommand(cmd: 'new-session' | 'abort', payload?: { prefill: string }) {
    if (cmd === 'abort') {
      this.webviewSession.queueCommand({ type: 'command/abort' });
      return;
    }
    if (payload) {
      this.webviewSession.queueCommand({ type: 'command/new-session', payload });
    } else {
      this.webviewSession.queueCommand({ type: 'command/new-session' });
    }
  }

  switchSession(direction: 'previous' | 'next') {
    this.webviewSession.queueCommand({
      type: 'command/switch-session',
      payload: { direction },
    });
  }

  requestInputFocus() {
    this.webviewSession.requestInputFocus();
  }

  searchSessions() {
    this.webviewSession.searchSessions();
  }

  async generateCommitMessage(sourceControl?: vscode.SourceControl) {
    await this.commitMessageService.generate(sourceControl);
  }

  async generateUsageReport() {
    await this.usageReportService.openReport(false);
  }

  async openMarkdownDocument(content: string, title: string, show = true) {
    return this.toolOutputProvider.open({
      content,
      title,
      language: 'markdown',
      preview: false,
      show,
    });
  }

  hasPendingAttention() {
    return this.sessionState.pendingForUser.size > 0;
  }

  openAttentionSessions() {
    this.webviewSession.openAttentionSessions();
  }

  async dispose() {
    this.disposing = true;
    this.providerFileRefresh.beginDispose();
    for (const endpoint of this.editorPanels.values()) {
      this.setEndpointReady(endpoint, false);
      for (const disposable of endpoint.panelDisposables) disposable.dispose();
      endpoint.panelDisposables = [];
      endpoint.restProxy.dispose();
      endpoint.fileSearch.dispose();
      await endpoint.webviewSession.dispose();
      this.endpoints.delete(endpoint);
    }
    this.editorPanels.clear();
    this.restProxy.dispose();
    await this.setMermaidPreviewOpen(false);
    if (this.sessionReconcileTimer) {
      clearInterval(this.sessionReconcileTimer);
      this.sessionReconcileTimer = null;
    }
    await this.webviewSession.dispose();
    await this.ralphHost.dispose();
    await this.serverEventBridge.dispose();
    await this.queuedMessages.dispose();
    await this.draftImages.dispose();
    await this.sessionPermissionModes.dispose();
    await this.sessionSelectedModels.dispose();
    this.configDisposable.dispose();
    this.windowStateDisposable.dispose();
    this.providerFileRefresh.dispose();
    this.fileSearch.dispose();
    this.sessionDiffProvider.dispose();
    this.toolOutputProvider.dispose();
    await this.droppedFilesService.dispose();
  }

  private setProviderWatchActive(active: boolean) {
    this.providerFileRefresh.setActive(active);
  }

  private queuedMessagesFor(viewId: string) {
    return this.queuedMessages
      .list()
      ?.filter((message) => (message.ownerViewId ?? 'sidebar') === viewId);
  }

  private postQueuedMessageSnapshots() {
    for (const endpoint of this.endpoints) {
      endpoint.bridge.post({
        type: 'queued-messages/sync',
        payload: { messages: this.queuedMessagesFor(endpoint.viewId) ?? [] },
      });
    }
  }

  private async updateQueuedMessages(viewId: string, messages: QueuedMessageSnapshot[]) {
    const endpoint = [...this.endpoints].find((item) => item.viewId === viewId);
    if (!endpoint?.ready) return;
    const persistence = this.queuedMessages.updateOwned(viewId, messages);
    this.postQueuedMessageSnapshots();
    await persistence;
  }

  private async transferEditorDraftState(viewId: string) {
    const queuedImagePaths = new Set(
      (this.queuedMessages.list() ?? []).flatMap((message) =>
        [...(message.clipboardImages ?? []), ...(message.nativePdfs ?? [])].flatMap((attachment) =>
          attachment.contextFile ? [attachment.contextFile.path] : []
        )
      )
    );
    const imagePaths = this.draftImages
      .list(viewId)
      .flatMap((image) =>
        image.contextFile && !queuedImagePaths.has(image.contextFile.path)
          ? [image.contextFile.path]
          : []
      );
    const persistence = this.draftImages.update([], viewId);
    await Promise.all([persistence, this.droppedFilesService.removeOwnedFiles(imagePaths)]);
  }

  private reconcileQueuedMessageOwners() {
    const eligibleEndpoints = [...this.endpoints].filter((endpoint) => endpoint.ready);
    if (eligibleEndpoints.length === 0) return;
    const target =
      eligibleEndpoints.find((endpoint) => endpoint.surface === 'sidebar') ?? eligibleEndpoints[0]!;
    const eligibleViewIds = new Set(eligibleEndpoints.map((endpoint) => endpoint.viewId));
    const unavailableOwners = new Set(
      (this.queuedMessages.list() ?? [])
        .map((message) => message.ownerViewId ?? 'sidebar')
        .filter((viewId) => !eligibleViewIds.has(viewId))
    );
    if (unavailableOwners.size === 0) return;
    const persistence = Promise.all(
      [...unavailableOwners].map((viewId) =>
        this.queuedMessages.transferOwner(viewId, target.viewId)
      )
    );
    this.postQueuedMessageSnapshots();
    void persistence.catch((err) => {
      logger.warn(
        `Failed to persist queued message ownership transfer: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  private isEndpointGenerationAvailable(endpoint: WebviewEndpoint | undefined, generation: number) {
    return (
      !!endpoint &&
      endpoint.ready &&
      this.endpoints.has(endpoint) &&
      endpoint.webviewSession.getRequestGeneration() === generation
    );
  }

  private async setMermaidPreviewOpen(open: boolean) {
    const operation = this.mermaidPreviewLayoutQueue.then(async () => {
      if (this.mermaidPreviewMaximized === open) return;
      await vscode.commands.executeCommand('workbench.action.toggleMaximizedAuxiliaryBar');
      this.mermaidPreviewMaximized = open;
    });
    this.mermaidPreviewLayoutQueue = operation.catch(() => undefined);
    await operation;
  }

  private async refreshProviderState(generation?: number, requireSignatureChange = false) {
    await this.providerFileRefresh.refreshState(generation, requireSignatureChange);
  }

  private async providerReauthenticated() {
    await this.providerFileRefresh.acknowledgeEmbeddedReauthentication();
  }

  private async refreshOpenCodeWorkspaceState(
    previousRouting?: OpenCodeModelRouting,
    currentRouting?: OpenCodeModelRouting
  ) {
    await this.providerFileRefresh.refreshWorkspaceState(previousRouting, currentRouting);
  }

  private async readProviderFilesSignature() {
    return this.providerFileRefresh.readFilesSignature();
  }

  private async handleReadyMessage() {
    await this.webviewSession.handleReady();
    this.providerFileRefresh.postStatus();
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

  private async storePdf(
    payload: Extract<WebviewMessage, { type: 'pdfs/store' }>['payload'],
    post: (message: ExtensionMessage) => void = (message) => this.post(message),
    isAvailable: () => boolean = () => true
  ) {
    const [contextFile] = await this.droppedFilesService.fromContent([
      { name: payload.name, content: payload.content, size: payload.size },
    ]);
    if (contextFile) {
      if (!isAvailable()) {
        await this.droppedFilesService.removeOwnedFile(contextFile.path);
        return;
      }
      post({ type: 'pdfs/stored', payload: { id: payload.id, contextFile } });
    }
  }

  private async storeImage(
    payload: Extract<WebviewMessage, { type: 'images/store' }>['payload'],
    post: (message: ExtensionMessage) => void = (message) => this.post(message),
    isAvailable: () => boolean = () => true
  ) {
    const [contextFile] = await this.droppedFilesService.fromContent([
      { name: payload.name, content: payload.content, size: payload.size },
    ]);
    if (contextFile) {
      if (!isAvailable()) {
        await this.droppedFilesService.removeOwnedFile(contextFile.path);
        return;
      }
      post({ type: 'images/stored', payload: { id: payload.id, contextFile } });
    }
  }

  private async releaseImages(
    payload: Extract<WebviewMessage, { type: 'images/release' }>['payload']
  ) {
    if (payload.deferred) {
      for (const path of payload.paths) {
        this.droppedFilesService.deferOwnedFileRemoval(path, payload.sessionId);
      }
      return;
    }
    await this.droppedFilesService.removeOwnedFiles(payload.paths);
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

  private searchFiles(
    requestId: number,
    query: string,
    limit = 12,
    post: (message: ExtensionMessage) => void = (message) => this.post(message),
    fileSearch = this.fileSearch
  ) {
    fileSearch.search(requestId, query, limit, (result) => {
      post({ type: 'files/search-results', payload: result });
    });
  }

  private async runInTerminal(command: string, title = 'OpenCode') {
    const text = command.trim();
    if (!text) return;
    const replacesBinary = replacesOpenCodeBinary(text);

    // Same prerequisite as Varro's own upgrade path: on Windows a managed
    // server holds opencode.exe open, and the install or update the user just
    // asked for cannot replace a running binary.
    if (replacesBinary) {
      await this.server.prepareForWindowsCliUpgrade();
    }

    const cwd = this.contextProvider.context.workspacePath || undefined;
    try {
      const terminal = vscode.window.createTerminal({ name: title, cwd });
      if (replacesBinary && process.platform === 'win32') {
        const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
          if (closedTerminal !== terminal) return;
          disposable.dispose();
          this.server.finishWindowsCliUpgrade();
        });
      }
      terminal.show(false);
      terminal.sendText(text, true);
    } catch (err) {
      if (replacesBinary) this.server.finishWindowsCliUpgrade();
      throw err;
    }
  }

  private openSessionInTerminal(sessionId: string) {
    const launch = resolveServerLaunch(this.server.resolveCommand(), ['--session', sessionId]);
    const terminal = vscode.window.createTerminal({
      name: 'OpenCode Session',
      cwd: this.contextProvider.context.workspacePath || undefined,
      shellPath: launch.command,
      shellArgs: launch.args,
    });
    terminal.show(false);
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
   * sessions whose completion event was lost - the webview-side watchdog only
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
    const idleState = {
      visible: true as const,
      text: `$(robot) OpenCode ${maximumTestedOpenCodeVersion}`,
      tooltip: `OpenCode ${maximumTestedOpenCodeVersion}\nMaximum version tested with this Varro release.\n\nClick to open chat.`,
    };
    const pendingRequests = [...this.sessionState.pendingForUser.values()].filter(
      (request) =>
        !this.isSessionAttentionVisible(request.sessionID) &&
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
        !this.isSessionAttentionVisible(sessionID) &&
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

    return idleState;
  }
}
