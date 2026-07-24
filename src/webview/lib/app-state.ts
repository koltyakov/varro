import { createSignal } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { SetStoreFunction, Store } from 'solid-js/store';
import type {
  Session,
  Permission,
  QuestionRequest,
  NormalizedTodo,
  SessionStatus,
  FileDiff,
  Agent,
  Command,
  Provider,
  MessageEntry,
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
  McpStatus,
  PermissionMode,
  ProviderLimitStatus,
  RecycleBinEntry,
  ServerStatus,
  WebviewThemeKind,
  WorkspaceStatusEventSummary,
} from '../../shared/protocol';
import { isPermissionMode } from '../../shared/protocol';
import type {
  ProviderAuthMethodsByProvider,
  WorkspaceStatusEntry,
} from '../../shared/opencode-types';
import {
  readProviderLimitPollIntervalSeconds,
  readProviderLimitThresholdPercent,
} from '../../shared/provider-limit-config';
import type { UsageLimitNotice } from './usage-limit';
import {
  resetAttachmentOrderState,
  seedClipboardImageAttachmentSequences,
  seedContextFileAttachmentSequences,
} from './attachment-order';
import { createMessageIndex } from './message-index';
import {
  activePermissionReconciliations,
  finishPermissionReconciliation,
  normalizeInitialPermissions,
  normalizeInitialQuestions,
} from './permission-grouping';
import {
  getSessionMarkerWorkspaceScope,
  readInitialSessionMarkerScope,
} from './state-session-markers';
import { createSessionTreeIndex } from './session-tree-index';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';
import {
  readDesktopSessionPaneSide,
  readExpandThinkingByDefault,
  readInitialWebviewState,
  readShowThinking,
  readStoredBooleanRecord,
  readStoredPermissionModes,
  readStoredQueuedMessages,
  readStoredSelectedModel,
  readStoredSelectedModels,
  readStoredString,
  readStoredStringArray,
  readStoredStringArrayRecord,
  readStoredStringRecord,
  resolveInitialDraftMode,
} from './state-stored-values';
import { createStreamingDeltaQueue, flushPendingStreamingDeltasFor } from './streaming-deltas';

