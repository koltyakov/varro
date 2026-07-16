import { appStore } from '../../lib/stores/app-store';
import { sessionStore } from '../../lib/stores/session-store';
import type { SessionStatusSnapshotOptions } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import { deriveUsageLimitNotice } from '../../lib/usage-limit';
import type { UsageLimitNotice } from '../../lib/usage-limit';
import {
  getLatestAssistantFinishedAt,
  latestAssistantFinished,
  latestAssistantFinishedBeforeLoading,
} from '../../lib/message-metrics';
import { isRunningSessionStatus } from '../../lib/session-event-reducer';
import type { MessageEntry, SessionStatus } from '../../types';

type SessionStatusSnapshot = {
  statuses: Record<string, SessionStatus>;
  startedAt: number;
};

type SessionStatusDependencies = {
  pendingAbortRetryAttempts: Map<string, number | null>;
  deriveUsageLimitNoticeContext(
    sessionId: string,
    messages?: MessageEntry[]
  ): { providerID: string; modelID: string | null | undefined } | null;
  refreshProviderLimit(providerID: string, modelID?: string | null): Promise<void>;
  isDocumentVisible(): boolean;
  shouldResyncSessionAfterIdle(sessionId: string): boolean;
  syncSession(sessionId: string): Promise<void>;
  syncSessionMessages(sessionId: string): Promise<void>;
  syncBusySessionMessages?(sessionId: string): Promise<void>;
  loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
  loadSessionStatusSnapshot?(): Promise<SessionStatusSnapshot>;
  isActiveSession(sessionId: string): boolean;
  getMessages?(): MessageEntry[];
  logError(context: string, err: unknown): void;
};

export class SessionStatusOperations {
  private readonly rechecks = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionStatusDependencies) {}

  readonly setSessionStatusEntry = (sessionId: string, status: SessionStatus) => {
    sessionStore.setSessionStatusEntry(sessionId, status);
  };

  readonly clearPendingAbort = (sessionId: string | null | undefined) => {
    clearPendingAbortWithDependencies(
      { pendingAbortRetryAttempts: this.deps.pendingAbortRetryAttempts },
      sessionId
    );
  };

  readonly hasPendingAbort = (sessionId: string | null | undefined) => {
    return hasPendingAbortWithDependencies(
      { pendingAbortRetryAttempts: this.deps.pendingAbortRetryAttempts },
      sessionId
    );
  };

  readonly clearPendingAbortTree = (sessionIds: string[]) => {
    clearPendingAbortTreeWithDependencies(
      { pendingAbortRetryAttempts: this.deps.pendingAbortRetryAttempts },
      sessionIds
    );
  };

  readonly markPendingAbortTree = (sessionIds: string[]) => {
    markPendingAbortTreeWithDependencies(
      {
        pendingAbortRetryAttempts: this.deps.pendingAbortRetryAttempts,
        getSessionStatus: (sessionId) => appStore.state.sessionStatus[sessionId],
      },
      sessionIds
    );
  };

  readonly markPendingAbort = (sessionId: string) => {
    markPendingAbortWithDependencies(
      {
        pendingAbortRetryAttempts: this.deps.pendingAbortRetryAttempts,
        getSessionStatus: (id) => appStore.state.sessionStatus[id],
      },
      sessionId
    );
  };

  readonly shouldIgnorePendingAbortStatus = (
    sessionId: string,
    status: SessionStatus | null | undefined
  ) => {
    return shouldIgnorePendingAbortStatusWithDependencies(
      { pendingAbortRetryAttempts: this.deps.pendingAbortRetryAttempts },
      sessionId,
      status
    );
  };

  readonly clearUsageLimitOnResumedProgress = (
    sessionID: string,
    nextStatus?: SessionStatus | null
  ) => {
    clearUsageLimitOnResumedProgressWithDependencies(
      {
        getSessionUsageLimit: (sessionId) => appStore.state.sessionUsageLimits[sessionId],
        setSessionUsageLimit: sessionStore.setSessionUsageLimit,
      },
      sessionID,
      nextStatus
    );
  };

  readonly applyUsageLimitNotice = (
    sessionID: string,
    notice: UsageLimitNotice | null,
    options?: { preserveExistingOnNull?: boolean }
  ) => {
    applyUsageLimitNoticeWithDependencies(
      {
        setSessionUsageLimit: sessionStore.setSessionUsageLimit,
        refreshProviderLimit: this.deps.refreshProviderLimit,
      },
      sessionID,
      notice,
      options
    );
  };

  readonly updateUsageLimitState = (
    sessionID: string,
    status: SessionStatus | null | undefined,
    messages = appStore.state.messages
  ) => {
    updateUsageLimitStateWithDependencies(
      {
        deriveUsageLimitNoticeContext: this.deps.deriveUsageLimitNoticeContext,
        applyUsageLimitNotice: this.applyUsageLimitNotice,
      },
      sessionID,
      status,
      messages
    );
  };

  readonly recheckSessionStatus = (sessionId: string): Promise<void> => {
    const existing = this.rechecks.get(sessionId);
    if (existing) return existing;

    const recheck = recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: this.deps.isDocumentVisible,
        loadSessionStatuses: this.deps.loadSessionStatuses,
        loadSessionStatusSnapshot: this.deps.loadSessionStatusSnapshot,
        shouldIgnorePendingAbortStatus: this.shouldIgnorePendingAbortStatus,
        hasPendingAbort: this.hasPendingAbort,
        updateUsageLimitState: this.updateUsageLimitState,
        clearPendingAbort: this.clearPendingAbort,
        stopLoading: uiStore.stopLoading,
        setSessionStatusEntry: sessionStore.setSessionStatusEntry,
        setSessionStatuses: sessionStore.setSessionStatuses,
        shouldResyncSessionAfterIdle: this.deps.shouldResyncSessionAfterIdle,
        syncSession: this.deps.syncSession,
        syncSessionMessages: this.deps.syncSessionMessages,
        syncBusySessionMessages: this.deps.syncBusySessionMessages,
        startLoading: uiStore.startLoading,
        loadingStartedAt: uiStore.loadingStartedAt,
        isActiveSession: this.deps.isActiveSession,
        getCurrentSessionStatus: (id) => appStore.state.sessionStatus[id],
        getMessages: this.deps.getMessages,
        logError: this.deps.logError,
      },
      sessionId
    ).finally(() => {
      this.rechecks.delete(sessionId);
    });
    this.rechecks.set(sessionId, recheck);
    return recheck;
  };
}

