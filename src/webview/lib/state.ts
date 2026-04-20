import { createMemo, createSignal } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import type {
  Session,
  Message,
  Part,
  Permission,
  QuestionRequest,
  Todo,
  SessionStatus,
  FileDiff,
  Agent,
  Provider,
  AssistantMessage,
} from '../types';
import type {
  EditorContext,
  DroppedFile,
  InitialWebviewState,
  PermissionMode,
  ServerStatus,
} from '../../shared/protocol';

const STORAGE_KEYS = {
  selectedAgent: 'varro.selectedAgent',
  selectedModel: 'varro.selectedModel',
  draftPermissionMode: 'varro.draftPermissionMode',
  sessionPermissionModes: 'varro.sessionPermissionModes',
  projectPermissionModes: 'varro.projectPermissionModes',
  hiddenProviders: 'varro.hiddenProviders',
  hiddenModels: 'varro.hiddenModels',
  lastSeenSessions: 'varro.lastSeenSessions',
  lastActiveSessionId: 'varro.lastActiveSessionId',
} as const;

export type SelectedModel = { providerID: string; modelID: string; variant?: string };

function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

interface AppState {
  serverStatus: ServerStatus;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
  sessions: Session[];
  activeSessionId: string | null;
  sessionStatus: Record<string, SessionStatus>;
  messages: Array<{ info: Message; parts: Part[] }>;
  todos: Todo[];
  permissions: Permission[];
  questions: QuestionRequest[];
  diffs: FileDiff[];
  streamingPartId: string | null;
  streamingText: string;
  agents: Agent[];
  allAgents: Agent[];
  providers: Provider[];
  providerDefaults: Record<string, string>;
  sessionPermissionModes: Record<string, PermissionMode>;
  selectedAgent: string | null;
  selectedModel: SelectedModel | null;
  hiddenProviders: string[];
  hiddenModels: string[];
  lastSeenSessions: Record<string, number>;
  compactingSessionIds: string[];
  queuedMessages: QueuedMessage[];
}

export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
}

export interface ClipboardImage {
  id: string;
  url: string;
  mime: string;
  filename: string;
  size: number;
}

export const MAX_CLIPBOARD_IMAGES = 5;
const MAX_CLIPBOARD_IMAGE_SIZE = 5 * 1024 * 1024;

const defaultEditorContext: EditorContext = {
  workspacePath: null,
  activeFile: null,
  selection: null,
  diagnostics: [],
};

const initialWebviewState = readInitialWebviewState();

export const [state, setState] = createStore<AppState>({
  serverStatus: initialWebviewState.serverStatus ?? { state: 'stopped' },
  editorContext: initialWebviewState.editorContext ?? defaultEditorContext,
  terminalSelection: initialWebviewState.terminalSelection ?? null,
  droppedFiles: initialWebviewState.droppedFiles ?? [],
  clipboardImages: [],
  sessions: [],
  activeSessionId: null,
  sessionStatus: {},
  messages: [],
  todos: [],
  permissions: [],
  questions: [],
  diffs: [],
  streamingPartId: null,
  streamingText: '',
  agents: [],
  allAgents: [],
  providers: [],
  providerDefaults: {},
  sessionPermissionModes:
    readStored<Record<string, PermissionMode>>(STORAGE_KEYS.sessionPermissionModes) || {},
  selectedAgent: readStored<string>(STORAGE_KEYS.selectedAgent),
  selectedModel: readStored<SelectedModel>(STORAGE_KEYS.selectedModel),
  hiddenProviders: readStored<string[]>(STORAGE_KEYS.hiddenProviders) || [],
  hiddenModels: readStored<string[]>(STORAGE_KEYS.hiddenModels) || [],
  lastSeenSessions: readStored<Record<string, number>>(STORAGE_KEYS.lastSeenSessions) || {},
  compactingSessionIds: [],
  queuedMessages: [],
});

export function enqueueMessage(message: QueuedMessage) {
  setState(
    'queuedMessages',
    produce((items) => {
      items.push(message);
    })
  );
}

