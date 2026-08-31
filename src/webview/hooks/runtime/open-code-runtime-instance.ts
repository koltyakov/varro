import { batch, createSignal, onCleanup, onMount } from 'solid-js';
import { reconcile } from 'solid-js/store';
import type {
  AutoApproveJudgeReference,
  ExtensionMessage,
  PermissionMode,
  QueuedContextSnapshot,
  SessionWorkspaceTarget,
  WebviewThemeKind,
} from '../../../shared/protocol';
import {
  AUTO_APPROVE_JUDGE_TIMEOUT_MS,
  createSessionWorkspaceMetadata,
} from '../../../shared/protocol';
import { DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS } from '../../../shared/provider-limit-config';
import { isPlaceholderSessionTitle } from '../../../shared/session-title';
import { isSameWorkspacePath } from '../../../shared/workspace-path';
import { onMessage, postMessage } from '../../lib/bridge';
import * as clientModule from '../../lib/client';
import type { SelectedModel, SessionSelectionOptions } from '../../lib/app-state-types';
import { appStore } from '../../lib/stores/app-store';
import { manualWorkspaceSelection } from '../../lib/app-state';
import { composerStore } from '../../lib/stores/composer-store';
import { permissionsStore } from '../../lib/stores/permissions-store';
import { ralphStore } from '../../lib/stores/ralph-store';
import { routingStore } from '../../lib/stores/routing-store';
import {
  captureSessionStatusSnapshotTime,
  resetSessionStatusSnapshotTracking,
  sessionStore,
} from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import { toApprovedPermissionReference, toPlainJudgeModel } from '../../lib/judge-request';
import { resetMessageEditState } from '../../lib/message-edit-state';
import { isWorkspaceDirectoryText } from '../../lib/part-utils';
import { resolveTaskSessionId } from '../../lib/task-session';
import { normalizePermissionEvent } from '../../lib/session-event-reducer';
import { flushPendingStreamingDeltasFor } from '../../lib/streaming-deltas';
import { resetToolCallExpansionState } from '../../lib/tool-call-expansion-state';
import { applyWebviewTheme } from '../../lib/theme';
import { DeferredMessageRemovals } from './deferred-message-removals';
import type { MessageEntry, Permission, Session, SessionStatus } from '../../types';
import {
  clearQueuedMessagesForSession,
  getModelPreferencesSnapshot,
  getSessionTreeIds,
  getSessionTreeRootId,
  isSessionAwaitingInput,
  isSessionTreeStatusWorking,
  setQueuedMessageEdit,
  syncQueuedMessages,
} from '../../lib/state';
import {
  advanceSessionHistoryCursor,
  advanceSessionHistoryPromptCursor,
  cacheSessionHistoryPage,
  clearSessionMessageWindowState,
  getCachedSessionMessages,
  getSessionMessageSnapshotMutationRevision,
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
  setCachedSessionMessages,
  setSessionHistoryPrompts,
  setSessionHistoryPromptCursor,
  setSessionHistoryCursor,
  takeCachedSessionHistoryPage,
} from '../../lib/message-window';
import { getNewChatDraftGeneration, startNewChatDraft } from '../../lib/new-chat-draft';
import { readInitialWebviewState, readWebviewInstanceContext } from '../../lib/state-stored-values';
import { STORAGE_KEYS, writeStored } from '../../lib/state-storage';
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
import { getSessionPermissionRulesForMode, isEditPermission } from '../permission-rules';
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
  normalizeProjectPath,
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
import { asRecord, isString } from '../../lib/runtime-values';

const client = clientModule.client;

function getSessionDirectory(sessionId: string): string | undefined {
  return appStore.state.sessions.find((session) => session.id === sessionId)?.directory;
}

function invalidateClientWorkspaceState() {
  clientModule.invalidateClientWorkspaceCaches();
}