export function clearPendingAbortWithDependencies(
  deps: { pendingAbortRetryAttempts: Map<string, number | null> },
  sessionId: string | null | undefined
) {
  if (!sessionId) return;
  deps.pendingAbortRetryAttempts.delete(sessionId);
}

export function hasPendingAbortWithDependencies(
  deps: { pendingAbortRetryAttempts: Map<string, number | null> },
  sessionId: string | null | undefined
) {
  return sessionId ? deps.pendingAbortRetryAttempts.has(sessionId) : false;
}

export function clearPendingAbortTreeWithDependencies(
  deps: { pendingAbortRetryAttempts: Map<string, number | null> },
  sessionIds: string[]
) {
  for (const sessionId of sessionIds) {
    clearPendingAbortWithDependencies(deps, sessionId);
  }
}

export function markPendingAbortWithDependencies(
  deps: {
    pendingAbortRetryAttempts: Map<string, number | null>;
    getSessionStatus(sessionId: string): SessionStatus | null | undefined;
  },
  sessionId: string
) {
  const status = deps.getSessionStatus(sessionId);
  deps.pendingAbortRetryAttempts.set(sessionId, status?.type === 'retry' ? status.attempt : null);
}

export function markPendingAbortTreeWithDependencies(
  deps: {
    pendingAbortRetryAttempts: Map<string, number | null>;
    getSessionStatus(sessionId: string): SessionStatus | null | undefined;
  },
  sessionIds: string[]
) {
  for (const sessionId of sessionIds) {
    markPendingAbortWithDependencies(deps, sessionId);
  }
}

