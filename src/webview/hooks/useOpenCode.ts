import { onMount, onCleanup, createEffect } from 'solid-js';
import { client, serverEvents } from '../lib/client';
import {
  state,
  setState,
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
  persistActiveSessionId,
  getPersistedActiveSessionId,
  getPersistedSelectedModel,
  clearClipboardImages,
  clearMessages,
  clearStreamingState,
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
  markSessionSeen,
  setSessionCompacting,
  getSelectedModelForSession,
  clearSelectedModelForSession,
  getPermissionModeForSession,
  removePermissionModeForSession,
  resetDraftPermissionMode,
  setPermissionModeForSession,
  syncDraftPermissionForWorkspace,
  saveProjectPermissionMode,
  draftPermissionMode,
  setDraftPermissionMode,
} from '../lib/state';
import { onMessage, postMessage } from '../lib/bridge';
import type { ExtensionMessage, WebviewThemeKind } from '../../shared/protocol';

function logError(context: string, err: unknown) {
  postMessage({
    type: 'log',
    payload: { msg: context, error: err instanceof Error ? err.message : String(err), level: 'warn' },
  });
}

function getDefaultPrimaryAgentName() {
  return state.agents.find((agent) => agent.name === 'build')?.name || state.agents[0]?.name || null;
}

import type {
  Session,
  SessionStatus,
  Message,
  Part,
  Permission,
  PermissionRule,
  QuestionRequest,
  Todo,
  FileDiff,
} from '../types';
import { getWorkspaceRelativePath, isSamePath } from '../lib/path-display';
import {
  formatSelectionReference,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
  mergeContextFile,
  subtractContextLineRanges,
} from '../../shared/context-files';
import { applyWebviewTheme } from '../lib/theme';
import { getPreferredVariant } from '../lib/model-variants';
import { getPromptTextForClipboardImages } from '../lib/clipboard-images';
import { modelSupportsVision } from '../lib/model-capabilities';

let initialized = false;
let eventHandlerCleanups: (() => void)[] = [];
let currentWorkspacePath: string | null = null;
let todoStateAuthority: 'messages' | 'event' = 'messages';
const FULL_ACCESS_PERMISSION_NAMES = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'codesearch',
  'lsp',
  'doom_loop',
  'skill',
] as const;
const FULL_ACCESS_PERMISSION_RULES: PermissionRule[] = FULL_ACCESS_PERMISSION_NAMES.map(
  (permission) => ({
    permission,
    pattern: '*',
    action: 'allow',
  })
);
const READ_ONLY_PERMISSIONS = new Set(['read', 'glob', 'grep', 'list', 'codesearch', 'lsp']);
const DEFAULT_PERMISSION_RULES: PermissionRule[] = FULL_ACCESS_PERMISSION_NAMES.map(
  (permission) => ({
    permission,
    pattern: '*',
    action: READ_ONLY_PERMISSIONS.has(permission) ? 'allow' : 'ask',
  })
);

function shouldAutoApprovePermissions(sessionId: string) {
  return getPermissionModeForSession(sessionId) === 'full';
}

function getSessionPermissionRulesForMode(
  mode: 'default' | 'full',
  _target: 'create' | 'update'
): PermissionRule[] {
  if (mode === 'full') return FULL_ACCESS_PERMISSION_RULES;
  return DEFAULT_PERMISSION_RULES;
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
  return sessions.toSorted((a, b) => b.time.updated - a.time.updated);
}

function applySessions(sessions: Session[]) {
  const nextSessions = sortSessions(
    sessions.filter((session) => isSessionInWorkspace(session, currentWorkspacePath))
  );
  setState('sessions', nextSessions);

  if (
    state.activeSessionId &&
    !nextSessions.some((session) => session.id === state.activeSessionId)
  ) {
    clearActiveSessionState();
  }
}

function clearActiveSessionState() {
  resetTodoSync();
  setState('activeSessionId', null);
  persistActiveSessionId(null);
  clearMessages();
  stopLoading();
}

function clearDeletedSessionState(id: string) {
  removePermissionModeForSession(id);
  setState('sessionStatus', (statuses) => {
    const next = { ...statuses };
    delete next[id];
    return next;
  });
  setState('questions', (items) => items.filter((item) => item.sessionID !== id));
  setState('permissions', (items) => items.filter((item) => item.sessionID !== id));

  if (state.activeSessionId === id) {
    clearActiveSessionState();
  }
}

function upsertSession(session: Session) {
  if (!isSessionInWorkspace(session, currentWorkspacePath)) {
    if (state.sessions.some((item) => item.id === session.id)) {
      applySessions(state.sessions.filter((item) => item.id !== session.id));
    }
    return;
  }

  applySessions([session, ...state.sessions.filter((item) => item.id !== session.id)]);
}

