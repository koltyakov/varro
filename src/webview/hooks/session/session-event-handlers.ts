import {
  isAbortedAssistantError,
  isTransientProviderConnectionError,
} from '../../../shared/error-classification';
import { isEditPermission } from '../../../shared/permission-rules';
import type { ServerEvent } from '../../../shared/protocol';
import { serverEvents } from '../../lib/client';
import {
  hasUnsettledToolPart,
  isAssistantMessage,
  isContinuationAssistantFinish,
  latestAssistantFinishedBeforeLoading,
} from '../../lib/message-metrics';
import { isRunningSessionStatus } from '../../lib/session-event-reducer';
import { logWarn } from '../../lib/log';
import { readWebviewInstanceContext } from '../../lib/state-stored-values';
import {
  invalidateSessionMessageWindowRequests,
  recordSessionMessageSnapshotMutation,
  resetSessionMessageWindowForRefetch,
} from '../../lib/message-window';
import { hasStreamedFinalResponse } from './session-watchdog';
import { parseUsageLimitNotice, type UsageLimitNotice } from '../../lib/usage-limit';
import { validateFileDiffs } from '../../lib/validate-diffs';
import { appStore } from '../../lib/stores/app-store';
import { permissionsStore } from '../../lib/stores/permissions-store';
import { sessionStore } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import { isSessionTreeStatusWorking } from '../../lib/state';
import { registerApprovalEventHandlers } from './session-approval-events';
import type {
  AssistantUsagePatch,
  NormalizedSessionEventInfo,
  ToolExecutionTime,
} from './session-event-utils';
import {
  ACTIVE_SESSION_PROGRESS_EVENTS,
  PROJECTED_SESSION_EVENTS,
  STREAMED_COMPLETION_SETTLE_DELAY_MS,
  TRANSCRIPT_SYNC_SESSION_EVENTS,
  currentStreamingSnapshot,
  getAssistantFinishedMessageId,
  getAssistantUsagePatchFromStepEvent,
  getEventString,
  getEventTimestamp,
  getPartDeltaQueueKey,
  getToolExecutionKey,
  hasActiveAssistantReply,
  isCompleteMessageInfo,
  isCompleteMessagePart,
  isContinuationStepEnd,
  isContinuationStepFinish,
  mergeSessionEventInfo,
  normalizeSessionEventInfo,
  syncSessionAgent,
} from './session-event-utils';
import { createProjectedSessionEventHandler } from './session-projected-events';
import { registerReasoningEventHandlers } from './session-reasoning-events';
import type {
  AssistantMessage,
  FileDiff,
  Message,
  MessageEntry,
  Part,
  Permission,
  Session,
  SessionEventInfo,
  SessionStatus,
} from '../../types';
import {
  asRecord,
  isNumber,
  isString,
  type UnknownRecord,
  isObject,
} from '../../lib/runtime-values';

const MISSING_PART_RECOVERY_RETRY_MIN_MS = 100;
const MISSING_PART_RECOVERY_RETRY_MAX_MS = 1_000;
const MAX_TRACKED_SESSION_SEQUENCES = 512;
const MAX_TRACKED_IDLE_SETTLEMENTS = 512;
const MAX_EVICTED_SESSION_SEQUENCES = 512;
const MAX_DIRTY_GAP_SESSIONS = 256;
const MAX_OVERFLOW_GAP_RECOVERIES = 16;
const MAX_TOOL_EXECUTION_TIMES = 1_024;
const DIRTY_GAP_RETRY_MIN_MS = 100;
const DIRTY_GAP_RETRY_MAX_MS = 30_000;
const TRANSIENT_CONNECTION_RETRY_DELAY_MS = 5_000;

type SequenceStatus = 'unknown' | 'ok' | 'gap';

type DirtyGapState = {
  generation: number;
  retryDelayMs: number;
  retryPending: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  syncing: boolean;
};

function runGapSync(
  operation: () => Promise<void | boolean | object>
): Promise<void | boolean | object> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

type EventHandlerDependencies = {
  getActiveSessionId(): string | null;
  getSessionStatus(sessionId: string): SessionStatus | null | undefined;
  isSessionTreeStatusWorking(sessionId: string): boolean;
  isSessionInActiveTree?(sessionId: string): boolean;
  getMessages(): MessageEntry[];
  findMessageById?(messageId: string): MessageEntry | null;
  findMessagePart?(messageId: string, partId: string): Part | null;
  isMessageRemovalDeferred?(sessionId: string, messageId: string): boolean;
  handoffTodosToMessages(messages?: MessageEntry[]): boolean;
  upsertSession(info: Session): void;
  setSessionCompacting(sessionId: string, compacting: boolean): void;
  removeDeletedSessionTree(sessionId: string): void;
  shouldIgnorePendingAbortStatus(sessionId: string, status: SessionStatus): boolean;
  hasPendingAbort(sessionId: string | null | undefined): boolean;
  markPendingAbort(sessionId: string): void;
  clearPendingAbort(sessionId: string | null | undefined): void;
  setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
  clearUsageLimitOnResumedProgress(sessionId: string, status?: SessionStatus | null): void;
  updateUsageLimitState(sessionId: string, status: SessionStatus | null | undefined): void;
  syncSession(
    sessionId: string,
    options?: { shouldApply(): boolean }
  ): Promise<void | boolean | object>;
  repairSessionTitle?(sessionId: string): Promise<void | boolean | object>;
  shouldResyncSessionAfterIdle(sessionId: string): boolean;
  syncSessionMessages(sessionId: string): Promise<void | boolean | object>;
  recheckSessionStatus?(sessionId: string): Promise<void | boolean | object>;
  applyUsageLimitNotice(
    sessionId: string,
    notice: UsageLimitNotice | null,
    options?: { preserveExistingOnNull?: boolean }
  ): void;
  syncTodosFromMessages<T>(messages?: MessageEntry[], latestEventPayload?: T): void;
  syncTodosForSession?(
    sessionId: string,
    messages?: MessageEntry[]
  ): Promise<void | boolean | object>;
  shouldAutoApprovePermissions(sessionId: string): boolean;
  shouldAutoApproveEdit?(permission: Permission): boolean;
  shouldAutoJudgePermissions?(sessionId: string): boolean;
  isPermissionSessionKnown?(sessionId: string): boolean;
  syncPermissionSession?(sessionId: string): Promise<void | boolean | object>;
  judgePermission?(permission: Permission): Promise<void | boolean | object>;
  permissionReplied?(permissionId: string): void;
  permissionVisible?(permissionId: string): void;
  syncPendingPermissions?(): Promise<void | boolean | object>;
  reconcileServerState?(): Promise<void | boolean | object>;
  invalidateMessageSync?(sessionId: string): void;
  respondPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ): Promise<void | boolean | object>;
  respondAutomaticPermission?: EventHandlerDependencies['respondPermission'];
  setDiffs(diffs: FileDiff[]): void;
  abortRemoteSession(sessionId: string): Promise<void | boolean | object>;
  continueInterruptedSession?(sessionId: string): Promise<void | boolean | object>;
  logError(context: string, cause: unknown): void;
  isPermissionAutomationOwner?(): boolean;
};

type EventHandlerOperationDependencies = {
  todoSyncOperations: Pick<
    EventHandlerDependencies,
    'handoffTodosToMessages' | 'syncTodosFromMessages' | 'syncTodosForSession'
  >;
  sessionLifecycleOperations: Pick<
    EventHandlerDependencies,
    'upsertSession' | 'removeDeletedSessionTree'
  >;
  sessionStatusOperations: Pick<
    EventHandlerDependencies,
    | 'shouldIgnorePendingAbortStatus'
    | 'hasPendingAbort'
    | 'markPendingAbort'
    | 'clearPendingAbort'
    | 'clearUsageLimitOnResumedProgress'
    | 'updateUsageLimitState'
    | 'applyUsageLimitNotice'
    | 'recheckSessionStatus'
    | 'setSessionStatusEntry'
  >;
  sessionSyncOperations: Pick<EventHandlerDependencies, 'syncSession' | 'syncSessionMessages'>;
  repairSessionTitle?: EventHandlerDependencies['repairSessionTitle'];
  sessionApprovalOperations: Pick<
    EventHandlerDependencies,
    | 'respondPermission'
    | 'judgePermission'
    | 'permissionReplied'
    | 'permissionVisible'
    | 'isPermissionSessionKnown'
    | 'syncPermissionSession'
  > & {
    respondAutomaticPermission?: EventHandlerDependencies['respondAutomaticPermission'];
  };
  syncPendingPermissions?: EventHandlerDependencies['syncPendingPermissions'];
  reconcileServerState?: EventHandlerDependencies['reconcileServerState'];
  invalidateMessageSync?: EventHandlerDependencies['invalidateMessageSync'];
  isMessageRemovalDeferred?: EventHandlerDependencies['isMessageRemovalDeferred'];
  abortRemoteSession: EventHandlerDependencies['abortRemoteSession'];
  continueInterruptedSession: NonNullable<EventHandlerDependencies['continueInterruptedSession']>;
  logError: EventHandlerDependencies['logError'];
  isPermissionAutomationOwner?(): boolean;
};

