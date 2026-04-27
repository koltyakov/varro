import { setSessionUsageLimit, setState, startLoading, state, stopLoading } from '../lib/state';
import type { UsageLimitNotice } from '../lib/usage-limit';
import { deriveUsageLimitNotice } from '../lib/usage-limit';
import type { Message, Part, SessionStatus } from '../types';

type SessionMessageEntry = { info: Message; parts: Part[] };

export function createSessionStatusOperations(deps: {
  pendingAbortRetryAttempts: Map<string, number | null>;
  deriveUsageLimitNoticeContext(
    sessionId: string,
    messages?: SessionMessageEntry[]
  ): { providerID: string; modelID: string | null | undefined } | null;
  refreshProviderLimit(providerID: string, modelID?: string | null): Promise<void>;
  isDocumentVisible(): boolean;
  shouldResyncSessionAfterIdle(sessionId: string): boolean;
  syncSessionMessages(sessionId: string): Promise<void>;
  loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
  logError(context: string, err: unknown): void;
}) {
  const setSessionStatusEntry = (sessionId: string, status: SessionStatus) => {
    setState('sessionStatus', (current) => ({
      ...current,
      [sessionId]: status,
    }));
  };

  const clearPendingAbort = (sessionId: string | null | undefined) => {
    clearPendingAbortWithDependencies(
      { pendingAbortRetryAttempts: deps.pendingAbortRetryAttempts },
      sessionId
    );
  };

  const hasPendingAbort = (sessionId: string | null | undefined) => {
    return hasPendingAbortWithDependencies(
      { pendingAbortRetryAttempts: deps.pendingAbortRetryAttempts },
      sessionId
    );
  };

  const clearPendingAbortTree = (sessionIds: string[]) => {
    clearPendingAbortTreeWithDependencies(
      { pendingAbortRetryAttempts: deps.pendingAbortRetryAttempts },
      sessionIds
    );
  };

  const markPendingAbortTree = (sessionIds: string[]) => {
    markPendingAbortTreeWithDependencies(
      {
        pendingAbortRetryAttempts: deps.pendingAbortRetryAttempts,
        getSessionStatus: (sessionId) => state.sessionStatus[sessionId],
      },
      sessionIds
    );
  };

  const shouldIgnorePendingAbortStatus = (
    sessionId: string,
    status: SessionStatus | null | undefined
  ) => {
    return shouldIgnorePendingAbortStatusWithDependencies(
      { pendingAbortRetryAttempts: deps.pendingAbortRetryAttempts },
      sessionId,
      status
    );
  };

  const clearUsageLimitOnResumedProgress = (
    sessionID: string,
    nextStatus?: SessionStatus | null
  ) => {
    clearUsageLimitOnResumedProgressWithDependencies(
      {
        getSessionUsageLimit: (sessionId) => state.sessionUsageLimits[sessionId],
        setSessionUsageLimit,
      },
      sessionID,
      nextStatus
    );
  };

  const applyUsageLimitNotice = (
    sessionID: string,
    notice: UsageLimitNotice | null,
    options?: { preserveExistingOnNull?: boolean }
  ) => {
    applyUsageLimitNoticeWithDependencies(
      {
        setSessionUsageLimit,
        refreshProviderLimit: deps.refreshProviderLimit,
      },
      sessionID,
      notice,
      options
    );
  };

  const updateUsageLimitState = (
    sessionID: string,
    status: SessionStatus | null | undefined,
    messages = state.messages
  ) => {
    updateUsageLimitStateWithDependencies(
      {
        deriveUsageLimitNoticeContext: deps.deriveUsageLimitNoticeContext,
        applyUsageLimitNotice,
      },
      sessionID,
      status,
      messages
    );
  };

  const recheckSessionStatus = async (sessionId: string) => {
    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: deps.isDocumentVisible,
        loadSessionStatuses: deps.loadSessionStatuses,
        shouldIgnorePendingAbortStatus,
        hasPendingAbort,
        updateUsageLimitState,
        clearPendingAbort,
        stopLoading,
        shouldResyncSessionAfterIdle: deps.shouldResyncSessionAfterIdle,
        syncSessionMessages: deps.syncSessionMessages,
        startLoading,
        logError: deps.logError,
      },
      sessionId
    );
  };

  return {
    setSessionStatusEntry,
    clearPendingAbort,
    hasPendingAbort,
    clearPendingAbortTree,
    markPendingAbortTree,
    shouldIgnorePendingAbortStatus,
    clearUsageLimitOnResumedProgress,
    applyUsageLimitNotice,
    updateUsageLimitState,
    recheckSessionStatus,
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
      messages?: SessionMessageEntry[]
    ): { providerID: string; modelID: string | null | undefined } | null;
    applyUsageLimitNotice(
      sessionId: string,
      notice: UsageLimitNotice | null,
      options?: { preserveExistingOnNull?: boolean }
    ): void;
  },
  sessionID: string,
  status: SessionStatus | null | undefined,
  messages: SessionMessageEntry[]
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
    shouldIgnorePendingAbortStatus(
      sessionId: string,
      status: SessionStatus | null | undefined
    ): boolean;
    hasPendingAbort(sessionId: string | null | undefined): boolean;
    updateUsageLimitState(sessionId: string, status: SessionStatus | null | undefined): void;
    clearPendingAbort(sessionId: string | null | undefined): void;
    stopLoading(): void;
    shouldResyncSessionAfterIdle(sessionId: string): boolean;
    syncSessionMessages(sessionId: string): Promise<void>;
    startLoading(): void;
    logError(context: string, err: unknown): void;
  },
  sessionId: string
) {
  if (!deps.isDocumentVisible()) return;
  try {
    const statuses = await deps.loadSessionStatuses();
    const status = statuses[sessionId];
    if (deps.shouldIgnorePendingAbortStatus(sessionId, status)) return;

    const abortedRetry = deps.hasPendingAbort(sessionId);
    if (!(abortedRetry && (!status || status.type === 'idle'))) {
      deps.updateUsageLimitState(sessionId, status);
    }
    if (!status || status.type === 'idle') {
      deps.clearPendingAbort(sessionId);
      deps.stopLoading();
      if (deps.shouldResyncSessionAfterIdle(sessionId)) {
        await deps.syncSessionMessages(sessionId).catch(() => {});
      }
      return;
    }

    if (status.type === 'busy' || status.type === 'retry') {
      deps.startLoading();
    }
  } catch (err) {
    deps.logError('recheckSessionStatus', err);
  }
}
