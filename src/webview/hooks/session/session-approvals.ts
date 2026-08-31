import { batch } from 'solid-js';
import type { PermissionMode } from '../../../shared/protocol';
import type { Permission, QuestionRequest, Session } from '../../types';

type PermissionResponse = 'once' | 'always' | 'reject';
type PermissionResponseTarget = { id: string; sessionID: string };
type PermissionResponseOptions = {
  rethrow?: boolean;
  groupMembers?: PermissionResponseTarget[];
  automatic?: boolean;
  permissionAutomationLease?: number;
};
type PermissionModeFreshness = {
  isSessionCurrent(): boolean;
  isDraftCurrent(): boolean;
  applyOptimistic?: boolean;
  getConfirmedMode?(): PermissionMode;
  onConfirmed?(session: Session): void;
};

function isMissingPermissionRequestError<T>(error: T): boolean {
  return error instanceof Error && /^404\b.*permission request not found/i.test(error.message);
}

function applyPermissionModeSelection(
  deps: {
    setPermissionModeForSession(sessionId: string | null | undefined, mode: PermissionMode): void;
    setDraftPermissionMode(mode: PermissionMode): void;
    saveProjectPermissionMode(mode: PermissionMode): void;
  },
  sessionId: string | null | undefined,
  mode: PermissionMode
) {
  batch(() => {
    deps.setPermissionModeForSession(sessionId, mode);
    deps.setDraftPermissionMode(mode);
    deps.saveProjectPermissionMode(mode);
  });
}

export async function respondPermissionWithDependencies(
  deps: {
    respondPermission(
      sessionId: string,
      permissionId: string,
      response: PermissionResponse
    ): Promise<void | boolean | object>;
    removePermission(permissionId: string, options?: { removeGroup?: boolean }): void;
    setError(message: string): void;
  },
  sessionId: string,
  permissionId: string,
  response: PermissionResponse,
  options?: PermissionResponseOptions
) {
  try {
    const targets =
      response === 'reject' && options?.groupMembers?.length
        ? options.groupMembers
        : [{ id: permissionId, sessionID: sessionId }];
    await Promise.all(
      targets.map(async (target) => {
        try {
          await deps.respondPermission(target.sessionID, target.id, response);
        } catch (err) {
          if (!isMissingPermissionRequestError(err)) throw err;
        }
      })
    );
    deps.removePermission(permissionId, { removeGroup: response !== 'once' });
  } catch (err) {
    deps.setError(err instanceof Error ? err.message : 'Failed to respond to permission');
    if (options?.rethrow) {
      throw err;
    }
  }
}

export async function respondQuestionWithDependencies(
  deps: {
    replyQuestion(
      requestId: string,
      answers: Array<Array<string>>
    ): Promise<void | boolean | object>;
    beginQuestionResponse(requestId: string): number | undefined;
    cancelQuestionResponse(requestId: string, expectedGeneration?: number): boolean;
    removeResolvedQuestion(requestId: string, expectedGeneration?: number): boolean;
    setError(message: string): void;
  },
  requestId: string,
  answers: Array<Array<string>>,
  options?: { rethrow?: boolean }
) {
  const responseGeneration = deps.beginQuestionResponse(requestId);
  try {
    await deps.replyQuestion(requestId, answers);
    deps.removeResolvedQuestion(requestId, responseGeneration);
  } catch (err) {
    if (!deps.cancelQuestionResponse(requestId, responseGeneration)) return;
    deps.setError(err instanceof Error ? err.message : 'Failed to answer question');
    if (options?.rethrow) throw err;
  }
}

export async function rejectQuestionWithDependencies(
  deps: {
    rejectQuestion(requestId: string): Promise<void | boolean | object>;
    beginQuestionResponse(requestId: string): number | undefined;
    cancelQuestionResponse(requestId: string, expectedGeneration?: number): boolean;
    removeResolvedQuestion(requestId: string, expectedGeneration?: number): boolean;
    setError(message: string): void;
  },
  requestId: string,
  options?: { rethrow?: boolean }
) {
  const responseGeneration = deps.beginQuestionResponse(requestId);
  try {
    await deps.rejectQuestion(requestId);
    deps.removeResolvedQuestion(requestId, responseGeneration);
  } catch (err) {
    if (!deps.cancelQuestionResponse(requestId, responseGeneration)) return;
    deps.setError(err instanceof Error ? err.message : 'Failed to reject question');
    if (options?.rethrow) throw err;
  }
}

