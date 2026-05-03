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
  return (props.id || props.permissionID || props.requestID) as string | undefined;
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
  respondPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ): Promise<void>;
  setDiffs(diffs: FileDiff[]): void;
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
    | 'clearPendingAbort'
    | 'clearUsageLimitOnResumedProgress'
    | 'updateUsageLimitState'
    | 'applyUsageLimitNotice'
  >;
  sessionSyncOperations: Pick<EventHandlerDependencies, 'syncSession' | 'syncSessionMessages'>;
  sessionApprovalOperations: Pick<EventHandlerDependencies, 'respondPermission'>;
};

function hasActiveAssistantReply(messages: Array<{ info: Message; parts: Part[] }>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]?.info;
    if (!message) continue;
    if (message.role === 'user') return false;
    return !message.error && !message.time.completed;
  }

  return false;
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
      respondPermission: this.deps.sessionApprovalOperations.respondPermission,
      setDiffs: sessionStore.setDiffs,
    });
  };
}

export function registerSessionEventHandlers(deps: EventHandlerDependencies) {
  const cleanups: Array<() => void> = [];
  const isSessionInActiveTree = (sessionId: string | null | undefined) => {
    if (!sessionId) return false;
    if (deps.isSessionInActiveTree) return deps.isSessionInActiveTree(sessionId);
    return sessionId === deps.getActiveSessionId();
  };

  cleanups.push(
    serverEvents.on('session.created', (data) => {
      const info = data.properties?.info as Session | undefined;
      if (info) deps.upsertSession(info);
    })
  );

  cleanups.push(
    serverEvents.on('session.updated', (data) => {
      const info = data.properties?.info as Session | undefined;
      if (info) {
        if (!info.time.compacting) deps.setSessionCompacting(info.id, false);
        deps.upsertSession(info);
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
      }
      if (sessionID === deps.getActiveSessionId()) {
        const statusType = (status as { type: string }).type;
        if (statusType === 'busy' || statusType === 'retry') uiStore.startLoading();
        else uiStore.stopLoading();
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
      if (sid && sid === deps.getActiveSessionId()) {
        const shouldResyncActiveMessages = hasActiveAssistantReply(deps.getMessages());
        sessionStore.markSessionSeen(sid);
        deps.syncSession(sid).catch(() => {});
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
    serverEvents.on('message.updated', (data) => {
      const info = data.properties?.info;
      const partialMessage = info as
        | { sessionID?: string; role?: string; error?: AssistantMessage['error'] }
        | undefined;
      const sessionID = partialMessage?.sessionID;
      if (!sessionID) return;
      const message = isCompleteMessageInfo(info) ? info : null;
      const assistantMessage = message && isAssistantMessage(message) ? message : null;

      if (isSessionInActiveTree(sessionID)) {
        uiStore.markLoadingActivity();
        if (message) {
          sessionStore.upsertMessageInfo(message);
        }
        if (assistantMessage && (!!assistantMessage.error || !!assistantMessage.time.completed)) {
          deps.handoffTodosToMessages();
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
      if (isSessionInActiveTree(partialPart?.sessionID)) {
        uiStore.markLoadingActivity();
        if (!isCompleteMessagePart(rawPart)) return;
        sessionStore.upsertPart(rawPart);
        if (rawPart.type === 'tool') {
          deps.syncTodosFromMessages();
        }
      }
    })
  );

  cleanups.push(
    serverEvents.on('message.part.delta', (data) => {
      const p = data.properties;
      if (!p) return;
      if (isSessionInActiveTree(p.sessionID as string | undefined)) {
        uiStore.markLoadingActivity();
        sessionStore.applyMessagePartDelta(
          p.messageID as string,
          p.partID as string,
          p.delta as string,
          p.sessionID as string,
          p.field as string
        );
      }
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
        if (!hasActiveAssistantReply(deps.getMessages())) return;
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
