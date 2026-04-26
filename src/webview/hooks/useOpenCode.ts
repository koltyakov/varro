import { onMount, onCleanup, createEffect } from 'solid-js';
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

function getDefaultPrimaryAgentName() {
  return (
    state.agents.find((agent) => agent.name === 'build')?.name || state.agents[0]?.name || null
  );
}

function getBuildAgentName() {
  return state.agents.find((agent) => agent.name === 'build')?.name || null;
}

import type { Session, SessionStatus, Message, Part, Permission, Todo } from '../types';
import { getWorkspaceRelativePath, isSamePath } from '../lib/path-display';
import {
  formatSelectionReference,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
  subtractContextLineRanges,
} from '../../shared/context-files';
import { applyWebviewTheme } from '../lib/theme';
import { getPreferredVariant } from '../lib/model-variants';
import { getPromptTextForClipboardImages } from '../lib/clipboard-images';
import { modelSupportsVision } from '../lib/model-capabilities';
import { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';
import { getSessionPermissionRulesForMode } from './permission-rules';
import { registerSessionEventHandlers } from './session-event-handlers';
import {
  deriveUsageLimitNotice,
  parseUsageLimitNotice,
  type UsageLimitNotice,
} from '../lib/usage-limit';

let initialized = false;
let initializing = false;
let eventHandlerCleanups: (() => void)[] = [];
let currentWorkspacePath: string | null = null;
let todoStateAuthority: 'messages' | 'event' = 'messages';
let connectionGeneration = 0;
let sessionSelectionGeneration = 0;
let sessionSyncGeneration = 0;
const pendingAbortRetryAttempts = new Map<string, number | null>();
const INTERRUPTED_SESSION_CONTINUE_PROMPT =
  'Continue from where you were interrupted before the extension reload. Review the existing conversation, do not repeat completed work, and proceed with the next unfinished step.';

function shouldAutoApprovePermissions(sessionId: string) {
  return getPermissionModeForSession(sessionId) === 'full';
}

function normalizeProjectPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedPath || null;
}

function isSessionInWorkspace(session: Session, workspacePath: string | null | undefined): boolean {
  const normalizedWorkspace = normalizeProjectPath(workspacePath);
  if (!normalizedWorkspace) return true;
  return normalizeProjectPath(session.directory) === normalizedWorkspace;
}

function sortSessions(sessions: Session[]) {
  return [...sessions].toSorted((a, b) => b.time.updated - a.time.updated);
}

function applySessions(sessions: Session[]) {
  const nextSessions = sortSessions(
    sessions.filter((session) => isSessionInWorkspace(session, currentWorkspacePath))
  );
  setSessions(nextSessions);

  if (
    state.activeSessionId &&
    !nextSessions.some((session) => session.id === state.activeSessionId)
  ) {
    clearActiveSessionState();
  }
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
  clearPendingAbort(id);
  removePermissionModeForSession(id);
  clearCurrentDocumentStateForSession(id);
  clearSelectedAgentForSession(id);
  clearSelectedMcpsForSession(id);
  clearSkippedPlanSession(id);
  clearSelectedModelForSession(id);
  clearSessionSeen(id);
  setState('sessionStatus', (statuses) => {
    const next = { ...statuses };
    delete next[id];
    return next;
  });
  setSessionUsageLimit(id, null);
  setSessionFailed(id, false);
  setState('questions', (items) => items.filter((item) => item.sessionID !== id));
  setState('permissions', (items) => items.filter((item) => item.sessionID !== id));
  setState('pendingAttentionSessionIds', (items) => items.filter((sessionId) => sessionId !== id));

  if (state.activeSessionId === id) {
    clearActiveSessionState();
  }
}

