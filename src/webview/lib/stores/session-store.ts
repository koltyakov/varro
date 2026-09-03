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
// Once a snapshot acknowledges local markers, older snapshots must not apply after they are pruned.
let latestAppliedSessionStatusSnapshotStartedAt = Number.NEGATIVE_INFINITY;

export function captureSessionStatusSnapshotTime() {
  return captureSessionStateTime();
}

export function resetSessionStatusSnapshotTracking() {
  sessionStatusLocalUpdatedAt.clear();
  latestAppliedSessionStatusSnapshotStartedAt = Number.NEGATIVE_INFINITY;
  resetSessionStateClock();
}

export const sessionStore = {
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

    let reconciledStatuses = statuses;
    batch(() => {
      setState('sessionStatus', (current) => {
        if (snapshotStartedAt === undefined) {
          reconciledStatuses = areEqualSessionStatusRecords(current, statuses) ? current : statuses;
          return reconciledStatuses;
        }

        const next = { ...statuses };
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
    const prev = state.sessionStatus[sessionId];
    sessionStatusLocalUpdatedAt.set(sessionId, captureSessionStatusSnapshotTime());
    recordStatusCompletionTransition(sessionId, prev, status);
    batch(() => {
      setState('sessionStatus', (current) => {
        const currentStatus = current[sessionId];
        if (currentStatus && isEqualSessionStatus(currentStatus, status)) return current;
        return { ...current, [sessionId]: status };
      });
      clearQuestionResponsePending(sessionId);
    });
  },
  clearSessionStatusEntry(sessionId: string) {
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