export function removeQueuedMessage(id: string) {
  setState(
    'queuedMessages',
    produce((items) => {
      const idx = items.findIndex((item) => item.id === id);
      if (idx !== -1) items.splice(idx, 1);
    })
  );
}

export function clearQueuedMessagesForSession(sessionId: string) {
  setState('queuedMessages', (items) => items.filter((item) => item.sessionId !== sessionId));
}

export function persistActiveSessionId(id: string | null) {
  writeStored(STORAGE_KEYS.lastActiveSessionId, id);
}

export function getPersistedActiveSessionId(): string | null {
  return readStored<string>(STORAGE_KEYS.lastActiveSessionId);
}

export function markSessionSeen(id: string) {
  const next = { ...state.lastSeenSessions, [id]: Date.now() };
  setState('lastSeenSessions', next);
  writeStored(STORAGE_KEYS.lastSeenSessions, next);
}

export function isSessionUnread(sessionId: string, updatedAt: number) {
  if (sessionId === state.activeSessionId) return false;
  const seen = state.lastSeenSessions[sessionId] ?? 0;
  return updatedAt > seen;
}

export function setSessionCompacting(sessionId: string, compacting: boolean) {
  setState(
    'compactingSessionIds',
    produce((ids) => {
      const idx = ids.indexOf(sessionId);
      if (compacting) {
        if (idx === -1) ids.push(sessionId);
        return;
      }
      if (idx !== -1) ids.splice(idx, 1);
    })
  );
}

export const isSessionCompacting = createMemo(() => {
  const sid = state.activeSessionId;
  if (!sid) return false;
  if (state.compactingSessionIds.includes(sid)) return true;
  return !!state.sessions.find((session) => session.id === sid)?.time.compacting;
});

export const [showThinking, setShowThinking] = createSignal(readShowThinking());

export function toggleThinking() {
  const next = !showThinking();
  setShowThinking(next);
  try {
    window.localStorage.setItem('varro.showThinking', JSON.stringify(next));
  } catch {}
}

function readShowThinking(): boolean {
  try {
    const raw = window.localStorage.getItem('varro.showThinking');
    return raw ? JSON.parse(raw) : true;
  } catch {
    return true;
  }
}

export const [inputText, setInputText] = createSignal('');
export const [nextPastedImageIndex, setNextPastedImageIndex] = createSignal(1);
export const [isLoading, setIsLoading] = createSignal(false);
export const [loadingStartedAt, setLoadingStartedAt] = createSignal<number | null>(null);
export const [loadingLastActivityAt, setLoadingLastActivityAt] = createSignal<number | null>(
  null
);

export function startLoading(now = Date.now()) {
  if (!isLoading()) {
    setLoadingStartedAt(now);
  } else if (loadingStartedAt() === null) {
    setLoadingStartedAt(now);
  }
  setLoadingLastActivityAt(now);
  setIsLoading(true);
}

export function stopLoading() {
  setIsLoading(false);
  setLoadingStartedAt(null);
  setLoadingLastActivityAt(null);
}

export function markLoadingActivity(now = Date.now()) {
  if (!isLoading()) return;
  if (loadingStartedAt() === null) {
    setLoadingStartedAt(now);
  }
  setLoadingLastActivityAt(now);
}

export const hasActiveQuestion = createMemo(() => {
  const sid = state.activeSessionId;
  return sid ? state.questions.some((q) => q.sessionID === sid) : false;
});

export const hasActivePermission = createMemo(() => {
  const sid = state.activeSessionId;
  return sid ? state.permissions.some((p) => p.sessionID === sid) : false;
});
export const [error, setError] = createSignal<string | null>(null);
export const [showSessionPicker, setShowSessionPicker] = createSignal(false);
export const [showModelPicker, setShowModelPicker] = createSignal(false);
export const [showSettings, setShowSettings] = createSignal(false);
export const [composerFocusKey, setComposerFocusKey] = createSignal(0);
export const [messageListScrollRequestKey, setMessageListScrollRequestKey] = createSignal(0);
let permissionWorkspace: string | null =
  initialWebviewState.editorContext?.workspacePath ?? null;

