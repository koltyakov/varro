import { onMount, onCleanup, createEffect } from 'solid-js';
import { client, serverEvents } from '../lib/client';
import {
  state,
  setState,
  setSelectedAgent,
  setSelectedModel,
  resolveSelectedModel,
  setTheme,
  isLoading,
  setIsLoading,
  setError,
  persistActiveSessionId,
  getPersistedActiveSessionId,
  clearClipboardImages,
  clearMessages,
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
} from '../lib/state';
import { onMessage, postMessage } from '../lib/bridge';
import type { ExtensionMessage } from '../../shared/protocol';
import type {
  Session,
  SessionStatus,
  Message,
  Part,
  Permission,
  QuestionRequest,
  Todo,
  FileDiff,
} from '../types';
import { getWorkspaceRelativePath } from '../lib/path-display';

let initialized = false;
let handlersRegistered = false;
let currentWorkspacePath: string | null = null;

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
    setState('activeSessionId', null);
    persistActiveSessionId(null);
    clearMessages();
    setIsLoading(false);
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

export function useOpenCode() {
  onMount(() => {
    if (!handlersRegistered) {
      handlersRegistered = true;
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
          } else if (msg.payload.state === 'error') {
            setError(msg.payload.message);
          }
          break;
        case 'theme/update':
          setTheme(msg.payload.theme);
          break;
        case 'context/update':
          {
            const nextWorkspacePath = normalizeProjectPath(msg.payload.workspacePath);
            const workspaceChanged = nextWorkspacePath !== currentWorkspacePath;
            currentWorkspacePath = nextWorkspacePath;
            setState('editorContext', msg.payload);
            if (workspaceChanged && initialized) {
              loadSessions().catch(() => {});
            }
          }
          break;
        case 'files/dropped':
          for (const file of msg.payload) {
            setState('droppedFiles', (prev) => {
              if (prev.find((f) => f.path === file.path)) return prev;
              return [...prev, file];
            });
          }
          break;
        case 'files/removed':
          removeContextFile(msg.payload.path);
          break;
        case 'command/new-session':
          createSession();
          break;
        case 'command/abort':
          abortSession();
          break;
        case 'command/share':
          shareSession();
          break;
      }
    });

    postMessage({ type: 'ready' });

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isLoading() && state.activeSessionId) {
        recheckSessionStatus(state.activeSessionId);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    onCleanup(() => {
      disposeBridge();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    });
  });

  // Periodic staleness recovery: when loading, poll server every 8s to detect missed idle events
  createEffect(() => {
    const loading = isLoading();
    const sessionId = state.activeSessionId;
    if (!loading || !sessionId) return;

    const timer = setInterval(() => {
      if (!isLoading() || !state.activeSessionId) return;
      recheckSessionStatus(state.activeSessionId);
    }, 8000);

    onCleanup(() => clearInterval(timer));
  });

  return { client };
}

export async function recheckSessionStatus(sessionId: string) {
  try {
    const statuses = await client.session.status();
    const status = statuses[sessionId];
    if (!status || status.type === 'idle') {
      setIsLoading(false);
      if (sessionId === state.activeSessionId) {
        await syncSessionMessages(sessionId).catch(() => {});
      }
    }
  } catch {}
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
  } catch {}
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
      const def = primaries.find((a) => a.name === 'build') || primaries[0];
      if (def) setSelectedAgent(def.name);
    }
  } catch {}
}

async function loadProviders() {
  try {
    const res = await client.config.providers();
    setState('providers', res.providers);
    setState('providerDefaults', res.default || {});
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
  } catch {}
}

async function loadSessions() {
  try {
    const sessions = await client.session.list();
    applySessions(sessions);
  } catch {}
}

export async function selectSession(id: string) {
  setState('activeSessionId', id);
  persistActiveSessionId(id);
  markSessionSeen(id);
  clearMessages();
  try {
    const [session, msgs] = await Promise.all([client.session.get(id), client.session.messages(id)]);
    upsertSession(session);
    setState('messages', msgs);
    await loadQuestions().catch(() => {});
    const statuses = await client.session
      .status()
      .catch(() => ({}) as Record<string, SessionStatus>);
    setState('sessionStatus', statuses);
    setIsLoading(statuses[id]?.type === 'busy');
  } catch (_err) {
    setError('Failed to load messages');
  }
}

async function syncSessionMessages(sessionId: string) {
  const msgs = await client.session.messages(sessionId);
  if (sessionId === state.activeSessionId) {
    setState('messages', msgs);
  }
}

