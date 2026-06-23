import { isAbortedAssistantError } from '../../lib/aborted';
import { serverEvents } from '../../lib/client';
import { isAssistantMessage } from '../../lib/message-metrics';
import { normalizePermissionEvent } from '../../lib/session-event-reducer';
import { parseUsageLimitNotice, type UsageLimitNotice } from '../../lib/usage-limit';
import { validateFileDiffs } from '../../lib/validate-diffs';
import { appStore } from '../../lib/stores/app-store';
import { permissionsStore } from '../../lib/stores/permissions-store';
import { sessionStore } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import type {
  AssistantMessage,
  FileDiff,
  Message,
  Part,
  Permission,
  QuestionRequest,
  Session,
  SessionEventInfo,
  SessionStatus,
} from '../../types';

function isCompleteMessageInfo(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.sessionID !== 'string' ||
    !record.sessionID ||
    typeof record.role !== 'string' ||
    !record.time ||
    typeof record.time !== 'object' ||
    typeof (record.time as { created?: unknown }).created !== 'number'
  ) {
    return false;
  }

  if (record.role === 'user') {
    return !!(
      record.parentID === undefined &&
      typeof record.agent === 'string' &&
      record.model &&
      typeof record.model === 'object' &&
      typeof (record.model as { providerID?: unknown }).providerID === 'string' &&
      typeof (record.model as { modelID?: unknown }).modelID === 'string'
    );
  }

  if (record.role === 'assistant') {
    return !!(
      typeof record.parentID === 'string' &&
      typeof record.modelID === 'string' &&
      typeof record.providerID === 'string' &&
      typeof record.mode === 'string' &&
      record.path &&
      typeof record.path === 'object' &&
      typeof (record.path as { cwd?: unknown }).cwd === 'string' &&
      typeof (record.path as { root?: unknown }).root === 'string' &&
      typeof record.cost === 'number' &&
      record.tokens &&
      typeof record.tokens === 'object' &&
      typeof (record.tokens as { input?: unknown }).input === 'number' &&
      typeof (record.tokens as { output?: unknown }).output === 'number' &&
      typeof (record.tokens as { reasoning?: unknown }).reasoning === 'number' &&
      (record.tokens as { cache?: unknown }).cache &&
      typeof (record.tokens as { cache?: unknown }).cache === 'object' &&
      typeof ((record.tokens as { cache?: unknown }).cache as { read?: unknown }).read ===
        'number' &&
      typeof ((record.tokens as { cache?: unknown }).cache as { write?: unknown }).write ===
        'number'
    );
  }

  return false;
}

function isCompleteMessagePart(value: unknown): value is Part {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    !!record.id &&
    typeof record.sessionID === 'string' &&
    !!record.sessionID &&
    typeof record.messageID === 'string' &&
    !!record.messageID &&
    typeof record.type === 'string' &&
    !!record.type
  );
}

function isWorkingStatus(status: SessionStatus | null | undefined) {
  return status?.type === 'busy' || status?.type === 'retry';
}

function isContinuationStepEnd(eventName: string, props: Record<string, unknown>) {
  if (eventName !== 'session.next.step.ended') return false;
  const finish = normalizeStepFinish(getEventString(props, 'finish'));
  return (
    finish === 'tool' ||
    finish === 'tools' ||
    finish === 'tool_call' ||
    finish === 'tool_calls' ||
    finish === 'tool_use' ||
    finish === 'tool_uses' ||
    finish === 'function_call' ||
    finish === 'function_calls'
  );
}

function normalizeStepFinish(value: string | undefined) {
  return value?.toLowerCase().replace(/[\s-]+/g, '_');
}

function hasUnsettledToolPart(parts: Part[]) {
  return parts.some(
    (part) =>
      part.type === 'tool' && (part.state.status === 'pending' || part.state.status === 'running')
  );
}

function getPartDeltaQueueKey(messageID: string, partID: string) {
  return `${messageID}\u0000${partID}`;
}

const getToolExecutionKey = (sessionId: string, callId: string) => `${sessionId}\u0000${callId}`;

const getEventTimestamp = (props: Record<string, unknown>) => {
  const timestamp = props.timestamp;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now();
};

function getPermissionReplyId(props: Record<string, unknown>) {
  const source =
    props.info && typeof props.info === 'object' ? (props.info as Record<string, unknown>) : props;
  return (source.id || source.permissionID || source.requestID) as string | undefined;
}

