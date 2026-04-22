import { batch, createSignal } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
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
  ProviderLimitStatus,
  ServerStatus,
  WebviewThemeKind,
} from '../../shared/protocol';
import { mergeContextFile } from '../../shared/context-files';
import type { UsageLimitNotice } from './usage-limit';

const STORAGE_KEYS = {
  selectedAgent: 'varro.selectedAgent',
  sessionSelectedAgents: 'varro.sessionSelectedAgents',
  selectedModel: 'varro.selectedModel',
  sessionSelectedModels: 'varro.sessionSelectedModels',
  draftPermissionMode: 'varro.draftPermissionMode',
  sessionPermissionModes: 'varro.sessionPermissionModes',
  projectPermissionModes: 'varro.projectPermissionModes',
  hiddenProviders: 'varro.hiddenProviders',
  hiddenModels: 'varro.hiddenModels',
  lastSeenSessions: 'varro.lastSeenSessions',
  lastActiveSessionId: 'varro.lastActiveSessionId',
} as const;

export type SelectedModel = { providerID: string; modelID: string; variant?: string };
export type SessionSelectedAgents = Record<string, string>;
export type SessionSelectedModels = Record<string, SelectedModel>;

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
    const serialized = JSON.stringify(value);
    if (window.localStorage.getItem(key) === serialized) return;
    window.localStorage.setItem(key, serialized);
  } catch {}
}

