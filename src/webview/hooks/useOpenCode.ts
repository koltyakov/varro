import { onMount, onCleanup, createEffect, createSignal } from 'solid-js';
import { produce } from 'solid-js/store';
import { client } from '../lib/client';
import {
  state,
  setState,
  setRecycleBinEntries,
  setSessions,
  setSelectedAgent,
  setSelectedModel,
  resolveSelectedModel,
  theme,
  setTheme,
  isLoading,
  startLoading,
  stopLoading,
  markLoadingActivity,
  setError,
  requestComposerFocus,
  requestOpenAttentionSessions,
  setCommands,
  persistActiveSessionId,
  getPersistedActiveSessionId,
  getPersistedSelectedAgent,
  getPersistedSelectedModel,
  requestMessageListScrollToBottom,
  clearClipboardImages,
  clearMessages,
  replaceMessages,
  clearStreamingState,
  clearCurrentDocumentStateForSession,
  clearDraftCurrentDocumentState,
  syncFailedSessionsFromMessages,
  setSessionFailed,
  setMessagesIncremental,
  upsertMessageInfo,
  upsertPart,
  applyMessagePartDelta,
  removeMessagePart,
  addPermission,
  removePermission,
  setQuestions,
  upsertQuestion,
  removeQuestion,
  removeContextFile,
  addContextFiles,
  markSessionSeen,
  clearSessionSeen,
  clearSkippedPlanSession,
  skipPlanSession,
  setSessionCompacting,
  getSelectedModelForSession,
  getSelectedAgentForSession,
  getSelectedMcpsForSession,
  clearSelectedAgentForSession,
  clearSelectedModelForSession,
  clearSelectedMcpsForSession,
  getPermissionModeForSession,
  removePermissionModeForSession,
  resetDraftPermissionMode,
  setPermissionModeForSession,
  syncDraftPermissionForWorkspace,
  syncSessionMarkersForWorkspace,
  saveProjectPermissionMode,
  draftPermissionMode,
  setDraftPermissionMode,
  getCurrentDocumentEnabled,
  adoptDraftCurrentDocumentState,
  rememberCurrentDocumentNavigation,
  getSessionTreeIds,
  setProviderLimit,
  setMcpStatus,
  setSelectedMcpsForSession,
  setSessionUsageLimit,
  consumeInterruptedSessionIds,
  setDesktopSessionPaneSide,
  setExpandThinkingByDefaultPreference,
  setShowStickyUserPromptPreference,
  getAvailableMcpNames,
  getProviderLimit,
} from '../lib/state';
import { onMessage, postMessage } from '../lib/bridge';
import type { ExtensionMessage, WebviewThemeKind } from '../../shared/protocol';

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