export function shouldIgnorePendingAbortStatusWithDependencies(
  deps: { pendingAbortRetryAttempts: Map<string, number | null> },
  sessionId: string,
  status: SessionStatus | null | undefined
) {
  if (!deps.pendingAbortRetryAttempts.has(sessionId)) return false;
  if (!status || status.type === 'idle') return false;
  if (status.type === 'busy') return true;
  if (status.type !== 'retry') return false;

  const abortedAttempt = deps.pendingAbortRetryAttempts.get(sessionId);
  return abortedAttempt == null || status.attempt >= abortedAttempt;
}

export function clearUsageLimitOnResumedProgressWithDependencies(
  deps: {
    getSessionUsageLimit(sessionId: string): UsageLimitNotice | null | undefined;
    setSessionUsageLimit(sessionId: string, notice: UsageLimitNotice | null): void;
  },
  sessionID: string,
  nextStatus?: SessionStatus | null
) {
  const current = deps.getSessionUsageLimit(sessionID);
  if (!current) return;
  if (nextStatus?.type === 'retry') return;
  if (nextStatus?.type === 'busy' && current.source === 'message') return;
  deps.setSessionUsageLimit(sessionID, null);
}

export function applyUsageLimitNoticeWithDependencies(
  deps: {
    setSessionUsageLimit(sessionId: string, notice: UsageLimitNotice | null): void;
    refreshProviderLimit(providerID: string, modelID?: string | null): Promise<void>;
  },
  sessionID: string,
  notice: UsageLimitNotice | null,
  options?: { preserveExistingOnNull?: boolean }
) {
  if (notice) {
    deps.setSessionUsageLimit(sessionID, { ...notice, sessionID });
    if (notice.providerID) {
      void deps.refreshProviderLimit(notice.providerID, notice.modelID);
    }
    return;
  }

  if (!options?.preserveExistingOnNull) {
    deps.setSessionUsageLimit(sessionID, null);
  }
}

export function updateUsageLimitStateWithDependencies(
  deps: {
    deriveUsageLimitNoticeContext(
      sessionId: string,
      messages?: MessageEntry[]
    ): { providerID: string; modelID: string | null | undefined } | null;
    applyUsageLimitNotice(
      sessionId: string,
      notice: UsageLimitNotice | null,
      options?: { preserveExistingOnNull?: boolean }
    ): void;
  },
  sessionID: string,
  status: SessionStatus | null | undefined,
  messages: MessageEntry[]
) {
  const rawNotice = deriveUsageLimitNotice({ sessionID, status, messages });
  const context = rawNotice?.providerID
    ? null
    : deps.deriveUsageLimitNoticeContext(sessionID, messages);
  const notice =
    rawNotice && context
      ? {
          ...rawNotice,
          sessionID,
          providerID: context.providerID,
          modelID: rawNotice.modelID || context.modelID,
        }
      : rawNotice;
  deps.applyUsageLimitNotice(sessionID, notice, {
    preserveExistingOnNull: status?.type === 'idle',
  });
}

