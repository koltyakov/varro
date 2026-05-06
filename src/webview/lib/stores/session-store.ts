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
    setState('sessionStatus', (current) => ({
      ...current,
      [sessionId]: status,
    }));
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
