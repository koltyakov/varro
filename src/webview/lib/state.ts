import { batch, createSignal } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import type { SetStoreFunction, Store } from 'solid-js/store';
import type {
  Session,
  Message,
  Part,
  Permission,
  PermissionGroupMember,
  QuestionRequest,
  Todo,
  SessionStatus,
  FileDiff,
  Agent,
  Command,
  Provider,
  AssistantMessage,
} from '../types';
import type {
  ClipboardImage,
  QueuedMessage,
  SelectedModel,
  SessionSelectedAgents,
  SessionSelectedMcps,
  SessionSelectedModels,
} from './app-state-types';
import type {
  DesktopSessionPaneSide,
  EditorContext,
  DroppedFile,
  InitialWebviewState,
  McpStatus,
  PermissionMode,
  ProviderLimitStatus,
  RecycleBinEntry,
  ServerStatus,
  WebviewThemeKind,
} from '../../shared/protocol';
import {
  readProviderLimitPollIntervalSeconds,
  readProviderLimitThresholdPercent,
} from '../../shared/provider-limit-config';
import { mergeContextFile } from '../../shared/context-files';
import type { UsageLimitNotice } from './usage-limit';
import { isAbortedAssistantError } from './aborted';
import { createMessageIndex } from './message-index';
import {
  getSessionMarkerWorkspaceScope,
  isSessionUnreadMarker,
  isSkippedPlanSessionMarker,
  nextSeenSessions,
  nextSkippedPlanSessions,
  pruneSkippedPlanSessions,
  readInitialSessionMarkerScope,
  readScopedSessionMarkerState,
  removeSessionMarker,
  writeScopedSessionMarkerState,
} from './state-session-markers';
import { createSessionTreeIndex, collectSessionTreeIds } from './session-tree-index';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';
import {
  areMessageEntriesEquivalent,
  getSharedMessagePrefixLength,
  type MessageEntry,
} from './message-entry-sync';
import { createStreamingDeltaQueue } from './streaming-deltas';