import type { Session, SessionStatus, Message, Part, Permission } from '../types';
import { applyWebviewTheme } from '../lib/theme';
import { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';
import { getSessionPermissionRulesForMode } from './permission-rules';
import { registerSessionEventHandlers } from './session-event-handlers';
import {
  deriveUsageLimitNotice,
  parseUsageLimitNotice,
  type UsageLimitNotice,
} from '../lib/usage-limit';
import {
  extractTodos,
  handoffTodosToMessages as handoffTodosToMessagesWithState,
  syncTodosFromMessages as syncTodosFromMessagesWithState,
} from './todo-sync';
import {
  applySessions as applySessionsWithLifecycle,
  clearDeletedSessionState as clearDeletedSessionStateWithLifecycle,
  getDeletedSessionTreeIds,
  getNextSessionIdAfterDeletion,
  hideDeletedSessionTree as hideDeletedSessionTreeWithLifecycle,
  normalizeProjectPath,
  removeDeletedSessionTree as removeDeletedSessionTreeWithLifecycle,
  upsertSession as upsertSessionWithLifecycle,
} from './session-lifecycle';
import {
  selectSessionWithDependencies,
  syncSessionMessagesWithDependencies,
  syncSessionWithDependencies,
} from './session-selection';
import { buildSessionSendBody } from './session-send';
import {
  getActiveProviderSelection as getActiveProviderSelectionForState,
  getBuildAgentName,
  getDefaultPrimaryAgentName,
  reconcileLoadedAgents,
  reconcileLoadedProviders,
} from './routing-state';
import {
  continueInterruptedSessionWithDependencies,
  initConnectionWithDependencies,
  recoverInterruptedSessionsWithDependencies,
} from './connection-bootstrap';
import {
  implementPlanWithDependencies,
  initSessionWithDependencies,
  openPlanWithDependencies,
  runSlashCommandWithDependencies,
} from './session-actions';
import {
  abortSessionWithDependencies,
  compactSessionWithDependencies,
  redoSessionWithDependencies,
  reviewSessionWithDependencies,
  undoSessionWithDependencies,
} from './session-controls';
import {
  autoApprovePermissionsForSessionWithDependencies,
  rejectQuestionWithDependencies,
  respondPermissionWithDependencies,
  respondQuestionWithDependencies,
  updatePermissionModeForSessionWithDependencies,
} from './session-approvals';

let initialized = false;
let initializing = false;
let eventHandlerCleanups: (() => void)[] = [];
let currentWorkspacePath: string | null = null;
let todoStateAuthority: 'messages' | 'event' = 'messages';
let connectionGeneration = 0;
let sessionSelectionGeneration = 0;
let sessionSyncGeneration = 0;
const pendingAbortRetryAttempts = new Map<string, number | null>();
const [documentVisible, setDocumentVisible] = createSignal(document.visibilityState === 'visible');

function shouldAutoApprovePermissions(sessionId: string) {
  return getPermissionModeForSession(sessionId) === 'full';
}

function applySessions(sessions: Session[]) {
  applySessionsWithLifecycle(getSessionLifecycleDeps(), sessions);
}

function setSessionStatusEntry(sessionId: string, status: SessionStatus) {
  setState(
    'sessionStatus',
    produce((statuses) => {
      statuses[sessionId] = status;
    })
  );
}

function clearActiveSessionState() {
  resetTodoSync();
  resetToolCallExpansionState();
  setState('activeSessionId', null);
  persistActiveSessionId(null);
  clearMessages();
  stopLoading();
}

function clearDeletedSessionState(id: string) {
  clearDeletedSessionStateWithLifecycle(getSessionLifecycleDeps(), id);
}

function hideDeletedSessionTree(id: string, sessions = state.sessions) {
  return hideDeletedSessionTreeWithLifecycle(getSessionLifecycleDeps(), id, sessions);
}

function removeDeletedSessionTree(id: string, sessions = state.sessions) {
  return removeDeletedSessionTreeWithLifecycle(getSessionLifecycleDeps(), id, sessions);
}

function upsertSession(session: Session) {
  upsertSessionWithLifecycle(getSessionLifecycleDeps(), session);
}

function getSessionLifecycleDeps() {
  return {
    getState: () => ({ activeSessionId: state.activeSessionId, sessions: state.sessions }),
    getCurrentWorkspacePath: () => currentWorkspacePath,
    setSessions,
    clearSessionStatusEntry: (sessionId: string) => {
      setState('sessionStatus', (statuses) => {
        const next = { ...statuses };
        delete next[sessionId];
        return next;
      });
    },
    clearPendingAbort,
    clearPendingAbortTree,
    removePermissionModeForSession,
    clearCurrentDocumentStateForSession,
    clearSelectedAgentForSession,
    clearSelectedMcpsForSession,
    clearSkippedPlanSession,
    clearSelectedModelForSession,
    clearSessionSeen,
    setSessionUsageLimit,
    setSessionFailed,
    filterQuestions: (predicate: (sessionId: string) => boolean) =>
      setState('questions', (items) => items.filter((item) => predicate(item.sessionID))),
    filterPermissions: (predicate: (sessionId: string) => boolean) =>
      setState('permissions', (items) => items.filter((item) => predicate(item.sessionID))),
    filterPendingAttentionSessionIds: (predicate: (sessionId: string) => boolean) =>
      setState('pendingAttentionSessionIds', (items) =>
        items.filter((sessionId) => predicate(sessionId))
      ),
    clearActiveSessionState,
    markSessionSeen,
  };
}

function clearPendingAbort(sessionId: string | null | undefined) {
  if (!sessionId) return;
  pendingAbortRetryAttempts.delete(sessionId);
}

function hasPendingAbort(sessionId: string | null | undefined) {
  return sessionId ? pendingAbortRetryAttempts.has(sessionId) : false;
}

function clearPendingAbortTree(sessionIds: string[]) {
  for (const sessionId of sessionIds) {
    clearPendingAbort(sessionId);
  }
}

function markPendingAbort(sessionId: string) {
  const status = state.sessionStatus[sessionId];
  pendingAbortRetryAttempts.set(sessionId, status?.type === 'retry' ? status.attempt : null);
}

function markPendingAbortTree(sessionIds: string[]) {
  for (const sessionId of sessionIds) {
    markPendingAbort(sessionId);
  }
}

function shouldIgnorePendingAbortStatus(
  sessionId: string,
  status: SessionStatus | null | undefined
) {
  if (!pendingAbortRetryAttempts.has(sessionId)) return false;
  if (!status || status.type === 'idle') return false;
  if (status.type === 'busy') return true;
  if (status.type !== 'retry') return false;

  const abortedAttempt = pendingAbortRetryAttempts.get(sessionId);
  return abortedAttempt == null || status.attempt >= abortedAttempt;
}

function resetTodoSync() {
  todoStateAuthority = 'messages';
}

function applyTheme(nextTheme: WebviewThemeKind) {
  applyWebviewTheme(nextTheme);
}

function syncTodosFromMessages(messages = state.messages) {
  syncTodosFromMessagesWithState(
    { authority: todoStateAuthority, todos: state.todos },
    (todos) => setState('todos', todos),
    messages
  );
}

function handoffTodosToMessages(messages = state.messages) {
  const handedOff = handoffTodosToMessagesWithState(
    { authority: todoStateAuthority, todos: state.todos },
    (todos) => setState('todos', todos),
    messages
  );
  if (handedOff) {
    todoStateAuthority = 'messages';
  }
  return handedOff;
}

function deriveSelectedModelFromMessages(messages: Array<{ info: Message; parts: Part[] }>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]?.info;
    if (!message) continue;
    if (message.role === 'user') {
      return message.model;
    }
    return {
      providerID: message.providerID,
      modelID: message.modelID,
      variant: message.variant,
    };
  }

  return null;
}

