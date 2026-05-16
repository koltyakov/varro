import { createSignal, onCleanup, onMount } from 'solid-js';
import type { ExtensionMessage, WebviewThemeKind } from '../../../shared/protocol';
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
import type { Message, Part, Session } from '../../types';
import { getSessionTreeIds, getSessionTreeRootId } from '../../lib/state';
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
  registerLoadingStatusPollEffect,
  registerProviderLimitRefreshEffect,
  registerVisibleRunningSessionSyncEffect,
} from '../session/session-effects';
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
  createSession(title?: string, initialPermissionMode?: 'default' | 'full'): Promise<string | null>;
  deleteSession(id: string): Promise<void>;
  deleteSessionImmediately(id: string): Promise<void>;
  restoreSession(rootID: string): Promise<void>;
  deleteSessionPermanently(rootID: string): Promise<void>;
  emptyRecycleBin(): Promise<void>;
  sendMessage(
    text: string,
    options?: {
      noReply?: boolean;
      queuedAttachments?: {
        droppedFiles?: QueuedMessage['droppedFiles'];
        clipboardImages?: QueuedMessage['clipboardImages'];
        terminalSelection?: QueuedMessage['terminalSelection'];
      };
      preserveComposer?: boolean;
    }
  ): Promise<void>;
  retryMessage(messageId: string, sessionId?: string | null): Promise<void>;
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
  updatePermissionModeForSession(
    mode: 'default' | 'full',
    sessionId?: string | null
  ): Promise<void>;
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

type SessionEntry = { info: Message; parts: Part[] };

function isNotFoundError(err: unknown) {
  return err instanceof Error && /^404\b/.test(err.message);
}

async function loadSessionWithMessages(sessionId: string): Promise<{
  session: Session;
  messages: SessionEntry[];
}> {
  const session = await client.session.get(sessionId);
  try {
    return { session, messages: await client.session.messages(sessionId) };
  } catch (err) {
    if (isNotFoundError(err)) return { session, messages: [] };
    throw err;
  }
}

