import { batch, createSignal, onCleanup, onMount } from 'solid-js';
import { reconcile } from 'solid-js/store';
import type {
  AutoApproveJudgeReference,
  ExtensionMessage,
  PermissionMode,
  WebviewThemeKind,
} from '../../../shared/protocol';
import { DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS } from '../../../shared/provider-limit-config';
import { isPlaceholderSessionTitle } from '../../../shared/session-title';
import { onMessage, postMessage } from '../../lib/bridge';
import * as clientModule from '../../lib/client';
import type { SessionSelectionOptions } from '../../lib/app-state-types';
import { appStore } from '../../lib/stores/app-store';
import { composerStore } from '../../lib/stores/composer-store';
import { permissionsStore } from '../../lib/stores/permissions-store';
import { ralphStore } from '../../lib/stores/ralph-store';
import { routingStore } from '../../lib/stores/routing-store';
import { resetSessionStatusSnapshotTracking, sessionStore } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import { toApprovedPermissionReference, toPlainJudgeModel } from '../../lib/judge-request';
import { resetMessageEditState } from '../../lib/message-edit-state';
import { isWorkspaceDirectoryText } from '../../lib/part-utils';
import { normalizePermissionEvent } from '../../lib/session-event-reducer';
import { flushPendingStreamingDeltasFor } from '../../lib/streaming-deltas';
import { resetToolCallExpansionState } from '../../lib/tool-call-expansion-state';
import { applyWebviewTheme } from '../../lib/theme';
import type { MessageEntry, Permission, Session, SessionStatus } from '../../types';
import {
  clearQueuedMessagesForSession,
  getSessionTreeIds,
  getSessionTreeRootId,
  isSessionAwaitingInput,
  isSessionTreeStatusWorking,
  syncQueuedMessages,
} from '../../lib/state';
import {
  advanceSessionHistoryCursor,
  advanceSessionHistoryPromptCursor,
  cacheSessionHistoryPage,
  clearSessionMessageWindowState,
  getSessionMessageWindowRevision,
  getSessionHistoryCursor,
  getSessionHistoryPromptCursor,
  getSessionHistoryPrompts,
  isSessionMessageWindowResetPending,
  markSessionHistoryLoadFailed,
  MESSAGE_HISTORY_WINDOW,
  mergeOlderHistory,
  mergeWindowedHistory,
  resetMessageWindowState,
  setSessionHistoryPrompts,
  setSessionHistoryPromptCursor,
  setSessionHistoryCursor,
  takeCachedSessionHistoryPage,
} from '../../lib/message-window';
import { getNewChatDraftGeneration, startNewChatDraft } from '../../lib/new-chat-draft';
import {
  createConnectionBootstrapOperations,
  ensureConnectionInitializedWithDependencies,
} from '../connection-bootstrap';
import { createStateBoundDataLoaderOperations } from '../data-loaders';
import {
  createMountBridgeOperations,
  postFocusStateWithDependencies,
  registerFocusStateTracking,
} from '../mount-bridge';
import { getSessionPermissionRulesForMode } from '../permission-rules';
import {
  deriveSelectedAgentFromMessages,
  deriveSelectedModelFromMessages,
  deriveSelectedModelFromSession,
  getActiveProviderSelection as getActiveProviderSelectionForState,
  getBuildAgentName,
  getDefaultPrimaryAgentName,
  getUsageLimitNoticeContext as getUsageLimitNoticeContextForState,
} from '../routing-state';
import { SessionActionOperations } from '../session/session-actions';
import { SessionApprovalOperations } from '../session/session-approvals';
import { SessionControlOperations } from '../session/session-controls';
import {
  createSessionMessageSyncCoordinator,
  registerLoadingStatusPollEffect,
  registerEventStreamRecoveryEffect,
  registerProviderLimitRefreshEffect,
  registerVisibleRunningSessionSyncEffect,
} from '../session/session-effects';
import {
  forceReconcileIdleSessionWithDependencies,
  reconcileStuckSessionsWithDependencies,
  registerStuckSessionWatchdogEffect,
  selectUnsettledLatestAssistant,
} from '../session/session-watchdog';
import { SessionEventHandlerOperations } from '../session/session-event-handlers';
import {
  getDeletedSessionTreeIds,
  getNextSessionIdAfterDeletion,
  SessionLifecycleOperations,
} from '../session/session-lifecycle';
import { SessionManagementOperations } from '../session/session-management';
import { SessionMcpOperations } from '../session/session-mcp';
import {
  ensureSessionPermissionWithDependencies,
  SessionSendOperations,
  type QueuedAttachmentSnapshot,
} from '../session/session-send';
import { SessionStatusOperations } from '../session/session-status';
import { resolveMessagesSelectedModel, SessionSyncOperations } from '../session/session-sync';
import { createTodoSyncOperations, resetTodoSync } from '../todo-sync';

const client = clientModule.client;

function invalidateClientWorkspaceState() {
  clientModule.invalidateClientWorkspaceCaches();
}

export interface OpenCodeRuntime {
  useOpenCode(): { client: typeof client };
  recheckSessionStatus(sessionId: string): Promise<void>;
  refreshRoutingState(): Promise<void>;
  continueInterruptedSession(sessionId: string): Promise<void>;
  applySessionMcps(names: string[], sessionId?: string | null): Promise<void>;
  selectSession(id: string, options?: SessionSelectionOptions): Promise<void>;
  loadFullSessionHistory(sessionId: string): Promise<void>;
  loadOlderSessionHistoryPage(sessionId: string): Promise<boolean>;
  loadOlderSessionPrompts(sessionId: string): Promise<boolean>;
  createSession(title?: string, initialPermissionMode?: PermissionMode): Promise<string | null>;
  renameSession(id: string, title: string): Promise<boolean>;
  forkSession(id: string, messageID?: string): Promise<string | null>;
  deleteSession(id: string): Promise<void>;
  deleteSessionImmediately(id: string): Promise<void>;
  restoreSession(rootID: string): Promise<void>;
  deleteSessionPermanently(rootID: string): Promise<void>;
  emptyRecycleBin(): Promise<void>;
  reloadSessions(): Promise<void>;
  loadMoreSessions(): Promise<void>;
  sendMessage(
    text: string,
    options?: {
      agent?: string;
      noReply?: boolean;
      delivery?: 'steer' | 'queue';
      queuedAttachments?: QueuedAttachmentSnapshot;
      preserveComposer?: boolean;
      targetSessionId?: string;
    }
  ): Promise<boolean>;
  retryMessage(messageId: string, sessionId?: string | null): Promise<void>;
  editMessage(
    messageId: string,
    text: string,
    options?: {
      allowEmptyText?: boolean;
      queuedAttachments?: QueuedAttachmentSnapshot;
      onOptimisticPublish?: () => void;
    }
  ): Promise<boolean>;
  implementPlan(prompt: string, sessionId?: string | null): Promise<void>;
  openPlan(markdown: string, sessionId?: string | null): Promise<void>;
  abortSession(): Promise<void>;
  undoSession(): Promise<void>;
  redoSession(): Promise<void>;
  initSession(): Promise<void>;
  runSlashCommandByName(name: string, args: string): Promise<unknown>;
  reviewSession(): Promise<void>;
  compactSession(): Promise<void>;
  respondPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ): Promise<void>;
  respondQuestion(
    requestID: string,
    answers: Array<Array<string>>,
    options?: { rethrow?: boolean }
  ): Promise<void>;
  updatePermissionModeForSession(mode: PermissionMode, sessionId?: string | null): Promise<void>;
  rejectQuestion(requestID: string, options?: { rethrow?: boolean }): Promise<void>;
}

function logError(context: string, err: unknown) {
  if (err instanceof WorkspaceLoadInvalidatedError) return;
  postMessage({
    type: 'log',
    payload: {
      msg: context,
      error: err instanceof Error ? err.message : String(err),
      level: 'warn',
    },
  });
}

class WorkspaceLoadInvalidatedError extends Error {}

function isCurrentGeneration(current: number, expected: number) {
  return current === expected;
}

const POLLED_STATUS_SNAPSHOT_FRESHNESS_MS = 100;

export type SessionStatusSnapshot = {
  statuses: Record<string, SessionStatus>;
  startedAt: number;
};

export function createSessionStatusSnapshotCoordinator(
  loadSessionStatuses: () => Promise<Record<string, SessionStatus>>,
  freshnessMs = POLLED_STATUS_SNAPSHOT_FRESHNESS_MS
) {
  let generation = 0;
  let inFlight: Promise<SessionStatusSnapshot> | null = null;
  let latest: { snapshot: SessionStatusSnapshot; completedAt: number } | null = null;

  const load = (): Promise<SessionStatusSnapshot> => {
    if (inFlight) return inFlight;
    if (latest && Date.now() - latest.completedAt < freshnessMs) {
      return Promise.resolve(latest.snapshot);
    }

    const requestGeneration = generation;
    const request = Promise.resolve().then(async () => {
      const startedAt = Date.now();
      const statuses = await loadSessionStatuses();
      return { statuses, startedAt };
    });
    const tracked: Promise<SessionStatusSnapshot> = request.then(
      (snapshot) => {
        if (requestGeneration === generation) {
          latest = { snapshot, completedAt: Date.now() };
        }
        if (inFlight === tracked) inFlight = null;
        return snapshot;
      },
      (err: unknown) => {
        if (inFlight === tracked) inFlight = null;
        throw err;
      }
    );
    inFlight = tracked;
    return tracked;
  };

  const clear = () => {
    generation += 1;
    inFlight = null;
    latest = null;
  };

  return { load, clear };
}

