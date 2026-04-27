import { createSignal, onCleanup, onMount } from 'solid-js';
import type { ExtensionMessage, WebviewThemeKind } from '../../shared/protocol';
import { onMessage, postMessage } from '../lib/bridge';
import { client } from '../lib/client';
import { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';
import { applyWebviewTheme } from '../lib/theme';
import {
  clearDraftCurrentDocumentState,
  clearMessages,
  clearSkippedPlanSession,
  consumeInterruptedSessionIds,
  draftPermissionMode,
  getAvailableMcpNames,
  getPersistedActiveSessionId,
  getPersistedSelectedAgent,
  getPersistedSelectedModel,
  getPermissionModeForSession,
  getProviderLimit,
  getSelectedAgentForSession,
  getSelectedMcpsForSession,
  getSelectedModelForSession,
  markSessionSeen,
  persistActiveSessionId,
  requestMessageListScrollToBottom,
  resetDraftPermissionMode,
  resolveSelectedModel,
  saveProjectPermissionMode,
  setCommands,
  setDraftPermissionMode,
  setError,
  setMcpStatus,
  setPermissionModeForSession,
  setProviderLimit,
  setRecycleBinEntries,
  setSelectedAgent,
  setSelectedMcpsForSession,
  setSelectedModel,
  setSessionCompacting,
  setSessionUsageLimit,
  setState,
  startLoading,
  state,
  stopLoading,
  syncFailedSessionsFromMessages,
  theme,
  isLoading,
  adoptDraftCurrentDocumentState,
  upsertMessageInfo,
  upsertPart,
  removePermission,
  setQuestions,
  removeQuestion,
  skipPlanSession,
  getSessionTreeIds,
  setMessagesIncremental,
} from '../lib/state';
import type { Message, Part, SessionStatus } from '../types';
import {
  createConnectionBootstrapOperations,
  ensureConnectionInitializedWithDependencies,
} from './connection-bootstrap';
import { createDataLoaderOperations } from './data-loaders';
import {
  createMountBridgeOperations,
  postFocusStateWithDependencies,
  registerFocusStateTracking,
} from './mount-bridge';
import { getSessionPermissionRulesForMode } from './permission-rules';
import {
  deriveSelectedAgentFromMessages,
  deriveSelectedModelFromMessages,
  getActiveProviderSelection as getActiveProviderSelectionForState,
  getBuildAgentName,
  getDefaultPrimaryAgentName,
  getUsageLimitNoticeContext as getUsageLimitNoticeContextForState,
} from './routing-state';
import { createSessionActionOperations } from './session-actions';
import { createSessionApprovalOperations } from './session-approvals';
import { createSessionControlOperations } from './session-controls';
import {
  registerLoadingStatusPollEffect,
  registerProviderLimitRefreshEffect,
} from './session-effects';
import { createSessionEventHandlerOperations } from './session-event-handlers';
import {
  createSessionLifecycleOperations,
  getDeletedSessionTreeIds,
  getNextSessionIdAfterDeletion,
} from './session-lifecycle';
import { createSessionManagementOperations } from './session-management';
import { createSessionMcpOperations } from './session-mcp';
import { createSessionSendOperations } from './session-send';
import { createSessionStatusOperations } from './session-status';
import { createSessionSyncOperations, resolveMessagesSelectedModel } from './session-sync';
import { createTodoSyncOperations, extractTodos } from './todo-sync';

export interface OpenCodeRuntime {
  useOpenCode(): { client: typeof client };
  recheckSessionStatus(sessionId: string): Promise<void>;
  refreshRoutingState(): Promise<void>;
  applySessionMcps(names: string[], sessionId?: string | null): Promise<void>;
  selectSession(id: string, options?: { markSeen?: boolean }): Promise<void>;
  createSession(title?: string, initialPermissionMode?: 'default' | 'full'): Promise<string | null>;
  deleteSession(id: string): Promise<void>;
  restoreSession(rootID: string): Promise<void>;
  deleteSessionPermanently(rootID: string): Promise<void>;
  emptyRecycleBin(): Promise<void>;
  sendMessage(text: string, options?: { noReply?: boolean }): Promise<void>;
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

export function createOpenCodeRuntime(): OpenCodeRuntime {
  let initialized = false;
  let initializing = false;
  let eventHandlerCleanups: Array<() => void> = [];
  let currentWorkspacePath: string | null = null;
  let todoStateAuthority: 'messages' | 'event' = 'messages';
  let connectionGeneration = 0;
  let sessionSelectionGeneration = 0;
  let sessionSyncGeneration = 0;
  const pendingAbortRetryAttempts = new Map<string, number | null>();
  const [documentVisible, setDocumentVisible] = createSignal(
    document.visibilityState === 'visible'
  );

  function resetTodoSync() {
    todoStateAuthority = 'messages';
  }

  const todoSyncOperations = createTodoSyncOperations({
    getAuthority: () => todoStateAuthority,
    setAuthority: (authority) => {
      todoStateAuthority = authority;
    },
  });

  const { syncTodosFromMessages, handoffTodosToMessages } = todoSyncOperations;

  const sessionStatusOperations = createSessionStatusOperations({
    pendingAbortRetryAttempts,
    deriveUsageLimitNoticeContext: getUsageLimitNoticeContext,
    refreshProviderLimit: (providerID, modelID) => refreshProviderLimit(providerID, modelID),
    isDocumentVisible: () => documentVisible(),
    shouldResyncSessionAfterIdle: (sessionId) => state.activeSessionId === sessionId,
    syncSessionMessages: (sessionId) => syncSessionMessages(sessionId),
    loadSessionStatuses: () => client.session.status(),
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

  const sessionLifecycleOperations = createSessionLifecycleOperations({
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
    messages: Array<{ info: Message; parts: Part[] }> = state.messages
  ) {
    return getUsageLimitNoticeContextForState({
      sessionId: sessionID,
      messages,
      selectedModelForSession: getSelectedModelForSession(sessionID),
      providers: state.providers,
      providerDefaults: state.providerDefaults,
      fallbackSelectedModel: state.selectedModel,
    });
  }

  function getDefaultPrimaryAgentNameFromState() {
    return getDefaultPrimaryAgentName(state.agents);
  }

  function getBuildAgentNameFromState() {
    return getBuildAgentName(state.agents);
  }

  function ensureSessionEventHandlersRegistered() {
    if (eventHandlerCleanups.length > 0) return;

    const sessionEventHandlerOperations = createSessionEventHandlerOperations({
      setTodoStateAuthority: (value) => {
        todoStateAuthority = value;
      },
      todoSyncOperations,
      sessionLifecycleOperations,
      sessionStatusOperations,
      sessionSyncOperations,
      sessionApprovalOperations,
      extractTodos,
    });

    eventHandlerCleanups = sessionEventHandlerOperations.registerSessionEventHandlers();
  }

  function useOpenCode() {
    onMount(() => {
      applyTheme(theme());

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
        isLoading,
        getActiveSessionId: () => state.activeSessionId,
        recheckSessionStatus: (sessionId) => {
          void recheckSessionStatus(sessionId);
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
        todoStateAuthority = 'messages';
        connectionGeneration = 0;
        sessionSelectionGeneration = 0;
        sessionSyncGeneration = 0;
        pendingAbortRetryAttempts.clear();
        setDocumentVisible(document.visibilityState === 'visible');
      });
    });

    registerLoadingStatusPollEffect({
      isLoading,
      getActiveSessionId: () => state.activeSessionId,
      isDocumentVisible: documentVisible,
      recheckSessionStatus: (sessionId) => {
        void recheckSessionStatus(sessionId);
      },
    });

    registerProviderLimitRefreshEffect({
      getServerState: () => state.serverStatus.state,
      areProvidersLoaded: () => state.providersLoaded,
      isDocumentVisible: documentVisible,
      getActiveProviderSelection,
      getProviderLimit,
      loadProviderLimit: (providerID, modelID) => client.config.providerLimit(providerID, modelID),
      setProviderLimit,
      logError,
    });

    return { client };
  }

  function getActiveProviderSelection() {
    return getActiveProviderSelectionForState({
      selectedModel: state.selectedModel,
      providers: state.providers,
      providerDefaults: state.providerDefaults,
    });
  }

  async function recheckSessionStatus(sessionId: string) {
    await recheckSessionStatusWithState(sessionId);
  }

  function initConnection() {
    return connectionBootstrapOperations.initConnection();
  }

  const dataLoaders = createDataLoaderOperations({
    listMcpStatus: () => client.mcp.status(),
    setMcpStatus,
    getActiveSessionId: () => state.activeSessionId,
    getSelectedMcpsForSession,
    setSelectedMcpsForSession,
    listQuestions: () => client.question.list(),
    setQuestions,
    listAgents: () => client.agent.list(),
    getSelectedAgent: () => state.selectedAgent,
    getSelectedAgentForSession: (sessionId) => getSelectedAgentForSession(sessionId),
    getPersistedSelectedAgent,
    setAllAgents: (agents) => setState('allAgents', agents),
    setPrimaryAgents: (agents) => setState('agents', agents),
    setSelectedAgent,
    listCommands: () => client.command.list(),
    setCommands,
    listProviders: () => client.config.providers(),
    setProvidersLoaded: (value) => setState('providersLoaded', value),
    setProviders: (providers) => setState('providers', providers),
    setProviderDefaults: (defaults) => setState('providerDefaults', defaults),
    getSelectedModel: () => state.selectedModel,
    setSelectedModel: (model) => setSelectedModel(model),
    loadProviderLimit: (providerID, modelID) => client.config.providerLimit(providerID, modelID),
    setProviderLimit,
    listSessions: () => client.session.list(),
    applySessions,
    listRecycleBin: () => client.varro.recycleBin.list(),
    setRecycleBinEntries,
    loadSessionStatuses: () => client.session.status(),
    setSessionStatuses: (statuses) => setState('sessionStatus', statuses),
    getSessions: () => state.sessions,
    updateUsageLimitState,
    logError,
  });

  const {
    loadMcps,
    loadQuestions,
    loadAgents,
    loadCommands,
    loadProviders,
    refreshProviderLimit,
    loadSessions,
    loadRecycleBin,
    hydrateSessionStatuses,
  } = dataLoaders;

  async function refreshRoutingState() {
    await dataLoaders.refreshRoutingState();
  }

  const sessionMcpOperations = createSessionMcpOperations({
    getSelectedMcpsForSession,
    getMcpStatus: () => state.mcpStatus,
    loadMcps,
    getAvailableMcpNames,
    connectMcp: (name) => client.mcp.connect(name),
    disconnectMcp: (name) => client.mcp.disconnect(name),
    logError,
    setSelectedMcpsForSession,
  });

  const { syncSessionMcps } = sessionMcpOperations;

  async function applySessionMcps(names: string[], sessionId = state.activeSessionId) {
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
        loadMcps(),
        loadQuestions(),
        loadRecycleBin(),
      ]);
    },
    hydrateSessionStatuses,
    getActiveSessionId: () => state.activeSessionId,
    getPersistedActiveSessionId,
    hasSession: (sessionId) => state.sessions.some((session) => session.id === sessionId),
    selectSession: async (sessionId) => {
      await selectSession(sessionId);
    },
    setInitialized: (value) => {
      initialized = value;
    },
    setError,
    nextConnectionGeneration: () => ++connectionGeneration,
    isCurrentConnectionGeneration: (generation) =>
      isCurrentGeneration(generation, connectionGeneration),
    consumeInterruptedSessionIds,
    getSessionStatus: (sessionId) => state.sessionStatus[sessionId],
    hasPendingQuestion: (sessionId) => state.questions.some((item) => item.sessionID === sessionId),
    hasPendingPermission: (sessionId) =>
      state.permissions.some((item) => item.sessionID === sessionId),
    loadSessionMessages: (sessionId) => client.session.messages(sessionId),
    logError,
    syncSessionMcps,
    resolveModel: (id) =>
      resolveSelectedModel(getSelectedModelForSession(id), state.providers, state.providerDefaults),
    resolveAgent: (id) => getSelectedAgentForSession(id) || getDefaultPrimaryAgentNameFromState(),
    sendAsync: (id, body) => client.session.sendAsync(id, body),
    syncSession,
    recheckSessionStatus,
  });

  async function continueInterruptedSession(sessionId: string) {
    await connectionBootstrapOperations.continueInterruptedSession(sessionId);
  }

  const sessionSendOperations = createSessionSendOperations({
    createSession: (initialPermissionMode) => createSession(undefined, initialPermissionMode),
    clearPendingAbort,
    resetTodoSync,
    syncSessionMcps,
    sendAsync: (sessionId, body) => client.session.sendAsync(sessionId, body),
    syncSession,
    syncSessionMessages,
    recheckSessionStatus,
    continueInterruptedSession,
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

  const sessionSyncOperations = createSessionSyncOperations(
    {
      getActiveSessionId: () => state.activeSessionId,
      setActiveSessionId: (activeSessionId) => setState('activeSessionId', activeSessionId),
      persistActiveSessionId,
      markSessionSeen,
      clearDraftCurrentDocumentState,
      resetToolCallExpansionState,
      resolvePersistedAgent: (sessionId) => ({
        persistedAgent: getSelectedAgentForSession(sessionId),
        fallbackAgent: getPersistedSelectedAgent() || getDefaultPrimaryAgentNameFromState(),
      }),
      applySelectedAgent: (agent, sessionId) =>
        setSelectedAgent(agent, { sessionId, persistGlobal: false }),
      resolvePersistedModel: (sessionId) =>
        resolveSelectedModel(
          getSelectedModelForSession(sessionId),
          state.providers,
          state.providerDefaults
        ),
      resolveFallbackModel: () =>
        resolveSelectedModel(getPersistedSelectedModel(), state.providers, state.providerDefaults),
      applySelectedModel: (model, sessionId) =>
        setSelectedModel(model, { sessionId, persistGlobal: false }),
      getConnectedMcpNames: () =>
        Object.entries(state.mcpStatus)
          .filter(([, value]) => value?.status === 'connected')
          .map(([name]) => name),
      hasSelectedMcps: (sessionId) => !!getSelectedMcpsForSession(sessionId),
      setSelectedMcpsForSession,
      syncSessionMcps,
      resetTodoSync,
      clearMessages,
      loadSession: async (sessionId) => {
        const [session, messages] = await Promise.all([
          client.session.get(sessionId),
          client.session.messages(sessionId),
        ]);
        return { session, messages };
      },
      isCurrentSelectionGeneration: (generation) =>
        isCurrentGeneration(generation, sessionSelectionGeneration),
      upsertSession,
      setMessagesIncremental,
      syncFailedSessionsFromMessages,
      requestMessageListScrollToBottom,
      deriveSelectedAgentFromMessages: (messages) => deriveSelectedAgentFromMessages(messages),
      deriveSelectedModelFromMessages: (messages) =>
        resolveMessagesSelectedModel(
          messages,
          state.providers,
          state.providerDefaults,
          deriveSelectedModelFromMessages
        ),
      syncTodosFromMessages,
      loadQuestions: async () => {
        await loadQuestions().catch((err) => logError('loadQuestions', err));
      },
      loadSessionStatuses: async () =>
        client.session.status().catch((err) => {
          logError('session.status', err);
          return {} as Record<string, SessionStatus>;
        }),
      mergeSessionStatuses: (statuses) =>
        setState('sessionStatus', (current) => ({ ...current, ...statuses })),
      updateUsageLimitState,
      startLoading,
      stopLoading,
      setError,
      getSessionStatus: (id) => state.sessionStatus[id],
      loadSessionMessages: (id) => client.session.messages(id),
      handoffTodosToMessages,
      loadSessionMetadata: (id) => client.session.get(id),
    },
    {
      nextSelection: () => ++sessionSelectionGeneration,
      nextSync: () => ++sessionSyncGeneration,
      isCurrentSync: (generation) => isCurrentGeneration(generation, sessionSyncGeneration),
    }
  );

  const sessionControlOperations = createSessionControlOperations({
    getActiveSessionId: () => state.activeSessionId,
    sendMessage,
    getSessionTreeIds,
    getSelectedAgentForSession,
    skipPlanSession,
    getSessionStatus: (sessionId) => state.sessionStatus[sessionId],
    getSessionUsageLimit: (sessionId) => state.sessionUsageLimits[sessionId],
    markPendingAbortTree,
    setSessionStatusEntry,
    stopLoading,
    abortRemoteSession: (sessionId) => client.session.abort(sessionId),
    clearPendingAbortTree,
    setSessionUsageLimit,
    logError,
    getMessages: () => state.messages,
    startLoading,
    revertSession: (sessionId, messageId) => client.session.revert(sessionId, messageId),
    syncSession,
    syncSessionMessages,
    setError,
    unrevertSession: (sessionId) => client.session.unrevert(sessionId),
    upsertSession,
    clearPendingAbort,
    resolveSelectedModel: () =>
      resolveSelectedModel(state.selectedModel, state.providers, state.providerDefaults),
    setSessionCompacting,
    compactRemoteSession: (sessionId, input) => client.session.compact(sessionId, input),
    getSession: (sessionId) => state.sessions.find((session) => session.id === sessionId),
  });

  const sessionActionOperations = createSessionActionOperations({
    getActiveSessionId: () => state.activeSessionId,
    getBuildAgent: getBuildAgentNameFromState,
    setError,
    clearSkippedPlanSession,
    applySelectedAgent: (agent, sessionId) =>
      setSelectedAgent(agent, { sessionId, persistGlobal: false }),
    sendMessage,
    openPlan: (content) => client.varro.openPlan(content),
    createSession: () => createSession(undefined, getPermissionModeForSession(null)),
    getMessageCount: () => state.messages.length,
    hasCommand: (commandName) => state.commands.some((item) => item.name === commandName),
    startLoading,
    runSessionCommand: (sessionId, input) => client.session.command(sessionId, input),
    shouldApplyToActiveSession: (sessionId) => state.activeSessionId === sessionId,
    upsertMessageInfo,
    upsertPart,
    syncTodosFromMessages,
    requestMessageListScrollToBottom,
    syncSession,
    recheckSessionStatus,
    stopLoading,
  });

  const sessionApprovalOperations = createSessionApprovalOperations({
    getPermissions: () => state.permissions,
    respondRemotePermission: (sessionId, permissionId, response) =>
      client.session.respondPermission(sessionId, permissionId, response),
    removePermission,
    setError,
    replyQuestion: (requestId, answers) => client.question.reply(requestId, answers),
    removeQuestion,
    rejectRemoteQuestion: (requestId) => client.question.reject(requestId),
    getPermissionModeForSession,
    getDraftPermissionMode: draftPermissionMode,
    setPermissionModeForSession,
    setDraftPermissionMode,
    saveProjectPermissionMode,
    updateSessionPermission: (sessionId, input) => client.session.update(sessionId, input),
    upsertSession,
    getPermissionsForSession: (sessionId) =>
      state.permissions.filter((permission) => permission.sessionID === sessionId),
  });

  const sessionManagementOperations = createSessionManagementOperations({
    getActiveSessionId: () => state.activeSessionId,
    createRemoteSession: (body) => client.session.create(body),
    buildCreatePermission: (mode) => getSessionPermissionRulesForMode(mode, 'create'),
    upsertSession,
    resetToolCallExpansionState,
    setActiveSessionId: (sessionId) => setState('activeSessionId', sessionId),
    clearDraftCurrentDocumentState,
    adoptDraftCurrentDocumentState,
    setSessionStatusEntry,
    setSessionUsageLimit,
    persistActiveSessionId,
    markSessionSeen,
    getPersistedSelectedModel,
    setSelectedModel,
    resolveDefaultAgent: () =>
      getBuildAgentNameFromState() ||
      getPersistedSelectedAgent() ||
      getDefaultPrimaryAgentNameFromState(),
    setSelectedAgent,
    getConnectedMcpNames: () =>
      Object.entries(state.mcpStatus)
        .filter(([, value]) => value?.status === 'connected')
        .map(([name]) => name),
    setSelectedMcpsForSession,
    setPermissionModeForSession,
    resetDraftPermissionMode,
    resetTodoSync,
    clearMessages,
    stopLoading,
    setError,
    getSessions: () => state.sessions,
    getDeletedSessionTreeIds,
    getNextSessionIdAfterDeletion,
    deleteRemoteSession: (sessionId) => client.session.delete(sessionId),
    hideDeletedSessionTree: (sessionId) => {
      hideDeletedSessionTree(sessionId);
    },
    loadRecycleBin,
    selectSession,
    logError,
    restoreRecycleBinEntry: (rootID) => client.varro.recycleBin.restore(rootID),
    loadSessions,
    hydrateSessionStatuses,
    getRecycleBinEntries: () => state.recycleBinEntries,
    deleteRecycleBinEntry: (rootID) => client.varro.recycleBin.delete(rootID),
    clearDeletedSessionState,
    emptyRecycleBin: () => client.varro.recycleBin.empty(),
  });

  async function selectSession(id: string, options?: { markSeen?: boolean }) {
    await sessionSyncOperations.selectSession(id, options);
  }

  async function syncSessionMessages(sessionId: string) {
    await sessionSyncOperations.syncSessionMessages(sessionId);
  }

  async function syncSession(sessionId: string) {
    await sessionSyncOperations.syncSession(sessionId);
  }

  async function createSession(
    title?: string,
    initialPermissionMode = getPermissionModeForSession(null)
  ): Promise<string | null> {
    return sessionManagementOperations.createSession(title, initialPermissionMode);
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

  async function sendMessage(text: string, options?: { noReply?: boolean }) {
    await sessionSendOperations.sendMessage(text, options);
  }

  async function retryMessage(messageId: string, sessionId = state.activeSessionId) {
    await sessionSendOperations.retryMessage(messageId, sessionId);
  }

  async function implementPlan(prompt: string, sessionId = state.activeSessionId) {
    await sessionActionOperations.implementPlan(prompt, sessionId);
  }

  async function openPlan(markdown: string, sessionId = state.activeSessionId) {
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
    sessionId = state.activeSessionId
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
    applySessionMcps,
    selectSession,
    createSession,
    deleteSession,
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