function deriveSelectedAgentFromMessages(messages: Array<{ info: Message; parts: Part[] }>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]?.info;
    if (!message) continue;
    if (message.role === 'user') return message.agent;
    if (message.agent) return message.agent;
  }

  return null;
}

function getUsageLimitNoticeContext(
  sessionID: string,
  messages: Array<{ info: Message; parts: Part[] }> = state.messages
) {
  const selected = resolveSelectedModel(
    getSelectedModelForSession(sessionID),
    state.providers,
    state.providerDefaults
  );
  if (selected) {
    return { providerID: selected.providerID, modelID: selected.modelID };
  }

  const derived = resolveSelectedModel(
    deriveSelectedModelFromMessages(messages),
    state.providers,
    state.providerDefaults
  );
  if (derived) {
    return { providerID: derived.providerID, modelID: derived.modelID };
  }

  return getActiveProviderSelection();
}

function getDefaultPrimaryAgentNameFromState() {
  return getDefaultPrimaryAgentName(state.agents);
}

function getBuildAgentNameFromState() {
  return getBuildAgentName(state.agents);
}

export function useOpenCode() {
  onMount(() => {
    applyTheme(theme());

    if (eventHandlerCleanups.length === 0) {
      eventHandlerCleanups = registerSessionEventHandlers({
        getActiveSessionId: () => state.activeSessionId,
        getMessages: () => state.messages,
        setTodoStateAuthority: (value) => {
          todoStateAuthority = value;
        },
        handoffTodosToMessages,
        setTodos: (todos) => setState('todos', todos),
        upsertSession,
        setSessionCompacting,
        removeDeletedSessionTree,
        shouldIgnorePendingAbortStatus,
        hasPendingAbort,
        clearPendingAbort,
        setSessionStatusEntry,
        clearUsageLimitOnResumedProgress,
        updateUsageLimitState,
        startLoading,
        stopLoading,
        markSessionSeen,
        syncSession,
        shouldResyncSessionAfterIdle,
        syncSessionMessages,
        markLoadingActivity,
        upsertMessageInfo,
        setSessionFailed,
        parseUsageLimitNotice: (message) => parseUsageLimitNotice(message),
        applyUsageLimitNotice: (sessionId, notice, options) =>
          applyUsageLimitNotice(sessionId, notice as UsageLimitNotice | null, options),
        setSessionUsageLimit,
        upsertPart,
        syncTodosFromMessages,
        applyMessagePartDelta,
        removeMessagePart,
        clearStreamingState,
        replaceMessages,
        shouldAutoApprovePermissions,
        respondPermission,
        addPermission,
        removePermission,
        upsertQuestion,
        removeQuestion,
        extractTodos,
        setDiffs: (diffs) => setState('diffs', diffs),
      });
    }

    const disposeBridge = onMessage((msg: ExtensionMessage) => {
      switch (msg.type) {
        case 'server/status':
          setState('serverStatus', msg.payload);
          if (msg.payload.state === 'running') {
            setError(null);
            ensureConnectionInitialized();
          } else {
            setState('providersLoaded', false);
            setState('providerLimits', {});
            setError(null);
          }
          break;
        case 'theme/update':
          setTheme(msg.payload.theme);
          applyTheme(msg.payload.theme);
          break;
        case 'config/update':
          setExpandThinkingByDefaultPreference(msg.payload.expandThinkingByDefault);
          setShowStickyUserPromptPreference(msg.payload.showStickyUserPrompt);
          setDesktopSessionPaneSide(msg.payload.desktopSessionPaneSide);
          break;
        case 'pending-attention/update':
          setState('pendingAttentionSessionIds', msg.payload.sessionIds);
          break;
        case 'context/update':
          {
            const previousActiveFilePath = state.editorContext.activeFile?.path ?? null;
            const nextWorkspacePath = normalizeProjectPath(msg.payload.workspacePath);
            const workspaceChanged = nextWorkspacePath !== currentWorkspacePath;
            currentWorkspacePath = nextWorkspacePath;
            setState('editorContext', msg.payload);
            rememberCurrentDocumentNavigation(
              previousActiveFilePath,
              msg.payload.activeFile?.path ?? null,
              state.activeSessionId
            );
            if (workspaceChanged) {
              syncDraftPermissionForWorkspace(nextWorkspacePath);
              syncSessionMarkersForWorkspace(nextWorkspacePath);
            }
            if (workspaceChanged && initialized) {
              loadSessions().catch(() => {});
            }
          }
          break;
        case 'terminal-selection/update':
          setState('terminalSelection', msg.payload);
          break;
        case 'files/dropped':
          addContextFiles(msg.payload);
          break;
        case 'files/removed':
          removeContextFile(msg.payload.path);
          break;
        case 'command/new-session':
          createSession();
          break;
        case 'command/focus-input':
          requestComposerFocus();
          break;
        case 'command/open-attention-sessions':
          requestOpenAttentionSessions();
          break;
        case 'command/abort':
          abortSession();
          break;
        case 'server/event':
          if (
            msg.payload.type === 'mcp.tools.changed' ||
            msg.payload.type === 'mcp.browser.open.failed'
          ) {
            void loadMcps();
          }
          break;
        case 'recycle-bin/update':
          setRecycleBinEntries(msg.payload.entries);
          break;
      }
    });

    postMessage({ type: 'ready' });

    const postFocusState = () => {
      postMessage({
        type: 'webview/focus',
        payload: { focused: document.visibilityState === 'visible' && document.hasFocus() },
      });
    };

    postFocusState();

    const handleVisibilityChange = () => {
      setDocumentVisible(document.visibilityState === 'visible');
      postFocusState();
      if (document.visibilityState === 'visible' && isLoading() && state.activeSessionId) {
        recheckSessionStatus(state.activeSessionId);
      }
    };
    const handleFocus = () => postFocusState();
    const handleBlur = () => postFocusState();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);

    onCleanup(() => {
      disposeBridge();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      for (const cleanup of eventHandlerCleanups) cleanup();
      eventHandlerCleanups = [];
      initialized = false;
      initializing = false;
      pendingAbortRetryAttempts.clear();
    });
  });

  // Periodic staleness recovery: when loading, poll server every 8s to detect missed idle events
  createEffect(() => {
    const loading = isLoading();
    const sessionId = state.activeSessionId;
    const visible = documentVisible();
    if (!loading || !sessionId || !visible) return;

    let delay = 8000;
    const schedulePoll = () => {
      return setTimeout(() => {
        if (!isLoading() || !state.activeSessionId || !documentVisible()) return;
        recheckSessionStatus(state.activeSessionId);
        delay = Math.min(delay * 2, 60_000);
        timer = schedulePoll();
      }, delay);
    };
    let timer = schedulePoll();

    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    const visible = documentVisible();
    if (state.serverStatus.state !== 'running' || !state.providersLoaded || !visible) return;

    const active = getActiveProviderSelection();
    if (!active) return;
    const existingLimit = getProviderLimit(active.providerID, active.modelID);
    if (existingLimit?.status === 'unsupported') return;

    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const limit = await client.config.providerLimit(active.providerID, active.modelID);
        if (!cancelled) {
          setProviderLimit(active.providerID, active.modelID, limit);
        }
      } catch (err) {
        logError('loadProviderLimit', err);
      }
    };

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 120_000);

    onCleanup(() => {
      cancelled = true;
      window.clearInterval(timer);
    });
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

