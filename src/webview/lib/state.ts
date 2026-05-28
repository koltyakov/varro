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
  ModelVariantSelections,
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
  WorkspaceStatusEventSummary,
} from '../../shared/protocol';
import type {
  ProviderAuthMethodsByProvider,
  WorkspaceStatusEntry,
} from '../../shared/opencode-types';
import {
  readProviderLimitPollIntervalSeconds,
  readProviderLimitThresholdPercent,
} from '../../shared/provider-limit-config';
import { mergeContextFile } from '../../shared/context-files';
import type { UsageLimitNotice } from './usage-limit';
import { isAbortedAssistantError } from './aborted';
import {
  clearClipboardImageAttachmentSequences,
  clearContextFileAttachmentSequences,
  ensureClipboardImageAttachmentSequence,
  ensureContextFileAttachmentSequence,
  removeClipboardImageAttachmentSequence,
  removeContextFileAttachmentSequence,
  resetAttachmentOrderState,
  seedClipboardImageAttachmentSequences,
  seedContextFileAttachmentSequences,
} from './attachment-order';
import { createMessageIndex } from './message-index';
import {
  getSessionMarkerWorkspaceScope,
  isSessionCompletedResponseUnreadMarker,
  isSessionUnreadMarker,
  isSkippedPlanSessionMarker,
  nextCompletedSessionResponses,
  nextSeenSessions,
  nextSkippedPlanSessions,
  pruneSessionMarkers,
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
  modelVariantSelections: ModelVariantSelections;
  sessionSelectedMcps: SessionSelectedMcps;
  hiddenProviders: string[];
  hiddenModels: string[];
  lastSeenSessions: Record<string, number>;
  completedSessionResponses: Record<string, number>;
  skippedPlanSessions: Record<string, number>;
  compactingSessionIds: string[];
  queuedMessages: QueuedMessage[];
  failedSessionIds: string[];
  sessionUsageLimits: Record<string, UsageLimitNotice | null>;
  interruptedSessionIds: string[];
  providerAuthMethods: ProviderAuthMethodsByProvider;
  workspaceStatuses: WorkspaceStatusEntry[];
  workspaceStatusSummary: WorkspaceStatusEventSummary;
}

export type LastOpenedView =
  | { type: 'new-session'; timestamp: number }
  | { type: 'sessions-list'; timestamp: number }
  | { type: 'session'; sessionId: string; timestamp: number };

type LastOpenedViewInput =
  | { type: 'new-session' }
  | { type: 'sessions-list' }
  | { type: 'session'; sessionId: string };

export const MAX_CLIPBOARD_IMAGES = 5;
const MAX_CLIPBOARD_IMAGE_SIZE = 5 * 1024 * 1024;
const EMPTY_SESSION_TREE_IDS: string[] = [];
const EMPTY_CHILD_RUNS_BY_PARENT_ID = new Map<
  string,
  Array<{ info: AssistantMessage; parts: Part[] }>
>();
const permissionGroupMemberCache = new WeakMap<Permission, PermissionGroupMember[]>();

