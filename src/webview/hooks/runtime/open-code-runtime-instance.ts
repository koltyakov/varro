import { createSignal, onCleanup, onMount } from 'solid-js';
import type {
  AutoApproveJudgeReference,
  ExtensionMessage,
  PermissionMode,
  WebviewThemeKind,
} from '../../../shared/protocol';
import { isPlaceholderSessionTitle } from '../../../shared/session-title';
import { onMessage, postMessage } from '../../lib/bridge';
import { client } from '../../lib/client';
import type { QueuedMessage } from '../../lib/app-state-types';
import { appStore } from '../../lib/stores/app-store';
import { composerStore } from '../../lib/stores/composer-store';
import { permissionsStore } from '../../lib/stores/permissions-store';
import { ralphStore } from '../../lib/stores/ralph-store';
import { routingStore } from '../../lib/stores/routing-store';
import { sessionStore } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import { normalizePermissionEvent } from '../../lib/session-event-reducer';
import { resetToolCallExpansionState } from '../../lib/tool-call-expansion-state';
import { applyWebviewTheme } from '../../lib/theme';
import type { Message, Part, Permission, Session, SessionStatus } from '../../types';
import {
  getSessionTreeIds,
  getSessionTreeRootId,
  isSessionAwaitingInput,
  isSessionTreeStatusWorking,
} from '../../lib/state';
import {
  getSessionHistoryCursor,
  MESSAGE_HISTORY_WINDOW,
  mergeOlderHistory,
  mergeWindowedHistory,
  setSessionHistoryCursor,
} from '../../lib/message-window';
import { startNewChatDraft } from '../../lib/new-chat-draft';
import {
  createConnectionBootstrapOperations,
  ensureConnectionInitializedWithDependencies,
} from '../connection-bootstrap';
import { createStateBoundDataLoaderOperations } from '../data-loaders';
import {
  createMountBridgeOperations,
  postFocusStateWithDependencies,
  registerFocusStateTracking,
} from '../mount-bridge';
import { getSessionPermissionRulesForMode } from '../permission-rules';
import {
  deriveSelectedAgentFromMessages,
  deriveSelectedModelFromMessages,
  getActiveProviderSelection as getActiveProviderSelectionForState,
  getBuildAgentName,
  getDefaultPrimaryAgentName,
  getUsageLimitNoticeContext as getUsageLimitNoticeContextForState,
} from '../routing-state';
import { SessionActionOperations } from '../session/session-actions';
import { SessionApprovalOperations } from '../session/session-approvals';
import { SessionControlOperations } from '../session/session-controls';
import {
  createSessionMessageSyncCoordinator,
  registerLoadingStatusPollEffect,
  registerEventStreamRecoveryEffect,
  registerProviderLimitRefreshEffect,
  registerVisibleRunningSessionSyncEffect,
} from '../session/session-effects';
import {
  forceReconcileIdleSessionWithDependencies,
  reconcileStuckSessionsWithDependencies,
  registerStuckSessionWatchdogEffect,
  selectUnsettledLatestAssistant,
} from '../session/session-watchdog';
import { SessionEventHandlerOperations } from '../session/session-event-handlers';
import {
  getDeletedSessionTreeIds,
  getNextSessionIdAfterDeletion,
  SessionLifecycleOperations,
} from '../session/session-lifecycle';
import { SessionManagementOperations } from '../session/session-management';
import { SessionMcpOperations } from '../session/session-mcp';
import {
  ensureSessionPermissionWithDependencies,
  SessionSendOperations,
} from '../session/session-send';
import { SessionStatusOperations } from '../session/session-status';
import { resolveMessagesSelectedModel, SessionSyncOperations } from '../session/session-sync';
import { createTodoSyncOperations, resetTodoSync } from '../todo-sync';

export interface OpenCodeRuntime {
  useOpenCode(): { client: typeof client };
  recheckSessionStatus(sessionId: string): Promise<void>;
  refreshRoutingState(): Promise<void>;
  continueInterruptedSession(sessionId: string): Promise<void>;
  applySessionMcps(names: string[], sessionId?: string | null): Promise<void>;
  selectSession(id: string, options?: { markSeen?: boolean }): Promise<void>;
  loadFullSessionHistory(sessionId: string): Promise<void>;
  createSession(title?: string, initialPermissionMode?: PermissionMode): Promise<string | null>;
  forkSession(id: string, messageID?: string): Promise<string | null>;
  deleteSession(id: string): Promise<void>;
  deleteSessionImmediately(id: string): Promise<void>;
  restoreSession(rootID: string): Promise<void>;
  deleteSessionPermanently(rootID: string): Promise<void>;
  emptyRecycleBin(): Promise<void>;
  sendMessage(
    text: string,
    options?: {
      noReply?: boolean;
      delivery?: 'steer' | 'queue';
      queuedAttachments?: {
        droppedFiles?: QueuedMessage['droppedFiles'];
        clipboardImages?: QueuedMessage['clipboardImages'];
        terminalSelection?: QueuedMessage['terminalSelection'];
      };
      preserveComposer?: boolean;
    }
  ): Promise<boolean>;
  retryMessage(messageId: string, sessionId?: string | null): Promise<void>;
  editMessage(
    messageId: string,
    text: string,
    options?: { allowEmptyText?: boolean }
  ): Promise<boolean>;
  implementPlan(prompt: string, sessionId?: string | null): Promise<void>;
  openPlan(markdown: string, sessionId?: string | null): Promise<void>;
  abortSession(): Promise<void>;
  undoSession(): Promise<void>;
  redoSession(): Promise<void>;
  initSession(): Promise<void>;
  runSlashCommandByName(name: string, args: string): Promise<unknown>;
  reviewSession(): Promise<void>;
  compactSession(): Promise<void>;
  respondPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ): Promise<void>;
  respondQuestion(requestID: string, answers: Array<Array<string>>): Promise<void>;
  updatePermissionModeForSession(mode: PermissionMode, sessionId?: string | null): Promise<void>;
  rejectQuestion(requestID: string): Promise<void>;
}

function logError(context: string, err: unknown) {
  postMessage({
    type: 'log',
    payload: {
      msg: context,
      error: err instanceof Error ? err.message : String(err),
      level: 'warn',
    },
  });
}

function isCurrentGeneration(current: number, expected: number) {
  return current === expected;
}

const POLLED_STATUS_SNAPSHOT_FRESHNESS_MS = 100;

