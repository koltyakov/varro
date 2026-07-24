import { isAbortedAssistantError } from '../../../shared/error-classification';
import { serverEvents } from '../../lib/client';
import {
  hasUnsettledToolPart,
  isAssistantMessage,
  latestAssistantFinishedBeforeLoading,
} from '../../lib/message-metrics';
import { isRunningSessionStatus } from '../../lib/session-event-reducer';
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

type EventHandlerDependencies = {
  getActiveSessionId(): string | null;
  getSessionStatus(sessionId: string): SessionStatus | null | undefined;
  isSessionTreeStatusWorking(sessionId: string): boolean;
  isSessionInActiveTree?(sessionId: string): boolean;
  getMessages(): MessageEntry[];
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
  syncSession(sessionId: string): Promise<void>;
  repairSessionTitle?(sessionId: string): Promise<void>;
  shouldResyncSessionAfterIdle(sessionId: string): boolean;
  syncSessionMessages(sessionId: string): Promise<void>;
  recheckSessionStatus?(sessionId: string): Promise<void>;
  applyUsageLimitNotice(
    sessionId: string,
    notice: UsageLimitNotice | null,
    options?: { preserveExistingOnNull?: boolean }
  ): void;
  syncTodosFromMessages(messages?: MessageEntry[], latestEventPayload?: unknown): void;
  syncTodosForSession?(sessionId: string, messages?: MessageEntry[]): Promise<void>;
  shouldAutoApprovePermissions(sessionId: string): boolean;
  shouldAutoJudgePermissions?(sessionId: string): boolean;
  judgePermission?(permission: Permission): Promise<void>;
  syncPendingPermissions?(): Promise<void>;
  reconcileServerState?(): Promise<void>;
  respondPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ): Promise<void>;
  setDiffs(diffs: FileDiff[]): void;
  abortRemoteSession(sessionId: string): Promise<unknown>;
  logError(context: string, err: unknown): void;
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
  >;
  sessionSyncOperations: Pick<EventHandlerDependencies, 'syncSession' | 'syncSessionMessages'>;
  repairSessionTitle?: EventHandlerDependencies['repairSessionTitle'];
  sessionApprovalOperations: Pick<
    EventHandlerDependencies,
    'respondPermission' | 'judgePermission'
  >;
  syncPendingPermissions?: EventHandlerDependencies['syncPendingPermissions'];
  reconcileServerState?: EventHandlerDependencies['reconcileServerState'];
  abortRemoteSession: EventHandlerDependencies['abortRemoteSession'];
  logError: EventHandlerDependencies['logError'];
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
      handoffTodosToMessages: this.deps.todoSyncOperations.handoffTodosToMessages,
      upsertSession: this.deps.sessionLifecycleOperations.upsertSession,
      setSessionCompacting: sessionStore.setSessionCompacting,
      removeDeletedSessionTree: this.deps.sessionLifecycleOperations.removeDeletedSessionTree,
      shouldIgnorePendingAbortStatus:
        this.deps.sessionStatusOperations.shouldIgnorePendingAbortStatus,
      hasPendingAbort: this.deps.sessionStatusOperations.hasPendingAbort,
      markPendingAbort: this.deps.sessionStatusOperations.markPendingAbort,
      clearPendingAbort: this.deps.sessionStatusOperations.clearPendingAbort,
      setSessionStatusEntry: sessionStore.setSessionStatusEntry,
      clearUsageLimitOnResumedProgress:
        this.deps.sessionStatusOperations.clearUsageLimitOnResumedProgress,
      updateUsageLimitState: this.deps.sessionStatusOperations.updateUsageLimitState,
      syncSession: this.deps.sessionSyncOperations.syncSession,
      repairSessionTitle: this.deps.repairSessionTitle,
      shouldResyncSessionAfterIdle: (sessionId) => appStore.state.activeSessionId === sessionId,
      syncSessionMessages: this.deps.sessionSyncOperations.syncSessionMessages,
      recheckSessionStatus: this.deps.sessionStatusOperations.recheckSessionStatus,
      applyUsageLimitNotice: this.deps.sessionStatusOperations.applyUsageLimitNotice,
      syncTodosFromMessages: this.deps.todoSyncOperations.syncTodosFromMessages,
      syncTodosForSession: this.deps.todoSyncOperations.syncTodosForSession,
      shouldAutoApprovePermissions: (sessionId) =>
        permissionsStore.getPermissionModeForSession(sessionId) === 'full',
      shouldAutoJudgePermissions: (sessionId) =>
        permissionsStore.getPermissionModeForSession(sessionId) === 'auto',
      judgePermission: this.deps.sessionApprovalOperations.judgePermission,
      syncPendingPermissions: this.deps.syncPendingPermissions,
      reconcileServerState: this.deps.reconcileServerState,
      respondPermission: this.deps.sessionApprovalOperations.respondPermission,
      setDiffs: sessionStore.setDiffs,
      abortRemoteSession: this.deps.abortRemoteSession,
      logError: this.deps.logError,
    });
  };
}