interface AppState {
  serverStatus: ServerStatus;
  providersLoaded: boolean;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  emptyStateLogoUri: string;
  draftCurrentDocumentEnabled: boolean | null;
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
  sessions: Session[];
  activeSessionId: string | null;
  currentDocumentEnabledBySession: Record<string, boolean>;
  sessionStatus: Record<string, SessionStatus>;
  messages: Array<{ info: Message; parts: Part[] }>;
  todos: Todo[];
  permissions: Permission[];
  questions: QuestionRequest[];
  pendingAttentionSessionIds: string[];
  diffs: FileDiff[];
  streamingPartId: string | null;
  streamingText: string;
  agents: Agent[];
  allAgents: Agent[];
  providers: Provider[];
  providerLimits: Record<string, ProviderLimitStatus | null>;
  providerDefaults: Record<string, string>;
  sessionPermissionModes: Record<string, PermissionMode>;
  selectedAgent: string | null;
  sessionSelectedAgents: SessionSelectedAgents;
  selectedModel: SelectedModel | null;
  sessionSelectedModels: SessionSelectedModels;
  hiddenProviders: string[];
  hiddenModels: string[];
  lastSeenSessions: Record<string, number>;
  compactingSessionIds: string[];
  queuedMessages: QueuedMessage[];
  failedSessionIds: string[];
  sessionUsageLimits: Record<string, UsageLimitNotice | null>;
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
  providersLoaded: false,
  editorContext: initialWebviewState.editorContext ?? defaultEditorContext,
  terminalSelection: initialWebviewState.terminalSelection ?? null,
  emptyStateLogoUri: initialWebviewState.emptyStateLogoUri ?? '',
  draftCurrentDocumentEnabled: null,
  droppedFiles: initialWebviewState.droppedFiles ?? [],
  clipboardImages: [],
  sessions: [],
  activeSessionId: null,
  currentDocumentEnabledBySession: {},
  sessionStatus: {},
  messages: [],
  todos: [],
  permissions: [],
  questions: [],
  pendingAttentionSessionIds: [],
  diffs: [],
  streamingPartId: null,
  streamingText: '',
  agents: [],
  allAgents: [],
  providers: [],
  providerLimits: {},
  providerDefaults: {},
  sessionPermissionModes:
    readStored<Record<string, PermissionMode>>(STORAGE_KEYS.sessionPermissionModes) || {},
  selectedAgent: readStored<string>(STORAGE_KEYS.selectedAgent),
  sessionSelectedAgents:
    readStored<SessionSelectedAgents>(STORAGE_KEYS.sessionSelectedAgents) || {},
  selectedModel: readStored<SelectedModel>(STORAGE_KEYS.selectedModel),
  sessionSelectedModels:
    readStored<SessionSelectedModels>(STORAGE_KEYS.sessionSelectedModels) || {},
  hiddenProviders: readStored<string[]>(STORAGE_KEYS.hiddenProviders) || [],
  hiddenModels: readStored<string[]>(STORAGE_KEYS.hiddenModels) || [],
  lastSeenSessions: readStored<Record<string, number>>(STORAGE_KEYS.lastSeenSessions) || {},
  compactingSessionIds: [],
  queuedMessages: [],
  failedSessionIds: [],
  sessionUsageLimits: {},
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

export function getPersistedSelectedModel(): SelectedModel | null {
  return readStored<SelectedModel>(STORAGE_KEYS.selectedModel);
}

export function getPersistedSelectedAgent(): string | null {
  return readStored<string>(STORAGE_KEYS.selectedAgent);
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

export function isSessionCompacting() {
  const sid = state.activeSessionId;
  if (!sid) return false;
  if (state.compactingSessionIds.includes(sid)) return true;
  return !!state.sessions.find((session) => session.id === sid)?.time.compacting;
}

export const [showThinking, setShowThinking] = createSignal(readShowThinking());

export function toggleThinking() {
  const next = !showThinking();
  setShowThinkingPreference(next);
}

export function setShowThinkingPreference(next: boolean) {
  setShowThinking(next);
  writeStored('varro.showThinking', next);
}

export const [inputText, setInputText] = createSignal('');
export const [nextPastedImageIndex, setNextPastedImageIndex] = createSignal(1);
export const [isLoading, setIsLoading] = createSignal(false);
export const [loadingStartedAt, setLoadingStartedAt] = createSignal<number | null>(null);
export const [loadingLastActivityAt, setLoadingLastActivityAt] = createSignal<number | null>(null);

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

export function hasActiveQuestion() {
  const sid = state.activeSessionId;
  return sid ? state.questions.some((q) => q.sessionID === sid) : false;
}

export function hasActivePermission() {
  const sid = state.activeSessionId;
  return sid ? state.permissions.some((p) => p.sessionID === sid) : false;
}

export function isSessionAwaitingInput(sessionId: string) {
  return (
    state.pendingAttentionSessionIds.includes(sessionId) ||
    state.permissions.some((permission) => permission.sessionID === sessionId) ||
    state.questions.some((question) => question.sessionID === sessionId)
  );
}

export const [error, setError] = createSignal<string | null>(null);
export const [showSessionPicker, setShowSessionPicker] = createSignal(false);
export const [showModelPicker, setShowModelPicker] = createSignal(false);
export const [showSettings, setShowSettings] = createSignal(false);
export const [composerFocusKey, setComposerFocusKey] = createSignal(0);
export const [messageListScrollRequestKey, setMessageListScrollRequestKey] = createSignal(0);
export const [messageStructureVersion, setMessageStructureVersion] = createSignal(0);
let permissionWorkspace: string | null = initialWebviewState.editorContext?.workspacePath ?? null;

function bumpMessageStructureVersion() {
  setMessageStructureVersion((value) => value + 1);
}

function resolveInitialDraftMode(): PermissionMode {
  if (permissionWorkspace) {
    const modes =
      readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
    if (modes[permissionWorkspace]) return modes[permissionWorkspace];
  }
  return readStored<PermissionMode>(STORAGE_KEYS.draftPermissionMode) || 'default';
}

export const [draftPermissionMode, setDraftPermissionMode] =
  createSignal<PermissionMode>(resolveInitialDraftMode());
export const [theme, setTheme] = createSignal<WebviewThemeKind>(
  initialWebviewState.theme ||
    ((window as unknown as Record<string, string>).__initialTheme as WebviewThemeKind) ||
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

export function getCurrentDocumentEnabled(
  sessionId: string | null | undefined = state.activeSessionId
) {
  return sessionId
    ? (state.currentDocumentEnabledBySession[sessionId] ?? true)
    : (state.draftCurrentDocumentEnabled ?? true);
}

function readShowThinking(): boolean {
  try {
    const raw = window.localStorage.getItem('varro.showThinking');
    return raw ? JSON.parse(raw) : true;
  } catch {
    return true;
  }
}

export function setCurrentDocumentEnabled(
  enabled: boolean,
  sessionId: string | null | undefined = state.activeSessionId
) {
  if (sessionId) {
    setState('currentDocumentEnabledBySession', sessionId, enabled);
    return;
  }
  setState('draftCurrentDocumentEnabled', enabled);
}

export function toggleCurrentDocumentEnabled(
  sessionId: string | null | undefined = state.activeSessionId
) {
  setCurrentDocumentEnabled(!getCurrentDocumentEnabled(sessionId), sessionId);
}

export function rememberCurrentDocumentNavigation(
  previousPath: string | null | undefined,
  nextPath: string | null | undefined,
  sessionId: string | null | undefined = state.activeSessionId
) {
  if (!previousPath || !nextPath || previousPath === nextPath) return;
  if (getCurrentDocumentEnabled(sessionId)) return;
  setCurrentDocumentEnabled(false, sessionId);
}

export function adoptDraftCurrentDocumentState(sessionId: string) {
  if (!sessionId || state.draftCurrentDocumentEnabled === null) return;
  setState('currentDocumentEnabledBySession', sessionId, state.draftCurrentDocumentEnabled);
  clearDraftCurrentDocumentState();
}

export function clearDraftCurrentDocumentState() {
  setState('draftCurrentDocumentEnabled', null);
}

export function clearCurrentDocumentStateForSession(sessionId: string) {
  if (!(sessionId in state.currentDocumentEnabledBySession)) return;
  setState(
    'currentDocumentEnabledBySession',
    produce((sessions) => {
      delete sessions[sessionId];
    })
  );
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

  if (state.sessionPermissionModes[sessionId] === mode) return;

  const nextModes = { ...state.sessionPermissionModes, [sessionId]: mode };

  setState('sessionPermissionModes', nextModes);
  writeStored(STORAGE_KEYS.sessionPermissionModes, nextModes);
}

export function removePermissionModeForSession(sessionId: string) {
  if (!state.sessionPermissionModes[sessionId]) return;
  const nextModes = Object.fromEntries(
    Object.entries(state.sessionPermissionModes).filter(([id]) => id !== sessionId)
  );
  setState('sessionPermissionModes', reconcile(nextModes));
  writeStored(STORAGE_KEYS.sessionPermissionModes, nextModes);
}

export function getSelectedModelForSession(
  sessionId: string | null | undefined
): SelectedModel | null {
  if (!sessionId) return null;
  return state.sessionSelectedModels[sessionId] || null;
}

export function getSelectedAgentForSession(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return state.sessionSelectedAgents[sessionId] || null;
}

export function setSelectedModel(
  model: SelectedModel | null,
  options?: { sessionId?: string | null; persistGlobal?: boolean }
) {
  const persistGlobal = options?.persistGlobal ?? true;
  const sessionId = options?.sessionId;

  if (!modelsEqual(state.selectedModel, model)) {
    setState('selectedModel', model);
  }
  if (persistGlobal) writeStored(STORAGE_KEYS.selectedModel, model);

  if (sessionId) {
    const nextSessionModels = model
      ? { ...state.sessionSelectedModels, [sessionId]: model }
      : Object.fromEntries(
          Object.entries(state.sessionSelectedModels).filter(([id]) => id !== sessionId)
        );
    setState('sessionSelectedModels', reconcile(nextSessionModels));
    writeStored(STORAGE_KEYS.sessionSelectedModels, nextSessionModels);
  }
}

export function clearSelectedModelForSession(sessionId: string) {
  if (!state.sessionSelectedModels[sessionId]) return;
  const nextSessionModels = Object.fromEntries(
    Object.entries(state.sessionSelectedModels).filter(([id]) => id !== sessionId)
  );
  setState('sessionSelectedModels', reconcile(nextSessionModels));
  writeStored(STORAGE_KEYS.sessionSelectedModels, nextSessionModels);
}

export function resetDraftPermissionMode() {
  const modes =
    readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
  const projectMode = permissionWorkspace && modes[permissionWorkspace];
  setDraftPermissionMode(projectMode || 'default');
  writeStored(STORAGE_KEYS.draftPermissionMode, null);
}

export function syncDraftPermissionForWorkspace(workspacePath: string | null) {
  permissionWorkspace = workspacePath?.replace(/\\/g, '/').replace(/\/+$/, '') || null;
  const modes =
    readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
  const mode =
    permissionWorkspace && modes[permissionWorkspace] ? modes[permissionWorkspace] : 'default';
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
      const idx = files.findIndex((f) => f.path === file.path);
      if (idx === -1) {
        files.push(file);
        return;
      }
      files[idx] = mergeContextFile(files[idx], file);
    })
  );
}