export interface AppState {
  serverStatus: ServerStatus;
  providersLoaded: boolean;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  emptyStateLogoUri: string;
  currentDocumentEnabled: boolean;
  draftCurrentDocumentEnabled: boolean | null;
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
  sessions: Session[];
  pinnedSessionIds: string[];
  recycleBinEntries: RecycleBinEntry[];
  activeSessionId: string | null;
  currentDocumentEnabledBySession: Record<string, boolean>;
  sessionStatus: Record<string, SessionStatus>;
  messages: MessageEntry[];
  todos: NormalizedTodo[];
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
  queuedMessageDispatchingId: string | null;
  failedQueuedMessageIds: string[];
  queuedMessageEdit: { id: string; sessionId: string } | null;
  failedSessionIds: string[];
  sessionMessageCounts: Record<string, number>;
  sessionUsageLimits: Record<string, UsageLimitNotice | null>;
  interruptedSessionIds: string[];
  providerAuthMethods: ProviderAuthMethodsByProvider;
  workspaceStatuses: WorkspaceStatusEntry[];
  workspaceStatusSummary: WorkspaceStatusEventSummary;
}

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
  showInlineFileChanges: Accessor<boolean>;
  setShowInlineFileChanges: Setter<boolean>;
  showChangedFiles: Accessor<boolean>;
  setShowChangedFiles: Setter<boolean>;
  desktopSessionPaneSide: Accessor<DesktopSessionPaneSide>;
  setDesktopSessionPaneSide: Setter<DesktopSessionPaneSide>;
  providerLimitPollIntervalSeconds: Accessor<number>;
  setProviderLimitPollIntervalSeconds: Setter<number>;
  providerLimitThresholdPercent: Accessor<number>;
  setProviderLimitThresholdPercent: Setter<number>;
  inputText: Accessor<string>;
  setInputText: Setter<string>;
  inputTextMutationVersion: Accessor<number>;
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
  connectionInitialized: Accessor<boolean>;
  setConnectionInitialized: Setter<boolean>;
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
  sessionSearchFocusKey: Accessor<number>;
  setSessionSearchFocusKey: Setter<number>;
  messageListScrollRequestKey: Accessor<number>;
  setMessageListScrollRequestKey: Setter<number>;
  messageStructureVersion: Accessor<number>;
  setMessageStructureVersion: Setter<number>;
  messageInfoVersion: Accessor<number>;
  setMessageInfoVersion: Setter<number>;
  sessionUsageLimitVersion: Accessor<number>;
  setSessionUsageLimitVersion: Setter<number>;
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
  const currentDocumentWorkspace =
    initialWebviewState.editorContext?.workspacePath?.replace(/\\/g, '/').replace(/\/+$/, '') ||
    null;
  const projectCurrentDocumentEnabled = readStoredBooleanRecord(
    STORAGE_KEYS.projectCurrentDocumentEnabled
  );
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
    currentDocumentEnabled: currentDocumentWorkspace
      ? (projectCurrentDocumentEnabled[currentDocumentWorkspace] ?? true)
      : true,
    draftCurrentDocumentEnabled: null,
    droppedFiles: initialWebviewState.droppedFiles ?? [],
    clipboardImages: [],
    sessions: [],
    pinnedSessionIds: initialWebviewState.pinnedSessionIds ?? [],
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
    sessionPermissionModes: readStoredPermissionModes(STORAGE_KEYS.sessionPermissionModes),
    selectedAgent: readStoredString(STORAGE_KEYS.selectedAgent),
    sessionSelectedAgents: readStoredStringRecord(STORAGE_KEYS.sessionSelectedAgents),
    selectedModel: readStoredSelectedModel(STORAGE_KEYS.selectedModel),
    sessionSelectedModels: readStoredSelectedModels(STORAGE_KEYS.sessionSelectedModels),
    modelVariantSelections: readStoredStringRecord(STORAGE_KEYS.modelVariantSelections),
    sessionSelectedMcps: readStoredStringArrayRecord(STORAGE_KEYS.sessionSelectedMcps),
    hiddenProviders: readStoredStringArray(STORAGE_KEYS.hiddenProviders),
    hiddenModels: readStoredStringArray(STORAGE_KEYS.hiddenModels),
    lastSeenSessions: initialLastSeenSessions,
    completedSessionResponses: initialCompletedSessionResponses,
    skippedPlanSessions: initialSkippedPlanSessions,
    compactingSessionIds: [],
    queuedMessages: readStoredQueuedMessages(),
    queuedMessageDispatchingId: null,
    failedQueuedMessageIds: [],
    queuedMessageEdit: null,
    failedSessionIds: [],
    sessionMessageCounts: {},
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
  const [showInlineFileChanges, setShowInlineFileChanges] = createSignal(
    initialWebviewState.showInlineFileChanges ?? false
  );
  const [showChangedFiles, setShowChangedFiles] = createSignal(
    initialWebviewState.showChangedFiles ?? false
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
  const [inputText, setInputTextValue] = createSignal('');
  const [inputTextMutationVersion, setInputTextMutationVersion] = createSignal(0);
  const setInputText: Setter<string> = (value) => {
    setInputTextMutationVersion((version) => version + 1);
    return setInputTextValue(value);
  };
  const [nextPastedImageIndex, setNextPastedImageIndex] = createSignal(1);
  const [isLoading, setIsLoading] = createSignal(false);
  const [loadingStartedAt, setLoadingStartedAt] = createSignal<number | null>(null);
  const [loadingLastActivityAt, setLoadingLastActivityAt] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [connectionInitialized, setConnectionInitialized] = createSignal(false);
  const [showSessionPicker, setShowSessionPicker] = createSignal(false);
  const [showModelPicker, setShowModelPicker] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [composerFocusKey, setComposerFocusKey] = createSignal(0);
  const [openAttentionSessionsKey, setOpenAttentionSessionsKey] = createSignal(0);
  const [sessionSearchFocusKey, setSessionSearchFocusKey] = createSignal(0);
  const [messageListScrollRequestKey, setMessageListScrollRequestKey] = createSignal(0);
  const [messageStructureVersion, setMessageStructureVersion] = createSignal(0);
  const [messageInfoVersion, setMessageInfoVersion] = createSignal(0);
  const [sessionUsageLimitVersion, setSessionUsageLimitVersion] = createSignal(0);
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
    isPermissionMode(initialWebviewState.defaultPermissionMode)
      ? initialWebviewState.defaultPermissionMode
      : 'default'
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
    showInlineFileChanges,
    setShowInlineFileChanges,
    showChangedFiles,
    setShowChangedFiles,
    desktopSessionPaneSide,
    setDesktopSessionPaneSide,
    providerLimitPollIntervalSeconds,
    setProviderLimitPollIntervalSeconds,
    providerLimitThresholdPercent,
    setProviderLimitThresholdPercent,
    inputText,
    setInputText,
    inputTextMutationVersion,
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
    connectionInitialized,
    setConnectionInitialized,
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
    sessionSearchFocusKey,
    setSessionSearchFocusKey,
    messageListScrollRequestKey,
    setMessageListScrollRequestKey,
    messageStructureVersion,
    setMessageStructureVersion,
    messageInfoVersion,
    setMessageInfoVersion,
    sessionUsageLimitVersion,
    setSessionUsageLimitVersion,
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
export const showInlineFileChanges = defaultAppState.showInlineFileChanges;
export const setShowInlineFileChanges = defaultAppState.setShowInlineFileChanges;
export const showChangedFiles = defaultAppState.showChangedFiles;
export const setShowChangedFiles = defaultAppState.setShowChangedFiles;
export const desktopSessionPaneSide = defaultAppState.desktopSessionPaneSide;
export const setDesktopSessionPaneSide = defaultAppState.setDesktopSessionPaneSide;
export const providerLimitPollIntervalSeconds = defaultAppState.providerLimitPollIntervalSeconds;
export const setProviderLimitPollIntervalSeconds =
  defaultAppState.setProviderLimitPollIntervalSeconds;
export const providerLimitThresholdPercent = defaultAppState.providerLimitThresholdPercent;
export const setProviderLimitThresholdPercent = defaultAppState.setProviderLimitThresholdPercent;
export const inputText = defaultAppState.inputText;
export const setInputText = defaultAppState.setInputText;
export const inputTextMutationVersion = defaultAppState.inputTextMutationVersion;
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
export const connectionInitialized = defaultAppState.connectionInitialized;
export const setConnectionInitialized = defaultAppState.setConnectionInitialized;
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
export const sessionSearchFocusKey = defaultAppState.sessionSearchFocusKey;
export const setSessionSearchFocusKey = defaultAppState.setSessionSearchFocusKey;
export const messageListScrollRequestKey = defaultAppState.messageListScrollRequestKey;
export const setMessageListScrollRequestKey = defaultAppState.setMessageListScrollRequestKey;
export const messageStructureVersion = defaultAppState.messageStructureVersion;
export const setMessageStructureVersion = defaultAppState.setMessageStructureVersion;
export const messageInfoVersion = defaultAppState.messageInfoVersion;
export const setMessageInfoVersion = defaultAppState.setMessageInfoVersion;
export const sessionUsageLimitVersion = defaultAppState.sessionUsageLimitVersion;
export const setSessionUsageLimitVersion = defaultAppState.setSessionUsageLimitVersion;
export const defaultPermissionMode = defaultAppState.defaultPermissionMode;
export const setDefaultPermissionModeSignal = defaultAppState.setDefaultPermissionMode;
export const draftPermissionMode = defaultAppState.draftPermissionMode;
export const setDraftPermissionMode = defaultAppState.setDraftPermissionMode;
export const theme = defaultAppState.theme;
export const setTheme = defaultAppState.setTheme;

export const sessionTreeIndex = defaultAppState.sessionTreeIndex;
export const messageIndex = defaultAppState.messageIndex;
export const streamingDeltaQueue = defaultAppState.streamingDeltaQueue;

export function resetDefaultAppState() {
  for (const reconciliation of activePermissionReconciliations) {
    finishPermissionReconciliation(reconciliation);
  }
  const next = createAppState();
  setState(reconcile(next.state));
  setShowThinking(next.showThinking());
  setExpandThinkingByDefault(next.expandThinkingByDefault());
  setShowInlineFileChanges(next.showInlineFileChanges());
  setShowChangedFiles(next.showChangedFiles());
  setDesktopSessionPaneSide(next.desktopSessionPaneSide());
  setProviderLimitPollIntervalSeconds(next.providerLimitPollIntervalSeconds());
  setProviderLimitThresholdPercent(next.providerLimitThresholdPercent());
  setInputText(next.inputText());
  setNextPastedImageIndex(next.nextPastedImageIndex());
  setIsLoading(next.isLoading());
  setLoadingStartedAt(next.loadingStartedAt());
  setLoadingLastActivityAt(next.loadingLastActivityAt());
  setError(next.error());
  setConnectionInitialized(next.connectionInitialized());
  setShowSessionPicker(next.showSessionPicker());
  setShowModelPicker(next.showModelPicker());
  setShowSettings(next.showSettings());
  setComposerFocusKey(next.composerFocusKey());
  setOpenAttentionSessionsKey(next.openAttentionSessionsKey());
  setSessionSearchFocusKey(next.sessionSearchFocusKey());
  setMessageListScrollRequestKey(next.messageListScrollRequestKey());
  setMessageStructureVersion(next.messageStructureVersion());
  setMessageInfoVersion(next.messageInfoVersion());
  setSessionUsageLimitVersion((value) => value + 1);
  setDefaultPermissionModeSignal(next.defaultPermissionMode());
  setDraftPermissionMode(next.draftPermissionMode());
  setTheme(next.theme());
  defaultAppState.sessionMarkerWorkspaceScope = next.sessionMarkerWorkspaceScope;
  defaultAppState.permissionWorkspace = next.permissionWorkspace;
  sessionTreeIndex.invalidate();
  messageIndex.invalidate();
  streamingDeltaQueue.reset();
}

export function getSessionMarkerWorkspaceScopeValue() {
  return defaultAppState.sessionMarkerWorkspaceScope;
}

export function setSessionMarkerWorkspaceScopeValue(value: string) {
  defaultAppState.sessionMarkerWorkspaceScope = value;
}

export function getPermissionWorkspaceValue() {
  return defaultAppState.permissionWorkspace;
}

export function setPermissionWorkspaceValue(value: string | null) {
  defaultAppState.permissionWorkspace = value;
}