export function registerSessionEventHandlers(deps: EventHandlerDependencies) {
  const cleanups: Array<() => void> = [];
  const activeMessageSyncs = new Set<string>();
  const pendingMissingPartDeltas = new Map<
    string,
    {
      sessionID: string;
      generation: number;
      syncing: boolean;
      retryTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  const toolExecutionTimes = new Map<string, ToolExecutionTime>();
  // Per-session debounce timers for the optimistic streamed-completion settle.
  const streamedCompletionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingTerminalStepSettles = new Map<string, number>();
  // Per-session durable sequence cursor, advanced by synchronized events (ephemeral
  // `*.delta` fragments carry no `seq`). Lets us resync only when a durable event was
  // actually missed, instead of defensively on every progress event.
  const lastSeqBySession = new Map<string, number>();
  let pendingPermissionSync = false;
  let serverReconciliation: Promise<void> | null = null;
  // Returns 'unknown' when the event carries no seq (e.g. an ephemeral delta — caller
  // keeps its default behavior), 'ok' when the event is in order or a duplicate, or 'gap'
  // when at least one durable event was skipped (a targeted resync is warranted).
  const noteSeq = (
    sessionId: string | null | undefined,
    seq: number | undefined
  ): 'unknown' | 'ok' | 'gap' => {
    if (!sessionId || typeof seq !== 'number') return 'unknown';
    const last = lastSeqBySession.get(sessionId);
    if (last === undefined) {
      lastSeqBySession.set(sessionId, seq);
      return 'ok';
    }
    if (seq <= last) return 'ok';
    lastSeqBySession.set(sessionId, seq);
    return seq === last + 1 ? 'ok' : 'gap';
  };
  const isSessionInActiveTree = (sessionId: string | null | undefined) => {
    if (!sessionId) return false;
    if (deps.isSessionInActiveTree) return deps.isSessionInActiveTree(sessionId);
    return sessionId === deps.getActiveSessionId();
  };
  const isActiveTreeWorking = () => {
    const activeSessionId = deps.getActiveSessionId();
    return activeSessionId ? deps.isSessionTreeStatusWorking(activeSessionId) : false;
  };
  const isStaleProgressAfterFinishedAssistant = (sessionId: string) =>
    isSessionInActiveTree(sessionId) &&
    latestAssistantFinishedBeforeLoading(deps.getMessages(), uiStore.loadingStartedAt());
  const scheduleActiveMessageSync = (sessionId: string) => {
    if (!isSessionInActiveTree(sessionId) || activeMessageSyncs.has(sessionId)) return;

    activeMessageSyncs.add(sessionId);
    void deps
      .syncSessionMessages(sessionId)
      .then(() => {
        const completedAt = pendingTerminalStepSettles.get(sessionId);
        if (completedAt === undefined) return;
        pendingTerminalStepSettles.delete(sessionId);
        if (!settleLatestAssistantOnIdle(sessionId, completedAt)) return;
        handleSessionIdle(sessionId, deps.hasPendingAbort(sessionId));
      })
      .catch((err) => deps.logError('syncSessionMessages', err))
      .finally(() => {
        activeMessageSyncs.delete(sessionId);
      });
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
    const message = deps.getMessages().find((entry) => entry.info.id === messageId)?.info;
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
    const hadActiveAssistantReply = hasActiveAssistantReply(deps.getMessages());
    settleLatestAssistantOnIdle(sessionId, Date.now());
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
    deps.syncSession(sessionId).catch(() => {});
    deps.repairSessionTitle?.(sessionId).catch((err) => deps.logError('repairSessionTitle', err));
    if (sessionId === deps.getActiveSessionId()) {
      const activeMessages = deps.getMessages();
      const shouldResyncActiveMessages =
        activeMessages.length === 0 ||
        hadActiveAssistantReply ||
        hasActiveAssistantReply(activeMessages);
      if (!uiStore.showSessionPicker()) sessionStore.markSessionSeen(sessionId);
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
    }
  };
  const recordToolExecutionTime = (eventName: string, props: Record<string, unknown>) => {
    const sessionId = typeof props.sessionID === 'string' ? props.sessionID : null;
    const callId = typeof props.callID === 'string' ? props.callID : null;
    if (!sessionId || !callId) return null;

    const key = getToolExecutionKey(sessionId, callId);
    const existing = toolExecutionTimes.get(key) || {};
    const timestamp = getEventTimestamp(props);
    if (eventName === 'session.next.tool.called' || eventName === 'session.next.shell.started') {
      toolExecutionTimes.set(key, { ...existing, start: timestamp });
      return { sessionId, callId, ended: false };
    }
    if (
      eventName === 'session.next.tool.success' ||
      eventName === 'session.next.tool.failed' ||
      eventName === 'session.next.shell.ended'
    ) {
      toolExecutionTimes.set(key, { ...existing, end: timestamp });
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
    deps.syncSession(sessionId).catch(() => {});
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
    return (
      deps
        .getMessages()
        .find(
          (entry) =>
            entry.info.id === assistantMessageID &&
            entry.info.sessionID === sessionId &&
            entry.info.role === 'assistant'
        ) || null
    );
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
      if (isSessionInActiveTree(sessionId)) scheduleActiveMessageSync(sessionId);
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
    if (nextInfo) sessionStore.upsertMessageInfo(nextInfo as Message);
    sessionStore.finishMessageStreaming(assistantInfo.id);
    if (isSessionInActiveTree(sessionId)) scheduleActiveMessageSync(sessionId);
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

    const local = deps.getMessages().find((entry) => entry.info.id === messageId);
    if (local?.info.role === 'assistant') {
      const completed = partialMessage.time?.completed;
      sessionStore.upsertMessageInfo({
        ...local.info,
        ...(partialMessage.error ? { error: partialMessage.error } : {}),
        time: {
          ...local.info.time,
          ...(completed !== undefined ? { completed } : {}),
        },
      });
    }

    sessionStore.finishMessageStreaming(messageId);
    return messageId;
  };
  const settleAssistantStepEnd = (sessionId: string, props: Record<string, unknown>) => {
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
    scheduleActiveMessageSync,
    syncTodosFromMessages: () => deps.syncTodosFromMessages(),
  });

  const syncMessagePartsIfMissing = (message: AssistantMessage) => {
    const localMessage = deps.getMessages().find((entry) => entry.info.id === message.id);
    if (localMessage && localMessage.parts.length > 0) return;

    scheduleActiveMessageSync(message.sessionID);
  };
  const hasMessagePart = (messageID: string, partID: string) =>
    deps
      .getMessages()
      .some(
        (message) =>
          message.info.id === messageID && message.parts.some((part) => part.id === partID)
      );
  const recoverMissingPartDeltas = (
    key: string,
    pending: {
      sessionID: string;
      generation: number;
      syncing: boolean;
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

        // A delta arrived after the follow-up read its snapshot. Yield before
        // another bounded pass so sustained traffic cannot create a tight loop.
        pending.retryTimer = setTimeout(() => {
          pending.retryTimer = undefined;
          if (pendingMissingPartDeltas.get(key) !== pending) return;
          pending.syncing = false;
          recoverMissingPartDeltas(key, pending);
        }, 0);
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
    const pending = existing || { sessionID, generation: 0, syncing: false };
    pending.sessionID = sessionID;
    pending.generation += 1;
    pendingMissingPartDeltas.set(key, pending);
    recoverMissingPartDeltas(key, pending);
  };

  cleanups.push(() => {
    activeMessageSyncs.clear();
    pendingTerminalStepSettles.clear();
    for (const pending of pendingMissingPartDeltas.values()) {
      if (pending.retryTimer !== undefined) clearTimeout(pending.retryTimer);
    }
    pendingMissingPartDeltas.clear();
    lastSeqBySession.clear();
    for (const timer of streamedCompletionTimers.values()) clearTimeout(timer);
    streamedCompletionTimers.clear();
    pendingPermissionSync = false;
    serverReconciliation = null;
  });

  cleanups.push(
    serverEvents.on('server.connected', () => {
      if (!deps.reconcileServerState || serverReconciliation) return;
      serverReconciliation = deps
        .reconcileServerState()
        .catch((err) => deps.logError('reconcileServerState', err))
        .finally(() => {
          serverReconciliation = null;
        });
    })
  );

  cleanups.push(
    serverEvents.on('session.created', (data) => {
      const info = normalizeSessionEventInfo(
        data.properties?.info as SessionEventInfo | undefined,
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
        data.properties?.info as SessionEventInfo | undefined,
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
      const id = (data.properties?.info as { id: string } | undefined)?.id;
      if (id) deps.removeDeletedSessionTree(id);
    })
  );

  cleanups.push(
    serverEvents.on('session.status', (data) => {
      const props = data.properties;
      if (!props) return;
      const sessionID = props.sessionID as string;
      const status = props.status as SessionStatus;
      if (deps.shouldIgnorePendingAbortStatus(sessionID, status)) return;
      const abortedRetry = deps.hasPendingAbort(sessionID);
      if (status.type === 'idle') {
        handleSessionIdle(sessionID, abortedRetry);
        return;
      }
      // opencode can emit a trailing `busy` after a turn already settled. Only
      // suppress it once canonical status says this session is no longer working;
      // a completed assistant step may still be followed by another tool/model step.
      if (
        status.type === 'busy' &&
        sessionID === deps.getActiveSessionId() &&
        latestAssistantFinishedBeforeLoading(deps.getMessages(), uiStore.loadingStartedAt()) &&
        !isRunningSessionStatus(deps.getSessionStatus(sessionID))
      ) {
        deps.setSessionStatusEntry(sessionID, { type: 'idle' });
        if (!isActiveTreeWorking()) uiStore.stopLoading();
        return;
      }
      deps.setSessionStatusEntry(sessionID, status);
      if (status.type === 'busy') {
        deps.clearUsageLimitOnResumedProgress(sessionID, status);
      }
      deps.updateUsageLimitState(sessionID, status);
      if (isSessionInActiveTree(sessionID)) {
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
      const sid = data.properties?.sessionID as string | undefined;
      if (sid) handleSessionIdle(sid, deps.hasPendingAbort(sid));
    })
  );

  cleanups.push(
    serverEvents.on('session.compacted', (data) => {
      const sid = data.properties?.sessionID as string | undefined;
      if (!sid) return;
      sessionStore.setSessionCompacting(sid, false);
      deps.syncSession(sid).catch(() => {});
      if (isSessionInActiveTree(sid)) {
        deps.syncSessionMessages(sid).catch((err) => deps.logError('syncSessionMessages', err));
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.error', (data) => {
      const sessionID = data.properties?.sessionID as string | undefined;
      if (!sessionID) return;
      markSessionError(sessionID, data.properties?.error as AssistantMessage['error'] | undefined);
    })
  );

  cleanups.push(
    serverEvents.on('message.updated', (data) => {
      const info = data.properties?.info;
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
      if (!sessionID) return;
      const message = isCompleteMessageInfo(info) ? info : null;
      const assistantMessage = message && isAssistantMessage(message) ? message : null;
      const assistantFinished =
        partialMessage.role === 'assistant' &&
        (!!partialMessage.error || !!partialMessage.time?.completed);
      const assistantCompleted =
        partialMessage.role === 'assistant' &&
        !partialMessage.error &&
        !!partialMessage.time?.completed;
      const agent = (partialMessage as { agent?: unknown }).agent;
      if (typeof agent === 'string' && agent) {
        appStore.setState('sessionSelectedAgents', sessionID, agent);
      }

      if (assistantFinished && !isSessionInActiveTree(sessionID)) {
        deps.setSessionStatusEntry(sessionID, { type: 'idle' });
        if (assistantCompleted) {
          sessionStore.markSessionResponseCompleted(sessionID, partialMessage.time?.completed);
        }
        deps.syncSession(sessionID).catch(() => {});
      } else if (assistantFinished) {
        deps.syncSession(sessionID).catch(() => {});
      }

      if (isSessionInActiveTree(sessionID)) {
        if (!assistantFinished) markSessionProgress(sessionID);
        uiStore.markLoadingActivity();
        if (message) {
          sessionStore.upsertMessageInfo(message);
        } else {
          scheduleActiveMessageSync(sessionID);
        }
        if (assistantFinished) {
          if (assistantMessage) {
            sessionStore.finishMessageStreaming(assistantMessage.id);
            syncMessagePartsIfMissing(assistantMessage);
            if (assistantCompleted) scheduleActiveMessageSync(sessionID);
            deps.handoffTodosToMessages();
            refreshSettledTodos(sessionID);
          } else {
            settlePartialAssistantUpdate(sessionID, partialMessage, assistantMessage);
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
      const rawPart = data.properties?.part;
      const partialPart = rawPart as { sessionID?: string; type?: string } | undefined;
      noteSeq(partialPart?.sessionID, data.seq);
      if (partialPart?.sessionID && partialPart.type === 'compaction') {
        sessionStore.setSessionCompacting(partialPart.sessionID, false);
      }
      if (!isSessionInActiveTree(partialPart?.sessionID)) return;

      if (!isCompleteMessagePart(rawPart)) {
        uiStore.startLoading();
        scheduleActiveMessageSync(partialPart!.sessionID!);
        return;
      }

      const applyPart = () => {
        if (!isSessionInActiveTree(rawPart.sessionID)) return;
        const part = applyToolExecutionTime(rawPart);
        sessionStore.upsertPart(part);
        if (part.type === 'tool') deps.syncTodosFromMessages();
        if (settleAssistantStepFinishPart(part, getEventTimestamp(data.properties || {}))) {
          handleSessionIdle(part.sessionID, deps.hasPendingAbort(part.sessionID));
          return;
        }
        uiStore.startLoading();
        if (part.type === 'text') scheduleStreamedCompletionSettle(part.sessionID);
      };

      if (!deps.getMessages().some((message) => message.info.id === rawPart.messageID)) {
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
      const p = data.properties;
      if (!p) return;
      const sessionID = p.sessionID as string | undefined;
      noteSeq(sessionID, data.seq);
      if (!sessionID || !isSessionInActiveTree(sessionID)) return;

      const messageID = p.messageID as string;
      const partID = p.partID as string;
      const delta = p.delta as string;
      const field = p.field as string;
      const staleCompletedMessage = ignoreStaleProgressForCompletedMessage(sessionID, messageID);
      if (!staleCompletedMessage) {
        markSessionProgress(sessionID);
        uiStore.markLoadingActivity();
      }
      if (
        pendingMissingPartDeltas.has(getPartDeltaQueueKey(messageID, partID)) ||
        !hasMessagePart(messageID, partID)
      ) {
        queueMissingPartDelta(sessionID, messageID, partID);
        return;
      }
      sessionStore.applyMessagePartDelta(messageID, partID, delta, sessionID, field);
    })
  );

  for (const eventName of ACTIVE_SESSION_PROGRESS_EVENTS) {
    cleanups.push(
      serverEvents.on(eventName, (data) => {
        const p = data.properties;
        if (!p) return;
        const sessionID = p.sessionID as string | undefined;
        if (!sessionID) return;
        const seqStatus = noteSeq(sessionID, data.seq);
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
        if (eventName === 'session.next.step.ended' && settleAssistantStepEnd(sessionID, p)) {
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

        if (!isSessionInActiveTree(sessionID)) return;
        uiStore.markLoadingActivity();
        const projected = PROJECTED_SESSION_EVENTS.has(eventName)
          ? handleProjectedSessionEvent(eventName, p)
          : false;
        if (PROJECTED_SESSION_EVENTS.has(eventName)) {
          if (!projected || seqStatus === 'gap') scheduleActiveMessageSync(sessionID);
        } else {
          // Synchronized events arrive in durable order, so a contiguous seq means we have
          // not missed anything and can skip the refetch. We still resync when a gap proves
          // a durable event was missed, or when the event carries no seq (ephemeral delta).
          if (seqStatus !== 'ok') scheduleActiveMessageSync(sessionID);
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
      if (!isSessionInActiveTree(p.sessionID as string | undefined)) return;
      uiStore.markLoadingActivity();
      sessionStore.removeMessagePart(
        p.sessionID as string,
        p.messageID as string,
        p.partID as string
      );
      deps.syncTodosFromMessages();
    })
  );

  cleanups.push(
    serverEvents.on('message.removed', (data) => {
      const p = data.properties;
      if (!p) return;
      if (isSessionInActiveTree(p.sessionID as string | undefined)) {
        uiStore.markLoadingActivity();
        sessionStore.clearStreamingState();
        const nextMessages = deps
          .getMessages()
          .filter((m) => m.info.id !== (p.messageID as string));
        sessionStore.replaceMessages(nextMessages);
        deps.syncTodosFromMessages(nextMessages);
      }
    })
  );

  cleanups.push(
    ...registerReasoningEventHandlers({
      getMessages: () => deps.getMessages(),
      syncSessionMessages: (sessionId) => deps.syncSessionMessages(sessionId),
      logError: (context, err) => deps.logError(context, err),
      isSessionInActiveTree,
      markSessionProgress,
      ignoreStaleProgressForCompletedMessage,
      ignoreStaleProgressAfterFinishedAssistant,
    })
  );

  cleanups.push(...registerApprovalEventHandlers(deps));

  cleanups.push(
    serverEvents.on('todo.updated', (data) => {
      const p = data.properties;
      if (isSessionInActiveTree(p?.sessionID as string | undefined)) {
        deps.syncTodosFromMessages(undefined, p);
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.diff', (data) => {
      const p = data.properties;
      if (isSessionInActiveTree(p?.sessionID as string | undefined)) {
        deps.setDiffs(validateFileDiffs(p?.diff));
      }
    })
  );

  return cleanups;
}
