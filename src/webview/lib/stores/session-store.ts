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
  hasActivePermission,
  hasActiveQuestion,
  hasActiveUsageLimit,
  isSessionAwaitingInput,
  isSessionCompacting,
  isSessionUnread,
  isSkippedPlanSession,
  markRunningToolPartsAborted,
  markSessionSeen,
  persistLastOpenedView,
  persistActiveSessionId,
  removeMessagePart,
  replaceMessages,
  setMessagesIncremental,
  setRecycleBinEntries,
  setSessionCompacting,
  setSessionFailed,
  setSessions,
  setSessionUsageLimit,
  setState,
  skipPlanSession,
  syncFailedSessionsFromMessages,
  upsertMessage,
  upsertMessageInfo,
  upsertPart,
} from '../state';

export const sessionStore = {
  persistActiveSessionId,
  getPersistedActiveSessionId,
  persistLastOpenedView,
  getPersistedLastOpenedView,
  markSessionSeen,
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
  markRunningToolPartsAborted,
  getSessionTreeIds,
  getSessionTreeRootId,
  getActiveUsageLimitNotice,
  hasActiveUsageLimit,
  syncFailedSessionsFromMessages,
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
  setSessionStatuses(statuses: Record<string, SessionStatus>) {
    setState('sessionStatus', statuses);
  },
  setSessionStatusEntry(sessionId: string, status: SessionStatus) {
    setState('sessionStatus', (current) => {
      const prev = current[sessionId];
      if (prev && isEqualSessionStatus(prev, status)) return current;
      return { ...current, [sessionId]: status };
    });
  },
  clearSessionStatusEntry(sessionId: string) {
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