export async function recheckSessionStatusWithDependencies(
  deps: {
    isDocumentVisible(): boolean;
    loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
    loadSessionStatusSnapshot?(): Promise<SessionStatusSnapshot>;
    shouldIgnorePendingAbortStatus(
      sessionId: string,
      status: SessionStatus | null | undefined
    ): boolean;
    hasPendingAbort(sessionId: string | null | undefined): boolean;
    updateUsageLimitState(sessionId: string, status: SessionStatus | null | undefined): void;
    clearPendingAbort(sessionId: string | null | undefined): void;
    stopLoading(): void;
    setSessionStatusEntry?(sessionId: string, status: SessionStatus): void;
    setSessionStatuses(
      statuses: Record<string, SessionStatus>,
      options?: SessionStatusSnapshotOptions
    ): void;
    shouldResyncSessionAfterIdle(sessionId: string): boolean;
    syncSession(sessionId: string): Promise<void>;
    syncSessionMessages(sessionId: string): Promise<void>;
    syncBusySessionMessages?(sessionId: string): Promise<void>;
    startLoading(): void;
    loadingStartedAt?(): number | null;
    isActiveSession(sessionId: string): boolean;
    getCurrentSessionStatus?(sessionId: string): SessionStatus | null | undefined;
    getMessages?(): MessageEntry[];
    logError(context: string, err: unknown): void;
  },
  sessionId: string
) {
  if (!deps.isDocumentVisible()) return;
  try {
    const fallbackStartedAt = Date.now();
    const snapshot = deps.loadSessionStatusSnapshot
      ? await deps.loadSessionStatusSnapshot()
      : { statuses: await deps.loadSessionStatuses(), startedAt: fallbackStartedAt };
    const { statuses } = snapshot;
    const status = statuses[sessionId];
    if (deps.shouldIgnorePendingAbortStatus(sessionId, status)) return;
    deps.setSessionStatuses(
      { ...statuses, [sessionId]: status ?? { type: 'idle' } },
      { snapshotStartedAt: snapshot.startedAt }
    );

    const abortedRetry = deps.hasPendingAbort(sessionId);
    if (!(abortedRetry && (!status || status.type === 'idle'))) {
      deps.updateUsageLimitState(sessionId, status);
    }
    if (!status || status.type === 'idle') {
      deps.clearPendingAbort(sessionId);
      const syncs: Array<PromiseSettledResult<void>> = [
        await settleVoid(deps.syncSession(sessionId)),
      ];
      let syncedMessages = false;
      const shouldSyncMessages = deps.shouldResyncSessionAfterIdle(sessionId);
      if (shouldSyncMessages) {
        const result = await settleVoid(deps.syncSessionMessages(sessionId));
        syncedMessages = result.status === 'fulfilled';
        syncs.push(result);
      }
      logRejectedSyncs(deps, syncs);
      if (deps.isActiveSession(sessionId)) {
        const messages = deps.getMessages?.() ?? [];
        const currentStatus = deps.getCurrentSessionStatus?.(sessionId);
        if (hasUnsettledLatestTurn(messages)) {
          deps.startLoading();
        } else if (
          syncedMessages &&
          latestAssistantFinished(messages) &&
          isRunningSessionStatus(currentStatus)
        ) {
          deps.setSessionStatusEntry?.(sessionId, { type: 'idle' });
          deps.stopLoading();
        } else if (
          isRunningSessionStatus(currentStatus) ||
          latestAssistantFinishedBeforeCurrentLoading(messages, deps.loadingStartedAt?.() ?? null)
        ) {
          deps.startLoading();
        } else {
          deps.stopLoading();
        }
      }
      return;
    }

    if (status.type === 'retry' && deps.isActiveSession(sessionId)) {
      deps.startLoading();
    } else if (status.type === 'busy' && deps.isActiveSession(sessionId)) {
      const syncResult = await settleVoid(
        (deps.syncBusySessionMessages ?? deps.syncSessionMessages)(sessionId)
      );
      logRejectedSyncs(deps, [syncResult]);
      const messages = deps.getMessages?.() ?? [];
      const currentStatus = deps.getCurrentSessionStatus?.(sessionId) ?? status;
      if (
        !isRunningSessionStatus(currentStatus) &&
        latestAssistantFinishedBeforeLoading(messages, deps.loadingStartedAt?.() ?? null)
      ) {
        deps.setSessionStatusEntry?.(sessionId, { type: 'idle' });
        deps.stopLoading();
      } else deps.startLoading();
    }
  } catch (err) {
    deps.logError('recheckSessionStatus', err);
  }
}

async function settleVoid(promise: Promise<void>): Promise<PromiseSettledResult<void>> {
  try {
    await promise;
    return { status: 'fulfilled', value: undefined };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function logRejectedSyncs(
  deps: { logError(context: string, err: unknown): void },
  results: PromiseSettledResult<void>[]
) {
  for (const result of results) {
    if (result.status === 'rejected') deps.logError('recheckSessionStatusSync', result.reason);
  }
}

function hasUnsettledLatestTurn(messages: MessageEntry[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]?.info;
    if (!message) continue;
    if (message.role === 'user') return true;
    return !message.error && !message.time.completed;
  }
  return false;
}

function latestAssistantFinishedBeforeCurrentLoading(
  messages: MessageEntry[],
  loadingStartedAt: number | null
) {
  const finishedAt = getLatestAssistantFinishedAt(messages);
  return finishedAt !== null && loadingStartedAt !== null && loadingStartedAt > finishedAt;
}
