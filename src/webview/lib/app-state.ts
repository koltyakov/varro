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
  AttachedDiagnostics,
  ClipboardImage,
  NativePdfAttachment,
  ModelVariantSelections,
  QueuedMessage,
  SelectedModel,
  SessionSelectedAgents,
  SessionSelectedMcps,
  SessionSelectedModels,
} from './app-state-types';
import type {
  AutoApproveActivity,
  DesktopSessionPaneSide,
  EditorContext,
  DroppedFile,
  LspStatus,
  McpStatus,
  PermissionMode,
  ProviderLimitStatus,
  RecycleBinEntry,
  RestartBlockedState,
  ServerStatus,
  WebviewThemeKind,
  WorkspaceStatusEventSummary,
} from '../../shared/protocol';
import { isPermissionMode } from '../../shared/protocol';
import { mergeContextFile } from '../../shared/context-files';
import type {
  ProviderAuthMethodsByProvider,
  WorkspaceStatusEntry,
} from '../../shared/opencode-types';
import type { UsageLimitNotice } from './usage-limit';
import {
  resetAttachmentOrderState,
  seedClipboardImageAttachmentSequences,
  seedContextFileAttachmentSequences,
} from './attachment-order';
import { createMessageIndex } from './message-index';
import { asRecord, isString } from './runtime-values';