function resolveInitialDraftMode(): PermissionMode {
  if (permissionWorkspace) {
    const modes =
      readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
    if (modes[permissionWorkspace]) return modes[permissionWorkspace];
  }
  return readStored<PermissionMode>(STORAGE_KEYS.draftPermissionMode) || 'default';
}

export const [draftPermissionMode, setDraftPermissionMode] = createSignal<PermissionMode>(
  resolveInitialDraftMode()
);
export const [theme, setTheme] = createSignal<'dark' | 'light'>(
  initialWebviewState.theme ||
    ((window as unknown as Record<string, string>).__initialTheme as 'dark' | 'light') ||
    'dark'
);

export function requestComposerFocus() {
  setComposerFocusKey((value) => value + 1);
}

export function requestMessageListScrollToBottom() {
  setMessageListScrollRequestKey((value) => value + 1);
}

export function getPermissionModeForSession(sessionId: string | null | undefined): PermissionMode {
  if (!sessionId) return draftPermissionMode();
  return state.sessionPermissionModes[sessionId] || 'default';
}

export function setPermissionModeForSession(
  sessionId: string | null | undefined,
  mode: PermissionMode
) {
  if (!sessionId) {
    setDraftPermissionMode(mode);
    saveProjectPermissionMode(mode);
    writeStored(STORAGE_KEYS.draftPermissionMode, mode === 'default' ? null : mode);
    return;
  }

  const nextModes = { ...state.sessionPermissionModes, [sessionId]: mode };

  setState('sessionPermissionModes', nextModes);
  writeStored(STORAGE_KEYS.sessionPermissionModes, nextModes);
}

export function removePermissionModeForSession(sessionId: string) {
  if (!state.sessionPermissionModes[sessionId]) return;
  const nextModes = Object.fromEntries(
    Object.entries(state.sessionPermissionModes).filter(([id]) => id !== sessionId)
  );
  setState('sessionPermissionModes', nextModes);
  writeStored(STORAGE_KEYS.sessionPermissionModes, nextModes);
}

export function resetDraftPermissionMode() {
  const modes =
    readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
  const projectMode = permissionWorkspace && modes[permissionWorkspace];
  setDraftPermissionMode(projectMode || 'default');
  writeStored(STORAGE_KEYS.draftPermissionMode, null);
}

export function syncDraftPermissionForWorkspace(workspacePath: string | null) {
  permissionWorkspace = workspacePath;
  const modes =
    readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
  const mode = workspacePath && modes[workspacePath] ? modes[workspacePath] : 'default';
  setDraftPermissionMode(mode);
}

export function saveProjectPermissionMode(mode: PermissionMode) {
  if (!permissionWorkspace) return;
  const modes =
    readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
  if (mode === 'default') {
    delete modes[permissionWorkspace];
  } else {
    modes[permissionWorkspace] = mode;
  }
  writeStored(STORAGE_KEYS.projectPermissionModes, modes);
}

export function addContextFile(file: DroppedFile) {
  setState(
    'droppedFiles',
    produce((files) => {
      if (!files.find((f) => f.path === file.path)) {
        files.push(file);
      }
    })
  );
}

export function removeContextFile(path: string) {
  setState(
    'droppedFiles',
    produce((files) => {
      const idx = files.findIndex((f) => f.path === path);
      if (idx !== -1) files.splice(idx, 1);
    })
  );
}

export function clearContextFiles() {
  setState('droppedFiles', []);
}

export function addClipboardImage(image: ClipboardImage) {
  if (image.size > MAX_CLIPBOARD_IMAGE_SIZE) return;
  setState(
    'clipboardImages',
    produce((images) => {
      if (images.length >= MAX_CLIPBOARD_IMAGES) images.shift();
      if (!images.find((item) => item.id === image.id)) {
        images.push(image);
      }
    })
  );
}

export function removeClipboardImage(id: string) {
  const image = state.clipboardImages.find((item) => item.id === id);
  setState(
    'clipboardImages',
    produce((images) => {
      const idx = images.findIndex((item) => item.id === id);
      if (idx !== -1) images.splice(idx, 1);
    })
  );
  if (image) replaceClipboardImagePlaceholder(image.filename);
}

