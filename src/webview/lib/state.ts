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
  DesktopSessionPaneSide,
  EditorContext,
  DroppedFile,
  InitialWebviewState,
  McpStatus,
  PermissionMode,
  ProviderLimitStatus,
  ServerStatus,
  WebviewThemeKind,
} from '../../shared/protocol';
import { mergeContextFile } from '../../shared/context-files';
import type { UsageLimitNotice } from './usage-limit';
import { isAbortedAssistantError } from './aborted';
import { createMessageIndex } from './message-index';
import { createSessionTreeIndex, collectSessionTreeIds } from './session-tree-index';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';
import { createStreamingDeltaQueue } from './streaming-deltas';

export type SelectedModel = { providerID: string; modelID: string; variant?: string };
export type SessionSelectedAgents = Record<string, string>;
export type SessionSelectedModels = Record<string, SelectedModel>;
export type SessionSelectedMcps = Record<string, string[]>;

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
  mcpStatus: Record<string, McpStatus>;
  providerDefaults: Record<string, string>;
  sessionPermissionModes: Record<string, PermissionMode>;
  selectedAgent: string | null;
  sessionSelectedAgents: SessionSelectedAgents;
  selectedModel: SelectedModel | null;
  sessionSelectedModels: SessionSelectedModels;
  sessionSelectedMcps: SessionSelectedMcps;
  hiddenProviders: string[];
  hiddenModels: string[];
  lastSeenSessions: Record<string, number>;
  skippedPlanSessions: Record<string, number>;
  compactingSessionIds: string[];
  queuedMessages: QueuedMessage[];
  failedSessionIds: string[];
  sessionUsageLimits: Record<string, UsageLimitNotice | null>;
  interruptedSessionIds: string[];
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
  permissions: normalizeInitialPermissions(initialWebviewState.pendingPermissions),
  questions: normalizeInitialQuestions(initialWebviewState.pendingQuestions),
  pendingAttentionSessionIds: collectInitialPendingAttentionSessionIds(initialWebviewState),
  diffs: [],
  streamingPartId: null,
  streamingText: '',
  agents: [],
  allAgents: [],
  providers: [],
  providerLimits: {},
  mcpStatus: {},
  providerDefaults: {},
  sessionPermissionModes:
    readStored<Record<string, PermissionMode>>(STORAGE_KEYS.sessionPermissionModes) || {},
  selectedAgent: readStored<string>(STORAGE_KEYS.selectedAgent),
  sessionSelectedAgents:
    readStored<SessionSelectedAgents>(STORAGE_KEYS.sessionSelectedAgents) || {},
  selectedModel: readStored<SelectedModel>(STORAGE_KEYS.selectedModel),
  sessionSelectedModels:
    readStored<SessionSelectedModels>(STORAGE_KEYS.sessionSelectedModels) || {},
  sessionSelectedMcps: readStored<SessionSelectedMcps>(STORAGE_KEYS.sessionSelectedMcps) || {},
  hiddenProviders: readStored<string[]>(STORAGE_KEYS.hiddenProviders) || [],
  hiddenModels: readStored<string[]>(STORAGE_KEYS.hiddenModels) || [],
  lastSeenSessions: readStored<Record<string, number>>(STORAGE_KEYS.lastSeenSessions) || {},
  skippedPlanSessions: readStored<Record<string, number>>(STORAGE_KEYS.skippedPlanSessions) || {},
  compactingSessionIds: [],
  queuedMessages: [],
  failedSessionIds: [],
  sessionUsageLimits: {},
  interruptedSessionIds: initialWebviewState.interruptedSessionIds ?? [],
});

export function consumeInterruptedSessionIds() {
  const ids = [...state.interruptedSessionIds];
  setState('interruptedSessionIds', []);
  return ids;
}