type EventHandlerDependencies = {
  getActiveSessionId(): string | null;
  isSessionInActiveTree?(sessionId: string): boolean;
  getMessages(): Array<{ info: Message; parts: Part[] }>;
  handoffTodosToMessages(messages?: Array<{ info: Message; parts: Part[] }>): boolean;
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
  shouldResyncSessionAfterIdle(sessionId: string): boolean;
  syncSessionMessages(sessionId: string): Promise<void>;
  applyUsageLimitNotice(
    sessionId: string,
    notice: UsageLimitNotice | null,
    options?: { preserveExistingOnNull?: boolean }
  ): void;
  syncTodosFromMessages(
    messages?: Array<{ info: Message; parts: Part[] }>,
    latestEventPayload?: unknown
  ): void;
  syncTodosForSession?(
    sessionId: string,
    messages?: Array<{ info: Message; parts: Part[] }>
  ): Promise<void>;
  shouldAutoApprovePermissions(sessionId: string): boolean;
  shouldAutoJudgePermissions?(sessionId: string): boolean;
  judgePermission?(permission: Permission): Promise<void>;
  syncPendingPermissions?(): Promise<void>;
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
  >;
  sessionSyncOperations: Pick<EventHandlerDependencies, 'syncSession' | 'syncSessionMessages'>;
  sessionApprovalOperations: Pick<
    EventHandlerDependencies,
    'respondPermission' | 'judgePermission'
  >;
  syncPendingPermissions?: EventHandlerDependencies['syncPendingPermissions'];
  abortRemoteSession: EventHandlerDependencies['abortRemoteSession'];
  logError: EventHandlerDependencies['logError'];
};

type NormalizedSessionEventInfo = SessionEventInfo & { id: string };

const ACTIVE_SESSION_PROGRESS_EVENTS = [
  'session.next.agent.switched',
  'session.next.model.switched',
  'session.next.prompted',
  'session.next.synthetic',
  'session.next.shell.started',
  'session.next.shell.ended',
  'session.next.step.started',
  'session.next.step.ended',
  'session.next.step.failed',
  'session.next.text.started',
  'session.next.text.delta',
  'session.next.text.ended',
  'session.next.tool.input.started',
  'session.next.tool.input.delta',
  'session.next.tool.input.ended',
  'session.next.tool.called',
  'session.next.tool.progress',
  'session.next.tool.success',
  'session.next.tool.failed',
  'session.next.retried',
  'session.next.compaction.started',
  'session.next.compaction.delta',
  'session.next.compaction.ended',
] as const;

const ACTIVE_TEXT_PROGRESS_EVENTS = new Set<string>([
  'session.next.text.started',
  'session.next.text.delta',
  'session.next.text.ended',
]);

const PROJECTED_SESSION_EVENTS = new Set<string>([
  ...ACTIVE_TEXT_PROGRESS_EVENTS,
  'session.next.tool.input.started',
  'session.next.tool.input.delta',
  'session.next.tool.input.ended',
  'session.next.tool.called',
  'session.next.tool.progress',
  'session.next.tool.success',
  'session.next.tool.failed',
  'session.next.reasoning.started',
  'session.next.reasoning.delta',
  'session.next.reasoning.ended',
]);

type ToolExecutionTime = { start?: number; end?: number };

function hasActiveAssistantReply(messages: Array<{ info: Message; parts: Part[] }>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]?.info;
    if (!message) continue;
    if (message.role === 'user') return false;
    return !message.error && !message.time.completed;
  }

  return false;
}

function latestAssistantFinishedBeforeLoading(
  messages: Array<{ info: Message; parts: Part[] }>,
  loadingStartedAt: number | null
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]?.info;
    if (!message) continue;
    if (message.role !== 'assistant') return false;
    const finishedAt = message.time.completed ?? (message.error ? message.time.created : null);
    if (finishedAt === null) return false;
    return loadingStartedAt === null || loadingStartedAt <= finishedAt;
  }

  return false;
}

function latestAssistantMessageForSession(
  messages: Array<{ info: Message; parts: Part[] }>,
  sessionId: string
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.info.sessionID !== sessionId || message.info.role !== 'assistant') {
      continue;
    }
    if (!message.info.error && !message.info.time.completed) return message;
  }
  return null;
}

function getAssistantFinishedMessageId(
  messages: Array<{ info: Message; parts: Part[] }>,
  partialMessage: { sessionID?: string; id?: unknown },
  assistantMessage: AssistantMessage | null
) {
  if (assistantMessage) return assistantMessage.id;
  if (typeof partialMessage.id === 'string' && partialMessage.id) return partialMessage.id;
  if (!partialMessage.sessionID) return null;
  return latestAssistantMessageForSession(messages, partialMessage.sessionID)?.info.id ?? null;
}

