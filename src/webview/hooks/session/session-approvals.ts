import { batch } from 'solid-js';
import type { PermissionMode } from '../../../shared/protocol';
import type { Permission, QuestionRequest, Session } from '../../types';

type PermissionResponse = 'once' | 'always' | 'reject';

export async function respondPermissionWithDependencies(
  deps: {
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
    await deps.respondPermission(sessionId, permissionId, response);
    deps.removePermission(permissionId);
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
    syncPendingPermissions?(): Promise<void>;
  },
  mode: PermissionMode,
  permissionRules: Session['permission'],
  sessionId: string | null | undefined
) {
  const previousMode = deps.getPermissionModeForSession(sessionId);
  const previousDraft = deps.getDraftPermissionMode();
  batch(() => {
    deps.setPermissionModeForSession(sessionId, mode);
    deps.setDraftPermissionMode(mode);
    deps.saveProjectPermissionMode(mode);
  });
  if (!sessionId) return;

  try {
    const session = await deps.updateSessionPermission(sessionId, { permission: permissionRules });
    deps.upsertSession(session);
  } catch (err) {
    batch(() => {
      deps.setPermissionModeForSession(sessionId, previousMode);
      deps.setDraftPermissionMode(previousDraft);
      deps.saveProjectPermissionMode(previousDraft);
    });
    deps.setError(err instanceof Error ? err.message : 'Failed to update permissions');
    return;
  }

  if (mode !== 'full') return;
  await deps.autoApprovePermissionsForSession(deps.getPermissionsForSession(sessionId));
  await deps.syncPendingPermissions?.();
}

export function getQuestionById(questions: QuestionRequest[], requestId: string) {
  return questions.find((question) => question.id === requestId) || null;
}

type SessionApprovalDependencies = {
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
  syncPendingPermissions?(): Promise<void>;
};

export class SessionApprovalOperations {
  constructor(private readonly deps: SessionApprovalDependencies) {}

  readonly respondPermission = async (
    sessionId: string,
    permissionId: string,
    response: PermissionResponse,
    options?: { rethrow?: boolean }
  ) => {
    await respondPermissionWithDependencies(
      {
        respondPermission: this.deps.respondRemotePermission,
        removePermission: this.deps.removePermission,
        setError: this.deps.setError,
      },
      sessionId,
      permissionId,
      response,
      options
    );
  };

  readonly respondQuestion = async (requestId: string, answers: Array<Array<string>>) => {
    await respondQuestionWithDependencies(
      {
        replyQuestion: this.deps.replyQuestion,
        removeQuestion: this.deps.removeQuestion,
        setError: this.deps.setError,
      },
      requestId,
      answers
    );
  };

  readonly rejectQuestion = async (requestId: string) => {
    await rejectQuestionWithDependencies(
      {
        rejectQuestion: this.deps.rejectRemoteQuestion,
        removeQuestion: this.deps.removeQuestion,
        setError: this.deps.setError,
      },
      requestId
    );
  };

  readonly autoApprovePermissionsForSession = async (permissions: Permission[]) => {
    await autoApprovePermissionsForSessionWithDependencies(
      {
        respondPermission: this.respondPermission,
      },
      permissions
    );
  };

  readonly updatePermissionModeForSession = async (
    mode: PermissionMode,
    permissionRules: Session['permission'],
    sessionId: string | null | undefined
  ) => {
    await updatePermissionModeForSessionWithDependencies(
      {
        getPermissionModeForSession: this.deps.getPermissionModeForSession,
        getDraftPermissionMode: this.deps.getDraftPermissionMode,
        setPermissionModeForSession: this.deps.setPermissionModeForSession,
        setDraftPermissionMode: this.deps.setDraftPermissionMode,
        saveProjectPermissionMode: this.deps.saveProjectPermissionMode,
        updateSessionPermission: this.deps.updateSessionPermission,
        upsertSession: this.deps.upsertSession,
        setError: this.deps.setError,
        getPermissionsForSession: this.deps.getPermissionsForSession,
        autoApprovePermissionsForSession: this.autoApprovePermissionsForSession,
        syncPendingPermissions: this.deps.syncPendingPermissions,
      },
      mode,
      permissionRules,
      sessionId
    );
  };
}