function normalizeInitialPermission(value: Record<string, unknown>): Permission | null {
  const id =
    typeof value.id === 'string'
      ? value.id
      : typeof value.permissionID === 'string'
        ? value.permissionID
        : typeof value.requestID === 'string'
          ? value.requestID
          : null;
  const sessionID = typeof value.sessionID === 'string' ? value.sessionID : null;
  if (!id || !sessionID) return null;

  const tool = value.tool as { messageID?: unknown; callID?: unknown } | undefined;
  const patterns = Array.isArray(value.patterns)
    ? value.patterns.filter((item): item is string => typeof item === 'string')
    : typeof value.patterns === 'string'
      ? value.patterns
      : undefined;
  const metadata =
    value.metadata && typeof value.metadata === 'object'
      ? (value.metadata as Record<string, unknown>)
      : {};
  const createdAt =
    value.time &&
    typeof value.time === 'object' &&
    typeof (value.time as { created?: unknown }).created === 'number'
      ? ((value.time as { created: number }).created ?? Date.now() / 1000)
      : Date.now() / 1000;
  const title =
    typeof value.title === 'string' && value.title.trim().length > 0
      ? value.title
      : [
          typeof value.permission === 'string' ? value.permission : '',
          Array.isArray(patterns)
            ? patterns.join(', ')
            : typeof patterns === 'string'
              ? patterns
              : '',
        ]
          .filter(Boolean)
          .join(' ') || 'Permission required';

  return {
    id,
    type:
      typeof value.permission === 'string'
        ? value.permission
        : typeof value.type === 'string'
          ? value.type
          : '',
    pattern: patterns,
    sessionID,
    messageID:
      typeof value.messageID === 'string'
        ? value.messageID
        : typeof tool?.messageID === 'string'
          ? tool.messageID
          : '',
    callID:
      typeof value.callID === 'string'
        ? value.callID
        : typeof tool?.callID === 'string'
          ? tool.callID
          : undefined,
    title,
    metadata,
    time: { created: createdAt },
  };
}

function normalizeInitialQuestion(value: Record<string, unknown>): QuestionRequest | null {
  const id = typeof value.id === 'string' ? value.id : null;
  const sessionID = typeof value.sessionID === 'string' ? value.sessionID : null;
  const questions = Array.isArray(value.questions) ? value.questions : null;
  if (!id || !sessionID || !questions) return null;

  const tool = value.tool;
  return {
    id,
    sessionID,
    questions: questions as QuestionRequest['questions'],
    tool:
      tool &&
      typeof tool === 'object' &&
      typeof (tool as { messageID?: unknown }).messageID === 'string' &&
      typeof (tool as { callID?: unknown }).callID === 'string'
        ? {
            messageID: (tool as { messageID: string }).messageID,
            callID: (tool as { callID: string }).callID,
          }
        : undefined,
  };
}

function normalizeInitialPermissions(values: unknown): Permission[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) =>
      item && typeof item === 'object'
        ? normalizeInitialPermission(item as Record<string, unknown>)
        : null
    )
    .filter((item): item is Permission => item !== null);
}

function normalizeInitialQuestions(values: unknown): QuestionRequest[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) =>
      item && typeof item === 'object'
        ? normalizeInitialQuestion(item as Record<string, unknown>)
        : null
    )
    .filter((item): item is QuestionRequest => item !== null);
}

function collectInitialPendingAttentionSessionIds(initialState: Partial<InitialWebviewState>) {
  return [
    ...new Set([
      ...normalizeInitialPermissions(initialState.pendingPermissions).map((item) => item.sessionID),
      ...normalizeInitialQuestions(initialState.pendingQuestions).map((item) => item.sessionID),
    ]),
  ];
}

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

export function markSessionSeen(id: string, updatedAt?: number) {
  const seenAt = Math.max(state.lastSeenSessions[id] ?? 0, updatedAt ?? 0, Date.now());
  const next = { ...state.lastSeenSessions, [id]: seenAt };
  setState('lastSeenSessions', next);
  writeStored(STORAGE_KEYS.lastSeenSessions, next);
}

export function skipPlanSession(sessionId: string, updatedAt?: number) {
  const sessionUpdatedAt =
    updatedAt ?? state.sessions.find((session) => session.id === sessionId)?.time.updated;
  if (typeof sessionUpdatedAt !== 'number') return;

  const next = { ...state.skippedPlanSessions, [sessionId]: sessionUpdatedAt };
  setState('skippedPlanSessions', next);
  writeStored(STORAGE_KEYS.skippedPlanSessions, next);
}