function normalizeSessionEventInfo(
  info: SessionEventInfo | undefined,
  sessionID?: string
): NormalizedSessionEventInfo | null {
  if (!info) return null;
  const normalized = stripNullishSessionInfo(info);
  const id = typeof normalized.id === 'string' && normalized.id ? normalized.id : sessionID;
  return id ? { ...normalized, id } : null;
}

function stripNullishSessionInfo(info: SessionEventInfo): SessionEventInfo {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info)) {
    if (value === null || value === undefined) continue;
    if (key === 'time' && value && typeof value === 'object') {
      const time = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          ([, timeValue]) => timeValue !== null && timeValue !== undefined
        )
      );
      if (Object.keys(time).length > 0) normalized.time = time;
      continue;
    }
    normalized[key] = value;
  }
  return normalized as SessionEventInfo;
}

function mergeSessionEventInfo(info: NormalizedSessionEventInfo): Session | null {
  const existing = appStore.state.sessions.find((session) => session.id === info.id);
  if (existing) {
    return {
      ...existing,
      ...info,
      time: { ...existing.time, ...info.time },
    };
  }

  if (
    typeof info.projectID === 'string' &&
    typeof info.directory === 'string' &&
    typeof info.title === 'string' &&
    typeof info.version === 'string' &&
    typeof info.time?.created === 'number' &&
    typeof info.time.updated === 'number'
  ) {
    return info as Session;
  }

  return null;
}

function syncSessionAgent(info: NormalizedSessionEventInfo) {
  const agent = (info as { agent?: unknown }).agent;
  if (typeof agent === 'string' && agent) {
    appStore.setState('sessionSelectedAgents', info.id, agent);
  }
}

export class SessionEventHandlerOperations {
  constructor(private readonly deps: EventHandlerOperationDependencies) {}

