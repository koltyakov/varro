import type { Permission, QuestionRequest, Session } from '../types';
import type { PermissionMode } from '../../shared/protocol';

type PermissionResponse = 'once' | 'always' | 'reject';

function getPermissionGroupMembers(
  permissions: Permission[],
  sessionId: string,
  permissionId: string
) {
  const permission = permissions.find(
    (item) =>
      item.id === permissionId ||
      item.duplicateIDs?.includes(permissionId) ||
      item.groupMembers?.some((member) => member.id === permissionId)
  );
  return permission?.groupMembers?.length
    ? permission.groupMembers
    : [{ id: permissionId, sessionID: sessionId }];
}

export async function respondPermissionWithDependencies(
  deps: {
    getPermissions(): Permission[];
    respondPermission(
      sessionId: string,
      permissionId: string,
      response: PermissionResponse
    ): Promise<unknown>;
    removePermission(permissionId: string): void;
    setError(message: string): void;
  },
  sessionId: string,
  permissionId: string,
  response: PermissionResponse,
  options?: { rethrow?: boolean }
) {
  try {
    const groupMembers = getPermissionGroupMembers(deps.getPermissions(), sessionId, permissionId);
    await Promise.all(
      groupMembers.map((member) => deps.respondPermission(member.sessionID, member.id, response))
    );
    groupMembers.forEach((member) => deps.removePermission(member.id));
  } catch (err) {
    deps.setError(err instanceof Error ? err.message : 'Failed to respond to permission');
    if (options?.rethrow) {
      throw err;
    }
  }
}

export async function respondQuestionWithDependencies(
  deps: {
    replyQuestion(requestId: string, answers: Array<Array<string>>): Promise<unknown>;
    removeQuestion(requestId: string): void;
    setError(message: string): void;
  },
  requestId: string,
  answers: Array<Array<string>>
) {
  try {
    await deps.replyQuestion(requestId, answers);
    deps.removeQuestion(requestId);
  } catch (err) {
    deps.setError(err instanceof Error ? err.message : 'Failed to answer question');
  }
}

export async function rejectQuestionWithDependencies(
  deps: {
    rejectQuestion(requestId: string): Promise<unknown>;
    removeQuestion(requestId: string): void;
    setError(message: string): void;
  },
  requestId: string
) {
  try {
    await deps.rejectQuestion(requestId);
    deps.removeQuestion(requestId);
  } catch (err) {
    deps.setError(err instanceof Error ? err.message : 'Failed to reject question');
  }
}

export async function autoApprovePermissionsForSessionWithDependencies(
  deps: {
    respondPermission(
      sessionId: string,
      permissionId: string,
      response: PermissionResponse,
      options?: { rethrow?: boolean }
    ): Promise<void>;
  },
  permissions: Permission[]
) {
  await Promise.all(
    permissions.map((permission) =>
      deps.respondPermission(permission.sessionID, permission.id, 'always').catch(() => {})
    )
  );
}

export async function updatePermissionModeForSessionWithDependencies(
  deps: {
    getPermissionModeForSession(sessionId: string | null | undefined): PermissionMode;
    getDraftPermissionMode(): PermissionMode;
    setPermissionModeForSession(sessionId: string | null | undefined, mode: PermissionMode): void;
    setDraftPermissionMode(mode: PermissionMode): void;
    saveProjectPermissionMode(mode: PermissionMode): void;
    updateSessionPermission(
      sessionId: string,
      input: { permission: Session['permission'] }
    ): Promise<Session>;
    upsertSession(session: Session): void;
    setError(message: string): void;
    getPermissionsForSession(sessionId: string): Permission[];
    autoApprovePermissionsForSession(permissions: Permission[]): Promise<void>;
  },
  mode: PermissionMode,
  permissionRules: Session['permission'],
  sessionId: string | null | undefined
) {
  const previousMode = deps.getPermissionModeForSession(sessionId);
  const previousDraft = deps.getDraftPermissionMode();
  deps.setPermissionModeForSession(sessionId, mode);
  deps.setDraftPermissionMode(mode);
  deps.saveProjectPermissionMode(mode);
  if (!sessionId) return;

  try {
    const session = await deps.updateSessionPermission(sessionId, { permission: permissionRules });
    deps.upsertSession(session);
  } catch (err) {
    deps.setPermissionModeForSession(sessionId, previousMode);
    deps.setDraftPermissionMode(previousDraft);
    deps.saveProjectPermissionMode(previousDraft);
    deps.setError(err instanceof Error ? err.message : 'Failed to update permissions');
    return;
  }

  if (mode !== 'full') return;
  await deps.autoApprovePermissionsForSession(deps.getPermissionsForSession(sessionId));
}