export class SessionEventHandlerOperations {
  constructor(private readonly deps: EventHandlerOperationDependencies) {}

  readonly registerSessionEventHandlers = () => {
    return registerSessionEventHandlers({
      getActiveSessionId: () => appStore.state.activeSessionId,
      getSessionStatus: (sessionId) => appStore.state.sessionStatus[sessionId],
      isSessionTreeStatusWorking,
      isSessionInActiveTree: (sessionId) => {
        const activeSessionId = appStore.state.activeSessionId;
        if (!activeSessionId) return false;

        return (
          (sessionStore.getSessionTreeRootId(sessionId) || sessionId) ===
          (sessionStore.getSessionTreeRootId(activeSessionId) || activeSessionId)
        );
      },
      getMessages: () => appStore.state.messages,
      findMessageById: sessionStore.getMessageById,
      findMessagePart: sessionStore.getMessagePartById,
      isMessageRemovalDeferred: this.deps.isMessageRemovalDeferred,
      handoffTodosToMessages: this.deps.todoSyncOperations.handoffTodosToMessages,
      upsertSession: this.deps.sessionLifecycleOperations.upsertSession,
      setSessionCompacting: sessionStore.setSessionCompacting,
      removeDeletedSessionTree: this.deps.sessionLifecycleOperations.removeDeletedSessionTree,
      shouldIgnorePendingAbortStatus:
        this.deps.sessionStatusOperations.shouldIgnorePendingAbortStatus,
      hasPendingAbort: this.deps.sessionStatusOperations.hasPendingAbort,
      markPendingAbort: this.deps.sessionStatusOperations.markPendingAbort,
      clearPendingAbort: this.deps.sessionStatusOperations.clearPendingAbort,
      setSessionStatusEntry: this.deps.sessionStatusOperations.setSessionStatusEntry,
      clearUsageLimitOnResumedProgress:
        this.deps.sessionStatusOperations.clearUsageLimitOnResumedProgress,
      updateUsageLimitState: this.deps.sessionStatusOperations.updateUsageLimitState,
      syncSession: this.deps.sessionSyncOperations.syncSession,
      repairSessionTitle: this.deps.repairSessionTitle,
      shouldResyncSessionAfterIdle: (sessionId) => {
        const activeSessionId = appStore.state.activeSessionId;
        if (!activeSessionId) return false;
        return (
          (sessionStore.getSessionTreeRootId(sessionId) || sessionId) ===
          (sessionStore.getSessionTreeRootId(activeSessionId) || activeSessionId)
        );
      },
      syncSessionMessages: this.deps.sessionSyncOperations.syncSessionMessages,
      recheckSessionStatus: this.deps.sessionStatusOperations.recheckSessionStatus,
      applyUsageLimitNotice: this.deps.sessionStatusOperations.applyUsageLimitNotice,
      syncTodosFromMessages: this.deps.todoSyncOperations.syncTodosFromMessages,
      syncTodosForSession: this.deps.todoSyncOperations.syncTodosForSession,
      shouldAutoApprovePermissions: (sessionId) =>
        this.deps.isPermissionAutomationOwner?.() !== false &&
        !permissionsStore.isSessionPermissionModePending(sessionId) &&
        !permissionsStore.isPermissionModeRecoveryPending(sessionId) &&
        permissionsStore.getPermissionModeForSession(sessionId) === 'full',
      shouldAutoApproveEdit: (permission) =>
        this.deps.isPermissionAutomationOwner?.() !== false &&
        !permissionsStore.isSessionPermissionModePending(permission.sessionID) &&
        !permissionsStore.isPermissionModeRecoveryPending(permission.sessionID) &&
        permissionsStore.getPermissionModeForSession(permission.sessionID) === 'edits' &&
        isEditPermission(permission.type),
      shouldAutoJudgePermissions: (sessionId) =>
        this.deps.isPermissionAutomationOwner?.() !== false &&
        !permissionsStore.isSessionPermissionModePending(sessionId) &&
        !permissionsStore.isPermissionModeRecoveryPending(sessionId) &&
        permissionsStore.getPermissionModeForSession(sessionId) === 'auto',
      isPermissionSessionKnown: this.deps.sessionApprovalOperations.isPermissionSessionKnown,
      syncPermissionSession: this.deps.sessionApprovalOperations.syncPermissionSession,
      judgePermission: this.deps.sessionApprovalOperations.judgePermission,
      permissionReplied: this.deps.sessionApprovalOperations.permissionReplied,
      permissionVisible: this.deps.sessionApprovalOperations.permissionVisible,
      syncPendingPermissions: this.deps.syncPendingPermissions,
      reconcileServerState: this.deps.reconcileServerState,
      invalidateMessageSync: this.deps.invalidateMessageSync,
      respondPermission: this.deps.sessionApprovalOperations.respondPermission,
      respondAutomaticPermission: this.deps.sessionApprovalOperations.respondAutomaticPermission,
      setDiffs: sessionStore.setDiffs,
      abortRemoteSession: this.deps.abortRemoteSession,
      continueInterruptedSession: this.deps.continueInterruptedSession,
      logError: this.deps.logError,
    });
  };
}

