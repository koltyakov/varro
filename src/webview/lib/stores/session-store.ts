import type { FileDiff, SessionStatus } from '../../types';
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
const sessionStatusLocallyIdle = new Set<string>();

export const sessionStore = {
  persistActiveSessionId,
  getPersistedActiveSessionId,
  persistLastOpenedView,
  getPersistedLastOpenedView,
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
    setState('sessionStatus', (current) => {
      if (options?.snapshotStartedAt === undefined) return statuses;

      const next = { ...statuses };
      for (const sessionId of sessionStatusLocalUpdatedAt.keys()) {
        const updatedAt = sessionStatusLocalUpdatedAt.get(sessionId) || 0;
        const currentStatus = current[sessionId];
        const incomingStatus = next[sessionId];
        const hasNewerLocalUpdate = updatedAt > options.snapshotStartedAt;
        const hasLocalIdleAfterWork =
          sessionStatusLocallyIdle.has(sessionId) &&
          currentStatus?.type === 'idle' &&
          isRunningSessionStatus(incomingStatus);
        const activeRootId = getSessionTreeRootId(state.activeSessionId) || state.activeSessionId;
        const sessionRootId = getSessionTreeRootId(sessionId) || sessionId;
        const hasLocalRunningWithoutSettledMessage =
          !!activeRootId &&
          sessionRootId === activeRootId &&
          isRunningSessionStatus(currentStatus) &&
          (!incomingStatus || incomingStatus.type === 'idle') &&
          !hasSettledLatestAssistantMessage(sessionId);
        const hasSettledMessageIdle =
          currentStatus?.type === 'idle' &&
          isRunningSessionStatus(incomingStatus) &&
          hasSettledLatestAssistantMessage(sessionId);
        if (
          !hasNewerLocalUpdate &&
          !hasLocalIdleAfterWork &&
          !hasLocalRunningWithoutSettledMessage &&
          !hasSettledMessageIdle
        ) {
          continue;
        }
        if (currentStatus) next[sessionId] = currentStatus;
        else delete next[sessionId];
      }
      return next;
    });
  },
  setSessionStatusEntry(sessionId: string, status: SessionStatus) {
    const prev = state.sessionStatus[sessionId];
    sessionStatusLocalUpdatedAt.set(sessionId, Date.now());
    if (status.type === 'idle') sessionStatusLocallyIdle.add(sessionId);
    else sessionStatusLocallyIdle.delete(sessionId);
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

function isRunningSessionStatus(status: SessionStatus | undefined): boolean {
  return status?.type === 'busy' || status?.type === 'retry';
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