const TODO_TOOL_NAMES = new Set(['todowrite', 'update_plan', 'updateplan']);

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
    typeof record.id === 'string' || typeof record.id === 'number'
      ? String(record.id)
      : content;

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
  if (!toolName.includes('todo') && !TODO_TOOL_NAMES.has(toolName)) {
    return null;
  }

  const toolState = part.state as Record<string, unknown>;
  return extractTodos(toolState.input) || extractTodos(toolState.metadata) || null;
}

function deriveTodosFromMessages(messages: Array<{ info: Message; parts: Part[] }>): Todo[] {
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].info.role === 'user') {
      lastUserMessageIndex = index;
      break;
    }
  }

  for (let messageIndex = messages.length - 1; messageIndex > lastUserMessageIndex; messageIndex -= 1) {
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

export function useOpenCode() {
  onMount(() => {
    applyTheme(theme());

    if (eventHandlerCleanups.length === 0) {
      registerEventHandlers();
    }

    const disposeBridge = onMessage((msg: ExtensionMessage) => {
      switch (msg.type) {
        case 'server/status':
          setState('serverStatus', msg.payload);
          if (msg.payload.state === 'running') {
            setError(null);
            if (!initialized) {
              initialized = true;
              initConnection();
            }
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
        case 'context/update':
          {
            const nextWorkspacePath = normalizeProjectPath(msg.payload.workspacePath);
            const workspaceChanged = nextWorkspacePath !== currentWorkspacePath;
            currentWorkspacePath = nextWorkspacePath;
            setState('editorContext', msg.payload);
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
          for (const file of msg.payload) {
            setState('droppedFiles', (prev) => {
              const index = prev.findIndex((f) => f.path === file.path);
              if (index === -1) return [...prev, file];
              return prev.map((item, itemIndex) =>
                itemIndex === index ? mergeContextFile(item, file) : item
              );
            });
          }
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
        case 'command/abort':
          abortSession();
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
    });
  });

  // Periodic staleness recovery: when loading, poll server every 8s to detect missed idle events
  createEffect(() => {
    const loading = isLoading();
    const sessionId = state.activeSessionId;
    if (!loading || !sessionId) return;

    let delay = 8000;
    const schedulePoll = () => {
      return setTimeout(() => {
        if (!isLoading() || !state.activeSessionId) return;
        recheckSessionStatus(state.activeSessionId);
        delay = Math.min(delay * 2, 60_000);
        timer = schedulePoll();
      }, delay);
    };
    let timer = schedulePoll();

    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    if (state.serverStatus.state !== 'running' || !state.providersLoaded) return;

    const active = getActiveProviderSelection();
    if (!active) return;

    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const limit = await client.config.providerLimit(active.providerID, active.modelID);
        if (!cancelled) {
          setState('providerLimits', active.providerID, limit);
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
  const selected = resolveSelectedModel(state.selectedModel, state.providers, state.providerDefaults);
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

export async function recheckSessionStatus(sessionId: string) {
  try {
    const statuses = await client.session.status();
    const status = statuses[sessionId];
    if (!status || status.type === 'idle') {
      stopLoading();
      if (sessionId === state.activeSessionId) {
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
  try {
    await client.health();
    await Promise.all([loadSessions(), loadAgents(), loadProviders(), loadQuestions()]);
    if (!state.activeSessionId) {
      const lastId = getPersistedActiveSessionId();
      if (lastId && state.sessions.some((s) => s.id === lastId)) {
        await selectSession(lastId);
      }
    }
  } catch (_err) {
    setError('Failed to connect to OpenCode server');
  }
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
    if (state.selectedAgent && !primaries.some((agent) => agent.name === state.selectedAgent)) {
      setSelectedAgent(null);
    }
    if (!state.selectedAgent) {
      const def = getDefaultPrimaryAgentName();
      if (def) setSelectedAgent(def);
    }
  } catch (err) {
    logError('loadAgents', err);
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

async function loadSessions() {
  try {
    const sessions = await client.session.list();
    applySessions(sessions);
  } catch (err) {
    logError('loadSessions', err);
  }
}

export async function selectSession(id: string) {
  setState('activeSessionId', id);
  persistActiveSessionId(id);
  markSessionSeen(id);
  const persistedModel = resolveSelectedModel(
    getSelectedModelForSession(id),
    state.providers,
    state.providerDefaults
  );
  if (persistedModel) {
    setSelectedModel(persistedModel, { sessionId: id, persistGlobal: false });
  }
  resetTodoSync();
  clearMessages();
  try {
    const [session, msgs] = await Promise.all([
      client.session.get(id),
      client.session.messages(id),
    ]);
    if (state.activeSessionId !== id) return;
    upsertSession(session);
    setMessagesIncremental(msgs);
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
    if (state.activeSessionId !== id) return;
    const statuses = await client.session
      .status()
      .catch((err) => { logError('session.status', err); return {} as Record<string, SessionStatus>; });
    if (state.activeSessionId !== id) return;
    setState('sessionStatus', statuses);
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
  const msgs = await client.session.messages(sessionId);
  if (sessionId === state.activeSessionId) {
    setMessagesIncremental(msgs);
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
    const session = await client.session.create({
      ...(title ? { title } : {}),
      permission: getSessionPermissionRulesForMode(initialPermissionMode, 'create'),
    });
    upsertSession(session);
    setState('activeSessionId', session.id);
    setState('sessionStatus', { ...state.sessionStatus, [session.id]: { type: 'idle' } });
    persistActiveSessionId(session.id);
    markSessionSeen(session.id);
    const defaultModel = getPersistedSelectedModel();
    if (defaultModel) {
      setSelectedModel(defaultModel, { sessionId: session.id, persistGlobal: false });
    }
    setSelectedAgent(getDefaultPrimaryAgentName());
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
    const wasActive = state.activeSessionId === id;
    const nextActiveId = wasActive
      ? state.sessions.filter((s) => s.id !== id)[0]?.id
      : null;
    await client.session.delete(id);
    setState(
      'sessions',
      state.sessions.filter((s) => s.id !== id)
    );
    clearSelectedModelForSession(id);
    clearDeletedSessionState(id);
    if (nextActiveId) {
      await selectSession(nextActiveId);
    }
  } catch (err) {
    logError('deleteSession', err);
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
  if (af) {
    const activeFilePath = getAttachmentReference({ path: af.path, type: 'file' }, wp);
    const explicitContext = hasExplicitContextForPath(state.droppedFiles, af.path);
    const activeSelectionRanges = getSelectionRangesFromEditorContext(sel);
    const explicitSelectionRanges = explicitContext?.type === 'file' ? explicitContext.lineRanges : undefined;
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
      text: file.lineRanges?.length ? formatSelectionReference(fileReference, file.lineRanges) : fileReference,
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
    body.variant = getPreferredVariant(body.model.providerID, body.model.modelID, state.providers) || undefined;
  }
  if (options?.noReply) body.noReply = true;

  resetTodoSync();
  setState('todos', []);

  setState('droppedFiles', []);
  clearClipboardImages();
  postMessage({ type: 'files/clear' });

  try {
    await client.session.sendAsync(sessionId, body);
    await Promise.all([syncSession(sessionId), syncSessionMessages(sessionId)]).catch(() => {});
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
  try {
    await client.session.abort(state.activeSessionId);
    stopLoading();
  } catch (err) {
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

export async function reviewSession() {
  if (!state.activeSessionId) return;
  await sendMessage('review the current changes in my code and provide feedback');
}

export async function compactSession() {
  if (!state.activeSessionId) return;
  const sessionId = state.activeSessionId;
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
  response: 'once' | 'always' | 'reject'
) {
  try {
    await client.session.respondPermission(sessionId, permissionId, response);
    removePermission(permissionId);
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to respond to permission');
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

type EventData = { properties?: Record<string, unknown> };

function getProps(data: unknown): Record<string, unknown> | undefined {
  return (data as EventData).properties;
}

function registerEventHandlers() {
  eventHandlerCleanups.push(
    serverEvents.on('session.created', (data) => {
      const info = getProps(data)?.info as Session | undefined;
      if (info) upsertSession(info);
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('session.updated', (data) => {
      const info = getProps(data)?.info as Session | undefined;
      if (info) {
        if (!info.time.compacting) setSessionCompacting(info.id, false);
        upsertSession(info);
      }
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('session.deleted', (data) => {
      const id = (getProps(data)?.info as { id: string } | undefined)?.id;
      if (id) {
        setState(
          'sessions',
          state.sessions.filter((s) => s.id !== id)
        );
        clearDeletedSessionState(id);
      }
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('session.status', (data) => {
      const props = getProps(data);
      if (!props) return;
      const sessionID = props.sessionID as string;
      const status = props.status as SessionStatus;
      setState('sessionStatus', { ...state.sessionStatus, [sessionID]: status });
      if (sessionID === state.activeSessionId) {
        const statusType = (status as { type: string }).type;
        if (statusType === 'busy' || statusType === 'retry') {
          startLoading();
        } else {
          stopLoading();
        }
      }
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('session.idle', (data) => {
      const sid = getProps(data)?.sessionID as string | undefined;
      if (sid) setSessionCompacting(sid, false);
      if (!sid || sid === state.activeSessionId) stopLoading();
      if (sid && sid === state.activeSessionId) {
        markSessionSeen(sid);
        syncSession(sid).catch(() => {});
        syncSessionMessages(sid).catch(() => {});
      }
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('message.updated', (data) => {
      const info = getProps(data)?.info as { sessionID?: string } | undefined;
      if (info?.sessionID === state.activeSessionId) {
        markLoadingActivity();
        upsertMessageInfo(info as Message);
      }
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('message.part.updated', (data) => {
      const part = getProps(data)?.part as { sessionID?: string } | undefined;
      if (part?.sessionID && (part as Part).type === 'compaction') {
        setSessionCompacting(part.sessionID, false);
      }
      if (part?.sessionID === state.activeSessionId) {
        markLoadingActivity();
        upsertPart(part as Part);
        if ((part as Part).type === 'tool') {
          syncTodosFromMessages();
        }
      }
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('message.part.delta', (data) => {
      const p = getProps(data);
      if (!p) return;
      if ((p.sessionID as string) === state.activeSessionId) {
        markLoadingActivity();
        applyMessagePartDelta(
          p.messageID as string,
          p.partID as string,
          p.delta as string,
          p.sessionID as string,
          p.field as string
        );
      }
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('message.part.removed', (data) => {
      const p = getProps(data);
      if (p) {
        if ((p.sessionID as string) === state.activeSessionId) {
          markLoadingActivity();
        }
        removeMessagePart(p.sessionID as string, p.messageID as string, p.partID as string);
        if ((p.sessionID as string) === state.activeSessionId) {
          syncTodosFromMessages();
        }
      }
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('message.removed', (data) => {
      const p = getProps(data);
      if (!p) return;
      if ((p.sessionID as string) === state.activeSessionId) {
        markLoadingActivity();
        clearStreamingState();
        const nextMessages = state.messages.filter((m) => m.info.id !== (p.messageID as string));
        setState('messages', nextMessages);
        syncTodosFromMessages(nextMessages);
      }
    })
  );

  function handlePermissionEvent(props: Record<string, unknown>) {
    let permission: Permission;
    if ('title' in props && 'time' in props) {
      permission = props as Permission;
    } else {
      const tool = props.tool as { messageID?: string; callID?: string } | undefined;
      permission = {
        id: props.id as string,
        type: (props.permission as string) || '',
        pattern: props.patterns as string[] | undefined,
        sessionID: props.sessionID as string,
        messageID: tool?.messageID || '',
        callID: tool?.callID,
        title: [props.permission, Array.isArray(props.patterns) ? props.patterns.join(', ') : '']
          .filter(Boolean)
          .join(' '),
        metadata: (props.metadata as { [key: string]: unknown }) || {},
        time: { created: Date.now() / 1000 },
      };
    }
    if (shouldAutoApprovePermissions(permission.sessionID)) {
      void respondPermission(permission.sessionID, permission.id, 'always');
      return;
    }
    addPermission(permission);
  }

  eventHandlerCleanups.push(
    serverEvents.on('permission.updated', (data) => {
      const props = getProps(data);
      if (props) handlePermissionEvent(props);
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('permission.asked', (data) => {
      const props = getProps(data);
      if (props) handlePermissionEvent(props);
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('permission.replied', (data) => {
      const props = getProps(data);
      if (!props) return;
      const pid = (props.permissionID || props.requestID) as string | undefined;
      if (pid) removePermission(pid);
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('question.asked', (data) => {
      const props = getProps(data);
      if (props) upsertQuestion(props as QuestionRequest);
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('question.replied', (data) => {
      const requestID = getProps(data)?.requestID as string | undefined;
      if (requestID) removeQuestion(requestID);
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('question.rejected', (data) => {
      const requestID = getProps(data)?.requestID as string | undefined;
      if (requestID) removeQuestion(requestID);
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('todo.updated', (data) => {
      const p = getProps(data);
      if ((p?.sessionID as string) === state.activeSessionId) {
        todoStateAuthority = 'event';
        setState('todos', extractTodos(p?.todos) || []);
      }
    })
  );

  eventHandlerCleanups.push(
    serverEvents.on('session.diff', (data) => {
      const p = getProps(data);
      if ((p?.sessionID as string) === state.activeSessionId)
        setState('diffs', p!.diff as FileDiff[]);
    })
  );
}