function hideDeletedSessionTree(id: string, sessions = state.sessions) {
  const deletedIds = getDeletedSessionTreeIds(id, sessions);

  setSessions(sessions.filter((session) => !deletedIds.has(session.id)));
  clearPendingAbortTree([...deletedIds]);
  setState('questions', (items) => items.filter((item) => !deletedIds.has(item.sessionID)));
  setState('permissions', (items) => items.filter((item) => !deletedIds.has(item.sessionID)));
  setState('pendingAttentionSessionIds', (items) =>
    items.filter((sessionId) => !deletedIds.has(sessionId))
  );

  if (state.activeSessionId && deletedIds.has(state.activeSessionId)) {
    clearActiveSessionState();
  }

  return deletedIds;
}

function getDeletedSessionTreeIds(rootId: string, sessions = state.sessions) {
  const deleted = new Set<string>();
  const pending = [rootId];

  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId || deleted.has(currentId)) continue;
    deleted.add(currentId);

    for (const session of sessions) {
      if (session.parentID === currentId) {
        pending.push(session.id);
      }
    }
  }

  return deleted;
}

function getNextSessionIdAfterDeletion(sessions: Session[]) {
  return sessions.find((session) => !session.parentID)?.id || sessions[0]?.id || null;
}

function removeDeletedSessionTree(id: string, sessions = state.sessions) {
  const deletedIds = getDeletedSessionTreeIds(id, sessions);

  setSessions(sessions.filter((session) => !deletedIds.has(session.id)));

  for (const deletedId of deletedIds) {
    clearDeletedSessionState(deletedId);
  }

  return deletedIds;
}

function upsertSession(session: Session) {
  if (!isSessionInWorkspace(session, currentWorkspacePath)) {
    if (state.sessions.some((item) => item.id === session.id)) {
      applySessions(state.sessions.filter((item) => item.id !== session.id));
    }
    return;
  }

  applySessions([session, ...state.sessions.filter((item) => item.id !== session.id)]);

  if (session.id === state.activeSessionId) {
    markSessionSeen(session.id, session.time.updated);
  }
}

const TODO_TOOL_NAMES = new Set(['todowrite', 'update_plan', 'updateplan']);

function extractTodosFromParallelTool(raw: unknown): Todo[] | null {
  if (!raw || typeof raw !== 'object') return null;

  const toolUses = (raw as Record<string, unknown>).tool_uses;
  if (!Array.isArray(toolUses)) return null;

  for (const toolUse of toolUses) {
    if (!toolUse || typeof toolUse !== 'object') continue;

    const record = toolUse as Record<string, unknown>;
    const recipientName =
      typeof record.recipient_name === 'string' ? record.recipient_name.trim().toLowerCase() : '';
    if (!recipientName.includes('todowrite')) continue;

    const todos = extractTodos(record.parameters);
    if (todos) return todos;
  }

  return null;
}

function normalizeTodo(raw: unknown): Todo | null {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const content =
    typeof record.content === 'string'
      ? record.content.trim()
      : typeof record.title === 'string'
        ? record.title.trim()
        : '';

  if (!content) return null;

  const id =
    typeof record.id === 'string' || typeof record.id === 'number' ? String(record.id) : content;

  return {
    content,
    status: typeof record.status === 'string' ? record.status : 'pending',
    priority: typeof record.priority === 'string' ? record.priority : 'medium',
    id,
  };
}

function extractTodos(raw: unknown): Todo[] | null {
  if (Array.isArray(raw)) {
    return raw.map(normalizeTodo).filter((todo): todo is Todo => Boolean(todo));
  }

  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  for (const key of ['todos', 'items', 'plan']) {
    const todos = extractTodos(record[key]);
    if (todos) return todos;
  }

  return null;
}

function extractTodosFromPart(part: Part): Todo[] | null {
  if (part.type !== 'tool') return null;

  const toolName = part.tool.trim().toLowerCase();
  const toolState = part.state as Record<string, unknown>;

  if (toolName === 'parallel' || toolName.endsWith('.parallel')) {
    return (
      extractTodosFromParallelTool(toolState.input) ||
      extractTodosFromParallelTool(toolState.metadata)
    );
  }

  if (!toolName.includes('todo') && !TODO_TOOL_NAMES.has(toolName)) {
    return null;
  }

  return extractTodos(toolState.input) || extractTodos(toolState.metadata) || null;
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

function deriveTodosFromMessages(messages: Array<{ info: Message; parts: Part[] }>): Todo[] {
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].info.role === 'user') {
      lastUserMessageIndex = index;
      break;
    }
  }

  for (
    let messageIndex = messages.length - 1;
    messageIndex > lastUserMessageIndex;
    messageIndex -= 1
  ) {
    const parts = messages[messageIndex].parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const todos = extractTodosFromPart(parts[partIndex]);
      if (todos) return todos;
    }
  }

  return [];
}

