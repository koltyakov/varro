import { serverEvents } from '../lib/client';
import { normalizePermissionEvent } from '../lib/session-event-reducer';
import { isAbortedAssistantError } from '../lib/aborted';
import { isAssistantMessage } from '../lib/message-metrics';
import { parseUsageLimitNotice, type UsageLimitNotice } from '../lib/usage-limit';
import {
  getPermissionModeForSession,
  addPermission,
  applyMessagePartDelta,
  clearStreamingState,
  markLoadingActivity,
  markSessionSeen,
  removeMessagePart,
  removePermission,
  removeQuestion,
  replaceMessages,
  setSessionCompacting,
  setSessionFailed,
  setSessionUsageLimit,
  setState,
  state,
  startLoading,
  stopLoading,
  upsertMessageInfo,
  upsertPart,
  upsertQuestion,
} from '../lib/state';
import type {
  FileDiff,
  Message,
  Part,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from '../types';

function getPermissionReplyId(props: Record<string, unknown>) {
  return (props.id || props.permissionID || props.requestID) as string | undefined;
}

type EventHandlerDependencies = {
  getActiveSessionId(): string | null;
  getMessages(): Array<{ info: Message; parts: Part[] }>;
  setTodoStateAuthority(value: 'messages' | 'event'): void;
  handoffTodosToMessages(messages?: Array<{ info: Message; parts: Part[] }>): boolean;
  setTodos(todos: Todo[]): void;
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
  syncTodosFromMessages(messages?: Array<{ info: Message; parts: Part[] }>): void;
  shouldAutoApprovePermissions(sessionId: string): boolean;
  respondPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ): Promise<void>;
  extractTodos(raw: unknown): Todo[] | null;
  setDiffs(diffs: FileDiff[]): void;
};