export function clearClipboardImages() {
  for (const image of state.clipboardImages) {
    replaceClipboardImagePlaceholder(image.filename);
  }
  setState('clipboardImages', []);
  if (inputText().trim().length === 0) setNextPastedImageIndex(1);
}

function replaceClipboardImagePlaceholder(filename: string) {
  const placeholder = `[${filename}]`;
  const text = inputText();
  const index = text.indexOf(placeholder);
  if (index === -1) return;
  setInputText(`${text.slice(0, index)}_____${text.slice(index + placeholder.length)}`);
}

export function resetPastedImageIndex() {
  setNextPastedImageIndex(1);
}

export function setQuestions(questions: QuestionRequest[]) {
  setState('questions', questions);
}

export function upsertQuestion(question: QuestionRequest) {
  setState(
    'questions',
    produce((questions) => {
      const idx = questions.findIndex((item) => item.id === question.id);
      if (idx !== -1) questions[idx] = question;
      else questions.push(question);
    })
  );
}

export function removeQuestion(requestID: string) {
  setState(
    'questions',
    produce((questions) => {
      const idx = questions.findIndex((item) => item.id === requestID);
      if (idx !== -1) questions.splice(idx, 1);
    })
  );
}

export function setSelectedAgent(agent: string | null) {
  setState('selectedAgent', agent);
  writeStored(STORAGE_KEYS.selectedAgent, agent);
}

export function setSelectedModel(model: SelectedModel | null) {
  setState('selectedModel', model);
  writeStored(STORAGE_KEYS.selectedModel, model);
}

export function modelVisibilityKey(providerID: string, modelID: string) {
  return `${providerID}:${modelID}`;
}

export function isProviderVisible(providerID: string) {
  return !state.hiddenProviders.includes(providerID);
}

function readInitialWebviewState(): Partial<InitialWebviewState> {
  const value = (window as unknown as { __initialWebviewState?: InitialWebviewState })
    .__initialWebviewState;
  return value && typeof value === 'object' ? value : {};
}

export function isModelVisible(providerID: string, modelID: string) {
  return (
    isProviderVisible(providerID) &&
    !state.hiddenModels.includes(modelVisibilityKey(providerID, modelID))
  );
}

export function getVisibleProviders(providers: Provider[]) {
  return providers
    .filter((provider) => isProviderVisible(provider.id))
    .map((provider) => ({
      ...provider,
      models: Object.fromEntries(
        Object.entries(provider.models).filter(([modelID]) => isModelVisible(provider.id, modelID))
      ),
    }))
    .filter((provider) => Object.keys(provider.models).length > 0);
}

export function setProviderVisible(providerID: string, visible: boolean) {
  const next = visible
    ? state.hiddenProviders.filter((item) => item !== providerID)
    : [...state.hiddenProviders.filter((item) => item !== providerID), providerID];

  setState('hiddenProviders', next);
  writeStored(STORAGE_KEYS.hiddenProviders, next);

  if (!visible && state.selectedModel?.providerID === providerID) {
    setSelectedModel(null);
  }
}

export function setModelVisible(providerID: string, modelID: string, visible: boolean) {
  const key = modelVisibilityKey(providerID, modelID);
  const next = visible
    ? state.hiddenModels.filter((item) => item !== key)
    : [...state.hiddenModels.filter((item) => item !== key), key];

  setState('hiddenModels', next);
  writeStored(STORAGE_KEYS.hiddenModels, next);

  if (visible && !isProviderVisible(providerID)) {
    const nextProviders = state.hiddenProviders.filter((item) => item !== providerID);
    setState('hiddenProviders', nextProviders);
    writeStored(STORAGE_KEYS.hiddenProviders, nextProviders);

    const provider = state.providers.find((p) => p.id === providerID);
    if (provider) {
      const otherKeys = Object.keys(provider.models)
        .filter((id) => id !== modelID)
        .map((id) => modelVisibilityKey(providerID, id));
      const nextHidden = [...next, ...otherKeys.filter((k) => !next.includes(k))];
      setState('hiddenModels', nextHidden);
      writeStored(STORAGE_KEYS.hiddenModels, nextHidden);
    }
  }

  if (
    !visible &&
    state.selectedModel?.providerID === providerID &&
    state.selectedModel.modelID === modelID
  ) {
    setSelectedModel(null);
  }
}

