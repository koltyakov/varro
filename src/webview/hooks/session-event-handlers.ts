import { serverEvents } from '../lib/client';
import { normalizePermissionEvent } from '../lib/session-event-reducer';
import { isAbortedAssistantError } from '../lib/aborted';
import { isAssistantMessage } from '../lib/message-metrics';
import type { UsageLimitNotice } from '../lib/usage-limit';
import type {
  FileDiff,
  Message,
  Part,
  Permission,
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
  startLoading(): void;
  stopLoading(): void;
  markSessionSeen(sessionId: string): void;
  syncSession(sessionId: string): Promise<void>;
  shouldResyncSessionAfterIdle(sessionId: string): boolean;
  syncSessionMessages(sessionId: string): Promise<void>;
  markLoadingActivity(): void;
  upsertMessageInfo(message: Message): void;
  setSessionFailed(sessionId: string, failed: boolean): void;
  parseUsageLimitNotice(message: string | undefined): UsageLimitNotice | null;
  applyUsageLimitNotice(
    sessionId: string,
    notice: UsageLimitNotice | null,
    options?: { preserveExistingOnNull?: boolean }
  ): void;
  setSessionUsageLimit(sessionId: string, notice: null): void;
  upsertPart(part: Part): void;
  syncTodosFromMessages(messages?: Array<{ info: Message; parts: Part[] }>): void;
  applyMessagePartDelta(
    messageId: string,
    partId: string,
    delta: string,
    sessionId?: string,
    field?: string
  ): void;
  removeMessagePart(sessionId: string, messageId: string, partId: string): void;
  clearStreamingState(): void;
  replaceMessages(messages: Array<{ info: Message; parts: Part[] }>): void;
  shouldAutoApprovePermissions(sessionId: string): boolean;
  respondPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ): Promise<void>;
  addPermission(permission: Permission): void;
  removePermission(permissionId: string): void;
  upsertQuestion(question: QuestionRequest): void;
  removeQuestion(requestId: string): void;
  extractTodos(raw: unknown): Todo[] | null;
  setDiffs(diffs: FileDiff[]): void;
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
        if (statusType === 'busy' || statusType === 'retry') deps.startLoading();
        else deps.stopLoading();
      }
    })
  );

  cleanups.push(
    serverEvents.on('session.idle', (data) => {
      const sid = data.properties?.sessionID as string | undefined;
      const abortedRetry = deps.hasPendingAbort(sid);
      deps.clearPendingAbort(sid);
      if (sid) deps.setSessionCompacting(sid, false);
      if (sid && !abortedRetry) {
        deps.updateUsageLimitState(sid, { type: 'idle' });
      }
      if (!sid || sid === deps.getActiveSessionId()) deps.stopLoading();
      if (sid && sid === deps.getActiveSessionId()) {
        deps.markSessionSeen(sid);
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
        deps.markLoadingActivity();
        deps.upsertMessageInfo(message);
        if (isAssistantMessage(message) && (!!message.error || !!message.time.completed)) {
          deps.setTodoStateAuthority('messages');
          deps.syncTodosFromMessages();
        }
      }
      if (isAssistantMessage(message)) {
        deps.setSessionFailed(
          message.sessionID,
          !!message.error && !isAbortedAssistantError(message.error)
        );
        const notice = deps.parseUsageLimitNotice(
          message.error?.data?.message || message.error?.name
        );
        if (notice) {
          deps.applyUsageLimitNotice(message.sessionID, {
            ...notice,
            source: 'message',
            sessionID: message.sessionID,
            providerID: message.providerID,
            modelID: message.modelID,
          });
        } else if (message.error) {
          deps.setSessionUsageLimit(message.sessionID, null);
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
        deps.setSessionCompacting(part.sessionID, false);
      }
      if (part?.sessionID === deps.getActiveSessionId()) {
        deps.markLoadingActivity();
        deps.upsertPart(part as Part);
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
        deps.markLoadingActivity();
        deps.applyMessagePartDelta(
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
        deps.markLoadingActivity();
      }
      deps.removeMessagePart(p.sessionID as string, p.messageID as string, p.partID as string);
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
        deps.markLoadingActivity();
        deps.clearStreamingState();
        const nextMessages = deps
          .getMessages()
          .filter((m) => m.info.id !== (p.messageID as string));
        deps.replaceMessages(nextMessages);
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
          deps.addPermission(permission);
        });
      return;
    }
    deps.addPermission(permission);
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
      if (pid) deps.removePermission(pid);
    })
  );

  cleanups.push(
    serverEvents.on('question.asked', (data) => {
      const props = data.properties;
      if (props) deps.upsertQuestion(props as QuestionRequest);
    })
  );

  cleanups.push(
    serverEvents.on('question.replied', (data) => {
      const requestID = data.properties?.requestID as string | undefined;
      if (requestID) deps.removeQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('question.rejected', (data) => {
      const requestID = data.properties?.requestID as string | undefined;
      if (requestID) deps.removeQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('todo.updated', (data) => {
      const p = data.properties;
      if ((p?.sessionID as string) === deps.getActiveSessionId()) {
        if (!hasActiveAssistantReply(deps.getMessages())) return;
        deps.setTodoStateAuthority('event');
        deps.setTodos(deps.extractTodos(p?.todos) || []);
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