function isWebviewThemeKind<T>(value: T): value is T & WebviewThemeKind {
  return (
    isString(value) &&
    (value === 'light' ||
      value === 'dark' ||
      value === 'high-contrast' ||
      value === 'high-contrast-light')
  );
}
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
  readInitialWebviewState,
  readShowThinking,
  readStoredBooleanRecord,
  normalizeStoredClipboardImage,
  readStoredDroppedFiles,
  readStoredPermissionModes,
  readStoredQueuedMessageEdit,
  readStoredQueuedMessages,
  readStoredNullableStringRecord,
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
  restartBlocked: RestartBlockedState | null;
  providersLoaded: boolean;
  providerRefreshPending: boolean;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  attachedDiagnostics: AttachedDiagnostics | null;
  emptyStateLogoUri: string;
  currentDocumentEnabled: boolean;
  draftCurrentDocumentEnabled: boolean | null;
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
  nativePdfs: NativePdfAttachment[];
  sessions: Session[];
  sessionsLoadError: string | null;
  sessionsHasMore: boolean;
  sessionsLoadingMore: boolean;
  sessionsPaginationError: string | null;
  recycleBinLoadError: string | null;
  messagesLoading: boolean;
  pinnedSessionIds: string[];
  recycleBinEntries: RecycleBinEntry[];
  activeSessionId: string | null;
  editorTabsOpen: boolean;
  /** Root session ids currently visible in editor tabs. */
  editorSessionIds: string[];
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
  lspStatus: LspStatus[];
  providerDefaults: Record<string, string>;
  sessionPermissionModes: Record<string, PermissionMode>;
  sessionAutoPermissionCounts: Record<
    string,
    { inFlight: number; approved: number; rejected: number }
  >;
  sessionAutoPermissionActivity: Record<string, AutoApproveActivity[]>;
  autoPermissionCountsSince: number;
  selectedAgent: string | null;
  sessionSelectedAgents: SessionSelectedAgents;
  selectedModel: SelectedModel | null;
  sessionSelectedModels: SessionSelectedModels;
  modelVariantSelections: ModelVariantSelections;
  sessionSelectedMcps: SessionSelectedMcps;
  draftSelectedMcps: string[] | null;
  hiddenProviders: string[];
  hiddenModels: string[];
  addedModels: string[];
  pinnedModels: string[];
  modelDisplayNames: Record<string, string>;
  lastSeenSessions: Record<string, number>;
  completedSessionResponses: Record<string, number>;
  skippedPlanSessions: Record<string, number>;
  compactingSessionIds: string[];
  queuedMessages: QueuedMessage[];
  queuedMessageDispatchingId: string | null;
  failedQueuedMessageIds: string[];
  queuedMessageEdit: { id: string; sessionId: string } | null;
  failedSessionIds: string[];
  failedSessionUpdatedAt: Record<string, number>;
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
  showInlineFileChanges: Accessor<boolean>;
  setShowInlineFileChanges: Setter<boolean>;
  showChangedFiles: Accessor<boolean>;
  setShowChangedFiles: Setter<boolean>;
  desktopSessionPaneSide: Accessor<DesktopSessionPaneSide>;
  setDesktopSessionPaneSide: Setter<DesktopSessionPaneSide>;
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
  errorRetry: Accessor<(() => void) | null>;
  setErrorRetry(action: (() => void) | null): void;
  connectionInitialized: Accessor<boolean>;
  setConnectionInitialized: Setter<boolean>;
  showSessionPicker: Accessor<boolean>;
  setShowSessionPicker: Setter<boolean>;
  showModelPicker: Accessor<boolean>;
  setShowModelPicker: Setter<boolean>;
  showModels: Accessor<boolean>;
  setShowModels: Setter<boolean>;
  composerFocusKey: Accessor<number>;
  setComposerFocusKey: Setter<number>;
  openAttentionSessionsKey: Accessor<number>;
  setOpenAttentionSessionsKey: Setter<number>;
  openCompletedSessionsKey: Accessor<number>;
  setOpenCompletedSessionsKey: Setter<number>;
  sessionSearchFocusKey: Accessor<number>;
  setSessionSearchFocusKey: Setter<number>;
  messageListScrollRequestKey: Accessor<number>;
  setMessageListScrollRequestKey: Setter<number>;
  messageListScrollTargetMessageId: Accessor<string | null>;
  setMessageListScrollTargetMessageId: Setter<string | null>;
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
  const initialQueuedMessages = readStoredQueuedMessages(initialWebviewState.queuedMessages);
  const storedQueuedMessageEdit = readStoredQueuedMessageEdit();
  const initialQueuedMessageEdit =
    storedQueuedMessageEdit &&
    initialQueuedMessages.some((message) => message.id === storedQueuedMessageEdit.id)
      ? storedQueuedMessageEdit
      : null;
  const discardQueuedEditDraft = storedQueuedMessageEdit !== null && !initialQueuedMessageEdit;
  if (discardQueuedEditDraft) {
    writeStored(STORAGE_KEYS.queuedMessageEdit, null);
    writeStored(STORAGE_KEYS.inputDraft, null);
    writeStored(STORAGE_KEYS.inputDraftFiles, null);
  }
  const initialDroppedFiles = discardQueuedEditDraft
    ? []
    : mergeInitialDroppedFiles(
        readStoredDroppedFiles(STORAGE_KEYS.inputDraftFiles),
        initialWebviewState.droppedFiles ?? []
      );
  const initialClipboardImages = discardQueuedEditDraft
    ? []
    : (initialWebviewState.clipboardImages ?? [])
        .slice(0, 5)
        .map(normalizeStoredClipboardImage)
        .filter((image): image is ClipboardImage => image !== null);
  const currentDocumentWorkspace =
    initialWebviewState.editorContext?.workspacePath?.replace(/\\/g, '/').replace(/\/+$/, '') ||
    null;
  const projectCurrentDocumentEnabled = readStoredBooleanRecord(
    STORAGE_KEYS.projectCurrentDocumentEnabled
  );
  resetAttachmentOrderState();
  seedContextFileAttachmentSequences(initialDroppedFiles);
  seedClipboardImageAttachmentSequences(initialClipboardImages);
  writeStored(
    STORAGE_KEYS.inputDraftFiles,
    initialDroppedFiles.length > 0 ? initialDroppedFiles : null
  );
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
  const modelPreferences = initialWebviewState.modelPreferences;

  const [state, setState] = createStore<AppState>({
    serverStatus: initialWebviewState.serverStatus ?? { state: 'stopped' },
    restartBlocked: null,
    providersLoaded: false,
    providerRefreshPending: false,
    editorContext: initialWebviewState.editorContext ?? defaultEditorContext,
    terminalSelection: discardQueuedEditDraft
      ? null
      : (initialWebviewState.terminalSelection ?? null),
    attachedDiagnostics: null,
    emptyStateLogoUri: initialWebviewState.emptyStateLogoUri ?? '',
    currentDocumentEnabled: currentDocumentWorkspace
      ? (projectCurrentDocumentEnabled[currentDocumentWorkspace] ?? true)
      : true,
    draftCurrentDocumentEnabled: null,
    droppedFiles: initialDroppedFiles,
    clipboardImages: initialClipboardImages,
    nativePdfs: [],
    sessions: [],
    sessionsLoadError: null,
    sessionsHasMore: false,
    sessionsLoadingMore: false,
    sessionsPaginationError: null,
    recycleBinLoadError: null,
    messagesLoading: false,
    pinnedSessionIds: initialWebviewState.pinnedSessionIds ?? [],
    recycleBinEntries: initialWebviewState.recycleBinEntries ?? [],
    activeSessionId: null,
    editorTabsOpen: initialWebviewState.editorTabsOpen ?? false,
    editorSessionIds: initialWebviewState.editorSessionIds ?? [],
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
    lspStatus: [],
    providerDefaults: {},
    sessionPermissionModes:
      initialWebviewState.webviewContext?.surface === 'editor'
        ? (initialWebviewState.sessionPermissionModes ?? {})
        : {
            ...readStoredPermissionModes(STORAGE_KEYS.sessionPermissionModes),
            ...initialWebviewState.sessionPermissionModes,
          },
    sessionAutoPermissionCounts: {},
    sessionAutoPermissionActivity: {},
    autoPermissionCountsSince: Date.now(),
    selectedAgent: readStoredString(STORAGE_KEYS.selectedAgent),
    sessionSelectedAgents: readStoredStringRecord(STORAGE_KEYS.sessionSelectedAgents),
    selectedModel: readStoredSelectedModel(STORAGE_KEYS.selectedModel),
    sessionSelectedModels:
      initialWebviewState.webviewContext?.surface === 'editor'
        ? (initialWebviewState.sessionSelectedModels ?? {})
        : {
            ...readStoredSelectedModels(STORAGE_KEYS.sessionSelectedModels),
            ...initialWebviewState.sessionSelectedModels,
          },
    modelVariantSelections:
      modelPreferences?.modelVariantSelections ??
      readStoredNullableStringRecord(STORAGE_KEYS.modelVariantSelections),
    sessionSelectedMcps: readStoredStringArrayRecord(STORAGE_KEYS.sessionSelectedMcps),
    draftSelectedMcps: null,
    hiddenProviders:
      modelPreferences?.hiddenProviders ?? readStoredStringArray(STORAGE_KEYS.hiddenProviders),
    hiddenModels:
      modelPreferences?.hiddenModels ?? readStoredStringArray(STORAGE_KEYS.hiddenModels),
    addedModels: modelPreferences?.addedModels ?? readStoredStringArray(STORAGE_KEYS.addedModels),
    pinnedModels:
      modelPreferences?.pinnedModels ?? readStoredStringArray(STORAGE_KEYS.pinnedModels),
    modelDisplayNames:
      modelPreferences?.modelDisplayNames ?? readStoredStringRecord(STORAGE_KEYS.modelDisplayNames),
    lastSeenSessions: initialLastSeenSessions,
    completedSessionResponses: initialCompletedSessionResponses,
    skippedPlanSessions: initialSkippedPlanSessions,
    compactingSessionIds: [],
    queuedMessages: initialQueuedMessages,
    queuedMessageDispatchingId: null,
    failedQueuedMessageIds: [],
    queuedMessageEdit: initialQueuedMessageEdit,
    failedSessionIds: [],
    failedSessionUpdatedAt: {},
    sessionMessageCounts: {},
    sessionUsageLimits: {},
    interruptedSessionIds: initialWebviewState.interruptedSessionIds ?? [],
    providerAuthMethods: {},
    workspaceStatuses: [],
    workspaceStatusSummary: { entries: [] },
  });

  const [showThinking, setShowThinking] = createSignal(readShowThinking());
  const [showInlineFileChanges, setShowInlineFileChanges] = createSignal(
    initialWebviewState.showInlineFileChanges ?? false
  );
  const [showChangedFiles, setShowChangedFiles] = createSignal(
    initialWebviewState.showChangedFiles ?? false
  );
  const [desktopSessionPaneSide, setDesktopSessionPaneSide] = createSignal<DesktopSessionPaneSide>(
    readDesktopSessionPaneSide(initialWebviewState)
  );
  const [inputText, setInputTextValue] = createSignal(
    readStoredString(STORAGE_KEYS.inputDraft) ?? ''
  );
  const [inputTextMutationVersion, setInputTextMutationVersion] = createSignal(0);
  const setInputText: Setter<string> = (value) => {
    setInputTextMutationVersion((version) => version + 1);
    const nextValue = setInputTextValue(value);
    writeStored(STORAGE_KEYS.inputDraft, nextValue || null);
    return nextValue;
  };
  const [nextPastedImageIndex, setNextPastedImageIndex] = createSignal(1);
  const [isLoading, setIsLoading] = createSignal(false);
  const [loadingStartedAt, setLoadingStartedAt] = createSignal<number | null>(null);
  const [loadingLastActivityAt, setLoadingLastActivityAt] = createSignal<number | null>(null);
  const [error, setErrorSignal] = createSignal<string | null>(null);
  const [errorRetry, setErrorRetrySignal] = createSignal<(() => void) | null>(null);
  const setError: Setter<string | null> = (value) => {
    setErrorRetrySignal(null);
    return setErrorSignal(value);
  };
  const setErrorRetry = (action: (() => void) | null) => {
    setErrorRetrySignal(() => action);
  };
  const [connectionInitialized, setConnectionInitialized] = createSignal(false);
  const [showSessionPicker, setShowSessionPicker] = createSignal(false);
  const [showModelPicker, setShowModelPicker] = createSignal(false);
  const [showModels, setShowModels] = createSignal(false);
  const [composerFocusKey, setComposerFocusKey] = createSignal(0);
  const [openAttentionSessionsKey, setOpenAttentionSessionsKey] = createSignal(0);
  const [openCompletedSessionsKey, setOpenCompletedSessionsKey] = createSignal(0);
  const [sessionSearchFocusKey, setSessionSearchFocusKey] = createSignal(0);
  const [messageListScrollRequestKey, setMessageListScrollRequestKey] = createSignal(0);
  const [messageListScrollTargetMessageId, setMessageListScrollTargetMessageId] = createSignal<
    string | null
  >(null);
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
  const startupTheme = asRecord(window)?.__initialTheme;
  const initialTheme: WebviewThemeKind = isWebviewThemeKind(startupTheme) ? startupTheme : 'dark';
  const [theme, setTheme] = createSignal<WebviewThemeKind>(
    initialWebviewState.theme || initialTheme
  );
  const streamingDeltaQueue = createStreamingDeltaQueue(() => {
    flushPendingStreamingDeltasFor(appState);
  });

  const appState = {
    state,
    setState,
    showThinking,
    setShowThinking,
    showInlineFileChanges,
    setShowInlineFileChanges,
    showChangedFiles,
    setShowChangedFiles,
    desktopSessionPaneSide,
    setDesktopSessionPaneSide,
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
    errorRetry,
    setErrorRetry,
    connectionInitialized,
    setConnectionInitialized,
    showSessionPicker,
    setShowSessionPicker,
    showModelPicker,
    setShowModelPicker,
    showModels,
    setShowModels,
    composerFocusKey,
    setComposerFocusKey,
    openAttentionSessionsKey,
    setOpenAttentionSessionsKey,
    openCompletedSessionsKey,
    setOpenCompletedSessionsKey,
    sessionSearchFocusKey,
    setSessionSearchFocusKey,
    messageListScrollRequestKey,
    setMessageListScrollRequestKey,
    messageListScrollTargetMessageId,
    setMessageListScrollTargetMessageId,
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
    streamingDeltaQueue,
  } satisfies AppStateInstance;

  return appState;
}