  readonly registerSessionEventHandlers = () => {
    return registerSessionEventHandlers({
      getActiveSessionId: () => appStore.state.activeSessionId,
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
      shouldResyncSessionAfterIdle: (sessionId) => appStore.state.activeSessionId === sessionId,
      syncSessionMessages: this.deps.sessionSyncOperations.syncSessionMessages,
      applyUsageLimitNotice: this.deps.sessionStatusOperations.applyUsageLimitNotice,
      syncTodosFromMessages: this.deps.todoSyncOperations.syncTodosFromMessages,
      syncTodosForSession: this.deps.todoSyncOperations.syncTodosForSession,
      shouldAutoApprovePermissions: (sessionId) =>
        permissionsStore.getPermissionModeForSession(sessionId) === 'full',
      shouldAutoJudgePermissions: (sessionId) =>
        permissionsStore.getPermissionModeForSession(sessionId) === 'auto',
      judgePermission: this.deps.sessionApprovalOperations.judgePermission,
      syncPendingPermissions: this.deps.syncPendingPermissions,
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
  const workingSessionIds = new Set<string>();
  const autoJudgingPermissionIds = new Set<string>();
  const pendingMissingPartDeltas = new Map<
    string,
    {
      sessionID: string;
      deltas: Array<{ messageID: string; partID: string; delta: string; field: string }>;
      syncing: boolean;
    }
  >();
  const toolExecutionTimes = new Map<string, ToolExecutionTime>();
  // Per-session durable sequence cursor, advanced by synchronized events (ephemeral
  // `*.delta` fragments carry no `seq`). Lets us resync only when a durable event was
  // actually missed, instead of defensively on every progress event.
  const lastSeqBySession = new Map<string, number>();
  let pendingPermissionSync = false;
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
  const setSessionStatusEntry = (sessionId: string, status: SessionStatus) => {
    if (isWorkingStatus(status)) workingSessionIds.add(sessionId);
    else workingSessionIds.delete(sessionId);
    deps.setSessionStatusEntry(sessionId, status);
  };
  const isSessionInActiveTree = (sessionId: string | null | undefined) => {
    if (!sessionId) return false;
    if (deps.isSessionInActiveTree) return deps.isSessionInActiveTree(sessionId);
    return sessionId === deps.getActiveSessionId();
  };
  const isActiveTreeWorking = () =>
    [...workingSessionIds].some((sessionId) => isSessionInActiveTree(sessionId));
  const isStaleProgressAfterFinishedAssistant = (sessionId: string) =>
    isSessionInActiveTree(sessionId) &&
    latestAssistantFinishedBeforeLoading(deps.getMessages(), uiStore.loadingStartedAt());
  const scheduleActiveMessageSync = (sessionId: string) => {
    if (!isSessionInActiveTree(sessionId) || activeMessageSyncs.has(sessionId)) return;

    activeMessageSyncs.add(sessionId);
    void deps
      .syncSessionMessages(sessionId)
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
    if (sessionId === deps.getActiveSessionId() && !isActiveTreeWorking()) {
      uiStore.stopLoading();
    }
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
    if (sessionId === deps.getActiveSessionId() && !isActiveTreeWorking()) {
      uiStore.stopLoading();
    }
    return true;
  };
  const markSessionProgress = (sessionId: string) => {
    setSessionStatusEntry(sessionId, { type: 'busy' });
    deps.clearUsageLimitOnResumedProgress(sessionId, { type: 'busy' });
  };
  const handleSessionIdle = (sessionId: string, abortedRetry: boolean) => {
    deps.clearPendingAbort(sessionId);
    sessionStore.setSessionCompacting(sessionId, false);
    setSessionStatusEntry(sessionId, { type: 'idle' });
    if (!abortedRetry) deps.updateUsageLimitState(sessionId, { type: 'idle' });
    if (sessionId === deps.getActiveSessionId()) {
      if (isActiveTreeWorking()) uiStore.startLoading();
      else uiStore.stopLoading();
    } else if (isSessionInActiveTree(sessionId) && !isActiveTreeWorking()) {
      uiStore.stopLoading();
    }
    deps.syncSession(sessionId).catch(() => {});
    if (sessionId === deps.getActiveSessionId()) {
      const activeMessages = deps.getMessages();
      const shouldResyncActiveMessages =
        activeMessages.length === 0 || hasActiveAssistantReply(activeMessages);
      if (!uiStore.showSessionPicker()) sessionStore.markSessionSeen(sessionId);
      const handedOffTodos = deps.handoffTodosToMessages();
      refreshSettledTodos(sessionId);
      if (
        (shouldResyncActiveMessages || !handedOffTodos) &&
        deps.shouldResyncSessionAfterIdle(sessionId)
      ) {
        deps.syncSessionMessages(sessionId).catch(() => {});
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
    setSessionStatusEntry(sessionId, { type: 'idle' });
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
    if (isSessionInActiveTree(sessionId)) {
      deps.syncSessionMessages(sessionId).catch((err) => deps.logError('syncSessionMessages', err));
    }
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
    setSessionStatusEntry(info.id, { type: 'idle' });
    if (alreadyPending) return;

    void deps.abortRemoteSession(info.id).catch((err) => {
      deps.clearPendingAbort(info.id);
      deps.logError('abortSession', err);
    });
  };
  // v2 reasoning events carry the owning assistantMessageID. When that message is loaded
  // we attach directly to it; otherwise we fall back to the "latest active assistant"
  // heuristic, preserving the pre-v2 behavior for older servers / not-yet-synced messages.
  const findReasoningMessage = (sessionId: string, assistantMessageID?: string) => {
    if (assistantMessageID) {
      const named = deps
        .getMessages()
        .find(
          (entry) =>
            entry.info.id === assistantMessageID &&
            entry.info.sessionID === sessionId &&
            entry.info.role === 'assistant'
        );
      if (named) return named;
    }
    return latestAssistantMessageForSession(deps.getMessages(), sessionId);
  };
  const ensureReasoningPart = (
    sessionId: string,
    reasoningId: string,
    assistantMessageID?: string
  ) => {
    const message = findReasoningMessage(sessionId, assistantMessageID);
    if (!message) return null;
    if (!message.parts.some((part) => part.id === reasoningId)) {
      sessionStore.upsertPart({
        id: reasoningId,
        sessionID: sessionId,
        messageID: message.info.id,
        type: 'reasoning',
        text: '',
      } as Part);
    }
    return message.info.id;
  };
  const withReasoningMessage = (
    sessionId: string,
    reasoningId: string,
    apply: (messageID: string) => void,
    assistantMessageID?: string
  ) => {
    const messageID = ensureReasoningPart(sessionId, reasoningId, assistantMessageID);
    if (messageID) {
      apply(messageID);
      return;
    }
    void deps
      .syncSessionMessages(sessionId)
      .then(() => {
        const syncedMessageID = ensureReasoningPart(sessionId, reasoningId, assistantMessageID);
        if (syncedMessageID) apply(syncedMessageID);
      })
      .catch((err) => deps.logError('syncSessionMessages', err));
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
  const findStepAssistantMessage = (sessionId: string, assistantMessageID?: string) => {
    if (assistantMessageID) return findAssistantMessage(sessionId, assistantMessageID);
    return latestAssistantMessageForSession(deps.getMessages(), sessionId);
  };
  const settleAssistantStepEnd = (sessionId: string, props: Record<string, unknown>) => {
    if (isContinuationStepEnd('session.next.step.ended', props)) return false;
    const assistantMessageID = getEventString(props, 'assistantMessageID');
    const message = findStepAssistantMessage(sessionId, assistantMessageID);
    if (!message) {
      if (isSessionInActiveTree(sessionId)) scheduleActiveMessageSync(sessionId);
      return false;
    }
    if (message.info.role !== 'assistant') return false;
    if (hasUnsettledToolPart(message.parts)) return false;
    if (!message.info.time.completed && !message.info.error) {
      sessionStore.upsertMessageInfo({
        ...message.info,
        time: { ...message.info.time, completed: getEventTimestamp(props) },
      } as Message);
    }
    sessionStore.finishMessageStreaming(message.info.id);
    return true;
  };
  const findPart = (messageID: string, partID: string): Part | null => {
    const message = deps.getMessages().find((entry) => entry.info.id === messageID);
    return message?.parts.find((part) => part.id === partID) || null;
  };
  const applyProjectedPart = (
    sessionId: string,
    assistantMessageID: string | undefined,
    part: Part
  ) => {
    const message = findAssistantMessage(sessionId, assistantMessageID);
    if (!message) {
      scheduleActiveMessageSync(sessionId);
      return false;
    }
    sessionStore.upsertPart(part);
    return true;
  };
  const ensureProjectedTextPart = (
    sessionId: string,
    assistantMessageID: string | undefined,
    partID: string,
    text = ''
  ) => {
    const message = findAssistantMessage(sessionId, assistantMessageID);
    if (!message) {
      scheduleActiveMessageSync(sessionId);
      return null;
    }
    const existing = message.parts.find((part) => part.id === partID);
    if (!existing) {
      sessionStore.upsertPart({
        id: partID,
        sessionID: sessionId,
        messageID: message.info.id,
        type: 'text',
        text,
      } as Part);
    }
    return message.info.id;
  };
  const handleProjectedTextEvent = (
    eventName: string,
    props: Record<string, unknown>,
    sessionId: string
  ) => {
    const textID = getEventString(props, 'textID');
    const assistantMessageID = getEventString(props, 'assistantMessageID');
    if (!textID) return false;
    const text = getEventString(props, 'text') || '';
    if (eventName === 'session.next.text.ended') {
      return !!applyProjectedPart(sessionId, assistantMessageID, {
        id: textID,
        sessionID: sessionId,
        messageID: assistantMessageID || '',
        type: 'text',
        text,
      } as Part);
    }
    const messageID = ensureProjectedTextPart(sessionId, assistantMessageID, textID);
    if (!messageID) return false;
    if (eventName === 'session.next.text.delta') {
      const delta = getEventString(props, 'delta') || text;
      if (delta) sessionStore.applyMessagePartDelta(messageID, textID, delta, sessionId, 'text');
    }
    return true;
  };
  const handleProjectedToolEvent = (
    eventName: string,
    props: Record<string, unknown>,
    sessionId: string
  ) => {
    const assistantMessageID = getEventString(props, 'assistantMessageID');
    const callID = getEventString(props, 'callID');
    if (!assistantMessageID || !callID) return false;
    const message = findAssistantMessage(sessionId, assistantMessageID);
    if (!message) {
      scheduleActiveMessageSync(sessionId);
      return false;
    }
    const existing = findPart(assistantMessageID, callID);
    const existingTool = existing?.type === 'tool' ? existing : null;
    const timestamp = getEventTimestamp(props);
    const toolName =
      getEventString(props, 'name') || getEventString(props, 'tool') || existingTool?.tool || '';
    const inputText = getEventString(props, 'text') || getEventString(props, 'input') || '';

    if (eventName === 'session.next.tool.input.delta') {
      const delta = getEventString(props, 'delta') || inputText;
      if (!delta || !existingTool || existingTool.state.status !== 'pending') return true;
      sessionStore.upsertPart({
        ...existingTool,
        state: { ...existingTool.state, raw: `${existingTool.state.raw || ''}${delta}` },
      });
      return true;
    }

    if (eventName === 'session.next.tool.input.started') {
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID: assistantMessageID,
        type: 'tool',
        callID,
        tool: toolName,
        state: { status: 'pending', input: {}, raw: '' },
      });
      return true;
    }

    if (eventName === 'session.next.tool.input.ended') {
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID: assistantMessageID,
        type: 'tool',
        callID,
        tool: toolName,
        state: { status: 'pending', input: parseToolInput(inputText), raw: inputText },
      });
      return true;
    }

    if (eventName === 'session.next.tool.called') {
      const input = asToolInput(props.input);
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID: assistantMessageID,
        type: 'tool',
        callID,
        tool: toolName,
        state: {
          status: 'running',
          input,
          title: toolName,
          metadata: asToolMetadata(props.provider),
          time: { start: timestamp },
        },
      });
      return true;
    }

    if (eventName === 'session.next.tool.progress') {
      if (!existingTool || existingTool.state.status !== 'running') return true;
      sessionStore.upsertPart({
        ...existingTool,
        state: {
          ...existingTool.state,
          metadata: {
            ...existingTool.state.metadata,
            structured: asToolMetadata(props.structured),
            content: props.content,
          },
        },
      });
      return true;
    }

    if (eventName === 'session.next.tool.success') {
      const input = existingTool ? getToolStateInput(existingTool) : {};
      const start = existingTool ? getToolStartTime(existingTool) : timestamp;
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID: assistantMessageID,
        type: 'tool',
        callID,
        tool: toolName,
        state: {
          status: 'completed',
          input,
          output: toolOutputToString(props.content, props.structured),
          title: toolName,
          metadata: {
            ...asToolMetadata(props.structured),
            provider: props.provider,
            result: props.result,
          },
          time: { start, end: timestamp },
        },
      });
      deps.syncTodosFromMessages();
      return true;
    }

    if (eventName === 'session.next.tool.failed') {
      const input = existingTool ? getToolStateInput(existingTool) : {};
      const start = existingTool ? getToolStartTime(existingTool) : timestamp;
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID: assistantMessageID,
        type: 'tool',
        callID,
        tool: toolName,
        state: {
          status: 'error',
          input,
          error: getToolErrorMessage(props.error),
          metadata: { provider: props.provider, result: props.result },
          time: { start, end: timestamp },
        },
      });
      deps.syncTodosFromMessages();
      return true;
    }

    return false;
  };
  const handleProjectedSessionEvent = (eventName: string, props: Record<string, unknown>) => {
    const sessionId = props.sessionID as string | undefined;
    if (!sessionId || !isSessionInActiveTree(sessionId)) return false;
    if (eventName.startsWith('session.next.text.')) {
      return handleProjectedTextEvent(eventName, props, sessionId);
    }
    if (eventName.startsWith('session.next.tool.')) {
      return handleProjectedToolEvent(eventName, props, sessionId);
    }
    return false;
  };
  const syncMessagePartsIfMissing = (message: AssistantMessage) => {
    const localMessage = deps.getMessages().find((entry) => entry.info.id === message.id);
    if (localMessage && localMessage.parts.length > 0) return;

    void deps
      .syncSessionMessages(message.sessionID)
      .catch((err) => deps.logError('syncSessionMessages', err));
  };
  const hasMessagePart = (messageID: string, partID: string) =>
    deps
      .getMessages()
      .some(
        (message) =>
          message.info.id === messageID && message.parts.some((part) => part.id === partID)
      );
  const queueMissingPartDelta = (
    sessionID: string,
    messageID: string,
    partID: string,
    delta: string,
    field: string
  ) => {
    const key = getPartDeltaQueueKey(messageID, partID);
    const existing = pendingMissingPartDeltas.get(key);
    const pending = existing || { sessionID, deltas: [], syncing: false };
    pending.sessionID = sessionID;
    pending.deltas.push({ messageID, partID, delta, field });
    pendingMissingPartDeltas.set(key, pending);

    if (pending.syncing) return;

    pending.syncing = true;
    void deps
      .syncSessionMessages(sessionID)
      .then(() => {
        const queued = pendingMissingPartDeltas.get(key);
        if (!queued) return;
        pendingMissingPartDeltas.delete(key);
        for (const item of queued.deltas) {
          sessionStore.applyMessagePartDelta(
            item.messageID,
            item.partID,
            item.delta,
            queued.sessionID,
            item.field
          );
        }
      })
      .catch((err) => {
        pendingMissingPartDeltas.delete(key);
        deps.logError('syncSessionMessages', err);
      });
  };

  cleanups.push(() => {
    activeMessageSyncs.clear();
    pendingMissingPartDeltas.clear();
    lastSeqBySession.clear();
    pendingPermissionSync = false;
  });

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
      setSessionStatusEntry(sessionID, status);
      if (status.type === 'busy') {
        deps.clearUsageLimitOnResumedProgress(sessionID, status);
      }
      deps.updateUsageLimitState(sessionID, status);
      if (sessionID === deps.getActiveSessionId()) {
        const statusType = (status as { type: string }).type;
        if (statusType === 'retry') {
          uiStore.startLoading();
        } else if (statusType === 'busy') {
          if (
            latestAssistantFinishedBeforeLoading(deps.getMessages(), uiStore.loadingStartedAt())
          ) {
            uiStore.stopLoading();
          } else uiStore.startLoading();
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

      if (assistantFinished) {
        setSessionStatusEntry(sessionID, { type: 'idle' });
        if (assistantCompleted) {
          sessionStore.markSessionResponseCompleted(sessionID, partialMessage.time?.completed);
        }
        deps.syncSession(sessionID).catch(() => {});
        if (sessionID === deps.getActiveSessionId() && !isActiveTreeWorking())
          uiStore.stopLoading();
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
          const messageId = getAssistantFinishedMessageId(
            deps.getMessages(),
            partialMessage,
            assistantMessage
          );
          if (messageId) sessionStore.finishMessageStreaming(messageId);
          if (assistantMessage) {
            syncMessagePartsIfMissing(assistantMessage);
            deps.handoffTodosToMessages();
            refreshSettledTodos(sessionID);
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

      uiStore.markLoadingActivity();
      if (!isCompleteMessagePart(rawPart)) {
        scheduleActiveMessageSync(partialPart!.sessionID!);
        return;
      }

      const applyPart = () => {
        if (!isSessionInActiveTree(rawPart.sessionID)) return;
        sessionStore.upsertPart(applyToolExecutionTime(rawPart));
        if (rawPart.type === 'tool') deps.syncTodosFromMessages();
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
        queueMissingPartDelta(sessionID, messageID, partID, delta, field);
        return;
      }
      sessionStore.applyMessagePartDelta(messageID, partID, delta, sessionID, field);
    })
  );

  cleanups.push(
    serverEvents.on('session.next.reasoning.started', (data) => {
      const p = data.properties;
      const sessionID = p?.sessionID as string | undefined;
      const reasoningID = getEventString(p, 'reasoningID');
      const assistantMessageID = getEventString(p, 'assistantMessageID');
      if (!sessionID) return;
      if (
        assistantMessageID &&
        ignoreStaleProgressForCompletedMessage(sessionID, assistantMessageID)
      ) {
        return;
      }
      if (!assistantMessageID && ignoreStaleProgressAfterFinishedAssistant(sessionID)) return;
      markSessionProgress(sessionID);
      if (!reasoningID || !isSessionInActiveTree(sessionID)) return;
      uiStore.markLoadingActivity();
      withReasoningMessage(sessionID, reasoningID, () => {}, assistantMessageID);
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
        if (sessionID === deps.getActiveSessionId()) uiStore.startLoading();
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
      })
    );
  }

  cleanups.push(
    serverEvents.on('session.next.reasoning.delta', (data) => {
      const p = data.properties;
      const sessionID = p?.sessionID as string | undefined;
      const reasoningID = getEventString(p, 'reasoningID');
      const assistantMessageID = getEventString(p, 'assistantMessageID');
      const delta = getEventString(p, 'delta') || getEventString(p, 'text');
      if (!sessionID) return;
      if (
        assistantMessageID &&
        ignoreStaleProgressForCompletedMessage(sessionID, assistantMessageID)
      ) {
        return;
      }
      if (!assistantMessageID && ignoreStaleProgressAfterFinishedAssistant(sessionID)) return;
      markSessionProgress(sessionID);
      if (!reasoningID || !delta || !isSessionInActiveTree(sessionID)) return;
      uiStore.markLoadingActivity();
      withReasoningMessage(
        sessionID,
        reasoningID,
        (messageID) => {
          sessionStore.applyMessagePartDelta(messageID, reasoningID, delta, sessionID, 'text');
        },
        assistantMessageID
      );
    })
  );

  cleanups.push(
    serverEvents.on('session.next.reasoning.ended', (data) => {
      const p = data.properties;
      const sessionID = p?.sessionID as string | undefined;
      const reasoningID = getEventString(p, 'reasoningID');
      const assistantMessageID = getEventString(p, 'assistantMessageID');
      if (!sessionID) return;
      if (
        assistantMessageID &&
        ignoreStaleProgressForCompletedMessage(sessionID, assistantMessageID)
      ) {
        return;
      }
      if (!assistantMessageID && ignoreStaleProgressAfterFinishedAssistant(sessionID)) return;
      markSessionProgress(sessionID);
      if (!reasoningID || !isSessionInActiveTree(sessionID)) return;
      uiStore.markLoadingActivity();
      const text = getEventString(p, 'text');
      withReasoningMessage(
        sessionID,
        reasoningID,
        (messageID) => {
          if (!text) return;
          sessionStore.upsertPart({
            id: reasoningID,
            sessionID,
            messageID,
            type: 'reasoning',
            text,
          } as Part);
        },
        assistantMessageID
      );
    })
  );

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

  function handlePermissionEvent(props: Record<string, unknown>) {
    const permission = normalizePermissionEvent(props);
    if (!permission) return;
    if (deps.shouldAutoApprovePermissions(permission.sessionID)) {
      void deps
        .respondPermission(permission.sessionID, permission.id, 'always', { rethrow: true })
        .catch(() => {
          permissionsStore.addPermission(permission);
        });
      return;
    }
    if (deps.shouldAutoJudgePermissions?.(permission.sessionID) && deps.judgePermission) {
      if (autoJudgingPermissionIds.has(permission.id)) return;
      autoJudgingPermissionIds.add(permission.id);
      void deps
        .judgePermission(permission)
        .catch((err) => {
          deps.logError('autoApproveJudge', err);
          permissionsStore.addPermission(permission);
        })
        .finally(() => {
          autoJudgingPermissionIds.delete(permission.id);
        });
      return;
    }
    permissionsStore.addPermission(permission);
  }

  cleanups.push(
    serverEvents.on('permission.updated', (data) => {
      const props = data.properties;
      if (props) handlePermissionEvent(props);
    })
  );

  cleanups.push(
    serverEvents.on('permission.asked', (data) => {
      const props = data.properties;
      if (props) handlePermissionEvent(props);
    })
  );

  cleanups.push(
    serverEvents.on('permission.v2.asked', (data) => {
      const props = data.properties;
      if (props) handlePermissionEvent(props);
    })
  );

  cleanups.push(
    serverEvents.on('permission.replied', (data) => {
      const props = data.properties;
      if (!props) return;
      const pid = getPermissionReplyId(props);
      if (pid) permissionsStore.removePermission(pid);
    })
  );

  cleanups.push(
    serverEvents.on('permission.v2.replied', (data) => {
      const props = data.properties;
      if (!props) return;
      const pid = getPermissionReplyId(props);
      if (pid) permissionsStore.removePermission(pid);
    })
  );

  cleanups.push(
    serverEvents.on('question.asked', (data) => {
      const props = data.properties;
      if (props) permissionsStore.upsertQuestion(props as QuestionRequest);
    })
  );

  cleanups.push(
    serverEvents.on('question.v2.asked', (data) => {
      const props = data.properties;
      if (props) permissionsStore.upsertQuestion(props as QuestionRequest);
    })
  );

  cleanups.push(
    serverEvents.on('question.replied', (data) => {
      const requestID = data.properties?.requestID as string | undefined;
      if (requestID) permissionsStore.removeQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('question.rejected', (data) => {
      const requestID = data.properties?.requestID as string | undefined;
      if (requestID) permissionsStore.removeQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('question.v2.replied', (data) => {
      const requestID = data.properties?.requestID as string | undefined;
      if (requestID) permissionsStore.removeQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('question.v2.rejected', (data) => {
      const requestID = data.properties?.requestID as string | undefined;
      if (requestID) permissionsStore.removeQuestion(requestID);
    })
  );

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

function getEventString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'string' ? item : undefined;
}

function parseToolInput(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return asToolInput(parsed);
  } catch {
    return {};
  }
}

function asToolInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asToolMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getToolStateInput(part: Part): Record<string, unknown> {
  if (part.type !== 'tool') return {};
  const input = part.state.input;
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function getToolStartTime(part: Part): number {
  if (part.type !== 'tool') return Date.now();
  const time = (part.state as { time?: { start?: unknown } }).time;
  return typeof time?.start === 'number' ? time.start : Date.now();
}

function getToolErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return 'Tool execution failed';
}

function toolOutputToString(content: unknown, structured: unknown): string {
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const record = item as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') return record.text;
        if (record.type === 'file' && typeof record.uri === 'string') return record.uri;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  if (structured && typeof structured === 'object') {
    try {
      return JSON.stringify(structured, null, 2);
    } catch {
      return String(structured);
    }
  }
  return '';
}