export function getQuestionById(questions: QuestionRequest[], requestId: string) {
  return questions.find((question) => question.id === requestId) || null;
}

export function createSessionApprovalOperations(deps: {
  getPermissions(): Permission[];
  respondRemotePermission(
    sessionId: string,
    permissionId: string,
    response: PermissionResponse
  ): Promise<unknown>;
  removePermission(permissionId: string): void;
  setError(message: string): void;
  replyQuestion(requestId: string, answers: Array<Array<string>>): Promise<unknown>;
  removeQuestion(requestId: string): void;
  rejectRemoteQuestion(requestId: string): Promise<unknown>;
  getPermissionModeForSession(sessionId: string | null | undefined): PermissionMode;
  getDraftPermissionMode(): PermissionMode;
  setPermissionModeForSession(sessionId: string | null | undefined, mode: PermissionMode): void;
  setDraftPermissionMode(mode: PermissionMode): void;
  saveProjectPermissionMode(mode: PermissionMode): void;
  updateSessionPermission(
    sessionId: string,
    input: { permission: Session['permission'] }
  ): Promise<Session>;
  upsertSession(session: Session): void;
  getPermissionsForSession(sessionId: string): Permission[];
}) {
  const operations = {
    respondPermission: async (
      sessionId: string,
      permissionId: string,
      response: PermissionResponse,
      options?: { rethrow?: boolean }
    ) => {
      await respondPermissionWithDependencies(
        {
          getPermissions: deps.getPermissions,
          respondPermission: deps.respondRemotePermission,
          removePermission: deps.removePermission,
          setError: deps.setError,
        },
        sessionId,
        permissionId,
        response,
        options
      );
    },
    respondQuestion: async (requestId: string, answers: Array<Array<string>>) => {
      await respondQuestionWithDependencies(
        {
          replyQuestion: deps.replyQuestion,
          removeQuestion: deps.removeQuestion,
          setError: deps.setError,
        },
        requestId,
        answers
      );
    },
    rejectQuestion: async (requestId: string) => {
      await rejectQuestionWithDependencies(
        {
          rejectQuestion: deps.rejectRemoteQuestion,
          removeQuestion: deps.removeQuestion,
          setError: deps.setError,
        },
        requestId
      );
    },
    autoApprovePermissionsForSession: async (permissions: Permission[]) => {
      await autoApprovePermissionsForSessionWithDependencies(
        {
          respondPermission: operations.respondPermission,
        },
        permissions
      );
    },
    updatePermissionModeForSession: async (
      mode: PermissionMode,
      permissionRules: Session['permission'],
      sessionId: string | null | undefined
    ) => {
      await updatePermissionModeForSessionWithDependencies(
        {
          getPermissionModeForSession: deps.getPermissionModeForSession,
          getDraftPermissionMode: deps.getDraftPermissionMode,
          setPermissionModeForSession: deps.setPermissionModeForSession,
          setDraftPermissionMode: deps.setDraftPermissionMode,
          saveProjectPermissionMode: deps.saveProjectPermissionMode,
          updateSessionPermission: deps.updateSessionPermission,
          upsertSession: deps.upsertSession,
          setError: deps.setError,
          getPermissionsForSession: deps.getPermissionsForSession,
          autoApprovePermissionsForSession: operations.autoApprovePermissionsForSession,
        },
        mode,
        permissionRules,
        sessionId
      );
    },
  };

  return operations;
}
