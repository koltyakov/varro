import type { Message, Session, SessionStatus } from '../../types';

type ResolvedModel = { providerID: string; modelID: string; variant?: string };

export async function reviewSessionWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    sendMessage(prompt: string): Promise<unknown>;
  },
  prompt = 'review the current changes in my code and provide feedback'
) {
  if (!deps.getActiveSessionId()) return;
  await deps.sendMessage(prompt);
}

export async function abortSessionWithDependencies(deps: {
  getActiveSessionId(): string | null;
  getSessionTreeRootId(sessionId: string): string | null;
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

  const rootSessionId = deps.getSessionTreeRootId(sessionId) || sessionId;
  const sessionTreeIds = deps.getSessionTreeIds(rootSessionId);
  if (deps.getSelectedAgentForSession(rootSessionId) === 'plan') {
    deps.skipPlanSession(rootSessionId);
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

export async function editMessageWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    getMessages(): Array<{ info: Message }>;
    isSessionWorking(sessionId: string): boolean;
    abortSession(): Promise<void>;
    startLoading(): void;
    invalidateMessageSync?(): void;
    pruneMessagesFrom?(sessionId: string, messageId: string): (() => void) | null;
    deleteMessage(sessionId: string, messageId: string): Promise<unknown>;
    syncSessionMessages(sessionId: string): Promise<void>;
    sendEditedMessage(text: string): Promise<boolean>;
    stopLoading(): void;
    setError(message: string): void;
  },
  messageId: string,
  text: string,
  options?: { allowEmptyText?: boolean }
) {
  const sessionId = deps.getActiveSessionId();
  if (!sessionId || (!options?.allowEmptyText && !text.trim())) return false;

  const messages = deps.getMessages();
  const targetIndex = messages.findIndex(
    (entry) => entry.info.role === 'user' && entry.info.id === messageId
  );
  const target = messages[targetIndex];
  if (!target || target.info.sessionID !== sessionId) return false;

  const messagesToDelete = messages.slice(targetIndex).toReversed();
  try {
    deps.startLoading();
    deps.invalidateMessageSync?.();
    deps.pruneMessagesFrom?.(sessionId, messageId);
    if (deps.isSessionWorking(sessionId)) {
      await deps.abortSession();
    }
    // Session revert also restores filesystem snapshots; direct history deletion does not.
    for (const message of messagesToDelete) {
      await deps.deleteMessage(sessionId, message.info.id);
    }
  } catch (err) {
    await deps.syncSessionMessages(sessionId).catch(() => {});
    deps.stopLoading();
    deps.setError(err instanceof Error ? err.message : 'Failed to edit message');
    return false;
  }

  try {
    if (await deps.sendEditedMessage(text)) return true;
  } catch (err) {
    deps.setError(err instanceof Error ? err.message : 'Failed to send edited message');
  }
  deps.stopLoading();
  return false;
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

type SessionControlDependencies = {
  getActiveSessionId(): string | null;
  sendMessage(prompt: string): Promise<unknown>;
  getSessionTreeRootId(sessionId: string): string | null;
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
  isSessionWorking(sessionId: string): boolean;
  sendEditedMessage(text: string): Promise<boolean>;
  invalidateMessageSync(): void;
  pruneMessagesFrom(sessionId: string, messageId: string): (() => void) | null;
  deleteMessage(sessionId: string, messageId: string): Promise<unknown>;
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
};

export class SessionControlOperations {
  constructor(private readonly deps: SessionControlDependencies) {}

  readonly reviewSession = async () => {
    await reviewSessionWithDependencies({
      getActiveSessionId: this.deps.getActiveSessionId,
      sendMessage: this.deps.sendMessage,
    });
  };

  readonly abortSession = async () => {
    await abortSessionWithDependencies({
      getActiveSessionId: this.deps.getActiveSessionId,
      getSessionTreeRootId: this.deps.getSessionTreeRootId,
      getSessionTreeIds: this.deps.getSessionTreeIds,
      getSelectedAgentForSession: this.deps.getSelectedAgentForSession,
      skipPlanSession: this.deps.skipPlanSession,
      getSessionStatus: this.deps.getSessionStatus,
      getSessionUsageLimit: this.deps.getSessionUsageLimit,
      markPendingAbortTree: this.deps.markPendingAbortTree,
      setSessionStatusEntry: this.deps.setSessionStatusEntry,
      stopLoading: this.deps.stopLoading,
      abortRemoteSession: this.deps.abortRemoteSession,
      clearPendingAbortTree: this.deps.clearPendingAbortTree,
      setSessionUsageLimit: this.deps.setSessionUsageLimit,
      logError: this.deps.logError,
    });
  };

  readonly undoSession = async () => {
    await undoSessionWithDependencies({
      getActiveSessionId: this.deps.getActiveSessionId,
      getMessages: this.deps.getMessages,
      startLoading: this.deps.startLoading,
      revertSession: this.deps.revertSession,
      syncSession: this.deps.syncSession,
      syncSessionMessages: this.deps.syncSessionMessages,
      stopLoading: this.deps.stopLoading,
      setError: this.deps.setError,
    });
  };

  readonly editMessage = async (
    messageId: string,
    text: string,
    options?: { allowEmptyText?: boolean }
  ) => {
    return await editMessageWithDependencies(
      {
        getActiveSessionId: this.deps.getActiveSessionId,
        getMessages: this.deps.getMessages,
        isSessionWorking: this.deps.isSessionWorking,
        abortSession: this.abortSession,
        startLoading: this.deps.startLoading,
        invalidateMessageSync: this.deps.invalidateMessageSync,
        pruneMessagesFrom: this.deps.pruneMessagesFrom,
        deleteMessage: this.deps.deleteMessage,
        syncSessionMessages: this.deps.syncSessionMessages,
        sendEditedMessage: this.deps.sendEditedMessage,
        stopLoading: this.deps.stopLoading,
        setError: this.deps.setError,
      },
      messageId,
      text,
      options
    );
  };

  readonly redoSession = async () => {
    await redoSessionWithDependencies({
      getActiveSessionId: this.deps.getActiveSessionId,
      startLoading: this.deps.startLoading,
      unrevertSession: this.deps.unrevertSession,
      upsertSession: this.deps.upsertSession,
      syncSession: this.deps.syncSession,
      syncSessionMessages: this.deps.syncSessionMessages,
      stopLoading: this.deps.stopLoading,
      setError: this.deps.setError,
    });
  };

  readonly compactSession = async () => {
    await compactSessionWithDependencies({
      getActiveSessionId: this.deps.getActiveSessionId,
      clearPendingAbort: this.deps.clearPendingAbort,
      resolveSelectedModel: this.deps.resolveSelectedModel,
      setError: this.deps.setError,
      setSessionCompacting: this.deps.setSessionCompacting,
      startLoading: this.deps.startLoading,
      compactRemoteSession: this.deps.compactRemoteSession,
      syncSession: this.deps.syncSession,
      syncSessionMessages: this.deps.syncSessionMessages,
      getSession: this.deps.getSession,
      stopLoading: this.deps.stopLoading,
    });
  };
}
