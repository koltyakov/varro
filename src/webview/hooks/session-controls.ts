import type { Message, Session, SessionStatus } from '../types';

type ResolvedModel = { providerID: string; modelID: string; variant?: string };

export async function reviewSessionWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    sendMessage(prompt: string): Promise<void>;
  },
  prompt = 'review the current changes in my code and provide feedback'
) {
  if (!deps.getActiveSessionId()) return;
  await deps.sendMessage(prompt);
}

export async function abortSessionWithDependencies(deps: {
  getActiveSessionId(): string | null;
  getSessionTreeIds(sessionId: string): string[];
  getSelectedAgentForSession(sessionId: string): string | null;
  skipPlanSession(sessionId: string): void;
  getSessionStatus(sessionId: string): SessionStatus | undefined;
  getSessionUsageLimit(sessionId: string): unknown;
  markPendingAbortTree(sessionIds: string[]): void;
  setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
  stopLoading(): void;
  abortRemoteSession(sessionId: string): Promise<unknown>;
  clearPendingAbortTree(sessionIds: string[]): void;
  setSessionUsageLimit(sessionId: string, notice: unknown): void;
  logError(context: string, err: unknown): void;
}) {
  const sessionId = deps.getActiveSessionId();
  if (!sessionId) return;

  const sessionTreeIds = deps.getSessionTreeIds(sessionId);
  if (deps.getSelectedAgentForSession(sessionId) === 'plan') {
    deps.skipPlanSession(sessionId);
  }

  const previousStatuses = new Map(
    sessionTreeIds.map((id) => [id, deps.getSessionStatus(id)] as const)
  );
  const previousUsageLimits = new Map(
    sessionTreeIds.map((id) => [id, deps.getSessionUsageLimit(id) || null] as const)
  );

  deps.markPendingAbortTree(sessionTreeIds);
  for (const id of sessionTreeIds) {
    deps.setSessionStatusEntry(id, { type: 'idle' });
  }
  deps.stopLoading();

  try {
    await Promise.all(sessionTreeIds.map((id) => deps.abortRemoteSession(id)));
  } catch (err) {
    deps.clearPendingAbortTree(sessionTreeIds);
    for (const id of sessionTreeIds) {
      const previousStatus = previousStatuses.get(id);
      if (previousStatus) {
        deps.setSessionStatusEntry(id, previousStatus);
      }
      deps.setSessionUsageLimit(id, previousUsageLimits.get(id) || null);
    }
    deps.logError('abortSession', err);
  }
}

export async function undoSessionWithDependencies(deps: {
  getActiveSessionId(): string | null;
  getMessages(): Array<{ info: Message }>;
  startLoading(): void;
  revertSession(sessionId: string, messageId: string): Promise<unknown>;
  syncSession(sessionId: string): Promise<void>;
  syncSessionMessages(sessionId: string): Promise<void>;
  stopLoading(): void;
  setError(message: string): void;
}) {
  const sessionId = deps.getActiveSessionId();
  if (!sessionId) return;

  const lastAssistant = [...deps.getMessages()]
    .toReversed()
    .find((entry) => entry.info.role === 'assistant');
  if (!lastAssistant) return;

  try {
    deps.startLoading();
    await deps.revertSession(sessionId, lastAssistant.info.id);
    await Promise.all([deps.syncSession(sessionId), deps.syncSessionMessages(sessionId)]);
    deps.stopLoading();
  } catch (err) {
    deps.stopLoading();
    deps.setError(err instanceof Error ? err.message : 'Failed to undo');
  }
}

export async function redoSessionWithDependencies(deps: {
  getActiveSessionId(): string | null;
  startLoading(): void;
  unrevertSession(sessionId: string): Promise<Session>;
  upsertSession(session: Session): void;
  syncSession(sessionId: string): Promise<void>;
  syncSessionMessages(sessionId: string): Promise<void>;
  stopLoading(): void;
  setError(message: string): void;
}) {
  const sessionId = deps.getActiveSessionId();
  if (!sessionId) return;

  try {
    deps.startLoading();
    const session = await deps.unrevertSession(sessionId);
    deps.upsertSession(session);
    await Promise.all([deps.syncSession(sessionId), deps.syncSessionMessages(sessionId)]);
    deps.stopLoading();
  } catch (err) {
    deps.stopLoading();
    deps.setError(err instanceof Error ? err.message : 'Failed to redo');
  }
}

