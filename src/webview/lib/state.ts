import { createSignal } from 'solid-js';
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
} from '../types';
import type {
  EditorContext,
  DroppedFile,
  PermissionMode,
  ServerStatus,
} from '../../shared/protocol';

const STORAGE_KEYS = {
  selectedAgent: 'opencode.selectedAgent',
  selectedModel: 'opencode.selectedModel',
  sessionPermissionModes: 'opencode.sessionPermissionModes',
  hiddenProviders: 'opencode.hiddenProviders',
  hiddenModels: 'opencode.hiddenModels',
  lastSeenSessions: 'opencode.lastSeenSessions',
  lastActiveSessionId: 'opencode.lastActiveSessionId',
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

type InitialWebviewState = Partial<
  Pick<AppState, 'serverStatus' | 'editorContext' | 'terminalSelection' | 'droppedFiles'>
> & {
  theme?: 'dark' | 'light';
};

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

export const [showThinking, setShowThinking] = createSignal(readShowThinking());

export function toggleThinking() {
  const next = !showThinking();
  setShowThinking(next);
  try {
    window.localStorage.setItem('opencode.showThinking', JSON.stringify(next));
  } catch {}
}

function readShowThinking(): boolean {
  try {
    const raw = window.localStorage.getItem('opencode.showThinking');
    return raw ? JSON.parse(raw) : true;
  } catch {
    return true;
  }
}

export const [inputText, setInputText] = createSignal('');
export const [isLoading, setIsLoading] = createSignal(false);

export function hasActiveQuestion() {
  const sid = state.activeSessionId;
  return sid ? state.questions.some((q) => q.sessionID === sid) : false;
}
export const [error, setError] = createSignal<string | null>(null);
export const [showSessionPicker, setShowSessionPicker] = createSignal(false);
export const [showModelPicker, setShowModelPicker] = createSignal(false);
export const [showSettings, setShowSettings] = createSignal(false);
export const [composerFocusKey, setComposerFocusKey] = createSignal(0);
export const [draftPermissionMode, setDraftPermissionMode] =
  createSignal<PermissionMode>('default');
export const [theme, setTheme] = createSignal<'dark' | 'light'>(
  initialWebviewState.theme ||
    ((window as unknown as Record<string, string>).__initialTheme as 'dark' | 'light') ||
    'dark'
);

export function requestComposerFocus() {
  setComposerFocusKey((value) => value + 1);
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
    return;
  }

  const nextModes =
    mode === 'default'
      ? Object.fromEntries(
          Object.entries(state.sessionPermissionModes).filter(([id]) => id !== sessionId)
        )
      : { ...state.sessionPermissionModes, [sessionId]: mode };

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
  setDraftPermissionMode('default');
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
  setState(
    'clipboardImages',
    produce((images) => {
      if (!images.find((item) => item.id === image.id)) {
        images.push(image);
      }
    })
  );
}

export function removeClipboardImage(id: string) {
  setState(
    'clipboardImages',
    produce((images) => {
      const idx = images.findIndex((item) => item.id === id);
      if (idx !== -1) images.splice(idx, 1);
    })
  );
}

export function clearClipboardImages() {
  setState('clipboardImages', []);
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

function readInitialWebviewState(): InitialWebviewState {
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

export function upsertMessage(msg: { info: Message; parts: Part[] }) {
  setState(
    'messages',
    produce((msgs) => {
      const idx = msgs.findIndex((m) => m.info.id === msg.info.id);
      if (idx !== -1) {
        msgs[idx] = msg;
      } else {
        msgs.push(msg);
      }
    })
  );
}

export function upsertMessageInfo(info: Message) {
  setState(
    'messages',
    produce((msgs) => {
      const idx = msgs.findIndex((m) => m.info.id === info.id);
      if (idx !== -1) {
        msgs[idx].info = info;
      } else {
        msgs.push({ info, parts: [] });
      }
    })
  );
}

export function upsertPart(part: Part) {
  setState(
    'messages',
    produce((msgs) => {
      const msgId = (part as { messageID: string }).messageID;
      const msg = msgs.find((m) => m.info.id === msgId);
      if (!msg) return;
      const idx = msg.parts.findIndex((p) => p.id === part.id);
      if (idx !== -1) msg.parts[idx] = part;
      else msg.parts.push(part);
    })
  );
}

export function updateMessagePart(part: Part) {
  setState(
    'messages',
    produce((msgs) => {
      for (const msg of msgs) {
        const idx = msg.parts.findIndex((p) => p.id === part.id);
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
      const msg = msgs.find((item) => item.info.id === messageId);
      if (!msg) return;

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
      }

      part.text += delta;
    })
  );
}

export function removeMessagePart(sessionId: string, messageId: string, partId: string) {
  setState(
    'messages',
    produce((msgs) => {
      for (const msg of msgs) {
        if (msg.info.sessionID === sessionId && msg.info.id === messageId) {
          const idx = msg.parts.findIndex((p) => p.id === partId);
          if (idx !== -1) msg.parts.splice(idx, 1);
          break;
        }
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
  setState('permissions', []);
  setState('todos', []);
  setState('diffs', []);
  setState('streamingPartId', null);
  setState('streamingText', '');
}