export interface AppState {
  serverStatus: ServerStatus;
  providersLoaded: boolean;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  emptyStateLogoUri: string;
  draftCurrentDocumentEnabled: boolean | null;
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
  sessions: Session[];
  recycleBinEntries: RecycleBinEntry[];
  activeSessionId: string | null;
  currentDocumentEnabledBySession: Record<string, boolean>;
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
  commands: Command[];
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

export const MAX_CLIPBOARD_IMAGES = 5;
const MAX_CLIPBOARD_IMAGE_SIZE = 5 * 1024 * 1024;

const defaultEditorContext: EditorContext = {
  workspacePath: null,
  activeFile: null,
  selection: null,
  diagnostics: [],
};

type SessionTreeIndex = ReturnType<typeof createSessionTreeIndex>;
type MessageIndex = ReturnType<typeof createMessageIndex>;
type StreamingDeltaQueue = ReturnType<typeof createStreamingDeltaQueue>;

export interface AppStateInstance {
  state: Store<AppState>;
  setState: SetStoreFunction<AppState>;
  showThinking: Accessor<boolean>;
  setShowThinking: Setter<boolean>;
  expandThinkingByDefault: Accessor<boolean>;
  setExpandThinkingByDefault: Setter<boolean>;
  showStickyUserPrompt: Accessor<boolean>;
  setShowStickyUserPrompt: Setter<boolean>;
  desktopSessionPaneSide: Accessor<DesktopSessionPaneSide>;
  setDesktopSessionPaneSide: Setter<DesktopSessionPaneSide>;
  providerLimitPollIntervalSeconds: Accessor<number>;
  setProviderLimitPollIntervalSeconds: Setter<number>;
  providerLimitThresholdPercent: Accessor<number>;
  setProviderLimitThresholdPercent: Setter<number>;
  inputText: Accessor<string>;
  setInputText: Setter<string>;
  nextPastedImageIndex: Accessor<number>;
  setNextPastedImageIndex: Setter<number>;
  isLoading: Accessor<boolean>;
  setIsLoading: Setter<boolean>;
  loadingStartedAt: Accessor<number | null>;
  setLoadingStartedAt: Setter<number | null>;
  loadingLastActivityAt: Accessor<number | null>;
  setLoadingLastActivityAt: Setter<number | null>;
  error: Accessor<string | null>;
  setError: Setter<string | null>;
  showSessionPicker: Accessor<boolean>;
  setShowSessionPicker: Setter<boolean>;
  showModelPicker: Accessor<boolean>;
  setShowModelPicker: Setter<boolean>;
  showSettings: Accessor<boolean>;
  setShowSettings: Setter<boolean>;
  composerFocusKey: Accessor<number>;
  setComposerFocusKey: Setter<number>;
  openAttentionSessionsKey: Accessor<number>;
  setOpenAttentionSessionsKey: Setter<number>;
  messageListScrollRequestKey: Accessor<number>;
  setMessageListScrollRequestKey: Setter<number>;
  messageStructureVersion: Accessor<number>;
  setMessageStructureVersion: Setter<number>;
  draftPermissionMode: Accessor<PermissionMode>;
  setDraftPermissionMode: Setter<PermissionMode>;
  theme: Accessor<WebviewThemeKind>;
  setTheme: Setter<WebviewThemeKind>;
  sessionMarkerWorkspaceScope: string;
  permissionWorkspace: string | null;
  sessionTreeIndex: SessionTreeIndex;
  messageIndex: MessageIndex;
  streamingDeltaQueue: StreamingDeltaQueue;
}

export function createAppState(): AppStateInstance {
  const initialWebviewState = readInitialWebviewState();
  const sessionMarkerWorkspaceScope = getSessionMarkerWorkspaceScope(
    initialWebviewState.editorContext?.workspacePath
  );
  const sessionMarkerStorage = { readStored, writeStored };
  const initialLastSeenSessions = readInitialSessionMarkerScope(
    sessionMarkerStorage,
    STORAGE_KEYS.lastSeenSessions,
    sessionMarkerWorkspaceScope
  );
  const initialSkippedPlanSessions = readInitialSessionMarkerScope(
    sessionMarkerStorage,
    STORAGE_KEYS.skippedPlanSessions,
    sessionMarkerWorkspaceScope
  );

  const [state, setState] = createStore<AppState>({
    serverStatus: initialWebviewState.serverStatus ?? { state: 'stopped' },
    providersLoaded: false,
    editorContext: initialWebviewState.editorContext ?? defaultEditorContext,
    terminalSelection: initialWebviewState.terminalSelection ?? null,
    emptyStateLogoUri: initialWebviewState.emptyStateLogoUri ?? '',
    draftCurrentDocumentEnabled: null,
    droppedFiles: initialWebviewState.droppedFiles ?? [],
    clipboardImages: [],
    sessions: [],
    recycleBinEntries: initialWebviewState.recycleBinEntries ?? [],
    activeSessionId: null,
    currentDocumentEnabledBySession: {},
    sessionStatus: {},
    messages: [],
    todos: [],
    permissions: normalizeInitialPermissions(initialWebviewState.pendingPermissions),
    questions: normalizeInitialQuestions(initialWebviewState.pendingQuestions),
    diffs: [],
    streamingPartId: null,
    streamingText: '',
    agents: [],
    allAgents: [],
    commands: [],
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
    lastSeenSessions: initialLastSeenSessions,
    skippedPlanSessions: initialSkippedPlanSessions,
    compactingSessionIds: [],
    queuedMessages: [],
    failedSessionIds: [],
    sessionUsageLimits: {},
    interruptedSessionIds: initialWebviewState.interruptedSessionIds ?? [],
  });

  const [showThinking, setShowThinking] = createSignal(readShowThinking());
  const [expandThinkingByDefault, setExpandThinkingByDefault] = createSignal(
    readExpandThinkingByDefault(initialWebviewState)
  );
  const [showStickyUserPrompt, setShowStickyUserPrompt] = createSignal(
    readShowStickyUserPrompt(initialWebviewState)
  );
  const [desktopSessionPaneSide, setDesktopSessionPaneSide] = createSignal<DesktopSessionPaneSide>(
    readDesktopSessionPaneSide(initialWebviewState)
  );
  const [providerLimitPollIntervalSeconds, setProviderLimitPollIntervalSeconds] = createSignal(
    readProviderLimitPollIntervalSeconds(initialWebviewState)
  );
  const [providerLimitThresholdPercent, setProviderLimitThresholdPercent] = createSignal(
    readProviderLimitThresholdPercent(initialWebviewState)
  );
  const [inputText, setInputText] = createSignal('');
  const [nextPastedImageIndex, setNextPastedImageIndex] = createSignal(1);
  const [isLoading, setIsLoading] = createSignal(false);
  const [loadingStartedAt, setLoadingStartedAt] = createSignal<number | null>(null);
  const [loadingLastActivityAt, setLoadingLastActivityAt] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [showSessionPicker, setShowSessionPicker] = createSignal(false);
  const [showModelPicker, setShowModelPicker] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [composerFocusKey, setComposerFocusKey] = createSignal(0);
  const [openAttentionSessionsKey, setOpenAttentionSessionsKey] = createSignal(0);
  const [messageListScrollRequestKey, setMessageListScrollRequestKey] = createSignal(0);
  const [messageStructureVersion, setMessageStructureVersion] = createSignal(0);
  const sessionTreeIndex = createSessionTreeIndex();
  const messageIndex = createMessageIndex(() => {
    setMessageStructureVersion((value) => value + 1);
  });
  const permissionWorkspace: string | null =
    initialWebviewState.editorContext?.workspacePath ?? null;
  const [draftPermissionMode, setDraftPermissionMode] = createSignal<PermissionMode>(
    resolveInitialDraftMode(permissionWorkspace)
  );
  const [theme, setTheme] = createSignal<WebviewThemeKind>(
    initialWebviewState.theme ||
      ((window as unknown as Record<string, string>).__initialTheme as WebviewThemeKind) ||
      'dark'
  );

  const appState = {
    state,
    setState,
    showThinking,
    setShowThinking,
    expandThinkingByDefault,
    setExpandThinkingByDefault,
    showStickyUserPrompt,
    setShowStickyUserPrompt,
    desktopSessionPaneSide,
    setDesktopSessionPaneSide,
    providerLimitPollIntervalSeconds,
    setProviderLimitPollIntervalSeconds,
    providerLimitThresholdPercent,
    setProviderLimitThresholdPercent,
    inputText,
    setInputText,
    nextPastedImageIndex,
    setNextPastedImageIndex,
    isLoading,
    setIsLoading,
    loadingStartedAt,
    setLoadingStartedAt,
    loadingLastActivityAt,
    setLoadingLastActivityAt,
    error,
    setError,
    showSessionPicker,
    setShowSessionPicker,
    showModelPicker,
    setShowModelPicker,
    showSettings,
    setShowSettings,
    composerFocusKey,
    setComposerFocusKey,
    openAttentionSessionsKey,
    setOpenAttentionSessionsKey,
    messageListScrollRequestKey,
    setMessageListScrollRequestKey,
    messageStructureVersion,
    setMessageStructureVersion,
    draftPermissionMode,
    setDraftPermissionMode,
    theme,
    setTheme,
    sessionMarkerWorkspaceScope,
    permissionWorkspace,
    sessionTreeIndex,
    messageIndex,
    streamingDeltaQueue: null as unknown as StreamingDeltaQueue,
  } satisfies AppStateInstance;

  appState.streamingDeltaQueue = createStreamingDeltaQueue(() => {
    flushPendingStreamingDeltasFor(appState);
  });

  return appState;
}

export const defaultAppState = createAppState();

export const state = defaultAppState.state;
export const setState = defaultAppState.setState;
export const showThinking = defaultAppState.showThinking;
export const setShowThinking = defaultAppState.setShowThinking;
export const expandThinkingByDefault = defaultAppState.expandThinkingByDefault;
export const setExpandThinkingByDefault = defaultAppState.setExpandThinkingByDefault;
export const showStickyUserPrompt = defaultAppState.showStickyUserPrompt;
export const setShowStickyUserPrompt = defaultAppState.setShowStickyUserPrompt;
export const desktopSessionPaneSide = defaultAppState.desktopSessionPaneSide;
export const setDesktopSessionPaneSide = defaultAppState.setDesktopSessionPaneSide;
export const providerLimitPollIntervalSeconds = defaultAppState.providerLimitPollIntervalSeconds;
export const setProviderLimitPollIntervalSeconds =
  defaultAppState.setProviderLimitPollIntervalSeconds;
export const providerLimitThresholdPercent = defaultAppState.providerLimitThresholdPercent;
export const setProviderLimitThresholdPercent = defaultAppState.setProviderLimitThresholdPercent;
export const inputText = defaultAppState.inputText;
export const setInputText = defaultAppState.setInputText;
export const nextPastedImageIndex = defaultAppState.nextPastedImageIndex;
export const setNextPastedImageIndex = defaultAppState.setNextPastedImageIndex;
export const isLoading = defaultAppState.isLoading;
export const setIsLoading = defaultAppState.setIsLoading;
export const loadingStartedAt = defaultAppState.loadingStartedAt;
export const setLoadingStartedAt = defaultAppState.setLoadingStartedAt;
export const loadingLastActivityAt = defaultAppState.loadingLastActivityAt;
export const setLoadingLastActivityAt = defaultAppState.setLoadingLastActivityAt;
export const error = defaultAppState.error;
export const setError = defaultAppState.setError;
export const showSessionPicker = defaultAppState.showSessionPicker;
export const setShowSessionPicker = defaultAppState.setShowSessionPicker;
export const showModelPicker = defaultAppState.showModelPicker;
export const setShowModelPicker = defaultAppState.setShowModelPicker;
export const showSettings = defaultAppState.showSettings;
export const setShowSettings = defaultAppState.setShowSettings;
export const composerFocusKey = defaultAppState.composerFocusKey;
export const setComposerFocusKey = defaultAppState.setComposerFocusKey;
export const openAttentionSessionsKey = defaultAppState.openAttentionSessionsKey;
export const setOpenAttentionSessionsKey = defaultAppState.setOpenAttentionSessionsKey;
export const messageListScrollRequestKey = defaultAppState.messageListScrollRequestKey;
export const setMessageListScrollRequestKey = defaultAppState.setMessageListScrollRequestKey;
export const messageStructureVersion = defaultAppState.messageStructureVersion;
export const setMessageStructureVersion = defaultAppState.setMessageStructureVersion;
export const draftPermissionMode = defaultAppState.draftPermissionMode;
export const setDraftPermissionMode = defaultAppState.setDraftPermissionMode;
export const theme = defaultAppState.theme;
export const setTheme = defaultAppState.setTheme;

const sessionTreeIndex = defaultAppState.sessionTreeIndex;
const messageIndex = defaultAppState.messageIndex;
const streamingDeltaQueue = defaultAppState.streamingDeltaQueue;

export function resetDefaultAppState() {
  const next = createAppState();
  setState(reconcile(next.state));
  setShowThinking(next.showThinking());
  setExpandThinkingByDefault(next.expandThinkingByDefault());
  setShowStickyUserPrompt(next.showStickyUserPrompt());
  setDesktopSessionPaneSide(next.desktopSessionPaneSide());
  setProviderLimitPollIntervalSeconds(next.providerLimitPollIntervalSeconds());
  setProviderLimitThresholdPercent(next.providerLimitThresholdPercent());
  setInputText(next.inputText());
  setNextPastedImageIndex(next.nextPastedImageIndex());
  setIsLoading(next.isLoading());
  setLoadingStartedAt(next.loadingStartedAt());
  setLoadingLastActivityAt(next.loadingLastActivityAt());
  setError(next.error());
  setShowSessionPicker(next.showSessionPicker());
  setShowModelPicker(next.showModelPicker());
  setShowSettings(next.showSettings());
  setComposerFocusKey(next.composerFocusKey());
  setOpenAttentionSessionsKey(next.openAttentionSessionsKey());
  setMessageListScrollRequestKey(next.messageListScrollRequestKey());
  setMessageStructureVersion(next.messageStructureVersion());
  setDraftPermissionMode(next.draftPermissionMode());
  setTheme(next.theme());
  defaultAppState.sessionMarkerWorkspaceScope = next.sessionMarkerWorkspaceScope;
  defaultAppState.permissionWorkspace = next.permissionWorkspace;
  sessionTreeIndex.invalidate();
  messageIndex.invalidate();
  streamingDeltaQueue.reset();
}

function getSessionMarkerWorkspaceScopeValue() {
  return defaultAppState.sessionMarkerWorkspaceScope;
}

function setSessionMarkerWorkspaceScopeValue(value: string) {
  defaultAppState.sessionMarkerWorkspaceScope = value;
}

function getPermissionWorkspaceValue() {
  return defaultAppState.permissionWorkspace;
}

function setPermissionWorkspaceValue(value: string | null) {
  defaultAppState.permissionWorkspace = value;
}

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
      ? ((value.time as { created: number }).created ?? Date.now())
      : Date.now();
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

function stableSerializePermissionValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerializePermissionValue(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerializePermissionValue(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function getPermissionGroupMembers(permission: Permission): PermissionGroupMember[] {
  if (permission.groupMembers?.length) {
    return permission.groupMembers.map((member) => ({ ...member }));
  }

  return [
    {
      id: permission.id,
      sessionID: permission.sessionID,
      messageID: permission.messageID,
      callID: permission.callID,
    },
  ];
}

export function getPermissionSignature(permission: Permission): string {
  const pattern = Array.isArray(permission.pattern)
    ? [...permission.pattern]
    : (permission.pattern ?? null);
  return stableSerializePermissionValue({
    type: permission.type,
    pattern,
    sessionID: permission.sessionID,
    title: permission.title,
    metadata: permission.metadata,
  });
}

export function groupPermissions(permissions: Permission[]): Permission[] {
  const grouped = new Map<string, Permission>();
  const sortedPermissions = [...permissions].toSorted((a, b) => a.time.created - b.time.created);

  for (const permission of sortedPermissions) {
    const signature = getPermissionSignature(permission);
    const existing = grouped.get(signature);
    if (!existing) {
      grouped.set(signature, {
        ...permission,
        duplicateIDs: [
          ...new Set(getPermissionGroupMembers(permission).map((member) => member.id)),
        ],
        groupMembers: getPermissionGroupMembers(permission),
      });
      continue;
    }

    const existingMembers = getPermissionGroupMembers(existing);
    const incomingMembers = getPermissionGroupMembers(permission);
    existing.groupMembers = [...existingMembers, ...incomingMembers];
    existing.duplicateIDs = [...new Set(existing.groupMembers.map((member) => member.id))];
  }

  return [...grouped.values()];
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
  return groupPermissions(
    values
      .map((item) =>
        item && typeof item === 'object'
          ? normalizeInitialPermission(item as Record<string, unknown>)
          : null
      )
      .filter((item): item is Permission => item !== null)
  );
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
  const nextSessions = nextSeenSessions(state.lastSeenSessions, id, updatedAt);
  if (!nextSessions) return;
  setState('lastSeenSessions', reconcile(nextSessions));
  writeScopedSessionMarkerState(
    { readStored, writeStored },
    STORAGE_KEYS.lastSeenSessions,
    getSessionMarkerWorkspaceScopeValue(),
    nextSessions
  );
}

export function clearSessionSeen(id: string) {
  const nextSessions = removeSessionMarker(state.lastSeenSessions, id);
  if (!nextSessions) return;
  setState('lastSeenSessions', reconcile(nextSessions));
  writeScopedSessionMarkerState(
    { readStored, writeStored },
    STORAGE_KEYS.lastSeenSessions,
    getSessionMarkerWorkspaceScopeValue(),
    nextSessions
  );
}

export function skipPlanSession(sessionId: string, updatedAt?: number) {
  const next = nextSkippedPlanSessions(
    state.skippedPlanSessions,
    state.sessions,
    sessionId,
    updatedAt
  );
  if (!next) return;
  setState('skippedPlanSessions', reconcile(next));
  writeScopedSessionMarkerState(
    { readStored, writeStored },
    STORAGE_KEYS.skippedPlanSessions,
    getSessionMarkerWorkspaceScopeValue(),
    next
  );
}

export function clearSkippedPlanSession(sessionId: string) {
  const nextSessions = removeSessionMarker(state.skippedPlanSessions, sessionId);
  if (!nextSessions) return;
  setState('skippedPlanSessions', reconcile(nextSessions));
  writeScopedSessionMarkerState(
    { readStored, writeStored },
    STORAGE_KEYS.skippedPlanSessions,
    getSessionMarkerWorkspaceScopeValue(),
    nextSessions
  );
}

export function isSkippedPlanSession(sessionId: string, updatedAt: number) {
  return isSkippedPlanSessionMarker(state.skippedPlanSessions, sessionId, updatedAt);
}

export function isSessionUnread(sessionId: string, updatedAt: number) {
  return isSessionUnreadMarker(state.lastSeenSessions, sessionId, updatedAt);
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

export function toggleThinking() {
  const next = !showThinking();
  setShowThinkingPreference(next);
}

export function setShowThinkingPreference(next: boolean) {
  setShowThinking(next);
  writeStored(STORAGE_KEYS.showThinking, next);
}

export function setExpandThinkingByDefaultPreference(next: boolean) {
  setExpandThinkingByDefault(next);
  writeStored(STORAGE_KEYS.expandThinkingByDefault, next);
}

export function setShowStickyUserPromptPreference(next: boolean) {
  setShowStickyUserPrompt(next);
  writeStored(STORAGE_KEYS.showStickyUserPrompt, next);
}

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
  if (!sid) return false;
  const rootId = getSessionTreeRootId(sid) || sid;
  const sessionIds = new Set(getSessionTreeIds(rootId));
  return state.questions.some((question) => sessionIds.has(question.sessionID));
}

export function hasActivePermission() {
  const sid = state.activeSessionId;
  if (!sid) return false;
  const rootId = getSessionTreeRootId(sid) || sid;
  const sessionIds = new Set(getSessionTreeIds(rootId));
  return state.permissions.some((permission) => sessionIds.has(permission.sessionID));
}

export function isSessionAwaitingInput(sessionId: string) {
  const rootId = getSessionTreeRootId(sessionId) || sessionId;
  const sessionIds = new Set(getSessionTreeIds(rootId));
  return [
    ...state.permissions.map((permission) => permission.sessionID),
    ...state.questions.map((question) => question.sessionID),
  ].some((candidateSessionId) => sessionIds.has(candidateSessionId));
}

export function requestComposerFocus() {
  setComposerFocusKey((value) => value + 1);
}

export function requestOpenAttentionSessions() {
  setOpenAttentionSessionsKey((value) => value + 1);
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

function readExpandThinkingByDefault(
  initialWebviewState: Partial<InitialWebviewState> = readInitialWebviewState()
): boolean {
  return (
    initialWebviewState.expandThinkingByDefault ??
    readStored<boolean>(STORAGE_KEYS.expandThinkingByDefault) ??
    false
  );
}

function readShowStickyUserPrompt(
  initialWebviewState: Partial<InitialWebviewState> = readInitialWebviewState()
): boolean {
  return (
    initialWebviewState.showStickyUserPrompt ??
    readStored<boolean>(STORAGE_KEYS.showStickyUserPrompt) ??
    true
  );
}

function readDesktopSessionPaneSide(
  initialWebviewState: Partial<InitialWebviewState> = readInitialWebviewState()
): DesktopSessionPaneSide {
  return initialWebviewState.desktopSessionPaneSide === 'right' ? 'right' : 'left';
}

function resolveInitialDraftMode(permissionWorkspace: string | null): PermissionMode {
  if (permissionWorkspace) {
    const modes =
      readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
    if (modes[permissionWorkspace]) return modes[permissionWorkspace];
  }
  return readStored<PermissionMode>(STORAGE_KEYS.draftPermissionMode) || 'default';
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
  const permissionWorkspace = getPermissionWorkspaceValue();
  const projectMode = permissionWorkspace && modes[permissionWorkspace];
  setDraftPermissionMode(projectMode || 'default');
  writeStored(STORAGE_KEYS.draftPermissionMode, null);
}

export function syncDraftPermissionForWorkspace(workspacePath: string | null) {
  const permissionWorkspace = workspacePath?.replace(/\\/g, '/').replace(/\/+$/, '') || null;
  setPermissionWorkspaceValue(permissionWorkspace);
  const modes =
    readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
  const mode =
    permissionWorkspace && modes[permissionWorkspace] ? modes[permissionWorkspace] : 'default';
  setDraftPermissionMode(mode);
}

export function saveProjectPermissionMode(mode: PermissionMode) {
  const permissionWorkspace = getPermissionWorkspaceValue();
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
  if (!text.includes(placeholder)) return;
  setInputText(text.split(placeholder).join('_____'));
}

export function resetPastedImageIndex() {
  setNextPastedImageIndex(1);
}

export function setQuestions(questions: QuestionRequest[]) {
  setState('questions', questions);
}

export function setCommands(commands: Command[]) {
  setState('commands', commands);
}

export function setSessions(nextSessions: Session[]) {
  setState('sessions', nextSessions);
  const nextMarkers = pruneSkippedPlanSessions(
    state.skippedPlanSessions,
    new Set(nextSessions.map((session) => session.id))
  );
  if (nextMarkers) {
    setState('skippedPlanSessions', reconcile(nextMarkers));
    writeScopedSessionMarkerState(
      { readStored, writeStored },
      STORAGE_KEYS.skippedPlanSessions,
      getSessionMarkerWorkspaceScopeValue(),
      nextMarkers
    );
  }
  sessionTreeIndex.invalidate();
}

export function syncSessionMarkersForWorkspace(workspacePath: string | null | undefined) {
  const scope = getSessionMarkerWorkspaceScope(workspacePath);
  setSessionMarkerWorkspaceScopeValue(scope);
  setState(
    'lastSeenSessions',
    reconcile(
      readScopedSessionMarkerState(
        { readStored, writeStored },
        STORAGE_KEYS.lastSeenSessions,
        scope
      )
    )
  );
  setState(
    'skippedPlanSessions',
    reconcile(
      readScopedSessionMarkerState(
        { readStored, writeStored },
        STORAGE_KEYS.skippedPlanSessions,
        scope
      )
    )
  );
}

export function setRecycleBinEntries(entries: RecycleBinEntry[]) {
  setState('recycleBinEntries', entries);
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

function flushPendingStreamingDeltasFor(appState: AppStateInstance) {
  const deltas = appState.streamingDeltaQueue.takeAll();
  if (deltas.length === 0) return;
  const latest = deltas[deltas.length - 1];
  let appendedPart = false;
  let committedPreviousStreamingPart = false;

  batch(() => {
    if (appState.state.streamingPartId && appState.state.streamingPartId !== latest.partId) {
      const previousLocation = appState.messageIndex.findPartLocation(
        appState.state.messages,
        appState.state.streamingPartId
      );
      if (previousLocation) {
        const previousPart =
          appState.state.messages[previousLocation.msgIdx]?.parts[previousLocation.partIdx];
        if (
          previousPart &&
          (previousPart.type === 'text' || previousPart.type === 'reasoning') &&
          previousPart.text !== appState.state.streamingText
        ) {
          appState.setState(
            'messages',
            previousLocation.msgIdx,
            'parts',
            previousLocation.partIdx,
            (currentPart) => {
              if (currentPart.type !== 'text' && currentPart.type !== 'reasoning') {
                return currentPart;
              }
              return {
                ...currentPart,
                text: appState.state.streamingText,
              };
            }
          );
          committedPreviousStreamingPart = true;
        }
      }
    }

    appState.setState('streamingPartId', latest.partId);
    appState.setState('streamingText', latest.text);

    for (const item of deltas) {
      const location = appState.messageIndex.findPartLocation(appState.state.messages, item.partId);
      if (location) {
        continue;
      }

      const msgIdx = appState.messageIndex.findMessageIndex(
        appState.state.messages,
        item.messageId
      );
      if (msgIdx === -1) continue;
      appState.setState('messages', msgIdx, 'parts', (parts) => [
        ...parts,
        {
          id: item.partId,
          messageID: item.messageId,
          sessionID: item.sessionId || appState.state.messages[msgIdx].info.sessionID,
          type: 'text' as const,
          text: item.text,
        },
      ]);
      appendedPart = true;
      appState.messageIndex.appendPart(appState.state.messages, item.partId, {
        msgIdx,
        partIdx: appState.state.messages[msgIdx].parts.length - 1,
      });
    }

    if (!appendedPart && committedPreviousStreamingPart) {
      // Keep the part index fresh after committing the previously active streaming part.
      appState.messageIndex.ensureIndex(appState.state.messages);
    }
  });
}

function flushPendingStreamingDeltas() {
  flushPendingStreamingDeltasFor(defaultAppState);
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
        if (msgs[idx].info === info) return;
        msgs[idx].info = info;
        messageIndex.invalidate();
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
      messageIndex.appendPart(msgs, part.id, {
        msgIdx: idx,
        partIdx: msgs[idx].parts.length - 1,
      });
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
        messageIndex.invalidate();
      }
    })
  );
}

export function getMessageById(id: string) {
  const index = messageIndex.findMessageIndex(state.messages, id);
  return index === -1 ? null : state.messages[index] || null;
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
  if (pending && pending.messageId !== messageId) {
    flushPendingStreamingDeltas();
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
          messageIndex.removePart(msgs, partId, location);
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
      if (
        perms.find(
          (p) =>
            p.id === permission.id ||
            p.duplicateIDs?.includes(permission.id) ||
            p.groupMembers?.some((member) => member.id === permission.id)
        )
      ) {
        return;
      }
      perms.splice(0, perms.length, ...groupPermissions([...perms, permission]));
    })
  );
}