export async function autoApprovePermissionsForSessionWithDependencies(
  deps: {
    respondPermission(
      sessionId: string,
      permissionId: string,
      response: PermissionResponse,
      options?: { rethrow?: boolean }
    ): Promise<void | boolean | object>;
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
      mode: PermissionMode,
      input: { permission: Session['permission'] }
    ): Promise<Session>;
    upsertSession(session: Session): void;
    setError(message: string): void;
    getPermissionsForSession(sessionId: string): Permission[];
    autoApprovePermissionsForSession(permissions: Permission[]): Promise<void | boolean | object>;
    syncPendingPermissions?(): Promise<void | boolean | object>;
  },
  mode: PermissionMode,
  permissionRules: Session['permission'],
  sessionId: string | null | undefined,
  freshness: PermissionModeFreshness = {
    isSessionCurrent: () => true,
    isDraftCurrent: () => true,
  }
) {
  const previousMode = deps.getPermissionModeForSession(sessionId);
  const previousDraft = deps.getDraftPermissionMode();
  if (freshness.applyOptimistic !== false) applyPermissionModeSelection(deps, sessionId, mode);
  if (!sessionId) return;

  try {
    const session = await deps.updateSessionPermission(sessionId, mode, {
      permission: permissionRules,
    });
    freshness.onConfirmed?.(session);
    if (!freshness.isSessionCurrent()) return;
    deps.upsertSession(session);
  } catch (err) {
    const sessionCurrent = freshness.isSessionCurrent();
    const draftCurrent = freshness.isDraftCurrent();
    if (!sessionCurrent && !draftCurrent) return;
    const confirmedMode = freshness.getConfirmedMode?.();
    batch(() => {
      if (sessionCurrent) {
        deps.setPermissionModeForSession(sessionId, confirmedMode ?? previousMode);
      }
      if (draftCurrent) {
        const rollbackMode = confirmedMode ?? previousDraft;
        deps.setDraftPermissionMode(rollbackMode);
        deps.saveProjectPermissionMode(rollbackMode);
      }
    });
    deps.setError(err instanceof Error ? err.message : 'Failed to update permissions');
    return;
  }

  if (mode === 'full') {
    if (!freshness.isSessionCurrent()) return;
    await deps.autoApprovePermissionsForSession(deps.getPermissionsForSession(sessionId));
    if (!freshness.isSessionCurrent()) return;
    await deps.syncPendingPermissions?.();
    return;
  }
  if (mode === 'auto' || mode === 'edits') {
    if (!freshness.isSessionCurrent()) return;
    await deps.syncPendingPermissions?.();
  }
}

export function getQuestionById(questions: QuestionRequest[], requestId: string) {
  return questions.find((question) => question.id === requestId) || null;
}

type SessionApprovalDependencies = {
  respondRemotePermission(
    sessionId: string,
    permissionId: string,
    response: PermissionResponse
  ): Promise<void | boolean | object>;
  respondAutomaticPermission?(
    sessionId: string,
    permissionId: string,
    response: PermissionResponse,
    lease?: number
  ): Promise<void | boolean | object>;
  canAutomatePermissions?(): boolean;
  removePermission(permissionId: string, options?: { removeGroup?: boolean }): void;
  setError(message: string): void;
  replyQuestion(requestId: string, answers: Array<Array<string>>): Promise<void | boolean | object>;
  beginQuestionResponse(requestId: string): number | undefined;
  cancelQuestionResponse(requestId: string, expectedGeneration?: number): boolean;
  removeResolvedQuestion(requestId: string, expectedGeneration?: number): boolean;
  rejectRemoteQuestion(requestId: string): Promise<void | boolean | object>;
  getPermissionModeForSession(sessionId: string | null | undefined): PermissionMode;
  getDraftPermissionMode(): PermissionMode;
  setPermissionModeForSession(sessionId: string | null | undefined, mode: PermissionMode): void;
  setDraftPermissionMode(mode: PermissionMode): void;
  saveProjectPermissionMode(mode: PermissionMode): void;
  updateSessionPermission(
    sessionId: string,
    mode: PermissionMode,
    input: { permission: Session['permission'] }
  ): Promise<Session>;
  upsertSession(session: Session): void;
  getPermissionsForSession(sessionId: string): Permission[];
  syncPendingPermissions?(): Promise<void | boolean | object>;
  setPendingSessionPermissionMode?(
    sessionId: string,
    mode: PermissionMode | null,
    generation?: number
  ): number | null;
};

type PermissionModeQueue = {
  confirmedMode: PermissionMode;
  pending: number;
  tail: Promise<void | boolean | object>;
};

export class SessionApprovalOperations {
  private nextPermissionModeGeneration = 0;
  private draftPermissionModeGeneration = 0;
  private readonly permissionModeGenerationBySession = new Map<string, number>();
  private readonly permissionModeQueues = new Map<string, PermissionModeQueue>();