export function clearSkippedPlanSession(sessionId: string) {
  if (!(sessionId in state.skippedPlanSessions)) return;
  const next = Object.fromEntries(
    Object.entries(state.skippedPlanSessions).filter(([id]) => id !== sessionId)
  );
  setState('skippedPlanSessions', reconcile(next));
  writeStored(STORAGE_KEYS.skippedPlanSessions, next);
}

export function isSkippedPlanSession(sessionId: string, updatedAt: number) {
  const skippedAt = state.skippedPlanSessions[sessionId];
  return typeof skippedAt === 'number' && skippedAt >= updatedAt;
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
  writeStored(STORAGE_KEYS.showThinking, next);
}

export const [expandThinkingByDefault, setExpandThinkingByDefault] = createSignal(
  readExpandThinkingByDefault()
);

export function setExpandThinkingByDefaultPreference(next: boolean) {
  setExpandThinkingByDefault(next);
  writeStored(STORAGE_KEYS.expandThinkingByDefault, next);
}

export const [showStickyUserPrompt, setShowStickyUserPrompt] = createSignal(
  readShowStickyUserPrompt()
);

export function setShowStickyUserPromptPreference(next: boolean) {
  setShowStickyUserPrompt(next);
  writeStored(STORAGE_KEYS.showStickyUserPrompt, next);
}

export const [desktopSessionPaneSide, setDesktopSessionPaneSide] =
  createSignal<DesktopSessionPaneSide>(readDesktopSessionPaneSide());

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
const sessionTreeIndex = createSessionTreeIndex();
const messageIndex = createMessageIndex(() => bumpMessageStructureVersion());
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
  return readStored<boolean>(STORAGE_KEYS.showThinking) ?? true;
}

function readExpandThinkingByDefault(): boolean {
  return (
    initialWebviewState.expandThinkingByDefault ??
    readStored<boolean>(STORAGE_KEYS.expandThinkingByDefault) ??
    readStored<boolean>(STORAGE_KEYS.legacyexpandThinkingByDefault) ??
    false
  );
}

function readShowStickyUserPrompt(): boolean {
  return (
    initialWebviewState.showStickyUserPrompt ??
    readStored<boolean>(STORAGE_KEYS.showStickyUserPrompt) ??
    true
  );
}

