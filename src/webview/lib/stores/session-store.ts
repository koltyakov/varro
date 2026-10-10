import type { FileDiff, SessionStatus } from '../../types';
import { isRunningSessionStatus } from '../session-event-reducer';
import { batch } from 'solid-js';
import { produce } from 'solid-js/store';
import { readWebviewInstanceContext } from '../state-stored-values';
import { captureSessionStateTime, resetSessionStateClock } from '../session-state-clock';
import { clearQuestionResponsePending } from '../state-permissions';
import {
  applyMessagePartDelta,
  clearMessages,
  clearSessionSeen,
  clearSkippedPlanSession,
  clearStreamingState,
  getActiveUsageLimitNotice,
  getMessageById,
  getMessagePartById,
  getPersistedLastOpenedView,
  getPersistedActiveSessionId,
  syncDraftPermissionForWorkspace,
  getSessionTreeIds,
  getSessionTreeRootId,
  hasSettledLatestAssistantMessage,
  hasActivePermission,
  hasActiveQuestion,
  hasActiveUsageLimit,
  isSessionAwaitingInput,
  isSessionCompacting,
  isSessionUnread,
  isSkippedPlanSession,
  markSessionSeen,
  markSessionResponseCompleted,
  persistLastOpenedView,
  persistActiveSessionId,
  pruneMessagesFrom,
  removeMessage,
  removeMessagePart,
  removeMessagesForSessions,
  replaceMessages,
  setMessagesIncremental,
  setRecycleBinEntries,
  showSessionPicker,
  setSessionCompacting,
  setSessionFailed,
  setSessions,
  setSessionUsageLimit,
  setState,
  state,
  skipPlanSession,
  syncFailedSessionsFromMessages,
  finishMessageStreaming,
  upsertMessage,
  upsertMessageInfo,
  upsertPart,
} from '../state';

export type SessionStatusSnapshotOptions = {
  snapshotStartedAt?: number;
};

const sessionStatusLocalUpdatedAt = new Map<string, number>();
const backgroundServicesUpdatedAt = new Map<string, number>();
const scheduledProviderRetries = new Map<string, Extract<SessionStatus, { type: 'retry' }>>();
const providerRetryCancellations = new Map<string, () => void>();
// Once a snapshot acknowledges local markers, older snapshots must not apply after they are pruned.
let latestAppliedSessionStatusSnapshotStartedAt = Number.NEGATIVE_INFINITY;

export function captureSessionStatusSnapshotTime() {
  return captureSessionStateTime();
}

export function resetSessionStatusSnapshotTracking() {
  sessionStatusLocalUpdatedAt.clear();
  backgroundServicesUpdatedAt.clear();
  scheduledProviderRetries.clear();
  providerRetryCancellations.clear();
  latestAppliedSessionStatusSnapshotStartedAt = Number.NEGATIVE_INFINITY;
  resetSessionStateClock();
}