function clearUsageLimitOnResumedProgress(sessionID: string, nextStatus?: SessionStatus | null) {
  const current = state.sessionUsageLimits[sessionID];
  if (!current) return;
  if (nextStatus?.type === 'retry') return;
  if (nextStatus?.type === 'busy' && current.source === 'message') return;
  setSessionUsageLimit(sessionID, null);
}

function applyUsageLimitNotice(
  sessionID: string,
  notice: UsageLimitNotice | null,
  options?: { preserveExistingOnNull?: boolean }
) {
  if (notice) {
    setSessionUsageLimit(sessionID, { ...notice, sessionID });
    if (notice.providerID) {
      void refreshProviderLimit(notice.providerID, notice.modelID);
    }
    return;
  }

  if (!options?.preserveExistingOnNull) {
    setSessionUsageLimit(sessionID, null);
  }
}

function shouldResyncSessionAfterIdle(sessionId: string) {
  return state.activeSessionId === sessionId;
}

function isDocumentVisible() {
  return documentVisible();
}

function isCurrentGeneration(current: number, expected: number) {
  return current === expected;
}

export async function recheckSessionStatus(sessionId: string) {
  if (!isDocumentVisible()) return;
  try {
    const statuses = await client.session.status();
    const status = statuses[sessionId];
    if (shouldIgnorePendingAbortStatus(sessionId, status)) return;
    const abortedRetry = hasPendingAbort(sessionId);
    if (!(abortedRetry && (!status || status.type === 'idle'))) {
      updateUsageLimitState(sessionId, status);
    }
    if (!status || status.type === 'idle') {
      clearPendingAbort(sessionId);
    }
    if (!status || status.type === 'idle') {
      stopLoading();
      if (shouldResyncSessionAfterIdle(sessionId)) {
        await syncSessionMessages(sessionId).catch(() => {});
      }
    } else if (status.type === 'busy' || status.type === 'retry') {
      startLoading();
    }
  } catch (err) {
    logError('recheckSessionStatus', err);
  }
}