export function resetModelVisibility() {
  setState('hiddenProviders', []);
  setState('hiddenModels', []);
  writeStored(STORAGE_KEYS.hiddenProviders, []);
  writeStored(STORAGE_KEYS.hiddenModels, []);
}

export function resolveSelectedModel(
  selectedModel: SelectedModel | null,
  providers: Provider[],
  _providerDefaults: Record<string, string>
): SelectedModel | null {
  const candidate = selectedModel;
  if (!candidate) return null;

  const provider = providers.find((item) => item.id === candidate.providerID);
  const model = provider?.models[candidate.modelID];
  if (!provider || !model) return null;
  if (!isModelVisible(candidate.providerID, candidate.modelID)) return null;
  if (candidate.variant && !model.variants?.[candidate.variant]) {
    return { providerID: candidate.providerID, modelID: candidate.modelID };
  }
  return candidate;
}

let messageIndexVersion = 0;
let indexedVersion = -1;
let messageById: Map<string, number> = new Map();
let partById: Map<string, { msgIdx: number; partIdx: number }> = new Map();

function ensureIndex(msgs: Array<{ info: Message; parts: Part[] }>) {
  if (indexedVersion === messageIndexVersion) return;
  messageById = new Map();
  partById = new Map();
  for (let i = 0; i < msgs.length; i++) {
    messageById.set(msgs[i].info.id, i);
    for (let j = 0; j < msgs[i].parts.length; j++) {
      partById.set(msgs[i].parts[j].id, { msgIdx: i, partIdx: j });
    }
  }
  indexedVersion = messageIndexVersion;
}

function invalidateIndex() {
  messageIndexVersion++;
}

function findMessageIndex(msgs: Array<{ info: Message; parts: Part[] }>, id: string): number {
  ensureIndex(msgs);
  const idx = messageById.get(id);
  if (idx !== undefined && idx < msgs.length && msgs[idx].info.id === id) return idx;
  return msgs.findIndex((m) => m.info.id === id);
}

export function upsertMessage(msg: { info: Message; parts: Part[] }) {
  setState(
    'messages',
    produce((msgs) => {
      const idx = findMessageIndex(msgs, msg.info.id);
      if (idx !== -1) {
        msgs[idx] = msg;
      } else {
        msgs.push(msg);
      }
      invalidateIndex();
    })
  );
}

export function upsertMessageInfo(info: Message) {
  setState(
    'messages',
    produce((msgs) => {
      const idx = findMessageIndex(msgs, info.id);
      if (idx !== -1) {
        msgs[idx].info = info;
      } else {
        msgs.push({ info, parts: [] });
      }
      invalidateIndex();
    })
  );
}

export function upsertPart(part: Part) {
  const msgId = (part as { messageID: string }).messageID;
  setState(
    'messages',
    produce((msgs) => {
      const idx = findMessageIndex(msgs, msgId);
      if (idx === -1) return;
      const partIdx = msgs[idx].parts.findIndex((p) => p.id === part.id);
      if (partIdx !== -1) msgs[idx].parts[partIdx] = part;
      else msgs[idx].parts.push(part);
      invalidateIndex();
    })
  );
}

export function updateMessagePart(part: Part) {
  const partId = part.id;
  setState(
    'messages',
    produce((msgs) => {
      ensureIndex(msgs);
      const loc = partById.get(partId);
      if (loc && loc.msgIdx < msgs.length) {
        const msg = msgs[loc.msgIdx];
        if (loc.partIdx < msg.parts.length && msg.parts[loc.partIdx].id === partId) {
          msg.parts[loc.partIdx] = part;
          return;
        }
      }
      for (const msg of msgs) {
        const idx = msg.parts.findIndex((p) => p.id === partId);
        if (idx !== -1) {
          msg.parts[idx] = part;
          break;
        }
      }
    })
  );
}