export function addContextFiles(files: DroppedFile[]) {
  if (files.length === 0) return;
  setState(
    'droppedFiles',
    produce((current) => {
      for (const file of files) {
        const idx = current.findIndex((item) => item.path === file.path);
        if (idx === -1) {
          current.push(file);
          continue;
        }
        current[idx] = mergeContextFile(current[idx], file);
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

export function setSessions(nextSessions: Session[]) {
  setState('sessions', nextSessions);
  invalidateSessionTreeIndex();
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

export function setSelectedAgent(
  agent: string | null,
  options?: { sessionId?: string | null; persistGlobal?: boolean }
) {
  const persistGlobal = options?.persistGlobal ?? true;
  const sessionId = options?.sessionId;

  if (state.selectedAgent !== agent) {
    setState('selectedAgent', agent);
  }
  if (persistGlobal) writeStored(STORAGE_KEYS.selectedAgent, agent);

  if (sessionId) {
    const nextSessionAgents = agent
      ? { ...state.sessionSelectedAgents, [sessionId]: agent }
      : Object.fromEntries(
          Object.entries(state.sessionSelectedAgents).filter(([id]) => id !== sessionId)
        );
    setState('sessionSelectedAgents', reconcile(nextSessionAgents));
    writeStored(STORAGE_KEYS.sessionSelectedAgents, nextSessionAgents);
  }
}

export function clearSelectedAgentForSession(sessionId: string) {
  if (!state.sessionSelectedAgents[sessionId]) return;
  const nextSessionAgents = Object.fromEntries(
    Object.entries(state.sessionSelectedAgents).filter(([id]) => id !== sessionId)
  );
  setState('sessionSelectedAgents', reconcile(nextSessionAgents));
  writeStored(STORAGE_KEYS.sessionSelectedAgents, nextSessionAgents);
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

export function getProviderLimitKey(
  providerID: string | null | undefined,
  modelID: string | null | undefined
) {
  const providerKey = providerID?.trim();
  if (!providerKey) return '';
  return `${providerKey}:${modelID?.trim() || ''}`;
}

export function getProviderLimit(
  providerID: string | null | undefined,
  modelID: string | null | undefined
) {
  const key = getProviderLimitKey(providerID, modelID);
  return key ? state.providerLimits[key] || null : null;
}

export function setProviderLimit(
  providerID: string | null | undefined,
  modelID: string | null | undefined,
  limit: ProviderLimitStatus | null
) {
  const key = getProviderLimitKey(providerID, modelID);
  if (!key) return;

  setState(
    'providerLimits',
    produce((current) => {
      if (limit === null) {
        delete current[key];
        return;
      }

      current[key] = limit;
    })
  );
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
  bumpMessageStructureVersion();
}

function findMessageIndex(msgs: Array<{ info: Message; parts: Part[] }>, id: string): number {
  ensureIndex(msgs);
  const idx = messageById.get(id);
  if (idx !== undefined && idx < msgs.length && msgs[idx].info.id === id) return idx;
  return msgs.findIndex((m) => m.info.id === id);
}

function findPartLocation(
  msgs: Array<{ info: Message; parts: Part[] }>,
  partId: string
): { msgIdx: number; partIdx: number } | null {
  ensureIndex(msgs);
  const indexed = partById.get(partId);
  if (indexed) {
    const message = msgs[indexed.msgIdx];
    if (message?.parts[indexed.partIdx]?.id === partId) {
      return indexed;
    }
  }

  for (let msgIdx = 0; msgIdx < msgs.length; msgIdx++) {
    const partIdx = msgs[msgIdx].parts.findIndex((part) => part.id === partId);
    if (partIdx !== -1) {
      const location = { msgIdx, partIdx };
      partById.set(partId, location);
      return location;
    }
  }

  return null;
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
        return;
      } else {
        msgs.push({ info, parts: [] });
        invalidateIndex();
      }
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
      const location = findPartLocation(msgs, part.id);
      if (location && location.msgIdx === idx) {
        msgs[idx].parts[location.partIdx] = part;
        return;
      }

      msgs[idx].parts.push(part);
      invalidateIndex();
    })
  );
  if (state.streamingPartId === part.id) {
    batch(() => {
      setState('streamingPartId', null);
      setState('streamingText', '');
    });
  }
}

export function updateMessagePart(part: Part) {
  const partId = part.id;
  setState(
    'messages',
    produce((msgs) => {
      const location = findPartLocation(msgs, partId);
      if (!location) return;
      const msg = msgs[location.msgIdx];
      if (msg) {
        msg.parts[location.partIdx] = part;
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

  ensureIndex(state.messages);
  const location = partById.get(partId);
  const message =
    location && state.messages[location.msgIdx]?.info.id === messageId
      ? state.messages[location.msgIdx]
      : state.messages.find((item) => item.info.id === messageId);
  if (!message) return;

  const existingPart =
    location && message.parts[location.partIdx]?.id === partId
      ? message.parts[location.partIdx]
      : message.parts.find((item) => item.id === partId);
  const existingText =
    existingPart && (existingPart.type === 'text' || existingPart.type === 'reasoning')
      ? existingPart.text
      : '';
  const currentStreamingText =
    state.streamingPartId === partId ? state.streamingText : existingText;
  const nextStreamingText = currentStreamingText + delta;

  batch(() => {
    setState('streamingPartId', partId);
    setState('streamingText', nextStreamingText);
  });

  setState(
    'messages',
    produce((msgs) => {
      const msgIdx = findMessageIndex(msgs, messageId);
      if (msgIdx === -1) return;
      const partIdx = msgs[msgIdx].parts.findIndex((item) => item.id === partId);
      if (partIdx !== -1) {
        const part = msgs[msgIdx].parts[partIdx];
        if (part.type === 'text' || part.type === 'reasoning') {
          part.text = nextStreamingText;
        }
        return;
      }
      msgs[msgIdx].parts.push({
        id: partId,
        messageID: messageId,
        sessionID: sessionId || msgs[msgIdx].info.sessionID,
        type: 'text',
        text: nextStreamingText,
      });
      invalidateIndex();
    })
  );
}

export function removeMessagePart(sessionId: string, messageId: string, partId: string) {
  setState(
    'messages',
    produce((msgs) => {
      const idx = findMessageIndex(msgs, messageId);
      if (idx !== -1 && msgs[idx].info.sessionID === sessionId) {
        const location = findPartLocation(msgs, partId);
        if (location && location.msgIdx === idx) {
          msgs[idx].parts.splice(location.partIdx, 1);
          invalidateIndex();
        }
      }
    })
  );
  if (state.streamingPartId === partId) {
    batch(() => {
      setState('streamingPartId', null);
      setState('streamingText', '');
    });
  }
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

export function clearStreamingState() {
  batch(() => {
    setState('streamingPartId', null);
    setState('streamingText', '');
  });
}

export function clearMessages() {
  replaceMessages([]);
  setState('permissions', []);
  setState('todos', []);
  setState('diffs', []);
  clearStreamingState();
}

export function setSessionFailed(sessionId: string, failed: boolean) {
  setState(
    'failedSessionIds',
    produce((ids) => {
      const idx = ids.indexOf(sessionId);
      if (failed) {
        if (idx === -1) ids.push(sessionId);
        return;
      }
      if (idx !== -1) ids.splice(idx, 1);
    })
  );
}

export function setSessionUsageLimit(sessionId: string, notice: UsageLimitNotice | null) {
  if (!sessionId) return;

  setState(
    'sessionUsageLimits',
    produce((current) => {
      if (notice === null) {
        delete current[sessionId];
        return;
      }

      current[sessionId] = notice;
    })
  );
  invalidateSessionTreeIndex();
}

let sessionTreeIndexVersion = 0;
let sessionTreeIndexedVersion = -1;
let sessionTreeIdsByRoot: Map<string, string[]> = new Map();
let nearestPrimarySessionById: Map<string, string> = new Map();
let activeUsageLimitByRoot: Map<string, UsageLimitNotice | null> = new Map();
let indexedSessionsRef: Session[] | null = null;
let indexedUsageLimitsRef: Record<string, UsageLimitNotice | null> | null = null;

function invalidateSessionTreeIndex() {
  sessionTreeIndexVersion++;
}

function ensureSessionTreeIndex(sessions = state.sessions, usageLimits = state.sessionUsageLimits) {
  if (
    sessionTreeIndexedVersion === sessionTreeIndexVersion &&
    indexedSessionsRef === sessions &&
    indexedUsageLimitsRef === usageLimits
  )
    return;

  const childrenByParent = new Map<string, string[]>();
  nearestPrimarySessionById = new Map();

  for (const session of sessions) {
    if (!session.parentID) continue;
    const children = childrenByParent.get(session.parentID);
    if (children) children.push(session.id);
    else childrenByParent.set(session.parentID, [session.id]);
  }

  const primarySessions = sessions.filter((session) => !session.parentID);
  if (primarySessions.length === 0) {
    sessionTreeIdsByRoot = new Map();
    activeUsageLimitByRoot = new Map();
    for (const session of sessions) {
      nearestPrimarySessionById.set(session.id, session.id);
      sessionTreeIdsByRoot.set(session.id, [session.id]);
      activeUsageLimitByRoot.set(session.id, usageLimits[session.id] || null);
    }
    sessionTreeIndexedVersion = sessionTreeIndexVersion;
    indexedSessionsRef = sessions;
    indexedUsageLimitsRef = usageLimits;
    return;
  }
  sessionTreeIdsByRoot = new Map();

  for (const root of primarySessions) {
    const visited: string[] = [];
    const pending = [root.id];
    while (pending.length > 0) {
      const currentId = pending.pop();
      if (!currentId || nearestPrimarySessionById.has(currentId)) continue;
      nearestPrimarySessionById.set(currentId, root.id);
      visited.push(currentId);
      const children = childrenByParent.get(currentId);
      if (!children) continue;
      for (let index = children.length - 1; index >= 0; index--) {
        pending.push(children[index]);
      }
    }
    sessionTreeIdsByRoot.set(root.id, visited);
  }

  activeUsageLimitByRoot = new Map();
  for (const root of primarySessions) {
    const treeIds = sessionTreeIdsByRoot.get(root.id) || [root.id];
    const activeNotice = treeIds.map((id) => usageLimits[id] || null).find((notice) => !!notice);
    activeUsageLimitByRoot.set(root.id, activeNotice || null);
  }

  sessionTreeIndexedVersion = sessionTreeIndexVersion;
  indexedSessionsRef = sessions;
  indexedUsageLimitsRef = usageLimits;
}

export function getSessionTreeIds(rootId: string | null | undefined, sessions = state.sessions) {
  if (!rootId) return [];
  if (sessions === state.sessions) {
    ensureSessionTreeIndex();
    const rootSessionId = nearestPrimarySessionById.get(rootId) || rootId;
    if (rootSessionId === rootId) {
      const cached = sessionTreeIdsByRoot.get(rootId);
      if (cached) return [...cached];
    }

    const rootIndex = sessionTreeIdsByRoot.get(rootSessionId);
    if (!rootIndex) return [rootId];
    const start = rootIndex.indexOf(rootId);
    return start === -1 ? [rootId] : rootIndex.slice(start);
  }

  const visited = new Set<string>();
  const pending = [rootId];

  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);

    for (const session of sessions) {
      if (session.parentID === currentId) pending.push(session.id);
    }
  }

  return [...visited];
}

export function getSessionTreeRootId(sessionId: string | null | undefined) {
  if (!sessionId) return null;
  ensureSessionTreeIndex();
  return nearestPrimarySessionById.get(sessionId) || sessionId;
}

export function getActiveUsageLimitNotice(sessionId: string | null | undefined) {
  if (!sessionId) return null;
  ensureSessionTreeIndex();
  const rootId = nearestPrimarySessionById.get(sessionId) || sessionId;
  return activeUsageLimitByRoot.get(rootId) || null;
}

export function hasActiveUsageLimit(sessionId: string | null | undefined) {
  return !!getActiveUsageLimitNotice(sessionId);
}

export function syncFailedSessionsFromMessages(
  messages: Array<{ info: Message; parts: Part[] }> = state.messages
) {
  const failedSessionIds = new Set<string>();

  const latestBySession = new Map<string, Message>();
  for (const entry of messages) {
    latestBySession.set(entry.info.sessionID, entry.info);
  }

  for (const [sessionId, info] of latestBySession) {
    if (info.role !== 'assistant' || !info.error) continue;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) continue;
    if (isSessionUnread(sessionId, session.time.updated)) failedSessionIds.add(sessionId);
  }

  setState('failedSessionIds', [...failedSessionIds]);
}

export function replaceMessages(incoming: Array<{ info: Message; parts: Part[] }>) {
  setState('messages', incoming);
  invalidateIndex();
}

export function setMessagesIncremental(incoming: Array<{ info: Message; parts: Part[] }>) {
  clearStreamingState();
  const current = state.messages;
  if (current === incoming) return;
  if (current.length === 0 || incoming.length === 0) {
    replaceMessages(incoming);
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
          let changed = false;
          for (let i = 0; i < incoming.length; i++) {
            if (i < msgs.length) {
              if (msgs[i] !== incoming[i]) {
                msgs[i] = incoming[i];
                changed = true;
              }
            } else {
              msgs.push(incoming[i]);
              changed = true;
            }
          }
          if (msgs.length !== incoming.length) {
            msgs.length = incoming.length;
            changed = true;
          }
          if (changed) invalidateIndex();
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
          let changed = false;
          for (let i = 0; i < incoming.length; i++) {
            if (msgs[i] !== incoming[i]) {
              msgs[i] = incoming[i];
              changed = true;
            }
          }
          if (changed) invalidateIndex();
        })
      );
      return;
    }
  }

  replaceMessages(incoming);
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

function modelsEqual(a: SelectedModel | null, b: SelectedModel | null) {
  return (
    a?.providerID === b?.providerID &&
    a?.modelID === b?.modelID &&
    (a?.variant || null) === (b?.variant || null)
  );
}