export function registerSessionEventHandlers(deps: EventHandlerDependencies) {
  const cleanups: Array<() => void> = [];
  const messageSyncs = new Set<string>();
  const pendingTranscriptMessageSyncs = new Set<string>();
  const pendingMissingPartDeltas = new Map<
    string,
    {
      sessionID: string;
      generation: number;
      syncing: boolean;
      retryDelayMs: number;
      retryTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  const toolExecutionTimes = new Map<string, ToolExecutionTime>();
  const transientConnectionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-session debounce timers for the optimistic streamed-completion settle.
  const streamedCompletionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const settledIdleSessions = new Set<string>();
  const pendingTerminalStepSettles = new Map<string, number>();
  // Per-session durable sequence cursor, advanced by synchronized events (ephemeral
  // delta fragments carry no `seq`). Lets us resync only when a durable event was
  // actually missed, instead of defensively on every progress event.
  const lastSeqBySession = new Map<string, number>();
  // A lower seq may be a stale replay or a server reset. Keep the old cursor until
  // canonical repair succeeds and the lower sequence advances.
  const pendingSequenceResets = new Map<string, { seq: number; repaired: boolean }>();
  const evictedSequenceSessions = new Set<string>();
  // A cursor can advance past a gap before reconciliation finishes. Keep the session
  // dirty until both canonical metadata and transcript reads succeed.
  const dirtyGaps = new Map<string, DirtyGapState>();
  const overflowGapRecoveries = new Set<string>();
  let sequenceEvictionOverflow = false;
  let dirtyGapOverflowLogged = false;
  let disposed = false;
  let pendingPermissionSync = false;
  let serverReconciliation: Promise<void | boolean | object> | null = null;
  // Returns 'unknown' when the event carries no seq (e.g. an ephemeral delta - caller
  // keeps its default behavior), 'ok' when the event is in order or a duplicate, or 'gap'
  // when at least one durable event was skipped (a targeted resync is warranted).
  const rememberSequenceEviction = (sessionId: string) => {
    if (sequenceEvictionOverflow || evictedSequenceSessions.has(sessionId)) return;
    if (evictedSequenceSessions.size >= MAX_EVICTED_SESSION_SEQUENCES) {
      evictedSequenceSessions.clear();
      sequenceEvictionOverflow = true;
      return;
    }
    evictedSequenceSessions.add(sessionId);
  };
  const invalidateSequenceCursor = (sessionId: string) => {
    lastSeqBySession.delete(sessionId);
    pendingSequenceResets.delete(sessionId);
    rememberSequenceEviction(sessionId);
  };
  const noteSeq = (
    sessionId: string | null | undefined,
    seq: number | undefined
  ): SequenceStatus => {
    if (!sessionId || !isNumber(seq) || !Number.isFinite(seq)) return 'unknown';
    const last = lastSeqBySession.get(sessionId);
    if (last === undefined) {
      const requiresRecovery =
        sequenceEvictionOverflow || evictedSequenceSessions.delete(sessionId);
      while (lastSeqBySession.size >= MAX_TRACKED_SESSION_SEQUENCES) {
        const oldestSessionId = lastSeqBySession.keys().next().value;
        if (oldestSessionId === undefined) break;
        lastSeqBySession.delete(oldestSessionId);
        pendingSequenceResets.delete(oldestSessionId);
        rememberSequenceEviction(oldestSessionId);
      }
      lastSeqBySession.set(sessionId, seq);
      return requiresRecovery ? 'gap' : 'ok';
    }
    if (seq === last) return 'ok';
    if (seq < last) {
      const reset = pendingSequenceResets.get(sessionId);
      if (reset?.repaired && seq === reset.seq + 1) {
        pendingSequenceResets.delete(sessionId);
        lastSeqBySession.set(sessionId, seq);
        return 'ok';
      }
      if (!reset || reset.repaired || seq > reset.seq) {
        pendingSequenceResets.set(sessionId, { seq, repaired: false });
      }
      return 'gap';
    }
    pendingSequenceResets.delete(sessionId);
    lastSeqBySession.set(sessionId, seq);
    return seq === last + 1 ? 'ok' : 'gap';
  };
  const isSessionInActiveTree = (sessionId: string | null | undefined) => {
    if (!sessionId) return false;
    if (deps.isSessionInActiveTree) return deps.isSessionInActiveTree(sessionId);
    return sessionId === deps.getActiveSessionId();
  };
  const findMessageById = (messageId: string) =>
    deps.findMessageById?.(messageId) ??
    deps.getMessages().find((entry) => entry.info.id === messageId) ??
    null;
  const findMessagePart = (messageId: string, partId: string) =>
    deps.findMessagePart?.(messageId, partId) ??
    findMessageById(messageId)?.parts.find((part) => part.id === partId) ??
    null;
  const invalidateMessageLoads = (sessionId: string, resetHistory = false) => {
    deps.invalidateMessageSync?.(sessionId);
    if (resetHistory) resetSessionMessageWindowForRefetch(sessionId);
    else invalidateSessionMessageWindowRequests(sessionId);
  };
  const isActiveTreeWorking = () => {
    const activeSessionId = deps.getActiveSessionId();
    return activeSessionId ? deps.isSessionTreeStatusWorking(activeSessionId) : false;
  };
  const messagesForSession = (sessionId: string) =>
    deps.getMessages().filter((entry) => entry.info.sessionID === sessionId);
  const isStaleProgressAfterFinishedAssistant = (sessionId: string) =>
    isSessionInActiveTree(sessionId) &&
    latestAssistantFinishedBeforeLoading(messagesForSession(sessionId), uiStore.loadingStartedAt());
  const latestAssistantHasExplicitTerminalFinish = (sessionId: string) => {
    const latest = messagesForSession(sessionId).at(-1)?.info;
    return (
      latest?.role === 'assistant' &&
      !!latest.time.completed &&
      !!latest.finish &&
      !isContinuationAssistantFinish(latest.finish)
    );
  };
  const scheduleMessageSync = (sessionId: string, ensureLatest = false) => {
    if (disposed) return;
    if (messageSyncs.has(sessionId)) {
      if (ensureLatest) pendingTranscriptMessageSyncs.add(sessionId);
      return;
    }

    messageSyncs.add(sessionId);
    void deps
      .syncSessionMessages(sessionId)
      .then(() => {
        if (disposed) return;
        const completedAt = pendingTerminalStepSettles.get(sessionId);
        if (completedAt === undefined) return;
        pendingTerminalStepSettles.delete(sessionId);
        if (!settleLatestAssistantOnIdle(sessionId, completedAt)) return;
        handleSessionIdle(sessionId, deps.hasPendingAbort(sessionId));
      })
      .catch((err) => {
        if (!disposed) deps.logError('syncSessionMessages', err);
      })
      .finally(() => {
        if (disposed) return;
        messageSyncs.delete(sessionId);
        if (!pendingTranscriptMessageSyncs.delete(sessionId)) return;
        scheduleMessageSync(sessionId);
      });
  };
  function scheduleDirtyGapRetry(sessionId: string, state: DirtyGapState) {
    if (
      disposed ||
      state.syncing ||
      state.retryTimer !== undefined ||
      dirtyGaps.get(sessionId) !== state
    ) {
      return;
    }
    const delayMs = state.retryDelayMs;
    state.retryDelayMs = Math.min(state.retryDelayMs * 2, DIRTY_GAP_RETRY_MAX_MS);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      recoverDirtyGap(sessionId, state);
    }, delayMs);
  }
  function recoverDirtyGap(sessionId: string, state: DirtyGapState) {
    if (
      disposed ||
      state.syncing ||
      state.retryTimer !== undefined ||
      dirtyGaps.get(sessionId) !== state
    ) {
      return;
    }

    state.syncing = true;
    state.retryPending = false;
    const generation = state.generation;
    const metadataSync = runGapSync(() =>
      deps.syncSession(sessionId, {
        shouldApply: () =>
          !disposed &&
          dirtyGaps.get(sessionId) === state &&
          state.syncing &&
          state.generation === generation &&
          !state.retryPending,
      })
    );
    const transcriptSync = runGapSync(() => deps.syncSessionMessages(sessionId));
    void Promise.allSettled([metadataSync, transcriptSync]).then(
      ([metadataResult, transcriptResult]) => {
        if (disposed || dirtyGaps.get(sessionId) !== state) return;
        state.syncing = false;
        if (metadataResult.status === 'rejected') {
          deps.logError('syncSession', metadataResult.reason);
        }
        if (transcriptResult.status === 'rejected') {
          deps.logError('syncSessionMessages', transcriptResult.reason);
        }
        const succeeded =
          metadataResult.status === 'fulfilled' && transcriptResult.status === 'fulfilled';
        if (succeeded && state.generation === generation && !state.retryPending) {
          const reset = pendingSequenceResets.get(sessionId);
          if (reset) reset.repaired = true;
          dirtyGaps.delete(sessionId);
          return;
        }
        if (succeeded) {
          state.retryDelayMs = DIRTY_GAP_RETRY_MIN_MS;
          recoverDirtyGap(sessionId, state);
          return;
        }
        scheduleDirtyGapRetry(sessionId, state);
      }
    );
  }
  const recoverOverflowGap = (sessionId: string) => {
    if (disposed || overflowGapRecoveries.has(sessionId)) return;
    if (overflowGapRecoveries.size >= MAX_OVERFLOW_GAP_RECOVERIES) {
      if (!dirtyGapOverflowLogged) {
        dirtyGapOverflowLogged = true;
        deps.logError(
          'sessionEventGapOverflow',
          new Error('Too many unresolved session event gaps')
        );
      }
      return;
    }

    overflowGapRecoveries.add(sessionId);
    const shouldApply = () => !disposed && overflowGapRecoveries.has(sessionId);
    const metadataSync = runGapSync(() => deps.syncSession(sessionId, { shouldApply }));
    const transcriptSync = runGapSync(() => deps.syncSessionMessages(sessionId));
    void Promise.allSettled([metadataSync, transcriptSync]).then(
      ([metadataResult, transcriptResult]) => {
        if (disposed) return;
        overflowGapRecoveries.delete(sessionId);
        if (metadataResult.status === 'rejected') {
          deps.logError('syncSession', metadataResult.reason);
        }
        if (transcriptResult.status === 'rejected') {
          deps.logError('syncSessionMessages', transcriptResult.reason);
        }
      }
    );
  };
  const markDirtyGap = (sessionId: string) => {
    let state = dirtyGaps.get(sessionId);
    if (!state) {
      if (dirtyGaps.size >= MAX_DIRTY_GAP_SESSIONS) {
        invalidateSequenceCursor(sessionId);
        recoverOverflowGap(sessionId);
        return;
      }
      state = {
        generation: 0,
        retryDelayMs: DIRTY_GAP_RETRY_MIN_MS,
        retryPending: false,
        syncing: false,
      };
      dirtyGaps.set(sessionId, state);
    }
    state.generation += 1;
    if (state.syncing) state.retryPending = true;
    recoverDirtyGap(sessionId, state);
  };
  const sequenceStatusByEvent = new WeakMap<ServerEvent, SequenceStatus>();
  // Sequence-sensitive handlers observe before their early returns; the wildcard
  // below covers every other durable event type.
  const observeSequence = (event: ServerEvent): SequenceStatus => {
    const observed = sequenceStatusByEvent.get(event);
    if (observed) return observed;

    const sessionId = getServerEventSessionId(event);
    const status = noteSeq(sessionId, event.seq);
    sequenceStatusByEvent.set(event, status);
    if (sessionId && event.seq !== undefined) {
      if (status === 'gap') {
        markDirtyGap(sessionId);
        schedulePendingPermissionSync();
      } else {
        const dirty = dirtyGaps.get(sessionId);
        if (dirty) {
          dirty.retryPending = true;
          recoverDirtyGap(sessionId, dirty);
        }
      }
    }
    return status;
  };
  const refreshSettledTodos = (sessionId: string) => {
    const sync = deps.syncTodosForSession?.(sessionId, deps.getMessages());
    if (!sync) return;
    sync.catch((err) => deps.logError('syncTodosForSession', err));
  };
  const ignoreStaleProgressAfterFinishedAssistant = (sessionId: string) => {
    if (!isStaleProgressAfterFinishedAssistant(sessionId)) return false;
    return true;
  };
  const ignoreStaleProgressForCompletedMessage = (sessionId: string, messageId: string) => {
    if (!isSessionInActiveTree(sessionId)) return false;
    const message = findMessageById(messageId)?.info;
    if (!message || message.sessionID !== sessionId || message.role !== 'assistant') return false;
    const finishedAt = message.time.completed ?? (message.error ? message.time.created : null);
    if (finishedAt === null) return false;
    const startedAt = uiStore.loadingStartedAt();
    if (startedAt !== null && startedAt > finishedAt) return false;
    return true;
  };
  const markSessionProgress = (sessionId: string) => {
    // Any genuine progress (more text, a tool call, reasoning) means the turn is
    // not done and a previous non-limit error is no longer terminal. Cancel a
    // pending recheck so it can't fire mid-turn.
    clearStreamedCompletionTimer(sessionId);
    settledIdleSessions.delete(sessionId);
    deps.setSessionStatusEntry(sessionId, { type: 'busy' });
    sessionStore.setSessionFailed(sessionId, false);
    deps.clearUsageLimitOnResumedProgress(sessionId, { type: 'busy' });
    if (isSessionInActiveTree(sessionId)) uiStore.startLoading();
  };
  const clearStreamedCompletionTimer = (sessionId: string) => {
    const timer = streamedCompletionTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    streamedCompletionTimers.delete(sessionId);
  };
  // Strong local evidence the latest assistant turn has streamed its final text
  // with no tools in flight: the same signal the stuck-session watchdog uses,
  // evaluated here against committed parts and the live streaming buffer.
  const isStreamedFinalResponse = (sessionId: string) =>
    hasStreamedFinalResponse(deps.getMessages(), sessionId, currentStreamingSnapshot());
  // When final text has streamed and a brief quiet window passes with no further
  // progress, recheck server-authoritative status. Do not settle locally here:
  // a quiet text stream can still be followed by a tool call.
  const scheduleStreamedCompletionSettle = (sessionId: string) => {
    clearStreamedCompletionTimer(sessionId);
    if (!isSessionInActiveTree(sessionId)) return;
    if (deps.hasPendingAbort(sessionId) || !isStreamedFinalResponse(sessionId)) return;
    const timer = setTimeout(() => {
      streamedCompletionTimers.delete(sessionId);
      runStreamedCompletionSettle(sessionId);
    }, STREAMED_COMPLETION_SETTLE_DELAY_MS);
    streamedCompletionTimers.set(sessionId, timer);
  };
  const runStreamedCompletionSettle = (sessionId: string) => {
    if (deps.hasPendingAbort(sessionId) || !isStreamedFinalResponse(sessionId)) return;
    void deps
      .recheckSessionStatus?.(sessionId)
      .catch((err) => deps.logError('streamedCompletionRecheck', err));
  };
  const handleSessionIdle = (sessionId: string, abortedRetry: boolean) => {
    if (disposed) return;
    const alreadySettled = settledIdleSessions.has(sessionId);
    if (!alreadySettled) {
      while (settledIdleSessions.size >= MAX_TRACKED_IDLE_SETTLEMENTS) {
        const oldestSessionId = settledIdleSessions.values().next().value;
        if (oldestSessionId === undefined) break;
        settledIdleSessions.delete(oldestSessionId);
      }
    }
    settledIdleSessions.add(sessionId);
    const hadActiveAssistantReply = hasActiveAssistantReply(deps.getMessages());
    if (!alreadySettled) settleLatestAssistantOnIdle(sessionId, Date.now());
    deps.clearPendingAbort(sessionId);
    sessionStore.setSessionCompacting(sessionId, false);
    deps.setSessionStatusEntry(sessionId, { type: 'idle' });
    if (!abortedRetry) deps.updateUsageLimitState(sessionId, { type: 'idle' });
    if (sessionId === deps.getActiveSessionId()) {
      if (isActiveTreeWorking()) uiStore.startLoading();
      else uiStore.stopLoading();
    } else if (isSessionInActiveTree(sessionId) && !isActiveTreeWorking()) {
      uiStore.stopLoading();
    }
    if (alreadySettled) return;
    deps
      .syncSession(sessionId)
      .catch((err) => logWarn('session-event syncSession after session.idle', err));
    deps.repairSessionTitle?.(sessionId).catch((err) => deps.logError('repairSessionTitle', err));
    if (sessionId === deps.getActiveSessionId()) {
      const activeMessages = deps.getMessages();
      const shouldResyncActiveMessages =
        activeMessages.length === 0 ||
        hadActiveAssistantReply ||
        hasActiveAssistantReply(activeMessages);
      if (readWebviewInstanceContext()?.surface === 'editor' || !uiStore.showSessionPicker()) {
        sessionStore.markSessionSeen(sessionId);
      }
      const handedOffTodos = deps.handoffTodosToMessages();
      refreshSettledTodos(sessionId);
      if (
        (shouldResyncActiveMessages || !handedOffTodos) &&
        deps.shouldResyncSessionAfterIdle(sessionId)
      ) {
        deps
          .syncSessionMessages(sessionId)
          .catch((err) => deps.logError('syncSessionMessages', err));
      }
    } else if (isSessionInActiveTree(sessionId) && deps.shouldResyncSessionAfterIdle(sessionId)) {
      deps.syncSessionMessages(sessionId).catch((err) => deps.logError('syncSessionMessages', err));
    }
  };
  const recordToolExecutionTime = (eventName: string, props: UnknownRecord) => {
    const sessionId = isString(props.sessionID) ? props.sessionID : null;
    const callId = isString(props.callID) ? props.callID : null;
    if (!sessionId || !callId) return null;

    const key = getToolExecutionKey(sessionId, callId);
    const existing = toolExecutionTimes.get(key) || {};
    const timestamp = getEventTimestamp(props);
    const remember = (timing: ToolExecutionTime) => {
      toolExecutionTimes.delete(key);
      toolExecutionTimes.set(key, timing);
      while (toolExecutionTimes.size > MAX_TOOL_EXECUTION_TIMES) {
        const oldestKey = toolExecutionTimes.keys().next().value;
        if (oldestKey === undefined) break;
        toolExecutionTimes.delete(oldestKey);
      }
    };
    if (eventName === 'session.next.tool.called' || eventName === 'session.next.shell.started') {
      remember(
        existing.end !== undefined && existing.start === undefined
          ? { ...existing, start: timestamp }
          : { start: timestamp }
      );
      return { sessionId, callId, ended: false };
    }
    if (
      eventName === 'session.next.tool.success' ||
      eventName === 'session.next.tool.failed' ||
      eventName === 'session.next.shell.ended'
    ) {
      remember({ ...existing, end: timestamp });
      return { sessionId, callId, ended: true };
    }

    return null;
  };
  const applyToolExecutionTime = (part: Part): Part => {
    if (part.type !== 'tool') return part;
    const timing = toolExecutionTimes.get(getToolExecutionKey(part.sessionID, part.callID));
    if (!timing?.start) return part;

    const state = part.state;
    if (state.status === 'running') {
      return { ...part, state: { ...state, time: { ...state.time, start: timing.start } } };
    }
    if (
      (state.status === 'completed' || state.status === 'error') &&
      timing.end !== undefined &&
      timing.end >= timing.start
    ) {
      return {
        ...part,
        state: { ...state, time: { ...state.time, start: timing.start, end: timing.end } },
      };
    }

    return part;
  };
  const updateExistingToolPartExecutionTime = (sessionId: string, callId: string) => {
    for (const message of deps.getMessages()) {
      for (const part of message.parts) {
        if (part.type !== 'tool' || part.sessionID !== sessionId || part.callID !== callId)
          continue;
        const nextPart = applyToolExecutionTime(part);
        if (nextPart !== part) sessionStore.upsertPart(nextPart);
        return;
      }
    }
  };
  const cancelTransientConnectionRetry = (sessionId: string) => {
    const timer = transientConnectionRetryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    transientConnectionRetryTimers.delete(sessionId);
  };
  const scheduleTransientConnectionRetry = (sessionId: string, message: string) => {
    if (
      !deps.continueInterruptedSession ||
      deps.hasPendingAbort(sessionId) ||
      transientConnectionRetryTimers.has(sessionId)
    )
      return;
    const retryAt = Date.now() + TRANSIENT_CONNECTION_RETRY_DELAY_MS;
    deps.setSessionStatusEntry(sessionId, {
      type: 'retry',
      attempt: 1,
      message,
      next: retryAt,
    });
    if (sessionId === deps.getActiveSessionId()) uiStore.startLoading();
    const timer = setTimeout(() => {
      transientConnectionRetryTimers.delete(sessionId);
      if (deps.hasPendingAbort(sessionId)) return;
      void deps.continueInterruptedSession!(sessionId).catch((err) => {
        deps.logError('continueInterruptedSession after connection failure', err);
        scheduleTransientConnectionRetry(sessionId, message);
      });
    }, TRANSIENT_CONNECTION_RETRY_DELAY_MS);
    transientConnectionRetryTimers.set(sessionId, timer);
  };
  const markSessionError = (sessionId: string, error: AssistantMessage['error'] | undefined) => {
    if (error) {
      const messages = deps.getMessages();
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const entry = messages[index];
        if (!entry || entry.info.sessionID !== sessionId) continue;
        if (entry.info.role === 'assistant') {
          sessionStore.upsertMessageInfo({ ...entry.info, error });
          sessionStore.finishMessageStreaming(entry.info.id);
        }
        break;
      }
    }
    deps.setSessionStatusEntry(sessionId, { type: 'idle' });
    deps.clearPendingAbort(sessionId);
    if (error && isAbortedAssistantError(error)) {
      sessionStore.setSessionFailed(sessionId, false);
      sessionStore.setSessionUsageLimit(sessionId, null);
    } else {
      sessionStore.setSessionFailed(sessionId, true);
      const notice = parseUsageLimitNotice(error?.data?.message || error?.name);
      if (notice) {
        deps.applyUsageLimitNotice(sessionId, {
          ...notice,
          source: 'message',
          sessionID: sessionId,
        });
      } else {
        sessionStore.setSessionUsageLimit(sessionId, null);
      }
    }
    if (sessionId === deps.getActiveSessionId() && !isActiveTreeWorking()) uiStore.stopLoading();
    if (isTransientProviderConnectionError(error)) {
      scheduleTransientConnectionRetry(sessionId, error?.data?.message || 'Connection lost');
    } else {
      cancelTransientConnectionRetry(sessionId);
    }
    deps
      .syncSession(sessionId)
      .catch((err) => logWarn('session-event syncSession after session.error', err));
    deps.syncSessionMessages(sessionId).catch((err) => deps.logError('syncSessionMessages', err));
  };
  const schedulePendingPermissionSync = () => {
    if (!deps.syncPendingPermissions || pendingPermissionSync) return;
    pendingPermissionSync = true;
    void deps
      .syncPendingPermissions()
      .catch((err) => deps.logError('syncPendingPermissions', err))
      .finally(() => {
        pendingPermissionSync = false;
      });
  };
  const abortLateChildSession = (info: NormalizedSessionEventInfo) => {
    if (!info.parentID || !deps.hasPendingAbort(info.parentID)) return;

    const alreadyPending = deps.hasPendingAbort(info.id);
    deps.markPendingAbort(info.id);
    deps.setSessionStatusEntry(info.id, { type: 'idle' });
    if (alreadyPending) return;

    void deps.abortRemoteSession(info.id).catch((err) => {
      deps.clearPendingAbort(info.id);
      deps.logError('abortSession', err);
    });
  };
  const findAssistantMessage = (sessionId: string, assistantMessageID?: string) => {
    if (!assistantMessageID) return null;
    const entry = findMessageById(assistantMessageID);
    return entry?.info.sessionID === sessionId && entry.info.role === 'assistant' ? entry : null;
  };
  const findLatestStepAssistantMessage = (sessionId: string) => {
    const messages = deps.getMessages();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index];
      if (!entry || entry.info.sessionID !== sessionId) continue;
      if (!isAssistantMessage(entry.info) || entry.info.error || entry.info.time.completed) {
        return null;
      }
      return { info: entry.info, parts: entry.parts };
    }
    return null;
  };
  const findStepAssistantMessage = (
    sessionId: string,
    assistantMessageID: string | undefined,
    allowLatestFallback: boolean
  ) => {
    if (assistantMessageID) {
      const named = findAssistantMessage(sessionId, assistantMessageID);
      if (named) return named;
      if (!allowLatestFallback) return null;
    }
    // OpenCode's v2 `assistantMessageID` is not the legacy assistant message id
    // rendered in Varro. For terminal step events, fall back to the latest active
    // legacy assistant in the same session so completion does not wait for polls.
    return findLatestStepAssistantMessage(sessionId);
  };
  const settleAssistantStepCompletion = (
    sessionId: string,
    assistantMessageID: string | undefined,
    completedAt: number,
    allowLatestFallback: boolean,
    usage?: AssistantUsagePatch
  ) => {
    const message = findStepAssistantMessage(sessionId, assistantMessageID, allowLatestFallback);
    if (!message) {
      if (allowLatestFallback) pendingTerminalStepSettles.set(sessionId, completedAt);
      if (isSessionInActiveTree(sessionId)) scheduleMessageSync(sessionId);
      return false;
    }
    if (message.info.role !== 'assistant') return false;
    if (hasUnsettledToolPart(message.parts)) return false;
    const assistantInfo = message.info;
    let nextInfo: AssistantMessage | null = null;
    const getNextInfo = (): AssistantMessage => {
      nextInfo ||= { ...assistantInfo };
      return nextInfo;
    };
    if (!assistantInfo.time.completed && !assistantInfo.error) {
      const info = getNextInfo();
      info.time = { ...info.time, completed: completedAt };
    }
    if (usage?.tokens) getNextInfo().tokens = usage.tokens;
    if (usage?.cost !== undefined) getNextInfo().cost = usage.cost;
    if (usage?.finish) getNextInfo().finish = usage.finish;
    if (nextInfo) {
      // SAFETY: getNextInfo clones a complete assistant message before applying this usage patch.
      sessionStore.upsertMessageInfo(nextInfo as Message);
    }
    sessionStore.finishMessageStreaming(assistantInfo.id);
    if (isSessionInActiveTree(sessionId)) scheduleMessageSync(sessionId);
    return true;
  };
  const latestUnsettledAssistantEntry = (sessionId: string) => {
    return findLatestStepAssistantMessage(sessionId);
  };
  const settleLatestAssistantOnIdle = (sessionId: string, completedAt: number) => {
    const message = latestUnsettledAssistantEntry(sessionId);
    if (!message || hasUnsettledToolPart(message.parts)) return false;
    if (message.info.time.created > completedAt) return false;
    sessionStore.upsertMessageInfo({
      ...message.info,
      time: { ...message.info.time, completed: completedAt },
    });
    sessionStore.finishMessageStreaming(message.info.id);
    return true;
  };
  const settlePartialAssistantUpdate = (
    sessionId: string,
    partialMessage: {
      id?: unknown;
      error?: AssistantMessage['error'];
      time?: { completed?: number };
    },
    assistantMessage: AssistantMessage | null
  ) => {
    const messageId = getAssistantFinishedMessageId(
      deps.getMessages(),
      { sessionID: sessionId, id: partialMessage.id },
      assistantMessage
    );
    if (!messageId) return null;

    const local = findMessageById(messageId);
    if (local?.info.role === 'assistant') {
      const completed = partialMessage.time?.completed;
      sessionStore.upsertMessageInfo({
        ...local.info,
        error: partialMessage.error ? partialMessage.error : undefined,
        time: {
          ...local.info.time,
          completed,
        },
      });
    }

    sessionStore.finishMessageStreaming(messageId);
    return messageId;
  };
  const settleAssistantStepEnd = (sessionId: string, props: UnknownRecord) => {
    if (isContinuationStepEnd('session.next.step.ended', props)) return false;
    return settleAssistantStepCompletion(
      sessionId,
      getEventString(props, 'assistantMessageID'),
      getEventTimestamp(props),
      true,
      getAssistantUsagePatchFromStepEvent(props)
    );
  };
  const settleAssistantStepFinishPart = (part: Part, completedAt: number) => {
    if (part.type !== 'step-finish') return false;
    if (isContinuationStepFinish(part.reason)) return false;
    return settleAssistantStepCompletion(part.sessionID, part.messageID, completedAt, false, {
      cost: part.cost,
      finish: part.reason,
      tokens: part.tokens,
    });
  };
  const handleProjectedSessionEvent = createProjectedSessionEventHandler({
    isSessionInActiveTree,
    getMessages: () => deps.getMessages(),
    findAssistantMessage,
    findPart: findMessagePart,
    scheduleActiveMessageSync: scheduleMessageSync,
    syncTodosFromMessages: () => deps.syncTodosFromMessages(),
  });

  const syncMessagePartsIfMissing = (message: AssistantMessage) => {
    const localMessage = findMessageById(message.id);
    if (localMessage && localMessage.parts.length > 0) return;

    scheduleMessageSync(message.sessionID);
  };
  const hasMessagePart = (messageID: string, partID: string) =>
    findMessagePart(messageID, partID) !== null;
  const recoverMissingPartDeltas = (
    key: string,
    pending: {
      sessionID: string;
      generation: number;
      syncing: boolean;
      retryDelayMs: number;
      retryTimer?: ReturnType<typeof setTimeout>;
    }
  ) => {
    if (pending.syncing || pendingMissingPartDeltas.get(key) !== pending) return;

    pending.syncing = true;
    void deps
      .syncSessionMessages(pending.sessionID)
      .then(async () => {
        if (pendingMissingPartDeltas.get(key) !== pending) return;

        // The synchronized part is canonical. Record which arrivals the bounded
        // follow-up is intended to cover rather than replaying queued fragments.
        const followUpGeneration = pending.generation;
        await deps.syncSessionMessages(pending.sessionID);
        if (pendingMissingPartDeltas.get(key) !== pending) return;
        if (pending.generation === followUpGeneration) {
          pendingMissingPartDeltas.delete(key);
          return;
        }

        // A delta arrived after the follow-up read its snapshot. Back off before
        // another bounded pass so sustained traffic cannot continuously refetch.
        const retryDelayMs = pending.retryDelayMs;
        pending.retryDelayMs = Math.min(
          pending.retryDelayMs * 2,
          MISSING_PART_RECOVERY_RETRY_MAX_MS
        );
        pending.retryTimer = setTimeout(() => {
          pending.retryTimer = undefined;
          if (pendingMissingPartDeltas.get(key) !== pending) return;
          pending.syncing = false;
          recoverMissingPartDeltas(key, pending);
        }, retryDelayMs);
      })
      .catch((err) => {
        if (pending.retryTimer !== undefined) clearTimeout(pending.retryTimer);
        if (pendingMissingPartDeltas.get(key) === pending) {
          pendingMissingPartDeltas.delete(key);
        }
        deps.logError('syncSessionMessages', err);
      });
  };
  const queueMissingPartDelta = (sessionID: string, messageID: string, partID: string) => {
    const key = getPartDeltaQueueKey(messageID, partID);
    const existing = pendingMissingPartDeltas.get(key);
    const pending = existing || {
      sessionID,
      generation: 0,
      syncing: false,
      retryDelayMs: MISSING_PART_RECOVERY_RETRY_MIN_MS,
    };
    pending.sessionID = sessionID;
    pending.generation += 1;
    pendingMissingPartDeltas.set(key, pending);
    recoverMissingPartDeltas(key, pending);
  };

  cleanups.push(
    serverEvents.on('*', (event) => {
      observeSequence(event);
    })
  );

  cleanups.push(() => {
    disposed = true;
    messageSyncs.clear();
    pendingTranscriptMessageSyncs.clear();
    pendingTerminalStepSettles.clear();
    toolExecutionTimes.clear();
    for (const pending of pendingMissingPartDeltas.values()) {
      if (pending.retryTimer !== undefined) clearTimeout(pending.retryTimer);
    }
    pendingMissingPartDeltas.clear();
    lastSeqBySession.clear();
    pendingSequenceResets.clear();
    evictedSequenceSessions.clear();
    for (const dirty of dirtyGaps.values()) {
      if (dirty.retryTimer !== undefined) clearTimeout(dirty.retryTimer);
    }
    dirtyGaps.clear();
    overflowGapRecoveries.clear();
    for (const timer of streamedCompletionTimers.values()) clearTimeout(timer);
    streamedCompletionTimers.clear();
    settledIdleSessions.clear();
    pendingPermissionSync = false;
    serverReconciliation = null;
  });

  cleanups.push(
    serverEvents.on('server.connected', () => {
      if (serverReconciliation) return;
      const activeSessionId = deps.getActiveSessionId();
      const recoveries: Array<Promise<void | boolean | object>> = [];
      if (deps.reconcileServerState) {
        recoveries.push(
          runGapSync(deps.reconcileServerState).catch((err) => {
            deps.logError('reconcileServerState', err);
          })
        );
      }
      if (activeSessionId) {
        recoveries.push(
          runGapSync(() => deps.syncSessionMessages(activeSessionId)).catch((err) => {
            deps.logError('syncSessionMessages', err);
          })
        );
      }
      if (recoveries.length === 0) return;
      serverReconciliation = Promise.all(recoveries)
        .then(() => undefined)
        .finally(() => {
          serverReconciliation = null;
        });
    })
  );

  cleanups.push(
    serverEvents.on('session.created', (data) => {
      const info = normalizeSessionEventInfo(
        // SAFETY: The surrounding shape or discriminator check establishes the SessionEventInfo contract used below.
        data.properties?.info as SessionEventInfo | undefined,
        // SAFETY: The surrounding shape or discriminator check establishes the string contract used below.
        data.properties?.sessionID as string | undefined
      );
      if (info) {
        syncSessionAgent(info);
        const session = mergeSessionEventInfo(info);
        if (session) deps.upsertSession(session);
        abortLateChildSession(info);
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.updated', (data) => {
      const info = normalizeSessionEventInfo(
        // SAFETY: The surrounding shape or discriminator check establishes the SessionEventInfo contract used below.
        data.properties?.info as SessionEventInfo | undefined,
        // SAFETY: The surrounding shape or discriminator check establishes the string contract used below.
        data.properties?.sessionID as string | undefined
      );
      if (info) {
        syncSessionAgent(info);
        if (!info.time?.compacting) deps.setSessionCompacting(info.id, false);
        const session = mergeSessionEventInfo(info);
        if (session) deps.upsertSession(session);
        abortLateChildSession(info);
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.deleted', (data) => {
      if (observeSequence(data) === 'gap') return;
      // SAFETY: The surrounding shape or discriminator check establishes the owner type contract used below.
      const id = (data.properties?.info as { id: string } | undefined)?.id;
      if (id) {
        settledIdleSessions.delete(id);
        cancelTransientConnectionRetry(id);
        deps.removeDeletedSessionTree(id);
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.status', (data) => {
      const props = data.properties;
      if (!props) return;
      const sessionID = getEventString(props, 'sessionID');
      const status = parseSessionStatus(props.status);
      if (!sessionID || !status) return;
      if (deps.shouldIgnorePendingAbortStatus(sessionID, status)) return;
      const abortedRetry = deps.hasPendingAbort(sessionID);
      if (status.type === 'idle') {
        if (abortedRetry) cancelTransientConnectionRetry(sessionID);
        if (transientConnectionRetryTimers.has(sessionID)) return;
        handleSessionIdle(sessionID, abortedRetry);
        return;
      }
      // opencode emits `busy` immediately after both continuation and terminal
      // assistant messages. A terminal finish is already authoritative; allowing
      // that trailing status to restart loading flashes Thinking before idle arrives.
      if (
        status.type === 'busy' &&
        isSessionInActiveTree(sessionID) &&
        latestAssistantFinishedBeforeLoading(
          messagesForSession(sessionID),
          uiStore.loadingStartedAt()
        ) &&
        (!isRunningSessionStatus(deps.getSessionStatus(sessionID)) ||
          latestAssistantHasExplicitTerminalFinish(sessionID))
      ) {
        deps.setSessionStatusEntry(sessionID, { type: 'idle' });
        if (!isActiveTreeWorking()) uiStore.stopLoading();
        return;
      }
      if (status.type === 'busy') cancelTransientConnectionRetry(sessionID);
      settledIdleSessions.delete(sessionID);
      deps.setSessionStatusEntry(sessionID, status);
      if (status.type === 'busy') {
        deps.clearUsageLimitOnResumedProgress(sessionID, status);
      }
      deps.updateUsageLimitState(sessionID, status);
      if (isSessionInActiveTree(sessionID)) {
        // SAFETY: The surrounding shape or discriminator check establishes the owner type contract used below.
        const statusType = (status as { type: string }).type;
        if (statusType === 'retry' || statusType === 'busy') {
          uiStore.startLoading();
        } else {
          if (isActiveTreeWorking()) uiStore.startLoading();
          else uiStore.stopLoading();
        }
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.idle', (data) => {
      const sid = getEventString(data.properties, 'sessionID');
      if (!sid) return;
      const abortedRetry = deps.hasPendingAbort(sid);
      if (abortedRetry) cancelTransientConnectionRetry(sid);
      if (!transientConnectionRetryTimers.has(sid)) handleSessionIdle(sid, abortedRetry);
    })
  );

  cleanups.push(
    serverEvents.on('session.compacted', (data) => {
      // SAFETY: The surrounding shape or discriminator check establishes the string contract used below.
      const sid = data.properties?.sessionID as string | undefined;
      if (!sid) return;
      sessionStore.setSessionCompacting(sid, false);
      deps
        .syncSession(sid)
        .catch((err) => logWarn('session-event syncSession after session.compacted', err));
      if (isSessionInActiveTree(sid)) {
        deps.syncSessionMessages(sid).catch((err) => deps.logError('syncSessionMessages', err));
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.error', (data) => {
      // SAFETY: The surrounding shape or discriminator check establishes the string contract used below.
      const sessionID = data.properties?.sessionID as string | undefined;
      if (!sessionID) return;
      // SAFETY: The surrounding shape or discriminator check establishes the AssistantMessage contract used below.
      markSessionError(sessionID, data.properties?.error as AssistantMessage['error'] | undefined);
    })
  );

  cleanups.push(
    serverEvents.on('message.updated', (data) => {
      const info = data.properties?.info;
      // SAFETY: The surrounding shape or discriminator check establishes the owner type contract used below.
      const partialMessage = info as
        | {
            id?: unknown;
            sessionID?: string;
            role?: string;
            error?: AssistantMessage['error'];
            time?: { completed?: number };
          }
        | undefined;
      const sessionID = partialMessage?.sessionID;
      if (!isString(sessionID) || !sessionID) return;
      const message = isCompleteMessageInfo(info) ? info : null;
      const assistantMessage = message && isAssistantMessage(message) ? message : null;
      const assistantFinished =
        partialMessage.role === 'assistant' &&
        (!!partialMessage.error || !!partialMessage.time?.completed);
      const assistantCompleted =
        partialMessage.role === 'assistant' &&
        !partialMessage.error &&
        !!partialMessage.time?.completed;
      if (assistantCompleted) cancelTransientConnectionRetry(sessionID);
      // SAFETY: The surrounding shape or discriminator check establishes the owner type contract used below.
      const agent = (partialMessage as { agent?: unknown }).agent;
      if (isString(agent) && agent) {
        appStore.setState('sessionSelectedAgents', sessionID, agent);
      }

      if (assistantFinished && !isSessionInActiveTree(sessionID)) {
        if (assistantCompleted) {
          sessionStore.markSessionResponseCompleted(sessionID, partialMessage.time?.completed);
        }
        deps
          .syncSession(sessionID)
          .catch((err) => logWarn('session-event syncSession after message.updated', err));
      } else if (assistantFinished) {
        deps
          .syncSession(sessionID)
          .catch((err) => logWarn('session-event syncSession after active message.updated', err));
      }

      if (isSessionInActiveTree(sessionID)) {
        if (!assistantFinished) markSessionProgress(sessionID);
        uiStore.markLoadingActivity();
        if (message) {
          recordSessionMessageSnapshotMutation(sessionID);
          if (
            !deps
              .getMessages()
              .some(
                (entry) =>
                  entry.info.id === message.id && entry.info.sessionID === message.sessionID
              )
          ) {
            invalidateMessageLoads(sessionID);
          }
          sessionStore.upsertMessageInfo(message);
        } else {
          scheduleMessageSync(sessionID);
        }
        if (assistantFinished) {
          if (assistantMessage) {
            sessionStore.finishMessageStreaming(assistantMessage.id);
            syncMessagePartsIfMissing(assistantMessage);
            if (assistantCompleted) scheduleMessageSync(sessionID);
            deps.handoffTodosToMessages();
            refreshSettledTodos(sessionID);
          } else {
            const settledMessageId = settlePartialAssistantUpdate(
              sessionID,
              partialMessage,
              assistantMessage
            );
            if (settledMessageId) recordSessionMessageSnapshotMutation(sessionID);
          }
        }
      }
      if (partialMessage?.role === 'assistant') {
        sessionStore.setSessionFailed(
          sessionID,
          !!partialMessage.error && !isAbortedAssistantError(partialMessage.error)
        );
        const notice = parseUsageLimitNotice(
          partialMessage.error?.data?.message || partialMessage.error?.name
        );
        if (notice) {
          deps.applyUsageLimitNotice(sessionID, {
            ...notice,
            source: 'message',
            sessionID,
            providerID: assistantMessage?.providerID,
            modelID: assistantMessage?.modelID,
          });
        } else if (partialMessage.error) {
          sessionStore.setSessionUsageLimit(sessionID, null);
        } else {
          deps.clearUsageLimitOnResumedProgress(sessionID);
        }
      }
    })
  );

  cleanups.push(
    serverEvents.on('message.part.updated', (data) => {
      const seqStatus = observeSequence(data);
      const rawPart = data.properties?.part;
      const partialPart = asRecord(rawPart);
      const partSessionID = isString(partialPart?.sessionID) ? partialPart.sessionID : undefined;
      if (partSessionID && partialPart?.type === 'compaction') {
        sessionStore.setSessionCompacting(partSessionID, false);
      }
      if (!isSessionInActiveTree(partSessionID)) return;

      if (!isCompleteMessagePart(rawPart)) {
        uiStore.startLoading();
        if (seqStatus !== 'gap') scheduleMessageSync(partSessionID!);
        return;
      }

      const applyPart = () => {
        if (!isSessionInActiveTree(rawPart.sessionID)) return;
        recordSessionMessageSnapshotMutation(rawPart.sessionID);
        const part = applyToolExecutionTime(rawPart);
        const staleCompletedMessage = ignoreStaleProgressForCompletedMessage(
          part.sessionID,
          part.messageID
        );
        sessionStore.upsertPart(part);
        if (part.type === 'tool') deps.syncTodosFromMessages();
        if (settleAssistantStepFinishPart(part, getEventTimestamp(data.properties || {}))) {
          handleSessionIdle(part.sessionID, deps.hasPendingAbort(part.sessionID));
          return;
        }
        if (!staleCompletedMessage) {
          uiStore.startLoading();
          if (part.type === 'text') scheduleStreamedCompletionSettle(part.sessionID);
        }
      };

      if (!findMessageById(rawPart.messageID)) {
        if (seqStatus === 'gap') return;
        void deps
          .syncSessionMessages(rawPart.sessionID)
          .then(applyPart)
          .catch((err) => deps.logError('syncSessionMessages', err));
        return;
      }

      applyPart();
    })
  );

  cleanups.push(
    serverEvents.on('message.part.delta', (data) => {
      const seqStatus = observeSequence(data);
      const p = data.properties;
      if (!p) return;
      const sessionID = getEventString(p, 'sessionID');
      const messageID = getEventString(p, 'messageID');
      const partID = getEventString(p, 'partID');
      const delta = getEventString(p, 'delta');
      const field = getEventString(p, 'field');
      if (!sessionID || !messageID || !partID || !delta || !field) return;
      if (!isSessionInActiveTree(sessionID)) return;
      const staleCompletedMessage = ignoreStaleProgressForCompletedMessage(sessionID, messageID);
      if (!staleCompletedMessage) {
        markSessionProgress(sessionID);
        uiStore.markLoadingActivity();
      }
      if (
        pendingMissingPartDeltas.has(getPartDeltaQueueKey(messageID, partID)) ||
        !hasMessagePart(messageID, partID)
      ) {
        if (seqStatus === 'gap') return;
        queueMissingPartDelta(sessionID, messageID, partID);
        return;
      }
      recordSessionMessageSnapshotMutation(sessionID);
      sessionStore.applyMessagePartDelta(messageID, partID, delta, sessionID, field);
    })
  );

  for (const eventName of ACTIVE_SESSION_PROGRESS_EVENTS) {
    cleanups.push(
      serverEvents.on(eventName, (data) => {
        const seqStatus = observeSequence(data);
        const p = data.properties;
        if (!p) return;
        const sessionID = getEventString(p, 'sessionID');
        if (!sessionID) return;
        const toolTimingUpdate = recordToolExecutionTime(eventName, p);
        if (toolTimingUpdate?.ended) {
          updateExistingToolPartExecutionTime(toolTimingUpdate.sessionId, toolTimingUpdate.callId);
        }
        if (
          !eventName.startsWith('session.next.compaction.') &&
          ignoreStaleProgressAfterFinishedAssistant(sessionID)
        ) {
          return;
        }
        const activeTreeEvent = isSessionInActiveTree(sessionID);
        if (eventName === 'session.next.step.ended' && settleAssistantStepEnd(sessionID, p)) {
          if (activeTreeEvent) recordSessionMessageSnapshotMutation(sessionID);
          handleSessionIdle(sessionID, deps.hasPendingAbort(sessionID));
          return;
        }
        markSessionProgress(sessionID);
        if (
          eventName === 'session.next.shell.started' ||
          eventName === 'session.next.tool.called'
        ) {
          schedulePendingPermissionSync();
        }

        if (eventName === 'session.next.agent.switched') {
          const agent = getEventString(p, 'agent');
          if (agent) appStore.setState('sessionSelectedAgents', sessionID, agent);
        }

        if (!activeTreeEvent) return;
        uiStore.markLoadingActivity();
        const projected = PROJECTED_SESSION_EVENTS.has(eventName)
          ? handleProjectedSessionEvent(eventName, p)
          : false;
        if (PROJECTED_SESSION_EVENTS.has(eventName)) {
          if (projected) {
            recordSessionMessageSnapshotMutation(sessionID);
          } else if (seqStatus !== 'gap') {
            scheduleMessageSync(sessionID);
          }
        } else {
          // Synchronized events arrive in durable order, so a contiguous seq means we have
          // not missed anything. Events that create transcript records still need a fetch
          // because Varro does not project those record types directly.
          const transcriptSync = TRANSCRIPT_SYNC_SESSION_EVENTS.has(eventName);
          if (seqStatus !== 'gap' && (transcriptSync || seqStatus !== 'ok')) {
            scheduleMessageSync(sessionID, transcriptSync);
          }
        }
        if (eventName === 'session.next.text.ended') {
          scheduleStreamedCompletionSettle(sessionID);
        }
      })
    );
  }

  cleanups.push(
    serverEvents.on('message.part.removed', (data) => {
      const p = data.properties;
      if (!p) return;
      const sessionID = getEventString(p, 'sessionID');
      const messageID = getEventString(p, 'messageID');
      const partID = getEventString(p, 'partID');
      if (!sessionID || !messageID || !partID || !isSessionInActiveTree(sessionID)) return;
      recordSessionMessageSnapshotMutation(sessionID);
      uiStore.markLoadingActivity();
      sessionStore.removeMessagePart(sessionID, messageID, partID);
      deps.syncTodosFromMessages();
    })
  );

  cleanups.push(
    serverEvents.on('message.removed', (data) => {
      const p = data.properties;
      if (!p) return;
      const sessionId = getEventString(p, 'sessionID');
      const messageId = getEventString(p, 'messageID');
      if (!sessionId || !messageId) return;
      invalidateMessageLoads(sessionId, true);
      if (isSessionInActiveTree(sessionId)) recordSessionMessageSnapshotMutation(sessionId);
      if (deps.isMessageRemovalDeferred?.(sessionId, messageId)) return;
      if (isSessionInActiveTree(sessionId)) {
        uiStore.markLoadingActivity();
        sessionStore.removeMessage(sessionId, messageId);
        deps.syncTodosFromMessages();
        scheduleMessageSync(sessionId, true);
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.next.revert.committed', (data) => {
      // SAFETY: The surrounding shape or discriminator check establishes the string contract used below.
      const sessionId = data.properties?.sessionID as string | undefined;
      if (!sessionId) return;
      invalidateMessageLoads(sessionId, true);
      if (isSessionInActiveTree(sessionId)) scheduleMessageSync(sessionId, true);
    })
  );

  cleanups.push(
    ...registerReasoningEventHandlers({
      getMessages: () => deps.getMessages(),
      syncSessionMessages: async (sessionId) => {
        await deps.syncSessionMessages(sessionId);
      },
      logError: (context, err) => deps.logError(context, err),
      isSessionInActiveTree,
      markSessionProgress,
      ignoreStaleProgressForCompletedMessage,
      ignoreStaleProgressAfterFinishedAssistant,
      recordSessionMessageSnapshotMutation,
    })
  );

  cleanups.push(...registerApprovalEventHandlers(deps));

  cleanups.push(
    serverEvents.on('todo.updated', (data) => {
      const p = data.properties;
      // SAFETY: The surrounding shape or discriminator check establishes the string contract used below.
      if (isSessionInActiveTree(p?.sessionID as string | undefined)) {
        deps.syncTodosFromMessages(undefined, p);
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.diff', (data) => {
      const p = data.properties;
      // SAFETY: The surrounding shape or discriminator check establishes the string contract used below.
      if (isSessionInActiveTree(p?.sessionID as string | undefined)) {
        deps.setDiffs(validateFileDiffs(p?.diff));
      }
    })
  );

  cleanups.push(() => {
    for (const timer of transientConnectionRetryTimers.values()) clearTimeout(timer);
    transientConnectionRetryTimers.clear();
  });
  return cleanups;
}

function parseSessionStatus<T>(value: T): SessionStatus | null {
  if (!value || !isObject(value)) return null;
  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const status = value as UnknownRecord;
  if (status.type === 'idle' || status.type === 'busy') return { type: status.type };
  if (
    status.type !== 'retry' ||
    !isNumber(status.attempt) ||
    !Number.isFinite(status.attempt) ||
    !isNumber(status.next) ||
    !Number.isFinite(status.next) ||
    !isString(status.message)
  ) {
    return null;
  }

  if (status.action === undefined) {
    return {
      type: 'retry',
      attempt: status.attempt,
      message: status.message,
      next: status.next,
    };
  }
  if (!status.action || !isObject(status.action)) return null;
  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const action = status.action as UnknownRecord;
  if (
    !isString(action.reason) ||
    !isString(action.provider) ||
    !isString(action.title) ||
    !isString(action.message) ||
    !isString(action.label) ||
    (action.link !== undefined && !isString(action.link))
  ) {
    return null;
  }
  return {
    type: 'retry',
    attempt: status.attempt,
    message: status.message,
    next: status.next,
    action: {
      reason: action.reason,
      provider: action.provider,
      title: action.title,
      message: action.message,
      label: action.label,
      link: action.link ? action.link : undefined,
    },
  };
}

function getServerEventSessionId(event: ServerEvent): string | undefined {
  const properties = asRecord(event.properties) ?? undefined;
  if (isString(properties?.sessionID) && properties.sessionID) {
    return properties.sessionID;
  }

  const part = asEventRecord(properties?.part);
  if (isString(part?.sessionID) && part.sessionID) return part.sessionID;

  const info = asEventRecord(properties?.info);
  if (isString(info?.sessionID) && info.sessionID) return info.sessionID;
  if (isString(event.type) && event.type.startsWith('session.') && isString(info?.id) && info.id) {
    return info.id;
  }
  return undefined;
}

function asEventRecord<T>(value: T): UnknownRecord | undefined {
  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  return value && isObject(value) ? (value as UnknownRecord) : undefined;
}