async function loadSessionMessagesAllowingEmpty(sessionId: string): Promise<SessionEntry[]> {
  try {
    return await client.session.messages(sessionId);
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

export function createOpenCodeRuntime(): OpenCodeRuntime {
  let initialized = false;
  let initializing = false;
  let eventHandlerCleanups: Array<() => void> = [];
  let currentWorkspacePath: string | null = null;
  let connectionGeneration = 0;
  let sessionSelectionGeneration = 0;
  let sessionSyncGeneration = 0;
  const pendingAbortRetryAttempts = new Map<string, number | null>();
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
    loadSessionStatuses: () => client.session.status(),
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

  function getDefaultPrimaryAgentNameFromState() {
    return getDefaultPrimaryAgentName(appStore.state.agents);
  }

  function getBuildAgentNameFromState() {
    return getBuildAgentName(appStore.state.agents);
  }

  function ensureSessionEventHandlersRegistered() {
    if (eventHandlerCleanups.length > 0) return;

    const sessionEventHandlerOperations = new SessionEventHandlerOperations({
      todoSyncOperations,
      sessionLifecycleOperations,
      sessionStatusOperations,
      sessionSyncOperations,
      sessionApprovalOperations,
      syncPendingPermissions,
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
          void createSession();
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

      const postFocusState = () =>
        postFocusStateWithDependencies({
          sendMessage: postMessage,
          isVisible: () => document.visibilityState === 'visible',
          hasFocus: () => document.hasFocus(),
        });

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
        sessionSyncGeneration = 0;
        pendingAbortRetryAttempts.clear();
        setDocumentVisible(document.visibilityState === 'visible');
      });
    });

    registerLoadingStatusPollEffect({
      isLoading: uiStore.isLoading,
      getActiveSessionId: () => appStore.state.activeSessionId,
      isDocumentVisible: documentVisible,
      recheckSessionStatus: (sessionId) => {
        void recheckSessionStatus(sessionId);
      },
    });

    registerProviderLimitRefreshEffect({
      getServerState: () => appStore.state.serverStatus.state,
      areProvidersLoaded: () => appStore.state.providersLoaded,
      isDocumentVisible: documentVisible,
      isActiveSessionWorking: () => {
        const activeSessionId = appStore.state.activeSessionId;
        if (!activeSessionId) return false;
        const rootId = getSessionTreeRootId(activeSessionId) || activeSessionId;
        return getSessionTreeIds(rootId).some((sessionId) => {
          const status = appStore.state.sessionStatus[sessionId];
          return status?.type === 'busy' || status?.type === 'retry';
        });
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
      getActiveSessionId: () => appStore.state.activeSessionId,
      getSessionStatuses: () => appStore.state.sessionStatus,
      loadSessions,
      hydrateSessionStatuses,
      loadQuestions,
      loadPendingPermissions: syncPendingPermissions,
      syncSessionMessages,
      logError,
    });

    return { client };
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

  async function recheckSessionStatus(sessionId: string) {
    await recheckSessionStatusWithState(sessionId);
  }

  async function syncPendingPermissions() {
    const pendingPermissions = await client.permission.list();
    for (const item of pendingPermissions) {
      const permission = normalizePermissionEvent(item);
      if (!permission) continue;
      if (permissionsStore.getPermissionModeForSession(permission.sessionID) === 'full') {
        await sessionApprovalOperations
          .respondPermission(permission.sessionID, permission.id, 'always', { rethrow: true })
          .catch(() => {
            permissionsStore.addPermission(permission);
          });
        continue;
      }
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

  const sessionMcpOperations = new SessionMcpOperations({
    getSelectedMcpsForSession: routingStore.getSelectedMcpsForSession,
    getMcpStatus: () => appStore.state.mcpStatus,
    loadMcps,
    getAvailableMcpNames: routingStore.getAvailableMcpNames,
    connectMcp: (name) => client.mcp.connect(name),
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
    sendAsync: (sessionId, body) => client.session.sendAsync(sessionId, body),
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
      loadSessionStatuses: async () => client.session.status(),
      mergeSessionStatuses: (statuses, options) =>
        sessionStore.setSessionStatuses(statuses, options),
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
      nextSync: () => ++sessionSyncGeneration,
      isCurrentSync: (generation) => isCurrentGeneration(generation, sessionSyncGeneration),
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
    revertSession: (sessionId, messageId) => client.session.revert(sessionId, messageId),
    syncSession,
    syncSessionMessages,
    setError: uiStore.setError,
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
    getPermissionsForSession: (sessionId) =>
      appStore.state.permissions.filter((permission) => permission.sessionID === sessionId),
    syncPendingPermissions,
  });

  const sessionManagementOperations = new SessionManagementOperations({
    getActiveSessionId: () => appStore.state.activeSessionId,
    createRemoteSession: (body) => client.session.create(body),
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

  async function syncSessionMessages(sessionId: string) {
    await sessionSyncOperations.syncSessionMessages(sessionId);
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

  async function deleteSession(id: string) {
    await sessionManagementOperations.deleteSession(id);
  }

  async function deleteSessionImmediately(id: string) {
    await client.varro.session.deleteImmediately(id);
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
      queuedAttachments?: {
        droppedFiles?: QueuedMessage['droppedFiles'];
        clipboardImages?: QueuedMessage['clipboardImages'];
        terminalSelection?: QueuedMessage['terminalSelection'];
      };
      preserveComposer?: boolean;
    }
  ) {
    await sessionSendOperations.sendMessage(text, options);
  }

  async function retryMessage(messageId: string, sessionId = appStore.state.activeSessionId) {
    await sessionSendOperations.retryMessage(messageId, sessionId);
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
    await sessionApprovalOperations.respondPermission(sessionId, permissionId, response, options);
  }

  async function respondQuestion(requestID: string, answers: Array<Array<string>>) {
    await sessionApprovalOperations.respondQuestion(requestID, answers);
  }

  async function updatePermissionModeForSession(
    mode: 'default' | 'full',
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
    createSession,
    deleteSession,
    deleteSessionImmediately,
    restoreSession,
    deleteSessionPermanently,
    emptyRecycleBin,
    sendMessage,
    retryMessage,
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