let cachedChildRunsByParentIdMessages: Array<{ info: Message; parts: Part[] }> | null = null;
let cachedChildRunsByParentIdVersion = -1;
let cachedChildRunsByParentId = EMPTY_CHILD_RUNS_BY_PARENT_ID;

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
  messageInfoVersion: Accessor<number>;
  setMessageInfoVersion: Setter<number>;
  defaultPermissionMode: Accessor<PermissionMode>;
  setDefaultPermissionMode: Setter<PermissionMode>;
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
  resetAttachmentOrderState();
  seedContextFileAttachmentSequences(initialWebviewState.droppedFiles ?? []);
  seedClipboardImageAttachmentSequences([]);
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
  const initialCompletedSessionResponses = readInitialSessionMarkerScope(
    sessionMarkerStorage,
    STORAGE_KEYS.completedSessionResponses,
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
    modelVariantSelections:
      readStored<ModelVariantSelections>(STORAGE_KEYS.modelVariantSelections) || {},
    sessionSelectedMcps: readStored<SessionSelectedMcps>(STORAGE_KEYS.sessionSelectedMcps) || {},
    hiddenProviders: readStored<string[]>(STORAGE_KEYS.hiddenProviders) || [],
    hiddenModels: readStored<string[]>(STORAGE_KEYS.hiddenModels) || [],
    lastSeenSessions: initialLastSeenSessions,
    completedSessionResponses: initialCompletedSessionResponses,
    skippedPlanSessions: initialSkippedPlanSessions,
    compactingSessionIds: [],
    queuedMessages: [],
    failedSessionIds: [],
    sessionUsageLimits: {},
    interruptedSessionIds: initialWebviewState.interruptedSessionIds ?? [],
    providerAuthMethods: {},
    workspaceStatuses: [],
    workspaceStatusSummary: { entries: [] },
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
  const [messageInfoVersion, setMessageInfoVersion] = createSignal(0);
  const sessionTreeIndex = createSessionTreeIndex();
  const messageIndex = createMessageIndex({
    onInvalidate: () => {
      setMessageStructureVersion((value) => value + 1);
      setMessageInfoVersion((value) => value + 1);
    },
    onPartChange: () => {
      setMessageStructureVersion((value) => value + 1);
    },
  });
  const permissionWorkspace: string | null =
    initialWebviewState.editorContext?.workspacePath ?? null;
  const [defaultPermissionMode, setDefaultPermissionMode] = createSignal<PermissionMode>(
    initialWebviewState.defaultPermissionMode === 'full' ? 'full' : 'default'
  );
  const [draftPermissionMode, setDraftPermissionMode] = createSignal<PermissionMode>(
    resolveInitialDraftMode(permissionWorkspace, defaultPermissionMode())
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
    messageInfoVersion,
    setMessageInfoVersion,
    defaultPermissionMode,
    setDefaultPermissionMode,
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
export function setPersistentShowSessionPicker(value: boolean) {
  setShowSessionPicker(value);
  if (value) {
    persistLastOpenedView({ type: 'sessions-list' });
    return;
  }
  persistLastOpenedView(
    state.activeSessionId
      ? { type: 'session', sessionId: state.activeSessionId }
      : { type: 'new-session' }
  );
}
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
export const messageInfoVersion = defaultAppState.messageInfoVersion;
export const setMessageInfoVersion = defaultAppState.setMessageInfoVersion;
export const defaultPermissionMode = defaultAppState.defaultPermissionMode;
export const setDefaultPermissionModeSignal = defaultAppState.setDefaultPermissionMode;
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
  setMessageInfoVersion(next.messageInfoVersion());
  setDefaultPermissionModeSignal(next.defaultPermissionMode());
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
    return permission.groupMembers;
  }

  const cachedMembers = permissionGroupMemberCache.get(permission);
  const cachedMember = cachedMembers?.[0];
  if (
    cachedMember &&
    cachedMember.id === permission.id &&
    cachedMember.sessionID === permission.sessionID &&
    cachedMember.messageID === permission.messageID &&
    cachedMember.callID === permission.callID
  ) {
    return cachedMembers;
  }

  const members = [
    {
      id: permission.id,
      sessionID: permission.sessionID,
      messageID: permission.messageID,
      callID: permission.callID,
    },
  ];
  permissionGroupMemberCache.set(permission, members);
  return members;
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

function normalizeLastOpenedView(value: unknown): LastOpenedView | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const timestamp = typeof record.timestamp === 'number' ? record.timestamp : null;
  if (timestamp === null || !Number.isFinite(timestamp)) return null;

  if (record.type === 'new-session') return { type: 'new-session', timestamp };
  if (record.type === 'sessions-list') return { type: 'sessions-list', timestamp };
  if (record.type === 'session' && typeof record.sessionId === 'string') {
    return { type: 'session', sessionId: record.sessionId, timestamp };
  }
  return null;
}

export function persistLastOpenedView(view: LastOpenedViewInput, now = Date.now()) {
  writeStored(STORAGE_KEYS.lastOpenedView, { ...view, timestamp: now });
}

export function getPersistedLastOpenedView(): LastOpenedView | null {
  return normalizeLastOpenedView(readStored<unknown>(STORAGE_KEYS.lastOpenedView));
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
  setState('lastSeenSessions', id, nextSessions[id]);
  writeScopedSessionMarkerState(
    { readStored, writeStored },
    STORAGE_KEYS.lastSeenSessions,
    getSessionMarkerWorkspaceScopeValue(),
    nextSessions
  );
}

