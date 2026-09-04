/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- VS Code and OpenCode boundary values are validated before provider actions. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Provider responses are parsed before command-specific use. */
import * as vscode from 'vscode';
import { replacesOpenCodeBinary } from '../shared/opencode-install';
import { MAX_NATIVE_PDF_TOTAL_BYTES } from '../shared/native-pdf';
import type {
  OpenCodeModelRouting,
  OpenCodeServerMemoryPermission,
  PermissionRule,
} from '../shared/opencode-types';
import {
  getSafeDefaultPermissionRules,
  getSessionPermissionRulesForMode,
} from '../shared/permission-rules';
import type {
  ChatModelSelection,
  DroppedFile,
  EditorContext,
  ExtensionMessage,
  QueuedMessageSnapshot,
  PermissionMode,
  ServerEvent,
  WebviewInstanceContext,
  WebviewMessage,
  WebviewRoute,
  SiblingWorkspaceAlert,
  TerminalSelection,
} from '../shared/protocol';
import { isPlaceholderSessionTitle } from '../shared/session-title';
import { asRecord } from '../shared/type-utils';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../shared/workspace-path';

const WORKSPACE_CATALOG_EVENT_TYPES = new Set<ServerEvent['type']>([
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'session.idle',
]);
const WORKSPACE_ATTENTION_EVENT_TYPES = new Set<ServerEvent['type']>([
  'permission.updated',
  'permission.asked',
  'permission.replied',
  'permission.v2.asked',
  'permission.v2.replied',
  'question.asked',
  'question.replied',
  'question.rejected',
  'question.v2.asked',
  'question.v2.replied',
  'question.v2.rejected',
]);
const WORKSPACE_INDEPENDENT_EVENT_TYPES = new Set<ServerEvent['type']>([
  'server.connected',
  'server.heartbeat',
  'server.instance.disposed',
  'global.disposed',
  'catalog.updated',
  'models-dev.refreshed',
  'plugin.added',
  'installation.updated',
  'installation.update-available',
  'workspace.ready',
  'workspace.failed',
  'workspace.status',
]);
const EDITOR_TITLE_EVENT_TYPES = new Set<ServerEvent['type']>([
  'session.created',
  'session.updated',
  'session.deleted',
]);
const UNSEQUENCED_TRANSCRIPT_DELTA_EVENT_TYPES = new Set<ServerEvent['type']>([
  'message.part.delta',
  'session.next.text.delta',
  'session.next.reasoning.delta',
  'session.next.tool.input.delta',
  'session.next.compaction.delta',
]);
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
import { readLocalSessionSummary } from './local-session-summary';
import { logger } from './logger';
import { MessageRouter } from './message-router';
import { ModelPreferencesStore } from './model-preferences-store';
import {
  nodeProviderSignatureFileSystem,
  ProviderFileRefreshController,
} from './provider-file-refresh-controller';
import type { ProviderSignatureFileSystem } from './provider-file-refresh-controller';
import { ProviderLimitService } from './provider-limit-service';
import { PinnedSessionManager } from './pinned-session-manager';
import { QueuedMessageStore } from './queued-message-store';
import { RalphHost } from './ralph-host';
import { InternalHelperCleanupCoordinator, RestProxy } from './rest-proxy';
import type { OpenCodeServer } from './server';
import { ServerEventBridge } from './server-event-bridge';
import { compareVersions, extractVersion } from './server-utils';
import { SessionExportService } from './session-export-service';
import { SessionDiffDocumentProvider } from './session-diff-document-provider';
import { ToolOutputDocumentProvider } from './tool-output-document-provider';
import { SessionStateManager } from './session-state-manager';
import { SessionPermissionModeStore } from './session-permission-mode-store';
import { SessionModelSelectionStore } from './session-model-selection-store';
import { SessionPlanStateStore } from './session-plan-state-store';
import { SessionHistoryScopeStore } from './session-history-scope-store';
import { SessionTitleFallback } from './session-title-fallback';
import { SessionTrashManager } from './session-trash-manager';
import { createSidebarProviderActions } from './sidebar-provider-actions';
import { SidebarProviderBridge } from './sidebar-provider-bridge';
import { SidebarProviderContextFiles } from './sidebar-provider-context-files';
import { SidebarProviderRuntime } from './sidebar-provider-runtime';
import { WebviewSession } from './webview-session';
import { WorkspaceSessionStatusCoordinator } from './workspace-session-status-coordinator';
import { UsageReportService } from './usage-report-service';
import { getWorkspaceSessionIdsForEvent } from './sidebar-provider-utils';
import { resolveServerLaunch } from './util/server-launch';

const maximumTestedOpenCodeVersion = readMaximumTestedOpenCodeVersion();