function readDesktopSessionPaneSide(): DesktopSessionPaneSide {
  return initialWebviewState.desktopSessionPaneSide === 'right' ? 'right' : 'left';
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

export function getSelectedMcpsForSession(sessionId: string | null | undefined): string[] | null {
  if (!sessionId) return null;
  return state.sessionSelectedMcps[sessionId] || null;
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

export function setMcpStatus(status: Record<string, McpStatus>) {
  setState('mcpStatus', status);
}

export function getAvailableMcpNames() {
  return Object.keys(state.mcpStatus).toSorted((a, b) => a.localeCompare(b));
}

export function setSelectedMcpsForSession(sessionId: string, names: string[]) {
  const nextNames = [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
  const nextSessionMcps = { ...state.sessionSelectedMcps, [sessionId]: nextNames };
  setState('sessionSelectedMcps', reconcile(nextSessionMcps));
  writeStored(STORAGE_KEYS.sessionSelectedMcps, nextSessionMcps);
}

export function clearSelectedMcpsForSession(sessionId: string) {
  if (!state.sessionSelectedMcps[sessionId]) return;
  const nextSessionMcps = Object.fromEntries(
    Object.entries(state.sessionSelectedMcps).filter(([id]) => id !== sessionId)
  );
  setState('sessionSelectedMcps', reconcile(nextSessionMcps));
  writeStored(STORAGE_KEYS.sessionSelectedMcps, nextSessionMcps);
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
  const sessionIds = new Set(nextSessions.map((session) => session.id));
  const nextSkippedPlanSessions = Object.fromEntries(
    Object.entries(state.skippedPlanSessions).filter(([id]) => sessionIds.has(id))
  );
  if (
    Object.keys(nextSkippedPlanSessions).length !== Object.keys(state.skippedPlanSessions).length
  ) {
    setState('skippedPlanSessions', reconcile(nextSkippedPlanSessions));
    writeStored(STORAGE_KEYS.skippedPlanSessions, nextSkippedPlanSessions);
  }
  sessionTreeIndex.invalidate();
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

const streamingDeltaQueue = createStreamingDeltaQueue(() => flushPendingStreamingDeltas());

function flushPendingStreamingDeltas() {
  const deltas = streamingDeltaQueue.takeAll();
  if (deltas.length === 0) return;
  const latest = deltas[deltas.length - 1];

  batch(() => {
    setState('streamingPartId', latest.partId);
    setState('streamingText', latest.text);
    setState(
      'messages',
      produce((msgs) => {
        for (const item of deltas) {
          const location = messageIndex.findPartLocation(msgs, item.partId);
          if (location) {
            const part = msgs[location.msgIdx]?.parts[location.partIdx];
            if (part.type === 'text' || part.type === 'reasoning') {
              part.text = item.text;
            }
            continue;
          }

          const msgIdx = messageIndex.findMessageIndex(msgs, item.messageId);
          if (msgIdx === -1) continue;
          msgs[msgIdx].parts.push({
            id: item.partId,
            messageID: item.messageId,
            sessionID: item.sessionId || msgs[msgIdx].info.sessionID,
            type: 'text',
            text: item.text,
          });
          messageIndex.invalidate();
        }
      })
    );
  });
}

export function upsertMessage(msg: { info: Message; parts: Part[] }) {
  flushPendingStreamingDeltas();
  setState(
    'messages',
    produce((msgs) => {
      const idx = messageIndex.findMessageIndex(msgs, msg.info.id);
      if (idx !== -1) {
        msgs[idx] = msg;
      } else {
        msgs.push(msg);
      }
      messageIndex.invalidate();
    })
  );
}

export function upsertMessageInfo(info: Message) {
  setState(
    'messages',
    produce((msgs) => {
      const idx = messageIndex.findMessageIndex(msgs, info.id);
      if (idx !== -1) {
        msgs[idx].info = info;
        return;
      } else {
        msgs.push({ info, parts: [] });
        messageIndex.invalidate();
      }
    })
  );
}

export function upsertPart(part: Part) {
  flushPendingStreamingDeltas();
  const msgId = (part as { messageID: string }).messageID;
  setState(
    'messages',
    produce((msgs) => {
      const idx = messageIndex.findMessageIndex(msgs, msgId);
      if (idx === -1) return;
      const location = messageIndex.findPartLocation(msgs, part.id);
      if (location && location.msgIdx === idx) {
        msgs[idx].parts[location.partIdx] = part;
        return;
      }

      msgs[idx].parts.push(part);
      messageIndex.invalidate();
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
  flushPendingStreamingDeltas();
  const partId = part.id;
  setState(
    'messages',
    produce((msgs) => {
      const location = messageIndex.findPartLocation(msgs, partId);
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

  const pending = streamingDeltaQueue.get(partId);
  if (pending && pending.messageId === messageId) {
    streamingDeltaQueue.bump(partId, pending.text + delta);
    streamingDeltaQueue.scheduleFlush();
    return;
  }

  messageIndex.ensureIndex(state.messages);
  const location = messageIndex.getIndexedPartLocation(partId);
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
  streamingDeltaQueue.set({
    messageId,
    partId,
    sessionId,
    text: currentStreamingText + delta,
  });
  streamingDeltaQueue.scheduleFlush();
}

export function removeMessagePart(sessionId: string, messageId: string, partId: string) {
  flushPendingStreamingDeltas();
  setState(
    'messages',
    produce((msgs) => {
      const idx = messageIndex.findMessageIndex(msgs, messageId);
      if (idx !== -1 && msgs[idx].info.sessionID === sessionId) {
        const location = messageIndex.findPartLocation(msgs, partId);
        if (location && location.msgIdx === idx) {
          msgs[idx].parts.splice(location.partIdx, 1);
          messageIndex.invalidate();
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
  streamingDeltaQueue.reset();
  batch(() => {
    setState('streamingPartId', null);
    setState('streamingText', '');
  });
}

export function clearMessages() {
  replaceMessages([]);
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
  sessionTreeIndex.invalidate();
}

export function getSessionTreeIds(rootId: string | null | undefined, sessions = state.sessions) {
  if (!rootId) return [];
  if (sessions === state.sessions) {
    return sessionTreeIndex.getTreeIds(rootId, state.sessions, state.sessionUsageLimits);
  }
  return collectSessionTreeIds(rootId, sessions);
}

export function getSessionTreeRootId(sessionId: string | null | undefined) {
  return sessionTreeIndex.getRootId(sessionId, state.sessions, state.sessionUsageLimits);
}

export function getActiveUsageLimitNotice(sessionId: string | null | undefined) {
  return sessionTreeIndex.getActiveUsageLimitNotice(
    sessionId,
    state.sessions,
    state.sessionUsageLimits
  );
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
    if (isAbortedAssistantError(info.error)) continue;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) continue;
    failedSessionIds.add(sessionId);
  }

  setState('failedSessionIds', [...failedSessionIds]);
}

export function replaceMessages(incoming: Array<{ info: Message; parts: Part[] }>) {
  streamingDeltaQueue.reset();
  setState('messages', incoming);
  messageIndex.invalidate();
}

export function setMessagesIncremental(incoming: Array<{ info: Message; parts: Part[] }>) {
  clearStreamingState();
  const current = state.messages;
  if (current === incoming) return;
  if (current.length === 0 || incoming.length === 0) {
    replaceMessages(incoming);
    return;
  }

  const sharedPrefixLength = getSharedMessagePrefixLength(current, incoming);

  if (sharedPrefixLength === 0) {
    replaceMessages(incoming);
    return;
  }

  setState(
    'messages',
    produce((msgs) => {
      let changed = false;
      for (let i = 0; i < incoming.length; i++) {
        const next = incoming[i];
        if (i < sharedPrefixLength) {
          if (!areMessageEntriesEquivalent(msgs[i], next)) {
            msgs[i] = next;
            changed = true;
          }
          continue;
        }

        if (i < msgs.length) {
          if (msgs[i] !== next) {
            msgs[i] = next;
            changed = true;
          }
        } else {
          msgs.push(next);
          changed = true;
        }
      }
      if (msgs.length !== incoming.length) {
        msgs.length = incoming.length;
        changed = true;
      }
      if (changed) messageIndex.invalidate();
    })
  );
}

function getSharedMessagePrefixLength(
  current: Array<{ info: Message; parts: Part[] }>,
  incoming: Array<{ info: Message; parts: Part[] }>
) {
  const minLen = Math.min(current.length, incoming.length);
  let index = 0;
  while (index < minLen && current[index].info.id === incoming[index].info.id) {
    index += 1;
  }
  return index;
}

function areMessageEntriesEquivalent(
  left: { info: Message; parts: Part[] },
  right: { info: Message; parts: Part[] }
) {
  if (left === right) return true;
  if (left.info !== right.info && !areMessagesEquivalent(left.info, right.info)) return false;
  if (left.parts === right.parts) return true;
  if (left.parts.length !== right.parts.length) return false;

  for (let index = 0; index < left.parts.length; index += 1) {
    if (
      left.parts[index] !== right.parts[index] &&
      !arePartsEquivalent(left.parts[index], right.parts[index])
    ) {
      return false;
    }
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

function areMessagesEquivalent(left: Message, right: Message) {
  if (left.id !== right.id) return false;
  if (left.sessionID !== right.sessionID) return false;
  if (left.role !== right.role) return false;
  if (left.time.created !== right.time.created) return false;
  if (
    (left.time as { completed?: number }).completed !==
    (right.time as { completed?: number }).completed
  ) {
    return false;
  }
  const leftError = (left as { error?: unknown }).error ?? null;
  const rightError = (right as { error?: unknown }).error ?? null;
  if (leftError !== rightError && !deepEqual(leftError, rightError)) return false;
  return true;
}

function arePartsEquivalent(left: Part, right: Part) {
  if (left.id !== right.id) return false;
  if (left.type !== right.type) return false;
  if (left.messageID !== right.messageID) return false;
  if (left.sessionID !== right.sessionID) return false;
  if ((left as { text?: unknown }).text !== (right as { text?: unknown }).text) return false;
  const leftState = (left as { state?: unknown }).state ?? null;
  const rightState = (right as { state?: unknown }).state ?? null;
  if (leftState === rightState) return true;
  return deepEqual(leftState, rightState);
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