export const sessionStore = {
  getBackgroundServiceCount(sessionId: string | null | undefined): number {
    if (!sessionId) return 0;
    const saved = state.sessionBackgroundServices[sessionId];
    if (saved !== undefined) return saved;
    const status = state.sessionStatus[sessionId];
    return status?.type === 'idle' || status?.type === 'busy'
      ? (status.backgroundServices ?? 0)
      : 0;
  },
  isProviderRetryScheduled(sessionId: string) {
    return scheduledProviderRetries.has(sessionId);
  },
  cancelProviderRetry(sessionId: string) {
    providerRetryCancellations.get(sessionId)?.();
  },
  retainProviderRetryStatus(
    sessionId: string,
    status: Extract<SessionStatus, { type: 'retry' }> | null,
    cancel?: () => void
  ) {
    if (status) scheduledProviderRetries.set(sessionId, status);
    else scheduledProviderRetries.delete(sessionId);
    if (cancel) providerRetryCancellations.set(sessionId, cancel);
    else providerRetryCancellations.delete(sessionId);
  },
  persistActiveSessionId,
  getPersistedActiveSessionId,
  persistLastOpenedView,
  getPersistedLastOpenedView,
  pruneMessagesFrom,
  removeMessagesForSessions,
  markSessionSeen,
  markSessionResponseCompleted,
  clearSessionSeen,
  skipPlanSession,
  clearSkippedPlanSession,
  isSkippedPlanSession,
  isSessionUnread,
  setSessionCompacting,
  isSessionCompacting,
  hasActiveQuestion,
  hasActivePermission,
  isSessionAwaitingInput,
  setSessions,
  setRecycleBinEntries,
  clearMessages,
  clearStreamingState,
  setSessionFailed,
  setSessionUsageLimit,
  getSessionTreeIds,
  getSessionTreeRootId,
  getActiveUsageLimitNotice,
  getMessageById,
  getMessagePartById,
  hasActiveUsageLimit,
  syncFailedSessionsFromMessages,
  finishMessageStreaming,
  replaceMessages,
  setMessagesIncremental,
  upsertMessage,
  upsertMessageInfo,
  upsertPart,
  applyMessagePartDelta,
  removeMessage,
  removeMessagePart,
  setActiveSessionId(sessionId: string | null) {
    setState('activeSessionId', sessionId);
  },
  setDiffs(diffs: FileDiff[]) {
    setState('diffs', diffs);
  },
  syncWorkspaceState(path: string | null) {
    syncDraftPermissionForWorkspace(path);
  },
  /**
   * True when a status snapshot started before this session's latest local status change or before
   * an already applied snapshot. Its view of the session predates what the webview now shows.
   */
  isSessionStatusSnapshotStale(sessionId: string, snapshotStartedAt: number) {
    if (snapshotStartedAt < latestAppliedSessionStatusSnapshotStartedAt) return true;
    const localUpdatedAt = sessionStatusLocalUpdatedAt.get(sessionId);
    return localUpdatedAt !== undefined && snapshotStartedAt < localUpdatedAt;
  },
  setSessionStatuses(
    statuses: Record<string, SessionStatus>,
    options?: SessionStatusSnapshotOptions
  ) {
    const snapshotStartedAt = options?.snapshotStartedAt;
    if (
      snapshotStartedAt !== undefined &&
      snapshotStartedAt < latestAppliedSessionStatusSnapshotStartedAt
    ) {
      return null;
    }
    if (snapshotStartedAt !== undefined) {
      latestAppliedSessionStatusSnapshotStartedAt = snapshotStartedAt;
    }

    // The backend is idle during a client-owned backoff. Its snapshots must not
    // remove the countdown or the stop control while that timer still owns the turn.
    const effectiveStatuses = { ...statuses };
    for (const [sessionId, retry] of scheduledProviderRetries) {
      if (!statuses[sessionId] || statuses[sessionId]?.type === 'idle') {
        effectiveStatuses[sessionId] = retry;
      }
    }
    let reconciledStatuses = effectiveStatuses;
    batch(() => {
      setState('sessionBackgroundServices', (current) => {
        let next: Record<string, number> | undefined;
        for (const sessionId of new Set([...Object.keys(current), ...Object.keys(statuses)])) {
          const updatedAt = backgroundServicesUpdatedAt.get(sessionId);
          if (
            snapshotStartedAt !== undefined &&
            updatedAt !== undefined &&
            updatedAt > snapshotStartedAt
          )
            continue;
          if (snapshotStartedAt !== undefined && updatedAt !== undefined)
            backgroundServicesUpdatedAt.delete(sessionId);
          const status = statuses[sessionId];
          const count =
            status?.type === 'idle' || status?.type === 'busy'
              ? (status.backgroundServices ?? 0)
              : 0;
          if (
            !Number.isSafeInteger(count) ||
            count < 0 ||
            current[sessionId] === count ||
            (current[sessionId] === undefined && count === 0)
          )
            continue;
          next ??= { ...current };
          next[sessionId] = count;
        }
        return next ?? current;
      });
      setState('sessionStatus', (current) => {
        if (snapshotStartedAt === undefined) {
          reconciledStatuses = areEqualSessionStatusRecords(current, effectiveStatuses)
            ? current
            : effectiveStatuses;
          return reconciledStatuses;
        }

        const next = { ...effectiveStatuses };
        for (const [sessionId, updatedAt] of sessionStatusLocalUpdatedAt) {
          if (updatedAt <= snapshotStartedAt) {
            sessionStatusLocalUpdatedAt.delete(sessionId);
            continue;
          }

          const currentStatus = current[sessionId];
          if (currentStatus) next[sessionId] = currentStatus;
          else delete next[sessionId];
        }

        const activeRootId = getSessionTreeRootId(state.activeSessionId) || state.activeSessionId;
        for (const sessionId of getSessionTreeIds(activeRootId)) {
          const currentStatus = current[sessionId];
          const incomingStatus = next[sessionId];
          if (
            currentStatus &&
            isRunningSessionStatus(currentStatus) &&
            (!incomingStatus || incomingStatus.type === 'idle') &&
            !hasSettledLatestAssistantMessage(sessionId)
          ) {
            next[sessionId] = currentStatus;
          }
        }
        reconciledStatuses = areEqualSessionStatusRecords(current, next) ? current : next;
        return reconciledStatuses;
      });
      for (let index = state.questionResponsePendingSessionIds.length - 1; index >= 0; index -= 1) {
        clearQuestionResponsePending(
          state.questionResponsePendingSessionIds[index]!,
          snapshotStartedAt
        );
      }
    });
    return reconciledStatuses;
  },
  setSessionStatusEntry(sessionId: string, status: SessionStatus) {
    const incomingServiceCount =
      status.type === 'idle' || status.type === 'busy' ? status.backgroundServices : undefined;
    const previousServiceCount = sessionStore.getBackgroundServiceCount(sessionId);
    const retainedServiceCount =
      state.sessionBackgroundServices[sessionId] === undefined && previousServiceCount > 0
        ? previousServiceCount
        : undefined;
    if (status.type === 'idle') status = scheduledProviderRetries.get(sessionId) ?? status;
    const prev = state.sessionStatus[sessionId];
    sessionStatusLocalUpdatedAt.set(sessionId, captureSessionStatusSnapshotTime());
    recordStatusCompletionTransition(sessionId, prev, status);
    batch(() => {
      const count = incomingServiceCount ?? retainedServiceCount;
      if (count !== undefined && Number.isSafeInteger(count) && count >= 0) {
        if (incomingServiceCount !== undefined)
          backgroundServicesUpdatedAt.set(sessionId, captureSessionStatusSnapshotTime());
        if (state.sessionBackgroundServices[sessionId] !== count)
          setState('sessionBackgroundServices', sessionId, count);
      }
      setState('sessionStatus', (current) => {
        const currentStatus = current[sessionId];
        if (currentStatus && isEqualSessionStatus(currentStatus, status)) return current;
        return { ...current, [sessionId]: status };
      });
      clearQuestionResponsePending(sessionId);
    });
  },
  clearSessionStatusEntry(sessionId: string) {
    sessionStore.cancelProviderRetry(sessionId);
    scheduledProviderRetries.delete(sessionId);
    sessionStatusLocalUpdatedAt.set(sessionId, captureSessionStatusSnapshotTime());
    batch(() => {
      setState(
        'sessionStatus',
        produce((statuses) => {
          delete statuses[sessionId];
        })
      );
      clearQuestionResponsePending(sessionId);
    });
  },
};