function initConnection() {
  return initConnectionWithDependencies(
    {
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
      recoverInterruptedSessions,
      setInitialized: (value) => {
        initialized = value;
      },
      setError,
    },
    {
      next: () => ++connectionGeneration,
      isCurrent: (generation) => isCurrentGeneration(generation, connectionGeneration),
    }
  );
}

async function loadMcps() {
  try {
    const status = await client.mcp.status();
    setMcpStatus(status || {});
    const activeSessionId = state.activeSessionId;
    if (activeSessionId && !getSelectedMcpsForSession(activeSessionId)) {
      setSelectedMcpsForSession(
        activeSessionId,
        Object.entries(status || {})
          .filter(([, value]) => value?.status === 'connected')
          .map(([name]) => name)
      );
    }
  } catch (err) {
    logError('loadMcps', err);
  }
}

async function syncSessionMcps(sessionId: string) {
  const desired = getSelectedMcpsForSession(sessionId);
  if (!desired) return;

  if (Object.keys(state.mcpStatus).length === 0) {
    await loadMcps();
  }

  const available = new Set(getAvailableMcpNames());
  const desiredSet = new Set(desired.filter((name) => available.has(name)));
  const connected = Object.entries(state.mcpStatus)
    .filter(([, value]) => value?.status === 'connected')
    .map(([name]) => name);

  const connect = [...desiredSet].filter((name) => !connected.includes(name));
  const disconnect = connected.filter((name) => !desiredSet.has(name));
  if (connect.length === 0 && disconnect.length === 0) return;

  try {
    await Promise.all([
      ...connect.map((name) => client.mcp.connect(name)),
      ...disconnect.map((name) => client.mcp.disconnect(name)),
    ]);
  } catch (err) {
    logError('syncSessionMcps', err);
  }

  await loadMcps();
}

export async function applySessionMcps(names: string[], sessionId = state.activeSessionId) {
  if (!sessionId) return;
  setSelectedMcpsForSession(sessionId, names);
  await syncSessionMcps(sessionId);
}

async function recoverInterruptedSessions(generation: number) {
  await recoverInterruptedSessionsWithDependencies(
    {
      consumeInterruptedSessionIds,
      isCurrentGeneration: (currentGeneration) =>
        isCurrentGeneration(currentGeneration, connectionGeneration),
      hasSession: (sessionId) => state.sessions.some((session) => session.id === sessionId),
      getSessionStatus: (sessionId) => state.sessionStatus[sessionId],
      hasPendingQuestion: (sessionId) =>
        state.questions.some((item) => item.sessionID === sessionId),
      hasPendingPermission: (sessionId) =>
        state.permissions.some((item) => item.sessionID === sessionId),
      loadSessionMessages: (sessionId) => client.session.messages(sessionId),
      continueInterruptedSession,
      logError,
    },
    generation
  );
}

async function continueInterruptedSession(sessionId: string) {
  await continueInterruptedSessionWithDependencies(
    {
      syncSessionMcps,
      resolveModel: (id) =>
        resolveSelectedModel(
          getSelectedModelForSession(id),
          state.providers,
          state.providerDefaults
        ),
      resolveAgent: (id) => getSelectedAgentForSession(id) || getDefaultPrimaryAgentNameFromState(),
      sendAsync: (id, body) => client.session.sendAsync(id, body),
      syncSession,
      recheckSessionStatus,
    },
    sessionId
  );
}

function ensureConnectionInitialized() {
  if (initialized || initializing) return;
  initializing = true;
  void initConnection().finally(() => {
    initializing = false;
  });
}

async function loadQuestions() {
  try {
    const questions = await client.question.list();
    setQuestions(questions);
  } catch (err) {
    logError('loadQuestions', err);
  }
}

async function loadAgents() {
  try {
    const loadedAgents = await client.agent.list();
    const activeSessionId = state.activeSessionId;
    const routingState = reconcileLoadedAgents({
      loadedAgents,
      activeSessionId,
      selectedAgent: state.selectedAgent,
      sessionSelectedAgent: activeSessionId ? getSelectedAgentForSession(activeSessionId) : null,
      persistedSelectedAgent: getPersistedSelectedAgent(),
    });
    setState('allAgents', routingState.visibleAgents);
    setState('agents', routingState.primaryAgents);
    if (routingState.nextSelectedAgent) {
      setSelectedAgent(
        routingState.nextSelectedAgent.value,
        routingState.nextSelectedAgent.options
      );
    }
  } catch (err) {
    logError('loadAgents', err);
  }
}

async function loadCommands() {
  try {
    const commands = await client.command.list();
    setCommands(commands || []);
  } catch (err) {
    logError('loadCommands', err);
  }
}

