import { appStore } from '../../lib/stores/app-store';
import { sessionStore } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import { deriveUsageLimitNotice } from '../../lib/usage-limit';
import type { UsageLimitNotice } from '../../lib/usage-limit';
import type { Message, Part, SessionStatus } from '../../types';

type SessionMessageEntry = { info: Message; parts: Part[] };

type SessionStatusDependencies = {
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
  isActiveSession(sessionId: string): boolean;
  logError(context: string, err: unknown): void;
};

export class SessionStatusOperations {
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

  readonly recheckSessionStatus = async (sessionId: string) => {
    await recheckSessionStatusWithDependencies(
      {
        isDocumentVisible: this.deps.isDocumentVisible,
        loadSessionStatuses: this.deps.loadSessionStatuses,
        shouldIgnorePendingAbortStatus: this.shouldIgnorePendingAbortStatus,
        hasPendingAbort: this.hasPendingAbort,
        updateUsageLimitState: this.updateUsageLimitState,
        clearPendingAbort: this.clearPendingAbort,
        stopLoading: uiStore.stopLoading,
        shouldResyncSessionAfterIdle: this.deps.shouldResyncSessionAfterIdle,
        syncSessionMessages: this.deps.syncSessionMessages,
        startLoading: uiStore.startLoading,
        isActiveSession: this.deps.isActiveSession,
        logError: this.deps.logError,
      },
      sessionId
    );
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
    isActiveSession(sessionId: string): boolean;
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
      if (deps.isActiveSession(sessionId)) {
        deps.stopLoading();
      }
      if (deps.shouldResyncSessionAfterIdle(sessionId)) {
        await deps.syncSessionMessages(sessionId).catch(() => {});
      }
      return;
    }

    if ((status.type === 'busy' || status.type === 'retry') && deps.isActiveSession(sessionId)) {
      deps.startLoading();
    }
  } catch (err) {
    deps.logError('recheckSessionStatus', err);
  }
}