  constructor(private readonly deps: SessionApprovalDependencies) {}

  readonly respondPermission = async (
    sessionId: string,
    permissionId: string,
    response: PermissionResponse,
    options?: PermissionResponseOptions
  ) => {
    await respondPermissionWithDependencies(
      {
        respondPermission: options?.automatic
          ? (targetSessionId, targetPermissionId, targetResponse) =>
              (this.deps.respondAutomaticPermission ?? this.deps.respondRemotePermission)(
                targetSessionId,
                targetPermissionId,
                targetResponse,
                options.permissionAutomationLease
              )
          : this.deps.respondRemotePermission,
        removePermission: this.deps.removePermission,
        setError: this.deps.setError,
      },
      sessionId,
      permissionId,
      response,
      options
    );
  };

  readonly respondQuestion = async (
    requestId: string,
    answers: Array<Array<string>>,
    options?: { rethrow?: boolean }
  ) => {
    await respondQuestionWithDependencies(
      {
        replyQuestion: this.deps.replyQuestion,
        beginQuestionResponse: this.deps.beginQuestionResponse,
        cancelQuestionResponse: this.deps.cancelQuestionResponse,
        removeResolvedQuestion: this.deps.removeResolvedQuestion,
        setError: this.deps.setError,
      },
      requestId,
      answers,
      options
    );
  };

  readonly rejectQuestion = async (requestId: string, options?: { rethrow?: boolean }) => {
    await rejectQuestionWithDependencies(
      {
        rejectQuestion: this.deps.rejectRemoteQuestion,
        beginQuestionResponse: this.deps.beginQuestionResponse,
        cancelQuestionResponse: this.deps.cancelQuestionResponse,
        removeResolvedQuestion: this.deps.removeResolvedQuestion,
        setError: this.deps.setError,
      },
      requestId,
      options
    );
  };

  readonly autoApprovePermissionsForSession = async (permissions: Permission[]) => {
    if (this.deps.canAutomatePermissions?.() === false) return;
    await autoApprovePermissionsForSessionWithDependencies(
      {
        respondPermission: (sessionId, permissionId, response, options) =>
          this.respondPermission(sessionId, permissionId, response, {
            ...options,
            automatic: true,
          }),
      },
      permissions
    );
  };

  readonly updatePermissionModeForSession = async (
    mode: PermissionMode,
    permissionRules: Session['permission'],
    sessionId: string | null | undefined
  ) => {
    const generation = ++this.nextPermissionModeGeneration;
    const sessionKey = sessionId ?? '';
    this.permissionModeGenerationBySession.set(sessionKey, generation);
    this.draftPermissionModeGeneration = generation;
    const queue = sessionId
      ? (this.permissionModeQueues.get(sessionId) ?? {
          confirmedMode: this.deps.getPermissionModeForSession(sessionId),
          pending: 0,
          tail: Promise.resolve(),
        })
      : null;
    if (sessionId && queue) this.permissionModeQueues.set(sessionId, queue);

    const pendingGeneration =
      sessionId && queue ? this.deps.setPendingSessionPermissionMode?.(sessionId, mode) : undefined;
    applyPermissionModeSelection(this.deps, sessionId, mode);
    if (!sessionId || !queue) return;

    queue.pending += 1;
    let pendingCleared = false;
    const request = queue.tail.then(() =>
      updatePermissionModeForSessionWithDependencies(
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
        sessionId,
        {
          applyOptimistic: false,
          isSessionCurrent: () =>
            this.permissionModeGenerationBySession.get(sessionKey) === generation,
          isDraftCurrent: () => this.draftPermissionModeGeneration === generation,
          getConfirmedMode: () => queue.confirmedMode,
          onConfirmed: () => {
            queue.confirmedMode = mode;
            if (this.permissionModeGenerationBySession.get(sessionKey) === generation) {
              this.deps.setPendingSessionPermissionMode?.(
                sessionId,
                null,
                pendingGeneration ?? undefined
              );
              this.deps.setPermissionModeForSession(sessionId, mode);
              pendingCleared = true;
            }
          },
        }
      )
    );
    queue.tail = request.catch(() => {});
    try {
      await request;
    } finally {
      queue.pending -= 1;
      if (
        !pendingCleared &&
        this.permissionModeGenerationBySession.get(sessionKey) === generation
      ) {
        this.deps.setPendingSessionPermissionMode?.(
          sessionId,
          null,
          pendingGeneration ?? undefined
        );
      }
      if (queue.pending === 0 && this.permissionModeQueues.get(sessionId) === queue) {
        this.permissionModeQueues.delete(sessionId);
      }
    }
  };
}