export async function compactSessionWithDependencies(deps: {
  getActiveSessionId(): string | null;
  clearPendingAbort(sessionId: string): void;
  resolveSelectedModel(): ResolvedModel | null;
  setError(message: string): void;
  setSessionCompacting(sessionId: string, compacting: boolean): void;
  startLoading(): void;
  compactRemoteSession(
    sessionId: string,
    input: { providerID: string; modelID: string }
  ): Promise<unknown>;
  syncSession(sessionId: string): Promise<void>;
  syncSessionMessages(sessionId: string): Promise<void>;
  getSession(sessionId: string): Session | undefined;
  stopLoading(): void;
}) {
  const sessionId = deps.getActiveSessionId();
  if (!sessionId) return;

  deps.clearPendingAbort(sessionId);
  const effectiveModel = deps.resolveSelectedModel();
  if (!effectiveModel) {
    deps.setError('Select a model before compacting the session');
    return;
  }

  try {
    deps.setSessionCompacting(sessionId, true);
    deps.startLoading();
    await deps.compactRemoteSession(sessionId, {
      providerID: effectiveModel.providerID,
      modelID: effectiveModel.modelID,
    });
    await Promise.all([deps.syncSession(sessionId), deps.syncSessionMessages(sessionId)]);
    const compacting = deps.getSession(sessionId)?.time.compacting;
    if (!compacting) {
      deps.setSessionCompacting(sessionId, false);
    }
    deps.stopLoading();
  } catch (err) {
    deps.stopLoading();
    deps.setSessionCompacting(sessionId, false);
    deps.setError(err instanceof Error ? err.message : 'Failed to compact session');
  }
}

export function createSessionControlOperations(deps: {
  getActiveSessionId(): string | null;
  sendMessage(prompt: string): Promise<void>;
  getSessionTreeIds(sessionId: string): string[];
  getSelectedAgentForSession(sessionId: string): string | null;
  skipPlanSession(sessionId: string): void;
  getSessionStatus(sessionId: string): SessionStatus | undefined;
  getSessionUsageLimit(sessionId: string): unknown;
  markPendingAbortTree(sessionIds: string[]): void;
  setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
  stopLoading(): void;
  abortRemoteSession(sessionId: string): Promise<unknown>;
  clearPendingAbortTree(sessionIds: string[]): void;
  setSessionUsageLimit(sessionId: string, notice: unknown): void;
  logError(context: string, err: unknown): void;
  getMessages(): Array<{ info: Message }>;
  startLoading(): void;
  revertSession(sessionId: string, messageId: string): Promise<unknown>;
  syncSession(sessionId: string): Promise<void>;
  syncSessionMessages(sessionId: string): Promise<void>;
  setError(message: string): void;
  unrevertSession(sessionId: string): Promise<Session>;
  upsertSession(session: Session): void;
  clearPendingAbort(sessionId: string): void;
  resolveSelectedModel(): ResolvedModel | null;
  setSessionCompacting(sessionId: string, compacting: boolean): void;
  compactRemoteSession(
    sessionId: string,
    input: { providerID: string; modelID: string }
  ): Promise<unknown>;
  getSession(sessionId: string): Session | undefined;
}) {
  return {
    reviewSession: async () => {
      await reviewSessionWithDependencies({
        getActiveSessionId: deps.getActiveSessionId,
        sendMessage: deps.sendMessage,
      });
    },
    abortSession: async () => {
      await abortSessionWithDependencies({
        getActiveSessionId: deps.getActiveSessionId,
        getSessionTreeIds: deps.getSessionTreeIds,
        getSelectedAgentForSession: deps.getSelectedAgentForSession,
        skipPlanSession: deps.skipPlanSession,
        getSessionStatus: deps.getSessionStatus,
        getSessionUsageLimit: deps.getSessionUsageLimit,
        markPendingAbortTree: deps.markPendingAbortTree,
        setSessionStatusEntry: deps.setSessionStatusEntry,
        stopLoading: deps.stopLoading,
        abortRemoteSession: deps.abortRemoteSession,
        clearPendingAbortTree: deps.clearPendingAbortTree,
        setSessionUsageLimit: deps.setSessionUsageLimit,
        logError: deps.logError,
      });
    },
    undoSession: async () => {
      await undoSessionWithDependencies({
        getActiveSessionId: deps.getActiveSessionId,
        getMessages: deps.getMessages,
        startLoading: deps.startLoading,
        revertSession: deps.revertSession,
        syncSession: deps.syncSession,
        syncSessionMessages: deps.syncSessionMessages,
        stopLoading: deps.stopLoading,
        setError: deps.setError,
      });
    },
    redoSession: async () => {
      await redoSessionWithDependencies({
        getActiveSessionId: deps.getActiveSessionId,
        startLoading: deps.startLoading,
        unrevertSession: deps.unrevertSession,
        upsertSession: deps.upsertSession,
        syncSession: deps.syncSession,
        syncSessionMessages: deps.syncSessionMessages,
        stopLoading: deps.stopLoading,
        setError: deps.setError,
      });
    },
    compactSession: async () => {
      await compactSessionWithDependencies({
        getActiveSessionId: deps.getActiveSessionId,
        clearPendingAbort: deps.clearPendingAbort,
        resolveSelectedModel: deps.resolveSelectedModel,
        setError: deps.setError,
        setSessionCompacting: deps.setSessionCompacting,
        startLoading: deps.startLoading,
        compactRemoteSession: deps.compactRemoteSession,
        syncSession: deps.syncSession,
        syncSessionMessages: deps.syncSessionMessages,
        getSession: deps.getSession,
        stopLoading: deps.stopLoading,
      });
    },
  };
}