async function loadProviders() {
  setState('providersLoaded', false);
  try {
    const res = await client.config.providers();
    setState('providers', res.providers);
    setState('providerDefaults', res.default || {});
    setState('providersLoaded', true);
    const routingState = reconcileLoadedProviders({
      selectedModel: state.selectedModel,
      providers: res.providers,
      providerDefaults: res.default || {},
    });
    if (routingState.nextSelectedModel !== undefined) {
      setSelectedModel(routingState.nextSelectedModel);
    }
  } catch (err) {
    logError('loadProviders', err);
  }
}

export async function refreshRoutingState() {
  await Promise.all([loadAgents(), loadProviders()]);
}

async function refreshProviderLimit(providerID: string, modelID?: string | null) {
  try {
    const limit = await client.config.providerLimit(providerID, modelID);
    setProviderLimit(providerID, modelID, limit);
  } catch (err) {
    logError('loadProviderLimit', err);
  }
}

async function loadSessions() {
  try {
    const sessions = await client.session.list();
    applySessions(sessions);
  } catch (err) {
    logError('loadSessions', err);
  }
}

async function loadRecycleBin() {
  try {
    const entries = await client.varro.recycleBin.list();
    setRecycleBinEntries(entries || []);
  } catch (err) {
    logError('loadRecycleBin', err);
  }
}

async function hydrateSessionStatuses() {
  try {
    const statuses = await client.session.status();
    setState('sessionStatus', statuses);
    for (const session of state.sessions) {
      updateUsageLimitState(session.id, statuses[session.id], []);
    }
  } catch (err) {
    logError('session.status', err);
  }
}

export async function selectSession(id: string, options?: { markSeen?: boolean }) {
  await selectSessionWithDependencies(
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
        resolveSelectedModel(
          deriveSelectedModelFromMessages(messages),
          state.providers,
          state.providerDefaults
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
    },
    {
      next: () => ++sessionSelectionGeneration,
    },
    id,
    options
  );
}

async function syncSessionMessages(sessionId: string) {
  await syncSessionMessagesWithDependencies(
    {
      getActiveSessionId: () => state.activeSessionId,
      getSessionStatus: (id) => state.sessionStatus[id],
      loadSessionMessages: (id) => client.session.messages(id),
      updateUsageLimitState,
      setMessagesIncremental,
      syncFailedSessionsFromMessages,
      handoffTodosToMessages,
    },
    {
      next: () => ++sessionSyncGeneration,
      isCurrent: (generation) => isCurrentGeneration(generation, sessionSyncGeneration),
    },
    sessionId
  );
}

async function syncSession(sessionId: string) {
  await syncSessionWithDependencies(
    {
      loadSession: (id) => client.session.get(id),
      upsertSession,
    },
    sessionId
  );
}

export async function createSession(
  title?: string,
  initialPermissionMode = getPermissionModeForSession(null)
): Promise<string | null> {
  try {
    const previousActiveSessionId = state.activeSessionId;
    const session = await client.session.create({
      ...(title ? { title } : {}),
      permission: getSessionPermissionRulesForMode(initialPermissionMode, 'create'),
    });
    upsertSession(session);
    resetToolCallExpansionState();
    setState('activeSessionId', session.id);
    if (previousActiveSessionId) {
      clearDraftCurrentDocumentState();
    } else {
      adoptDraftCurrentDocumentState(session.id);
    }
    setSessionStatusEntry(session.id, { type: 'idle' });
    setSessionUsageLimit(session.id, null);
    persistActiveSessionId(session.id);
    markSessionSeen(session.id);
    const defaultModel = getPersistedSelectedModel();
    if (defaultModel) {
      setSelectedModel(defaultModel, { sessionId: session.id, persistGlobal: false });
    }
    const defaultAgent =
      getBuildAgentNameFromState() ||
      getPersistedSelectedAgent() ||
      getDefaultPrimaryAgentNameFromState();
    if (defaultAgent) {
      setSelectedAgent(defaultAgent, { sessionId: session.id, persistGlobal: false });
    }
    setSelectedMcpsForSession(
      session.id,
      Object.entries(state.mcpStatus)
        .filter(([, value]) => value?.status === 'connected')
        .map(([name]) => name)
    );
    if (initialPermissionMode === 'full') {
      setPermissionModeForSession(session.id, 'full');
    }
    resetDraftPermissionMode();
    resetTodoSync();
    clearMessages();
    stopLoading();
    return session.id;
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to create session');
    return null;
  }
}

export async function deleteSession(id: string) {
  try {
    const deletedIds = getDeletedSessionTreeIds(id, state.sessions);
    const remainingSessions = state.sessions.filter((session) => !deletedIds.has(session.id));
    const wasActive = state.activeSessionId ? deletedIds.has(state.activeSessionId) : false;
    const nextActiveId = wasActive ? getNextSessionIdAfterDeletion(remainingSessions) : null;

    await client.session.delete(id);

    hideDeletedSessionTree(id);
    await loadRecycleBin();

    if (nextActiveId) {
      await selectSession(nextActiveId, { markSeen: false });
    }
  } catch (err) {
    logError('deleteSession', err);
  }
}