type SessionEntry = { info: Message; parts: Part[] };
export type SessionStatusSnapshot = {
  statuses: Record<string, SessionStatus>;
  startedAt: number;
};

export function createSessionStatusSnapshotCoordinator(
  loadSessionStatuses: () => Promise<Record<string, SessionStatus>>,
  freshnessMs = POLLED_STATUS_SNAPSHOT_FRESHNESS_MS
) {
  let generation = 0;
  let inFlight: Promise<SessionStatusSnapshot> | null = null;
  let latest: { snapshot: SessionStatusSnapshot; completedAt: number } | null = null;

  const load = (): Promise<SessionStatusSnapshot> => {
    if (inFlight) return inFlight;
    if (latest && Date.now() - latest.completedAt < freshnessMs) {
      return Promise.resolve(latest.snapshot);
    }

    const requestGeneration = generation;
    const request = Promise.resolve().then(async () => {
      const startedAt = Date.now();
      const statuses = await loadSessionStatuses();
      return { statuses, startedAt };
    });
    const tracked: Promise<SessionStatusSnapshot> = request.then(
      (snapshot) => {
        if (requestGeneration === generation) {
          latest = { snapshot, completedAt: Date.now() };
        }
        if (inFlight === tracked) inFlight = null;
        return snapshot;
      },
      (err: unknown) => {
        if (inFlight === tracked) inFlight = null;
        throw err;
      }
    );
    inFlight = tracked;
    return tracked;
  };

  const clear = () => {
    generation += 1;
    inFlight = null;
    latest = null;
  };

  return { load, clear };
}

export function createPerSessionMessageSyncGenerations() {
  type SyncAttempt = { sessionId: string; token: number; applied: boolean };

  let nextToken = 0;
  const currentTokenBySession = new Map<string, number>();
  const attemptsByToken = new Map<number, SyncAttempt>();

  const isCurrent = (token: number) => {
    const attempt = attemptsByToken.get(token);
    if (!attempt) return false;
    const current = currentTokenBySession.get(attempt.sessionId) === token;
    attempt.applied = current;
    return current;
  };

  const run = (
    sessionId: string,
    operation: (token: number) => Promise<void>
  ): Promise<boolean> => {
    const token = ++nextToken;
    const attempt: SyncAttempt = { sessionId, token, applied: false };
    attemptsByToken.set(token, attempt);
    currentTokenBySession.set(sessionId, token);
    return Promise.resolve()
      .then(() => operation(token))
      .then(() => attempt.applied)
      .finally(() => {
        attemptsByToken.delete(token);
      });
  };

  const invalidate = (sessionId: string) => {
    currentTokenBySession.set(sessionId, ++nextToken);
  };

  const clear = () => {
    currentTokenBySession.clear();
    attemptsByToken.clear();
  };

  return { isCurrent, run, invalidate, clear };
}

function isNotFoundError(err: unknown) {
  return err instanceof Error && /^404\b/.test(err.message);
}

async function fetchSessionMessages(sessionId: string): Promise<SessionEntry[]> {
  const incoming = await client.session.messages(sessionId, { limit: MESSAGE_HISTORY_WINDOW });
  const current = appStore.state.messages.filter((entry) => entry.info.sessionID === sessionId);
  if (current.length === 0) {
    setSessionHistoryCursor(sessionId, incoming.nextCursor);
  }
  return mergeWindowedHistory(current, incoming);
}

async function loadSessionWithMessages(sessionId: string): Promise<{
  session: Session;
  messages: SessionEntry[];
}> {
  const session = await client.session.get(sessionId);
  try {
    return { session, messages: await fetchSessionMessages(sessionId) };
  } catch (err) {
    if (isNotFoundError(err)) return { session, messages: [] };
    throw err;
  }
}