function differsByMajorOrMinor(left: string, right: string) {
  const [leftMajor, leftMinor] = left.split('.').map(Number);
  const [rightMajor, rightMinor] = right.split('.').map(Number);
  return leftMajor !== rightMajor || leftMinor !== rightMinor;
}

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
  workspacePath: string | null;
  siblingAlertsKey: string;
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
type StatusBarState =
  | { visible: false; action: 'focus' }
  | {
      visible: true;
      action: 'focus' | 'attention' | 'sibling';
      text: string;
      tooltip: string;
      backgroundColor?: vscode.ThemeColor;
    };

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'varro.chat';
  public static readonly editorViewType = 'varro.editor';
  private static readonly EXPORT_TIMEOUT_MS = 30_000;
  private static readonly RECYCLE_BIN_CLEANUP_INTERVAL_MS = 60_000;
  private static readonly SESSION_RECONCILE_INTERVAL_MS = 10_000;
  private static readonly QUEUE_RECONCILE_INTERVAL_MS = 1_000;
  private static readonly SESSION_RECONCILE_GRACE_MS = 10_000;
  private static readonly QUEUE_OWNER_RECONCILE_MAX_ATTEMPTS = 3;
  private static readonly PERMISSION_MODE_FALLBACK_RETRY_INITIAL_MS = 5_000;
  private static readonly PERMISSION_MODE_FALLBACK_RETRY_MAX_MS = 5 * 60_000;
  private static readonly MAX_DEFERRED_WORKSPACE_EVENTS = 1_000;

  private lastStatusBarStateKey = '';
  private attentionStatusBarItemVisible = false;
  private hiddenStatusBarState: Extract<StatusBarState, { visible: true }> | null = null;
  private openCodeVersionCheck: 'idle' | 'checking' | 'checked' = 'idle';
  private openCodeUpdateAvailable = false;
  private openCodeCliVersion: string | null = null;
  private openCodeServerVersion: string | null = null;
  private readonly extensionVersion: string;
  private activeChatModel: ChatModelSelection | null = null;
  private readonly fileSearch: FileSearchService;
  private readonly sessionState: SessionStateManager;
  private readonly sessionTrash: SessionTrashManager;
  private readonly pinnedSessions: PinnedSessionManager;
  private readonly queuedMessages: QueuedMessageStore;
  private readonly sessionPermissionModes: SessionPermissionModeStore;
  private readonly sessionSelectedModels: SessionModelSelectionStore;
  private readonly sessionPlanState: SessionPlanStateStore;
  private readonly sessionHistoryScopes: SessionHistoryScopeStore;
  private readonly modelPreferences: ModelPreferencesStore;
  private readonly draftImages: DraftImageStore;
  private readonly hiddenSessions: HiddenSessionManager;
  private readonly internalHelperCleanupCoordinator = new InternalHelperCleanupCoordinator();
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
  private readonly observedQueuedMessagePersistences = new Set<Promise<void>>();
  private queuedPdfCleanupRequested = false;
  private queuedPdfCleanup: Promise<void> | null = null;
  private sessionReconcileIntervalMs = 0;
  private sessionReconcileInFlight: Promise<void> | null = null;
  private sessionReconcileRerunRequested = false;
  private mermaidPreviewMaximized = false;
  private mermaidPreviewLayoutQueue: Promise<void> = Promise.resolve();
  private readonly contextProvider: ContextProvider;
  private readonly generatedDependencyTreeGuard: GeneratedDependencyTreeGuard;
  private readonly workspaceSessionStatusCoordinator = new WorkspaceSessionStatusCoordinator();
  private readonly endpoints = new Set<WebviewEndpoint>();
  private readonly serverMemoryPermissions = new Map<string, OpenCodeServerMemoryPermission>();
  private readonly editorPanels = new Map<string, EditorEndpoint>();
  private lastFocusedContextViewId: string | null = null;
  private readonly permissionModeQueues = new Map<string, Promise<unknown>>();
  private permissionModeFallbackReconciliation: Promise<void> | null = null;
  private permissionModeFallbackReconciliationRequested = false;
  private permissionModeFallbackRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private permissionModeFallbackRetryMs = SidebarProvider.PERMISSION_MODE_FALLBACK_RETRY_INITIAL_MS;
  private readonly deferredWorkspaceEvents: ServerEvent[] = [];
  private readonly permissionAutomationOwnerViewIds = new Set<string>();
  private readonly permissionAutomationOwnerWorkspaces = new Map<string, string>();
  private readonly permissionAutomationLeases = new Map<string, number>();
  private nextPermissionAutomationLease = 0;
  private interruptedRecoveryClaim: {
    claimId: number;
    sessionIds: string[];
    viewId: string;
    workspacePath: string | null;
  } | null = null;
  private readonly deferredInterruptedRecoveryOwners = new Map<string, string>();
  private sessionDirectoryReconciliationScheduled = false;
  private lastWorkspaceStructureKey: string | null = null;
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
    globalState: vscode.Memento,
    contextProvider: ContextProvider,
    private readonly server: OpenCodeServer,
    private readonly extensionId: string,
    private readonly simulateNoProviders = false,
    providerSignatureFileSystem: ProviderSignatureFileSystem = nodeProviderSignatureFileSystem
  ) {
    this.contextProvider = contextProvider;
    const extensionPackageJson: unknown = vscode.extensions.getExtension(extensionId)?.packageJSON;
    this.extensionVersion =
      extensionPackageJson &&
      typeof extensionPackageJson === 'object' &&
      typeof (extensionPackageJson as { version?: unknown }).version === 'string'
        ? (extensionPackageJson as { version: string }).version
        : 'unknown';
    const persistence = new HostPersistence(workspaceState);
    const globalPersistence = new HostPersistence(globalState);
    this.droppedFilesService = new DroppedFilesService(contextProvider);
    this.fileSearch = new FileSearchService();
    this.providerLimitService = new ProviderLimitService(server);
    const isOpenAIPro = async () => {
      const status = await this.providerLimitService.get('openai', null);
      if (status.status !== 'available') return false;
      const planName = status.planName?.trim().toLowerCase();
      return planName === 'pro 5x' || planName === 'pro 20x';
    };
    this.bridge = new SidebarProviderBridge(extensionUri);
    this.sessionTrash = new SessionTrashManager(persistence);
    this.pinnedSessions = new PinnedSessionManager(persistence);
    this.queuedMessages = new QueuedMessageStore(persistence);
    this.sessionPermissionModes = new SessionPermissionModeStore(persistence);
    this.sessionSelectedModels = new SessionModelSelectionStore(persistence);
    this.sessionPlanState = new SessionPlanStateStore(persistence);
    this.sessionHistoryScopes = new SessionHistoryScopeStore(persistence);
    this.modelPreferences = new ModelPreferencesStore(globalPersistence, persistence);
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
        onSessionDirectoryChange: () => this.scheduleSessionDirectoryReconciliation(),
      },
      {
        shouldShow: (sessionID) =>
          this.sessionState.getSessionWorkspaceMatch(
            sessionID,
            this.contextProvider.context.workspacePath
          ) !== false && !this.isAnyChatVisible(),
      }
    );
    for (const [sessionId, agent] of Object.entries(this.sessionPlanState.listAgents())) {
      this.sessionState.setSessionAgent(sessionId, agent);
    }
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
      () => this.updateStatusBarItem()
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
        getWorkspaceDirectories: () => {
          const serverWorkspace = this.server.getWorkspaceCwd();
          return [
            ...(this.contextProvider.context.workspaceFolders ?? []).map((folder) => folder.path),
            ...[...this.endpoints]
              .map((endpoint) => endpoint.workspacePath)
              .filter((workspacePath): workspacePath is string => workspacePath !== null),
            ...(serverWorkspace ? [serverWorkspace] : []),
          ];
        },
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
      if (event.affectsConfiguration('varro.server.autoUpdate')) {
        this.updateStatusBarItem();
      }
      if (
        event.affectsConfiguration('varro.chat.showFileDiffs') ||
        event.affectsConfiguration('varro.chat.expandThinking') ||
        event.affectsConfiguration('varro.chat.fontSize') ||
        event.affectsConfiguration('varro.chat.showChangedFiles') ||
        event.affectsConfiguration('varro.chat.showTurnTimer') ||
        event.affectsConfiguration('varro.chat.desktopSessionPaneSide') ||
        event.affectsConfiguration('varro.chat.defaultPermissionMode') ||
        event.affectsConfiguration('chat.fontSize') ||
        event.affectsConfiguration('chat.editor.fontSize') ||
        event.affectsConfiguration('chat.fontFamily')
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
    contextFilesState = this.contextFilesState,
    restoredWorkspacePath?: string | null
  ): WebviewEndpoint {
    const endpointRef: EndpointRef & { endpoint?: WebviewEndpoint } = {};
    const sidebarWorkspacePath = [...this.endpoints].find(
      (endpoint) => endpoint.surface === 'sidebar'
    )?.workspacePath;
    const sessionWorkspacePath =
      webviewContext.initialRoute.type === 'session'
        ? (webviewContext.initialRoute.directory ??
          this.sessionState.directoryFor(webviewContext.initialRoute.sessionId))
        : undefined;
    let initialWorkspacePath =
      webviewContext.surface === 'editor' && sessionWorkspacePath
        ? sessionWorkspacePath
        : (restoredWorkspacePath ??
          (webviewContext.surface === 'editor'
            ? (sidebarWorkspacePath ?? this.contextProvider.context.workspacePath)
            : this.contextProvider.context.workspacePath));
    const getEndpointContext = () =>
      this.withWorkspacePath(
        this.contextProvider.context,
        endpointRef.endpoint ? endpointRef.endpoint.workspacePath : initialWorkspacePath
      );
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
        handleRecoveryLoadedSideEffects: () => this.reconcilePermissionAutomationOwners(true),
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
        permissionModeRecoverySessionIds: () =>
          this.sessionPermissionModes.pendingSafeFallbackSessionIds(),
        sessionSelectedModels: () => this.sessionSelectedModels.list(),
        sessionPlanState: () => this.sessionPlanState.list(),
        sessionPlanAgents: () => this.sessionPlanState.listAgents(),
        sessionModelMigrationPending: () => this.sessionSelectedModels.needsMigration(),
        modelPreferences: () =>
          this.modelPreferences.needsMigration() ? undefined : this.modelPreferences.get(),
        modelPreferencesMigrationPending: () => this.modelPreferences.needsMigration(),
        editorTabsOpen: () => this.editorPanels.size > 0,
        editorSessionIds: () => this.visibleEditorSessionIds(),
        openEditorSessionIds: () => this.openEditorSessionIds(),
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
        editorContext: getEndpointContext,
      },
      webviewContext,
      webviewContext.surface === 'sidebar'
    );

    const endpointServer = {
      getWorkspaceCwd: () =>
        endpointRef.endpoint
          ? (endpointRef.endpoint.workspacePath ?? undefined)
          : (initialWorkspacePath ?? undefined),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- RestProxy validates each route before forwarding its opaque request body.
      request: (method: string, path: string, body?: unknown, options?: { directory?: string }) =>
        this.server.request(method, path, body, {
          ...options,
          directory:
            options?.directory ??
            (endpointRef.endpoint
              ? (endpointRef.endpoint.workspacePath ?? undefined)
              : (initialWorkspacePath ?? undefined)),
        }),
    };
    const restProxy = new RestProxy({
      server: endpointServer,
      workspaceSessionStatusCoordinator: this.workspaceSessionStatusCoordinator,
      contextProvider: this.contextProvider,
      providerLimitService: this.providerLimitService,
      sessionState: this.sessionState,
      sessionTrash: this.sessionTrash,
      pinnedSessions: this.pinnedSessions,
      hiddenSessions: this.hiddenSessions,
      internalHelperCleanupCoordinator: this.internalHelperCleanupCoordinator,
      autoApproveJudge: this.autoApproveJudge,
      sessionTitleFallback: this.sessionTitleFallback,
      readLocalSessionSummary,
      simulateNoProviders: this.simulateNoProviders,
      getRequestGeneration: () => webviewSession.getRequestGeneration(),
      getStatus: () => this.serverEventBridge.getStatus(),
      getSessionHistoryScope: (root) => this.sessionHistoryScopes.getForRoot(root),
      getSessionHistoryScopeByKey: (key) => this.sessionHistoryScopes.get(key),
      associateSessionHistoryScope: (root, key) => this.sessionHistoryScopes.associate(root, key),
      updateSessionHistoryScope: async (key, scope) => {
        await this.sessionHistoryScopes.set(key, scope);
        this.workspaceSessionStatusCoordinator.clearCatalogs();
        for (const endpoint of this.endpoints) endpoint.restProxy.invalidateSessionCatalog();
        this.post({ type: 'session/catalog-invalidated' });
      },
      getWorkspacePath: () => endpointRef.endpoint?.workspacePath ?? initialWorkspacePath,
      resolvePendingAttentionRequest: (requestID) => {
        const pending = this.sessionState.pending.get(requestID);
        if (!pending) return undefined;
        return {
          sessionID: pending.sessionID,
          directory: this.sessionState.directoryFor(pending.sessionID),
        };
      },
      shouldAbortSessionBeforeRecycle: (sessionID) =>
        this.sessionState.busy.has(sessionID) ||
        [...this.sessionState.pending.values()].some((request) => request.sessionID === sessionID),
      ensureServerStarted: () => this.runtime.ensureServerStarted(),
      confirmPromptAdmission: (workspacePath) =>
        generatedDependencyTreeGuard.confirmPromptAdmission(workspacePath),
      refreshOpenCodeConfig: (previousRouting, currentRouting, workspacePath) =>
        this.refreshOpenCodeWorkspaceState(previousRouting, currentRouting, workspacePath),
      cleanupExpiredRecycleBin: () => this.cleanupExpiredRecycleBin(),
      removeSessionImages: (sessionIds) =>
        this.droppedFilesService.removeSessionOwnedFiles(sessionIds),
      rememberServerMemoryPermissions: (rules) => {
        for (const rule of rules) {
          this.serverMemoryPermissions.set(
            `${rule.projectID}\0${rule.permission}\0${rule.pattern}`,
            rule
          );
        }
      },
      forgetServerMemoryPermission: (rule) => {
        this.serverMemoryPermissions.delete(
          `${rule.projectID}\0${rule.permission}\0${rule.pattern}`
        );
      },
      getServerMemoryPermissions: (projectID) =>
        [...this.serverMemoryPermissions.values()].filter((rule) => rule.projectID === projectID),
      postApiResponse: (requestGeneration, payload) =>
        webviewSession.postApiResponse(payload, requestGeneration),
      isPermissionAutomationLeaseCurrent: (lease, request) => {
        const workspace = this.permissionAutomationOwnerWorkspaces.get(webviewContext.viewId);
        if (
          !workspace ||
          !this.permissionAutomationOwnerViewIds.has(webviewContext.viewId) ||
          this.permissionAutomationLeases.get(workspace) !== lease
        ) {
          return false;
        }
        const pendingSessionID = request.permissionID
          ? this.sessionState.pending.get(request.permissionID)?.sessionID
          : undefined;
        if (request.sessionID && pendingSessionID && request.sessionID !== pendingSessionID) {
          return false;
        }
        const sessionID = pendingSessionID ?? request.sessionID;
        const recoveringSessionIDs = new Set(
          this.sessionPermissionModes.pendingSafeFallbackSessionIds()
        );
        if (
          sessionID &&
          this.sessionState
            .sessionLineageFor(sessionID)
            .some((candidate) => recoveringSessionIDs.has(candidate))
        ) {
          return false;
        }
        const directory = sessionID ? this.sessionState.directoryFor(sessionID) : undefined;
        const permissionWorkspace =
          request.workspaceDirectory ??
          (directory ? (this.getOpenSessionDirectory(directory) ?? undefined) : undefined);
        return normalizeWorkspaceIdentity(permissionWorkspace) === workspace;
      },
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
        const queuedPdfPaths = (this.queuedMessages.list() ?? [])
          .find((message) => message.sessionId === sessionId && message.id === itemId)
          ?.nativePdfs?.flatMap((pdf) => (pdf.contextFile ? [pdf.contextFile.path] : []));
        const persistence = this.queuedMessages.completeDispatchAdmission(
          webviewContext.viewId,
          sessionId,
          itemId,
          lease,
          requestId
        );
        if (!persistence) return false;
        for (const path of queuedPdfPaths ?? []) {
          this.droppedFilesService.deferOwnedFileRemoval(path, sessionId);
        }
        this.postQueuedSessionStatusFor(sessionId, 'busy');
        this.postQueuedMessageSnapshots();
        this.updateSessionReconcileTimer();
        this.queuedPdfCleanupRequested = true;
        this.scheduleQueuedPdfCleanup();
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
      updatePermissionMode: (sessionID, mode, directory, preconfigured, defaultPermission) =>
        preconfigured
          ? this.persistPreconfiguredPermissionMode(
              sessionID,
              mode,
              directory ?? endpointServer.getWorkspaceCwd(),
              true
            )
          : this.updateConfirmedPermissionMode(
              sessionID,
              mode,
              directory ?? endpointServer.getWorkspaceCwd(),
              false,
              defaultPermission
            ),
      allowPermissionForSession: (sessionID, permission, patterns, directory) =>
        this.allowPermissionForSession(
          sessionID,
          permission,
          patterns,
          directory ?? endpointServer.getWorkspaceCwd()
        ),
      updatePermissionRulesForSession: (sessionID, rules, directory) =>
        this.updatePermissionRulesForSession(
          sessionID,
          rules,
          directory ?? endpointServer.getWorkspaceCwd()
        ),
      activateSession: async (sessionID, directory, catalogRoot, signal) => {
        const workspacePath = this.getOpenSessionDirectory(catalogRoot);
        if (!workspacePath) throw new Error('Session workspace folder is not open');
        const session = asRecord(
          await this.server.request('GET', `/session/${encodeURIComponent(sessionID)}`, undefined, {
            directory,
            signal,
          })
        );
        signal?.throwIfAborted();
        const currentWorkspacePath = this.getOpenSessionDirectory(workspacePath);
        if (!currentWorkspacePath) throw new Error('Session workspace folder is not open');
        if (
          session?.id !== sessionID ||
          typeof session.directory !== 'string' ||
          !isSameWorkspacePath(session.directory, directory)
        ) {
          throw new Error('404 Session not found');
        }
        initialWorkspacePath = currentWorkspacePath;
        if (endpointRef.endpoint) {
          this.setEndpointWorkspace(endpointRef.endpoint, currentWorkspacePath);
        }
        this.reconcilePermissionAutomationOwners();
        if (
          webviewContext.surface === 'sidebar' &&
          this.contextProvider.getOpenWorkspaceRoot(currentWorkspacePath)
        ) {
          await this.contextProvider.selectWorkspace(currentWorkspacePath);
        }
        post({ type: 'context/update', payload: getEndpointContext() });
        this.postSiblingWorkspaceAlerts();
        return session;
      },
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
        acknowledgeSessionSeen: (sessionId) =>
          this.sessionState.acknowledgeCompletedSession(sessionId),
        setWebviewFocus: (focused) => {
          if (focused) this.lastFocusedContextViewId = webviewContext.viewId;
        },
        revealPermission: (permissionId) => this.revealPermission(permissionId),
        contextFilesState,
        sessionExportService:
          webviewContext.surface === 'sidebar'
            ? this.sessionExportService
            : new SessionExportService(
                {
                  ...endpointServer,
                  resolveCommand: () => this.server.resolveCommand(),
                },
                SidebarProvider.EXPORT_TIMEOUT_MS
              ),
        usageReportService: this.usageReportService,
        restProxy,
        getWorkspaceDirectory: () => endpointServer.getWorkspaceCwd(),
        sessionDiffProvider: {
          open: (sessionID, path, directory) =>
            this.sessionDiffProvider.open(
              sessionID,
              path,
              directory,
              endpointServer,
              (candidateSessionID, candidateDirectory) =>
                restProxy.authorizeSessionDirectory(candidateSessionID, candidateDirectory)
            ),
        },
        toolOutputProvider: this.toolOutputProvider,
        server: this.server,
        sessionServer: endpointServer,
        post,
        refreshProviders: () => this.refreshProviderCatalog(),
        providerAuthChanged: () => this.providerAuthChanged(),
        postContext: () => post({ type: 'context/update', payload: getEndpointContext() }),
        selectWorkspace: async (path) => {
          const workspacePath = this.contextProvider.getOpenWorkspaceRoot(path);
          if (!workspacePath) throw new Error('Selected workspace folder is not open');
          initialWorkspacePath = workspacePath;
          if (endpointRef.endpoint) this.setEndpointWorkspace(endpointRef.endpoint, workspacePath);
          this.reconcilePermissionAutomationOwners();
          if (webviewContext.surface === 'sidebar') {
            await this.contextProvider.selectWorkspace(workspacePath);
          } else {
            post({ type: 'context/update', payload: getEndpointContext() });
          }
          this.postSiblingWorkspaceAlerts();
        },
        postTerminalSelection: (selection) =>
          post({ type: 'terminal-selection/update', payload: selection }),
        postConfigState: () => this.postConfigState(),
        handleReadyMessage: async (documentId) => {
          try {
            await this.recoverPendingPermissionModeFallbacks();
            const ready = await webviewSession.handleReady(documentId);
            if (!ready) return;
            if (endpointRef.endpoint) {
              this.setEndpointReady(endpointRef.endpoint, true);
              if (endpointRef.endpoint.surface === 'editor') {
                const editorEndpoint = endpointRef.endpoint as EditorEndpoint;
                editorEndpoint.restoringSessionId = undefined;
              }
            }
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
          return this.storeImage(
            payload,
            post,
            () => this.isEndpointGenerationAvailable(endpointRef.endpoint, generation),
            (contextFile) =>
              this.draftImages.setContextFile(payload.id, contextFile, webviewContext.viewId)
          );
        },
        releaseImages: (payload) => this.releaseImages(payload),
        removeContextFile: (path) =>
          contextFilesState.removeContextFile(path, (message) => post(message)),
        clearContextFiles: () => contextFilesState.clearContextFiles(),
        pickFiles: () => contextFilesState.pickFiles((message) => post(message)),
        searchFiles: (requestId, query, limit) => {
          const generation = webviewSession.getRequestGeneration();
          const workspaceDirectory = endpointServer.getWorkspaceCwd();
          this.searchFiles(
            requestId,
            query,
            limit,
            workspaceDirectory,
            post,
            fileSearch,
            () =>
              this.isEndpointGenerationAvailable(endpointRef.endpoint, generation) &&
              isSameWorkspacePath(
                endpointRef.endpoint?.workspacePath ?? initialWorkspacePath,
                workspaceDirectory
              )
          );
        },
        runInTerminal: (command, title) =>
          this.runInTerminal(command, title, endpointServer.getWorkspaceCwd()),
        openSessionInTerminal: (sessionId, directory) =>
          this.openSessionInTerminal(sessionId, directory ?? endpointServer.getWorkspaceCwd()),
        openSessionInEditor: (sessionId, title, model, rootSessionId, directory) =>
          this.openSessionInEditor(sessionId, title, model, rootSessionId, directory),
        openSessionInSidebar: (sessionId, directory) =>
          this.openSessionInSidebar(sessionId, directory),
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
          if (mode === null) {
            const modes = await this.sessionPermissionModes.set(sessionId, null);
            this.postPermissionModes(modes);
            return;
          }
          await this.persistPreconfiguredPermissionMode(
            sessionId,
            mode,
            this.sessionState.directoryFor(sessionId) ?? endpointServer.getWorkspaceCwd()
          );
        },
        migratePermissionModes: async ({ modes: legacyModes }) => {
          await Promise.all(
            Object.entries(legacyModes).map(([sessionId, mode]) => {
              const directory =
                this.sessionState.directoryFor(sessionId) ?? endpointServer.getWorkspaceCwd();
              return this.persistPreconfiguredPermissionMode(
                sessionId,
                mode,
                directory,
                true,
                mode === 'default'
              );
            })
          );
        },
        updateSessionModel: async ({ sessionId, model }) => {
          const models = await this.sessionSelectedModels.set(sessionId, model);
          this.post({ type: 'session-models/sync', payload: { models } });
        },
        migrateSessionModels: async ({ models }) => {
          const migrated = await this.sessionSelectedModels.migrateLegacy(models);
          this.post({ type: 'session-models/sync', payload: { models: migrated } });
        },
        updateSessionPlanState: async (payload) => {
          if (payload.skippedAt !== undefined || payload.agent) {
            await this.sessionPlanState.update(payload.sessionId, payload);
          }
          if (payload.agent) this.sessionState.setSessionAgent(payload.sessionId, payload.agent);
          if (typeof payload.skippedAt === 'number') {
            this.sessionState.acknowledgePlanSession(payload.sessionId);
          }
          if (payload.skippedAt !== undefined || payload.agent) {
            const update: Extract<
              ExtensionMessage,
              { type: 'session-plan-state/update' }
            >['payload'] = { sessionId: payload.sessionId };
            if (payload.skippedAt !== undefined) update.skippedAt = payload.skippedAt;
            if (payload.agent) update.agent = payload.agent;
            this.post({
              type: 'session-plan-state/update',
              payload: update,
            });
          }
        },
        updateSessionUnreadState: ({ sessionId, directory, kind, unread, markerAt }) => {
          const workspacePath = directory
            ? this.contextProvider.getOpenWorkspaceRoot(directory)
            : endpointRef.endpoint?.workspacePath;
          if (directory && !workspacePath) return;
          if (
            workspacePath &&
            this.sessionState.getSessionWorkspaceMatch(sessionId, workspacePath) === false
          ) {
            return;
          }
          this.sessionState.setSessionUnreadState(
            sessionId,
            kind,
            unread,
            workspacePath ?? undefined,
            markerAt
          );
        },
        updateModelPreferences: async ({ base, preferences }) => {
          const updated = await this.modelPreferences.update(base, preferences);
          this.post({ type: 'model-preferences/sync', payload: updated });
        },
        migrateModelPreferences: async (preferences) => {
          const migrated = await this.modelPreferences.migrateLegacy(preferences);
          this.post({ type: 'model-preferences/sync', payload: migrated });
        },
        updateDraftImages: ({ images }) => this.draftImages.update(images, webviewContext.viewId),
        setMermaidPreviewOpen: (open) => this.setMermaidPreviewOpen(open),
        setActiveRoute: (sessionId) => {
          const endpoint = endpointRef.endpoint;
          if (!endpoint || sessionId === undefined) return;
          if (endpoint.surface === 'editor') {
            const editorEndpoint = endpoint as EditorEndpoint;
            if (sessionId && editorEndpoint?.restoringSessionId === sessionId) {
              editorEndpoint.restoringSessionId = undefined;
            }
            return;
          }
          if (
            (sessionId === null && endpoint.route.type === 'new-session') ||
            (sessionId !== null &&
              endpoint.route.type === 'session' &&
              endpoint.route.sessionId === sessionId)
          ) {
            return;
          }
          endpoint.route = sessionId
            ? {
                type: 'session',
                sessionId,
                directory:
                  this.sessionState.directoryFor(sessionId) ?? endpoint.workspacePath ?? undefined,
              }
            : { type: 'new-session' };
          this.updateStatusBarItem();
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
      workspacePath: initialWorkspacePath,
      siblingAlertsKey: '',
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
    if (this.disposing) return Promise.resolve();
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
    rootSessionId?: string,
    directory?: string
  ) {
    if (this.disposing) return;
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
    if (this.disposing) return;
    const rootId = rootSessionId || this.sessionState.rootSessionIdFor(sessionId);
    const workspacePath = directory ?? this.sessionState.directoryFor(sessionId);
    const key = this.sessionEditorKey(rootId, workspacePath);
    const existing = this.editorPanels.get(key);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, false);
      if (existing.route.type !== 'session' || existing.route.sessionId !== sessionId) {
        const nextRoute: WebviewRoute = {
          type: 'session',
          sessionId,
          directory: workspacePath,
          rootSessionId: rootId,
          title,
        };
        existing.route = nextRoute;
        existing.webviewSession.setInitialRoute(nextRoute);
        existing.panel.title = this.editorTitle(nextRoute);
        existing.webviewSession.queueCommand({
          type: 'command/open-session',
          payload: workspacePath ? { sessionId, directory: workspacePath } : { sessionId },
        });
        this.reconcileQueuedMessageOwners();
      }
      return;
    }
    await this.openEditorPanel({
      type: 'session',
      sessionId,
      directory: workspacePath,
      rootSessionId: rootId,
      title,
    });
  }

  async openSessionInSidebar(sessionId: string, directory?: string) {
    await vscode.commands.executeCommand(`${SidebarProvider.viewType}.focus`);
    const sidebarEndpoint = [...this.endpoints].find((endpoint) => endpoint.surface === 'sidebar');
    if (directory) {
      const workspacePath = this.contextProvider.getOpenWorkspaceRoot(directory);
      if (!workspacePath) throw new Error('Session workspace folder is not open');
      if (sidebarEndpoint) this.setEndpointWorkspace(sidebarEndpoint, workspacePath);
      this.reconcilePermissionAutomationOwners();
      await this.contextProvider.selectWorkspace(workspacePath);
      this.postSiblingWorkspaceAlerts();
    }
    const rootId = this.sessionState.rootSessionIdFor(sessionId);
    this.editorPanels.get(this.sessionEditorKey(rootId, directory))?.panel.dispose();
    this.webviewSession.queueCommand({
      type: 'command/open-session',
      payload: directory ? { sessionId, directory } : { sessionId },
    });
  }

  async openNewEditor() {
    if (this.disposing) return;
    await this.openEditorPanel({ type: 'new-session' });
  }

  openNewTerminalEditor() {
    const terminal = vscode.window.createTerminal({
      cwd: this.contextProvider.context.workspacePath || undefined,
      location: vscode.TerminalLocation.Editor,
    });
    terminal.show(false);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PersistedEditorState) {
    if (this.disposing) return;
    const route = this.readPersistedEditorRoute(state);
    const viewId = this.readPersistedEditorViewId(state);
    const workspacePath = this.readPersistedEditorWorkspacePath(state);
    await this.attachEditorPanel(
      panel,
      route,
      viewId ?? `editor-${Date.now()}-${++this.nextEditorId}`,
      workspacePath
    );
  }

  private async openEditorPanel(route: WebviewRoute) {
    if (this.disposing) return;
    const panel = vscode.window.createWebviewPanel(
      SidebarProvider.editorViewType,
      this.editorTitle(route),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    await this.attachEditorPanel(panel, route, `editor-${Date.now()}-${++this.nextEditorId}`);
  }

  private async attachEditorPanel(
    panel: vscode.WebviewPanel,
    route: WebviewRoute,
    viewId: string,
    restoredWorkspacePath?: string | null
  ) {
    if (this.disposing) return;
    const key = this.editorKey(route, viewId);
    const existing = this.editorPanels.get(key);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, false);
      panel.dispose();
      return;
    }
    const existingView = [...this.editorPanels.values()].find(
      (endpoint) => endpoint.viewId === viewId
    );
    if (existingView) {
      existingView.panel.reveal(existingView.panel.viewColumn, false);
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
      new SidebarProviderContextFiles(this.droppedFilesService),
      restoredWorkspacePath
    );
    const editorEndpoint: EditorEndpoint = Object.assign(endpoint, {
      key,
      panel,
      route,
      restoringSessionId: route.type === 'session' ? route.sessionId : undefined,
      panelDisposables: [] as vscode.Disposable[],
    });
    this.editorPanels.set(key, editorEndpoint);
    this.postEditorTabsState();
    let wasVisible = panel.visible;
    const viewStateDisposable = panel.onDidChangeViewState(({ webviewPanel }) => {
      if (this.disposing) return;
      if (webviewPanel.visible === wasVisible) return;
      wasVisible = webviewPanel.visible;
      if (webviewPanel.visible) {
        endpoint.webviewSession.resume();
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
      endpoint.contextFilesState.clearContextFiles();
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
          payload:
            endpoint.route.type === 'session' && endpoint.route.directory
              ? { sessionId: endpoint.restoringSessionId, directory: endpoint.route.directory }
              : { sessionId: endpoint.restoringSessionId },
        });
        return;
      }
    }
    if (
      route.type === 'session' &&
      endpoint.route.type === 'session' &&
      route.sessionId === endpoint.route.sessionId &&
      isPlaceholderSessionTitle(route.title) &&
      !isPlaceholderSessionTitle(endpoint.route.title)
    ) {
      route = { ...route, title: endpoint.route.title };
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
    this.reconcileQueuedMessageOwners();
    this.postEditorTabsState();
    this.updateStatusBarItem();
  }

  private postEditorTabsState() {
    const sessionIds = this.visibleEditorSessionIds();
    this.post({
      type: 'editor-tabs/state',
      payload: {
        open: this.editorPanels.size > 0,
        sessionIds,
        openSessionIds: this.openEditorSessionIds(),
      },
    });
  }

  private editorKey(route: WebviewRoute, viewId: string) {
    return route.type === 'session'
      ? this.sessionEditorKey(route.rootSessionId || route.sessionId, route.directory)
      : `draft:${viewId}`;
  }

  private sessionEditorKey(rootSessionId: string, directory?: string | null) {
    return `session:${normalizeWorkspaceIdentity(directory) ?? '*'}:${rootSessionId}`;
  }

  private editorTitle(route: WebviewRoute) {
    if (route.type === 'new-session') return 'Varro: New Session';
    return this.editorSessionTitle(route) || 'Varro: Session';
  }

  private editorSessionTitle(route: Extract<WebviewRoute, { type: 'session' }>) {
    const routeTitle = route.title?.trim();
    const stateTitle = this.sessionState.titleFor(route.sessionId)?.trim();
    if (stateTitle && !isPlaceholderSessionTitle(stateTitle)) return stateTitle;
    if (routeTitle && !isPlaceholderSessionTitle(routeTitle)) return routeTitle;
    return stateTitle || routeTitle;
  }

  private readPersistedEditorRoute(state: PersistedEditorState): WebviewRoute {
    if (!state) return { type: 'new-session' };
    const persisted = state['varro.lastOpenedView'];
    if (!persisted || typeof persisted !== 'object') return { type: 'new-session' };
    const route = persisted as Record<string, unknown>;
    if (
      route.type !== 'session' ||
      typeof route.sessionId !== 'string' ||
      this.sessionTrash.isHidden(route.sessionId) ||
      this.hiddenSessions.isHidden(route.sessionId)
    ) {
      return { type: 'new-session' };
    }
    const restoredRoute: WebviewRoute = {
      type: 'session',
      sessionId: route.sessionId,
      rootSessionId: this.sessionState.rootSessionIdFor(route.sessionId),
    };
    if (typeof route.directory === 'string') {
      const directory = this.getOpenSessionDirectory(route.directory);
      if (directory) restoredRoute.directory = directory;
    }
    return restoredRoute;
  }

  private readPersistedEditorViewId(state: PersistedEditorState) {
    const value = state?.['varro.editorViewId'];
    return typeof value === 'string' && /^editor-[A-Za-z0-9-]+$/.test(value) ? value : null;
  }

  private readPersistedEditorWorkspacePath(state: PersistedEditorState) {
    const value = state?.['varro.workspacePath'];
    return typeof value === 'string' ? this.getOpenSessionDirectory(value) : null;
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
    let workspaceStructureChanged = false;
    if (msg.type === 'server/status' && msg.payload.state === 'running') {
      void this.recoverPendingPermissionModeFallbacks();
    }
    if (msg.type === 'server/event') this.postQueuedSessionStatus(msg.payload);
    if (msg.type === 'server/event') this.releaseDeletedEditorRestorations(msg.payload);
    if (msg.type === 'server/event') this.removeDeletedSessionPersistence(msg.payload);
    if (msg.type === 'server/event' && this.shouldDeferWorkspaceEvent(msg.payload)) {
      this.deferredWorkspaceEvents.push(msg.payload);
      if (this.deferredWorkspaceEvents.length > SidebarProvider.MAX_DEFERRED_WORKSPACE_EVENTS) {
        this.deferredWorkspaceEvents.shift();
        logger.warn('Dropped oldest deferred workspace event after reaching the queue limit');
      }
      if (EDITOR_TITLE_EVENT_TYPES.has(msg.payload.type)) this.updateEditorPanelTitles();
      return;
    }
    if (msg.type === 'server/event') this.flushDeferredWorkspaceEvents();
    if (msg.type === 'context/update') {
      const structureKey = this.workspaceStructureKey(msg.payload);
      workspaceStructureChanged = structureKey !== this.lastWorkspaceStructureKey;
      if (workspaceStructureChanged) {
        this.lastWorkspaceStructureKey = structureKey;
        this.reconcileWorkspaceMembership(msg.payload);
      }
    }
    this.postToEndpoints(msg);
    if (msg.type === 'server/event' && EDITOR_TITLE_EVENT_TYPES.has(msg.payload.type)) {
      this.updateEditorPanelTitles();
    }
    if (msg.type === 'context/update' && workspaceStructureChanged) {
      this.postSiblingWorkspaceAlerts();
    }
  }

  private workspaceStructureKey(context: EditorContext) {
    return JSON.stringify([
      normalizeWorkspaceIdentity(context.workspacePath),
      normalizeWorkspaceIdentity(context.workspaceDirectory),
      (context.workspaceFolders ?? []).map((folder) => [
        folder.name,
        normalizeWorkspaceIdentity(folder.path),
      ]),
    ]);
  }

  private reconcileWorkspaceMembership(context: EditorContext) {
    const workspaceDirectories = [
      ...(context.workspaceFolders ?? []).map((folder) => folder.path),
      context.workspaceDirectory,
    ].filter((path): path is string => Boolean(path));
    for (const endpoint of this.endpoints) {
      endpoint.restProxy.cancelRequestsOutsideDirectories(workspaceDirectories);
    }
    this.sessionState.removeSessionsOutsideWorkspaceDirectories(workspaceDirectories);
    const fallbackWorkspacePath = context.workspacePath
      ? this.contextProvider.getOpenWorkspaceRoot(context.workspacePath)
      : workspaceDirectories[0];

    for (const endpoint of this.endpoints) {
      if (!endpoint.workspacePath || this.getOpenSessionDirectory(endpoint.workspacePath)) {
        continue;
      }
      endpoint.restProxy.cancelAllRequests('Workspace folder was removed');
      if (endpoint.surface === 'editor') {
        const editorEndpoint = endpoint as EditorEndpoint;
        editorEndpoint.panel.dispose();
        continue;
      }
      endpoint.workspacePath = fallbackWorkspacePath ?? null;
      endpoint.route = { type: 'new-session' };
      endpoint.contextFilesState.clearContextFiles();
      endpoint.contextFilesState.setTerminalSelection(null);
    }
    this.reconcilePermissionAutomationOwners(true);
    this.reconcileQueuedMessageOwners();
  }

  private postToEndpoints(msg: ExtensionMessage) {
    for (const endpoint of this.endpoints) {
      if (
        msg.type === 'server/event' &&
        msg.payload.seq === undefined &&
        UNSEQUENCED_TRANSCRIPT_DELTA_EVENT_TYPES.has(msg.payload.type) &&
        !endpoint.bridge.isVisible()
      ) {
        continue;
      }
      if (
        endpoint.surface === 'editor' &&
        !endpoint.ready &&
        !endpoint.bridge.isVisible() &&
        (msg.type === 'server/event' || msg.type === 'context/update')
      ) {
        continue;
      }
      const endpointMessage =
        msg.type === 'server/event'
          ? this.projectEventForEndpoint(msg, endpoint)
          : msg.type === 'context/update'
            ? { ...msg, payload: this.withWorkspacePath(msg.payload, endpoint.workspacePath) }
            : msg;
      if (endpointMessage) endpoint.bridge.post(endpointMessage);
      else if (msg.type === 'server/event') this.refreshCatalogEventForEndpoint(msg, endpoint);
    }
  }

  private projectEventForEndpoint(
    msg: Extract<ExtensionMessage, { type: 'server/event' }>,
    endpoint: WebviewEndpoint
  ): Extract<ExtensionMessage, { type: 'server/event' }> | null {
    if (this.isEventInEndpointWorkspace(msg.payload, endpoint)) return msg;
    const sessionIDs = getWorkspaceSessionIdsForEvent(msg.payload);
    const directory = this.getEventDirectory(msg.payload, sessionIDs);
    const catalogEvent = WORKSPACE_CATALOG_EVENT_TYPES.has(msg.payload.type);
    const attentionEvent = WORKSPACE_ATTENTION_EVENT_TYPES.has(msg.payload.type);
    const catalogAuthorized =
      sessionIDs.length > 0 &&
      sessionIDs.every((sessionID) =>
        attentionEvent
          ? endpoint.restProxy.isSessionCatalogInventoryAuthorized(sessionID, directory)
          : endpoint.restProxy.isSessionCatalogEventAuthorized(sessionID, directory)
      );
    if (
      (!catalogEvent && !attentionEvent) ||
      (attentionEvent && !catalogAuthorized) ||
      (catalogEvent && !this.isEventInOpenWorkspace(msg.payload) && !catalogAuthorized)
    ) {
      return null;
    }

    if (attentionEvent) return msg;

    const projected = projectWorkspaceCatalogEvent(msg.payload);
    const { seq: _seq, sequenceOnly: _sequenceOnly, ...event } = projected;
    return { type: 'server/event', payload: event as ServerEvent };
  }

  private refreshCatalogEventForEndpoint(
    msg: Extract<ExtensionMessage, { type: 'server/event' }>,
    endpoint: WebviewEndpoint
  ) {
    if (
      !WORKSPACE_CATALOG_EVENT_TYPES.has(msg.payload.type) &&
      !WORKSPACE_ATTENTION_EVENT_TYPES.has(msg.payload.type)
    ) {
      return;
    }
    const sessionIDs = getWorkspaceSessionIdsForEvent(msg.payload);
    if (sessionIDs.length === 0) return;
    const directory = this.getEventDirectory(msg.payload, sessionIDs);
    void endpoint.restProxy
      .refreshSessionCatalogEventAuthorization(sessionIDs, directory)
      .then((authorized) => {
        if (!authorized || !this.endpoints.has(endpoint)) return;
        const projected = this.projectEventForEndpoint(msg, endpoint);
        if (projected) endpoint.bridge.post(projected);
      })
      .catch(() => undefined);
  }

  private getEventDirectory(event: ServerEvent, sessionIDs: readonly string[]) {
    if (event.workspaceDirectory) return event.workspaceDirectory;
    if (event.type === 'session.created' || event.type === 'session.updated') {
      const info = asRecord(event.properties?.info);
      if (typeof info?.directory === 'string') return info.directory;
    }
    for (const sessionID of sessionIDs) {
      const directory = this.sessionState.directoryFor(sessionID);
      if (directory) return directory;
    }
    return undefined;
  }

  private isEventInOpenWorkspace(event: ServerEvent) {
    if (event.workspaceDirectory) {
      return this.isOpenSessionDirectory(event.workspaceDirectory);
    }
    return getWorkspaceSessionIdsForEvent(event).some((sessionID) => {
      const directory = this.sessionState.directoryFor(sessionID);
      return Boolean(directory && this.isOpenSessionDirectory(directory));
    });
  }

  private releaseDeletedEditorRestorations(event: ServerEvent) {
    if (event.type !== 'session.deleted') return;
    const deletedSessionId = event.properties?.info?.id || event.properties?.sessionID;
    if (!deletedSessionId) return;
    for (const endpoint of this.editorPanels.values()) {
      const restoringSessionId = endpoint.restoringSessionId;
      if (
        restoringSessionId &&
        (restoringSessionId === deletedSessionId ||
          this.sessionState.rootSessionIdFor(restoringSessionId) === deletedSessionId)
      ) {
        endpoint.restoringSessionId = undefined;
      }
    }
  }

  private removeDeletedSessionPersistence(event: ServerEvent) {
    if (event.type !== 'session.deleted') return;
    const sessionId = event.properties?.info?.id || event.properties?.sessionID;
    if (!sessionId) return;
    const cleanup = Promise.all([
      this.sessionPermissionModes.removeSession(sessionId),
      this.sessionSelectedModels.removeSession(sessionId),
      this.sessionPlanState.removeSession(sessionId),
    ]);
    void cleanup.catch(
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection reasons are normalized for logging at this boundary.
      (error: unknown) => {
        logger.warn(
          `Failed to remove persisted state for deleted session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    );
  }

  private postQueuedSessionStatus(event: ServerEvent) {
    let sessionId: string | undefined;
    let status: 'busy' | 'idle' | undefined;
    if (event.type === 'session.status') {
      sessionId = event.properties?.sessionID;
      const statusType = event.properties?.status?.type;
      if (statusType === 'busy' || statusType === 'idle') status = statusType;
    } else if (event.type === 'session.idle') {
      sessionId = event.properties?.sessionID;
      status = 'idle';
    } else if (event.type === 'message.updated') {
      const info = asRecord(event.properties?.info);
      const time = asRecord(info?.time);
      if (
        info?.role === 'assistant' &&
        typeof time?.completed === 'number' &&
        typeof info.sessionID === 'string' &&
        !this.sessionState.busy.has(info.sessionID)
      ) {
        sessionId = info.sessionID;
        status = 'idle';
      }
    }
    if (!sessionId || !status) return;
    this.postQueuedSessionStatusFor(sessionId, status);
  }

  private postQueuedSessionStatusFor(sessionId: string, status: 'busy' | 'idle') {
    if (!(this.queuedMessages.list() ?? []).some((message) => message.sessionId === sessionId)) {
      return;
    }
    const currentStatus =
      status === 'idle' && this.sessionState.busy.has(sessionId) ? 'busy' : status;
    for (const endpoint of this.endpoints) {
      if (!endpoint.ready) continue;
      endpoint.bridge.post({
        type: 'queued-messages/session-status',
        payload: { sessionId, status: currentStatus },
      });
    }
  }

  private shouldDeferWorkspaceEvent(event: ServerEvent) {
    if (event.workspaceDirectory) return false;
    if (WORKSPACE_CATALOG_EVENT_TYPES.has(event.type)) return false;
    const sessionIDs = getWorkspaceSessionIdsForEvent(event);
    return sessionIDs.some((sessionID) => !this.sessionState.directoryFor(sessionID));
  }

  private flushDeferredWorkspaceEvents() {
    if (this.deferredWorkspaceEvents.length === 0) return;
    const ready: ServerEvent[] = [];
    const pending: ServerEvent[] = [];
    for (const event of this.deferredWorkspaceEvents) {
      (this.shouldDeferWorkspaceEvent(event) ? pending : ready).push(event);
    }
    this.deferredWorkspaceEvents.splice(0, this.deferredWorkspaceEvents.length, ...pending);
    for (const event of ready) {
      this.postToEndpoints({ type: 'server/event', payload: event });
      if (EDITOR_TITLE_EVENT_TYPES.has(event.type)) this.updateEditorPanelTitles();
    }
  }

  private scheduleSessionDirectoryReconciliation() {
    if (this.sessionDirectoryReconciliationScheduled) return;
    this.sessionDirectoryReconciliationScheduled = true;
    queueMicrotask(() => {
      this.sessionDirectoryReconciliationScheduled = false;
      if (this.disposing) return;
      this.flushDeferredWorkspaceEvents();
      this.reconcilePermissionAutomationOwners(true);
      void this.recoverPendingPermissionModeFallbacks();
    });
  }

  private isEventInEndpointWorkspace(event: ServerEvent, endpoint: WebviewEndpoint) {
    if (!endpoint.workspacePath) return true;
    const workspaceDirectory = this.contextProvider.context.workspaceDirectory;
    const workspaceDirectoryIsOpenRoot = Boolean(
      workspaceDirectory && this.contextProvider.getOpenWorkspaceRoot(workspaceDirectory)
    );
    const sessionIDs = getWorkspaceSessionIdsForEvent(event);
    if (event.workspaceDirectory) {
      if (
        workspaceDirectory &&
        isSameWorkspacePath(event.workspaceDirectory, workspaceDirectory) &&
        (!workspaceDirectoryIsOpenRoot ||
          (sessionIDs.length > 0 &&
            sessionIDs.every(
              (sessionID) => this.sessionState.workspaceScopeFor(sessionID) === 'workspace'
            )))
      ) {
        return true;
      }
      return isSameWorkspacePath(event.workspaceDirectory, endpoint.workspacePath);
    }
    if (sessionIDs.length === 0) return WORKSPACE_INDEPENDENT_EVENT_TYPES.has(event.type);
    let knownMatch = false;
    for (const sessionID of sessionIDs) {
      const directory = this.sessionState.directoryFor(sessionID);
      if (
        workspaceDirectory &&
        isSameWorkspacePath(directory, workspaceDirectory) &&
        (!workspaceDirectoryIsOpenRoot ||
          this.sessionState.workspaceScopeFor(sessionID) === 'workspace')
      ) {
        knownMatch = true;
        continue;
      }
      const match = this.sessionState.getSessionWorkspaceMatch(sessionID, endpoint.workspacePath);
      if (match === false) return false;
      if (match === true) knownMatch = true;
    }
    return knownMatch;
  }

  private isOpenSessionDirectory(directory: string) {
    return Boolean(this.getOpenSessionDirectory(directory));
  }

  private getOpenSessionDirectory(directory: string): string | null {
    const workspaceRoot = this.contextProvider.getOpenWorkspaceRoot(directory);
    if (workspaceRoot) return workspaceRoot;
    const workspaceDirectory = this.contextProvider.context.workspaceDirectory;
    return workspaceDirectory && isSameWorkspacePath(directory, workspaceDirectory)
      ? workspaceDirectory
      : null;
  }

  private permissionAutomationFor(viewId: string) {
    const workspace =
      this.permissionAutomationOwnerWorkspaces.get(viewId) ??
      normalizeWorkspaceIdentity(
        [...this.endpoints].find((endpoint) => endpoint.viewId === viewId)?.workspacePath
      ) ??
      '*';
    return {
      owner: this.permissionAutomationOwnerViewIds.has(viewId),
      lease: this.permissionAutomationLeases.get(workspace) ?? 0,
    };
  }

  private setEndpointReady(endpoint: WebviewEndpoint, ready: boolean) {
    if (endpoint.ready === ready) return;
    endpoint.ready = ready;
    if (!ready) endpoint.siblingAlertsKey = '';
    if (!ready) {
      for (const [sessionId, viewId] of this.deferredInterruptedRecoveryOwners) {
        if (viewId === endpoint.viewId) this.deferredInterruptedRecoveryOwners.delete(sessionId);
      }
    }
    if (!ready) this.queuedMessages.releaseDispatchClaimsForView(endpoint.viewId);
    if (!this.disposing) this.reconcileQueuedMessageOwners();
    this.reconcilePermissionAutomationOwners();
    this.postSiblingWorkspaceAlerts();
  }

  private reconcilePermissionAutomationOwners(resendActionable = false) {
    const owners: WebviewEndpoint[] = [];
    const workspaceGroups = new Map<string, WebviewEndpoint[]>();
    for (const endpoint of this.endpoints) {
      if (!endpoint.ready) continue;
      const key = normalizeWorkspaceIdentity(endpoint.workspacePath) ?? '*';
      const group = workspaceGroups.get(key) ?? [];
      group.push(endpoint);
      workspaceGroups.set(key, group);
    }
    for (const group of workspaceGroups.values()) {
      const current = group.find((endpoint) =>
        this.permissionAutomationOwnerViewIds.has(endpoint.viewId)
      );
      owners.push(group.find((endpoint) => endpoint.surface === 'sidebar') ?? current ?? group[0]!);
    }
    const nextOwnerViewIds = new Set(owners.map((endpoint) => endpoint.viewId));
    const nextOwnerWorkspaces = new Map(
      owners.map((endpoint) => [
        endpoint.viewId,
        normalizeWorkspaceIdentity(endpoint.workspacePath) ?? '*',
      ])
    );
    const previousOwnerByWorkspace = new Map(
      [...this.permissionAutomationOwnerWorkspaces].map(([viewId, workspace]) => [
        workspace,
        viewId,
      ])
    );
    const nextOwnerByWorkspace = new Map(
      [...nextOwnerWorkspaces].map(([viewId, workspace]) => [workspace, viewId])
    );
    if (
      nextOwnerViewIds.size === this.permissionAutomationOwnerViewIds.size &&
      [...nextOwnerViewIds].every(
        (viewId) =>
          this.permissionAutomationOwnerViewIds.has(viewId) &&
          this.permissionAutomationOwnerWorkspaces.get(viewId) === nextOwnerWorkspaces.get(viewId)
      )
    ) {
      if (resendActionable) this.postPendingPermissionActionables();
      this.reconcileInterruptedRecoveryOwners(owners);
      return;
    }
    for (const workspace of new Set([
      ...previousOwnerByWorkspace.keys(),
      ...nextOwnerByWorkspace.keys(),
    ])) {
      if (previousOwnerByWorkspace.get(workspace) === nextOwnerByWorkspace.get(workspace)) continue;
      if (nextOwnerByWorkspace.has(workspace)) {
        this.permissionAutomationLeases.set(workspace, ++this.nextPermissionAutomationLease);
      } else {
        this.permissionAutomationLeases.delete(workspace);
      }
    }
    this.permissionAutomationOwnerViewIds.clear();
    this.permissionAutomationOwnerWorkspaces.clear();
    for (const viewId of nextOwnerViewIds) this.permissionAutomationOwnerViewIds.add(viewId);
    for (const [viewId, workspace] of nextOwnerWorkspaces) {
      this.permissionAutomationOwnerWorkspaces.set(viewId, workspace);
    }
    for (const endpoint of this.endpoints) {
      if (!endpoint.ready) continue;
      endpoint.bridge.post({
        type: 'permission-automation/update',
        payload: this.permissionAutomationFor(endpoint.viewId),
      });
    }
    this.postPendingPermissionActionables();
    this.reconcileInterruptedRecoveryOwners(owners);
  }

  private postPendingPermissionActionables() {
    for (const [permissionId, request] of this.sessionState.pending) {
      if (request.kind !== 'permission') continue;
      this.permissionAutomationOwnerForSession(request.sessionID)?.bridge.post({
        type: 'permission/actionable',
        payload: { permissionId },
      });
    }
  }

  private permissionAutomationOwnerForSession(sessionID: string) {
    const directory = this.sessionState.directoryFor(sessionID);
    if (!directory) return undefined;
    const owners = [...this.endpoints].filter(
      (endpoint) => endpoint.ready && this.permissionAutomationOwnerViewIds.has(endpoint.viewId)
    );
    return owners.find((endpoint) => isSameWorkspacePath(endpoint.workspacePath, directory));
  }

  private reconcileInterruptedRecoveryOwners(owners: WebviewEndpoint[]) {
    const activeClaim = this.interruptedRecoveryClaim;
    if (activeClaim) {
      const owner = owners.find((candidate) => candidate.viewId === activeClaim.viewId);
      if (!owner || !isSameWorkspacePath(owner.workspacePath, activeClaim.workspacePath)) {
        this.interruptedRecoveryClaim = null;
      }
    }
    if (this.interruptedRecoveryClaim) return;
    const candidates = this.sessionState
      .claimInterruptedSessions()
      .filter((session) => !this.deferredInterruptedRecoveryOwners.has(session.id));
    const owner = owners.find((candidate) =>
      candidates.some((session) => {
        const directory = session.directory ?? this.sessionState.directoryFor(session.id);
        return directory ? isSameWorkspacePath(directory, candidate.workspacePath) : false;
      })
    );
    if (!owner) return;
    const sessions = candidates.filter((session) => {
      const directory = session.directory ?? this.sessionState.directoryFor(session.id);
      return directory ? isSameWorkspacePath(directory, owner.workspacePath) : false;
    });
    if (sessions.length === 0) return;
    const claim = {
      claimId: ++this.nextInterruptedRecoveryClaimId,
      sessionIds: sessions.map((session) => session.id),
      viewId: owner.viewId,
      workspacePath: owner.workspacePath,
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
      if (consumedSet.has(sessionId)) this.deferredInterruptedRecoveryOwners.delete(sessionId);
      else this.deferredInterruptedRecoveryOwners.set(sessionId, claim.viewId);
    }
    const owners = [...this.endpoints].filter(
      (endpoint) => endpoint.ready && this.permissionAutomationOwnerViewIds.has(endpoint.viewId)
    );
    this.reconcileInterruptedRecoveryOwners(owners);
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
    else if (endpoint?.ready && !this.queuedMessages.has(payload.sessionId, payload.itemId)) {
      result.deniedReason = 'missing';
    }
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
    this.reconcilePermissionAutomationOwners();
    const sessionID = this.sessionState.pending.get(permissionId)?.sessionID;
    const owner = sessionID ? this.permissionAutomationOwnerForSession(sessionID) : undefined;
    owner?.bridge.post({ type: 'permission/actionable', payload: { permissionId } });
  }

  private postPermissionModes(modes = this.sessionPermissionModes.list()) {
    const recoveringSessionIds = this.sessionPermissionModes.pendingSafeFallbackSessionIds();
    const payload: Extract<ExtensionMessage, { type: 'permission-modes/sync' }>['payload'] = {
      modes,
    };
    if (recoveringSessionIds.length > 0) payload.recoveringSessionIds = recoveringSessionIds;
    this.post({
      type: 'permission-modes/sync',
      payload,
    });
  }

  private recoverPendingPermissionModeFallbacks(): Promise<void> {
    if (this.permissionModeFallbackRetryTimer) {
      clearTimeout(this.permissionModeFallbackRetryTimer);
      this.permissionModeFallbackRetryTimer = null;
    }
    if (this.permissionModeFallbackReconciliation) {
      this.permissionModeFallbackReconciliationRequested = true;
      return this.permissionModeFallbackReconciliation;
    }
    this.permissionModeFallbackReconciliationRequested = false;
    const operation = this.runPermissionModeFallbackRecovery();
    this.permissionModeFallbackReconciliation = operation;
    const clear = () => {
      if (this.permissionModeFallbackReconciliation === operation) {
        this.permissionModeFallbackReconciliation = null;
        if (this.permissionModeFallbackReconciliationRequested && !this.disposing) {
          this.permissionModeFallbackReconciliationRequested = false;
          void this.recoverPendingPermissionModeFallbacks();
        } else if (this.sessionPermissionModes.pendingSafeFallbackSessionIds().length > 0) {
          this.schedulePermissionModeFallbackRecovery();
        } else if (this.permissionModeFallbackRetryTimer) {
          clearTimeout(this.permissionModeFallbackRetryTimer);
          this.permissionModeFallbackRetryTimer = null;
          this.resetPermissionModeFallbackBackoff();
        } else {
          this.resetPermissionModeFallbackBackoff();
        }
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  private schedulePermissionModeFallbackRecovery() {
    if (this.disposing || this.permissionModeFallbackRetryTimer) return;
    const delay = this.permissionModeFallbackRetryMs;
    this.permissionModeFallbackRetryMs = Math.min(
      delay * 2,
      SidebarProvider.PERMISSION_MODE_FALLBACK_RETRY_MAX_MS
    );
    this.permissionModeFallbackRetryTimer = setTimeout(() => {
      this.permissionModeFallbackRetryTimer = null;
      void this.recoverPendingPermissionModeFallbacks();
    }, delay);
  }

  private resetPermissionModeFallbackBackoff() {
    this.permissionModeFallbackRetryMs = SidebarProvider.PERMISSION_MODE_FALLBACK_RETRY_INITIAL_MS;
  }

  private async runPermissionModeFallbackRecovery() {
    const pendingSessionIDs = this.sessionPermissionModes.pendingSafeFallbackSessionIds();
    if (pendingSessionIDs.length === 0) {
      this.resetPermissionModeFallbackBackoff();
      return;
    }
    try {
      await this.runtime.ensureServerStarted();
    } catch (err) {
      logger.warn(
        `Could not recover pending permission modes: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    const recover = async (directoriesBySessionID: ReadonlyMap<string, string>) => {
      const sessionIDs = [...directoriesBySessionID.keys()];
      const results = await Promise.allSettled(
        sessionIDs.map((sessionID) =>
          this.updateConfirmedPermissionMode(
            sessionID,
            'default',
            directoriesBySessionID.get(sessionID),
            true
          )
        )
      );
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result?.status !== 'rejected') continue;
        logger.warn(
          `Could not recover pending permission mode for ${sessionIDs[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        );
      }
    };

    const knownDirectories = new Map<string, string>();
    for (const sessionID of pendingSessionIDs) {
      const directory = this.sessionState.directoryFor(sessionID);
      if (directory) knownDirectories.set(sessionID, directory);
    }
    await recover(knownDirectories);

    if (this.sessionPermissionModes.pendingSafeFallbackSessionIds().length === 0) {
      this.resetPermissionModeFallbackBackoff();
      return;
    }

    const unresolvedSessionIDs = new Set(
      this.sessionPermissionModes
        .pendingSafeFallbackSessionIds()
        .filter((sessionID) => !this.sessionState.directoryFor(sessionID))
    );
    if (unresolvedSessionIDs.size === 0) return;
    const catalog = await this.restProxy.loadPermissionModeRecoveryCatalog();
    const discoveredDirectories = new Map<string, string>();
    const catalogSessionIDs = new Set<string>();
    for (const session of catalog.sessions) {
      catalogSessionIDs.add(session.id);
      if (unresolvedSessionIDs.has(session.id)) {
        discoveredDirectories.set(session.id, session.directory);
      }
    }
    await recover(discoveredDirectories);

    if (catalog.complete) {
      const absentSessionIDs = this.sessionPermissionModes
        .pendingSafeFallbackSessionIds()
        .filter(
          (sessionID) => unresolvedSessionIDs.has(sessionID) && !catalogSessionIDs.has(sessionID)
        );
      const removals = await Promise.allSettled(
        absentSessionIDs.map((sessionID) => this.sessionPermissionModes.removeSession(sessionID))
      );
      for (let index = 0; index < removals.length; index += 1) {
        const result = removals[index];
        if (result?.status !== 'rejected') continue;
        logger.warn(
          `Could not clear absent permission mode ${absentSessionIDs[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        );
      }
      if (absentSessionIDs.length > 0) this.postPermissionModes();
    }

    if (this.sessionPermissionModes.pendingSafeFallbackSessionIds().length === 0) {
      this.resetPermissionModeFallbackBackoff();
    }
  }

  private updateConfirmedPermissionMode(
    sessionID: string,
    mode: PermissionMode,
    directory?: string,
    recoverFallback = false,
    defaultPermission?: PermissionRule[]
  ) {
    const previous = this.permissionModeQueues.get(sessionID) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (
          recoverFallback &&
          !this.sessionPermissionModes.pendingSafeFallbackSessionIds().includes(sessionID)
        ) {
          return;
        }
        try {
          await this.sessionPermissionModes.stageSafeFallback(sessionID);
        } catch (err) {
          this.postPermissionModes();
          this.schedulePermissionModeFallbackRecovery();
          throw err;
        }
        this.postPermissionModes();
        let session: unknown;
        try {
          const permission =
            mode === 'default'
              ? (defaultPermission ?? getSafeDefaultPermissionRules())
              : getSessionPermissionRulesForMode(mode, 'update');
          session = await this.server.request(
            'PATCH',
            `/session/${encodeURIComponent(sessionID)}`,
            { permission },
            { directory }
          );
        } catch (err) {
          this.postPermissionModes();
          this.schedulePermissionModeFallbackRecovery();
          throw err;
        }
        try {
          const modes = await this.sessionPermissionModes.set(sessionID, mode);
          this.postPermissionModes(modes);
        } catch (err) {
          logger.warn(
            `Failed to persist confirmed permission mode: ${err instanceof Error ? err.message : String(err)}`
          );
          this.postPermissionModes();
          try {
            await this.server.request(
              'PATCH',
              `/session/${encodeURIComponent(sessionID)}`,
              { permission: getSafeDefaultPermissionRules() },
              { directory }
            );
            await this.sessionPermissionModes.set(sessionID, 'default');
            this.postPermissionModes();
          } catch (recoveryError) {
            logger.warn(
              `Could not immediately restore safe permission rules: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
            );
            this.schedulePermissionModeFallbackRecovery();
          }
          throw new Error('Permission mode was not saved; safe default recovery is in progress', {
            cause: err,
          });
        }
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

  private allowPermissionForSession(
    sessionID: string,
    permission: string,
    patterns: string[],
    directory?: string
  ): Promise<void> {
    const previous = this.permissionModeQueues.get(sessionID) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const session = asRecord(
          await this.server.request('GET', `/session/${encodeURIComponent(sessionID)}`, undefined, {
            directory,
          })
        );
        if (session?.id !== sessionID) throw new Error('404 Session not found');
        const existing = Array.isArray(session.permission) ? session.permission : [];
        const additions = patterns
          .filter(
            (pattern) =>
              !existing.some((value) => {
                const rule = asRecord(value);
                return (
                  rule?.permission === permission &&
                  rule.pattern === pattern &&
                  rule.action === 'allow'
                );
              })
          )
          .map((pattern) => ({ permission, pattern, action: 'allow' }));
        await this.server.request(
          'PATCH',
          `/session/${encodeURIComponent(sessionID)}`,
          { permission: [...existing, ...additions] },
          { directory }
        );
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

  private updatePermissionRulesForSession(
    sessionID: string,
    rules: PermissionRule[],
    directory?: string
  ): Promise<PermissionRule[]> {
    const previous = this.permissionModeQueues.get(sessionID) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        await this.server.request(
          'PATCH',
          `/session/${encodeURIComponent(sessionID)}`,
          { permission: rules },
          { directory }
        );
        return rules;
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

  private persistPreconfiguredPermissionMode(
    sessionID: string,
    mode: PermissionMode,
    directory?: string,
    ifAbsent = false,
    resetRemoteRules = false
  ): Promise<void> {
    const previous = this.permissionModeQueues.get(sessionID) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (ifAbsent && Object.hasOwn(this.sessionPermissionModes.list(), sessionID)) return;
        try {
          await this.sessionPermissionModes.stageSafeFallback(sessionID);
        } catch (err) {
          this.postPermissionModes();
          try {
            await this.server.request(
              'PATCH',
              `/session/${encodeURIComponent(sessionID)}`,
              { permission: getSafeDefaultPermissionRules() },
              { directory }
            );
          } catch (recoveryError) {
            logger.warn(
              `Could not restore safe rules after fallback persistence failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
            );
          }
          this.schedulePermissionModeFallbackRecovery();
          throw err;
        }
        this.postPermissionModes();
        if (resetRemoteRules) {
          try {
            await this.server.request(
              'PATCH',
              `/session/${encodeURIComponent(sessionID)}`,
              {
                permission:
                  mode === 'default'
                    ? getSafeDefaultPermissionRules()
                    : getSessionPermissionRulesForMode(mode, 'update'),
              },
              { directory }
            );
          } catch (err) {
            this.postPermissionModes();
            this.schedulePermissionModeFallbackRecovery();
            throw err;
          }
        }
        try {
          const modes = await this.sessionPermissionModes.set(sessionID, mode);
          this.postPermissionModes(modes);
        } catch (err) {
          this.postPermissionModes();
          this.schedulePermissionModeFallbackRecovery();
          throw new Error('Permission mode was not saved; safe default recovery is in progress', {
            cause: err,
          });
        }
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
      const title = this.editorSessionTitle(endpoint.route);
      if (endpoint.route.title !== title) endpoint.route = { ...endpoint.route, title };
      const panelTitle = this.editorTitle(endpoint.route);
      if (endpoint.panel.title !== panelTitle) endpoint.panel.title = panelTitle;
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

  private isSessionOpen(rootSessionID: string, workspacePath: string) {
    const routeMatches = (route: WebviewRoute, endpointWorkspacePath: string | null) =>
      (!endpointWorkspacePath || isSameWorkspacePath(endpointWorkspacePath, workspacePath)) &&
      route.type === 'session' &&
      (route.rootSessionId || this.sessionState.rootSessionIdFor(route.sessionId)) ===
        rootSessionID;
    return (
      [...this.endpoints].some(
        (endpoint) =>
          endpoint.surface === 'sidebar' && routeMatches(endpoint.route, endpoint.workspacePath)
      ) ||
      [...this.editorPanels.values()].some((editor) =>
        routeMatches(
          editor.route,
          [...this.endpoints].find((endpoint) => endpoint.viewId === editor.viewId)
            ?.workspacePath ?? editor.workspacePath
        )
      )
    );
  }

  private siblingWorkspaceAlertsFor(endpoint: WebviewEndpoint): SiblingWorkspaceAlert[] {
    const folders = this.contextProvider.context.workspaceFolders ?? [];
    const alerts = new Map<
      string,
      {
        name: string;
        path: string;
        kinds: Set<SiblingWorkspaceAlert['kinds'][number]>;
        count: number;
      }
    >();

    for (const candidate of this.sessionState.getSiblingAlertCandidates()) {
      const kinds = candidate.kinds.filter((kind) => kind !== 'completed');
      if (kinds.length === 0) continue;
      if (
        this.isSessionOpen(candidate.rootSessionID, candidate.directory) ||
        this.sessionTrash.isHidden(candidate.sessionID) ||
        this.sessionTrash.isHidden(candidate.rootSessionID) ||
        this.hiddenSessions.isHidden(candidate.sessionID) ||
        this.hiddenSessions.isHidden(candidate.rootSessionID)
      ) {
        continue;
      }
      const folder = folders.find((item) => isSameWorkspacePath(item.path, candidate.directory));
      if (!folder || isSameWorkspacePath(folder.path, endpoint.workspacePath)) continue;
      const existing = alerts.get(folder.path);
      if (existing) {
        existing.count += kinds.length;
        for (const kind of kinds) existing.kinds.add(kind);
      } else {
        alerts.set(folder.path, {
          name: folder.name,
          path: folder.path,
          kinds: new Set(kinds),
          count: kinds.length,
        });
      }
    }

    return [...alerts.values()]
      .map((alert) => ({ ...alert, kinds: [...alert.kinds].toSorted() }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }

  private postSiblingWorkspaceAlerts() {
    for (const endpoint of this.endpoints) {
      if (!endpoint.ready) continue;
      const payload = this.siblingWorkspaceAlertsFor(endpoint);
      const key = JSON.stringify(payload);
      if (key === endpoint.siblingAlertsKey) continue;
      endpoint.siblingAlertsKey = key;
      endpoint.bridge.post({ type: 'sibling-workspace-alerts/update', payload });
    }
  }

  private isAnyChatVisible() {
    return [...this.endpoints].some((endpoint) => endpoint.bridge.isVisible());
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

  private openEditorSessionIds() {
    return [
      ...new Set(
        [...this.editorPanels.values()].flatMap((endpoint) =>
          endpoint.route.type === 'session'
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

  captureContextTarget() {
    return this.resolveContextEndpoint(this.lastFocusedContextViewId).viewId;
  }

  postDroppedFiles(
    files: Array<Pick<DroppedFile, 'path' | 'relativePath' | 'type'>>,
    targetViewId?: string
  ) {
    const endpoint = this.resolveContextEndpoint(targetViewId);
    endpoint.contextFilesState.postDroppedFiles(files, (message) => endpoint.bridge.post(message));
  }

  postTerminalSelection(selection: TerminalSelection | null, targetViewId?: string) {
    const endpoint = this.resolveContextEndpoint(targetViewId);
    endpoint.contextFilesState.setTerminalSelection(selection);
    endpoint.bridge.post({ type: 'terminal-selection/update', payload: selection });
  }

  async revealContextTarget(targetViewId: string, revealSidebar: () => PromiseLike<void>) {
    const endpoint = this.resolveContextEndpoint(targetViewId);
    if (endpoint.surface === 'sidebar') {
      await revealSidebar();
      return;
    }
    const editor = [...this.editorPanels.values()].find(
      (candidate) => candidate.viewId === endpoint.viewId
    );
    if (editor) editor.panel.reveal(editor.panel.viewColumn, false);
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

  getStatusBarClickAction() {
    return this.getStatusBarState().action;
  }

  async openSiblingWorkspaceSessions() {
    const sidebarEndpoint = [...this.endpoints].find((endpoint) => endpoint.surface === 'sidebar');
    const alert = sidebarEndpoint ? this.siblingWorkspaceAlertsFor(sidebarEndpoint)[0] : undefined;
    if (!sidebarEndpoint || !alert) return;

    const workspacePath = this.contextProvider.getOpenWorkspaceRoot(alert.path);
    if (!workspacePath) return;
    this.setEndpointWorkspace(sidebarEndpoint, workspacePath);
    this.reconcilePermissionAutomationOwners();
    await this.contextProvider.selectWorkspace(workspacePath);
    this.postSiblingWorkspaceAlerts();
    this.webviewSession.searchSessions();
  }

  openAttentionSessions() {
    this.webviewSession.openAttentionSessions();
  }

  openCompletedSessions() {
    this.sessionState.clearCompletedInWorkspace(this.contextProvider.context.workspacePath);
    this.webviewSession.openCompletedSessions();
  }

  async dispose() {
    this.disposing = true;
    this.sessionReconcileRerunRequested = false;
    if (this.sessionReconcileTimer) {
      clearInterval(this.sessionReconcileTimer);
      this.sessionReconcileTimer = null;
      this.sessionReconcileIntervalMs = 0;
    }
    this.sessionState.dispose();
    this.providerFileRefresh.beginDispose();
    for (const endpoint of this.endpoints) this.setEndpointReady(endpoint, false);
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
    if (this.permissionModeFallbackRetryTimer) {
      clearTimeout(this.permissionModeFallbackRetryTimer);
      this.permissionModeFallbackRetryTimer = null;
    }
    await this.webviewSession.dispose();
    await this.ralphHost.dispose();
    await this.serverEventBridge.dispose();
    await this.queuedMessages.dispose();
    await this.draftImages.dispose();
    await this.sessionPermissionModes.dispose();
    await this.sessionSelectedModels.dispose();
    await this.sessionPlanState.dispose();
    await this.modelPreferences.dispose();
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

  private updateQueuedMessages(viewId: string, messages: QueuedMessageSnapshot[]): Promise<void> {
    const endpoint = [...this.endpoints].find((item) => item.viewId === viewId);
    if (!endpoint?.ready) return Promise.resolve();
    const nextPdfPaths = new Set(
      messages.flatMap((message) =>
        (message.nativePdfs ?? []).flatMap((pdf) => (pdf.contextFile ? [pdf.contextFile.path] : []))
      )
    );
    for (const path of nextPdfPaths) this.droppedFilesService.markQueuedPdf(path);
    const persistence = this.queuedMessages.updateOwned(viewId, messages);
    this.observeQueuedMessagePersistence(persistence);
    this.queuedPdfCleanupRequested = true;
    this.scheduleQueuedPdfCleanup();
    return Promise.resolve();
  }

  private observeQueuedMessagePersistence(persistence: Promise<void>) {
    if (this.observedQueuedMessagePersistences.has(persistence)) return;
    this.observedQueuedMessagePersistences.add(persistence);
    void persistence
      .then(
        () => {
          this.postQueuedMessageSnapshots();
          this.updateSessionReconcileTimer();
          void this.runSessionReconcile();
        },
        (error) => {
          this.postQueuedMessageSnapshots();
          logger.error(
            `Queued message persistence failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      )
      .finally(() => {
        this.observedQueuedMessagePersistences.delete(persistence);
      });
  }

  private scheduleQueuedPdfCleanup() {
    if (this.queuedPdfCleanup) return;
    const cleanup = (async () => {
      while (this.queuedPdfCleanupRequested) {
        this.queuedPdfCleanupRequested = false;
        await this.queuedMessages.whenIdle();
        const referencedPaths = new Set(
          (this.queuedMessages.list() ?? []).flatMap((message) =>
            (message.nativePdfs ?? []).flatMap((pdf) =>
              pdf.contextFile ? [pdf.contextFile.path] : []
            )
          )
        );
        await this.droppedFilesService.removeOwnedFiles(
          (function* (paths: Iterable<string>) {
            for (const path of paths) {
              if (!referencedPaths.has(path)) yield path;
            }
          })(this.droppedFilesService.ownedQueuedPdfPaths())
        );
      }
    })();
    this.queuedPdfCleanup = cleanup;
    const finish = () => {
      if (this.queuedPdfCleanup !== cleanup) return;
      this.queuedPdfCleanup = null;
      if (this.queuedPdfCleanupRequested) this.scheduleQueuedPdfCleanup();
    };
    void cleanup.then(finish, (error) => {
      logger.error(
        `Queued PDF cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      );
      finish();
    });
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
    await this.draftImages.update([], viewId);
    await this.draftImages.dispose();
    await this.droppedFilesService.removeOwnedFiles(imagePaths);
  }

  private reconcileQueuedMessageOwners(
    remainingAttempts = SidebarProvider.QUEUE_OWNER_RECONCILE_MAX_ATTEMPTS
  ) {
    const eligibleEndpoints = [...this.endpoints].filter((endpoint) => endpoint.ready);
    if (eligibleEndpoints.length === 0) return;
    const eligibleByViewId = new Map(
      eligibleEndpoints.map((endpoint) => [endpoint.viewId, endpoint] as const)
    );
    const sidebar = eligibleEndpoints.find((endpoint) => endpoint.surface === 'sidebar');
    const sessionEditors = new Map<string, WebviewEndpoint>();
    for (const editor of this.editorPanels.values()) {
      const endpoint = eligibleByViewId.get(editor.viewId);
      if (endpoint && editor.route.type === 'session') {
        sessionEditors.set(editor.route.sessionId, endpoint);
      }
    }
    const persistence = this.queuedMessages.reassignOwners(
      (message) =>
        sessionEditors.get(message.sessionId)?.viewId ??
        sidebar?.viewId ??
        (eligibleByViewId.has(message.ownerViewId ?? 'sidebar')
          ? (message.ownerViewId ?? 'sidebar')
          : eligibleEndpoints[0]!.viewId)
    );
    if (!persistence) return;
    this.postQueuedMessageSnapshots();
    void persistence.catch((err) => {
      this.postQueuedMessageSnapshots();
      if (remainingAttempts > 1) this.reconcileQueuedMessageOwners(remainingAttempts - 1);
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

  private refreshProviderCatalog() {
    this.providerLimitService.clearCache();
    this.post({ type: 'providers/refresh' });
    return Promise.resolve();
  }

  private async providerAuthChanged() {
    await this.providerFileRefresh.acknowledgeEmbeddedAuthChange();
  }

  private async refreshOpenCodeWorkspaceState(
    previousRouting?: OpenCodeModelRouting,
    currentRouting?: OpenCodeModelRouting,
    workspacePath?: string
  ) {
    await this.providerFileRefresh.refreshWorkspaceState(
      previousRouting,
      currentRouting,
      workspacePath
    );
  }

  private async cleanupExpiredRecycleBin() {
    await this.runtime.cleanupExpiredRecycleBin(this.serverEventBridge.getStatus());
  }

  private postConfigState() {
    this.post({ type: 'config/update', payload: this.readConfig() });
  }

  private withWorkspacePath(context: EditorContext, workspacePath: string | null): EditorContext {
    return { ...context, workspacePath };
  }

  private resolveContextEndpoint(targetViewId?: string | null) {
    const target = targetViewId
      ? [...this.endpoints].find((endpoint) => endpoint.viewId === targetViewId)
      : undefined;
    return target ?? [...this.endpoints].find((endpoint) => endpoint.surface === 'sidebar')!;
  }

  private setEndpointWorkspace(endpoint: WebviewEndpoint, workspacePath: string) {
    if (isSameWorkspacePath(endpoint.workspacePath, workspacePath)) return;
    endpoint.contextFilesState.clearContextFiles();
    endpoint.contextFilesState.setTerminalSelection(null);
    endpoint.workspacePath = workspacePath;
  }

  private async storePdf(
    payload: Extract<WebviewMessage, { type: 'pdfs/store' }>['payload'],
    post: (message: ExtensionMessage) => void = (message) => this.post(message),
    isAvailable: () => boolean = () => true
  ) {
    const [contextFile] = await this.droppedFilesService.fromContent(
      [{ name: payload.name, content: payload.content, size: payload.size }],
      { maxFileBytes: MAX_NATIVE_PDF_TOTAL_BYTES }
    );
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
    isAvailable: () => boolean = () => true,
    onStored: (contextFile: DroppedFile) => void = () => {}
  ) {
    const [contextFile] = await this.droppedFilesService.fromContent([
      { name: payload.name, content: payload.content, size: payload.size },
    ]);
    if (contextFile) {
      if (!isAvailable()) {
        await this.droppedFilesService.removeOwnedFile(contextFile.path);
        return;
      }
      onStored(contextFile);
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

  private searchFiles(
    requestId: number,
    query: string,
    limit = 12,
    workspaceDirectory: string | null | undefined = this.contextProvider.context.workspacePath,
    post: (message: ExtensionMessage) => void = (message) => this.post(message),
    fileSearch = this.fileSearch,
    isAvailable: () => boolean = () => true
  ) {
    fileSearch.search(requestId, query, limit, workspaceDirectory, (result) => {
      if (!isAvailable()) return;
      post({ type: 'files/search-results', payload: result });
    });
  }

  private async runInTerminal(
    command: string,
    title = 'OpenCode',
    workspacePath = this.contextProvider.context.workspacePath || undefined
  ) {
    const text = command.trim();
    if (!text) return;
    const replacesBinary = replacesOpenCodeBinary(text);

    // Same prerequisite as Varro's own upgrade path: on Windows a managed
    // server holds opencode.exe open, and the install or update the user just
    // asked for cannot replace a running binary.
    if (replacesBinary) {
      await this.server.prepareForWindowsCliUpgrade();
    }

    try {
      const terminal = vscode.window.createTerminal({ name: title, cwd: workspacePath });
      if (replacesBinary && process.platform === 'win32') {
        const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
          if (closedTerminal !== terminal) return;
          disposable.dispose();
          void (async () => {
            try {
              await this.server.finishWindowsCliUpgrade();
            } catch (err) {
              logger.warn(
                `Failed to finish Windows OpenCode CLI update: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          })();
        });
      }
      terminal.show(false);
      terminal.sendText(text, true);
    } catch (err) {
      if (replacesBinary) await this.server.finishWindowsCliUpgrade();
      throw err;
    }
  }

  private openSessionInTerminal(
    sessionId: string,
    workspacePath = this.contextProvider.context.workspacePath || undefined
  ) {
    const launch = resolveServerLaunch(this.server.resolveCommand(), ['--session', sessionId]);
    const terminal = vscode.window.createTerminal({
      name: 'OpenCode Session',
      cwd: workspacePath,
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
    this.postSiblingWorkspaceAlerts();
    this.updateSessionReconcileTimer();
    this.refreshOpenCodeVersionStatus();
    this.renderOpenCodeStatusBarItem();
    const next = this.getStatusBarState();
    const nextKey = JSON.stringify(next);
    if (nextKey === this.lastStatusBarStateKey) return;
    this.lastStatusBarStateKey = nextKey;

    const statusBarItem = this.serverEventBridge.getStatusBarItem();
    if (!next.visible) {
      if (this.attentionStatusBarItemVisible) {
        statusBarItem.hide();
        this.attentionStatusBarItemVisible = false;
      }
    } else {
      statusBarItem.text = next.text;
      statusBarItem.backgroundColor = next.backgroundColor;
      statusBarItem.tooltip = next.tooltip;
      if (!this.attentionStatusBarItemVisible) {
        statusBarItem.show();
        this.attentionStatusBarItemVisible = true;
      }
    }
  }

  private refreshOpenCodeVersionStatus() {
    if (this.serverEventBridge.getStatus().state !== 'running') {
      this.openCodeVersionCheck = 'idle';
      this.openCodeUpdateAvailable = false;
      this.openCodeCliVersion = null;
      this.openCodeServerVersion = null;
      return;
    }
    if (this.openCodeVersionCheck !== 'idle') return;

    this.openCodeVersionCheck = 'checking';
    void this.server
      .readServerInfo()
      .then((info) => {
        if (this.disposing || this.serverEventBridge.getStatus().state !== 'running') return;
        this.openCodeCliVersion = info.cliVersion ? extractVersion(info.cliVersion) : null;
        this.openCodeServerVersion = info.health.version
          ? extractVersion(info.health.version)
          : null;
        this.openCodeUpdateAvailable =
          (this.openCodeCliVersion !== null &&
            compareVersions(this.openCodeCliVersion, maximumTestedOpenCodeVersion) < 0) ||
          (this.openCodeCliVersion !== null &&
            this.openCodeServerVersion !== null &&
            compareVersions(this.openCodeServerVersion, this.openCodeCliVersion) < 0);
        this.openCodeVersionCheck = 'checked';
        this.renderOpenCodeStatusBarItem();
      })
      .catch(() => {
        this.openCodeVersionCheck = 'checked';
      });
  }

  private renderOpenCodeStatusBarItem() {
    const updateMarker = this.openCodeUpdateAvailable ? '*' : '';
    const displayedVersion =
      this.openCodeServerVersion ?? this.openCodeCliVersion ?? maximumTestedOpenCodeVersion;
    const autoUpdatesEnabled = vscode.workspace
      .getConfiguration('varro')
      .get<boolean>('server.autoUpdate', true);
    const versionLines = [
      `OpenCode CLI: ${this.openCodeCliVersion ?? 'unknown'}`,
      `OpenCode Server: ${this.openCodeServerVersion ?? 'unknown'}`,
    ];
    if (
      this.openCodeCliVersion &&
      compareVersions(this.openCodeCliVersion, maximumTestedOpenCodeVersion) < 0
    ) {
      versionLines.push(
        '',
        `New CLI version: OpenCode ${maximumTestedOpenCodeVersion} is not installed yet.`,
        `Auto-updates are ${autoUpdatesEnabled ? 'on' : 'off'}.`
      );
    }
    if (
      this.openCodeCliVersion &&
      this.openCodeServerVersion &&
      compareVersions(this.openCodeServerVersion, this.openCodeCliVersion) < 0
    ) {
      versionLines.push(
        '',
        `CLI updated to OpenCode ${this.openCodeCliVersion}; server ${this.openCodeServerVersion} is stale.`
      );
    }
    if (versionLines.length > 2) versionLines.push('');
    versionLines.push(`Varro extension: ${this.extensionVersion}`);
    if (
      (this.openCodeCliVersion &&
        differsByMajorOrMinor(this.openCodeCliVersion, maximumTestedOpenCodeVersion)) ||
      (this.openCodeServerVersion &&
        differsByMajorOrMinor(this.openCodeServerVersion, maximumTestedOpenCodeVersion))
    ) {
      versionLines.push(`Verified w/ OpenCode ${maximumTestedOpenCodeVersion}`);
    }

    const openCodeStatusBarItem = this.serverEventBridge.getOpenCodeStatusBarItem();
    openCodeStatusBarItem.text = `$(robot) OpenCode ${displayedVersion}${updateMarker}`;
    openCodeStatusBarItem.tooltip = versionLines.join('\n');
    openCodeStatusBarItem.show();
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
    const hasQueuedMessages = (this.queuedMessages.list()?.length ?? 0) > 0;
    const shouldRun =
      (this.sessionState.busy.size > 0 || hasQueuedMessages) &&
      this.serverEventBridge.getStatus().state === 'running';
    const intervalMs = hasQueuedMessages
      ? SidebarProvider.QUEUE_RECONCILE_INTERVAL_MS
      : SidebarProvider.SESSION_RECONCILE_INTERVAL_MS;
    if (
      shouldRun &&
      (!this.sessionReconcileTimer || this.sessionReconcileIntervalMs !== intervalMs)
    ) {
      if (this.sessionReconcileTimer) clearInterval(this.sessionReconcileTimer);
      this.sessionReconcileTimer = setInterval(() => void this.runSessionReconcile(), intervalMs);
      this.sessionReconcileIntervalMs = intervalMs;
    } else if (!shouldRun && this.sessionReconcileTimer) {
      clearInterval(this.sessionReconcileTimer);
      this.sessionReconcileTimer = null;
      this.sessionReconcileIntervalMs = 0;
    }
  }

  private runSessionReconcile(): Promise<void> {
    if (this.disposing) return this.sessionReconcileInFlight ?? Promise.resolve();
    if (this.sessionReconcileInFlight) {
      this.sessionReconcileRerunRequested = true;
      return this.sessionReconcileInFlight;
    }
    const reconciliation = this.runSessionReconcileLoop();
    this.sessionReconcileInFlight = reconciliation;
    return reconciliation;
  }

  private async runSessionReconcileLoop() {
    try {
      do {
        this.sessionReconcileRerunRequested = false;
        await this.runSessionReconcilePass();
      } while (this.sessionReconcileRerunRequested && !this.disposing);
    } finally {
      this.sessionReconcileInFlight = null;
    }
  }

  private async runSessionReconcilePass() {
    if (this.disposing) return;
    const queuedSessionIDs = new Set(
      (this.queuedMessages.list() ?? []).map((message) => message.sessionId)
    );
    const trackedSessionIDs = new Set([...this.sessionState.busy, ...queuedSessionIDs]);
    if (trackedSessionIDs.size === 0) return;
    const observedBusyRevisions = new Map(
      [...this.sessionState.busy].map((sessionID) => [
        sessionID,
        this.sessionState.busyEvidenceRevisionFor(sessionID),
      ])
    );
    const directoriesBySessionID = new Map(
      [...trackedSessionIDs].map((sessionID) => [
        sessionID,
        this.sessionState.directoryFor(sessionID),
      ])
    );
    const directories = [...new Set(directoriesBySessionID.values())];
    const results = await Promise.allSettled(
      directories.map((directory) =>
        this.server.request('GET', '/session/status', undefined, { directory })
      )
    );
    if (this.disposing) return;
    const successfulDirectories = new Set<string | undefined>();
    const serverStatuses: Record<string, unknown> = {};
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result?.status !== 'fulfilled') continue;
      successfulDirectories.add(directories[index]);
      if (result.value && typeof result.value === 'object') {
        Object.assign(serverStatuses, result.value);
      }
    }
    if (successfulDirectories.size === 0) return;
    // The state manager checks deferred prompt failures before its revision guard.
    // Preserve failed-root busy state until that directory has an authoritative result.
    for (const sessionID of observedBusyRevisions.keys()) {
      if (!successfulDirectories.has(directoriesBySessionID.get(sessionID))) {
        serverStatuses[sessionID] = { type: 'busy' };
      }
    }
    for (const sessionID of this.sessionState.busy) {
      const observedRevision = observedBusyRevisions.get(sessionID);
      if (
        observedRevision === undefined ||
        this.sessionState.busyEvidenceRevisionFor(sessionID) !== observedRevision
      ) {
        serverStatuses[sessionID] = { type: 'busy' };
      }
    }
    for (const sessionID of queuedSessionIDs) {
      if (!successfulDirectories.has(directoriesBySessionID.get(sessionID))) continue;
      const statusType = asRecord(serverStatuses[sessionID])?.type;
      this.postQueuedSessionStatusFor(
        sessionID,
        statusType === 'busy' || statusType === 'retry' ? 'busy' : 'idle'
      );
    }
    const stale = this.sessionState.reconcileStaleBusySessions(
      serverStatuses,
      SidebarProvider.SESSION_RECONCILE_GRACE_MS,
      Date.now(),
      observedBusyRevisions
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

  private getStatusBarState(): StatusBarState {
    if (this.isAnyChatVisible()) {
      this.hiddenStatusBarState = null;
      return { visible: false, action: 'focus' };
    }

    const current = this.getCurrentStatusBarState();
    if (current.visible && !this.hiddenStatusBarState) this.hiddenStatusBarState = current;
    return this.hiddenStatusBarState ?? current;
  }

  private getCurrentStatusBarState(): StatusBarState {
    const idleState = {
      visible: false as const,
      action: 'focus' as const,
    };
    const pendingRequests = [...this.sessionState.pendingForUser.values()].filter(
      (request) =>
        !this.isSessionAttentionVisible(request.sessionID) &&
        !this.sessionTrash.isHidden(request.sessionID) &&
        !this.hiddenSessions.isHidden(request.sessionID) &&
        this.sessionState.isSessionVisibleInWorkspace(
          request.sessionID,
          this.contextProvider.context.workspacePath,
          this.contextProvider.context.workspaceDirectory,
          Boolean(
            this.contextProvider.context.workspaceDirectory &&
            this.contextProvider.getOpenWorkspaceRoot(
              this.contextProvider.context.workspaceDirectory
            )
          )
        )
    );
    if (pendingRequests.length > 0) {
      return {
        visible: true,
        action: 'attention',
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

    const actionableSessions = new Map<string, 'Error' | 'Plan ready'>();
    for (const sessionID of this.sessionState.failed) actionableSessions.set(sessionID, 'Error');
    for (const sessionID of this.sessionState.completed) {
      if (this.sessionState.isPlanSession(sessionID) && !actionableSessions.has(sessionID)) {
        actionableSessions.set(sessionID, 'Plan ready');
      }
    }
    const localAlerts = [...actionableSessions].filter(
      ([sessionID]) =>
        !this.isSessionAttentionVisible(sessionID) &&
        !this.sessionTrash.isHidden(sessionID) &&
        !this.hiddenSessions.isHidden(sessionID) &&
        this.sessionState.isSessionVisibleInWorkspace(
          sessionID,
          this.contextProvider.context.workspacePath,
          this.contextProvider.context.workspaceDirectory,
          Boolean(
            this.contextProvider.context.workspaceDirectory &&
            this.contextProvider.getOpenWorkspaceRoot(
              this.contextProvider.context.workspaceDirectory
            )
          )
        )
    );
    if (localAlerts.length > 0) {
      return {
        visible: true,
        action: 'attention',
        text: `$(bell-dot) Varro: ${localAlerts.length} ${localAlerts.length === 1 ? 'needs' : 'need'} attention`,
        backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
        tooltip: [
          'Varro needs your attention.',
          ...localAlerts.slice(0, 3).map(([sessionID, kind]) => {
            const title = this.sessionState.titleFor(sessionID) || sessionID;
            return `${title}: ${kind}`;
          }),
          ...(localAlerts.length > 3 ? [`+${localAlerts.length - 3} more`] : []),
          '',
          'Click to open chat.',
        ].join('\n'),
      };
    }

    const sidebarEndpoint = [...this.endpoints].find((endpoint) => endpoint.surface === 'sidebar');
    const siblingAlerts = sidebarEndpoint ? this.siblingWorkspaceAlertsFor(sidebarEndpoint) : [];
    const siblingAlertCount = siblingAlerts.reduce((count, alert) => count + alert.count, 0);
    if (siblingAlertCount > 0) {
      return {
        visible: true,
        action: 'sibling',
        text: `$(bell-dot) Varro: ${siblingAlertCount} workspace ${siblingAlertCount === 1 ? 'event' : 'events'}`,
        backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
        tooltip: [
          'Varro needs your attention in another workspace.',
          ...siblingAlerts.slice(0, 3).map((alert) => `${alert.name}: ${alert.count}`),
          ...(siblingAlerts.length > 3 ? [`+${siblingAlerts.length - 3} more workspaces`] : []),
          '',
          'Click to open the first workspace session list.',
        ].join('\n'),
      };
    }

    return idleState;
  }
}

function projectWorkspaceCatalogEvent(event: ServerEvent): ServerEvent {
  if ((event.type === 'session.created' || event.type === 'session.updated') && event.properties) {
    const info = asRecord(event.properties.info);
    if (!info) return event;
    return {
      ...event,
      properties: {
        ...event.properties,
        info: projectWorkspaceCatalogSessionInfo(info),
      },
    } as ServerEvent;
  }
  if (event.type === 'session.status') {
    const status = event.properties?.status;
    if (!status) return event;
    return {
      ...event,
      properties: {
        ...event.properties,
        status:
          status.type === 'retry'
            ? {
                type: 'retry',
                attempt: status.attempt,
                next: status.next,
                message: 'Session is retrying',
              }
            : { type: status.type },
      },
    } as ServerEvent;
  }
  return event;
}

function projectWorkspaceCatalogSessionInfo(info: Record<string, unknown>) {
  const {
    permission: _permission,
    revert: _revert,
    metadata: _metadata,
    path: _path,
    ...catalogInfo
  } = info;
  const summary = asRecord(catalogInfo.summary);
  if (summary) {
    const { diffs: _diffs, ...summaryWithoutDiffs } = summary;
    catalogInfo.summary = summaryWithoutDiffs;
  }
  return catalogInfo;
}