export function removePermission(permissionId: string) {
  setState(
    'permissions',
    produce((perms) => {
      const idx = perms.findIndex(
        (p) =>
          p.id === permissionId ||
          p.duplicateIDs?.includes(permissionId) ||
          p.groupMembers?.some((member) => member.id === permissionId)
      );
      if (idx === -1) return;
      const permission = perms[idx];
      const groupMembers = getPermissionGroupMembers(permission).filter(
        (member) => member.id !== permissionId
      );
      if (groupMembers.length === 0) {
        perms.splice(idx, 1);
        return;
      }

      const nextLeader = groupMembers[0];
      permission.id = nextLeader.id;
      permission.sessionID = nextLeader.sessionID;
      permission.messageID = nextLeader.messageID;
      permission.callID = nextLeader.callID;
      permission.groupMembers = groupMembers.length > 1 ? groupMembers : undefined;
      permission.duplicateIDs =
        groupMembers.length > 1 ? groupMembers.map((member) => member.id) : undefined;
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

export function syncFailedSessionsFromMessages(messages: MessageEntry[] = state.messages) {
  const failedSessionIds = new Set<string>();
  const scopedSessionIds = new Set<string>();

  const latestBySession = new Map<string, Message>();
  for (const entry of messages) {
    scopedSessionIds.add(entry.info.sessionID);
    latestBySession.set(entry.info.sessionID, entry.info);
  }

  for (const [sessionId, info] of latestBySession) {
    if (info.role !== 'assistant' || !info.error) continue;
    if (isAbortedAssistantError(info.error)) continue;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) continue;
    failedSessionIds.add(sessionId);
  }

  setState('failedSessionIds', [
    ...state.failedSessionIds.filter((sessionId) => !scopedSessionIds.has(sessionId)),
    ...failedSessionIds,
  ]);
}

export function replaceMessages(incoming: MessageEntry[]) {
  const nextMessages = cloneMessageEntries(incoming);
  streamingDeltaQueue.reset();
  batch(() => {
    setState('messages', nextMessages);
    if (state.streamingPartId !== null) setState('streamingPartId', null);
    if (state.streamingText !== '') setState('streamingText', '');
  });
  messageIndex.invalidate();
}

export function setMessagesIncremental(
  incoming: MessageEntry[],
  options?: { preserveExtraParts?: boolean }
) {
  const current = state.messages;
  if (current === incoming) return;
  clearStreamingState();
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
        const nextEntry = mergeMessageEntry(msgs[i], next, options);
        if (i < sharedPrefixLength) {
          if (!areMessageEntriesEquivalent(msgs[i], nextEntry)) {
            msgs[i] = nextEntry;
            changed = true;
          }
          continue;
        }

        if (i < msgs.length) {
          if (!areMessageEntriesEquivalent(msgs[i], nextEntry)) {
            msgs[i] = nextEntry;
            changed = true;
          }
        } else {
          msgs.push(nextEntry);
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

function mergeMessageEntry(
  current: MessageEntry | undefined,
  incoming: MessageEntry,
  options?: { preserveExtraParts?: boolean }
) {
  const next = cloneValue(incoming);
  if (!current || !options?.preserveExtraParts || current.parts.length === 0) {
    return next;
  }

  const incomingPartIds = new Set(next.parts.map((part) => part.id));
  for (const part of current.parts) {
    if (!incomingPartIds.has(part.id)) {
      next.parts.push(cloneValue(part));
    }
  }

  return next;
}

function cloneMessageEntries(entries: MessageEntry[]) {
  return entries.map((entry) => cloneValue(entry));
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        cloneValue(entry),
      ])
    ) as T;
  }
  return value;
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
