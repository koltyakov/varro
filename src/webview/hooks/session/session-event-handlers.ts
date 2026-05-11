import { isAbortedAssistantError } from '../../lib/aborted';
import { serverEvents } from '../../lib/client';
import { isAssistantMessage } from '../../lib/message-metrics';
import { normalizePermissionEvent } from '../../lib/session-event-reducer';
import { parseUsageLimitNotice, type UsageLimitNotice } from '../../lib/usage-limit';
import { appStore } from '../../lib/stores/app-store';
import { permissionsStore } from '../../lib/stores/permissions-store';
import { sessionStore } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import type {
  AssistantMessage,
  FileDiff,
  Message,
  Part,
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
  shouldAutoApprovePermissions(sessionId: string): boolean;
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
    'handoffTodosToMessages' | 'syncTodosFromMessages'
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
  sessionApprovalOperations: Pick<EventHandlerDependencies, 'respondPermission'>;
  syncPendingPermissions?: EventHandlerDependencies['syncPendingPermissions'];
  abortRemoteSession: EventHandlerDependencies['abortRemoteSession'];
  logError: EventHandlerDependencies['logError'];
};

type NormalizedSessionEventInfo = SessionEventInfo & { id: string };

const ACTIVE_MESSAGE_RESYNC_DELAY_MS = 100;

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
      shouldAutoApprovePermissions: (sessionId) =>
        permissionsStore.getPermissionModeForSession(sessionId) === 'full',
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
  const activeMessageSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let pendingPermissionSyncTimer: ReturnType<typeof setTimeout> | null = null;
  const isSessionInActiveTree = (sessionId: string | null | undefined) => {
    if (!sessionId) return false;
    if (deps.isSessionInActiveTree) return deps.isSessionInActiveTree(sessionId);
    return sessionId === deps.getActiveSessionId();
  };
  const scheduleActiveMessageSync = (
    sessionId: string,
    delayMs = ACTIVE_MESSAGE_RESYNC_DELAY_MS
  ) => {
    if (!isSessionInActiveTree(sessionId) || activeMessageSyncTimers.has(sessionId)) return;

    const timer = setTimeout(() => {
      activeMessageSyncTimers.delete(sessionId);
      deps.syncSessionMessages(sessionId).catch((err) => deps.logError('syncSessionMessages', err));
    }, delayMs);
    activeMessageSyncTimers.set(sessionId, timer);
  };
  const markSessionProgress = (sessionId: string) => {
    deps.setSessionStatusEntry(sessionId, { type: 'busy' });
    deps.clearUsageLimitOnResumedProgress(sessionId, { type: 'busy' });
  };
  const markSessionError = (sessionId: string, error: AssistantMessage['error'] | undefined) => {
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
    if (sessionId === deps.getActiveSessionId()) uiStore.stopLoading();
    deps.syncSession(sessionId).catch(() => {});
    if (isSessionInActiveTree(sessionId)) {
      deps.syncSessionMessages(sessionId).catch((err) => deps.logError('syncSessionMessages', err));
    }
  };
  const schedulePendingPermissionSync = () => {
    if (!deps.syncPendingPermissions || pendingPermissionSyncTimer) return;
    pendingPermissionSyncTimer = setTimeout(() => {
      pendingPermissionSyncTimer = null;
      deps.syncPendingPermissions?.().catch((err) => deps.logError('syncPendingPermissions', err));
    }, ACTIVE_MESSAGE_RESYNC_DELAY_MS);
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
  const ensureReasoningPart = (sessionId: string, reasoningId: string) => {
    const message = latestAssistantMessageForSession(deps.getMessages(), sessionId);
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
    apply: (messageID: string) => void
  ) => {
    const messageID = ensureReasoningPart(sessionId, reasoningId);
    if (messageID) {
      apply(messageID);
      return;
    }
    void deps
      .syncSessionMessages(sessionId)
      .then(() => {
        const syncedMessageID = ensureReasoningPart(sessionId, reasoningId);
        if (syncedMessageID) apply(syncedMessageID);
      })
      .catch((err) => deps.logError('syncSessionMessages', err));
  };
  const syncMessagePartsIfMissing = (message: AssistantMessage) => {
    const localMessage = deps.getMessages().find((entry) => entry.info.id === message.id);
    if (localMessage && localMessage.parts.length > 0) return;

    void deps
      .syncSessionMessages(message.sessionID)
      .catch((err) => deps.logError('syncSessionMessages', err));
  };

  cleanups.push(() => {
    for (const timer of activeMessageSyncTimers.values()) clearTimeout(timer);
    activeMessageSyncTimers.clear();
    if (pendingPermissionSyncTimer) clearTimeout(pendingPermissionSyncTimer);
    pendingPermissionSyncTimer = null;
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
      deps.setSessionStatusEntry(sessionID, status);
      if (status.type === 'busy') {
        deps.clearUsageLimitOnResumedProgress(sessionID, status);
      }
      if (!(abortedRetry && status.type === 'idle')) {
        deps.updateUsageLimitState(sessionID, status);
      }
      if (status.type === 'idle') {
        deps.clearPendingAbort(sessionID);
        deps.syncSession(sessionID).catch(() => {});
      }
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
          uiStore.stopLoading();
        }
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.idle', (data) => {
      const sid = data.properties?.sessionID as string | undefined;
      const abortedRetry = deps.hasPendingAbort(sid);
      deps.clearPendingAbort(sid);
      if (sid) sessionStore.setSessionCompacting(sid, false);
      if (sid) deps.setSessionStatusEntry(sid, { type: 'idle' });
      if (sid && !abortedRetry) {
        deps.updateUsageLimitState(sid, { type: 'idle' });
      }
      if (!sid || sid === deps.getActiveSessionId()) uiStore.stopLoading();
      if (sid) deps.syncSession(sid).catch(() => {});
      if (sid && sid === deps.getActiveSessionId()) {
        const activeMessages = deps.getMessages();
        const shouldResyncActiveMessages =
          activeMessages.length === 0 || hasActiveAssistantReply(activeMessages);
        if (!uiStore.showSessionPicker()) sessionStore.markSessionSeen(sid);
        const handedOffTodos = deps.handoffTodosToMessages();
        if (
          (shouldResyncActiveMessages || !handedOffTodos) &&
          deps.shouldResyncSessionAfterIdle(sid)
        ) {
          deps.syncSessionMessages(sid).catch(() => {});
        }
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
        deps.setSessionStatusEntry(sessionID, { type: 'idle' });
        if (assistantCompleted) {
          sessionStore.markSessionResponseCompleted(sessionID, partialMessage.time?.completed);
        }
        deps.syncSession(sessionID).catch(() => {});
        if (sessionID === deps.getActiveSessionId()) uiStore.stopLoading();
      }

      if (isSessionInActiveTree(sessionID)) {
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
        sessionStore.upsertPart(rawPart);
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
      if (isSessionInActiveTree(sessionID)) {
        const messageID = p.messageID as string;
        const partID = p.partID as string;
        const delta = p.delta as string;
        const field = p.field as string;
        uiStore.markLoadingActivity();
        const hasPart = deps
          .getMessages()
          .some(
            (message) =>
              message.info.id === messageID && message.parts.some((part) => part.id === partID)
          );
        if (!hasPart && sessionID) {
          deps
            .syncSessionMessages(sessionID)
            .then(() =>
              sessionStore.applyMessagePartDelta(messageID, partID, delta, sessionID, field)
            )
            .catch((err) => deps.logError('syncSessionMessages', err));
          return;
        }
        sessionStore.applyMessagePartDelta(messageID, partID, delta, sessionID, field);
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.next.reasoning.started', (data) => {
      const p = data.properties;
      const sessionID = p?.sessionID as string | undefined;
      const reasoningID = getEventString(p, 'reasoningID');
      if (!sessionID) return;
      markSessionProgress(sessionID);
      if (!reasoningID || !isSessionInActiveTree(sessionID)) return;
      uiStore.markLoadingActivity();
      withReasoningMessage(sessionID, reasoningID, () => {});
    })
  );

  for (const eventName of ACTIVE_SESSION_PROGRESS_EVENTS) {
    cleanups.push(
      serverEvents.on(eventName, (data) => {
        const p = data.properties;
        const sessionID = p?.sessionID as string | undefined;
        if (!sessionID) return;
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
        scheduleActiveMessageSync(sessionID);
      })
    );
  }

  cleanups.push(
    serverEvents.on('session.next.reasoning.delta', (data) => {
      const p = data.properties;
      const sessionID = p?.sessionID as string | undefined;
      const reasoningID = getEventString(p, 'reasoningID');
      const delta = getEventString(p, 'delta') || getEventString(p, 'text');
      if (!sessionID) return;
      markSessionProgress(sessionID);
      if (!reasoningID || !delta || !isSessionInActiveTree(sessionID)) return;
      uiStore.markLoadingActivity();
      withReasoningMessage(sessionID, reasoningID, (messageID) => {
        sessionStore.applyMessagePartDelta(messageID, reasoningID, delta, sessionID, 'text');
      });
    })
  );

  cleanups.push(
    serverEvents.on('session.next.reasoning.ended', (data) => {
      const p = data.properties;
      const sessionID = p?.sessionID as string | undefined;
      const reasoningID = getEventString(p, 'reasoningID');
      if (!sessionID) return;
      markSessionProgress(sessionID);
      if (!reasoningID || !isSessionInActiveTree(sessionID)) return;
      uiStore.markLoadingActivity();
      const text = getEventString(p, 'text');
      withReasoningMessage(sessionID, reasoningID, (messageID) => {
        if (!text) return;
        sessionStore.upsertPart({
          id: reasoningID,
          sessionID,
          messageID,
          type: 'reasoning',
          text,
        } as Part);
      });
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
    serverEvents.on('permission.replied', (data) => {
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
        deps.setDiffs((p?.diff as FileDiff[]) || []);
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