export type SessionStore = typeof sessionStore;

function isEqualSessionStatus(a: SessionStatus, b: SessionStatus): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'idle' && b.type === 'idle') return a.backgroundServices === b.backgroundServices;
  if (a.type === 'busy' && b.type === 'busy')
    return (
      !!a.background === !!b.background &&
      a.backgroundStartedAt === b.backgroundStartedAt &&
      a.backgroundCommand === b.backgroundCommand &&
      a.backgroundServices === b.backgroundServices
    );
  if (a.type === 'retry' && b.type === 'retry') {
    return a.attempt === b.attempt && a.message === b.message && a.next === b.next;
  }
  return true;
}

function areEqualSessionStatusRecords(
  a: Record<string, SessionStatus>,
  b: Record<string, SessionStatus>
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    const left = a[key];
    const right = b[key];
    if (!left || !right || !isEqualSessionStatus(left, right)) return false;
  }

  return true;
}

function recordStatusCompletionTransition(
  sessionId: string,
  prev: SessionStatus | undefined,
  next: SessionStatus
) {
  if (!isRunningSessionStatus(prev) || next.type !== 'idle') return;
  if (state.failedSessionIds.includes(sessionId)) return;
  if (hasActiveUsageLimit(sessionId)) return;
  if (isSessionAwaitingInput(sessionId)) return;

  const isActiveSessionVisible =
    state.activeSessionId === sessionId &&
    (readWebviewInstanceContext()?.surface === 'editor' || !showSessionPicker());
  if (isActiveSessionVisible) markSessionSeen(sessionId);
  else markSessionResponseCompleted(sessionId);
}