export function createPerSessionMessageSyncGenerations() {
  type SyncAttempt = { sessionId: string; token: number; applied: boolean };

  let nextToken = 0;
  const currentTokenBySession = new Map<string, number>();
  const attemptsByToken = new Map<number, SyncAttempt>();

  const isCurrent = (token: number) => {
    const attempt = attemptsByToken.get(token);
    if (!attempt) return false;
    const current = currentTokenBySession.get(attempt.sessionId) === token;
    attempt.applied = current;
    return current;
  };

  const run = (
    sessionId: string,
    operation: (token: number) => Promise<void>
  ): Promise<boolean> => {
    const token = ++nextToken;
    const attempt: SyncAttempt = { sessionId, token, applied: false };
    attemptsByToken.set(token, attempt);
    currentTokenBySession.set(sessionId, token);
    return Promise.resolve()
      .then(() => operation(token))
      .then(() => attempt.applied)
      .finally(() => {
        attemptsByToken.delete(token);
      });
  };

  const invalidate = (sessionId: string) => {
    currentTokenBySession.set(sessionId, ++nextToken);
  };

  const clear = () => {
    currentTokenBySession.clear();
    attemptsByToken.clear();
  };

  return { isCurrent, run, invalidate, clear };
}

function isNotFoundError(err: unknown) {
  return err instanceof Error && /^404\b/.test(err.message);
}

function mergeSessionMessages(
  current: MessageEntry[],
  sessionId: string,
  incoming: MessageEntry[]
): MessageEntry[] {
  const sessionMessages = incoming.filter((entry) => entry.info.sessionID === sessionId);
  if (!current.some((entry) => entry.info.sessionID !== sessionId)) return incoming;

  const incomingIndexById = new Map(
    sessionMessages.map((entry, index) => [entry.info.id, index] as const)
  );
  const hasOverlap = current.some(
    (entry) => entry.info.sessionID === sessionId && incomingIndexById.has(entry.info.id)
  );
  if (!hasOverlap) {
    const firstSessionIndex = current.findIndex((entry) => entry.info.sessionID === sessionId);
    const insertionIndex = firstSessionIndex < 0 ? 0 : firstSessionIndex;
    return [
      ...current.slice(0, insertionIndex).filter((entry) => entry.info.sessionID !== sessionId),
      ...sessionMessages,
      ...current.slice(insertionIndex).filter((entry) => entry.info.sessionID !== sessionId),
    ];
  }

  const merged: MessageEntry[] = [];
  let incomingIndex = 0;
  for (const entry of current) {
    if (entry.info.sessionID !== sessionId) {
      merged.push(entry);
      continue;
    }

    const matchingIndex = incomingIndexById.get(entry.info.id);
    if (matchingIndex === undefined || matchingIndex < incomingIndex) continue;
    while (incomingIndex <= matchingIndex) merged.push(sessionMessages[incomingIndex++]!);
  }
  while (incomingIndex < sessionMessages.length) merged.push(sessionMessages[incomingIndex++]!);
  return merged;
}

function setSessionMessagesIncremental(
  sessionId: string,
  messages: MessageEntry[],
  options?: { preserveExtraParts?: boolean },
  behavior?: { preserveSessionStreaming?: boolean }
) {
  flushPendingStreamingDeltasFor(appStore.defaultAppState);
  const current = appStore.state.messages;
  const streamingPartId = appStore.state.streamingPartId;
  const streamingText = appStore.state.streamingText;
  const preserveStreamingState =
    !!streamingPartId &&
    current.some(
      (entry) =>
        (behavior?.preserveSessionStreaming || entry.info.sessionID !== sessionId) &&
        entry.parts.some((part) => part.id === streamingPartId)
    );
  sessionStore.setMessagesIncremental(mergeSessionMessages(current, sessionId, messages), options);
  if (
    preserveStreamingState &&
    appStore.state.messages.some((entry) => entry.parts.some((part) => part.id === streamingPartId))
  ) {
    batch(() => {
      appStore.setState('streamingPartId', streamingPartId);
      appStore.setState('streamingText', streamingText);
    });
  }
}

async function fetchSessionMessages(
  sessionId: string,
  options?: { resetHistoryWindow?: boolean; isCurrent?: () => boolean }
): Promise<MessageEntry[]> {
  const requestRevision = getSessionMessageWindowRevision(sessionId);
  const incoming = await client.session.messages(sessionId, { limit: MESSAGE_HISTORY_WINDOW });
  const current = appStore.state.messages.filter((entry) => entry.info.sessionID === sessionId);
  if (
    options?.isCurrent?.() === false ||
    getSessionMessageWindowRevision(sessionId) !== requestRevision
  ) {
    return current;
  }

  const incomingKeys = new Set(
    incoming.map((entry) => `${entry.info.sessionID}\u0000${entry.info.id}`)
  );
  const hasOverlap = current.some((entry) =>
    incomingKeys.has(`${entry.info.sessionID}\u0000${entry.info.id}`)
  );
  const resetHistoryWindow =
    !!options?.resetHistoryWindow ||
    isSessionMessageWindowResetPending(sessionId) ||
    current.length === 0 ||
    incoming.length === 0 ||
    !hasOverlap;
  if (resetHistoryWindow) {
    clearSessionMessageWindowState(sessionId);
    setSessionHistoryCursor(sessionId, incoming.nextCursor);
    setSessionHistoryPrompts(sessionId, []);
    setSessionHistoryPromptCursor(sessionId, incoming.nextCursor);
    if (incoming.nextCursor) {
      void loadSessionBoundaryPrompts(
        sessionId,
        incoming.nextCursor,
        options?.isCurrent,
        new Set(incoming.map((entry) => entry.info.id))
      );
    }
  }
  const messages = resetHistoryWindow ? incoming : mergeWindowedHistory(current, incoming);
  if (!resetHistoryWindow) {
    const promptCursor = getSessionHistoryPromptCursor(sessionId);
    const loadedMessageIds = new Set(messages.map((entry) => entry.info.id));
    const hasBoundaryPrompt = getSessionHistoryPrompts(sessionId).some(
      (entry) => !loadedMessageIds.has(entry.info.id) && hasPreviewablePromptContent(entry)
    );
    if (promptCursor && !hasBoundaryPrompt) {
      void loadSessionBoundaryPrompts(
        sessionId,
        promptCursor,
        options?.isCurrent,
        loadedMessageIds
      );
    }
  }
  appStore.setState('sessionMessageCounts', sessionId, messages.length);
  return messages;
}

const promptHistoryLoads = new Map<string, { revision: number; promise: Promise<boolean> }>();
const promptHistoryPageLoads = new Map<
  string,
  { revision: number; cursor: string; promise: ReturnType<typeof client.session.messages> }
>();

function hasPreviewablePromptContent(entry: MessageEntry) {
  return entry.parts.some(
    (part) =>
      part.type === 'file' ||
      (part.type === 'text' &&
        part.text
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .some((line) => {
            const trimmed = line.trim();
            return trimmed.length > 0 && !isWorkspaceDirectoryText(trimmed);
          }))
  );
}

function loadOlderSessionPrompts(
  sessionId: string,
  initialCursor?: string,
  isCurrent: () => boolean = () => true,
  knownLoadedMessageIds: ReadonlySet<string> = new Set()
): Promise<boolean> {
  const revision = getSessionMessageWindowRevision(sessionId);
  const existing = promptHistoryLoads.get(sessionId);
  if (existing?.revision === revision) return existing.promise;

  const load = (async () => {
    let cursor = initialCursor ?? getSessionHistoryPromptCursor(sessionId);
    while (cursor) {
      const pageLoad = client.session.messages(sessionId, {
        limit: MESSAGE_HISTORY_WINDOW,
        before: cursor,
      });
      promptHistoryPageLoads.set(sessionId, { revision, cursor, promise: pageLoad });
      let page: Awaited<typeof pageLoad>;
      try {
        page = await pageLoad;
      } finally {
        if (promptHistoryPageLoads.get(sessionId)?.promise === pageLoad) {
          promptHistoryPageLoads.delete(sessionId);
        }
      }
      if (!isCurrent() || getSessionMessageWindowRevision(sessionId) !== revision) {
        return false;
      }
      cacheSessionHistoryPage(sessionId, cursor, page);
      const nextCursor = advanceSessionHistoryPromptCursor(sessionId, cursor, page.nextCursor);
      const prompts = page.filter((entry) => entry.info.role === 'user');
      if (prompts.length > 0) {
        setSessionHistoryPrompts(
          sessionId,
          mergeOlderHistory(getSessionHistoryPrompts(sessionId), prompts)
        );
        const loadedMessageIds = new Set([
          ...knownLoadedMessageIds,
          ...appStore.state.messages
            .filter((entry) => entry.info.sessionID === sessionId)
            .map((entry) => entry.info.id),
        ]);
        if (
          prompts.some(
            (entry) => !loadedMessageIds.has(entry.info.id) && hasPreviewablePromptContent(entry)
          )
        ) {
          return true;
        }
      }
      cursor = nextCursor;
    }
    return false;
  })()
    .catch((err: unknown) => {
      if (isCurrent()) logError('loadOlderSessionPrompts', err);
      return false;
    })
    .finally(() => {
      if (promptHistoryLoads.get(sessionId)?.promise === load) {
        promptHistoryLoads.delete(sessionId);
      }
    });
  promptHistoryLoads.set(sessionId, { revision, promise: load });
  return load;
}

