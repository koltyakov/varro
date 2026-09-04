import type { Message, Part, Session, SessionStatus } from '../../types';
import type { QueuedAttachmentSnapshot } from './session-send';
import type { UsageLimitNotice } from '../../lib/usage-limit';
import { resolveTaskSessionId } from '../../lib/task-session';

type ResolvedModel = { providerID: string; modelID: string; variant?: string };
type SessionUsageLimitSnapshot =
  | UsageLimitNotice
  | Pick<UsageLimitNotice, 'sessionID' | 'attempt'>
  | null
  | undefined;

export async function reviewSessionWithDependencies(
  deps: {
    sendMessage(prompt: string): Promise<void | boolean | object>;
  },
  prompt = 'review the current changes in my code and provide feedback'
) {
  await deps.sendMessage(prompt);
}

export async function abortSessionWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    getSessionTreeRootId(sessionId: string): string | null;
    getSessionTreeIds(sessionId: string): string[];
    getSelectedAgentForSession(sessionId: string): string | null;
    skipPlanSession(sessionId: string): void;
    getSessionStatus(sessionId: string): SessionStatus | undefined;
    getSessionUsageLimit(sessionId: string): SessionUsageLimitSnapshot;
    markPendingAbortTree(sessionIds: string[]): void;
    setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
    stopLoading(): void;
    abortRemoteSession(sessionId: string): Promise<void | boolean | object>;
    clearPendingAbortTree(sessionIds: string[]): void;
    setSessionUsageLimit(sessionId: string, notice: SessionUsageLimitSnapshot): void;
    setError?(message: string): void;
    logError(context: string, cause: unknown): void;
  },
  targetSessionId = deps.getActiveSessionId()
) {
  const sessionId = targetSessionId;
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
  if (deps.getActiveSessionId() === sessionId) deps.stopLoading();

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
    deps.setError?.(
      err instanceof Error ? `Failed to stop the run: ${err.message}` : 'Failed to stop the run'
    );
    deps.logError('abortSession', err);
    throw err;
  }
}

export async function undoSessionWithDependencies(deps: {
  getActiveSessionId(): string | null;
  getMessages(): Array<{ info: Message }>;
  startLoading(): () => boolean;
  revertSession(sessionId: string, messageId: string): Promise<void | boolean | object>;
  syncSession(sessionId: string): Promise<void | boolean | object>;
  syncSessionMessages(sessionId: string): Promise<void | boolean | object>;
  stopLoading(): void;
  setError(message: string): void;
}) {
  const sessionId = deps.getActiveSessionId();
  if (!sessionId) return;

  const lastAssistant = [...deps.getMessages()]
    .toReversed()
    .find((entry) => entry.info.role === 'assistant' && entry.info.sessionID === sessionId);
  if (!lastAssistant) return;

  const isCurrent = deps.startLoading();
  try {
    await deps.revertSession(sessionId, lastAssistant.info.id);
    await Promise.all([deps.syncSession(sessionId), deps.syncSessionMessages(sessionId)]);
    if (isCurrent()) deps.stopLoading();
  } catch (err) {
    if (isCurrent()) {
      deps.stopLoading();
      deps.setError(err instanceof Error ? err.message : 'Failed to undo');
    }
  }
}

