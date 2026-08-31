import { serverEvents } from '../../lib/client';
import { normalizePermissionEvent } from '../../lib/session-event-reducer';
import { permissionsStore } from '../../lib/stores/permissions-store';
import type { Permission, QuestionRequest } from '../../types';
import { getPermissionReplyId, getQuestionReplyId } from './session-event-utils';
import type { UnknownRecord } from '../../../shared/type-utils';

type ApprovalEventDependencies = {
  shouldAutoApprovePermissions(sessionId: string): boolean;
  shouldAutoApproveEdit?(permission: Permission): boolean;
  shouldAutoJudgePermissions?(sessionId: string): boolean;
  isPermissionSessionKnown?(sessionId: string): boolean;
  syncPermissionSession?(sessionId: string): Promise<void | boolean | object>;
  judgePermission?(permission: Permission): Promise<void | boolean | object>;
  permissionReplied?(permissionId: string): void;
  permissionVisible?(permissionId: string): void;
  respondPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ): Promise<void | boolean | object>;
  respondAutomaticPermission?(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    options?: { rethrow?: boolean }
  ): Promise<void | boolean | object>;
  logError(context: string, cause: unknown): void;
};

export function registerApprovalEventHandlers(deps: ApprovalEventDependencies): Array<() => void> {
  const autoJudgingPermissionIds = new Set<string>();
  const pendingSessionPermissions = new Map<string, Permission>();
  const cleanups: Array<() => void> = [];
  let disposed = false;

  function handleKnownPermission(permission: Permission) {
    if (permission.recoveredIncomplete) {
      permissionsStore.addPermission(permission);
      deps.permissionVisible?.(permission.id);
      return;
    }
    if (deps.shouldAutoApprovePermissions(permission.sessionID)) {
      const respond = deps.respondAutomaticPermission ?? deps.respondPermission;
      void respond(permission.sessionID, permission.id, 'always', { rethrow: true }).catch(() => {
        if (!deps.shouldAutoApprovePermissions(permission.sessionID)) {
          permissionsStore.addPermission(permission);
          deps.permissionVisible?.(permission.id);
        }
      });
      return;
    }
    if (deps.shouldAutoApproveEdit?.(permission)) {
      const respond = deps.respondAutomaticPermission ?? deps.respondPermission;
      void respond(permission.sessionID, permission.id, 'once', { rethrow: true }).catch(() => {
        permissionsStore.addPermission(permission);
        deps.permissionVisible?.(permission.id);
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
          deps.permissionVisible?.(permission.id);
        })
        .finally(() => {
          autoJudgingPermissionIds.delete(permission.id);
        });
      return;
    }
    permissionsStore.addPermission(permission);
    deps.permissionVisible?.(permission.id);
  }

  function handlePermissionEvent(props: UnknownRecord) {
    const permission = normalizePermissionEvent(props);
    if (!permission) return;
    if (!deps.isPermissionSessionKnown?.(permission.sessionID) && deps.syncPermissionSession) {
      const alreadyPending = pendingSessionPermissions.has(permission.id);
      pendingSessionPermissions.set(permission.id, permission);
      if (alreadyPending) return;

      void Promise.resolve()
        .then(() => deps.syncPermissionSession!(permission.sessionID))
        .then(
          () => {
            const pending = pendingSessionPermissions.get(permission.id);
            if (disposed || !pending) return;
            pendingSessionPermissions.delete(permission.id);
            handleKnownPermission(pending);
          },
          (err) => {
            const pending = pendingSessionPermissions.get(permission.id);
            if (disposed || !pending) return;
            pendingSessionPermissions.delete(permission.id);
            deps.logError('permission.session', err);
            permissionsStore.addPermission(pending);
            deps.permissionVisible?.(pending.id);
          }
        );
      return;
    }
    handleKnownPermission(permission);
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
      if (pid) {
        pendingSessionPermissions.delete(pid);
        deps.permissionReplied?.(pid);
        permissionsStore.removePermission(pid);
      }
    })
  );

  cleanups.push(
    serverEvents.on('permission.v2.replied', (data) => {
      const props = data.properties;
      if (!props) return;
      const pid = getPermissionReplyId(props);
      if (pid) {
        pendingSessionPermissions.delete(pid);
        deps.permissionReplied?.(pid);
        permissionsStore.removePermission(pid);
      }
    })
  );

  cleanups.push(
    serverEvents.on('question.asked', (data) => {
      const props = data.properties;
      if (props) {
        // SAFETY: question.asked is decoded by the server-event contract as a complete question request.
        permissionsStore.upsertQuestion(props as QuestionRequest);
      }
    })
  );

  cleanups.push(
    serverEvents.on('question.v2.asked', (data) => {
      const props = data.properties;
      if (props) {
        // SAFETY: question.v2.asked is decoded by the server-event contract as a complete question request.
        permissionsStore.upsertQuestion(props as QuestionRequest);
      }
    })
  );

  cleanups.push(
    serverEvents.on('question.replied', (data) => {
      const requestID = getQuestionReplyId(data.properties);
      if (requestID) permissionsStore.removeResolvedQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('question.rejected', (data) => {
      const requestID = getQuestionReplyId(data.properties);
      if (requestID) permissionsStore.removeResolvedQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('question.v2.replied', (data) => {
      const requestID = getQuestionReplyId(data.properties);
      if (requestID) permissionsStore.removeResolvedQuestion(requestID);
    })
  );

  cleanups.push(
    serverEvents.on('question.v2.rejected', (data) => {
      const requestID = getQuestionReplyId(data.properties);
      if (requestID) permissionsStore.removeResolvedQuestion(requestID);
    })
  );

  cleanups.push(() => {
    disposed = true;
    pendingSessionPermissions.clear();
  });

  return cleanups;
}
