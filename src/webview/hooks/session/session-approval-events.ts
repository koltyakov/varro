import { serverEvents } from '../../lib/client';
import { normalizePermissionEvent } from '../../lib/session-event-reducer';
import { permissionsStore } from '../../lib/stores/permissions-store';
import type { Permission, QuestionRequest } from '../../types';
import { getPermissionReplyId, getQuestionReplyId } from './session-event-utils';

type ApprovalEventDependencies = {
  shouldAutoApprovePermissions(sessionId: string): boolean;
  shouldAutoJudgePermissions?(sessionId: string): boolean;
  judgePermission?(permission: Permission): Promise<void>;
  respondPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ): Promise<void>;
  logError(context: string, err: unknown): void;
};

export function registerApprovalEventHandlers(deps: ApprovalEventDependencies): Array<() => void> {
  const autoJudgingPermissionIds = new Set<string>();
  const cleanups: Array<() => void> = [];

  function handlePermissionEvent(props: Record<string, unknown>) {
    const permission = normalizePermissionEvent(props);
    if (!permission) return;
    if (deps.shouldAutoApprovePermissions(permission.sessionID)) {
      void deps
        .respondPermission(permission.sessionID, permission.id, 'always', { rethrow: true })
        .catch(() => {
          if (!deps.shouldAutoApprovePermissions(permission.sessionID)) {
            permissionsStore.addPermission(permission);
          }
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
      const requestID = getQuestionReplyId(data.properties);
      if (requestID) permissionsStore.removeQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('question.rejected', (data) => {
      const requestID = getQuestionReplyId(data.properties);
      if (requestID) permissionsStore.removeQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('question.v2.replied', (data) => {
      const requestID = getQuestionReplyId(data.properties);
      if (requestID) permissionsStore.removeQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('question.v2.rejected', (data) => {
      const requestID = getQuestionReplyId(data.properties);
      if (requestID) permissionsStore.removeQuestion(requestID);
    })
  );

  return cleanups;
}