export async function restoreSession(rootID: string) {
  try {
    await client.varro.recycleBin.restore(rootID);
    await Promise.all([loadSessions(), loadRecycleBin(), hydrateSessionStatuses()]);
  } catch (err) {
    logError('restoreSession', err);
  }
}

export async function deleteSessionPermanently(rootID: string) {
  try {
    const entry = state.recycleBinEntries.find((item) => item.rootID === rootID);
    await client.varro.recycleBin.delete(rootID);
    await loadRecycleBin();
    const deletedSessions = entry?.sessions?.length
      ? entry.sessions
      : entry?.root
        ? [entry.root]
        : [{ id: rootID } as Session];
    for (const session of deletedSessions) {
      clearDeletedSessionState(session.id);
    }
  } catch (err) {
    logError('deleteSessionPermanently', err);
  }
}

export async function emptyRecycleBin() {
  try {
    const entries = [...state.recycleBinEntries];
    await client.varro.recycleBin.empty();
    await loadRecycleBin();
    for (const entry of entries) {
      for (const session of entry.sessions) {
        clearDeletedSessionState(session.id);
      }
    }
  } catch (err) {
    logError('emptyRecycleBin', err);
  }
}

export async function sendMessage(text: string, options?: { noReply?: boolean }) {
  let sessionId = state.activeSessionId;
  if (!sessionId) {
    const createdId = await createSession(undefined, getPermissionModeForSession(null));
    if (!createdId) return;
    sessionId = createdId;
  }

  const currentSessionId = state.activeSessionId;
  if (currentSessionId && currentSessionId !== sessionId) {
    sessionId = currentSessionId;
  }

  clearPendingAbort(sessionId);
  await syncSessionMcps(sessionId);

  const sendPayload = buildSessionSendBody(
    {
      selectedAgent: state.selectedAgent,
      selectedModel: state.selectedModel,
      providers: state.providers,
      providerDefaults: state.providerDefaults,
      editorContext: state.editorContext,
      terminalSelection: state.terminalSelection,
      droppedFiles: state.droppedFiles,
      clipboardImages: state.clipboardImages,
    },
    sessionId,
    text,
    getCurrentDocumentEnabled,
    options
  );
  if (!sendPayload) return;
  const { body, effectiveModel } = sendPayload;

  requestMessageListScrollToBottom();
  startLoading();
  setError(null);
  if (effectiveModel) {
    setSelectedModel(effectiveModel, { sessionId });
  }

  resetTodoSync();
  setState('todos', []);
  setSessionUsageLimit(sessionId, null);

  try {
    await client.session.sendAsync(sessionId, body);
    setState('droppedFiles', []);
    setState('terminalSelection', null);
    clearClipboardImages();
    postMessage({ type: 'files/clear' });
    postMessage({ type: 'terminal-selection/clear' });
    await Promise.all([
      syncSession(sessionId),
      syncSessionMessages(sessionId),
      recheckSessionStatus(sessionId),
    ]).catch(() => {});
  } catch (err) {
    stopLoading();
    const baseMessage = err instanceof Error ? err.message : 'Failed to send message';
    if (body.model) {
      setError(
        `Failed to send with ${body.model.providerID}/${body.model.modelID}: ${baseMessage}`
      );
      return;
    }
    setError(baseMessage);
  }
}

export async function retryMessage(messageId: string, sessionId = state.activeSessionId) {
  if (!sessionId || sessionId !== state.activeSessionId) return;

  const assistantEntry = state.messages.find(
    (entry) => entry.info.role === 'assistant' && entry.info.id === messageId
  );
  if (!assistantEntry || assistantEntry.info.role !== 'assistant') return;

  startLoading();
  setError(null);
  clearPendingAbort(sessionId);
  setSessionUsageLimit(sessionId, null);
  setSessionFailed(sessionId, false);

  try {
    await continueInterruptedSession(sessionId);
  } catch (err) {
    stopLoading();
    setSessionFailed(sessionId, true);
    setError(err instanceof Error ? err.message : 'Failed to retry message');
  }
}

export async function implementPlan(prompt: string, sessionId = state.activeSessionId) {
  await implementPlanWithDependencies(
    {
      getActiveSessionId: () => state.activeSessionId,
      getBuildAgent: getBuildAgentNameFromState,
      setError,
      clearSkippedPlanSession,
      applySelectedAgent: (agent, id) =>
        setSelectedAgent(agent, { sessionId: id, persistGlobal: false }),
      sendMessage,
    },
    prompt,
    sessionId
  );
}

