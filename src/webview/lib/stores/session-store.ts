import type { FileDiff, SessionStatus } from '../../types';
import { isRunningSessionStatus } from '../session-event-reducer';
import { produce } from 'solid-js/store';
import {
  applyMessagePartDelta,
  clearMessages,
  clearSessionSeen,
  clearSkippedPlanSession,
  clearStreamingState,
  getActiveUsageLimitNotice,
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
  removeMessagePart,
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

export function resetSessionStatusSnapshotTracking() {
  sessionStatusLocalUpdatedAt.clear();
  latestAppliedSessionStatusSnapshotStartedAt = Number.NEGATIVE_INFINITY;
}

export const sessionStore = {
  persistActiveSessionId,
  getPersistedActiveSessionId,
  persistLastOpenedView,
  getPersistedLastOpenedView,
  pruneMessagesFrom,
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
  hasActiveUsageLimit,
  syncFailedSessionsFromMessages,
  finishMessageStreaming,
  replaceMessages,
  setMessagesIncremental,
  upsertMessage,
  upsertMessageInfo,
  upsertPart,
  applyMessagePartDelta,
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
      return;
    }
    if (snapshotStartedAt !== undefined) {
      latestAppliedSessionStatusSnapshotStartedAt = snapshotStartedAt;
    }

    setState('sessionStatus', (current) => {
      if (snapshotStartedAt === undefined) {
        return areEqualSessionStatusRecords(current, statuses) ? current : statuses;
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
      return areEqualSessionStatusRecords(current, next) ? current : next;
    });
  },
  setSessionStatusEntry(sessionId: string, status: SessionStatus) {
    const prev = state.sessionStatus[sessionId];
    sessionStatusLocalUpdatedAt.set(sessionId, Date.now());
    recordStatusCompletionTransition(sessionId, prev, status);
    setState('sessionStatus', (current) => {
      const currentStatus = current[sessionId];
      if (currentStatus && isEqualSessionStatus(currentStatus, status)) return current;
      return { ...current, [sessionId]: status };
    });
  },
  clearSessionStatusEntry(sessionId: string) {
    sessionStatusLocalUpdatedAt.set(sessionId, Date.now());
    setState(
      'sessionStatus',
      produce((statuses) => {
        delete statuses[sessionId];
      })
    );
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

  if (state.activeSessionId === sessionId && !showSessionPicker()) markSessionSeen(sessionId);
  else markSessionResponseCompleted(sessionId);
}