export function applyMessagePartDelta(
  messageId: string,
  partId: string,
  delta: string,
  sessionId?: string,
  field = 'text'
) {
  if (field !== 'text' || !delta) return;

  setState(
    'messages',
    produce((msgs) => {
      const msgIdx = findMessageIndex(msgs, messageId);
      if (msgIdx === -1) return;
      const msg = msgs[msgIdx];

      let part = msg.parts.find(
        (item): item is Part & { type: 'text'; text: string } =>
          item.id === partId && item.type === 'text'
      );

      if (!part) {
        part = {
          id: partId,
          messageID: messageId,
          sessionID: sessionId || msg.info.sessionID,
          type: 'text',
          text: '',
        };
        msg.parts.push(part);
        invalidateIndex();
      }

      part.text += delta;
    })
  );
}

export function removeMessagePart(sessionId: string, messageId: string, partId: string) {
  setState(
    'messages',
    produce((msgs) => {
      const idx = findMessageIndex(msgs, messageId);
      if (idx !== -1 && msgs[idx].info.sessionID === sessionId) {
        const partIdx = msgs[idx].parts.findIndex((p) => p.id === partId);
        if (partIdx !== -1) msgs[idx].parts.splice(partIdx, 1);
        invalidateIndex();
      }
    })
  );
}

export function addPermission(permission: Permission) {
  setState(
    'permissions',
    produce((perms) => {
      if (!perms.find((p) => p.id === permission.id)) {
        perms.push(permission);
      }
    })
  );
}

export function removePermission(permissionId: string) {
  setState(
    'permissions',
    produce((perms) => {
      const idx = perms.findIndex((p) => p.id === permissionId);
      if (idx !== -1) perms.splice(idx, 1);
    })
  );
}

export function clearMessages() {
  setState('messages', []);
  invalidateIndex();
  setState('permissions', []);
  setState('todos', []);
  setState('diffs', []);
  setState('streamingPartId', null);
  setState('streamingText', '');
}

export function setMessagesIncremental(
  incoming: Array<{ info: Message; parts: Part[] }>
) {
  const current = state.messages;
  if (current.length === 0 || incoming.length === 0) {
    setState('messages', incoming);
    invalidateIndex();
    return;
  }

  if (current.length !== incoming.length) {
    let prefixMatch = true;
    const minLen = Math.min(current.length, incoming.length);
    for (let i = 0; i < minLen && prefixMatch; i++) {
      if (current[i].info.id !== incoming[i].info.id) prefixMatch = false;
    }
    if (prefixMatch) {
      setState(
        'messages',
        produce((msgs) => {
          for (let i = 0; i < incoming.length; i++) {
            if (i < msgs.length) {
              msgs[i] = incoming[i];
            } else {
              msgs.push(incoming[i]);
            }
          }
          msgs.length = incoming.length;
          invalidateIndex();
        })
      );
      return;
    }
  }

  if (current.length === incoming.length) {
    let identical = true;
    for (let i = 0; i < current.length && identical; i++) {
      if (current[i].info.id !== incoming[i].info.id) identical = false;
    }
    if (identical) {
      setState(
        'messages',
        produce((msgs) => {
          for (let i = 0; i < incoming.length; i++) {
            msgs[i] = incoming[i];
          }
          invalidateIndex();
        })
      );
      return;
    }
  }

  setState('messages', incoming);
  invalidateIndex();
}

export function getChildRunsByParentId(
  messages: Array<{ info: Message; parts: Part[] }>
): Map<string, Array<{ info: AssistantMessage; parts: Part[] }>> {
  const map = new Map<string, Array<{ info: AssistantMessage; parts: Part[] }>>();
  for (const entry of messages) {
    if (entry.info.role !== 'assistant') continue;
    const a = entry.info as AssistantMessage;
    if (a.mode !== 'subagent') continue;
    const children = map.get(a.parentID);
    if (children) children.push(entry as { info: AssistantMessage; parts: Part[] });
    else map.set(a.parentID, [entry as { info: AssistantMessage; parts: Part[] }]);
  }
  for (const children of map.values()) {
    children.sort((a, b) => a.info.time.created - b.info.time.created);
  }
  return map;
}