export interface OpenCodeRuntime {
  useOpenCode(): { client: typeof client };
  recheckSessionStatus(sessionId: string): Promise<void>;
  refreshRoutingState(): Promise<void>;
  continueInterruptedSession(sessionId: string): Promise<void>;
  applySessionMcps(names: string[], sessionId?: string | null): Promise<void>;
  selectSession(id: string, options?: SessionSelectionOptions): Promise<boolean>;
  loadFullSessionHistory(sessionId: string): Promise<void>;
  loadOlderSessionHistoryPage(
    sessionId: string,
    options?: { prefetchBoundaryPrompts?: boolean }
  ): Promise<boolean>;
  loadOlderSessionPrompts(sessionId: string): Promise<boolean>;
  createSession(title?: string, initialPermissionMode?: PermissionMode): Promise<string | null>;
  renameSession(id: string, title: string): Promise<boolean>;
  forkSession(id: string, messageID?: string): Promise<string | null>;
  deleteSession(id: string): Promise<void>;
  deleteSessionImmediately(id: string, options?: { directory?: string }): Promise<void>;
  restoreSession(rootID: string): Promise<void>;
  deleteSessionPermanently(rootID: string): Promise<void>;
  emptyRecycleBin(): Promise<void>;
  reloadSessions(): Promise<void>;
  loadMoreSessions(): Promise<void>;
  sendMessage(
    text: string,
    options?: {
      messageId?: string;
      agent?: string;
      noReply?: boolean;
      delivery?: 'steer' | 'queue';
      queuedAttachments?: QueuedAttachmentSnapshot;
      queuedContext?: QueuedContextSnapshot;
      preserveComposer?: boolean;
      targetSessionId?: string;
      newSessionWorkspace?: SessionWorkspaceTarget;
      queuedMessageDispatch?: { itemId: string; lease: number };
    }
  ): Promise<boolean>;
  retryMessage(messageId: string, sessionId?: string | null): Promise<void>;
  editMessage(
    messageId: string,
    text: string,
    options?: {
      allowEmptyText?: boolean;
      queuedAttachments?: QueuedAttachmentSnapshot;
      selectedModel?: SelectedModel;
      onOptimisticPublish?: () => void;
    }
  ): Promise<boolean>;
  implementPlan(prompt: string, sessionId?: string | null): Promise<void>;
  openPlan(markdown: string, sessionId?: string | null): Promise<void>;
  abortSession(): Promise<void>;
  undoSession(): Promise<void>;
  redoSession(): Promise<void>;
  initSession(): Promise<void>;
  runSlashCommandByName(name: string, args: string): Promise<boolean>;
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

function logError<T>(context: string, err: T) {
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

function publishSessionModel(sessionId: string, model: SelectedModel | null) {
  postMessage({
    type: 'session-model/update',
    payload: {
      sessionId,
      model: model
        ? {
            providerID: model.providerID,
            modelID: model.modelID,
            variant: model.variant || undefined,
          }
        : null,
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

type PermissionJudgeAttempt = {
  permission: Permission;
  automationLease?: number;
  status: 'judging' | 'visible' | 'responded';
  countedInFlight: boolean;
  promise: Promise<void>;
};

type PermissionJudgeOutcome =
  | { type: 'decision'; response: Awaited<ReturnType<typeof client.varro.judgePermission>> }
  | { type: 'error'; error: unknown }
  | { type: 'timeout' };

const MAX_AUTO_APPROVE_ACTIVITY = 40;

function startAutoApproveActivity(permission: Permission) {
  const current = appStore.state.sessionAutoPermissionActivity[permission.sessionID] ?? [];
  appStore.setState(
    'sessionAutoPermissionActivity',
    permission.sessionID,
    [
      ...current.filter((activity) => activity.permissionId !== permission.id),
      {
        permissionId: permission.id,
        status: 'reviewing' as const,
        title: permission.title?.trim() || permission.type,
        createdAt: Date.now(),
      },
    ].slice(-MAX_AUTO_APPROVE_ACTIVITY)
  );
}

function finishAutoApproveActivity(
  permission: Pick<Permission, 'id' | 'sessionID'> & Partial<Pick<Permission, 'title' | 'type'>>,
  status:
    | 'auto-approved'
    | 'approval-required'
    | 'auto-review-failed'
    | 'manually-approved'
    | 'manually-rejected',
  detail?: string
) {
  const current = appStore.state.sessionAutoPermissionActivity[permission.sessionID] ?? [];
  const index = current.findIndex((activity) => activity.permissionId === permission.id);
  const next = {
    permissionId: permission.id,
    status,
    title:
      permission.title?.trim() || permission.type || current[index]?.title || 'Permission request',
    detail: detail || undefined,
    createdAt: index >= 0 ? current[index]!.createdAt : Date.now(),
  };
  appStore.setState(
    'sessionAutoPermissionActivity',
    permission.sessionID,
    (index >= 0
      ? current.map((activity, i) => (i === index ? next : activity))
      : [...current, next]
    ).slice(-MAX_AUTO_APPROVE_ACTIVITY)
  );
}

function clearReviewingAutoApproveActivity(permission: Pick<Permission, 'id' | 'sessionID'>) {
  const current = appStore.state.sessionAutoPermissionActivity[permission.sessionID] ?? [];
  if (
    !current.some(
      (activity) => activity.permissionId === permission.id && activity.status === 'reviewing'
    )
  ) {
    return;
  }
  appStore.setState(
    'sessionAutoPermissionActivity',
    permission.sessionID,
    current.filter(
      (activity) => activity.permissionId !== permission.id || activity.status !== 'reviewing'
    )
  );
}

function showPermissionAfterJudge(
  attempt: PermissionJudgeAttempt,
  reason?: string,
  actionSummary?: string
) {
  attempt.permission = {
    ...attempt.permission,
    autoApproveReason: reason,
    actionSummary: actionSummary || undefined,
  };
  if (attempt.status === 'visible') {
    permissionsStore.setPermissionAutoApprovePresentation(
      attempt.permission.id,
      reason,
      actionSummary
    );
    return;
  }

  attempt.status = 'visible';
  permissionsStore.addPermission(attempt.permission);
  permissionsStore.setPermissionAutoApprovePresentation(
    attempt.permission.id,
    reason,
    actionSummary
  );
  postMessage({
    type: 'permission/reveal',
    payload: { permissionId: attempt.permission.id },
  });
}

function getPermissionJudgeErrorMessage<T>(error: T): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (isString(error) && error.trim()) return error;
  const message = asRecord(error)?.message;
  if (isString(message) && message.trim()) return message;
  return 'Unknown error';
}

function updateSessionAutoPermissionCounts(
  sessionId: string,
  changes: Partial<{ inFlight: number; approved: number; rejected: number }>
) {
  const current = appStore.state.sessionAutoPermissionCounts[sessionId] ?? {
    inFlight: 0,
    approved: 0,
    rejected: 0,
  };
  appStore.setState('sessionAutoPermissionCounts', sessionId, {
    inFlight: Math.max(0, changes.inFlight ?? current.inFlight),
    approved: changes.approved ?? current.approved,
    rejected: changes.rejected ?? current.rejected,
  });
}

function getPermissionDecisionScopeId(sessionId: string) {
  return getSessionTreeRootId(sessionId) || sessionId;
}

function finishPermissionJudgeAttempt(attempt: PermissionJudgeAttempt) {
  if (!attempt.countedInFlight) return;
  attempt.countedInFlight = false;
  const current = appStore.state.sessionAutoPermissionCounts[attempt.permission.sessionID];
  updateSessionAutoPermissionCounts(attempt.permission.sessionID, {
    inFlight: (current?.inFlight ?? 0) - 1,
  });
}

function isPermissionSessionKnown(sessionId: string): boolean {
  const visited = new Set<string>();
  let currentSessionId: string | undefined = sessionId;

  while (currentSessionId && !visited.has(currentSessionId)) {
    if (Object.hasOwn(appStore.state.sessionPermissionModes, currentSessionId)) return true;
    visited.add(currentSessionId);

    const session = appStore.state.sessions.find((item) => item.id === currentSessionId);
    if (!session) return false;
    currentSessionId = session.parentID;
  }

  return true;
}

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
      const startedAt = captureSessionStatusSnapshotTime();
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
      (err) => {
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

function isNotFoundError<T>(err: T) {
  return err instanceof Error && /^404\b/.test(err.message);
}

function mergeSessionMessages(
  current: MessageEntry[],
  sessionId: string,
  incoming: MessageEntry[],
  sessions: Session[] = appStore.state.sessions
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
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (firstSessionIndex < 0 && !session?.parentID) {
      return mergeParentSnapshotWithRecoveredSessions(sessionMessages, current, sessions);
    }
    const insertionIndex =
      firstSessionIndex < 0
        ? getNewSessionMessageInsertionIndex(current, sessionId, sessions)
        : firstSessionIndex;
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

function mergeParentSnapshotWithRecoveredSessions(
  parentMessages: MessageEntry[],
  recoveredMessages: MessageEntry[],
  sessions: Session[]
) {
  const recoveredBySession = new Map<string, MessageEntry[]>();
  for (const entry of recoveredMessages) {
    const entries = recoveredBySession.get(entry.info.sessionID);
    if (entries) entries.push(entry);
    else recoveredBySession.set(entry.info.sessionID, [entry]);
  }

  const merged = [...parentMessages];
  const orderedSessionIds: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (sessionId: string) => {
    if (visited.has(sessionId)) return;
    if (visiting.has(sessionId)) return;
    visiting.add(sessionId);
    const parentId = sessions.find((candidate) => candidate.id === sessionId)?.parentID;
    if (parentId && recoveredBySession.has(parentId)) visit(parentId);
    visiting.delete(sessionId);
    visited.add(sessionId);
    orderedSessionIds.push(sessionId);
  };
  for (const sessionId of recoveredBySession.keys()) visit(sessionId);

  for (const sessionId of orderedSessionIds) {
    const entries = recoveredBySession.get(sessionId);
    if (!entries) continue;
    const insertionIndex = getNewSessionMessageInsertionIndex(merged, sessionId, sessions);
    merged.splice(insertionIndex, 0, ...entries);
  }
  return merged;
}

function getNewSessionMessageInsertionIndex(
  current: MessageEntry[],
  sessionId: string,
  sessions: Session[]
) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.parentID) return current.length;

  let anchorIndex = current.findIndex((entry) => entry.info.id === session.parentID);
  if (anchorIndex < 0) {
    anchorIndex = current.findIndex((entry) =>
      entry.parts.some(
        (part) =>
          part.type === 'tool' && resolveTaskSessionId(part, current, sessions) === sessionId
      )
    );
  }
  if (anchorIndex < 0) return current.length;

  const parentSessionId = current[anchorIndex]!.info.sessionID;
  const nextParentIndex = current.findIndex(
    (entry, index) => index > anchorIndex && entry.info.sessionID === parentSessionId
  );
  return nextParentIndex < 0 ? current.length : nextParentIndex;
}

function setSessionMessagesIncremental(
  sessionId: string,
  messages: MessageEntry[],
  options?: { preserveExtraParts?: boolean },
  behavior?: { preserveSessionStreaming?: boolean; authoritativeSessionSnapshot?: boolean }
) {
  flushPendingStreamingDeltasFor(appStore.defaultAppState);
  const current = appStore.state.messages;
  const streamingPartId = appStore.state.streamingPartId;
  const streamingText = appStore.state.streamingText;
  const streamingBelongsToSession =
    !!streamingPartId &&
    current.some(
      (entry) =>
        entry.info.sessionID === sessionId &&
        entry.parts.some((part) => part.id === streamingPartId)
    );
  const preserveStreamingState =
    !!streamingPartId &&
    current.some(
      (entry) =>
        (entry.info.sessionID !== sessionId ||
          (behavior?.preserveSessionStreaming &&
            (!behavior.authoritativeSessionSnapshot || options?.preserveExtraParts))) &&
        entry.parts.some((part) => part.id === streamingPartId)
    );
  batch(() => {
    if (streamingBelongsToSession && !preserveStreamingState && !options?.preserveExtraParts) {
      appStore.setState('streamingPartId', null);
      appStore.setState('streamingText', '');
    }
    sessionStore.setMessagesIncremental(
      mergeSessionMessages(current, sessionId, messages),
      options
    );
    setCachedSessionMessages(
      sessionId,
      appStore.state.messages.filter((entry) => entry.info.sessionID === sessionId)
    );
    if (
      preserveStreamingState &&
      appStore.state.messages.some((entry) =>
        entry.parts.some((part) => part.id === streamingPartId)
      )
    ) {
      appStore.setState('streamingPartId', streamingPartId);
      appStore.setState('streamingText', streamingText);
    }
  });
}

async function fetchSessionMessages(
  sessionId: string,
  options?: { isCurrent?: () => boolean }
): Promise<MessageEntry[]> {
  const requestRevision = getSessionMessageWindowRevision(sessionId);
  const requestMutationRevision = getSessionMessageSnapshotMutationRevision(sessionId);
  const incoming = await client.session.messages(sessionId, {
    limit: MESSAGE_HISTORY_WINDOW,
    directory: getSessionDirectory(sessionId),
  });
  const activeMessages = appStore.state.messages.filter(
    (entry) => entry.info.sessionID === sessionId
  );
  const current = activeMessages.length > 0 ? activeMessages : getCachedSessionMessages(sessionId);
  if (
    options?.isCurrent?.() === false ||
    getSessionMessageWindowRevision(sessionId) !== requestRevision ||
    getSessionMessageSnapshotMutationRevision(sessionId) !== requestMutationRevision
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
        directory: getSessionDirectory(sessionId),
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
    .catch((err) => {
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
    isCurrent,
  }).catch((err) => {
    if (isNotFoundError(err)) return [];
    throw err;
  });
  const [session, messages] = await Promise.all([
    client.session.get(sessionId, { directory: getSessionDirectory(sessionId) }),
    messagesPromise,
  ]);
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

export function resetWorkspaceDerivedState(options?: { preserveWorkspaceCatalog?: boolean }) {
  const preserveWorkspaceCatalog = options?.preserveWorkspaceCatalog === true;
  const queuedTreeSessionIds = new Set(
    appStore.state.queuedMessages.flatMap((message) => {
      const rootId = getSessionTreeRootId(message.sessionId) || message.sessionId;
      return [rootId, message.sessionId, ...getSessionTreeIds(rootId)];
    })
  );
  const queuedWorkingStatuses = Object.fromEntries(
    Object.entries(appStore.state.sessionStatus).filter(
      ([sessionId, status]) =>
        queuedTreeSessionIds.has(sessionId) && (status?.type === 'busy' || status?.type === 'retry')
    )
  );
  batch(() => {
    sessionStore.setActiveSessionId(null);
    sessionStore.persistActiveSessionId(null);
    sessionStore.clearMessages();
    if (!preserveWorkspaceCatalog) {
      appStore.setState('sessions', []);
      appStore.setState('sessionsLoadError', null);
      appStore.setState('sessionsHasMore', false);
      appStore.setState('recycleBinEntries', []);
      appStore.setState('recycleBinLoadError', null);
      appStore.setState('sessionStatus', reconcile(queuedWorkingStatuses));
      appStore.setState('failedSessionIds', []);
      appStore.setState('failedSessionUpdatedAt', {});
      appStore.setState('sessionMessageCounts', reconcile({}));
      appStore.setState('sessionUsageLimits', reconcile({}));
    }
    appStore.setState('sessionsLoadingMore', false);
    appStore.setState('sessionsPaginationError', null);
    appStore.setState('messagesLoading', false);
    appStore.setState('permissions', []);
    appStore.setState('questions', []);
    appStore.setState('compactingSessionIds', []);
    appStore.setState('queuedMessageDispatchingId', null);
    setQueuedMessageEdit(null);
    appStore.setState('interruptedSessionIds', []);

    // Keep the toolbar presentation stable while the new catalogs load. Sending
    // remains blocked by workspaceCatalogReloadPending until they are authoritative.
    appStore.setState('providersLoaded', false);
    appStore.setState('workspaceCatalogReloadPending', true);
    appStore.setState('agentsLoaded', false);
    appStore.setState('commandsLoaded', false);
    appStore.setState('commands', []);
    appStore.setState('lspStatus', []);
    appStore.setState('sessionAutoPermissionCounts', reconcile({}));
    appStore.setState('sessionAutoPermissionActivity', reconcile({}));
    appStore.setState('autoPermissionCountsSince', Date.now());
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
    composerStore.resetPastedImageIndex();
    uiStore.stopLoading();
    uiStore.setError(null);
    uiStore.setShowModelPicker(false);
    uiStore.setShowModels(false);
  });

  appStore.defaultAppState.sessionTreeIndex.invalidate();
  appStore.defaultAppState.setSessionUsageLimitVersion((version) => version + 1);
  resetSessionStatusSnapshotTracking();
  resetMessageEditState();
  resetToolCallExpansionState();
  resetMessageWindowState();
}

export function createOpenCodeRuntime(): OpenCodeRuntime {
  const initialWebviewState = readInitialWebviewState();
  const initialPermissionAutomation = initialWebviewState.permissionAutomation;
  let permissionAutomationOwner =
    initialPermissionAutomation?.owner === true && initialPermissionAutomation.lease !== undefined;
  let permissionAutomationLease = initialPermissionAutomation?.lease;
  let initialized = false;
  let initializationAttemptGeneration = 0;
  let activeInitializationAttempt: number | null = null;
  let eventHandlerCleanups: Array<() => void> = [];
  let currentWorkspacePath = initialWebviewState.editorContext?.workspacePath;
  let workspaceGeneration = 0;
  let connectionGeneration = 0;
  let sessionSelectionGeneration = 0;
  let sessionActivationGeneration = 0;
  let sessionActivationController: AbortController | null = null;
  let sessionActivationDirectory: string | null = null;
  let initialRouteConsumed = false;
  let restoredPermissionsClassified = false;
  const permissionDecisionReferencesByTree = new Map<string, AutoApproveJudgeReference[]>();
  const permissionJudgeAttempts = new Map<string, PermissionJudgeAttempt>();
  const permissionSessionSyncs = new Map<string, Promise<void>>();
  const hiddenRestoredPermissions = new Map<
    string,
    { permission: Permission; workspacePath: string | null }
  >();
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
    loadSessionTodos: (sessionId) =>
      client.session.todos(sessionId, { directory: getSessionDirectory(sessionId) }),
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
    publishSessionModel,
  });

  const { applySessions, clearDeletedSessionState, hideDeletedSessionTree, upsertSession } =
    sessionLifecycleOperations;

  async function deleteSessionImmediately(id: string, options?: { directory?: string }) {
    await client.varro.session.deleteImmediately(id, {
      directory: options?.directory ?? getSessionDirectory(id),
    });
    hideDeletedSessionTree(id);
    clearQueuedMessagesForSession(id);
    clearSessionMessageWindowState(id);
  }
  const sessionTitleFallbackAttempts = new Map<string, number>();
  const sessionTitleFallbacks = new Map<string, Promise<void>>();
  const deferredMessageRemovals = new DeferredMessageRemovals();

  function deferMessageRemovals(sessionId: string, messageIds: string[]) {
    return deferredMessageRemovals.defer(sessionId, messageIds);
  }

  function isMessageRemovalDeferred(sessionId: string, messageId: string) {
    return deferredMessageRemovals.isDeferred(sessionId, messageId);
  }

  function repairSessionTitle(sessionId: string): Promise<void> {
    const inFlight = sessionTitleFallbacks.get(sessionId);
    if (inFlight) return inFlight;
    const existing = appStore.state.sessions.find((session) => session.id === sessionId);
    if (existing && !isPlaceholderSessionTitle(existing.title)) return Promise.resolve();
    const attempts = sessionTitleFallbackAttempts.get(sessionId) ?? 0;
    if (attempts >= 2) return Promise.resolve();
    sessionTitleFallbackAttempts.set(sessionId, attempts + 1);

    const fallback = (async () => {
      const renamed = await client.varro.session.renameIfUntitled(sessionId, {
        directory: getSessionDirectory(sessionId),
      });
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
        respondAutomaticPermission: (sessionId, permissionId, response, options) =>
          sessionApprovalOperations.respondPermission(sessionId, permissionId, response, {
            ...options,
            automatic: true,
          }),
        judgePermission: judgeAndRespondPermission,
        permissionReplied: markPermissionJudgeResponded,
        permissionVisible: (permissionId) => {
          postMessage({ type: 'permission/reveal', payload: { permissionId } });
        },
        isPermissionSessionKnown,
        syncPermissionSession: ensurePermissionSessionKnown,
      },
      syncPendingPermissions,
      reconcileServerState,
      invalidateMessageSync: messageSyncGenerations.invalidate,
      isMessageRemovalDeferred,
      abortRemoteSession: (sessionId: string) =>
        client.session.abort(sessionId, { directory: getSessionDirectory(sessionId) }),
      continueInterruptedSession,
      logError,
      isPermissionAutomationOwner: () => permissionAutomationOwner,
    });

    eventHandlerCleanups = sessionEventHandlerOperations.registerSessionEventHandlers();
  }

  function useOpenCode() {
    hideAutomaticallyHandledRestoredPermissions();

    onMount(() => {
      applyTheme(uiStore.theme());
      const webviewContext = readWebviewInstanceContext();
      if (webviewContext?.surface === 'editor') {
        writeStored(STORAGE_KEYS.editorViewId, webviewContext.viewId);
      }

      const mountBridgeOperations = createMountBridgeOperations({
        ensureConnectionInitialized,
        reloadSessionCatalog: reloadSessions,
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
        openSession: (sessionId, directory) => {
          uiStore.setShowSessionPicker(false);
          void selectSession(sessionId, { directory });
        },
        abortSession: () => {
          void abortSession().catch(() => {});
        },
        refreshMcps: () => {
          void loadMcps();
        },
        refreshLsps: () => {
          void loadLsps();
        },
        refreshProviders: () => {
          void refreshRoutingState();
        },
        revalidateProviderAuth: sessionSendOperations.revalidateProviderAuth,
        applyTheme,
        setPermissionAutomation: (owner, lease) => {
          const nextOwner = owner && lease !== undefined;
          const becameOwner = nextOwner && !permissionAutomationOwner;
          permissionAutomationOwner = nextOwner;
          permissionAutomationLease = lease;
          if (owner) hideAutomaticallyHandledRestoredPermissions();
          if (becameOwner) {
            void syncPendingPermissions().catch((err) => logError('permission.ownership', err));
          }
        },
        permissionModesSynced: () => {
          if (!permissionAutomationOwner) return;
          void syncPendingPermissions().catch((err) => logError('permission.mode-sync', err));
        },
        revealPermission: (permissionId) => {
          if (!permissionAutomationOwner) return;
          if (appStore.state.permissions.some((permission) => permission.id === permissionId))
            return;
          void syncPendingPermissions().catch((err) => logError('permission.actionable', err));
        },
        queueInterruptedSessionRecovery: (claimId, sessionIds) =>
          connectionBootstrapOperations.queueInterruptedSessionRecovery(claimId, sessionIds),
      });

      ensureSessionEventHandlersRegistered();

      const disposeBridge = onMessage((msg: ExtensionMessage) => {
        mountBridgeOperations.handleExtensionMessage(msg);
      });

      postMessage({ type: 'ready' });
      if (
        webviewContext?.surface !== 'editor' &&
        initialWebviewState.sessionModelMigrationPending
      ) {
        postMessage({
          type: 'session-models/migrate',
          payload: {
            models: Object.fromEntries(
              Object.entries(appStore.state.sessionSelectedModels).map(([sessionId, model]) => [
                sessionId,
                {
                  providerID: model.providerID,
                  modelID: model.modelID,
                  variant: model.variant,
                },
              ])
            ),
          },
        });
      }
      if (
        webviewContext?.surface !== 'editor' &&
        initialWebviewState.modelPreferencesMigrationPending
      ) {
        postMessage({
          type: 'model-preferences/migrate',
          payload: getModelPreferencesSnapshot(),
        });
      }
      if (
        webviewContext?.surface !== 'editor' &&
        initialWebviewState.queuedMessages === undefined
      ) {
        syncQueuedMessages();
      }
      permissionsStore.syncSessionPermissionModesToHost();

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
          void refreshRoutingState();
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
    const workspacePath = normalizeProjectPath(
      currentWorkspacePath === undefined
        ? initialWebviewState.editorContext?.workspacePath
        : currentWorkspacePath
    );
    const restoredPermissions = [...hiddenRestoredPermissions.values()]
      .filter((entry) => entry.workspacePath === workspacePath)
      .map((entry) => entry.permission);
    try {
      const pendingPermissions = await client.permission.list();
      if (syncGeneration < latestPermissionSyncGeneration) return;
      latestPermissionSyncGeneration = syncGeneration;
      const normalizedPendingPermissions = pendingPermissions
        .map((item) => normalizePermissionEvent(item))
        .filter((permission): permission is Permission => permission !== null);
      await Promise.all(
        normalizedPendingPermissions.map((permission) =>
          ensurePermissionSessionKnown(permission.sessionID).catch((err) =>
            logError('permission.session', err)
          )
        )
      );
      if (syncGeneration !== permissionSyncGeneration) return;
      const pendingPermissionIds = new Set(
        normalizedPendingPermissions.map((permission) => permission.id)
      );
      for (const [permissionId] of permissionJudgeAttempts) {
        if (
          !pendingPermissionIds.has(permissionId) &&
          !reconciliation.changedPermissionIds.has(permissionId)
        ) {
          const attempt = permissionJudgeAttempts.get(permissionId);
          if (attempt) {
            finishPermissionJudgeAttempt(attempt);
            clearReviewingAutoApproveActivity(attempt.permission);
          }
          permissionJudgeAttempts.delete(permissionId);
        }
      }
      const snapshotGeneration = ++permissionSnapshotGeneration;
      const isCurrent = () => snapshotGeneration === permissionSnapshotGeneration;
      const visiblePermissions: Permission[] = [];
      const pendingPermissionHandlers: Promise<void>[] = [];

      for (const permission of normalizedPendingPermissions) {
        if (!isCurrent()) return;
        const mode = permissionsStore.getPermissionModeForSession(permission.sessionID);
        const modePending = permissionsStore.isSessionPermissionModePending(permission.sessionID);
        const modeRecovering = permissionsStore.isPermissionModeRecoveryPending(
          permission.sessionID
        );
        if (permissionAutomationOwner && !modePending && !modeRecovering && mode === 'full') {
          pendingPermissionHandlers.push(
            sessionApprovalOperations
              .respondPermission(permission.sessionID, permission.id, 'always', {
                rethrow: true,
                automatic: true,
                permissionAutomationLease,
              })
              .catch(() => {
                if (
                  isCurrent() &&
                  permissionsStore.getPermissionModeForSession(permission.sessionID) !== 'full'
                ) {
                  permissionsStore.addPermission(permission);
                  postMessage({
                    type: 'permission/reveal',
                    payload: { permissionId: permission.id },
                  });
                }
              })
          );
          continue;
        }
        if (permissionAutomationOwner && !modePending && !modeRecovering && mode === 'auto') {
          const attempt = permissionJudgeAttempts.get(permission.id);
          if (attempt?.status === 'visible') visiblePermissions.push(attempt.permission);
          else pendingPermissionHandlers.push(judgeAndRespondPermission(permission));
          continue;
        }
        if (
          permissionAutomationOwner &&
          !modePending &&
          !modeRecovering &&
          mode === 'edits' &&
          isEditPermission(permission.type)
        ) {
          pendingPermissionHandlers.push(
            sessionApprovalOperations
              .respondPermission(permission.sessionID, permission.id, 'once', {
                rethrow: true,
                automatic: true,
                permissionAutomationLease,
              })
              .catch(() => {
                if (isCurrent()) {
                  permissionsStore.addPermission(permission);
                  postMessage({
                    type: 'permission/reveal',
                    payload: { permissionId: permission.id },
                  });
                }
              })
          );
          continue;
        }
        visiblePermissions.push(permission);
        postMessage({ type: 'permission/reveal', payload: { permissionId: permission.id } });
      }

      await Promise.all(pendingPermissionHandlers);

      if (isCurrent()) {
        permissionsStore.reconcilePermissions(visiblePermissions, reconciliation);
        for (const permission of restoredPermissions) {
          hiddenRestoredPermissions.delete(permission.id);
        }
      }
    } catch (err) {
      if (syncGeneration === permissionSyncGeneration) {
        for (const permission of restoredPermissions) {
          const mode = permissionsStore.getPermissionModeForSession(permission.sessionID);
          const modePending = permissionsStore.isSessionPermissionModePending(permission.sessionID);
          const hasJudgeAttempt = permissionsStore
            .getPermissionGroupMembers(permission)
            .some((member) => permissionJudgeAttempts.has(member.id));
          if ((modePending || mode !== 'full') && !hasJudgeAttempt) {
            permissionsStore.addPermission(permission);
            postMessage({ type: 'permission/reveal', payload: { permissionId: permission.id } });
          }
        }
      }
      throw err;
    } finally {
      permissionsStore.finishPermissionReconciliation(reconciliation);
    }
  }

  function hideAutomaticallyHandledRestoredPermissions() {
    if (restoredPermissionsClassified || !permissionAutomationOwner) return;
    restoredPermissionsClassified = true;

    const hasStoredAutomaticMode = Object.values(appStore.state.sessionPermissionModes).some(
      (mode) => mode !== 'default'
    );
    const restoredPermissions = appStore.state.permissions.filter(
      (permission) =>
        (!isPermissionSessionKnown(permission.sessionID) && hasStoredAutomaticMode) ||
        permissionsStore.getPermissionModeForSession(permission.sessionID) !== 'default'
    );
    const workspacePath = normalizeProjectPath(initialWebviewState.editorContext?.workspacePath);
    for (const permission of restoredPermissions) {
      hiddenRestoredPermissions.set(permission.id, { permission, workspacePath });
      permissionsStore.removePermission(permission.id, { removeGroup: true });
    }
  }

  function syncPermissionSession(sessionId: string): Promise<void> {
    const existing = permissionSessionSyncs.get(sessionId);
    if (existing) return existing;

    const generation = workspaceGeneration;
    const sessionSync = sessionSyncOperations.syncSession(sessionId, {
      shouldApply: () => generation === workspaceGeneration,
    });
    permissionSessionSyncs.set(sessionId, sessionSync);
    void sessionSync.then(
      () => {
        if (permissionSessionSyncs.get(sessionId) === sessionSync) {
          permissionSessionSyncs.delete(sessionId);
        }
      },
      () => {
        if (permissionSessionSyncs.get(sessionId) === sessionSync) {
          permissionSessionSyncs.delete(sessionId);
        }
      }
    );
    return sessionSync;
  }

  async function ensurePermissionSessionKnown(sessionId: string): Promise<void> {
    const ancestryResolution = (async () => {
      const visited = new Set<string>();
      let currentSessionId: string | undefined = sessionId;

      while (currentSessionId && !visited.has(currentSessionId)) {
        if (Object.hasOwn(appStore.state.sessionPermissionModes, currentSessionId)) return;
        visited.add(currentSessionId);

        let session = appStore.state.sessions.find((item) => item.id === currentSessionId);
        if (!session) {
          await syncPermissionSession(currentSessionId);
          session = appStore.state.sessions.find((item) => item.id === currentSessionId);
        }
        currentSessionId = session?.parentID;
      }
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        ancestryResolution,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`Timed out resolving permission session ancestry for ${sessionId}`));
          }, AUTO_APPROVE_JUDGE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function applyPermissionJudgeOutcome(
    attempt: PermissionJudgeAttempt,
    outcome: PermissionJudgeOutcome,
    acceptVisible: boolean
  ): Promise<void> {
    const { permission } = attempt;
    if (permissionJudgeAttempts.get(permission.id) !== attempt) return;
    const wasVisible = attempt.status === 'visible';
    if (attempt.status !== 'judging' && !(acceptVisible && wasVisible)) return;

    const mode = permissionsStore.getPermissionModeForSession(permission.sessionID);
    const modePending = permissionsStore.isSessionPermissionModePending(permission.sessionID);
    if (modePending || mode !== 'auto') {
      if (!wasVisible) {
        const shouldShow =
          modePending ||
          mode === 'default' ||
          (mode === 'edits' && !isEditPermission(permission.type));
        attempt.status = shouldShow ? 'visible' : 'responded';
        if (shouldShow) showPermissionAfterJudge(attempt);
      }
      finishPermissionJudgeAttempt(attempt);
      finishAutoApproveActivity(permission, 'auto-review-failed', 'Automatic review was stopped.');
      return;
    }
    if (outcome.type === 'timeout') {
      if (!wasVisible) showPermissionAfterJudge(attempt, 'Timed out before making a decision.');
      return;
    }
    if (outcome.type === 'error') {
      logError('autoApproveJudge', outcome.error);
      showPermissionAfterJudge(
        attempt,
        `Failed to evaluate this request: ${getPermissionJudgeErrorMessage(outcome.error)}`
      );
      finishPermissionJudgeAttempt(attempt);
      finishAutoApproveActivity(
        permission,
        'auto-review-failed',
        `Review failed: ${getPermissionJudgeErrorMessage(outcome.error)}`
      );
      return;
    }
    if (outcome.response.decision === 'ask') {
      showPermissionAfterJudge(attempt, outcome.response.reason, outcome.response.actionSummary);
      finishPermissionJudgeAttempt(attempt);
      finishAutoApproveActivity(
        permission,
        'approval-required',
        outcome.response.reason || 'Automatic review requested manual approval.'
      );
      return;
    }

    attempt.status = 'responded';
    try {
      await sessionApprovalOperations.respondPermission(
        permission.sessionID,
        permission.id,
        outcome.response.decision === 'allow' ? 'once' : 'reject',
        {
          rethrow: true,
          automatic: true,
          permissionAutomationLease: attempt.automationLease,
        }
      );
      const counts = appStore.state.sessionAutoPermissionCounts[permission.sessionID];
      const key = outcome.response.decision === 'allow' ? 'approved' : 'rejected';
      updateSessionAutoPermissionCounts(permission.sessionID, {
        [key]: (counts?.[key] ?? 0) + 1,
      });
      finishAutoApproveActivity(
        permission,
        outcome.response.decision === 'allow' ? 'auto-approved' : 'auto-review-failed',
        outcome.response.reason ||
          (outcome.response.decision === 'allow'
            ? 'Approved by automatic review.'
            : 'Rejected by automatic review.')
      );
    } catch (err) {
      logError('autoApproveJudge', err);
      if (permissionJudgeAttempts.get(permission.id) === attempt) {
        showPermissionAfterJudge(
          attempt,
          `Failed to apply the automatic decision: ${getPermissionJudgeErrorMessage(err)}`,
          outcome.response.actionSummary
        );
        finishAutoApproveActivity(
          permission,
          'auto-review-failed',
          `Could not apply the automatic decision: ${getPermissionJudgeErrorMessage(err)}`
        );
      }
    } finally {
      finishPermissionJudgeAttempt(attempt);
    }
  }

  function judgeAndRespondPermission(
    permission: Permission,
    preserveVisible = false
  ): Promise<void> {
    if (!permissionAutomationOwner || permissionAutomationLease === undefined) {
      permissionsStore.addPermission(permission);
      postMessage({ type: 'permission/reveal', payload: { permissionId: permission.id } });
      return Promise.resolve();
    }
    const existingAttempt = permissionJudgeAttempts.get(permission.id);
    if (existingAttempt) return existingAttempt.promise;

    if (!preserveVisible) permissionsStore.removePermission(permission.id, { removeGroup: true });
    const attempt: PermissionJudgeAttempt = {
      permission,
      automationLease: permissionAutomationLease,
      status: preserveVisible ? 'visible' : 'judging',
      countedInFlight: true,
      promise: Promise.resolve(),
    };
    permissionJudgeAttempts.set(permission.id, attempt);
    startAutoApproveActivity(permission);
    const counts = appStore.state.sessionAutoPermissionCounts[permission.sessionID];
    updateSessionAutoPermissionCounts(permission.sessionID, {
      inFlight: (counts?.inFlight ?? 0) + 1,
    });

    const judgeRequest = Promise.resolve()
      .then(async (): Promise<PermissionJudgeOutcome> => {
        const model = resolvePermissionJudgeModel(permission.sessionID);
        const request = {
          permission,
          approvedReferences:
            permissionDecisionReferencesByTree.get(
              getPermissionDecisionScopeId(permission.sessionID)
            ) || [],
          model: model || undefined,
        };
        if (attempt.automationLease === undefined) {
          throw new Error('Permission automation lease is unavailable');
        }
        const response = await client.varro.judgePermission(request, {
          permissionAutomationLease: attempt.automationLease,
        });
        return { type: 'decision', response };
      })
      .catch((error): PermissionJudgeOutcome => ({ type: 'error', error }));
    let timedOut = false;
    let judgeTimeout: ReturnType<typeof setTimeout>;
    const judge = Promise.race([
      judgeRequest,
      new Promise<PermissionJudgeOutcome>((resolve) => {
        judgeTimeout = setTimeout(() => {
          timedOut = true;
          resolve({ type: 'timeout' });
        }, AUTO_APPROVE_JUDGE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(judgeTimeout));

    attempt.promise = judge.then((outcome) =>
      applyPermissionJudgeOutcome(attempt, outcome, preserveVisible)
    );
    void judgeRequest.then(async (outcome) => {
      if (timedOut) await applyPermissionJudgeOutcome(attempt, outcome, true);
    });
    return attempt.promise;
  }

  function recheckVisiblePermissionsAfterAlways(permission: Permission) {
    const scopeId = getPermissionDecisionScopeId(permission.sessionID);
    const visibleAttempts = [...permissionJudgeAttempts.values()].filter(
      (attempt) =>
        attempt.status === 'visible' &&
        getPermissionDecisionScopeId(attempt.permission.sessionID) === scopeId &&
        !permissionsStore.isSessionPermissionModePending(attempt.permission.sessionID) &&
        permissionsStore.getPermissionModeForSession(attempt.permission.sessionID) === 'auto'
    );

    for (const attempt of visibleAttempts) {
      finishPermissionJudgeAttempt(attempt);
      permissionJudgeAttempts.delete(attempt.permission.id);
      void judgeAndRespondPermission(attempt.permission, true);
    }
  }

  function markPermissionJudgeResponded(permissionId: string) {
    const attempt = permissionJudgeAttempts.get(permissionId);
    if (!attempt) return;
    attempt.status = 'responded';
    finishPermissionJudgeAttempt(attempt);
    clearReviewingAutoApproveActivity(attempt.permission);
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
    reloadWorkspaceCatalogs,
    loadCompatibilityState,
    refreshProviderLimit,
    loadSessions,
    loadMoreSessions,
    loadRecycleBin,
    invalidateWorkspace,
  } = dataLoaders;
  const hydrateSessionStatuses = hydratePolledSessionStatuses;

  async function loadLsps() {
    const generation = workspaceGeneration;
    try {
      const status = await client.lsp.status();
      if (generation === workspaceGeneration) appStore.setState('lspStatus', status);
    } catch (err) {
      if (generation === workspaceGeneration) logError('loadLsps', err);
    }
  }

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
      loadLsps(),
      reloadWorkspaceCatalogs(),
      loadCompatibilityState(),
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

  function invalidateWorkspaceAsyncWork(
    preserveWorkspaceCatalog = false,
    preserveSessionActivation = false
  ) {
    workspaceGeneration += 1;
    sessionSelectionGeneration += 1;
    permissionSyncGeneration += 1;
    latestPermissionSyncGeneration = permissionSyncGeneration;
    permissionSnapshotGeneration += 1;
    if (!preserveSessionActivation) {
      sessionActivationGeneration += 1;
      sessionActivationController?.abort();
      sessionActivationController = null;
      sessionActivationDirectory = null;
    }
    invalidateWorkspace({ preserveSessionCatalog: preserveWorkspaceCatalog });
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
    permissionDecisionReferencesByTree.clear();
    for (const attempt of permissionJudgeAttempts.values()) {
      finishPermissionJudgeAttempt(attempt);
      clearReviewingAutoApproveActivity(attempt.permission);
    }
    permissionJudgeAttempts.clear();
    permissionSessionSyncs.clear();
  }

  function invalidateConnection() {
    invalidateClientWorkspaceState();
    connectionGeneration += 1;
    invalidateInitializationAttempt();
    invalidateWorkspaceAsyncWork();
    initialized = false;
    uiStore.setConnectionInitialized(false);
  }

  function resetWorkspaceForChange(options?: {
    workspaceMembershipChanged?: boolean;
    nextWorkspacePath?: string | null;
    executionDirectoryChanged?: boolean;
  }) {
    if (options?.workspaceMembershipChanged && !options.executionDirectoryChanged) {
      sessionActivationGeneration += 1;
      sessionActivationController?.abort();
      sessionActivationController = null;
      sessionActivationDirectory = null;
      invalidateClientWorkspaceState();
      workspaceGeneration += 1;
      appStore.setState('workspaceCatalogReloadPending', true);
      return;
    }
    const preserveSessionActivation = Boolean(
      sessionActivationController &&
      sessionActivationDirectory &&
      isSameWorkspacePath(sessionActivationDirectory, options?.nextWorkspacePath)
    );
    invalidateClientWorkspaceState();
    connectionGeneration += 1;
    invalidateInitializationAttempt();
    invalidateWorkspaceAsyncWork(true, preserveSessionActivation);
    resetWorkspaceDerivedState({ preserveWorkspaceCatalog: true });
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
        reloadWorkspaceCatalogs(),
        loadCompatibilityState(),
        loadMcps(),
        loadLsps(),
        loadQuestions(),
        loadRecycleBin(),
        syncPendingPermissions().catch((err) => logError('permission.list', err)),
      ]);
    },
    hydrateSessionStatuses,
    getActiveSessionId: () => appStore.state.activeSessionId,
    getPersistedActiveSessionId: sessionStore.getPersistedActiveSessionId,
    getPersistedLastOpenedView: sessionStore.getPersistedLastOpenedView,
    getInitialRoute: () => {
      if (initialRouteConsumed) return null;
      const context = readWebviewInstanceContext();
      return context?.surface === 'editor' ? context.initialRoute : null;
    },
    markInitialRouteConsumed: () => {
      initialRouteConsumed = true;
    },
    getSessionCount: () => appStore.state.sessions.length,
    getOnlyPrimarySessionId: () => {
      const primarySessions = appStore.state.sessions.filter((session) => !session.parentID);
      return primarySessions.length === 1 ? primarySessions[0]?.id || null : null;
    },
    hasSession: (sessionId) => appStore.state.sessions.some((session) => session.id === sessionId),
    getSessionDirectory: (sessionId) =>
      appStore.state.sessions.find((session) => session.id === sessionId)?.directory,
    selectSession: (sessionId, directory) =>
      selectSession(sessionId, { directory, reportActivationError: false }),
    startNewSession: startNewChatDraft,
    setShowSessionPicker: uiStore.setShowSessionPicker,
    setInitialized: (value) => {
      initialized = value;
      uiStore.setConnectionInitialized(value);
      if (value) appStore.setState('serverReconnecting', false);
    },
    setError: uiStore.setError,
    nextConnectionGeneration: () => ++connectionGeneration,
    isCurrentConnectionGeneration: (generation) =>
      isCurrentGeneration(generation, connectionGeneration),
    getCurrentConnectionGeneration: () => connectionGeneration,
    isInitialized: () => initialized,
    consumeInterruptedSessionIds: appStore.consumeInterruptedSessionIds,
    acknowledgeInterruptedSessionRecovery: (claimId, consumedSessionIds) =>
      postMessage({
        type: 'recovery/interrupted-sessions-ack',
        payload: { claimId, consumedSessionIds },
      }),
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
    sendAsync: (id, body) => {
      const directory = getSessionDirectory(id);
      return directory
        ? client.session.sendAsync(id, body, { directory })
        : client.session.sendAsync(id, body);
    },
    syncSession,
    recheckSessionStatus,
  });

  async function continueInterruptedSession(sessionId: string) {
    await connectionBootstrapOperations.continueInterruptedSession(sessionId);
  }

  const sessionSendOperations = new SessionSendOperations({
    getWorkspaceGeneration: () => workspaceGeneration,
    createSession: (initialPermissionMode, workspaceTarget) =>
      createSession(undefined, initialPermissionMode, workspaceTarget),
    ensureSessionPermission: (sessionId, options) =>
      ensureSessionPermissionWithDependencies(
        {
          getSession: (id) => appStore.state.sessions.find((session) => session.id === id),
          buildPermissionRules: (mode) => getSessionPermissionRulesForMode(mode, 'update'),
          getPermissionMode: permissionsStore.getPermissionModeForSession,
          updateSessionPermission: (id, input) => client.session.update(id, input, options),
          upsertSession,
          setError: uiStore.setError,
        },
        sessionId
      ),
    clearPendingAbort,
    resetTodoSync,
    syncSessionMcps,
    sendAsync: async (sessionId, body, options) => {
      const directory = options?.directory ?? getSessionDirectory(sessionId);
      const response = directory
        ? await client.session.sendAsync(sessionId, body, { ...options, directory })
        : await client.session.sendAsync(sessionId, body);
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
      syncSessionMcps: async (sessionId) => {
        await syncSessionMcps(sessionId);
      },
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
      isSessionInActiveTree: (sessionId) => {
        const activeSessionId = appStore.state.activeSessionId;
        if (!activeSessionId) return false;
        return (
          (getSessionTreeRootId(sessionId) || sessionId) ===
          (getSessionTreeRootId(activeSessionId) || activeSessionId)
        );
      },
      loadingStartedAt: uiStore.loadingStartedAt,
      loadSessionMessages: (sessionId, isCurrentSync = () => true) => {
        const generation = workspaceGeneration;
        return loadSessionMessagesAllowingEmpty(
          sessionId,
          () => generation === workspaceGeneration && isCurrentSync()
        );
      },
      setSessionMessagesIncremental: (sessionId, messages, options) =>
        setSessionMessagesIncremental(sessionId, messages, options, {
          preserveSessionStreaming: sessionId !== appStore.state.activeSessionId,
          authoritativeSessionSnapshot: true,
        }),
      handoffTodosToMessages,
      loadSessionMetadata: (id) => client.session.get(id, { directory: getSessionDirectory(id) }),
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
    abortRemoteSession: (sessionId) =>
      client.session.abort(sessionId, { directory: getSessionDirectory(sessionId) }),
    clearPendingAbortTree,
    setSessionUsageLimit: sessionStore.setSessionUsageLimit,
    logError,
    getMessages: () => appStore.state.messages,
    startLoading: uiStore.startLoading,
    invalidateMessageSync: (sessionId) => messageSyncGenerations.invalidate(sessionId),
    deferMessageRemovals,
    pruneMessagesFrom: sessionStore.pruneMessagesFrom,
    getSessions: () => appStore.state.sessions,
    moveSessionTreeToRecycleBin: async (sessionId) => {
      const sessionIds = getSessionTreeIds(sessionId);
      await client.session.delete(sessionId, { directory: getSessionDirectory(sessionId) });
      hideDeletedSessionTree(sessionId);
      sessionStore.removeMessagesForSessions(sessionIds);
      await loadRecycleBin();
    },
    restoreSessionTreeFromRecycleBin: async (sessionId) => {
      const restored = await client.varro.recycleBin.restore(sessionId);
      if (restored) {
        await Promise.all([loadSessions(), loadRecycleBin(), hydrateSessionStatuses()]);
      }
      return restored;
    },
    deleteMessage: (sessionId, messageId) =>
      client.session.deleteMessage(sessionId, messageId, {
        directory: getSessionDirectory(sessionId),
      }),
    revertSession: (sessionId, messageId) =>
      client.session.revert(sessionId, messageId, {
        directory: getSessionDirectory(sessionId),
      }),
    syncSession,
    syncSessionMessages,
    setError: uiStore.setError,
    isSessionWorking: (sessionId) => isSessionTreeStatusWorking(sessionId),
    sendEditedMessage: (text, sessionId, queuedAttachments) =>
      sessionSendOperations.sendMessage(text, { targetSessionId: sessionId, queuedAttachments }),
    prepareEditedMessageSend: (text, sessionId, queuedAttachments, selectedModel) =>
      sessionSendOperations.prepareSendMessage(text, {
        targetSessionId: sessionId,
        queuedAttachments,
        selectedModel,
        optimisticModel: selectedModel,
        preserveModelSelection: true,
        preserveScrollPosition: true,
      }),
    unrevertSession: (sessionId) =>
      client.session.unrevert(sessionId, { directory: getSessionDirectory(sessionId) }),
    upsertSession,
    clearPendingAbort,
    resolveSelectedModel: () =>
      routingStore.resolveSelectedModel(
        appStore.state.selectedModel,
        appStore.state.providers,
        appStore.state.providerDefaults
      ),
    setSessionCompacting: sessionStore.setSessionCompacting,
    compactRemoteSession: (sessionId, input) =>
      client.session.compact(sessionId, input, { directory: getSessionDirectory(sessionId) }),
    getSession: (sessionId) => appStore.state.sessions.find((session) => session.id === sessionId),
  });

  const sessionActionOperations = new SessionActionOperations({
    getActiveSessionId: () => appStore.state.activeSessionId,
    getBuildAgent: getBuildAgentNameFromState,
    setError: uiStore.setError,
    clearSkippedPlanSession: sessionStore.clearSkippedPlanSession,
    applySelectedAgent: (agent, sessionId) => {
      routingStore.setSelectedAgent(agent, { sessionId, persistGlobal: false });
    },
    sendMessage,
    openPlan: (content) => client.varro.openPlan(content),
    createSession: () =>
      createSession(undefined, permissionsStore.getPermissionModeForSession(null)),
    getMessageCount: () => appStore.state.messages.length,
    hasCommand: routingStore.hasCommand,
    startLoading: uiStore.startLoading,
    runSessionCommand: (sessionId, input) =>
      client.session.command(sessionId, input, { directory: getSessionDirectory(sessionId) }),
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
    respondAutomaticPermission: (sessionId, permissionId, response, lease) => {
      const currentLease = lease ?? permissionAutomationLease;
      return currentLease === undefined
        ? Promise.reject(new Error('Permission automation lease is required'))
        : client.session.respondPermission(sessionId, permissionId, response, {
            permissionAutomationLease: currentLease,
          });
    },
    canAutomatePermissions: () => permissionAutomationOwner,
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
    updateSessionPermission: (sessionId, mode) =>
      client.varro.session.updatePermissionMode(sessionId, mode, {
        directory: getSessionDirectory(sessionId),
      }),
    upsertSession,
    getPermissionsForSession: (sessionId) => {
      const sessionIds = new Set(getSessionTreeIds(sessionId));
      return appStore.state.permissions.filter(
        (permission) =>
          sessionIds.has(permission.sessionID) &&
          !permissionsStore.isSessionPermissionModePending(permission.sessionID) &&
          permissionsStore.getPermissionModeForSession(permission.sessionID) === 'full'
      );
    },
    syncPendingPermissions,
    setPendingSessionPermissionMode: permissionsStore.setPendingSessionPermissionMode,
  });

  const sessionManagementOperations = new SessionManagementOperations({
    getActiveSessionId: () => appStore.state.activeSessionId,
    getWorkspaceGeneration: () => workspaceGeneration,
    getSessionSelectionGeneration: () => sessionSelectionGeneration,
    getNewChatDraftGeneration,
    createRemoteSession: (body, workspaceTarget) => {
      const workspaceScope =
        workspaceTarget?.scope ??
        (!manualWorkspaceSelection() &&
        (appStore.state.editorContext.workspaceFolders?.length ?? 0) > 1
          ? 'workspace'
          : 'folder');
      const directory = workspaceTarget
        ? (workspaceTarget.directory ?? undefined)
        : workspaceScope === 'workspace'
          ? (appStore.state.editorContext.workspaceDirectory ??
            appStore.state.editorContext.workspaceFolders?.[0]?.path ??
            undefined)
          : (appStore.state.editorContext.workspacePath ?? undefined);
      return client.session.create(
        { ...body, metadata: createSessionWorkspaceMetadata(workspaceScope) },
        { directory }
      );
    },
    updateRemoteSession: (sessionId, body) =>
      client.session.update(sessionId, body, { directory: getSessionDirectory(sessionId) }),
    forkRemoteSession: (sessionId, messageID) =>
      client.session.fork(sessionId, messageID, { directory: getSessionDirectory(sessionId) }),
    getPermissionModeForSession: permissionsStore.getPermissionModeForSession,
    isPermissionModeStable: (sessionId) =>
      !permissionsStore.isSessionPermissionModePending(sessionId) &&
      !permissionsStore.isPermissionModeRecoveryPending(sessionId),
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
    publishSessionModel,
    getEffectiveSessionModel: (sessionId) =>
      routingStore.getSelectedModelForSession(sessionId) ??
      (appStore.state.activeSessionId === sessionId ? appStore.state.selectedModel : null) ??
      deriveSelectedModelFromSession(
        appStore.state.sessions.find((session) => session.id === sessionId)
      ),
    resolveDefaultAgent: () =>
      getBuildAgentNameFromState() ||
      routingStore.getPersistedSelectedAgent() ||
      getDefaultPrimaryAgentNameFromState(),
    setSelectedAgent: routingStore.setSelectedAgent,
    getInitialMcpNames: () => routingStore.getSelectedMcpsForSession(null) || [],
    setSelectedMcpsForSession: routingStore.setSelectedMcpsForSession,
    resetDraftSelectedMcps: routingStore.resetDraftSelectedMcps,
    setPermissionModeForSession: permissionsStore.setPermissionModeForSession,
    setPendingSessionPermissionMode: permissionsStore.setPendingSessionPermissionMode,
    persistConfirmedPermissionModeForSession: (sessionId, mode, directory) =>
      client.varro.session
        .updatePermissionMode(sessionId, mode, {
          directory,
          preconfigured: true,
        })
        .then(() => undefined),
    resetDraftPermissionMode: permissionsStore.resetDraftPermissionMode,
    resetTodoSync,
    clearMessages: sessionStore.clearMessages,
    stopLoading: uiStore.stopLoading,
    setError: uiStore.setError,
    getSessions: () => appStore.state.sessions,
    getDeletedSessionTreeIds,
    getNextSessionIdAfterDeletion,
    deleteRemoteSession: (sessionId) =>
      client.session.delete(sessionId, { directory: getSessionDirectory(sessionId) }),
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
    const activation = ++sessionActivationGeneration;
    sessionActivationController?.abort();
    const activationController = new AbortController();
    sessionActivationController = activationController;
    const knownSession = appStore.state.sessions.find((session) => session.id === id);
    const targetDirectory = options?.directory ?? knownSession?.directory;
    sessionActivationDirectory = null;
    if (targetDirectory && !isSameWorkspacePath(targetDirectory, currentWorkspacePath)) {
      sessionActivationDirectory = targetDirectory;
      try {
        const activatedSession = await client.session.activate(id, targetDirectory, {
          signal: activationController.signal,
        });
        if (activation !== sessionActivationGeneration) return false;
        upsertSession(activatedSession);
      } catch (err) {
        if (
          activation === sessionActivationGeneration &&
          !activationController.signal.aborted &&
          options?.reportActivationError !== false
        ) {
          uiStore.setError(err instanceof Error ? err.message : String(err));
        }
        if (sessionActivationController === activationController) {
          sessionActivationController = null;
          sessionActivationDirectory = null;
        }
        return false;
      }
    }
    if (activation !== sessionActivationGeneration) return false;
    if (sessionActivationController === activationController) {
      sessionActivationController = null;
      sessionActivationDirectory = null;
    }
    messageSyncGenerations.invalidate(id);
    await sessionSyncOperations.selectSession(id, options);
    if (appStore.state.activeSessionId === id) {
      const directory = getSessionDirectory(id);
      sessionStore.persistLastOpenedView(
        directory
          ? { type: 'session', sessionId: id, directory }
          : { type: 'session', sessionId: id }
      );
    }
    return appStore.state.activeSessionId === id;
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
    initialPermissionMode = permissionsStore.getPermissionModeForSession(null),
    workspaceTarget?: SessionWorkspaceTarget
  ): Promise<string | null> {
    const sessionId = await sessionManagementOperations.createSession(
      title,
      initialPermissionMode,
      workspaceTarget
    );
    if (sessionId) {
      const directory = getSessionDirectory(sessionId);
      sessionStore.persistLastOpenedView(
        directory ? { type: 'session', sessionId, directory } : { type: 'session', sessionId }
      );
    }
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

  function loadOlderSessionHistoryPage(
    sessionId: string,
    options?: { prefetchBoundaryPrompts?: boolean }
  ): Promise<boolean> {
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
          directory: getSessionDirectory(sessionId),
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
        if (nextCursor && options?.prefetchBoundaryPrompts !== false) {
          void loadSessionBoundaryPrompts(sessionId, nextCursor, isCurrent);
        }
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
    if (sessionId) {
      const directory = getSessionDirectory(sessionId);
      sessionStore.persistLastOpenedView(
        directory ? { type: 'session', sessionId, directory } : { type: 'session', sessionId }
      );
    }
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
      messageId?: string;
      agent?: string;
      noReply?: boolean;
      delivery?: 'steer' | 'queue';
      queuedAttachments?: QueuedAttachmentSnapshot;
      queuedContext?: QueuedContextSnapshot;
      preserveComposer?: boolean;
      targetSessionId?: string;
      workspaceDirectory?: string;
      newSessionWorkspace?: SessionWorkspaceTarget;
      queuedMessageDispatch?: { itemId: string; lease: number };
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
      selectedModel?: SelectedModel;
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
    const groupMembers = permission ? permissionsStore.getPermissionGroupMembers(permission) : [];
    const decisionReference = permission
      ? toApprovedPermissionReference(permission, response)
      : null;
    try {
      for (const member of groupMembers) {
        const attempt = permissionJudgeAttempts.get(member.id);
        if (!attempt) continue;
        attempt.status = 'responded';
        finishPermissionJudgeAttempt(attempt);
      }
      await sessionApprovalOperations.respondPermission(sessionId, permissionId, response, {
        ...options,
        rethrow: true,
        groupMembers: response === 'reject' && permission ? groupMembers : undefined,
      });
    } catch (err) {
      for (const member of permission
        ? permissionsStore.getPermissionGroupMembers(permission)
        : []) {
        const attempt = permissionJudgeAttempts.get(member.id);
        if (attempt?.status === 'responded') attempt.status = 'visible';
      }
      if (options?.rethrow) throw err;
      return;
    }
    if (permission && decisionReference) {
      recordPermissionDecisionReference(permission.sessionID, decisionReference);
      for (const member of groupMembers.length > 0 ? groupMembers : [permission]) {
        finishAutoApproveActivity(
          member,
          response === 'reject' ? 'manually-rejected' : 'manually-approved',
          response === 'reject'
            ? 'Rejected manually.'
            : response === 'always'
              ? 'Approved manually for matching future requests.'
              : 'Approved manually once.'
        );
      }
      if (response === 'always') recheckVisiblePermissionsAfterAlways(permission);
    }
  }

  function recordPermissionDecisionReference(
    sessionId: string,
    reference: AutoApproveJudgeReference
  ) {
    const scopeId = getPermissionDecisionScopeId(sessionId);
    const references = permissionDecisionReferencesByTree.get(scopeId) || [];
    permissionDecisionReferencesByTree.set(scopeId, [...references, reference].slice(-20));
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