export function markSessionResponseCompleted(id: string, completedAt?: number) {
  const nextSessions = nextCompletedSessionResponses(
    state.completedSessionResponses,
    id,
    completedAt
  );
  if (!nextSessions) return;
  setState('completedSessionResponses', id, nextSessions[id]);
  writeScopedSessionMarkerState(
    { readStored, writeStored },
    STORAGE_KEYS.completedSessionResponses,
    getSessionMarkerWorkspaceScopeValue(),
    nextSessions
  );
}

export function clearSessionSeen(id: string) {
  const nextSessions = removeSessionMarker(state.lastSeenSessions, id);
  if (!nextSessions) return;
  setState(
    'lastSeenSessions',
    produce((draft) => {
      delete draft[id];
    })
  );
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
  setState('skippedPlanSessions', sessionId, next[sessionId]);
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
  setState(
    'skippedPlanSessions',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
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

export function isSessionCompletedResponseUnread(sessionId: string) {
  return isSessionCompletedResponseUnreadMarker(
    state.completedSessionResponses,
    state.lastSeenSessions,
    sessionId
  );
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

export function isSessionStatusWorking(status: SessionStatus | null | undefined) {
  return status?.type === 'busy' || status?.type === 'retry';
}

export function isSessionTreeStatusWorking(
  sessionId: string | null | undefined,
  statuses: Record<string, SessionStatus | undefined> = state.sessionStatus
) {
  if (!sessionId) return false;

  const rootId = getSessionTreeRootId(sessionId) || sessionId;
  const sessionIds = new Set(getSessionTreeIds(rootId));
  return [...sessionIds].some((candidateSessionId) =>
    isSessionStatusWorking(statuses[candidateSessionId])
  );
}

export function isActiveSessionWorking() {
  return isLoading() || isSessionCompacting() || isSessionTreeStatusWorking(state.activeSessionId);
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

  const sessionMode = state.sessionPermissionModes[sessionId];
  if (sessionMode) return sessionMode;

  const parentId = state.sessions.find((session) => session.id === sessionId)?.parentID;
  if (parentId) return getPermissionModeForSession(parentId);

  return 'default';
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

function resolveInitialDraftMode(
  permissionWorkspace: string | null,
  fallbackMode: PermissionMode
): PermissionMode {
  if (permissionWorkspace) {
    const modes =
      readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
    if (Object.hasOwn(modes, permissionWorkspace)) return modes[permissionWorkspace];
  }
  return readStored<PermissionMode>(STORAGE_KEYS.draftPermissionMode) || fallbackMode;
}

function resolveProjectDraftModeForCurrentWorkspace(fallbackMode = defaultPermissionMode()) {
  const permissionWorkspace = getPermissionWorkspaceValue();
  if (!permissionWorkspace) return fallbackMode;
  const modes =
    readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
  return Object.hasOwn(modes, permissionWorkspace) ? modes[permissionWorkspace] : fallbackMode;
}

function hasPersistedDraftPermissionMode(permissionWorkspace: string | null): boolean {
  if (permissionWorkspace) {
    const modes =
      readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
    if (Object.hasOwn(modes, permissionWorkspace)) return true;
  }
  return readStored<PermissionMode>(STORAGE_KEYS.draftPermissionMode) !== null;
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
    writeStored(STORAGE_KEYS.draftPermissionMode, mode);
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
  setState(
    'sessionPermissionModes',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
  writeStored(STORAGE_KEYS.sessionPermissionModes, nextModes);
}

export function getSelectedModelForSession(
  sessionId: string | null | undefined
): SelectedModel | null {
  if (!sessionId) return null;
  return state.sessionSelectedModels[sessionId] || null;
}

export function getModelVariantSelectionKey(providerID: string, modelID: string) {
  return `${providerID}:${modelID}`;
}

export function getStoredVariantForModel(
  providerID: string | null | undefined,
  modelID: string | null | undefined
): string | null {
  if (!providerID || !modelID) return null;
  return state.modelVariantSelections[getModelVariantSelectionKey(providerID, modelID)] || null;
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

  if (model?.variant) {
    const key = getModelVariantSelectionKey(model.providerID, model.modelID);
    if (state.modelVariantSelections[key] !== model.variant) {
      const nextSelections = { ...state.modelVariantSelections, [key]: model.variant };
      setState('modelVariantSelections', nextSelections);
      writeStored(STORAGE_KEYS.modelVariantSelections, nextSelections);
    }
  }

  if (sessionId) {
    if (model) {
      setState('sessionSelectedModels', sessionId, model);
    } else {
      setState(
        'sessionSelectedModels',
        produce((draft) => {
          delete draft[sessionId];
        })
      );
    }
    writeStored(STORAGE_KEYS.sessionSelectedModels, { ...state.sessionSelectedModels });
  }
}

export function clearSelectedModelForSession(sessionId: string) {
  if (!state.sessionSelectedModels[sessionId]) return;
  setState(
    'sessionSelectedModels',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
  writeStored(STORAGE_KEYS.sessionSelectedModels, { ...state.sessionSelectedModels });
}

export function setMcpStatus(status: Record<string, McpStatus>) {
  setState('mcpStatus', status);
}

export function getAvailableMcpNames() {
  return Object.keys(state.mcpStatus).toSorted((a, b) => a.localeCompare(b));
}

export function setSelectedMcpsForSession(sessionId: string, names: string[]) {
  const nextNames = [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
  setState('sessionSelectedMcps', sessionId, nextNames);
  writeStored(STORAGE_KEYS.sessionSelectedMcps, { ...state.sessionSelectedMcps });
}

export function clearSelectedMcpsForSession(sessionId: string) {
  if (!state.sessionSelectedMcps[sessionId]) return;
  setState(
    'sessionSelectedMcps',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
  writeStored(STORAGE_KEYS.sessionSelectedMcps, { ...state.sessionSelectedMcps });
}

export function resetDraftPermissionMode() {
  setDraftPermissionMode(resolveProjectDraftModeForCurrentWorkspace());
  writeStored(STORAGE_KEYS.draftPermissionMode, null);
}

export function syncDraftPermissionForWorkspace(workspacePath: string | null) {
  const permissionWorkspace = workspacePath?.replace(/\\/g, '/').replace(/\/+$/, '') || null;
  setPermissionWorkspaceValue(permissionWorkspace);
  setDraftPermissionMode(resolveProjectDraftModeForCurrentWorkspace());
}

export function saveProjectPermissionMode(mode: PermissionMode) {
  const permissionWorkspace = getPermissionWorkspaceValue();
  if (!permissionWorkspace) return;
  const modes =
    readStored<Record<string, PermissionMode>>(STORAGE_KEYS.projectPermissionModes) || {};
  modes[permissionWorkspace] = mode;
  writeStored(STORAGE_KEYS.projectPermissionModes, modes);
}

export function setDefaultPermissionModePreference(mode: PermissionMode) {
  setDefaultPermissionModeSignal(mode);
  if (!hasPersistedDraftPermissionMode(getPermissionWorkspaceValue())) {
    setDraftPermissionMode(mode);
  }
}

export function addContextFile(file: DroppedFile) {
  const attachmentSequence = ensureContextFileAttachmentSequence(
    file.path,
    file.attachmentSequence
  );
  setState(
    'droppedFiles',
    produce((files) => {
      const idx = files.findIndex((f) => f.path === file.path);
      if (idx === -1) {
        files.push({ ...file, attachmentSequence });
        return;
      }
      files[idx] = { ...mergeContextFile(files[idx], file), attachmentSequence };
    })
  );
}

export function addContextFiles(files: DroppedFile[]) {
  if (files.length === 0) return;
  setState(
    'droppedFiles',
    produce((current) => {
      for (const file of files) {
        const attachmentSequence = ensureContextFileAttachmentSequence(
          file.path,
          file.attachmentSequence
        );
        const idx = current.findIndex((item) => item.path === file.path);
        if (idx === -1) {
          current.push({ ...file, attachmentSequence });
          continue;
        }
        current[idx] = { ...mergeContextFile(current[idx], file), attachmentSequence };
      }
    })
  );
}

export function removeContextFile(path: string) {
  removeContextFileAttachmentSequence(path);
  setState(
    'droppedFiles',
    produce((files) => {
      const idx = files.findIndex((f) => f.path === path);
      if (idx !== -1) files.splice(idx, 1);
    })
  );
}

export function clearContextFiles() {
  clearContextFileAttachmentSequences();
  setState('droppedFiles', []);
}

export function addClipboardImage(image: ClipboardImage) {
  if (image.size > MAX_CLIPBOARD_IMAGE_SIZE) return false;

  const duplicateKey = image.contentKey ?? image.url;
  if (state.clipboardImages.some((item) => (item.contentKey ?? item.url) === duplicateKey)) {
    return false;
  }

  const attachmentSequence = ensureClipboardImageAttachmentSequence(
    image.id,
    image.attachmentSequence
  );
  setState(
    'clipboardImages',
    produce((images) => {
      if (images.length >= MAX_CLIPBOARD_IMAGES) {
        const removed = images.shift();
        if (removed) removeClipboardImageAttachmentSequence(removed.id);
      }
      if (!images.find((item) => item.id === image.id)) {
        images.push({ ...image, attachmentSequence });
      }
    })
  );

  return true;
}

export function removeClipboardImage(id: string) {
  const image = state.clipboardImages.find((item) => item.id === id);
  removeClipboardImageAttachmentSequence(id);
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
  clearClipboardImageAttachmentSequences();
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

export function setProviderAuthMethods(methods: ProviderAuthMethodsByProvider) {
  setState('providerAuthMethods', methods);
}

export function setWorkspaceStatuses(entries: WorkspaceStatusEntry[]) {
  setState('workspaceStatuses', entries);
}

export function setWorkspaceStatusSummary(summary: WorkspaceStatusEventSummary) {
  setState('workspaceStatusSummary', summary);
}

export function setCommands(commands: Command[]) {
  setState('commands', commands);
}

export function setSessions(nextSessions: Session[]) {
  setState('sessions', nextSessions);
  const sessionIds = new Set(nextSessions.map((session) => session.id));
  const nextMarkers = pruneSkippedPlanSessions(state.skippedPlanSessions, sessionIds);
  if (nextMarkers) {
    setState(
      'skippedPlanSessions',
      produce((draft) => {
        for (const id of Object.keys(draft)) {
          if (!sessionIds.has(id)) delete draft[id];
        }
      })
    );
    writeScopedSessionMarkerState(
      { readStored, writeStored },
      STORAGE_KEYS.skippedPlanSessions,
      getSessionMarkerWorkspaceScopeValue(),
      nextMarkers
    );
  }
  const nextCompletedMarkers = pruneSessionMarkers(state.completedSessionResponses, sessionIds);
  if (nextCompletedMarkers) {
    setState(
      'completedSessionResponses',
      produce((draft) => {
        for (const id of Object.keys(draft)) {
          if (!sessionIds.has(id)) delete draft[id];
        }
      })
    );
    writeScopedSessionMarkerState(
      { readStored, writeStored },
      STORAGE_KEYS.completedSessionResponses,
      getSessionMarkerWorkspaceScopeValue(),
      nextCompletedMarkers
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
  setState(
    'completedSessionResponses',
    reconcile(
      readScopedSessionMarkerState(
        { readStored, writeStored },
        STORAGE_KEYS.completedSessionResponses,
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
    if (agent) {
      setState('sessionSelectedAgents', sessionId, agent);
    } else {
      setState(
        'sessionSelectedAgents',
        produce((draft) => {
          delete draft[sessionId];
        })
      );
    }
    writeStored(STORAGE_KEYS.sessionSelectedAgents, { ...state.sessionSelectedAgents });
  }
}

export function clearSelectedAgentForSession(sessionId: string) {
  if (!state.sessionSelectedAgents[sessionId]) return;
  setState(
    'sessionSelectedAgents',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
  writeStored(STORAGE_KEYS.sessionSelectedAgents, { ...state.sessionSelectedAgents });
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
        const currentPart = appState.state.messages[location.msgIdx]?.parts[location.partIdx];
        if (
          item.partId !== latest.partId &&
          currentPart?.type === 'text' &&
          currentPart.text !== item.text &&
          shouldUseStreamingText(currentPart.text, item.text)
        ) {
          appState.setState('messages', location.msgIdx, 'parts', location.partIdx, {
            ...currentPart,
            text: item.text,
          });
          committedPreviousStreamingPart = true;
        }
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
        if (areMessageEntriesEquivalent(msgs[idx], msg)) return;
        msgs[idx] = msg;
        messageIndex.invalidate();
      } else {
        msgs.push(msg);
        messageIndex.invalidate();
      }
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
  const nextPart = materializeStreamingTextInPart(part, getStreamingTextSnapshot());
  const msgId = (nextPart as { messageID: string }).messageID;
  batch(() => {
    setState(
      'messages',
      produce((msgs) => {
        const idx = messageIndex.findMessageIndex(msgs, msgId);
        if (idx === -1) return;
        const location = messageIndex.findPartLocation(msgs, nextPart.id);
        if (location && location.msgIdx === idx) {
          msgs[idx].parts[location.partIdx] = nextPart;
          return;
        }

        msgs[idx].parts.push(nextPart);
        messageIndex.appendPart(msgs, nextPart.id, {
          msgIdx: idx,
          partIdx: msgs[idx].parts.length - 1,
        });
      })
    );
    if (state.streamingPartId === nextPart.id) {
      setState('streamingPartId', null);
      setState('streamingText', '');
    }
  });
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
        messageIndex.notifyPartContentChange();
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

export function finishMessageStreaming(messageId: string) {
  flushPendingStreamingDeltas();
  const partId = state.streamingPartId;
  if (!partId) return;

  const location = messageIndex.findPartLocation(state.messages, partId);
  if (!location) return;

  const message = state.messages[location.msgIdx];
  if (!message || message.info.id !== messageId) return;

  streamingDeltaQueue.reset();
  batch(() => {
    setState('messages', location.msgIdx, 'parts', location.partIdx, (currentPart) => {
      if (currentPart.type !== 'text' && currentPart.type !== 'reasoning') return currentPart;
      if (currentPart.text === state.streamingText) return currentPart;
      return {
        ...currentPart,
        text: state.streamingText,
      };
    });
    setState('streamingPartId', null);
    setState('streamingText', '');
  });
  messageIndex.notifyPartContentChange();
}

export function removeMessagePart(sessionId: string, messageId: string, partId: string) {
  flushPendingStreamingDeltas();
  batch(() => {
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
      setState('streamingPartId', null);
      setState('streamingText', '');
    }
  });
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

      const signature = getPermissionSignature(permission);
      const existingIndex = perms.findIndex((p) => getPermissionSignature(p) === signature);

      if (existingIndex === -1) {
        perms.push({
          ...permission,
          duplicateIDs: [...new Set(getPermissionGroupMembers(permission).map((m) => m.id))],
          groupMembers: getPermissionGroupMembers(permission),
        });
        return;
      }

      const existing = perms[existingIndex]!;
      const incomingMembers = getPermissionGroupMembers(permission);
      const merged = [
        ...(existing.groupMembers || getPermissionGroupMembers(existing)),
        ...incomingMembers,
      ];
      const mergedIds = [...new Set(merged.map((m) => m.id))];

      if (permission.time.created < existing.time.created) {
        perms[existingIndex] = {
          ...permission,
          groupMembers: merged,
          duplicateIDs: mergedIds,
        };
      } else {
        existing.groupMembers = merged;
        existing.duplicateIDs = mergedIds;
      }
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
  streamingDeltaQueue.reset();
  batch(() => {
    setState('messages', []);
    setState('todos', []);
    setState('diffs', []);
    setState('streamingPartId', null);
    setState('streamingText', '');
  });
  messageIndex.invalidate();
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

  if (notice === null) {
    if (state.sessionUsageLimits[sessionId] === undefined) return;
    setState(
      'sessionUsageLimits',
      produce((limits) => {
        delete limits[sessionId];
      })
    );
    sessionTreeIndex.invalidate();
    return;
  }

  setState('sessionUsageLimits', {
    ...state.sessionUsageLimits,
    [sessionId]: notice,
  });
  sessionTreeIndex.invalidate();
}

export function getSessionTreeIds(rootId: string | null | undefined, sessions = state.sessions) {
  if (!rootId) return EMPTY_SESSION_TREE_IDS;
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

type StreamingTextSnapshot = { partId: string; text: string } | null;

export function replaceMessages(incoming: MessageEntry[]) {
  flushPendingStreamingDeltas();
  const streamingSnapshot = getStreamingTextSnapshot();
  const nextMessages = cloneMessageEntries(incoming);
  materializeStreamingText(nextMessages, streamingSnapshot);
  streamingDeltaQueue.reset();
  batch(() => {
    setState('messages', nextMessages);
    if (state.streamingPartId !== null) setState('streamingPartId', null);
    if (state.streamingText !== '') setState('streamingText', '');
  });
  messageIndex.invalidate();
  settleRunningSessionStatusesFromMessages(nextMessages);
}

export function setMessagesIncremental(
  incoming: MessageEntry[],
  options?: { preserveExtraParts?: boolean }
) {
  flushPendingStreamingDeltas();
  const current = state.messages;
  const streamingSnapshot = getStreamingTextSnapshot();
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

  streamingDeltaQueue.reset();
  batch(() => {
    if (state.streamingPartId !== null) setState('streamingPartId', null);
    if (state.streamingText !== '') setState('streamingText', '');

    setState(
      'messages',
      produce((msgs) => {
        let changed = false;
        let startIndex = 0;
        while (startIndex < sharedPrefixLength && msgs[startIndex] === incoming[startIndex]) {
          startIndex += 1;
        }

        for (let i = startIndex; i < incoming.length; i++) {
          const next = incoming[i];
          const currentEntry = msgs[i];
          if (
            currentEntry &&
            areMessageEntriesEquivalent(currentEntry, next) &&
            !hasExtraMessagePartsToPreserve(currentEntry, next, options) &&
            !hasStreamingTextToMaterialize(currentEntry, next, options, streamingSnapshot)
          ) {
            continue;
          }

          const nextEntry = mergeMessageEntry(currentEntry, next, options, streamingSnapshot);
          if (i < sharedPrefixLength) {
            if (!areMessageEntriesEquivalent(currentEntry, nextEntry)) {
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
  });
  settleRunningSessionStatusesFromMessages(incoming);
}

export function hasSettledLatestAssistantMessage(
  sessionId: string,
  messages: MessageEntry[] = state.messages
) {
  const latest = getLatestMessageInfoForSession(sessionId, messages);
  return latest?.role === 'assistant' && (!!latest.error || !!latest.time.completed);
}

export function hasCompletedLatestAssistantMessage(
  sessionId: string,
  messages: MessageEntry[] = state.messages
) {
  const latest = getLatestMessageInfoForSession(sessionId, messages);
  return latest?.role === 'assistant' && !latest.error && !!latest.time.completed;
}

function settleRunningSessionStatusesFromMessages(messages: MessageEntry[]) {
  const settledMessages = getSettledLatestAssistantMessages(messages);
  if (settledMessages.size === 0) return;

  batch(() => {
    for (const [sessionId, message] of settledMessages) {
      const status = state.sessionStatus[sessionId];
      if (status?.type === 'busy' || status?.type === 'retry') {
        setState('sessionStatus', sessionId, { type: 'idle' });
      }
      if (message.error) continue;
      if (state.activeSessionId === sessionId && !showSessionPicker()) {
        markSessionSeen(sessionId, message.time.completed);
      } else {
        markSessionResponseCompleted(sessionId, message.time.completed);
      }
    }
  });
}

function getSettledLatestAssistantMessages(messages: MessageEntry[]) {
  const latestBySession = new Map<string, Message>();
  for (const entry of messages) {
    latestBySession.set(entry.info.sessionID, entry.info);
  }

  const settled = new Map<string, AssistantMessage>();
  for (const [sessionId, message] of latestBySession) {
    if (message.role !== 'assistant') continue;
    if (!message.error && !message.time.completed) continue;
    settled.set(sessionId, message);
  }
  return settled;
}

function getLatestMessageInfoForSession(sessionId: string, messages: MessageEntry[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.sessionID === sessionId) return info;
  }
  return null;
}

function mergeMessageEntry(
  current: MessageEntry | undefined,
  incoming: MessageEntry,
  options?: { preserveExtraParts?: boolean },
  streamingSnapshot?: StreamingTextSnapshot
) {
  const next = cloneValue(incoming);
  if (!current || !options?.preserveExtraParts || current.parts.length === 0) {
    materializeStreamingTextInEntry(next, streamingSnapshot ?? null);
    return next;
  }

  const incomingPartIds = new Set(next.parts.map((part) => part.id));
  for (const part of current.parts) {
    if (!incomingPartIds.has(part.id)) {
      next.parts.push(cloneValue(part));
    }
  }

  materializeStreamingTextInEntry(next, streamingSnapshot ?? null);
  return next;
}

function getStreamingTextSnapshot(): StreamingTextSnapshot {
  return state.streamingPartId
    ? { partId: state.streamingPartId, text: state.streamingText }
    : null;
}

function materializeStreamingText(
  entries: MessageEntry[],
  streamingSnapshot: StreamingTextSnapshot
) {
  if (!streamingSnapshot) return;
  for (const entry of entries) {
    materializeStreamingTextInEntry(entry, streamingSnapshot);
  }
}

function materializeStreamingTextInEntry(
  entry: MessageEntry,
  streamingSnapshot: StreamingTextSnapshot
) {
  if (!streamingSnapshot) return;
  for (let index = 0; index < entry.parts.length; index += 1) {
    const part = entry.parts[index];
    if (part.id !== streamingSnapshot.partId) continue;
    const nextPart = materializeStreamingTextInPart(part, streamingSnapshot);
    if (nextPart !== part) entry.parts[index] = nextPart;
    return;
  }
}

function materializeStreamingTextInPart(
  part: Part,
  streamingSnapshot: StreamingTextSnapshot
): Part {
  if (!streamingSnapshot || part.id !== streamingSnapshot.partId) return part;
  if (!isStreamingTextPart(part)) return part;
  if (!shouldUseStreamingText(part.text, streamingSnapshot.text)) return part;
  if (part.text === streamingSnapshot.text) return part;
  return { ...part, text: streamingSnapshot.text };
}

function hasStreamingTextToMaterialize(
  current: MessageEntry | undefined,
  incoming: MessageEntry,
  options: { preserveExtraParts?: boolean } | undefined,
  streamingSnapshot: StreamingTextSnapshot
) {
  if (!streamingSnapshot) return false;

  const incomingPart = incoming.parts.find((part) => part.id === streamingSnapshot.partId);
  if (incomingPart) {
    return (
      isStreamingTextPart(incomingPart) &&
      incomingPart.text !== streamingSnapshot.text &&
      shouldUseStreamingText(incomingPart.text, streamingSnapshot.text)
    );
  }

  if (!current || !options?.preserveExtraParts) return false;
  const currentPart = current.parts.find((part) => part.id === streamingSnapshot.partId);
  return (
    !!currentPart &&
    isStreamingTextPart(currentPart) &&
    currentPart.text !== streamingSnapshot.text &&
    shouldUseStreamingText(currentPart.text, streamingSnapshot.text)
  );
}

function isStreamingTextPart(part: Part): part is Extract<Part, { type: 'text' | 'reasoning' }> {
  return part.type === 'text' || part.type === 'reasoning';
}

function shouldUseStreamingText(currentText: string, streamingText: string) {
  if (currentText === streamingText) return true;
  if (!streamingText) return false;
  return streamingText.startsWith(currentText);
}

function hasExtraMessagePartsToPreserve(
  current: MessageEntry,
  incoming: MessageEntry,
  options?: { preserveExtraParts?: boolean }
) {
  if (!options?.preserveExtraParts || current.parts.length <= incoming.parts.length) return false;

  const incomingPartIds = new Set(incoming.parts.map((part) => part.id));
  return current.parts.some((part) => !incomingPartIds.has(part.id));
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
  if (
    messages === state.messages &&
    cachedChildRunsByParentIdMessages === messages &&
    cachedChildRunsByParentIdVersion === messageStructureVersion()
  ) {
    return cachedChildRunsByParentId;
  }

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

  if (messages === state.messages) {
    cachedChildRunsByParentIdMessages = messages;
    cachedChildRunsByParentIdVersion = messageStructureVersion();
    cachedChildRunsByParentId = map;
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