function loadSessionBoundaryPrompts(
  sessionId: string,
  initialCursor: string,
  isCurrent: () => boolean = () => true,
  knownLoadedMessageIds: ReadonlySet<string> = new Set()
): Promise<void> {
  const revision = getSessionMessageWindowRevision(sessionId);
  const existing = promptHistoryLoads.get(sessionId);
  if (!existing || existing.revision !== revision) {
    return loadOlderSessionPrompts(sessionId, initialCursor, isCurrent, knownLoadedMessageIds).then(
      () => {}
    );
  }
  return existing.promise.then(() => {
    if (!isCurrent()) return;
    if (getSessionHistoryPromptCursor(sessionId) !== initialCursor) return;
    return loadOlderSessionPrompts(sessionId, initialCursor, isCurrent, knownLoadedMessageIds).then(
      () => {}
    );
  });
}

async function loadSessionWithMessages(
  sessionId: string,
  isCurrent: () => boolean = () => true
): Promise<{
  session: Session;
  messages: MessageEntry[];
}> {
  const messagesPromise = fetchSessionMessages(sessionId, {
    resetHistoryWindow: true,
    isCurrent,
  }).catch((err: unknown) => {
    if (isNotFoundError(err)) return [];
    throw err;
  });
  const [session, messages] = await Promise.all([client.session.get(sessionId), messagesPromise]);
  return { session, messages };
}