async function loadSessionMessagesAllowingEmpty(sessionId: string): Promise<SessionEntry[]> {
  try {
    return await fetchSessionMessages(sessionId);
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

function applyTheme(nextTheme: WebviewThemeKind) {
  applyWebviewTheme(nextTheme);
}

function getUsageLimitNoticeContext(
  sessionID: string,
  messages: Array<{ info: Message; parts: Part[] }> = appStore.state.messages
) {
  return getUsageLimitNoticeContextForState({
    sessionId: sessionID,
    messages,
    selectedModelForSession: routingStore.getSelectedModelForSession(sessionID),
    providers: appStore.state.providers,
    providerDefaults: appStore.state.providerDefaults,
    fallbackSelectedModel: appStore.state.selectedModel,
  });
}

function settleLatestAssistantMessage(sessionId: string) {
  const info = selectUnsettledLatestAssistant(appStore.state.messages, sessionId);
  if (!info) return;
  sessionStore.upsertMessageInfo({ ...info, time: { ...info.time, completed: Date.now() } });
  sessionStore.finishMessageStreaming(info.id);
}

function getDefaultPrimaryAgentNameFromState() {
  return getDefaultPrimaryAgentName(appStore.state.agents);
}

function getBuildAgentNameFromState() {
  return getBuildAgentName(appStore.state.agents);
}

function postFocusState() {
  postFocusStateWithDependencies({
    sendMessage: postMessage,
    isVisible: () => document.visibilityState === 'visible',
    hasFocus: () => document.hasFocus(),
  });
}

function getActiveProviderSelection() {
  return getActiveProviderSelectionForState({
    activeSessionId: appStore.state.activeSessionId,
    selectedModel: appStore.state.selectedModel,
    providers: appStore.state.providers,
    providerDefaults: appStore.state.providerDefaults,
    getActiveRalphModel: (sessionId) => {
      const managerSessionId = ralphStore.isRalphSession(sessionId)
        ? sessionId
        : ralphStore.findManagerSessionIdForChild(sessionId);
      const model = managerSessionId ? ralphStore.getRun(managerSessionId)?.config.model : null;
      if (!model?.providerID) return null;
      return { providerID: model.providerID, modelID: model.modelID };
    },
  });
}

function resolvePermissionJudgeModel(sessionId: string) {
  return routingStore.resolveSelectedModel(
    routingStore.getSelectedModelForSession(sessionId) || appStore.state.selectedModel,
    appStore.state.providers,
    appStore.state.providerDefaults
  );
}

async function deleteSessionImmediately(id: string) {
  await client.varro.session.deleteImmediately(id);
}

export function createOpenCodeRuntime(): OpenCodeRuntime {
  let initialized = false;
  let initializing = false;
  let eventHandlerCleanups: Array<() => void> = [];
  let currentWorkspacePath: string | null = null;
  let connectionGeneration = 0;
  let sessionSelectionGeneration = 0;
  let approvedPermissionReferences: AutoApproveJudgeReference[] = [];
  let permissionSyncGeneration = 0;
  let latestPermissionSyncGeneration = 0;
  let permissionSnapshotGeneration = 0;
  const fullHistoryLoads = new Map<string, Promise<void>>();
  const pendingAbortRetryAttempts = new Map<string, number | null>();
  const statusSnapshotStartedAt = new WeakMap<Record<string, SessionStatus>, number>();
  const statusSnapshots = createSessionStatusSnapshotCoordinator(() => client.session.status());
  const messageSyncGenerations = createPerSessionMessageSyncGenerations();
  const sessionMessageSyncCoordinator = createSessionMessageSyncCoordinator((sessionId) =>
    runSessionMessageSync(sessionId)
  );
  const [documentVisible, setDocumentVisible] = createSignal(
    document.visibilityState === 'visible'
  );

  const todoSyncOperations = createTodoSyncOperations({
    loadSessionTodos: (sessionId) => client.session.todos(sessionId),
  });

  const { syncTodosForSession, syncTodosFromMessages, handoffTodosToMessages } = todoSyncOperations;

  const sessionStatusOperations = new SessionStatusOperations({
    pendingAbortRetryAttempts,
    deriveUsageLimitNoticeContext: getUsageLimitNoticeContext,
    refreshProviderLimit: (providerID, modelID) => refreshProviderLimit(providerID, modelID),
    isDocumentVisible: () => documentVisible(),
    shouldResyncSessionAfterIdle: (sessionId) => appStore.state.activeSessionId === sessionId,
    syncSession: (sessionId) => syncSession(sessionId),
    syncSessionMessages: (sessionId) => syncSessionMessages(sessionId),
    syncBusySessionMessages: (sessionId) => syncPolledSessionMessages(sessionId),
    loadSessionStatuses: loadSessionStatusesFromSnapshot,
    loadSessionStatusSnapshot: statusSnapshots.load,
    isActiveSession: (sessionId) => appStore.state.activeSessionId === sessionId,
    getMessages: () => appStore.state.messages,
    logError,
  });

  const {
    setSessionStatusEntry,
    clearPendingAbort,
    clearPendingAbortTree,
    markPendingAbortTree,
    updateUsageLimitState,
    recheckSessionStatus: recheckSessionStatusWithState,
  } = sessionStatusOperations;

  const sessionLifecycleOperations = new SessionLifecycleOperations({
    getCurrentWorkspacePath: () => currentWorkspacePath,
    clearPendingAbort,
    clearPendingAbortTree,
    resetTodoSync,
    resetToolCallExpansionState,
  });

  const { applySessions, clearDeletedSessionState, hideDeletedSessionTree, upsertSession } =
    sessionLifecycleOperations;
  const sessionTitleFallbackAttempts = new Map<string, number>();
  const sessionTitleFallbacks = new Map<string, Promise<void>>();

  function repairSessionTitle(sessionId: string): Promise<void> {
    const inFlight = sessionTitleFallbacks.get(sessionId);
    if (inFlight) return inFlight;
    const existing = appStore.state.sessions.find((session) => session.id === sessionId);
    if (existing && !isPlaceholderSessionTitle(existing.title)) return Promise.resolve();
    const attempts = sessionTitleFallbackAttempts.get(sessionId) ?? 0;
    if (attempts >= 2) return Promise.resolve();
    sessionTitleFallbackAttempts.set(sessionId, attempts + 1);

    const fallback = (async () => {
      const renamed = await client.varro.session.renameIfUntitled(sessionId);
      if (!renamed) return;
      const current = appStore.state.sessions.find((session) => session.id === sessionId);
      if (current) {
        upsertSession({ ...current, title: renamed.title });
        return;
      }
      await syncSession(sessionId);
    })().finally(() => {
      sessionTitleFallbacks.delete(sessionId);
    });
    sessionTitleFallbacks.set(sessionId, fallback);
    return fallback;
  }

  function ensureSessionEventHandlersRegistered() {
    if (eventHandlerCleanups.length > 0) return;

    const sessionEventHandlerOperations = new SessionEventHandlerOperations({
      todoSyncOperations,
      sessionLifecycleOperations,
      sessionStatusOperations,
      sessionSyncOperations: {
        syncSession: sessionSyncOperations.syncSession,
        syncSessionMessages,
      },
      repairSessionTitle,
      sessionApprovalOperations: {
        respondPermission: sessionApprovalOperations.respondPermission,
        judgePermission: (permission) => {
          const snapshotGeneration = permissionSnapshotGeneration;
          return judgeAndRespondPermission(
            permission,
            () => snapshotGeneration === permissionSnapshotGeneration
          );
        },
      },
      syncPendingPermissions,
      reconcileServerState,
      abortRemoteSession: (sessionId: string) => client.session.abort(sessionId),
      logError,
    });

    eventHandlerCleanups = sessionEventHandlerOperations.registerSessionEventHandlers();
  }

  function useOpenCode() {
    onMount(() => {
      applyTheme(uiStore.theme());

      const mountBridgeOperations = createMountBridgeOperations({
        ensureConnectionInitialized,
        getCurrentWorkspacePath: () => currentWorkspacePath,
        setCurrentWorkspacePath: (path) => {
          currentWorkspacePath = path;
        },
        reloadSessionsForWorkspaceChange: () => {
          void loadSessions();
        },
        isInitialized: () => initialized,
        createSession: () => {
          startNewChatDraft();
        },
        abortSession: () => {
          void abortSession();
        },
        refreshMcps: () => {
          void loadMcps();
        },
        refreshProviders: () => {
          void Promise.all([loadProviders(), loadCompatibilityState()]);
        },
        applyTheme,
      });

      ensureSessionEventHandlersRegistered();

      const disposeBridge = onMessage((msg: ExtensionMessage) => {
        mountBridgeOperations.handleExtensionMessage(msg);
      });

      postMessage({ type: 'ready' });

      postFocusState();

      const disposeFocusTracking = registerFocusStateTracking({
        setDocumentVisible,
        postFocusState,
        isLoading: uiStore.isLoading,
        getActiveSessionId: () => appStore.state.activeSessionId,
        recheckSessionStatus: (sessionId) => {
          void recheckSessionStatus(sessionId);
        },
        refreshProviders: () => {
          void Promise.all([loadProviders(), loadCompatibilityState()]);
        },
      });

      onCleanup(() => {
        disposeBridge();
        disposeFocusTracking();
        for (const cleanup of eventHandlerCleanups) cleanup();
        eventHandlerCleanups = [];
        initialized = false;
        initializing = false;
        currentWorkspacePath = null;
        connectionGeneration = 0;
        sessionSelectionGeneration = 0;
        permissionSyncGeneration = 0;
        latestPermissionSyncGeneration = 0;
        permissionSnapshotGeneration = 0;
        pendingAbortRetryAttempts.clear();
        statusSnapshots.clear();
        messageSyncGenerations.clear();
        setDocumentVisible(document.visibilityState === 'visible');
      });
    });

    registerLoadingStatusPollEffect({
      isLoading: uiStore.isLoading,
      getActiveSessionId: () => appStore.state.activeSessionId,
      isDocumentVisible: documentVisible,
      getEventStreamState: () =>
        appStore.state.serverStatus.state === 'running'
          ? appStore.state.serverStatus.eventStream
          : undefined,
      recheckSessionStatus,
      logError,
    });

    registerEventStreamRecoveryEffect({
      getEventStreamState: () =>
        appStore.state.serverStatus.state === 'running'
          ? appStore.state.serverStatus.eventStream
          : undefined,
      isLoading: uiStore.isLoading,
      getActiveSessionId: () => appStore.state.activeSessionId,
      recheckSessionStatus,
      logError,
    });

    registerProviderLimitRefreshEffect({
      getServerState: () => appStore.state.serverStatus.state,
      areProvidersLoaded: () => appStore.state.providersLoaded,
      isDocumentVisible: documentVisible,
      isActiveSessionWorking: () => {
        const activeSessionId = appStore.state.activeSessionId;
        return activeSessionId ? isSessionTreeStatusWorking(activeSessionId) : false;
      },
      getActiveProviderSelection,
      getProviderLimit: routingStore.getProviderLimit,
      loadProviderLimit: (providerID, modelID) => client.config.providerLimit(providerID, modelID),
      setProviderLimit: routingStore.setProviderLimit,
      getPollIntervalMs: () => uiStore.providerLimitPollIntervalSeconds() * 1000,
      logError,
    });

    registerVisibleRunningSessionSyncEffect({
      getServerState: () => appStore.state.serverStatus.state,
      isDocumentVisible: documentVisible,
      getEventStreamState: () =>
        appStore.state.serverStatus.state === 'running'
          ? appStore.state.serverStatus.eventStream
          : undefined,
      getActiveSessionId: () => appStore.state.activeSessionId,
      getSessionStatuses: () => appStore.state.sessionStatus,
      loadSessions,
      hydrateSessionStatuses: hydratePolledSessionStatuses,
      loadQuestions,
      loadPendingPermissions: syncPendingPermissions,
      syncSessionMessages: syncPolledSessionMessages,
      logError,
    });

    registerStuckSessionWatchdogEffect({
      getServerState: () => appStore.state.serverStatus.state,
      isDocumentVisible: documentVisible,
      hasBusySession: () =>
        uiStore.isLoading() ||
        Object.values(appStore.state.sessionStatus).some(
          (status) => status?.type === 'busy' || status?.type === 'retry'
        ),
      runReconcile: () => reconcileStuckSessions(),
    });

    return { client };
  }

  const stuckSessionTimers = new Map<string, number>();

  async function forceReconcileIdleSession(sessionId: string) {
    await forceReconcileIdleSessionWithDependencies(
      {
        setSessionStatusEntry,
        clearPendingAbort,
        updateUsageLimitState,
        syncSessionMessages,
        settleLatestAssistantMessage,
        isActiveSession: (id) => appStore.state.activeSessionId === id,
        isTreeWorking: isSessionTreeStatusWorking,
        stopLoading: uiStore.stopLoading,
        logError,
      },
      sessionId
    );
  }

  async function reconcileStuckSessions() {
    await reconcileStuckSessionsWithDependencies(
      {
        loadSessionStatuses: loadSessionStatusesFromSnapshot,
        getLocalSessionStatuses: () => appStore.state.sessionStatus,
        getActiveSessionId: () => appStore.state.activeSessionId,
        isLoading: uiStore.isLoading,
        isAwaitingInput: isSessionAwaitingInput,
        hasPendingAbort: (sessionId) => pendingAbortRetryAttempts.has(sessionId),
        forceReconcileIdleSession,
        logError,
        getMessages: () => appStore.state.messages,
        getStreamingText: () => ({
          partId: appStore.state.streamingPartId,
          text: appStore.state.streamingText,
        }),
      },
      stuckSessionTimers
    );
  }

  async function loadSessionStatusesFromSnapshot(): Promise<Record<string, SessionStatus>> {
    const snapshot = await statusSnapshots.load();
    statusSnapshotStartedAt.set(snapshot.statuses, snapshot.startedAt);
    return snapshot.statuses;
  }

  async function hydratePolledSessionStatuses(): Promise<void> {
    try {
      const snapshot = await statusSnapshots.load();
      sessionStore.setSessionStatuses(snapshot.statuses, {
        snapshotStartedAt: snapshot.startedAt,
      });
      for (const session of appStore.state.sessions) {
        updateUsageLimitState(session.id, snapshot.statuses[session.id], []);
      }
    } catch (err) {
      logError('session.status', err);
    }
  }

  function recheckSessionStatus(sessionId: string): Promise<void> {
    return recheckSessionStatusWithState(sessionId);
  }

  async function syncPendingPermissions() {
    const syncGeneration = ++permissionSyncGeneration;
    const reconciliation = permissionsStore.beginPermissionReconciliation();
    try {
      const pendingPermissions = await client.permission.list();
      if (syncGeneration < latestPermissionSyncGeneration) return;
      latestPermissionSyncGeneration = syncGeneration;
      const snapshotGeneration = ++permissionSnapshotGeneration;
      const isCurrent = () => snapshotGeneration === permissionSnapshotGeneration;
      const visiblePermissions: Permission[] = [];

      for (const item of pendingPermissions) {
        if (!isCurrent()) return;
        const permission = normalizePermissionEvent(item);
        if (!permission) continue;
        const mode = permissionsStore.getPermissionModeForSession(permission.sessionID);
        if (mode === 'full') {
          await sessionApprovalOperations
            .respondPermission(permission.sessionID, permission.id, 'always', { rethrow: true })
            .catch(() => {
              if (
                isCurrent() &&
                permissionsStore.getPermissionModeForSession(permission.sessionID) !== 'full'
              ) {
                permissionsStore.addPermission(permission);
              }
            });
          continue;
        }
        if (mode === 'auto') {
          await judgeAndRespondPermission(permission, isCurrent);
          continue;
        }
        visiblePermissions.push(permission);
      }

      if (isCurrent()) {
        permissionsStore.reconcilePermissions(visiblePermissions, reconciliation);
      }
    } finally {
      permissionsStore.finishPermissionReconciliation(reconciliation);
    }
  }

  async function judgeAndRespondPermission(permission: Permission, isCurrent = () => true) {
    try {
      const model = resolvePermissionJudgeModel(permission.sessionID);
      const response = await client.varro.judgePermission({
        permission,
        approvedReferences: approvedPermissionReferences,
        ...(model ? { model } : {}),
      });
      if (
        !isCurrent() ||
        permissionsStore.getPermissionModeForSession(permission.sessionID) !== 'auto'
      ) {
        return;
      }
      if (response.decision === 'allow') {
        await sessionApprovalOperations.respondPermission(
          permission.sessionID,
          permission.id,
          'once',
          {
            rethrow: true,
          }
        );
        return;
      }
    } catch (err) {
      logError('autoApproveJudge', err);
    }
    if (
      isCurrent() &&
      permissionsStore.getPermissionModeForSession(permission.sessionID) === 'auto'
    ) {
      permissionsStore.addPermission(permission);
    }
  }

  function initConnection() {
    return connectionBootstrapOperations.initConnection();
  }

  const dataLoaders = createStateBoundDataLoaderOperations({
    applySessions,
    updateUsageLimitState,
    logError,
  });

  const {
    loadMcps,
    loadQuestions,
    loadAgents,
    loadCommands,
    loadProviders,
    loadCompatibilityState,
    refreshProviderLimit,
    loadSessions,
    loadRecycleBin,
    hydrateSessionStatuses,
  } = dataLoaders;

  async function refreshRoutingState() {
    await dataLoaders.refreshRoutingState();
  }

  async function reconcileServerState() {
    const activeSessionId = appStore.state.activeSessionId;
    const results = await Promise.allSettled([
      loadSessions(),
      loadRecycleBin(),
      hydrateSessionStatuses(),
      loadQuestions(),
      syncPendingPermissions(),
      loadMcps(),
      loadCommands(),
      refreshRoutingState(),
      loadCompatibilityState(),
      ...(activeSessionId ? [syncSession(activeSessionId)] : []),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') logError('reconcileServerState', result.reason);
    }
  }

  const sessionMcpOperations = new SessionMcpOperations({
    getSelectedMcpsForSession: routingStore.getSelectedMcpsForSession,
    getRequiredMcpSessionIds: (targetSessionId) => [
      targetSessionId,
      ...Object.entries(appStore.state.sessionStatus)
        .filter(([, status]) => status?.type === 'busy' || status?.type === 'retry')
        .map(([sessionId]) => sessionId),
    ],
    getMcpStatus: () => appStore.state.mcpStatus,
    loadMcps,
    getAvailableMcpNames: routingStore.getAvailableMcpNames,
    connectMcp: (name) => client.mcp.connect(name),
    authenticateMcp: (name) => client.mcp.authenticate(name),
    disconnectMcp: (name) => client.mcp.disconnect(name),
    logError,
    setSelectedMcpsForSession: routingStore.setSelectedMcpsForSession,
  });

  const { syncSessionMcps } = sessionMcpOperations;

  async function applySessionMcps(names: string[], sessionId = appStore.state.activeSessionId) {
    await sessionMcpOperations.applySessionMcps(names, sessionId);
  }

  const connectionBootstrapOperations = createConnectionBootstrapOperations({
    health: client.health,
    loadInitialData: async () => {
      await Promise.all([
        loadSessions(),
        loadAgents(),
        loadCommands(),
        loadProviders(),
        loadCompatibilityState(),
        loadMcps(),
        loadQuestions(),
        loadRecycleBin(),
      ]);
    },
    hydrateSessionStatuses,
    getActiveSessionId: () => appStore.state.activeSessionId,
    getPersistedActiveSessionId: sessionStore.getPersistedActiveSessionId,
    getPersistedLastOpenedView: sessionStore.getPersistedLastOpenedView,
    getSessionCount: () => appStore.state.sessions.length,
    getOnlyPrimarySessionId: () => {
      const primarySessions = appStore.state.sessions.filter((session) => !session.parentID);
      return primarySessions.length === 1 ? primarySessions[0]?.id || null : null;
    },
    hasSession: (sessionId) => appStore.state.sessions.some((session) => session.id === sessionId),
    selectSession: (sessionId) => sessionSyncOperations.selectSession(sessionId),
    setShowSessionPicker: uiStore.setShowSessionPicker,
    setInitialized: (value) => {
      initialized = value;
    },
    setError: uiStore.setError,
    nextConnectionGeneration: () => ++connectionGeneration,
    isCurrentConnectionGeneration: (generation) =>
      isCurrentGeneration(generation, connectionGeneration),
    consumeInterruptedSessionIds: appStore.consumeInterruptedSessionIds,
    getSessionStatus: (sessionId) => appStore.state.sessionStatus[sessionId],
    hasPendingQuestion: (sessionId) =>
      appStore.state.questions.some((item) => item.sessionID === sessionId),
    hasPendingPermission: (sessionId) =>
      appStore.state.permissions.some((item) => item.sessionID === sessionId),
    loadSessionMessages: loadSessionMessagesAllowingEmpty,
    logError,
    syncSessionMcps,
    resolveModel: (id) =>
      routingStore.resolveSelectedModel(
        routingStore.getSelectedModelForSession(id),
        appStore.state.providers,
        appStore.state.providerDefaults
      ),
    resolveAgent: (id) =>
      routingStore.getSelectedAgentForSession(id) || getDefaultPrimaryAgentNameFromState(),
    sendAsync: (id, body) => client.session.sendAsync(id, body),
    syncSession,
    recheckSessionStatus,
  });

  async function continueInterruptedSession(sessionId: string) {
    await connectionBootstrapOperations.continueInterruptedSession(sessionId);
  }

  const sessionSendOperations = new SessionSendOperations({
    createSession: (initialPermissionMode) => createSession(undefined, initialPermissionMode),
    ensureSessionPermission: (sessionId) =>
      ensureSessionPermissionWithDependencies(
        {
          getSession: (id) => appStore.state.sessions.find((session) => session.id === id),
          buildPermissionRules: (mode) => getSessionPermissionRulesForMode(mode, 'update'),
          getPermissionMode: permissionsStore.getPermissionModeForSession,
          updateSessionPermission: (id, input) => client.session.update(id, input),
          upsertSession,
          setError: uiStore.setError,
        },
        sessionId
      ),
    clearPendingAbort,
    resetTodoSync,
    syncSessionMcps,
    sendAsync: async (sessionId, body) => {
      const response = await client.session.sendAsync(sessionId, body);
      void repairSessionTitle(sessionId).catch((err) => logError('repairSessionTitle', err));
      return response;
    },
    syncSession,
    syncSessionMessages,
    recheckSessionStatus,
    setSessionStatusEntry,
    continueInterruptedSession,
    logError,
  });

  function ensureConnectionInitialized() {
    ensureConnectionInitializedWithDependencies({
      isInitialized: () => initialized,
      isInitializing: () => initializing,
      initConnection,
      setInitializing: (value) => {
        initializing = value;
      },
    });
  }

  const sessionSyncOperations = new SessionSyncOperations(
    {
      getActiveSessionId: () => appStore.state.activeSessionId,
      setActiveSessionId: sessionStore.setActiveSessionId,
      clearPendingAbort,
      persistActiveSessionId: sessionStore.persistActiveSessionId,
      markSessionSeen: sessionStore.markSessionSeen,
      clearDraftCurrentDocumentState: composerStore.clearDraftCurrentDocumentState,
      resetToolCallExpansionState,
      resolvePersistedAgent: (sessionId) => ({
        persistedAgent: routingStore.getSelectedAgentForSession(sessionId),
        fallbackAgent:
          routingStore.getPersistedSelectedAgent() || getDefaultPrimaryAgentNameFromState(),
      }),
      applySelectedAgent: (agent, sessionId) =>
        routingStore.setSelectedAgent(agent, { sessionId, persistGlobal: false }),
      resolvePersistedModel: (sessionId) =>
        routingStore.resolveSelectedModel(
          routingStore.getSelectedModelForSession(sessionId),
          appStore.state.providers,
          appStore.state.providerDefaults
        ),
      resolveFallbackModel: () =>
        routingStore.resolveSelectedModel(
          routingStore.getPersistedSelectedModel(),
          appStore.state.providers,
          appStore.state.providerDefaults
        ),
      applySelectedModel: (model, sessionId) =>
        routingStore.setSelectedModel(model, { sessionId, persistGlobal: false }),
      getConnectedMcpNames: routingStore.getConnectedMcpNames,
      hasSelectedMcps: (sessionId) => routingStore.getSelectedMcpsForSession(sessionId) !== null,
      setSelectedMcpsForSession: routingStore.setSelectedMcpsForSession,
      syncSessionMcps,
      resetTodoSync,
      clearMessages: sessionStore.clearMessages,
      loadSession: loadSessionWithMessages,
      isCurrentSelectionGeneration: (generation) =>
        isCurrentGeneration(generation, sessionSelectionGeneration),
      upsertSession,
      setMessagesIncremental: sessionStore.setMessagesIncremental,
      syncFailedSessionsFromMessages: sessionStore.syncFailedSessionsFromMessages,
      requestMessageListScrollToBottom: uiStore.requestMessageListScrollToBottom,
      deriveSelectedAgentFromMessages,
      deriveSelectedModelFromMessages: (messages) =>
        resolveMessagesSelectedModel(
          messages,
          appStore.state.providers,
          appStore.state.providerDefaults,
          deriveSelectedModelFromMessages
        ),
      syncTodosForSession,
      loadQuestions: async () => {
        await loadQuestions().catch((err) => logError('loadQuestions', err));
      },
      loadSessionStatuses: loadSessionStatusesFromSnapshot,
      mergeSessionStatuses: (statuses, options) =>
        sessionStore.setSessionStatuses(statuses, {
          snapshotStartedAt: statusSnapshotStartedAt.get(statuses) ?? options?.snapshotStartedAt,
        }),
      updateUsageLimitState,
      setSessionStatusEntry,
      startLoading: uiStore.startLoading,
      stopLoading: uiStore.stopLoading,
      setError: uiStore.setError,
      getSessionStatus: (id) => appStore.state.sessionStatus[id],
      loadingStartedAt: uiStore.loadingStartedAt,
      loadSessionMessages: loadSessionMessagesAllowingEmpty,
      handoffTodosToMessages,
      loadSessionMetadata: (id) => client.session.get(id),
    },
    {
      nextSelection: () => ++sessionSelectionGeneration,
      isCurrentSync: messageSyncGenerations.isCurrent,
    }
  );

  const sessionControlOperations = new SessionControlOperations({
    getActiveSessionId: () => appStore.state.activeSessionId,
    sendMessage,
    getSessionTreeRootId: sessionStore.getSessionTreeRootId,
    getSessionTreeIds: sessionStore.getSessionTreeIds,
    getSelectedAgentForSession: routingStore.getSelectedAgentForSession,
    skipPlanSession: sessionStore.skipPlanSession,
    getSessionStatus: (sessionId) => appStore.state.sessionStatus[sessionId],
    getSessionUsageLimit: (sessionId) => appStore.state.sessionUsageLimits[sessionId],
    markPendingAbortTree,
    setSessionStatusEntry,
    stopLoading: uiStore.stopLoading,
    abortRemoteSession: (sessionId) => client.session.abort(sessionId),
    clearPendingAbortTree,
    setSessionUsageLimit: sessionStore.setSessionUsageLimit,
    logError,
    getMessages: () => appStore.state.messages,
    startLoading: uiStore.startLoading,
    invalidateMessageSync: () => {
      const sessionId = appStore.state.activeSessionId;
      if (sessionId) messageSyncGenerations.invalidate(sessionId);
    },
    pruneMessagesFrom: sessionStore.pruneMessagesFrom,
    revertSession: (sessionId, messageId) => client.session.revert(sessionId, messageId),
    syncSession,
    syncSessionMessages,
    setError: uiStore.setError,
    isSessionWorking: (sessionId) => isSessionTreeStatusWorking(sessionId),
    sendEditedMessage: (text) => sendMessage(text),
    unrevertSession: (sessionId) => client.session.unrevert(sessionId),
    upsertSession,
    clearPendingAbort,
    resolveSelectedModel: () =>
      routingStore.resolveSelectedModel(
        appStore.state.selectedModel,
        appStore.state.providers,
        appStore.state.providerDefaults
      ),
    setSessionCompacting: sessionStore.setSessionCompacting,
    compactRemoteSession: (sessionId, input) => client.session.compact(sessionId, input),
    getSession: (sessionId) => appStore.state.sessions.find((session) => session.id === sessionId),
  });

  const sessionActionOperations = new SessionActionOperations({
    getActiveSessionId: () => appStore.state.activeSessionId,
    getBuildAgent: getBuildAgentNameFromState,
    setError: uiStore.setError,
    clearSkippedPlanSession: sessionStore.clearSkippedPlanSession,
    applySelectedAgent: (agent, sessionId) =>
      routingStore.setSelectedAgent(agent, { sessionId, persistGlobal: false }),
    sendMessage,
    openPlan: (content) => client.varro.openPlan(content),
    createSession: () =>
      createSession(undefined, permissionsStore.getPermissionModeForSession(null)),
    getMessageCount: () => appStore.state.messages.length,
    hasCommand: routingStore.hasCommand,
    startLoading: uiStore.startLoading,
    runSessionCommand: (sessionId, input) => client.session.command(sessionId, input),
    shouldApplyToActiveSession: (sessionId) => appStore.state.activeSessionId === sessionId,
    upsertMessageInfo: sessionStore.upsertMessageInfo,
    upsertPart: sessionStore.upsertPart,
    syncTodosFromMessages,
    requestMessageListScrollToBottom: uiStore.requestMessageListScrollToBottom,
    syncSession,
    recheckSessionStatus,
    stopLoading: uiStore.stopLoading,
  });

  const sessionApprovalOperations = new SessionApprovalOperations({
    respondRemotePermission: (sessionId, permissionId, response) =>
      client.session.respondPermission(sessionId, permissionId, response),
    removePermission: permissionsStore.removePermission,
    setError: uiStore.setError,
    replyQuestion: (requestId, answers) => client.question.reply(requestId, answers),
    removeQuestion: permissionsStore.removeQuestion,
    rejectRemoteQuestion: (requestId) => client.question.reject(requestId),
    getPermissionModeForSession: permissionsStore.getPermissionModeForSession,
    getDraftPermissionMode: permissionsStore.draftPermissionMode,
    setPermissionModeForSession: permissionsStore.setPermissionModeForSession,
    setDraftPermissionMode: permissionsStore.setDraftPermissionMode,
    saveProjectPermissionMode: permissionsStore.saveProjectPermissionMode,
    updateSessionPermission: (sessionId, input) => client.session.update(sessionId, input),
    upsertSession,
    getPermissionsForSession: (sessionId) => {
      const rootId = getSessionTreeRootId(sessionId) || sessionId;
      const sessionIds = new Set(getSessionTreeIds(rootId));
      return appStore.state.permissions.filter((permission) =>
        permissionsStore
          .getPermissionGroupMembers(permission)
          .some((member) => sessionIds.has(member.sessionID))
      );
    },
    syncPendingPermissions,
  });

  const sessionManagementOperations = new SessionManagementOperations({
    getActiveSessionId: () => appStore.state.activeSessionId,
    createRemoteSession: (body) => client.session.create(body),
    forkRemoteSession: (sessionId, messageID) => client.session.fork(sessionId, messageID),
    getPermissionModeForSession: permissionsStore.getPermissionModeForSession,
    buildCreatePermission: (mode) => getSessionPermissionRulesForMode(mode, 'create'),
    upsertSession,
    resetToolCallExpansionState,
    setActiveSessionId: sessionStore.setActiveSessionId,
    clearDraftCurrentDocumentState: composerStore.clearDraftCurrentDocumentState,
    adoptDraftCurrentDocumentState: composerStore.adoptDraftCurrentDocumentState,
    setSessionStatusEntry,
    setSessionUsageLimit: sessionStore.setSessionUsageLimit,
    persistActiveSessionId: sessionStore.persistActiveSessionId,
    markSessionSeen: sessionStore.markSessionSeen,
    getDefaultSelectedModel: () => appStore.state.selectedModel,
    setSelectedModel: routingStore.setSelectedModel,
    resolveDefaultAgent: () =>
      getBuildAgentNameFromState() ||
      routingStore.getPersistedSelectedAgent() ||
      getDefaultPrimaryAgentNameFromState(),
    setSelectedAgent: routingStore.setSelectedAgent,
    getConnectedMcpNames: routingStore.getConnectedMcpNames,
    setSelectedMcpsForSession: routingStore.setSelectedMcpsForSession,
    setPermissionModeForSession: permissionsStore.setPermissionModeForSession,
    resetDraftPermissionMode: permissionsStore.resetDraftPermissionMode,
    resetTodoSync,
    clearMessages: sessionStore.clearMessages,
    stopLoading: uiStore.stopLoading,
    setError: uiStore.setError,
    getSessions: () => appStore.state.sessions,
    getDeletedSessionTreeIds,
    getNextSessionIdAfterDeletion,
    deleteRemoteSession: (sessionId) => client.session.delete(sessionId),
    hideDeletedSessionTree,
    loadRecycleBin,
    selectSession,
    logError,
    restoreRecycleBinEntry: (rootID) => client.varro.recycleBin.restore(rootID),
    loadSessions,
    hydrateSessionStatuses,
    getRecycleBinEntries: () => appStore.state.recycleBinEntries,
    deleteRecycleBinEntry: (rootID) => client.varro.recycleBin.delete(rootID),
    clearDeletedSessionState,
    emptyRecycleBin: () => client.varro.recycleBin.empty(),
  });

  async function selectSession(id: string, options?: { markSeen?: boolean }) {
    await sessionSyncOperations.selectSession(id, options);
    if (appStore.state.activeSessionId === id) {
      sessionStore.persistLastOpenedView({ type: 'session', sessionId: id });
    }
  }

  function runSessionMessageSync(sessionId: string): Promise<boolean> {
    return messageSyncGenerations.run(sessionId, (token) =>
      sessionSyncOperations.syncSessionMessages(sessionId, token)
    );
  }

  function syncSessionMessages(sessionId: string): Promise<void> {
    return sessionMessageSyncCoordinator.sync(sessionId);
  }

  function syncPolledSessionMessages(sessionId: string): Promise<void> {
    return sessionMessageSyncCoordinator.syncIfStale(sessionId);
  }

  async function syncSession(sessionId: string) {
    await sessionSyncOperations.syncSession(sessionId);
  }

  async function createSession(
    title?: string,
    initialPermissionMode = permissionsStore.getPermissionModeForSession(null)
  ): Promise<string | null> {
    const sessionId = await sessionManagementOperations.createSession(title, initialPermissionMode);
    if (sessionId) sessionStore.persistLastOpenedView({ type: 'session', sessionId });
    return sessionId;
  }

  async function loadFullSessionHistory(sessionId: string) {
    const existing = fullHistoryLoads.get(sessionId);
    if (existing) return existing;

    const load = (async () => {
      try {
        let cursor = getSessionHistoryCursor(sessionId);
        while (cursor && appStore.state.activeSessionId === sessionId) {
          const page = await client.session.messages(sessionId, {
            limit: MESSAGE_HISTORY_WINDOW,
            before: cursor,
          });
          if (appStore.state.activeSessionId !== sessionId) return;
          const current = appStore.state.messages.filter(
            (entry) => entry.info.sessionID === sessionId
          );
          sessionStore.setMessagesIncremental(mergeOlderHistory(current, page));
          cursor = page.nextCursor;
          setSessionHistoryCursor(sessionId, cursor);
        }
      } catch (err) {
        logError('loadFullSessionHistory', err);
      }
    })().finally(() => {
      fullHistoryLoads.delete(sessionId);
    });
    fullHistoryLoads.set(sessionId, load);
    return load;
  }

  async function forkSession(id: string, messageID?: string): Promise<string | null> {
    const sessionId = await sessionManagementOperations.forkSession(id, messageID);
    if (sessionId) sessionStore.persistLastOpenedView({ type: 'session', sessionId });
    return sessionId;
  }

  async function deleteSession(id: string) {
    await sessionManagementOperations.deleteSession(id);
  }

  async function restoreSession(rootID: string) {
    await sessionManagementOperations.restoreSession(rootID);
  }

  async function deleteSessionPermanently(rootID: string) {
    await sessionManagementOperations.deleteSessionPermanently(rootID);
  }

  async function emptyRecycleBin() {
    await sessionManagementOperations.emptyRecycleBin();
  }

  async function sendMessage(
    text: string,
    options?: {
      noReply?: boolean;
      delivery?: 'steer' | 'queue';
      queuedAttachments?: {
        droppedFiles?: QueuedMessage['droppedFiles'];
        clipboardImages?: QueuedMessage['clipboardImages'];
        terminalSelection?: QueuedMessage['terminalSelection'];
      };
      preserveComposer?: boolean;
    }
  ): Promise<boolean> {
    return await sessionSendOperations.sendMessage(text, options);
  }

  async function retryMessage(messageId: string, sessionId = appStore.state.activeSessionId) {
    await sessionSendOperations.retryMessage(messageId, sessionId);
  }

  async function editMessage(
    messageId: string,
    text: string,
    options?: { allowEmptyText?: boolean }
  ) {
    return await sessionControlOperations.editMessage(messageId, text, options);
  }

  async function implementPlan(prompt: string, sessionId = appStore.state.activeSessionId) {
    await sessionActionOperations.implementPlan(prompt, sessionId);
  }

  async function openPlan(markdown: string, sessionId = appStore.state.activeSessionId) {
    await sessionActionOperations.openPlan(markdown, sessionId);
  }

  async function abortSession() {
    await sessionControlOperations.abortSession();
  }

  async function undoSession() {
    await sessionControlOperations.undoSession();
  }

  async function redoSession() {
    await sessionControlOperations.redoSession();
  }

  async function initSession() {
    await sessionActionOperations.initSession();
  }

  async function runSlashCommandByName(name: string, args: string) {
    return sessionActionOperations.runSlashCommandByName(name, args);
  }

  async function reviewSession() {
    await sessionControlOperations.reviewSession();
  }

  async function compactSession() {
    await sessionControlOperations.compactSession();
  }

  async function respondPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ) {
    const permission = appStore.state.permissions.find((item) => item.id === permissionId);
    await sessionApprovalOperations.respondPermission(sessionId, permissionId, response, {
      ...options,
      ...(response === 'reject' && permission
        ? { groupMembers: permissionsStore.getPermissionGroupMembers(permission) }
        : {}),
    });
    if (permission && response !== 'reject' && !options?.rethrow) {
      recordApprovedPermissionReference(permission, response);
    }
  }

  function recordApprovedPermissionReference(
    permission: Permission,
    response: AutoApproveJudgeReference['response']
  ) {
    approvedPermissionReferences = [
      ...approvedPermissionReferences,
      {
        type: permission.type,
        title: permission.title,
        response,
        ...(permission.pattern !== undefined ? { pattern: permission.pattern } : {}),
        ...(permission.metadata ? { metadata: permission.metadata } : {}),
      },
    ].slice(-20);
  }

  async function respondQuestion(requestID: string, answers: Array<Array<string>>) {
    await sessionApprovalOperations.respondQuestion(requestID, answers);
  }

  async function updatePermissionModeForSession(
    mode: PermissionMode,
    sessionId = appStore.state.activeSessionId
  ) {
    await sessionApprovalOperations.updatePermissionModeForSession(
      mode,
      getSessionPermissionRulesForMode(mode, 'update'),
      sessionId
    );
  }

  async function rejectQuestion(requestID: string) {
    await sessionApprovalOperations.rejectQuestion(requestID);
  }

  return {
    useOpenCode,
    recheckSessionStatus,
    refreshRoutingState,
    continueInterruptedSession,
    applySessionMcps,
    selectSession,
    loadFullSessionHistory,
    createSession,
    forkSession,
    deleteSession,
    deleteSessionImmediately,
    restoreSession,
    deleteSessionPermanently,
    emptyRecycleBin,
    sendMessage,
    retryMessage,
    editMessage,
    implementPlan,
    openPlan,
    abortSession,
    undoSession,
    redoSession,
    initSession,
    runSlashCommandByName,
    reviewSession,
    compactSession,
    respondPermission,
    respondQuestion,
    updatePermissionModeForSession,
    rejectQuestion,
  };
}