function resetTodoSync() {
  todoStateAuthority = 'messages';
}

function applyTheme(nextTheme: WebviewThemeKind) {
  applyWebviewTheme(nextTheme);
}

function syncTodosFromMessages(messages = state.messages) {
  if (todoStateAuthority === 'event') return;
  setState('todos', deriveTodosFromMessages(messages));
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
    if (!loading || !sessionId || !isDocumentVisible()) return;

    let delay = 8000;
    const schedulePoll = () => {
      return setTimeout(() => {
        if (!isLoading() || !state.activeSessionId || !isDocumentVisible()) return;
        recheckSessionStatus(state.activeSessionId);
        delay = Math.min(delay * 2, 60_000);
        timer = schedulePoll();
      }, delay);
    };
    let timer = schedulePoll();

    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    if (state.serverStatus.state !== 'running' || !state.providersLoaded || !isDocumentVisible())
      return;

    const active = getActiveProviderSelection();
    if (!active) return;

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
  const selected = resolveSelectedModel(
    state.selectedModel,
    state.providers,
    state.providerDefaults
  );
  if (selected) {
    return { providerID: selected.providerID, modelID: selected.modelID };
  }

  const firstProvider = state.providers[0];
  if (!firstProvider) return null;

  const defaultModelID = state.providerDefaults[firstProvider.id];
  const fallbackModelID =
    (defaultModelID && firstProvider.models[defaultModelID] ? defaultModelID : null) ||
    Object.keys(firstProvider.models)[0];
  if (!fallbackModelID) return null;

  return { providerID: firstProvider.id, modelID: fallbackModelID };
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
  return document.visibilityState === 'visible';
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

async function initConnection() {
  const generation = ++connectionGeneration;
  try {
    await client.health();
    if (!isCurrentGeneration(generation, connectionGeneration)) return;
    await Promise.all([
      loadSessions(),
      loadAgents(),
      loadCommands(),
      loadProviders(),
      loadMcps(),
      loadQuestions(),
      loadRecycleBin(),
    ]);
    if (!isCurrentGeneration(generation, connectionGeneration)) return;
    await hydrateSessionStatuses();
    if (!isCurrentGeneration(generation, connectionGeneration)) return;
    if (!state.activeSessionId) {
      const lastId = getPersistedActiveSessionId();
      if (lastId && state.sessions.some((s) => s.id === lastId)) {
        await selectSession(lastId);
        if (!isCurrentGeneration(generation, connectionGeneration)) return;
      }
    }
    await recoverInterruptedSessions(generation);
    if (!isCurrentGeneration(generation, connectionGeneration)) return;
    initialized = true;
  } catch (_err) {
    initialized = false;
    setError('Failed to connect to OpenCode server');
  }
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
  const sessionIds = consumeInterruptedSessionIds().filter(
    (id, index, items) => items.indexOf(id) === index
  );
  if (sessionIds.length === 0) return;

  for (const sessionId of sessionIds) {
    if (!isCurrentGeneration(generation, connectionGeneration)) return;
    if (!state.sessions.some((session) => session.id === sessionId)) continue;

    const status = state.sessionStatus[sessionId];
    if (status?.type === 'busy' || status?.type === 'retry') continue;
    if (state.questions.some((item) => item.sessionID === sessionId)) continue;
    if (state.permissions.some((item) => item.sessionID === sessionId)) continue;

    try {
      const messages = await client.session.messages(sessionId);
      if (!isCurrentGeneration(generation, connectionGeneration)) return;
      if (!shouldContinueInterruptedSession(messages)) continue;
      await continueInterruptedSession(sessionId);
    } catch (err) {
      logError('recoverInterruptedSession', err);
    }
  }
}

function shouldContinueInterruptedSession(messages: Array<{ info: Message; parts: Part[] }>) {
  const lastInfo = messages.at(-1)?.info;
  if (!lastInfo) return false;
  if (lastInfo.role === 'user') return true;
  return !lastInfo.error && !lastInfo.time.completed;
}

async function continueInterruptedSession(sessionId: string) {
  await syncSessionMcps(sessionId);
  const model = resolveSelectedModel(
    getSelectedModelForSession(sessionId),
    state.providers,
    state.providerDefaults
  );
  const agent = getSelectedAgentForSession(sessionId) || getDefaultPrimaryAgentName();
  const body: {
    parts: Array<{ type: string; text: string }>;
    model?: { providerID: string; modelID: string };
    agent?: string;
    variant?: string;
  } = {
    parts: [{ type: 'text', text: INTERRUPTED_SESSION_CONTINUE_PROMPT }],
  };

  if (agent) {
    body.agent = agent;
  }

  if (model) {
    body.model = { providerID: model.providerID, modelID: model.modelID };
    if (model.variant) {
      body.variant = model.variant;
    }
  }

  await client.session.sendAsync(sessionId, body);
  await Promise.all([syncSession(sessionId), recheckSessionStatus(sessionId)]).catch(() => {});
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
    const agents = await client.agent.list();
    const visible = agents.filter((a) => !a.hidden);
    const primaries = visible.filter((a) => a.mode !== 'subagent');
    setState('allAgents', visible);
    setState('agents', primaries);
    const activeSessionId = state.activeSessionId;
    const activeAgent = state.selectedAgent;
    if (activeAgent && !primaries.some((agent) => agent.name === activeAgent)) {
      setSelectedAgent(null, { sessionId: activeSessionId, persistGlobal: !activeSessionId });
    }
    if (!activeSessionId) {
      const defaultAgent = getDefaultPrimaryAgentName();
      if (defaultAgent && state.selectedAgent !== defaultAgent) {
        setSelectedAgent(defaultAgent, { persistGlobal: false });
      }
      return;
    }
    if (!state.selectedAgent) {
      const sessionAgent = getSelectedAgentForSession(activeSessionId);
      const globalAgent = getPersistedSelectedAgent();
      const fallback = [sessionAgent, getDefaultPrimaryAgentName(), globalAgent].find(
        (candidate): candidate is string =>
          !!candidate && primaries.some((agent) => agent.name === candidate)
      );
      if (fallback) {
        setSelectedAgent(fallback, { sessionId: activeSessionId, persistGlobal: !activeSessionId });
      }
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
    const effectiveModel = resolveSelectedModel(
      state.selectedModel,
      res.providers,
      res.default || {}
    );
    if (state.selectedModel && !effectiveModel) {
      setSelectedModel(null);
    } else if (
      effectiveModel &&
      state.selectedModel &&
      state.selectedModel.variant &&
      !effectiveModel.variant
    ) {
      setSelectedModel({ providerID: effectiveModel.providerID, modelID: effectiveModel.modelID });
    }
    if (!state.selectedModel && res.providers.length > 0) {
      const firstProvider = res.providers[0];
      const defaultModelID = (res.default || {})[firstProvider.id];
      const modelID = defaultModelID || Object.keys(firstProvider.models)[0];
      if (modelID) {
        setSelectedModel({ providerID: firstProvider.id, modelID });
      }
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
  const generation = ++sessionSelectionGeneration;
  clearDraftCurrentDocumentState();
  resetToolCallExpansionState();
  setState('activeSessionId', id);
  persistActiveSessionId(id);
  if (options?.markSeen ?? true) {
    markSessionSeen(id);
  }
  const persistedAgent = getSelectedAgentForSession(id);
  if (persistedAgent) {
    setSelectedAgent(persistedAgent, { sessionId: id, persistGlobal: false });
  } else {
    const defaultAgent = getPersistedSelectedAgent() || getDefaultPrimaryAgentName();
    if (defaultAgent) {
      setSelectedAgent(defaultAgent, { sessionId: id, persistGlobal: false });
    }
  }
  const persistedModel = resolveSelectedModel(
    getSelectedModelForSession(id),
    state.providers,
    state.providerDefaults
  );
  if (persistedModel) {
    setSelectedModel(persistedModel, { sessionId: id, persistGlobal: false });
  }
  if (!getSelectedMcpsForSession(id)) {
    setSelectedMcpsForSession(
      id,
      Object.entries(state.mcpStatus)
        .filter(([, value]) => value?.status === 'connected')
        .map(([name]) => name)
    );
  }
  await syncSessionMcps(id);
  resetTodoSync();
  clearMessages();
  try {
    const [session, msgs] = await Promise.all([
      client.session.get(id),
      client.session.messages(id),
    ]);
    if (
      !isCurrentGeneration(generation, sessionSelectionGeneration) ||
      state.activeSessionId !== id
    )
      return;
    upsertSession(session);
    setMessagesIncremental(msgs);
    syncFailedSessionsFromMessages(msgs);
    requestMessageListScrollToBottom();
    const inferredAgent = !persistedAgent ? deriveSelectedAgentFromMessages(msgs) : null;
    if (inferredAgent) {
      setSelectedAgent(inferredAgent, { sessionId: id, persistGlobal: false });
    }
    const inferredModel = resolveSelectedModel(
      deriveSelectedModelFromMessages(msgs),
      state.providers,
      state.providerDefaults
    );
    if (inferredModel) {
      setSelectedModel(inferredModel, { sessionId: id, persistGlobal: false });
    }
    syncTodosFromMessages(msgs);
    await loadQuestions().catch((err) => logError('loadQuestions', err));
    if (
      !isCurrentGeneration(generation, sessionSelectionGeneration) ||
      state.activeSessionId !== id
    )
      return;
    const statuses = await client.session.status().catch((err) => {
      logError('session.status', err);
      return {} as Record<string, SessionStatus>;
    });
    if (
      !isCurrentGeneration(generation, sessionSelectionGeneration) ||
      state.activeSessionId !== id
    )
      return;
    setState('sessionStatus', (current) => ({ ...current, ...statuses }));
    updateUsageLimitState(id, statuses[id], msgs);
    const statusType = statuses[id]?.type;
    if (statusType === 'busy' || statusType === 'retry') {
      startLoading();
    } else {
      stopLoading();
    }
  } catch (_err) {
    setError('Failed to load messages');
  }
}

async function syncSessionMessages(sessionId: string) {
  const generation = ++sessionSyncGeneration;
  const msgs = await client.session.messages(sessionId);
  if (!isCurrentGeneration(generation, sessionSyncGeneration)) return;
  updateUsageLimitState(sessionId, state.sessionStatus[sessionId], msgs);
  if (sessionId === state.activeSessionId) {
    setMessagesIncremental(msgs);
    syncFailedSessionsFromMessages(msgs);
    resetTodoSync();
    syncTodosFromMessages(msgs);
  }
}

async function syncSession(sessionId: string) {
  const session = await client.session.get(sessionId);
  upsertSession(session);
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
      getBuildAgentName() || getPersistedSelectedAgent() || getDefaultPrimaryAgentName();
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
    const deletedIds = getDeletedSessionTreeIds(id);
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
    for (const session of entry?.sessions || []) {
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

  const effectiveModel = resolveSelectedModel(
    state.selectedModel,
    state.providers,
    state.providerDefaults
  );
  const includeClipboardImages = effectiveModel
    ? modelSupportsVision(effectiveModel.providerID, effectiveModel.modelID, state.providers)
    : true;
  const promptText = getPromptTextForClipboardImages(
    text,
    state.clipboardImages,
    includeClipboardImages
  );

  const parts: Array<{
    type: string;
    text?: string;
    mime?: string;
    filename?: string;
    url?: string;
  }> = [];
  if (promptText.trim()) parts.push({ type: 'text', text: promptText });

  const wp = state.editorContext.workspacePath;
  if (wp) {
    parts.push({ type: 'text', text: `[Working directory: ${wp}]` });
  }

  const sel = state.editorContext.selection;
  const af = state.editorContext.activeFile;
  const currentDocumentEnabled = getCurrentDocumentEnabled(sessionId);
  if (af && currentDocumentEnabled) {
    const activeFilePath = getAttachmentReference({ path: af.path, type: 'file' }, wp);
    const explicitContext = hasExplicitContextForPath(state.droppedFiles, af.path);
    const activeSelectionRanges = getSelectionRangesFromEditorContext(sel);
    const explicitSelectionRanges =
      explicitContext?.type === 'file' ? explicitContext.lineRanges : undefined;
    const uniqueActiveSelectionRanges = subtractContextLineRanges(
      activeSelectionRanges,
      explicitSelectionRanges
    );
    if (explicitContext) {
      if (uniqueActiveSelectionRanges.length > 0) {
        parts.push({
          type: 'text',
          text: formatSelectionReference(activeFilePath, uniqueActiveSelectionRanges),
        });
      }
      parts.push({
        type: 'text',
        text:
          explicitSelectionRanges && explicitSelectionRanges.length > 0
            ? formatSelectionReference(activeFilePath, explicitSelectionRanges)
            : activeFilePath,
      });
    } else {
      parts.push({
        type: 'text',
        text:
          uniqueActiveSelectionRanges.length > 0
            ? formatSelectionReference(activeFilePath, uniqueActiveSelectionRanges)
            : `[Active file: ${activeFilePath}]`,
      });
    }
  }

  const terminalSelection = state.terminalSelection;
  if (terminalSelection) {
    parts.push({
      type: 'text',
      text: `[Selection from terminal ${terminalSelection.terminalName}]\n\`\`\`text\n${terminalSelection.text}\n\`\`\``,
    });
  }

  for (const file of state.droppedFiles) {
    if (isSamePath(file.path, af?.path)) continue;
    const fileReference = getAttachmentReference(file, wp);
    parts.push({
      type: 'text',
      text: file.lineRanges?.length
        ? formatSelectionReference(fileReference, file.lineRanges)
        : fileReference,
    });
  }

  if (includeClipboardImages) {
    for (const image of state.clipboardImages) {
      parts.push({
        type: 'file',
        mime: image.mime,
        filename: image.filename,
        url: image.url,
      });
    }
  }

  if (parts.length === 0) return;

  requestMessageListScrollToBottom();
  startLoading();
  setError(null);

  const body: {
    parts: typeof parts;
    model?: { providerID: string; modelID: string };
    agent?: string;
    noReply?: boolean;
    variant?: string;
  } = { parts };
  if (state.selectedAgent) body.agent = state.selectedAgent;
  if (effectiveModel) {
    setSelectedModel(effectiveModel, { sessionId });
    body.model = {
      providerID: effectiveModel.providerID,
      modelID: effectiveModel.modelID,
    };
  }
  if (effectiveModel?.variant) {
    body.variant = effectiveModel.variant;
  } else if (body.model) {
    body.variant =
      getPreferredVariant(body.model.providerID, body.model.modelID, state.providers) || undefined;
  }
  if (options?.noReply) body.noReply = true;

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
  if (!sessionId || sessionId !== state.activeSessionId) return;

  const buildAgent = getBuildAgentName();
  if (!buildAgent) {
    setError('Build agent is unavailable');
    return;
  }

  clearSkippedPlanSession(sessionId);
  setSelectedAgent(buildAgent, { sessionId, persistGlobal: false });
  await sendMessage(prompt);
}

export async function openPlan(markdown: string, sessionId = state.activeSessionId) {
  if (!sessionId || sessionId !== state.activeSessionId) return;

  const content = markdown.trim();
  if (!content) {
    setError('Plan content is empty');
    return;
  }

  try {
    setError(null);
    await client.varro.openPlan(content);
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to open plan');
  }
}

function getAttachmentReference(
  file: { path: string; type: 'file' | 'directory' },
  workspacePath: string | null
) {
  const relativePath = getWorkspaceRelativePath(file.path, workspacePath) ?? file.path;
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (file.type === 'directory') {
    return normalizedPath === '.' ? './' : `${normalizedPath}/`;
  }
  return normalizedPath;
}

export async function abortSession() {
  if (!state.activeSessionId) return;
  const sessionId = state.activeSessionId;
  const sessionTreeIds = getSessionTreeIds(sessionId);
  if (getSelectedAgentForSession(sessionId) === 'plan') {
    skipPlanSession(sessionId);
  }
  const previousStatuses = new Map(
    sessionTreeIds.map((id) => [id, state.sessionStatus[id]] as const)
  );
  const previousUsageLimits = new Map(
    sessionTreeIds.map((id) => [id, state.sessionUsageLimits[id] || null] as const)
  );
  markPendingAbortTree(sessionTreeIds);
  for (const id of sessionTreeIds) {
    setSessionStatusEntry(id, { type: 'idle' });
  }
  stopLoading();
  try {
    await Promise.all(sessionTreeIds.map((id) => client.session.abort(id)));
  } catch (err) {
    clearPendingAbortTree(sessionTreeIds);
    for (const id of sessionTreeIds) {
      const previousStatus = previousStatuses.get(id);
      if (previousStatus) {
        setSessionStatusEntry(id, previousStatus);
      }
      setSessionUsageLimit(id, previousUsageLimits.get(id) || null);
    }
    logError('abortSession', err);
  }
}

export async function undoSession() {
  if (!state.activeSessionId) return;
  const lastAssistant = [...state.messages].toReversed().find((m) => m.info.role === 'assistant');
  if (!lastAssistant) return;
  try {
    startLoading();
    await client.session.revert(state.activeSessionId, lastAssistant.info.id);
    await Promise.all([
      syncSession(state.activeSessionId),
      syncSessionMessages(state.activeSessionId),
    ]);
    stopLoading();
  } catch (err) {
    stopLoading();
    setError(err instanceof Error ? err.message : 'Failed to undo');
  }
}

export async function redoSession() {
  if (!state.activeSessionId) return;
  try {
    startLoading();
    const session = await client.session.unrevert(state.activeSessionId);
    upsertSession(session);
    await Promise.all([
      syncSession(state.activeSessionId),
      syncSessionMessages(state.activeSessionId),
    ]);
    stopLoading();
  } catch (err) {
    stopLoading();
    setError(err instanceof Error ? err.message : 'Failed to redo');
  }
}

const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file containing:
1. Build, lint, and test commands - especially the command to run a single test.
2. Code style guidelines including imports, formatting, types, naming conventions, error handling, etc.

The file you create will be given to agentic coding agents (such as yourself) that operate in this repository. Make it about 20 lines long.
If there's already an AGENTS.md, improve it. If there are Cursor rules (in .cursor/rules/ or .cursorrules) or Copilot rules (in .github/copilot-instructions.md), include them.`;

export async function initSession() {
  let sessionId = state.activeSessionId;
  if (!sessionId) {
    const createdId = await createSession(undefined, getPermissionModeForSession(null));
    if (!createdId) return;
    sessionId = createdId;
  }

  if (sessionId === state.activeSessionId && state.messages.length > 0) {
    setError('Init is only available for blank sessions');
    return;
  }

  await sendMessage(INIT_PROMPT);
}

export async function runSlashCommandByName(name: string, args: string) {
  const command = state.commands.find((item) => item.name === name);
  if (!command) {
    setError(`Unknown command: /${name}`);
    return false;
  }

  let sessionId = state.activeSessionId;
  if (!sessionId) {
    const createdId = await createSession(undefined, getPermissionModeForSession(null));
    if (!createdId) return false;
    sessionId = createdId;
  }

  try {
    startLoading();
    const result = await client.session.command(sessionId, {
      command: name,
      arguments: args,
    });
    if (state.activeSessionId === sessionId) {
      upsertMessageInfo(result.info);
      for (const part of result.parts) {
        upsertPart(part);
      }
      syncTodosFromMessages();
      requestMessageListScrollToBottom();
    }
    await Promise.all([syncSession(sessionId), recheckSessionStatus(sessionId)]).catch(() => {});
    stopLoading();
    return true;
  } catch (err) {
    stopLoading();
    setError(err instanceof Error ? err.message : `Failed to run /${name}`);
    return false;
  }
}

export async function reviewSession() {
  if (!state.activeSessionId) return;
  await sendMessage('review the current changes in my code and provide feedback');
}

export async function compactSession() {
  if (!state.activeSessionId) return;
  const sessionId = state.activeSessionId;
  clearPendingAbort(sessionId);
  const effectiveModel = resolveSelectedModel(
    state.selectedModel,
    state.providers,
    state.providerDefaults
  );
  if (!effectiveModel) {
    setError('Select a model before compacting the session');
    return;
  }
  try {
    setSessionCompacting(sessionId, true);
    startLoading();
    await client.session.compact(sessionId, {
      providerID: effectiveModel.providerID,
      modelID: effectiveModel.modelID,
    });
    await Promise.all([syncSession(sessionId), syncSessionMessages(sessionId)]);
    const compacting = state.sessions.find((session) => session.id === sessionId)?.time.compacting;
    if (!compacting) setSessionCompacting(sessionId, false);
    stopLoading();
  } catch (err) {
    stopLoading();
    setSessionCompacting(sessionId, false);
    setError(err instanceof Error ? err.message : 'Failed to compact session');
  }
}

export async function respondPermission(
  sessionId: string,
  permissionId: string,
  response: 'once' | 'always' | 'reject',
  options?: { rethrow?: boolean }
) {
  try {
    const permission = state.permissions.find(
      (item) =>
        item.id === permissionId ||
        item.duplicateIDs?.includes(permissionId) ||
        item.groupMembers?.some((member) => member.id === permissionId)
    );
    const groupMembers = permission?.groupMembers?.length
      ? permission.groupMembers
      : [{ id: permissionId, sessionID: sessionId }];
    await Promise.all(
      groupMembers.map((member) =>
        client.session.respondPermission(member.sessionID, member.id, response)
      )
    );
    groupMembers.forEach((member) => removePermission(member.id));
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to respond to permission');
    if (options?.rethrow) {
      throw err;
    }
  }
}

export async function respondQuestion(requestID: string, answers: Array<Array<string>>) {
  try {
    await client.question.reply(requestID, answers);
    removeQuestion(requestID);
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to answer question');
  }
}

async function autoApprovePermissionsForSession(permissions: Permission[]) {
  await Promise.all(
    permissions.map((permission) =>
      respondPermission(permission.sessionID, permission.id, 'always').catch(() => {})
    )
  );
}

export async function updatePermissionModeForSession(
  mode: 'default' | 'full',
  sessionId = state.activeSessionId
) {
  const previousMode = getPermissionModeForSession(sessionId);
  const previousDraft = draftPermissionMode();
  setPermissionModeForSession(sessionId, mode);
  setDraftPermissionMode(mode);
  saveProjectPermissionMode(mode);
  if (!sessionId) return;

  try {
    const session = await client.session.update(sessionId, {
      permission: getSessionPermissionRulesForMode(mode, 'update'),
    });
    upsertSession(session);
  } catch (err) {
    setPermissionModeForSession(sessionId, previousMode);
    setDraftPermissionMode(previousDraft);
    saveProjectPermissionMode(previousDraft);
    setError(err instanceof Error ? err.message : 'Failed to update permissions');
    return;
  }

  if (mode !== 'full') return;
  await autoApprovePermissionsForSession(
    state.permissions.filter((permission) => permission.sessionID === sessionId)
  );
}

export async function rejectQuestion(requestID: string) {
  try {
    await client.question.reject(requestID);
    removeQuestion(requestID);
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to reject question');
  }
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