type EventHandlerOperationDependencies = {
  setTodoStateAuthority(value: 'messages' | 'event'): void;
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
  extractTodos(raw: unknown): Todo[] | null;
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

export function createSessionEventHandlerOperations(deps: EventHandlerOperationDependencies) {
  const registerHandlers = () => {
    return registerSessionEventHandlers({
      getActiveSessionId: () => state.activeSessionId,
      getMessages: () => state.messages,
      setTodoStateAuthority: deps.setTodoStateAuthority,
      handoffTodosToMessages: deps.todoSyncOperations.handoffTodosToMessages,
      setTodos: (todos) => setState('todos', todos),
      upsertSession: deps.sessionLifecycleOperations.upsertSession,
      setSessionCompacting,
      removeDeletedSessionTree: deps.sessionLifecycleOperations.removeDeletedSessionTree,
      shouldIgnorePendingAbortStatus: deps.sessionStatusOperations.shouldIgnorePendingAbortStatus,
      hasPendingAbort: deps.sessionStatusOperations.hasPendingAbort,
      clearPendingAbort: deps.sessionStatusOperations.clearPendingAbort,
      setSessionStatusEntry: (sessionId, status) =>
        setState('sessionStatus', (current) => ({
          ...current,
          [sessionId]: status,
        })),
      clearUsageLimitOnResumedProgress:
        deps.sessionStatusOperations.clearUsageLimitOnResumedProgress,
      updateUsageLimitState: deps.sessionStatusOperations.updateUsageLimitState,
      syncSession: deps.sessionSyncOperations.syncSession,
      shouldResyncSessionAfterIdle: (sessionId) => state.activeSessionId === sessionId,
      syncSessionMessages: deps.sessionSyncOperations.syncSessionMessages,
      applyUsageLimitNotice: deps.sessionStatusOperations.applyUsageLimitNotice,
      syncTodosFromMessages: deps.todoSyncOperations.syncTodosFromMessages,
      shouldAutoApprovePermissions: (sessionId) =>
        getPermissionModeForSession(sessionId) === 'full',
      respondPermission: deps.sessionApprovalOperations.respondPermission,
      extractTodos: deps.extractTodos,
      setDiffs: (diffs) => setState('diffs', diffs),
    });
  };

  return { registerSessionEventHandlers: registerHandlers };
}

export function registerSessionEventHandlers(deps: EventHandlerDependencies) {
  const cleanups: Array<() => void> = [];

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
        if (statusType === 'busy' || statusType === 'retry') startLoading();
        else stopLoading();
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.idle', (data) => {
      const sid = data.properties?.sessionID as string | undefined;
      const abortedRetry = deps.hasPendingAbort(sid);
      deps.clearPendingAbort(sid);
      if (sid) setSessionCompacting(sid, false);
      if (sid && !abortedRetry) {
        deps.updateUsageLimitState(sid, { type: 'idle' });
      }
      if (!sid || sid === deps.getActiveSessionId()) stopLoading();
      if (sid && sid === deps.getActiveSessionId()) {
        markSessionSeen(sid);
        deps.syncSession(sid).catch(() => {});
        if (deps.shouldResyncSessionAfterIdle(sid)) {
          deps.syncSessionMessages(sid).catch(() => {});
        }
      }
    })
  );

  cleanups.push(
    serverEvents.on('message.updated', (data) => {
      const info = data.properties?.info as { sessionID?: string } | undefined;
      const message = info as Message | undefined;
      if (!message?.sessionID) return;
      if (message.sessionID === deps.getActiveSessionId()) {
        markLoadingActivity();
        upsertMessageInfo(message);
        if (isAssistantMessage(message) && (!!message.error || !!message.time.completed)) {
          deps.handoffTodosToMessages();
        }
      }
      if (isAssistantMessage(message)) {
        setSessionFailed(
          message.sessionID,
          !!message.error && !isAbortedAssistantError(message.error)
        );
        const notice = parseUsageLimitNotice(message.error?.data?.message || message.error?.name);
        if (notice) {
          deps.applyUsageLimitNotice(message.sessionID, {
            ...notice,
            source: 'message',
            sessionID: message.sessionID,
            providerID: message.providerID,
            modelID: message.modelID,
          });
        } else if (message.error) {
          setSessionUsageLimit(message.sessionID, null);
        } else {
          deps.clearUsageLimitOnResumedProgress(message.sessionID);
        }
      }
    })
  );

  cleanups.push(
    serverEvents.on('message.part.updated', (data) => {
      const part = data.properties?.part as { sessionID?: string } | undefined;
      if (part?.sessionID && (part as Part).type === 'compaction') {
        setSessionCompacting(part.sessionID, false);
      }
      if (part?.sessionID === deps.getActiveSessionId()) {
        markLoadingActivity();
        upsertPart(part as Part);
        if ((part as Part).type === 'tool') {
          deps.syncTodosFromMessages();
        }
      }
    })
  );

  cleanups.push(
    serverEvents.on('message.part.delta', (data) => {
      const p = data.properties;
      if (!p) return;
      if ((p.sessionID as string) === deps.getActiveSessionId()) {
        markLoadingActivity();
        applyMessagePartDelta(
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
      if ((p.sessionID as string) === deps.getActiveSessionId()) {
        markLoadingActivity();
      }
      removeMessagePart(p.sessionID as string, p.messageID as string, p.partID as string);
      if ((p.sessionID as string) === deps.getActiveSessionId()) {
        deps.syncTodosFromMessages();
      }
    })
  );

  cleanups.push(
    serverEvents.on('message.removed', (data) => {
      const p = data.properties;
      if (!p) return;
      if ((p.sessionID as string) === deps.getActiveSessionId()) {
        markLoadingActivity();
        clearStreamingState();
        const nextMessages = deps
          .getMessages()
          .filter((m) => m.info.id !== (p.messageID as string));
        replaceMessages(nextMessages);
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
          addPermission(permission);
        });
      return;
    }
    addPermission(permission);
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
      if (pid) removePermission(pid);
    })
  );

  cleanups.push(
    serverEvents.on('question.asked', (data) => {
      const props = data.properties;
      if (props) upsertQuestion(props as QuestionRequest);
    })
  );

  cleanups.push(
    serverEvents.on('question.replied', (data) => {
      const requestID = data.properties?.requestID as string | undefined;
      if (requestID) removeQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('question.rejected', (data) => {
      const requestID = data.properties?.requestID as string | undefined;
      if (requestID) removeQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('todo.updated', (data) => {
      const p = data.properties;
      if ((p?.sessionID as string) === deps.getActiveSessionId()) {
        if (!hasActiveAssistantReply(deps.getMessages())) return;
        const todos = deps.extractTodos(p?.todos);
        if (!todos) return;
        deps.setTodoStateAuthority('event');
        deps.setTodos(todos);
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.diff', (data) => {
      const p = data.properties;
      if ((p?.sessionID as string) === deps.getActiveSessionId()) {
        deps.setDiffs((p?.diff as FileDiff[]) || []);
      }
    })
  );

  return cleanups;
}