export async function openPlan(markdown: string, sessionId = state.activeSessionId) {
  await openPlanWithDependencies(
    {
      getActiveSessionId: () => state.activeSessionId,
      setError,
      openPlan: (content) => client.varro.openPlan(content),
    },
    markdown,
    sessionId
  );
}

export async function abortSession() {
  await abortSessionWithDependencies({
    getActiveSessionId: () => state.activeSessionId,
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
  });
}

export async function undoSession() {
  await undoSessionWithDependencies({
    getActiveSessionId: () => state.activeSessionId,
    getMessages: () => state.messages,
    startLoading,
    revertSession: (sessionId, messageId) => client.session.revert(sessionId, messageId),
    syncSession,
    syncSessionMessages,
    stopLoading,
    setError,
  });
}

export async function redoSession() {
  await redoSessionWithDependencies({
    getActiveSessionId: () => state.activeSessionId,
    startLoading,
    unrevertSession: (sessionId) => client.session.unrevert(sessionId),
    upsertSession,
    syncSession,
    syncSessionMessages,
    stopLoading,
    setError,
  });
}

export async function initSession() {
  await initSessionWithDependencies({
    getActiveSessionId: () => state.activeSessionId,
    createSession: () => createSession(undefined, getPermissionModeForSession(null)),
    getMessageCount: () => state.messages.length,
    setError,
    sendMessage,
  });
}

export async function runSlashCommandByName(name: string, args: string) {
  return runSlashCommandWithDependencies(
    {
      hasCommand: (commandName) => state.commands.some((item) => item.name === commandName),
      getActiveSessionId: () => state.activeSessionId,
      createSession: () => createSession(undefined, getPermissionModeForSession(null)),
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
      setError,
    },
    name,
    args
  );
}

export async function reviewSession() {
  await reviewSessionWithDependencies({
    getActiveSessionId: () => state.activeSessionId,
    sendMessage,
  });
}

export async function compactSession() {
  await compactSessionWithDependencies({
    getActiveSessionId: () => state.activeSessionId,
    clearPendingAbort,
    resolveSelectedModel: () =>
      resolveSelectedModel(state.selectedModel, state.providers, state.providerDefaults),
    setError,
    setSessionCompacting,
    startLoading,
    compactRemoteSession: (sessionId, input) => client.session.compact(sessionId, input),
    syncSession,
    syncSessionMessages,
    getSession: (sessionId) => state.sessions.find((session) => session.id === sessionId),
    stopLoading,
  });
}

export async function respondPermission(
  sessionId: string,
  permissionId: string,
  response: 'once' | 'always' | 'reject',
  options?: { rethrow?: boolean }
) {
  await respondPermissionWithDependencies(
    {
      getPermissions: () => state.permissions,
      respondPermission: (targetSessionId, targetPermissionId, targetResponse) =>
        client.session.respondPermission(targetSessionId, targetPermissionId, targetResponse),
      removePermission,
      setError,
    },
    sessionId,
    permissionId,
    response,
    options
  );
}

export async function respondQuestion(requestID: string, answers: Array<Array<string>>) {
  await respondQuestionWithDependencies(
    {
      replyQuestion: (id, responseAnswers) => client.question.reply(id, responseAnswers),
      removeQuestion,
      setError,
    },
    requestID,
    answers
  );
}

async function autoApprovePermissionsForSession(permissions: Permission[]) {
  await autoApprovePermissionsForSessionWithDependencies(
    {
      respondPermission,
    },
    permissions
  );
}

export async function updatePermissionModeForSession(
  mode: 'default' | 'full',
  sessionId = state.activeSessionId
) {
  await updatePermissionModeForSessionWithDependencies(
    {
      getPermissionModeForSession,
      getDraftPermissionMode: draftPermissionMode,
      setPermissionModeForSession,
      setDraftPermissionMode,
      saveProjectPermissionMode,
      updateSessionPermission: (id, input) => client.session.update(id, input),
      upsertSession,
      setError,
      getPermissionsForSession: (id) =>
        state.permissions.filter((permission) => permission.sessionID === id),
      autoApprovePermissionsForSession,
    },
    mode,
    getSessionPermissionRulesForMode(mode, 'update'),
    sessionId
  );
}

export async function rejectQuestion(requestID: string) {
  await rejectQuestionWithDependencies(
    {
      rejectQuestion: (id) => client.question.reject(id),
      removeQuestion,
      setError,
    },
    requestID
  );
}

function updateUsageLimitState(
  sessionID: string,
  status: SessionStatus | null | undefined,
  messages = state.messages
) {
  const rawNotice = deriveUsageLimitNotice({ sessionID, status, messages });
  const context = rawNotice?.providerID ? null : getUsageLimitNoticeContext(sessionID, messages);
  const notice =
    rawNotice && context
      ? {
          ...rawNotice,
          sessionID,
          providerID: context.providerID,
          modelID: rawNotice.modelID || context.modelID,
        }
      : rawNotice;
  applyUsageLimitNotice(sessionID, notice, { preserveExistingOnNull: status?.type === 'idle' });
}