function mergeInitialDroppedFiles(
  storedFiles: DroppedFile[],
  hostFiles: DroppedFile[]
): DroppedFile[] {
  const files = storedFiles.map((file) => ({ ...file }));
  for (const file of hostFiles) {
    const index = files.findIndex((item) => item.path === file.path);
    if (index === -1) {
      files.push({ ...file });
      continue;
    }
    files[index] = mergeContextFile(files[index], file);
  }
  return files;
}

export const defaultAppState = createAppState();

export const state = defaultAppState.state;
export const setState = defaultAppState.setState;
export const showThinking = defaultAppState.showThinking;
export const setShowThinking = defaultAppState.setShowThinking;
export const showInlineFileChanges = defaultAppState.showInlineFileChanges;
export const setShowInlineFileChanges = defaultAppState.setShowInlineFileChanges;
export const showChangedFiles = defaultAppState.showChangedFiles;
export const setShowChangedFiles = defaultAppState.setShowChangedFiles;
export const desktopSessionPaneSide = defaultAppState.desktopSessionPaneSide;
export const setDesktopSessionPaneSide = defaultAppState.setDesktopSessionPaneSide;
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
export const errorRetry = defaultAppState.errorRetry;
export const setErrorRetry = defaultAppState.setErrorRetry;
export const connectionInitialized = defaultAppState.connectionInitialized;
export const setConnectionInitialized = defaultAppState.setConnectionInitialized;
export const showSessionPicker = defaultAppState.showSessionPicker;
export const setShowSessionPicker = defaultAppState.setShowSessionPicker;