export async function editMessageWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    getMessages(): Array<{ info: Message; parts?: Part[] }>;
    isSessionWorking(sessionId: string): boolean;
    abortSession(sessionId: string): Promise<void | boolean | object>;
    startLoading(): void;
    invalidateMessageSync?(sessionId: string): void;
    deferMessageRemovals?(sessionId: string, messageIds: string[]): () => void;
    pruneMessagesFrom?(sessionId: string, messageId: string): (() => void) | null;
    getSessions?(): Session[];
    getSessionTreeIds?(sessionId: string): string[];
    abortActiveSessionTree?(sessionId: string): Promise<void>;
    moveSessionTreeToRecycleBin?(sessionId: string): Promise<void>;
    restoreSessionTreeFromRecycleBin?(sessionId: string): Promise<void | boolean>;
    deleteMessage(sessionId: string, messageId: string): Promise<void | boolean | object>;
    syncSessionMessages(sessionId: string): Promise<void | boolean | object>;
    sendEditedMessage(
      text: string,
      sessionId: string,
      queuedAttachments?: QueuedAttachmentSnapshot
    ): Promise<boolean>;
    prepareEditedMessageSend?(
      text: string,
      sessionId: string,
      queuedAttachments?: QueuedAttachmentSnapshot,
      selectedModel?: ResolvedModel
    ): (beforeOptimisticPublish?: () => void) => Promise<boolean>;
    stopLoading(): void;
    setError(message: string): void;
  },
  messageId: string,
  text: string,
  options?: {
    allowEmptyText?: boolean;
    queuedAttachments?: QueuedAttachmentSnapshot;
    selectedModel?: ResolvedModel;
    onOptimisticPublish?: () => void;
  }
) {
  const sessionId = deps.getActiveSessionId();
  if (!sessionId || (!options?.allowEmptyText && !text.trim())) return false;

  const messages = deps.getMessages();
  const targetIndex = messages.findIndex(
    (entry) => entry.info.role === 'user' && entry.info.id === messageId
  );
  const target = messages[targetIndex];
  if (!target || target.info.role !== 'user' || target.info.sessionID !== sessionId) return false;

  const messagesToDelete = messages
    .slice(targetIndex)
    .filter((entry) => entry.info.sessionID === sessionId)
    .toReversed();
  const childSessions = getDiscardedTaskSessions(
    messagesToDelete,
    messages,
    deps.getSessions?.() ?? [],
    sessionId,
    deps.getSessionTreeIds
  );
  const selectedModel = options?.selectedModel ?? target.info.model;
  const sendEditedMessage = deps.prepareEditedMessageSend
    ? deps.prepareEditedMessageSend(text, sessionId, options?.queuedAttachments, selectedModel)
    : (beforeOptimisticPublish?: () => void) => {
        beforeOptimisticPublish?.();
        return deps.sendEditedMessage(text, sessionId, options?.queuedAttachments);
      };
  let historyPruned = false;
  const pruneHistory = () => {
    if (historyPruned) return;
    historyPruned = true;
    deps.pruneMessagesFrom?.(sessionId, messageId);
  };
  let releaseDeferredRemovals: (() => void) | undefined;
  let removalsReleased = false;
  const releaseRemovals = () => {
    if (removalsReleased) return;
    removalsReleased = true;
    releaseDeferredRemovals?.();
  };
  let replacementPublished = false;
  let successfulParentDeletions = 0;
  let parentDeletionStarted = false;
  const recycleAttempts: Array<{
    sessionId: string;
    launchMessageId: string;
    confirmed: boolean;
  }> = [];
  const recoverRecycledChildren = async (attempts: typeof recycleAttempts, failures: string[]) => {
    const restoredSessionIds = new Set<string>();
    for (const attempt of attempts.toReversed()) {
      try {
        const restored = await deps.restoreSessionTreeFromRecycleBin?.(attempt.sessionId);
        if (restored === false && attempt.confirmed) {
          throw new Error('restore returned false');
        }
        if (restored === false) continue;
        restoredSessionIds.add(attempt.sessionId);
        for (const restoredSessionId of deps.getSessionTreeIds?.(attempt.sessionId) ?? []) {
          restoredSessionIds.add(restoredSessionId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown restore error';
        failures.push(`restore ${attempt.sessionId}: ${message}`);
      }
    }
    const sessionIdsToSync = [...restoredSessionIds];
    const syncResults = await Promise.allSettled(
      sessionIdsToSync.map((sessionIdToSync) => deps.syncSessionMessages(sessionIdToSync))
    );
    for (const [index, result] of syncResults.entries()) {
      if (result.status === 'fulfilled') continue;
      const message = result.reason instanceof Error ? result.reason.message : 'unknown sync error';
      failures.push(`sync ${sessionIdsToSync[index]}: ${message}`);
    }
  };
  const publishReplacement = () => {
    if (replacementPublished) return;
    replacementPublished = true;
    options?.onOptimisticPublish?.();
    pruneHistory();
    releaseRemovals();
  };
  try {
    deps.startLoading();
    deps.invalidateMessageSync?.(sessionId);
    if (deps.isSessionWorking(sessionId)) {
      await deps.abortSession(sessionId);
    }
    if (childSessions.length > 0) {
      if (
        !deps.abortActiveSessionTree ||
        !deps.moveSessionTreeToRecycleBin ||
        !deps.restoreSessionTreeFromRecycleBin
      ) {
        throw new Error('Cannot safely remove child sessions launched by this message');
      }
      for (const childSession of childSessions) {
        await deps.abortActiveSessionTree(childSession.sessionId);
        const attempt = { ...childSession, confirmed: false };
        recycleAttempts.push(attempt);
        await deps.moveSessionTreeToRecycleBin(childSession.sessionId);
        attempt.confirmed = true;
      }
    }
    releaseDeferredRemovals = deps.deferMessageRemovals?.(
      sessionId,
      messagesToDelete.map((message) => message.info.id)
    );
    // Session revert also restores filesystem snapshots; direct history deletion does not.
    for (const message of messagesToDelete) {
      parentDeletionStarted = true;
      await deps.deleteMessage(sessionId, message.info.id);
      successfulParentDeletions += 1;
    }
  } catch (err) {
    releaseRemovals();
    const recoveryFailures: string[] = [];
    let parentSyncSucceeded = false;
    try {
      await deps.syncSessionMessages(sessionId);
      parentSyncSucceeded = true;
    } catch (syncErr) {
      const message = syncErr instanceof Error ? syncErr.message : 'unknown sync error';
      recoveryFailures.push(`sync ${sessionId}: ${message}`);
    }
    let attemptsToRestore = recycleAttempts;
    if (parentDeletionStarted && successfulParentDeletions > 0 && parentSyncSucceeded) {
      const remainingMessageIds = new Set(
        deps
          .getMessages()
          .filter((entry) => entry.info.sessionID === sessionId)
          .map((entry) => entry.info.id)
      );
      attemptsToRestore = recycleAttempts.filter((attempt) =>
        remainingMessageIds.has(attempt.launchMessageId)
      );
    }
    await recoverRecycledChildren(attemptsToRestore, recoveryFailures);
    const recoveryError =
      recoveryFailures.length > 0
        ? new Error(
            `Rollback failed for recycled child sessions (${recoveryFailures.join('; ')}). Check the recycle bin and reload the affected sessions.`
          )
        : undefined;
    if (deps.getActiveSessionId() === sessionId) {
      deps.stopLoading();
      const editError = err instanceof Error ? err.message : 'Failed to edit message';
      const recoveryMessage =
        recoveryError instanceof Error ? recoveryError.message : 'Rollback failed';
      deps.setError(
        recoveryError ? `${editError}. Rollback also failed: ${recoveryMessage}` : editError
      );
    }
    return false;
  }

  try {
    if (await sendEditedMessage(publishReplacement)) {
      releaseRemovals();
      return true;
    }
  } catch (err) {
    if (deps.getActiveSessionId() === sessionId) {
      deps.setError(err instanceof Error ? err.message : 'Failed to send edited message');
    }
  }
  pruneHistory();
  releaseRemovals();
  await Promise.allSettled([deps.syncSessionMessages(sessionId)]);
  if (deps.getActiveSessionId() === sessionId) deps.stopLoading();
  return false;
}

function getDiscardedTaskSessions(
  discardedMessages: Array<{ info: Message; parts?: Part[] }>,
  allMessages: Array<{ info: Message; parts?: Part[] }>,
  sessions: Session[],
  parentSessionId: string,
  getSessionTreeIds?: (sessionId: string) => string[]
) {
  const normalizedMessages = allMessages.map((entry) => ({
    info: entry.info,
    parts: entry.parts ?? [],
  }));
  const discardedKeys = new Set(
    discardedMessages.map((entry) => `${entry.info.sessionID}\0${entry.info.id}`)
  );
  const resolved = new Map<string, { sessionId: string; launchMessageId: string }>();

  for (const entry of normalizedMessages) {
    if (!discardedKeys.has(`${entry.info.sessionID}\0${entry.info.id}`)) continue;
    const nextUserCreated = normalizedMessages.find(
      (candidate) =>
        candidate.info.sessionID === entry.info.sessionID &&
        candidate.info.role === 'user' &&
        candidate.info.time.created > entry.info.time.created
    )?.info.time.created;
    for (const part of entry.parts) {
      if (part.type !== 'tool') continue;
      const childSessionId = resolveTaskSessionId(
        part,
        normalizedMessages,
        sessions,
        nextUserCreated
      );
      if (childSessionId && isSessionDescendantOf(childSessionId, parentSessionId, sessions)) {
        resolved.set(childSessionId, {
          sessionId: childSessionId,
          launchMessageId: entry.info.id,
        });
      }
    }
  }

  const branches = [...resolved.values()];
  if (!getSessionTreeIds || branches.length < 2) return branches;
  return branches.filter(
    (branch) =>
      !branches.some(
        (other) =>
          other.sessionId !== branch.sessionId &&
          getSessionTreeIds(other.sessionId).includes(branch.sessionId)
      )
  );
}

function isSessionDescendantOf(sessionId: string, parentSessionId: string, sessions: Session[]) {
  const sessionById = new Map(sessions.map((session) => [session.id, session] as const));
  const visited = new Set<string>();
  let current = sessionById.get(sessionId);
  while (current?.parentID && !visited.has(current.id)) {
    if (current.parentID === parentSessionId) return true;
    visited.add(current.id);
    current = sessionById.get(current.parentID);
  }
  return false;
}

export async function redoSessionWithDependencies(deps: {
  getActiveSessionId(): string | null;
  startLoading(): () => boolean;
  unrevertSession(sessionId: string): Promise<Session>;
  upsertSession(session: Session): void;
  syncSession(sessionId: string): Promise<void | boolean | object>;
  syncSessionMessages(sessionId: string): Promise<void | boolean | object>;
  stopLoading(): void;
  setError(message: string): void;
}) {
  const sessionId = deps.getActiveSessionId();
  if (!sessionId) return;

  const isCurrent = deps.startLoading();
  try {
    const session = await deps.unrevertSession(sessionId);
    deps.upsertSession(session);
    await Promise.all([deps.syncSession(sessionId), deps.syncSessionMessages(sessionId)]);
    if (isCurrent()) deps.stopLoading();
  } catch (err) {
    if (isCurrent()) {
      deps.stopLoading();
      deps.setError(err instanceof Error ? err.message : 'Failed to redo');
    }
  }
}

export async function compactSessionWithDependencies(deps: {
  getActiveSessionId(): string | null;
  clearPendingAbort(sessionId: string): void;
  resolveSelectedModel(): ResolvedModel | null;
  setError(message: string): void;
  setSessionCompacting(sessionId: string, compacting: boolean): void;
  startLoading(): () => boolean;
  compactRemoteSession(
    sessionId: string,
    input: { providerID: string; modelID: string }
  ): Promise<void | boolean | object>;
  syncSession(sessionId: string): Promise<void | boolean | object>;
  syncSessionMessages(sessionId: string): Promise<void | boolean | object>;
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

  const isCurrent = deps.startLoading();
  try {
    deps.setSessionCompacting(sessionId, true);
    await deps.compactRemoteSession(sessionId, {
      providerID: effectiveModel.providerID,
      modelID: effectiveModel.modelID,
    });
    await Promise.all([deps.syncSession(sessionId), deps.syncSessionMessages(sessionId)]);
    const compacting = deps.getSession(sessionId)?.time.compacting;
    if (!compacting) {
      deps.setSessionCompacting(sessionId, false);
    }
    if (isCurrent()) deps.stopLoading();
  } catch (err) {
    deps.setSessionCompacting(sessionId, false);
    if (isCurrent()) {
      deps.stopLoading();
      deps.setError(err instanceof Error ? err.message : 'Failed to compact session');
    }
  }
}

type SessionControlDependencies = {
  getActiveSessionId(): string | null;
  sendMessage(prompt: string): Promise<void | boolean | object>;
  getSessionTreeRootId(sessionId: string): string | null;
  getSessionTreeIds(sessionId: string): string[];
  getSelectedAgentForSession(sessionId: string): string | null;
  skipPlanSession(sessionId: string): void;
  getSessionStatus(sessionId: string): SessionStatus | undefined;
  getSessionUsageLimit(sessionId: string): SessionUsageLimitSnapshot;
  markPendingAbortTree(sessionIds: string[]): void;
  setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
  stopLoading(): void;
  abortRemoteSession(sessionId: string): Promise<void | boolean | object>;
  clearPendingAbortTree(sessionIds: string[]): void;
  setSessionUsageLimit(sessionId: string, notice: SessionUsageLimitSnapshot): void;
  logError(context: string, cause: unknown): void;
  getMessages(): Array<{ info: Message; parts?: Part[] }>;
  startLoading(): () => boolean;
  revertSession(sessionId: string, messageId: string): Promise<void | boolean | object>;
  syncSession(sessionId: string): Promise<void | boolean | object>;
  syncSessionMessages(sessionId: string): Promise<void | boolean | object>;
  setError(message: string): void;
  isSessionWorking(sessionId: string): boolean;
  sendEditedMessage(
    text: string,
    sessionId: string,
    queuedAttachments?: QueuedAttachmentSnapshot
  ): Promise<boolean>;
  prepareEditedMessageSend?(
    text: string,
    sessionId: string,
    queuedAttachments?: QueuedAttachmentSnapshot,
    selectedModel?: ResolvedModel
  ): (beforeOptimisticPublish?: () => void) => Promise<boolean>;
  invalidateMessageSync(sessionId: string): void;
  deferMessageRemovals(sessionId: string, messageIds: string[]): () => void;
  pruneMessagesFrom(sessionId: string, messageId: string): (() => void) | null;
  getSessions(): Session[];
  moveSessionTreeToRecycleBin(sessionId: string): Promise<void>;
  restoreSessionTreeFromRecycleBin(sessionId: string): Promise<void | boolean>;
  deleteMessage(sessionId: string, messageId: string): Promise<void | boolean | object>;
  unrevertSession(sessionId: string): Promise<Session>;
  upsertSession(session: Session): void;
  clearPendingAbort(sessionId: string): void;
  resolveSelectedModel(): ResolvedModel | null;
  setSessionCompacting(sessionId: string, compacting: boolean): void;
  compactRemoteSession(
    sessionId: string,
    input: { providerID: string; modelID: string }
  ): Promise<void | boolean | object>;
  getSession(sessionId: string): Session | undefined;
};

export class SessionControlOperations {
  constructor(private readonly deps: SessionControlDependencies) {}

  readonly reviewSession = async () => {
    await reviewSessionWithDependencies({
      sendMessage: this.deps.sendMessage,
    });
  };

  readonly abortSession = async (sessionId = this.deps.getActiveSessionId()) => {
    if (!sessionId) return;
    await abortSessionWithDependencies(
      {
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
        setError: this.deps.setError,
        logError: this.deps.logError,
      },
      sessionId
    );
  };

  private readonly abortActiveSessionTree = async (sessionId: string) => {
    const activeSessionIds = this.deps.getSessionTreeIds(sessionId).filter((id) => {
      const status = this.deps.getSessionStatus(id);
      return status?.type === 'busy' || status?.type === 'retry';
    });
    if (activeSessionIds.length === 0) return;

    const previousStatuses = new Map(
      activeSessionIds.map((id) => [id, this.deps.getSessionStatus(id)] as const)
    );
    this.deps.markPendingAbortTree(activeSessionIds);
    for (const id of activeSessionIds) {
      this.deps.setSessionStatusEntry(id, { type: 'idle' });
    }
    try {
      await Promise.all(activeSessionIds.map((id) => this.deps.abortRemoteSession(id)));
    } catch (err) {
      this.deps.clearPendingAbortTree(activeSessionIds);
      for (const id of activeSessionIds) {
        const previousStatus = previousStatuses.get(id);
        if (previousStatus) this.deps.setSessionStatusEntry(id, previousStatus);
      }
      throw err;
    }
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
    options?: {
      allowEmptyText?: boolean;
      queuedAttachments?: QueuedAttachmentSnapshot;
      selectedModel?: ResolvedModel;
      onOptimisticPublish?: () => void;
    }
  ) => {
    return await editMessageWithDependencies(
      {
        getActiveSessionId: this.deps.getActiveSessionId,
        getMessages: this.deps.getMessages,
        isSessionWorking: this.deps.isSessionWorking,
        abortSession: this.abortSession,
        startLoading: this.deps.startLoading,
        invalidateMessageSync: this.deps.invalidateMessageSync,
        deferMessageRemovals: this.deps.deferMessageRemovals,
        pruneMessagesFrom: this.deps.pruneMessagesFrom,
        getSessions: this.deps.getSessions,
        getSessionTreeIds: this.deps.getSessionTreeIds,
        abortActiveSessionTree: this.abortActiveSessionTree,
        moveSessionTreeToRecycleBin: this.deps.moveSessionTreeToRecycleBin,
        restoreSessionTreeFromRecycleBin: this.deps.restoreSessionTreeFromRecycleBin,
        deleteMessage: this.deps.deleteMessage,
        syncSessionMessages: this.deps.syncSessionMessages,
        sendEditedMessage: this.deps.sendEditedMessage,
        prepareEditedMessageSend: this.deps.prepareEditedMessageSend,
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