async function syncSession(sessionId: string) {
  const session = await client.session.get(sessionId);
  upsertSession(session);
}

export async function createSession(title?: string): Promise<string | null> {
  try {
    const session = await client.session.create(title ? { title } : undefined);
    upsertSession(session);
    setState('activeSessionId', session.id);
    persistActiveSessionId(session.id);
    markSessionSeen(session.id);
    clearMessages();
    return session.id;
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to create session');
    return null;
  }
}

export async function deleteSession(id: string) {
  try {
    await client.session.delete(id);
    setState(
      'sessions',
      state.sessions.filter((s) => s.id !== id)
    );
    if (state.activeSessionId === id) {
      setState('activeSessionId', null);
      persistActiveSessionId(null);
      clearMessages();
      if (state.sessions.length > 0) {
        await selectSession(state.sessions[0].id);
      }
    }
  } catch {}
}

export async function sendMessage(text: string, options?: { noReply?: boolean }) {
  let sessionId = state.activeSessionId;
  if (!sessionId) {
    sessionId = await createSession();
    if (!sessionId) return;
  }

  const parts: Array<{
    type: string;
    text?: string;
    mime?: string;
    filename?: string;
    url?: string;
  }> = [];
  if (text.trim()) parts.push({ type: 'text', text });

  const wp = state.editorContext.workspacePath;
  if (wp) {
    parts.push({ type: 'text', text: `[Working directory: ${wp}]` });
  }

  const sel = state.editorContext.selection;
  const af = state.editorContext.activeFile;
  if (sel && af) {
    parts.push({
      type: 'text',
      text: `[Selection from ${af.relativePath} lines ${sel.startLine}-${sel.endLine}]\n\`\`\`${af.language}\n${sel.text}\n\`\`\``,
    });
  }

  for (const file of state.droppedFiles) {
    parts.push({ type: 'text', text: getAttachmentReference(file, wp) });
  }

  for (const image of state.clipboardImages) {
    parts.push({
      type: 'file',
      mime: image.mime,
      filename: image.filename,
      url: image.url,
    });
  }

  if (parts.length === 0) return;

  setIsLoading(true);
  setError(null);

  const body: {
    parts: typeof parts;
    model?: { providerID: string; modelID: string };
    agent?: string;
    noReply?: boolean;
    variant?: string;
  } = { parts };
  if (state.selectedAgent) body.agent = state.selectedAgent;
  const effectiveModel = resolveSelectedModel(
    state.selectedModel,
    state.providers,
    state.providerDefaults
  );
  if (effectiveModel) {
    body.model = {
      providerID: effectiveModel.providerID,
      modelID: effectiveModel.modelID,
    };
  }
  if (effectiveModel?.variant) {
    body.variant = effectiveModel.variant;
  } else if (body.model) {
    const provider = state.providers.find((p) => p.id === body.model!.providerID);
    const modelObj = provider?.models[body.model!.modelID];
    if (modelObj?.variants) {
      const realVariants = Object.keys(modelObj.variants).filter((v) => v !== 'none');
      if (realVariants.length > 0) body.variant = realVariants[0];
    }
  }
  if (options?.noReply) body.noReply = true;

  setState('droppedFiles', []);
  clearClipboardImages();
  postMessage({ type: 'files/clear' });

  try {
    await client.session.sendAsync(sessionId, body);
    await Promise.all([syncSession(sessionId), syncSessionMessages(sessionId)]).catch(() => {});
  } catch (err) {
    setIsLoading(false);
    const baseMessage = err instanceof Error ? err.message : 'Failed to send message';
    if (body.model) {
      setError(`Failed to send with ${body.model.providerID}/${body.model.modelID}: ${baseMessage}`);
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
    return `@${normalizedPath === '.' ? './' : `${normalizedPath}/`}`;
  }
  return `@${normalizedPath}`;
}

export async function abortSession() {
  if (!state.activeSessionId) return;
  try {
    await client.session.abort(state.activeSessionId);
    setIsLoading(false);
  } catch {}
}

export async function shareSession() {
  if (!state.activeSessionId) return;
  try {
    const session = await client.session.share(state.activeSessionId);
    setState(
      'sessions',
      state.sessions.map((s) => (s.id === session.id ? session : s))
    );
    if (session.share?.url) {
      await navigator.clipboard.writeText(session.share.url).catch(() => {});
    }
  } catch {}
}

export async function unshareSession() {
  if (!state.activeSessionId) return;
  try {
    const session = await client.session.unshare(state.activeSessionId);
    setState(
      'sessions',
      state.sessions.map((s) => (s.id === session.id ? session : s))
    );
  } catch {}
}

export async function respondPermission(
  sessionId: string,
  permissionId: string,
  response: string,
  remember?: boolean
) {
  try {
    await client.session.respondPermission(sessionId, permissionId, response, remember);
    removePermission(permissionId);
  } catch {}
}

export async function respondQuestion(requestID: string, answers: Array<Array<string>>) {
  try {
    await client.question.reply(requestID, answers);
    removeQuestion(requestID);
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to answer question');
  }
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
  serverEvents.on('session.created', (data) => {
    const info = getProps(data)?.info as Session | undefined;
    if (info) upsertSession(info);
  });

  serverEvents.on('session.updated', (data) => {
    const info = getProps(data)?.info as Session | undefined;
    if (info) upsertSession(info);
  });

  serverEvents.on('session.deleted', (data) => {
    const id = (getProps(data)?.info as { id: string } | undefined)?.id;
    if (id)
      setState(
        'sessions',
        state.sessions.filter((s) => s.id !== id)
      );
  });

  serverEvents.on('session.status', (data) => {
    const props = getProps(data);
    if (!props) return;
    const sessionID = props.sessionID as string;
    const status = props.status as SessionStatus;
    setState('sessionStatus', { ...state.sessionStatus, [sessionID]: status });
    if (sessionID === state.activeSessionId) {
      const statusType = (status as { type: string }).type;
      setIsLoading(statusType === 'busy' || statusType === 'retry');
    }
  });

  serverEvents.on('session.idle', (data) => {
    const sid = getProps(data)?.sessionID as string | undefined;
    if (!sid || sid === state.activeSessionId) setIsLoading(false);
    if (sid && sid === state.activeSessionId) {
      markSessionSeen(sid);
      syncSession(sid).catch(() => {});
      syncSessionMessages(sid).catch(() => {});
    }
  });

  serverEvents.on('message.updated', (data) => {
    const info = getProps(data)?.info as { sessionID?: string } | undefined;
    if (info?.sessionID === state.activeSessionId) upsertMessageInfo(info as Message);
  });

  serverEvents.on('message.part.updated', (data) => {
    const part = getProps(data)?.part as { sessionID?: string } | undefined;
    if (part?.sessionID === state.activeSessionId) upsertPart(part as Part);
  });

  serverEvents.on('message.part.delta', (data) => {
    const p = getProps(data);
    if (!p) return;
    if ((p.sessionID as string) === state.activeSessionId) {
      applyMessagePartDelta(
        p.messageID as string,
        p.partID as string,
        p.delta as string,
        p.sessionID as string,
        p.field as string
      );
    }
  });

  serverEvents.on('message.part.removed', (data) => {
    const p = getProps(data);
    if (p) removeMessagePart(p.sessionID as string, p.messageID as string, p.partID as string);
  });

  serverEvents.on('message.removed', (data) => {
    const p = getProps(data);
    if (!p) return;
    if ((p.sessionID as string) === state.activeSessionId) {
      setState(
        'messages',
        state.messages.filter((m) => m.info.id !== (p.messageID as string))
      );
    }
  });

  serverEvents.on('permission.updated', (data) => {
    const props = getProps(data);
    if (props) addPermission(props as Permission);
  });

  serverEvents.on('permission.replied', (data) => {
    const pid = getProps(data)?.permissionID as string | undefined;
    if (pid) removePermission(pid);
  });

  serverEvents.on('question.asked', (data) => {
    const props = getProps(data);
    if (props) upsertQuestion(props as QuestionRequest);
  });

  serverEvents.on('question.replied', (data) => {
    const requestID = getProps(data)?.requestID as string | undefined;
    if (requestID) removeQuestion(requestID);
  });

  serverEvents.on('question.rejected', (data) => {
    const requestID = getProps(data)?.requestID as string | undefined;
    if (requestID) removeQuestion(requestID);
  });

  serverEvents.on('todo.updated', (data) => {
    const p = getProps(data);
    if ((p?.sessionID as string) === state.activeSessionId) setState('todos', p!.todos as Todo[]);
  });

  serverEvents.on('session.diff', (data) => {
    const p = getProps(data);
    if ((p?.sessionID as string) === state.activeSessionId)
      setState('diffs', p!.diff as FileDiff[]);
  });
}