export const showModelPicker = defaultAppState.showModelPicker;
export const setShowModelPicker = defaultAppState.setShowModelPicker;
export const showModels = defaultAppState.showModels;
export const setShowModels = defaultAppState.setShowModels;
export const composerFocusKey = defaultAppState.composerFocusKey;
export const setComposerFocusKey = defaultAppState.setComposerFocusKey;
export const openAttentionSessionsKey = defaultAppState.openAttentionSessionsKey;
export const setOpenAttentionSessionsKey = defaultAppState.setOpenAttentionSessionsKey;
export const openCompletedSessionsKey = defaultAppState.openCompletedSessionsKey;
export const setOpenCompletedSessionsKey = defaultAppState.setOpenCompletedSessionsKey;
export const sessionSearchFocusKey = defaultAppState.sessionSearchFocusKey;
export const setSessionSearchFocusKey = defaultAppState.setSessionSearchFocusKey;
export const messageListScrollRequestKey = defaultAppState.messageListScrollRequestKey;
export const setMessageListScrollRequestKey = defaultAppState.setMessageListScrollRequestKey;
export const messageListScrollTargetMessageId = defaultAppState.messageListScrollTargetMessageId;
export const setMessageListScrollTargetMessageId =
  defaultAppState.setMessageListScrollTargetMessageId;
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
  setShowInlineFileChanges(next.showInlineFileChanges());
  setShowChangedFiles(next.showChangedFiles());
  setDesktopSessionPaneSide(next.desktopSessionPaneSide());
  setInputText(next.inputText());
  setNextPastedImageIndex(next.nextPastedImageIndex());
  setIsLoading(next.isLoading());
  setLoadingStartedAt(next.loadingStartedAt());
  setLoadingLastActivityAt(next.loadingLastActivityAt());
  setError(next.error());
  setConnectionInitialized(next.connectionInitialized());
  setShowSessionPicker(next.showSessionPicker());
  setShowModelPicker(next.showModelPicker());
  setShowModels(next.showModels());
  setComposerFocusKey(next.composerFocusKey());
  setOpenAttentionSessionsKey(next.openAttentionSessionsKey());
  setOpenCompletedSessionsKey(next.openCompletedSessionsKey());
  setSessionSearchFocusKey(next.sessionSearchFocusKey());
  setMessageListScrollRequestKey(next.messageListScrollRequestKey());
  setMessageListScrollTargetMessageId(next.messageListScrollTargetMessageId());
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