async function loadSessionMessagesAllowingEmpty(
  sessionId: string,
  isCurrent: () => boolean = () => true
): Promise<MessageEntry[]> {
  try {
    return await fetchSessionMessages(sessionId, { isCurrent });
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

function applyTheme(nextTheme: WebviewThemeKind) {
  applyWebviewTheme(nextTheme);
}

function getUsageLimitNoticeContext(
  sessionID: string,
  messages: MessageEntry[] = appStore.state.messages
) {
  return getUsageLimitNoticeContextForState({
    sessionId: sessionID,
    messages,
    selectedModelForSession: routingStore.getSelectedModelForSession(sessionID),
    providers: appStore.state.providers,
    providerDefaults: appStore.state.providerDefaults,
    fallbackSelectedModel: appStore.state.selectedModel,
  });
}

function settleLatestAssistantMessage(sessionId: string) {
  const info = selectUnsettledLatestAssistant(appStore.state.messages, sessionId);
  if (!info) return;
  sessionStore.upsertMessageInfo({ ...info, time: { ...info.time, completed: Date.now() } });
  sessionStore.finishMessageStreaming(info.id);
}

function getDefaultPrimaryAgentNameFromState() {
  return getDefaultPrimaryAgentName(appStore.state.agents);
}

function getBuildAgentNameFromState() {
  return getBuildAgentName(appStore.state.agents);
}

function postFocusState() {
  postFocusStateWithDependencies({
    sendMessage: postMessage,
    isVisible: () => document.visibilityState === 'visible',
    hasFocus: () => document.hasFocus(),
  });
}

function getActiveProviderSelection() {
  return getActiveProviderSelectionForState({
    activeSessionId: appStore.state.activeSessionId,
    selectedModel: appStore.state.selectedModel,
    providers: appStore.state.providers,
    providerDefaults: appStore.state.providerDefaults,
    getActiveRalphModel: (sessionId) => {
      const managerSessionId = ralphStore.isRalphSession(sessionId)
        ? sessionId
        : ralphStore.findManagerSessionIdForChild(sessionId);
      const model = managerSessionId ? ralphStore.getRun(managerSessionId)?.config.model : null;
      if (!model?.providerID) return null;
      return { providerID: model.providerID, modelID: model.modelID };
    },
  });
}

function resolvePermissionJudgeModel(sessionId: string) {
  return toPlainJudgeModel(
    routingStore.resolveSelectedModel(
      routingStore.getSelectedModelForSession(sessionId) || appStore.state.selectedModel,
      appStore.state.providers,
      appStore.state.providerDefaults
    )
  );
}

async function deleteSessionImmediately(id: string) {
  await client.varro.session.deleteImmediately(id);
  clearQueuedMessagesForSession(id);
  clearSessionMessageWindowState(id);
}

export function resetWorkspaceDerivedState() {
  batch(() => {
    sessionStore.setActiveSessionId(null);
    sessionStore.persistActiveSessionId(null);
    sessionStore.clearMessages();
    appStore.setState('sessions', []);
    appStore.setState('sessionsLoadError', null);
    appStore.setState('sessionsHasMore', false);
    appStore.setState('sessionsLoadingMore', false);
    appStore.setState('sessionsPaginationError', null);
    appStore.setState('recycleBinEntries', []);
    appStore.setState('recycleBinLoadError', null);
    appStore.setState('messagesLoading', false);
    appStore.setState('sessionStatus', reconcile({}));
    appStore.setState('permissions', []);
    appStore.setState('questions', []);
    appStore.setState('compactingSessionIds', []);
    appStore.setState('queuedMessageDispatchingId', null);
    appStore.setState('failedQueuedMessageIds', []);
    appStore.setState('queuedMessageEdit', null);
    appStore.setState('failedSessionIds', []);
    appStore.setState('sessionMessageCounts', reconcile({}));
    appStore.setState('sessionUsageLimits', reconcile({}));
    appStore.setState('interruptedSessionIds', []);

    appStore.setState('providersLoaded', false);
    appStore.setState('agents', []);
    appStore.setState('allAgents', []);
    appStore.setState('commands', []);
    appStore.setState('providers', []);
    appStore.setState('providerLimits', reconcile({}));
    appStore.setState('mcpStatus', reconcile({}));
    appStore.setState('providerDefaults', reconcile({}));
    appStore.setState('providerAuthMethods', reconcile({}));
    appStore.setState('workspaceStatuses', []);
    appStore.setState('workspaceStatusSummary', reconcile({ entries: [] }));
    appStore.setState('draftSelectedMcps', null);
    routingStore.setSelectedAgent(routingStore.getPersistedSelectedAgent(), {
      persistGlobal: false,
    });
    routingStore.setSelectedModel(routingStore.getPersistedSelectedModel(), {
      persistGlobal: false,
    });

    composerStore.clearContextFiles();
    composerStore.clearClipboardImages();
    composerStore.clearTerminalSelection();
    composerStore.clearAttachedDiagnostics();
    composerStore.setInputText('');
    composerStore.resetPastedImageIndex();
    uiStore.stopLoading();
    uiStore.setError(null);
    uiStore.setShowSessionPicker(false);
    uiStore.setShowModelPicker(false);
    uiStore.setShowSettings(false);
  });

  appStore.defaultAppState.sessionTreeIndex.invalidate();
  appStore.defaultAppState.setSessionUsageLimitVersion((version) => version + 1);
  resetSessionStatusSnapshotTracking();
  resetMessageEditState();
  resetToolCallExpansionState();
  resetMessageWindowState();
}

export function createOpenCodeRuntime(): OpenCodeRuntime {
  let initialized = false;
  let initializationAttemptGeneration = 0;
  let activeInitializationAttempt: number | null = null;
  let eventHandlerCleanups: Array<() => void> = [];
  let currentWorkspacePath: string | null | undefined;
  let workspaceGeneration = 0;
  let connectionGeneration = 0;
  let sessionSelectionGeneration = 0;
  let approvedPermissionReferences: AutoApproveJudgeReference[] = [];
  let permissionSyncGeneration = 0;
  let latestPermissionSyncGeneration = 0;
  let permissionSnapshotGeneration = 0;
  const fullHistoryLoads = new Map<
    string,
    {
      workspaceGeneration: number;
      selectionGeneration: number;
      revision: number;
      promise: Promise<void>;
    }
  >();
  const historyPageLoads = new Map<
    string,
    {
      workspaceGeneration: number;
      selectionGeneration: number;
      revision: number;
      promise: Promise<boolean>;
    }
  >();
  const pendingAbortRetryAttempts = new Map<string, number | null>();
  const statusSnapshotStartedAt = new WeakMap<Record<string, SessionStatus>, number>();
  const statusSnapshots = createSessionStatusSnapshotCoordinator(() => client.session.status());
  const messageSyncGenerations = createPerSessionMessageSyncGenerations();
  const sessionMessageSyncCoordinator = createSessionMessageSyncCoordinator((sessionId) =>
    runSessionMessageSync(sessionId)
  );
  const [documentVisible, setDocumentVisible] = createSignal(
    document.visibilityState === 'visible'
  );

  const todoSyncOperations = createTodoSyncOperations({
    loadSessionTodos: (sessionId) => client.session.todos(sessionId),
  });

  const { syncTodosForSession, syncTodosFromMessages, handoffTodosToMessages } = todoSyncOperations;

  const sessionStatusOperations = new SessionStatusOperations({
    pendingAbortRetryAttempts,
    deriveUsageLimitNoticeContext: getUsageLimitNoticeContext,
    refreshProviderLimit: (providerID, modelID) => refreshProviderLimit(providerID, modelID),
    isDocumentVisible: () => documentVisible(),
    shouldResyncSessionAfterIdle: (sessionId) => appStore.state.activeSessionId === sessionId,
    syncSession: (sessionId) => syncSession(sessionId),
    syncSessionMessages: (sessionId) => syncSessionMessages(sessionId),
    syncBusySessionMessages: (sessionId) => syncPolledSessionMessages(sessionId),
    loadSessionStatuses: loadSessionStatusesFromSnapshot,
    loadSessionStatusSnapshot: loadCurrentSessionStatusSnapshot,
    isActiveSession: (sessionId) => appStore.state.activeSessionId === sessionId,
    getMessages: () => appStore.state.messages,
    onSessionSettled: () => {
      void syncSessionMcps(appStore.state.activeSessionId).catch((err) =>
        logError('syncSessionMcpsAfterSessionSettled', err)
      );
    },
    logError,
  });

  const {
    setSessionStatusEntry,
    clearPendingAbort,
    clearPendingAbortTree,
    markPendingAbortTree,
    updateUsageLimitState,
    recheckSessionStatus: recheckSessionStatusWithState,
  } = sessionStatusOperations;

  const sessionLifecycleOperations = new SessionLifecycleOperations({
    getCurrentWorkspacePath: () => currentWorkspacePath ?? null,
    clearPendingAbort,
    clearPendingAbortTree,
    resetTodoSync,
    resetToolCallExpansionState,
  });

  const { applySessions, clearDeletedSessionState, hideDeletedSessionTree, upsertSession } =
    sessionLifecycleOperations;
  const sessionTitleFallbackAttempts = new Map<string, number>();
  const sessionTitleFallbacks = new Map<string, Promise<void>>();

  function repairSessionTitle(sessionId: string): Promise<void> {
    const inFlight = sessionTitleFallbacks.get(sessionId);
    if (inFlight) return inFlight;
    const existing = appStore.state.sessions.find((session) => session.id === sessionId);
    if (existing && !isPlaceholderSessionTitle(existing.title)) return Promise.resolve();
    const attempts = sessionTitleFallbackAttempts.get(sessionId) ?? 0;
    if (attempts >= 2) return Promise.resolve();
    sessionTitleFallbackAttempts.set(sessionId, attempts + 1);

    const fallback = (async () => {
      const renamed = await client.varro.session.renameIfUntitled(sessionId);
      if (!renamed) return;
      const current = appStore.state.sessions.find((session) => session.id === sessionId);
      if (current) {
        upsertSession({ ...current, title: renamed.title });
        return;
      }
      await syncSession(sessionId);
    })().finally(() => {
      if (sessionTitleFallbacks.get(sessionId) === fallback) {
        sessionTitleFallbacks.delete(sessionId);
      }
    });
    sessionTitleFallbacks.set(sessionId, fallback);
    return fallback;
  }

  function ensureSessionEventHandlersRegistered() {
    if (eventHandlerCleanups.length > 0) return;

    const sessionEventHandlerOperations = new SessionEventHandlerOperations({
      todoSyncOperations,
      sessionLifecycleOperations,
      sessionStatusOperations,
      sessionSyncOperations: {
        syncSession: sessionSyncOperations.syncSession,
        syncSessionMessages,
      },
      repairSessionTitle,
      sessionApprovalOperations: {
        respondPermission: sessionApprovalOperations.respondPermission,
        judgePermission: (permission) => {
          const snapshotGeneration = permissionSnapshotGeneration;
          return judgeAndRespondPermission(
            permission,
            () => snapshotGeneration === permissionSnapshotGeneration
          );
        },
      },
      syncPendingPermissions,
      reconcileServerState,
      invalidateMessageSync: messageSyncGenerations.invalidate,
      abortRemoteSession: (sessionId: string) => client.session.abort(sessionId),
      logError,
    });

    eventHandlerCleanups = sessionEventHandlerOperations.registerSessionEventHandlers();
  }

  function useOpenCode() {
    onMount(() => {
      applyTheme(uiStore.theme());

      const mountBridgeOperations = createMountBridgeOperations({
        ensureConnectionInitialized,
        getServerState: () => appStore.state.serverStatus.state,
        invalidateConnection,
        getCurrentWorkspacePath: () => currentWorkspacePath,
        setCurrentWorkspacePath: (path) => {
          currentWorkspacePath = path;
        },
        resetWorkspaceForChange,
        reloadWorkspaceAfterChange,
        isInitialized: () => initialized,
        createSession: (prefill) => {
          startNewChatDraft();
          if (prefill !== undefined) {
            composerStore.setInputText(prefill);
          }
        },
        abortSession: () => {
          void abortSession().catch(() => {});
        },
        refreshMcps: () => {
          void loadMcps();
        },
        refreshProviders: () => {
          void Promise.all([loadProviders(), loadCompatibilityState()]);
        },
        revalidateProviderAuth: sessionSendOperations.revalidateProviderAuth,
        applyTheme,
      });

      ensureSessionEventHandlersRegistered();

      const disposeBridge = onMessage((msg: ExtensionMessage) => {
        mountBridgeOperations.handleExtensionMessage(msg);
      });

      postMessage({ type: 'ready' });
      syncQueuedMessages();

      postFocusState();

      const disposeFocusTracking = registerFocusStateTracking({
        setDocumentVisible,
        postFocusState,
        isLoading: uiStore.isLoading,
        getActiveSessionId: () => appStore.state.activeSessionId,
        recheckSessionStatus: (sessionId) => {
          void recheckSessionStatus(sessionId);
        },
        refreshProviders: () => {
          void Promise.all([loadProviders(), loadCompatibilityState()]);
        },
      });

      onCleanup(() => {
        disposeBridge();
        disposeFocusTracking();
        for (const cleanup of eventHandlerCleanups) cleanup();
        eventHandlerCleanups = [];
        invalidateConnection();
        currentWorkspacePath = undefined;
        resetMessageWindowState();
        setDocumentVisible(document.visibilityState === 'visible');
      });
    });

    registerLoadingStatusPollEffect({
      isLoading: uiStore.isLoading,
      getActiveSessionId: () => appStore.state.activeSessionId,
      isDocumentVisible: documentVisible,
      getEventStreamState: () =>
        appStore.state.serverStatus.state === 'running'
          ? appStore.state.serverStatus.eventStream
          : undefined,
      recheckSessionStatus,
      logError,
    });

    registerEventStreamRecoveryEffect({
      getEventStreamState: () =>
        appStore.state.serverStatus.state === 'running'
          ? appStore.state.serverStatus.eventStream
          : undefined,
      isLoading: uiStore.isLoading,
      getActiveSessionId: () => appStore.state.activeSessionId,
      recheckSessionStatus,
      logError,
    });

    registerProviderLimitRefreshEffect({
      getServerState: () => appStore.state.serverStatus.state,
      areProvidersLoaded: () => appStore.state.providersLoaded,
      isDocumentVisible: documentVisible,
      isActiveSessionWorking: () => {
        const activeSessionId = appStore.state.activeSessionId;
        return activeSessionId ? isSessionTreeStatusWorking(activeSessionId) : false;
      },
      getActiveProviderSelection,
      getProviderLimit: routingStore.getProviderLimit,
      loadProviderLimit: (providerID, modelID) => client.config.providerLimit(providerID, modelID),
      setProviderLimit: routingStore.setProviderLimit,
      getPollIntervalMs: () => DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS * 1000,
      logError,
    });

    registerVisibleRunningSessionSyncEffect({
      getServerState: () => appStore.state.serverStatus.state,
      isDocumentVisible: documentVisible,
      getEventStreamState: () =>
        appStore.state.serverStatus.state === 'running'
          ? appStore.state.serverStatus.eventStream
          : undefined,
      getActiveSessionId: () => appStore.state.activeSessionId,
      getSessionStatuses: () => appStore.state.sessionStatus,
      loadSessions,
      hydrateSessionStatuses: hydratePolledSessionStatuses,
      loadQuestions,
      loadPendingPermissions: syncPendingPermissions,
      syncSessionMessages: syncPolledSessionMessages,
      logError,
    });

    registerStuckSessionWatchdogEffect({
      getServerState: () => appStore.state.serverStatus.state,
      isDocumentVisible: documentVisible,
      hasBusySession: () =>
        uiStore.isLoading() ||
        Object.values(appStore.state.sessionStatus).some(
          (status) => status?.type === 'busy' || status?.type === 'retry'
        ),
      runReconcile: () => reconcileStuckSessions(),
    });

    return { client };
  }

  const stuckSessionTimers = new Map<string, number>();

  async function forceReconcileIdleSession(sessionId: string) {
    await forceReconcileIdleSessionWithDependencies(
      {
        setSessionStatusEntry,
        clearPendingAbort,
        updateUsageLimitState,
        syncSessionMessages,
        settleLatestAssistantMessage,
        isActiveSession: (id) => appStore.state.activeSessionId === id,
        isTreeWorking: isSessionTreeStatusWorking,
        stopLoading: uiStore.stopLoading,
        logError,
      },
      sessionId
    );
  }

  async function reconcileStuckSessions() {
    await reconcileStuckSessionsWithDependencies(
      {
        loadSessionStatuses: loadSessionStatusesFromSnapshot,
        getLocalSessionStatuses: () => appStore.state.sessionStatus,
        getActiveSessionId: () => appStore.state.activeSessionId,
        isLoading: uiStore.isLoading,
        isAwaitingInput: isSessionAwaitingInput,
        hasPendingAbort: (sessionId) => pendingAbortRetryAttempts.has(sessionId),
        forceReconcileIdleSession,
        logError,
        getMessages: () => appStore.state.messages,
        getStreamingText: () => ({
          partId: appStore.state.streamingPartId,
          text: appStore.state.streamingText,
        }),
      },
      stuckSessionTimers
    );
  }

  async function loadSessionStatusesFromSnapshot(): Promise<Record<string, SessionStatus>> {
    const snapshot = await loadCurrentSessionStatusSnapshot();
    statusSnapshotStartedAt.set(snapshot.statuses, snapshot.startedAt);
    return snapshot.statuses;
  }

  async function loadCurrentSessionStatusSnapshot(): Promise<SessionStatusSnapshot> {
    const generation = workspaceGeneration;
    const snapshot = await statusSnapshots.load();
    if (generation !== workspaceGeneration) throw new WorkspaceLoadInvalidatedError();
    return snapshot;
  }

  async function hydratePolledSessionStatuses(): Promise<void> {
    try {
      const snapshot = await loadCurrentSessionStatusSnapshot();
      sessionStore.setSessionStatuses(snapshot.statuses, {
        snapshotStartedAt: snapshot.startedAt,
      });
      for (const session of appStore.state.sessions) {
        updateUsageLimitState(session.id, snapshot.statuses[session.id], []);
      }
    } catch (err) {
      logError('session.status', err);
    }
  }

  function recheckSessionStatus(sessionId: string): Promise<void> {
    return recheckSessionStatusWithState(sessionId);
  }

  async function syncPendingPermissions() {
    const syncGeneration = ++permissionSyncGeneration;
    const reconciliation = permissionsStore.beginPermissionReconciliation();
    try {
      const pendingPermissions = await client.permission.list();
      if (syncGeneration < latestPermissionSyncGeneration) return;
      latestPermissionSyncGeneration = syncGeneration;
      const snapshotGeneration = ++permissionSnapshotGeneration;
      const isCurrent = () => snapshotGeneration === permissionSnapshotGeneration;
      const visiblePermissions: Permission[] = [];

      for (const item of pendingPermissions) {
        if (!isCurrent()) return;
        const permission = normalizePermissionEvent(item);
        if (!permission) continue;
        const mode = permissionsStore.getPermissionModeForSession(permission.sessionID);
        if (mode === 'full') {
          await sessionApprovalOperations
            .respondPermission(permission.sessionID, permission.id, 'always', { rethrow: true })
            .catch(() => {
              if (
                isCurrent() &&
                permissionsStore.getPermissionModeForSession(permission.sessionID) !== 'full'
              ) {
                permissionsStore.addPermission(permission);
              }
            });
          continue;
        }
        if (mode === 'auto') {
          await judgeAndRespondPermission(permission, isCurrent);
          continue;
        }
        visiblePermissions.push(permission);
      }

      if (isCurrent()) {
        permissionsStore.reconcilePermissions(visiblePermissions, reconciliation);
      }
    } finally {
      permissionsStore.finishPermissionReconciliation(reconciliation);
    }
  }

  async function judgeAndRespondPermission(permission: Permission, isCurrent = () => true) {
    try {
      const model = resolvePermissionJudgeModel(permission.sessionID);
      const response = await client.varro.judgePermission({
        permission,
        approvedReferences: approvedPermissionReferences,
        ...(model ? { model } : {}),
      });
      if (
        !isCurrent() ||
        permissionsStore.getPermissionModeForSession(permission.sessionID) !== 'auto'
      ) {
        return;
      }
      if (response.decision === 'allow') {
        await sessionApprovalOperations.respondPermission(
          permission.sessionID,
          permission.id,
          'once',
          {
            rethrow: true,
          }
        );
        return;
      }
    } catch (err) {
      logError('autoApproveJudge', err);
    }
    if (
      isCurrent() &&
      permissionsStore.getPermissionModeForSession(permission.sessionID) === 'auto'
    ) {
      permissionsStore.addPermission(permission);
    }
  }

  function initConnection() {
    return connectionBootstrapOperations.initConnection();
  }

  const dataLoaders = createStateBoundDataLoaderOperations({
    applySessions,
    updateUsageLimitState,
    logError,
  });

  const {
    loadMcps,
    loadQuestions,
    loadAgents,
    loadCommands,
    loadProviders,
    loadCompatibilityState,
    refreshProviderLimit,
    loadSessions,
    loadMoreSessions,
    loadRecycleBin,
    invalidateWorkspace,
  } = dataLoaders;
  const hydrateSessionStatuses = hydratePolledSessionStatuses;

  async function refreshRoutingState() {
    await Promise.all([dataLoaders.refreshRoutingState(), loadCompatibilityState()]);
  }

  async function reconcileServerState() {
    const activeSessionId = appStore.state.activeSessionId;
    const results = await Promise.allSettled([
      loadSessions(),
      loadRecycleBin(),
      hydrateSessionStatuses(),
      loadQuestions(),
      syncPendingPermissions(),
      loadMcps(),
      loadCommands(),
      refreshRoutingState(),
      ...(activeSessionId ? [syncSession(activeSessionId)] : []),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') logError('reconcileServerState', result.reason);
    }
  }

  const sessionMcpOperations = new SessionMcpOperations({
    getSelectedMcpsForSession: routingStore.getSelectedMcpsForSession,
    getRequiredMcpSessionIds: (targetSessionId) => [
      ...(targetSessionId ? [targetSessionId] : []),
      ...Object.entries(appStore.state.sessionStatus)
        .filter(([, status]) => status?.type === 'busy' || status?.type === 'retry')
        .map(([sessionId]) => sessionId),
    ],
    getMcpStatus: () => appStore.state.mcpStatus,
    loadMcps,
    getAvailableMcpNames: routingStore.getAvailableMcpNames,
    connectMcp: (name) => client.mcp.connect(name),
    authenticateMcp: (name) => client.mcp.authenticate(name),
    disconnectMcp: (name) => client.mcp.disconnect(name),
    logError,
    setSelectedMcpsForSession: routingStore.setSelectedMcpsForSession,
    setDraftSelectedMcps: routingStore.setDraftSelectedMcps,
  });

  const { syncSessionMcps } = sessionMcpOperations;

  function invalidateInitializationAttempt() {
    initializationAttemptGeneration += 1;
    activeInitializationAttempt = null;
  }

  function invalidateWorkspaceAsyncWork() {
    workspaceGeneration += 1;
    sessionSelectionGeneration += 1;
    permissionSyncGeneration += 1;
    latestPermissionSyncGeneration = permissionSyncGeneration;
    permissionSnapshotGeneration += 1;
    invalidateWorkspace();
    statusSnapshots.clear();
    messageSyncGenerations.clear();
    sessionMcpOperations.invalidate();
    pendingAbortRetryAttempts.clear();
    stuckSessionTimers.clear();
    sessionTitleFallbackAttempts.clear();
    sessionTitleFallbacks.clear();
    fullHistoryLoads.clear();
    historyPageLoads.clear();
    promptHistoryLoads.clear();
    promptHistoryPageLoads.clear();
    approvedPermissionReferences = [];
  }

  function invalidateConnection() {
    invalidateClientWorkspaceState();
    connectionGeneration += 1;
    invalidateInitializationAttempt();
    invalidateWorkspaceAsyncWork();
    initialized = false;
    uiStore.setConnectionInitialized(false);
  }

  function resetWorkspaceForChange() {
    invalidateClientWorkspaceState();
    connectionGeneration += 1;
    invalidateInitializationAttempt();
    invalidateWorkspaceAsyncWork();
    resetWorkspaceDerivedState();
  }

  function reloadWorkspaceAfterChange(wasInitialized: boolean) {
    if (appStore.state.serverStatus.state !== 'running') return;
    if (wasInitialized) {
      void reconcileServerState();
      return;
    }
    ensureConnectionInitialized();
  }

  async function applySessionMcps(names: string[], sessionId = appStore.state.activeSessionId) {
    await sessionMcpOperations.applySessionMcps(names, sessionId);
  }

  const connectionBootstrapOperations = createConnectionBootstrapOperations({
    health: client.health,
    loadInitialData: async () => {
      await Promise.all([
        loadSessions(),
        loadAgents(),
        loadCommands(),
        loadProviders(),
        loadCompatibilityState(),
        loadMcps(),
        loadQuestions(),
        loadRecycleBin(),
      ]);
    },
    hydrateSessionStatuses,
    getActiveSessionId: () => appStore.state.activeSessionId,
    getPersistedActiveSessionId: sessionStore.getPersistedActiveSessionId,
    getPersistedLastOpenedView: sessionStore.getPersistedLastOpenedView,
    getSessionCount: () => appStore.state.sessions.length,
    getOnlyPrimarySessionId: () => {
      const primarySessions = appStore.state.sessions.filter((session) => !session.parentID);
      return primarySessions.length === 1 ? primarySessions[0]?.id || null : null;
    },
    hasSession: (sessionId) => appStore.state.sessions.some((session) => session.id === sessionId),
    selectSession: (sessionId) => sessionSyncOperations.selectSession(sessionId),
    setShowSessionPicker: uiStore.setShowSessionPicker,
    setInitialized: (value) => {
      initialized = value;
      uiStore.setConnectionInitialized(value);
    },
    setError: uiStore.setError,
    nextConnectionGeneration: () => ++connectionGeneration,
    isCurrentConnectionGeneration: (generation) =>
      isCurrentGeneration(generation, connectionGeneration),
    consumeInterruptedSessionIds: appStore.consumeInterruptedSessionIds,
    getSessionStatus: (sessionId) => appStore.state.sessionStatus[sessionId],
    hasPendingQuestion: (sessionId) =>
      appStore.state.questions.some((item) => item.sessionID === sessionId),
    hasPendingPermission: (sessionId) =>
      appStore.state.permissions.some((item) => item.sessionID === sessionId),
    loadSessionMessages: (sessionId) => {
      const generation = workspaceGeneration;
      return loadSessionMessagesAllowingEmpty(sessionId, () => generation === workspaceGeneration);
    },
    logError,
    syncSessionMcps,
    resolveModel: (id) =>
      routingStore.resolveSelectedModel(
        routingStore.getSelectedModelForSession(id),
        appStore.state.providers,
        appStore.state.providerDefaults
      ),
    resolveAgent: (id) =>
      routingStore.getSelectedAgentForSession(id) || getDefaultPrimaryAgentNameFromState(),
    sendAsync: (id, body) => client.session.sendAsync(id, body),
    syncSession,
    recheckSessionStatus,
  });

  async function continueInterruptedSession(sessionId: string) {
    await connectionBootstrapOperations.continueInterruptedSession(sessionId);
  }

  const sessionSendOperations = new SessionSendOperations({
    getWorkspaceGeneration: () => workspaceGeneration,
    createSession: (initialPermissionMode) => createSession(undefined, initialPermissionMode),
    ensureSessionPermission: (sessionId) =>
      ensureSessionPermissionWithDependencies(
        {
          getSession: (id) => appStore.state.sessions.find((session) => session.id === id),
          buildPermissionRules: (mode) => getSessionPermissionRulesForMode(mode, 'update'),
          getPermissionMode: permissionsStore.getPermissionModeForSession,
          updateSessionPermission: (id, input) => client.session.update(id, input),
          upsertSession,
          setError: uiStore.setError,
        },
        sessionId
      ),
    clearPendingAbort,
    resetTodoSync,
    syncSessionMcps,
    sendAsync: async (sessionId, body) => {
      const response = await client.session.sendAsync(sessionId, body);
      void repairSessionTitle(sessionId).catch((err) => logError('repairSessionTitle', err));
      return response;
    },
    syncSession,
    syncSessionMessages,
    recheckSessionStatus,
    setSessionStatusEntry,
    getMessageCount: (sessionId) => {
      const loadedCount = appStore.state.messages.filter(
        (entry) => entry.info.sessionID === sessionId
      ).length;
      return appStore.state.activeSessionId === sessionId || loadedCount > 0
        ? loadedCount
        : (appStore.state.sessionMessageCounts[sessionId] ?? 0);
    },
    continueInterruptedSession,
    logError,
  });

  function ensureConnectionInitialized() {
    ensureConnectionInitializedWithDependencies({
      isInitialized: () => initialized,
      isInitializing: () => activeInitializationAttempt !== null,
      initConnection,
      beginInitializing: () => {
        activeInitializationAttempt = ++initializationAttemptGeneration;
        return activeInitializationAttempt;
      },
      finishInitializing: (attempt) => {
        if (activeInitializationAttempt === attempt) activeInitializationAttempt = null;
      },
    });
  }

  const sessionSyncOperations = new SessionSyncOperations(
    {
      getActiveSessionId: () => appStore.state.activeSessionId,
      setActiveSessionId: sessionStore.setActiveSessionId,
      clearPendingAbort,
      persistActiveSessionId: sessionStore.persistActiveSessionId,
      markSessionSeen: sessionStore.markSessionSeen,
      clearDraftCurrentDocumentState: composerStore.clearDraftCurrentDocumentState,
      resetToolCallExpansionState,
      resolvePersistedAgent: (sessionId) => ({
        persistedAgent: routingStore.getSelectedAgentForSession(sessionId),
        fallbackAgent:
          routingStore.getPersistedSelectedAgent() || getDefaultPrimaryAgentNameFromState(),
      }),
      applySelectedAgent: (agent, sessionId) =>
        routingStore.setSelectedAgent(agent, { sessionId, persistGlobal: false }),
      getSession: (sessionId) =>
        appStore.state.sessions.find((session) => session.id === sessionId),
      resolveSessionModel: deriveSelectedModelFromSession,
      resolvePersistedModel: routingStore.getSelectedModelForSession,
      resolveFallbackModel: routingStore.getPersistedSelectedModel,
      applySelectedModel: (model, sessionId) =>
        routingStore.setSelectedModel(model, { sessionId, persistGlobal: false }),
      getConnectedMcpNames: routingStore.getConnectedMcpNames,
      hasSelectedMcps: (sessionId) => routingStore.getSelectedMcpsForSession(sessionId) !== null,
      setSelectedMcpsForSession: routingStore.setSelectedMcpsForSession,
      syncSessionMcps,
      resetTodoSync,
      clearMessages: sessionStore.clearMessages,
      setMessagesLoading: (loading) => appStore.setState('messagesLoading', loading),
      loadSession: (sessionId, isCurrentSelection = () => true) => {
        const generation = workspaceGeneration;
        return loadSessionWithMessages(
          sessionId,
          () => generation === workspaceGeneration && isCurrentSelection()
        );
      },
      isCurrentSelectionGeneration: (generation) =>
        isCurrentGeneration(generation, sessionSelectionGeneration),
      upsertSession,
      setMessagesIncremental: (messages, options) => {
        const sessionId = appStore.state.activeSessionId ?? messages[0]?.info.sessionID;
        if (!sessionId) {
          sessionStore.setMessagesIncremental(messages, options);
          return;
        }
        setSessionMessagesIncremental(sessionId, messages, options);
      },
      syncFailedSessionsFromMessages: sessionStore.syncFailedSessionsFromMessages,
      requestMessageListScrollToBottom: uiStore.requestMessageListScrollToBottom,
      deriveSelectedAgentFromMessages,
      deriveSelectedModelFromMessages: (messages) =>
        resolveMessagesSelectedModel(
          messages,
          appStore.state.providers,
          appStore.state.providerDefaults,
          deriveSelectedModelFromMessages
        ),
      syncTodosForSession,
      loadQuestions: async () => {
        await loadQuestions().catch((err) => logError('loadQuestions', err));
      },
      loadSessionStatuses: loadSessionStatusesFromSnapshot,
      mergeSessionStatuses: (statuses, options) =>
        sessionStore.setSessionStatuses(statuses, {
          snapshotStartedAt: statusSnapshotStartedAt.get(statuses) ?? options?.snapshotStartedAt,
        }),
      updateUsageLimitState,
      setSessionStatusEntry,
      startLoading: uiStore.startLoading,
      stopLoading: uiStore.stopLoading,
      setError: uiStore.setError,
      getSessionStatus: (id) => appStore.state.sessionStatus[id],
      loadingStartedAt: uiStore.loadingStartedAt,
      loadSessionMessages: (sessionId, isCurrentSync = () => true) => {
        const generation = workspaceGeneration;
        return loadSessionMessagesAllowingEmpty(
          sessionId,
          () => generation === workspaceGeneration && isCurrentSync()
        );
      },
      handoffTodosToMessages,
      loadSessionMetadata: (id) => client.session.get(id),
    },
    {
      nextSelection: () => ++sessionSelectionGeneration,
      isCurrentSync: messageSyncGenerations.isCurrent,
    }
  );

  const sessionControlOperations = new SessionControlOperations({
    getActiveSessionId: () => appStore.state.activeSessionId,
    sendMessage,
    getSessionTreeRootId: sessionStore.getSessionTreeRootId,
    getSessionTreeIds: sessionStore.getSessionTreeIds,
    getSelectedAgentForSession: routingStore.getSelectedAgentForSession,
    skipPlanSession: sessionStore.skipPlanSession,
    getSessionStatus: (sessionId) => appStore.state.sessionStatus[sessionId],
    getSessionUsageLimit: (sessionId) => appStore.state.sessionUsageLimits[sessionId],
    markPendingAbortTree,
    setSessionStatusEntry,
    stopLoading: uiStore.stopLoading,
    abortRemoteSession: (sessionId) => client.session.abort(sessionId),
    clearPendingAbortTree,
    setSessionUsageLimit: sessionStore.setSessionUsageLimit,
    logError,
    getMessages: () => appStore.state.messages,
    startLoading: uiStore.startLoading,
    invalidateMessageSync: (sessionId) => messageSyncGenerations.invalidate(sessionId),
    pruneMessagesFrom: sessionStore.pruneMessagesFrom,
    deleteMessage: (sessionId, messageId) => client.session.deleteMessage(sessionId, messageId),
    revertSession: (sessionId, messageId) => client.session.revert(sessionId, messageId),
    syncSession,
    syncSessionMessages,
    setError: uiStore.setError,
    isSessionWorking: (sessionId) => isSessionTreeStatusWorking(sessionId),
    sendEditedMessage: (text, sessionId, queuedAttachments) =>
      sessionSendOperations.sendMessage(text, { targetSessionId: sessionId, queuedAttachments }),
    prepareEditedMessageSend: (text, sessionId, queuedAttachments) =>
      sessionSendOperations.prepareSendMessage(text, {
        targetSessionId: sessionId,
        queuedAttachments,
      }),
    unrevertSession: (sessionId) => client.session.unrevert(sessionId),
    upsertSession,
    clearPendingAbort,
    resolveSelectedModel: () =>
      routingStore.resolveSelectedModel(
        appStore.state.selectedModel,
        appStore.state.providers,
        appStore.state.providerDefaults
      ),
    setSessionCompacting: sessionStore.setSessionCompacting,
    compactRemoteSession: (sessionId, input) => client.session.compact(sessionId, input),
    getSession: (sessionId) => appStore.state.sessions.find((session) => session.id === sessionId),
  });

  const sessionActionOperations = new SessionActionOperations({
    getActiveSessionId: () => appStore.state.activeSessionId,
    getBuildAgent: getBuildAgentNameFromState,
    setError: uiStore.setError,
    clearSkippedPlanSession: sessionStore.clearSkippedPlanSession,
    applySelectedAgent: (agent, sessionId) =>
      routingStore.setSelectedAgent(agent, { sessionId, persistGlobal: false }),
    sendMessage,
    openPlan: (content) => client.varro.openPlan(content),
    createSession: () =>
      createSession(undefined, permissionsStore.getPermissionModeForSession(null)),
    getMessageCount: () => appStore.state.messages.length,
    hasCommand: routingStore.hasCommand,
    startLoading: uiStore.startLoading,
    runSessionCommand: (sessionId, input) => client.session.command(sessionId, input),
    shouldApplyToActiveSession: (sessionId) => appStore.state.activeSessionId === sessionId,
    upsertMessageInfo: sessionStore.upsertMessageInfo,
    upsertPart: sessionStore.upsertPart,
    syncTodosFromMessages,
    requestMessageListScrollToBottom: uiStore.requestMessageListScrollToBottom,
    syncSession,
    recheckSessionStatus,
    stopLoading: uiStore.stopLoading,
  });

  const sessionApprovalOperations = new SessionApprovalOperations({
    respondRemotePermission: (sessionId, permissionId, response) =>
      client.session.respondPermission(sessionId, permissionId, response),
    removePermission: permissionsStore.removePermission,
    setError: uiStore.setError,
    replyQuestion: (requestId, answers) => client.question.reply(requestId, answers),
    removeQuestion: permissionsStore.removeQuestion,
    rejectRemoteQuestion: (requestId) => client.question.reject(requestId),
    getPermissionModeForSession: permissionsStore.getPermissionModeForSession,
    getDraftPermissionMode: permissionsStore.draftPermissionMode,
    setPermissionModeForSession: permissionsStore.setPermissionModeForSession,
    setDraftPermissionMode: permissionsStore.setDraftPermissionMode,
    saveProjectPermissionMode: permissionsStore.saveProjectPermissionMode,
    updateSessionPermission: (sessionId, input) => client.session.update(sessionId, input),
    upsertSession,
    getPermissionsForSession: (sessionId) => {
      const rootId = getSessionTreeRootId(sessionId) || sessionId;
      const sessionIds = new Set(getSessionTreeIds(rootId));
      return appStore.state.permissions.filter((permission) =>
        permissionsStore
          .getPermissionGroupMembers(permission)
          .some((member) => sessionIds.has(member.sessionID))
      );
    },
    syncPendingPermissions,
  });

  const sessionManagementOperations = new SessionManagementOperations({
    getActiveSessionId: () => appStore.state.activeSessionId,
    getWorkspaceGeneration: () => workspaceGeneration,
    getNewChatDraftGeneration,
    createRemoteSession: (body) => client.session.create(body),
    updateRemoteSession: (sessionId, body) => client.session.update(sessionId, body),
    forkRemoteSession: (sessionId, messageID) => client.session.fork(sessionId, messageID),
    getPermissionModeForSession: permissionsStore.getPermissionModeForSession,
    buildCreatePermission: (mode) => getSessionPermissionRulesForMode(mode, 'create'),
    upsertSession,
    resetToolCallExpansionState,
    setActiveSessionId: sessionStore.setActiveSessionId,
    clearDraftCurrentDocumentState: composerStore.clearDraftCurrentDocumentState,
    adoptDraftCurrentDocumentState: composerStore.adoptDraftCurrentDocumentState,
    setSessionStatusEntry,
    setSessionUsageLimit: sessionStore.setSessionUsageLimit,
    persistActiveSessionId: sessionStore.persistActiveSessionId,
    markSessionSeen: sessionStore.markSessionSeen,
    getDefaultSelectedModel: routingStore.getPersistedSelectedModel,
    setSelectedModel: routingStore.setSelectedModel,
    resolveDefaultAgent: () =>
      getBuildAgentNameFromState() ||
      routingStore.getPersistedSelectedAgent() ||
      getDefaultPrimaryAgentNameFromState(),
    setSelectedAgent: routingStore.setSelectedAgent,
    getInitialMcpNames: () => routingStore.getSelectedMcpsForSession(null) || [],
    setSelectedMcpsForSession: routingStore.setSelectedMcpsForSession,
    resetDraftSelectedMcps: routingStore.resetDraftSelectedMcps,
    setPermissionModeForSession: permissionsStore.setPermissionModeForSession,
    resetDraftPermissionMode: permissionsStore.resetDraftPermissionMode,
    resetTodoSync,
    clearMessages: sessionStore.clearMessages,
    stopLoading: uiStore.stopLoading,
    setError: uiStore.setError,
    getSessions: () => appStore.state.sessions,
    getDeletedSessionTreeIds,
    getNextSessionIdAfterDeletion,
    deleteRemoteSession: (sessionId) => client.session.delete(sessionId),
    hideDeletedSessionTree,
    loadRecycleBin,
    selectSession,
    logError,
    restoreRecycleBinEntry: (rootID) => client.varro.recycleBin.restore(rootID),
    loadSessions,
    hydrateSessionStatuses,
    getRecycleBinEntries: () => appStore.state.recycleBinEntries,
    deleteRecycleBinEntry: (rootID) => client.varro.recycleBin.delete(rootID),
    clearDeletedSessionState,
    emptyRecycleBin: () => client.varro.recycleBin.empty(),
  });

  async function selectSession(id: string, options?: SessionSelectionOptions) {
    messageSyncGenerations.invalidate(id);
    await sessionSyncOperations.selectSession(id, options);
    if (appStore.state.activeSessionId === id) {
      sessionStore.persistLastOpenedView({ type: 'session', sessionId: id });
    }
  }

  function runSessionMessageSync(sessionId: string): Promise<boolean> {
    return messageSyncGenerations.run(sessionId, (token) =>
      sessionSyncOperations.syncSessionMessages(sessionId, token)
    );
  }

  function syncSessionMessages(sessionId: string): Promise<void> {
    return sessionMessageSyncCoordinator.sync(sessionId);
  }

  function syncPolledSessionMessages(sessionId: string): Promise<void> {
    return sessionMessageSyncCoordinator.syncIfStale(sessionId);
  }

  async function syncSession(sessionId: string) {
    await sessionSyncOperations.syncSession(sessionId);
  }

  async function createSession(
    title?: string,
    initialPermissionMode = permissionsStore.getPermissionModeForSession(null)
  ): Promise<string | null> {
    const sessionId = await sessionManagementOperations.createSession(title, initialPermissionMode);
    if (sessionId) sessionStore.persistLastOpenedView({ type: 'session', sessionId });
    return sessionId;
  }

  async function loadFullSessionHistory(sessionId: string) {
    const existing = fullHistoryLoads.get(sessionId);
    const generation = workspaceGeneration;
    const selectionGeneration = sessionSelectionGeneration;
    const revision = getSessionMessageWindowRevision(sessionId);
    if (
      existing?.workspaceGeneration === generation &&
      existing.selectionGeneration === selectionGeneration &&
      existing.revision === revision
    ) {
      return existing.promise;
    }

    const isCurrent = () =>
      generation === workspaceGeneration &&
      selectionGeneration === sessionSelectionGeneration &&
      revision === getSessionMessageWindowRevision(sessionId) &&
      appStore.state.activeSessionId === sessionId;
    const load = (async () => {
      const visitedCursors = new Set<string>();
      while (isCurrent()) {
        const cursor = getSessionHistoryCursor(sessionId);
        if (!cursor) return;
        if (visitedCursors.has(cursor)) {
          setSessionHistoryCursor(sessionId);
          return;
        }
        visitedCursors.add(cursor);
        if (!(await loadOlderSessionHistoryPage(sessionId))) return;
      }
    })().finally(() => {
      if (fullHistoryLoads.get(sessionId)?.promise === load) fullHistoryLoads.delete(sessionId);
    });
    fullHistoryLoads.set(sessionId, {
      workspaceGeneration: generation,
      selectionGeneration,
      revision,
      promise: load,
    });
    return load;
  }

  function loadOlderSessionHistoryPage(sessionId: string): Promise<boolean> {
    const existing = historyPageLoads.get(sessionId);
    const generation = workspaceGeneration;
    const selectionGeneration = sessionSelectionGeneration;
    const revision = getSessionMessageWindowRevision(sessionId);
    if (
      existing?.workspaceGeneration === generation &&
      existing.selectionGeneration === selectionGeneration &&
      existing.revision === revision
    ) {
      return existing.promise;
    }

    const isCurrent = () =>
      generation === workspaceGeneration &&
      selectionGeneration === sessionSelectionGeneration &&
      revision === getSessionMessageWindowRevision(sessionId) &&
      appStore.state.activeSessionId === sessionId;
    const load = (async () => {
      const cursor = getSessionHistoryCursor(sessionId);
      if (!cursor || !isCurrent()) return false;
      try {
        let page = takeCachedSessionHistoryPage(sessionId, cursor);
        const promptPageLoad = promptHistoryPageLoads.get(sessionId);
        if (!page && promptPageLoad?.revision === revision && promptPageLoad.cursor === cursor) {
          const prefetchedPage = await promptPageLoad.promise;
          if (!isCurrent()) return false;
          page = takeCachedSessionHistoryPage(sessionId, cursor) ?? prefetchedPage;
        }
        page ??= await client.session.messages(sessionId, {
          limit: MESSAGE_HISTORY_WINDOW,
          before: cursor,
        });
        if (!isCurrent()) return false;
        const current = appStore.state.messages.filter(
          (entry) => entry.info.sessionID === sessionId
        );
        setSessionMessagesIncremental(sessionId, mergeOlderHistory(current, page), undefined, {
          preserveSessionStreaming: true,
        });
        const nextCursor = advanceSessionHistoryCursor(sessionId, cursor, page.nextCursor);
        markSessionHistoryLoadFailed(sessionId, false);
        if (nextCursor) void loadSessionBoundaryPrompts(sessionId, nextCursor, isCurrent);
        return page.length > 0 || nextCursor !== undefined;
      } catch (err) {
        if (isCurrent()) {
          markSessionHistoryLoadFailed(sessionId, true);
        }
        if (isCurrent()) logError('loadOlderSessionHistoryPage', err);
        return false;
      }
    })().finally(() => {
      if (historyPageLoads.get(sessionId)?.promise === load) historyPageLoads.delete(sessionId);
    });
    historyPageLoads.set(sessionId, {
      workspaceGeneration: generation,
      selectionGeneration,
      revision,
      promise: load,
    });
    return load;
  }

  async function forkSession(id: string, messageID?: string): Promise<string | null> {
    const sessionId = await sessionManagementOperations.forkSession(id, messageID);
    if (sessionId) sessionStore.persistLastOpenedView({ type: 'session', sessionId });
    return sessionId;
  }

  async function renameSession(id: string, title: string): Promise<boolean> {
    return sessionManagementOperations.renameSession(id, title);
  }

  async function deleteSession(id: string) {
    await sessionManagementOperations.deleteSession(id);
  }

  async function restoreSession(rootID: string) {
    await sessionManagementOperations.restoreSession(rootID);
  }

  async function deleteSessionPermanently(rootID: string) {
    await sessionManagementOperations.deleteSessionPermanently(rootID);
  }

  async function emptyRecycleBin() {
    await sessionManagementOperations.emptyRecycleBin();
  }

  async function reloadSessions() {
    await Promise.all([loadSessions(), loadRecycleBin()]);
  }

  function loadOlderSessionPromptsForCurrentWorkspace(sessionId: string) {
    const generation = workspaceGeneration;
    return loadOlderSessionPrompts(sessionId, undefined, () => generation === workspaceGeneration);
  }

  async function sendMessage(
    text: string,
    options?: {
      agent?: string;
      noReply?: boolean;
      delivery?: 'steer' | 'queue';
      queuedAttachments?: QueuedAttachmentSnapshot;
      preserveComposer?: boolean;
      targetSessionId?: string;
    }
  ): Promise<boolean> {
    return await sessionSendOperations.sendMessage(text, options);
  }

  async function retryMessage(messageId: string, sessionId = appStore.state.activeSessionId) {
    await sessionSendOperations.retryMessage(messageId, sessionId);
  }

  async function editMessage(
    messageId: string,
    text: string,
    options?: {
      allowEmptyText?: boolean;
      queuedAttachments?: QueuedAttachmentSnapshot;
      onOptimisticPublish?: () => void;
    }
  ) {
    return await sessionControlOperations.editMessage(messageId, text, options);
  }

  async function implementPlan(prompt: string, sessionId = appStore.state.activeSessionId) {
    await sessionActionOperations.implementPlan(prompt, sessionId);
  }

  async function openPlan(markdown: string, sessionId = appStore.state.activeSessionId) {
    await sessionActionOperations.openPlan(markdown, sessionId);
  }

  async function abortSession() {
    await sessionControlOperations.abortSession();
  }

  async function undoSession() {
    await sessionControlOperations.undoSession();
  }

  async function redoSession() {
    await sessionControlOperations.redoSession();
  }

  async function initSession() {
    await sessionActionOperations.initSession();
  }

  async function runSlashCommandByName(name: string, args: string) {
    return sessionActionOperations.runSlashCommandByName(name, args);
  }

  async function reviewSession() {
    await sessionControlOperations.reviewSession();
  }

  async function compactSession() {
    await sessionControlOperations.compactSession();
  }

  async function respondPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ) {
    const permission = appStore.state.permissions.find((item) => item.id === permissionId);
    await sessionApprovalOperations.respondPermission(sessionId, permissionId, response, {
      ...options,
      ...(response === 'reject' && permission
        ? { groupMembers: permissionsStore.getPermissionGroupMembers(permission) }
        : {}),
    });
    if (permission && response !== 'reject' && !options?.rethrow) {
      recordApprovedPermissionReference(permission, response);
    }
  }

  function recordApprovedPermissionReference(
    permission: Permission,
    response: AutoApproveJudgeReference['response']
  ) {
    approvedPermissionReferences = [
      ...approvedPermissionReferences,
      toApprovedPermissionReference(permission, response),
    ].slice(-20);
  }

  async function respondQuestion(
    requestID: string,
    answers: Array<Array<string>>,
    options?: { rethrow?: boolean }
  ) {
    await sessionApprovalOperations.respondQuestion(requestID, answers, options);
  }

  async function updatePermissionModeForSession(
    mode: PermissionMode,
    sessionId = appStore.state.activeSessionId
  ) {
    await sessionApprovalOperations.updatePermissionModeForSession(
      mode,
      getSessionPermissionRulesForMode(mode, 'update'),
      sessionId
    );
  }

  async function rejectQuestion(requestID: string, options?: { rethrow?: boolean }) {
    await sessionApprovalOperations.rejectQuestion(requestID, options);
  }

  return {
    useOpenCode,
    recheckSessionStatus,
    refreshRoutingState,
    continueInterruptedSession,
    applySessionMcps,
    selectSession,
    loadFullSessionHistory,
    loadOlderSessionHistoryPage,
    loadOlderSessionPrompts: loadOlderSessionPromptsForCurrentWorkspace,
    createSession,
    renameSession,
    forkSession,
    deleteSession,
    deleteSessionImmediately,
    restoreSession,
    deleteSessionPermanently,
    emptyRecycleBin,
    reloadSessions,
    loadMoreSessions,
    sendMessage,
    retryMessage,
    editMessage,
    implementPlan,
    openPlan,
    abortSession,
    undoSession,
    redoSession,
    initSession,
    runSlashCommandByName,
    reviewSession,
    compactSession,
    respondPermission,
    respondQuestion,
    updatePermissionModeForSession,
    rejectQuestion,
  };
}
