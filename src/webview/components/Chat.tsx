import {
  desktopSessionPaneSide,
  state,
  showSessionPicker,
  setShowSessionPicker,
  showSettings,
  openAttentionSessionsKey,
  isSessionAwaitingInput,
  getSessionTreeRootId,
} from '../lib/state';
import { createSignal, onMount, onCleanup, createEffect, createMemo, on } from 'solid-js';
import { selectSession, createSession, deleteSession } from '../hooks/useOpenCode';
import { normalizeSessionTitle } from '../../shared/session-title';
import { ChatWorkspace } from './chat/ChatWorkspace';
import {
  deriveSessionIndicators,
  getPrimarySessionsForFilter,
  getSessionListFilterLabel,
  isPrimarySession,
  shouldShowSessionHeaderBadge,
} from './chat/SessionListView';
import type { SessionListFilter } from './chat/SessionListView';

type HeaderSessionCounts = {
  running: number;
  attention: number;
  failed: number;
  planReady: number;
  completed: number;
  sidebarRunning: number;
  sidebarAttention: number;
  sidebarFailed: number;
  sidebarPlanReady: number;
  sidebarCompleted: number;
};

const DESKTOP_SESSION_LAYOUT_MEDIA_QUERY = '(min-width: 1400px)';
const RECONNECT_BANNER_SHOW_DELAY_MS = 1500;
const RECONNECT_BANNER_MIN_VISIBLE_MS = 4000;
const CHAT_VIEW_ENTER_DURATION_MS = 180;

export function Chat() {
  const [sessionFilter, setSessionFilter] = createSignal<SessionListFilter | null>(null);
  const [subagentParentId, setSubagentParentId] = createSignal<string | null>(null);
  const [isDesktopSessionLayout, setIsDesktopSessionLayout] = createSignal(false);
  const [isCreatingSessionFromPicker, setIsCreatingSessionFromPicker] = createSignal(false);
  const [isEnteringChatView, setIsEnteringChatView] = createSignal(false);
  const [showReconnectBanner, setShowReconnectBanner] = createSignal(false);
  const isDesktopSessionPaneRight = () => desktopSessionPaneSide() === 'right';
  const primarySessions = createMemo(() => state.sessions.filter(isPrimarySession));
  const sessionIndicators = createMemo(() => deriveSessionIndicators(state.sessions));
  const sessionsById = createMemo(
    () => new Map(state.sessions.map((session) => [session.id, session]))
  );
  const isEventStreamDegraded = createMemo(
    () => state.serverStatus.state === 'running' && state.serverStatus.eventStream === 'degraded'
  );
  const shouldRenderWorkspace = () => !showSessionPicker() || isDesktopSessionLayout();
  let reconnectBannerShowTimer: number | undefined;
  let reconnectBannerHideTimer: number | undefined;
  let reconnectBannerVisibleSince = 0;
  let chatViewEnterTimer: number | undefined;

  const clearReconnectBannerShowTimer = () => {
    if (reconnectBannerShowTimer == null) return;
    window.clearTimeout(reconnectBannerShowTimer);
    reconnectBannerShowTimer = undefined;
  };

  const clearReconnectBannerHideTimer = () => {
    if (reconnectBannerHideTimer == null) return;
    window.clearTimeout(reconnectBannerHideTimer);
    reconnectBannerHideTimer = undefined;
  };

  const clearChatViewEnterTimer = () => {
    if (chatViewEnterTimer == null) return;
    window.clearTimeout(chatViewEnterTimer);
    chatViewEnterTimer = undefined;
  };

  onMount(() => {
    if (typeof window.matchMedia !== 'function') return;

    const mediaQuery = window.matchMedia(DESKTOP_SESSION_LAYOUT_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktopSessionLayout(event.matches);
    };

    setIsDesktopSessionLayout(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    onCleanup(() => mediaQuery.removeEventListener('change', handleChange));
  });

  createEffect(
    on(isEventStreamDegraded, (isDegraded) => {
      if (isDegraded) {
        clearReconnectBannerHideTimer();
        if (showReconnectBanner() || reconnectBannerShowTimer != null) return;

        reconnectBannerShowTimer = window.setTimeout(() => {
          reconnectBannerShowTimer = undefined;
          reconnectBannerVisibleSince = Date.now();
          setShowReconnectBanner(true);
        }, RECONNECT_BANNER_SHOW_DELAY_MS);
        return;
      }

      clearReconnectBannerShowTimer();
      if (!showReconnectBanner()) return;

      const remainingVisibleMs =
        RECONNECT_BANNER_MIN_VISIBLE_MS - (Date.now() - reconnectBannerVisibleSince);
      if (remainingVisibleMs <= 0) {
        reconnectBannerVisibleSince = 0;
        setShowReconnectBanner(false);
        return;
      }

      if (reconnectBannerHideTimer != null) return;
      reconnectBannerHideTimer = window.setTimeout(() => {
        reconnectBannerHideTimer = undefined;
        reconnectBannerVisibleSince = 0;
        if (!isEventStreamDegraded()) setShowReconnectBanner(false);
      }, remainingVisibleMs);
    })
  );

  onCleanup(() => {
    clearReconnectBannerShowTimer();
    clearReconnectBannerHideTimer();
    clearChatViewEnterTimer();
  });

  const shouldDiscardActiveBlankSession = () => {
    const sessionId = state.activeSessionId;
    if (!sessionId || state.messages.length > 0) return false;
    if (state.queuedMessages.some((item) => item.sessionId === sessionId)) return false;
    if (isSessionAwaitingInput(sessionId)) return false;
    const statusType = state.sessionStatus[sessionId]?.type;
    return statusType !== 'busy' && statusType !== 'retry';
  };

  const activeTitle = () => {
    if (!state.activeSessionId) return 'New Chat';
    const session = sessionsById().get(state.activeSessionId);
    return normalizeSessionTitle(session?.title) || 'New Chat';
  };

  const headerSessionCounts = createMemo(() => {
    const indicators = sessionIndicators();
    return getHeaderSessionCounts(
      primarySessions(),
      state.activeSessionId,
      showSessionPicker(),
      (sessionId) => indicators.runningIds.has(sessionId),
      (sessionId) => indicators.attentionIds.has(sessionId),
      (sessionId) => indicators.failedIds.has(sessionId),
      (session) => indicators.planReadyIds.has(session.id),
      (session) => indicators.newlyCompletedIds.has(session.id)
    );
  });
  const runningSessionsCount = () => headerSessionCounts().running;
  const attentionSessionsCount = () => headerSessionCounts().attention;
  const failedSessionsCount = () => headerSessionCounts().failed;
  const planReadySessionsCount = () => headerSessionCounts().planReady;
  const completedSessionsCount = () => headerSessionCounts().completed;
  const sessionSidebarRunningCount = () => headerSessionCounts().sidebarRunning;
  const sessionSidebarAttentionCount = () => headerSessionCounts().sidebarAttention;
  const sessionSidebarFailedCount = () => headerSessionCounts().sidebarFailed;
  const sessionSidebarPlanReadyCount = () => headerSessionCounts().sidebarPlanReady;
  const sessionSidebarCompletedCount = () => headerSessionCounts().sidebarCompleted;
  const primarySessionsCount = () => primarySessions().length;

  const openSessionFilter = async (filter: SessionListFilter, count: number) => {
    if (count === 0) return;

    const indicators = sessionIndicators();
    const autoOpenSessionId = getAutoOpenSessionIdForFilter(
      primarySessions(),
      filter,
      state.activeSessionId,
      showSessionPicker(),
      (sessionId) => indicators.runningIds.has(sessionId),
      (sessionId) => indicators.attentionIds.has(sessionId),
      (sessionId) => indicators.failedIds.has(sessionId),
      (session) => indicators.planReadyIds.has(session.id),
      (session) => indicators.newlyCompletedIds.has(session.id)
    );

    if (autoOpenSessionId) {
      setSessionFilter(null);
      setSubagentParentId(null);
      await selectSession(autoOpenSessionId);
      return;
    }

    setSubagentParentId(null);
    setSessionFilter(filter);
    setShowSessionPicker(true);
  };

  createEffect(() => {
    if (!showSessionPicker()) {
      setSessionFilter(null);
      setSubagentParentId(null);
    }
  });

  createEffect(
    on(showSessionPicker, (isOpen, wasOpen) => {
      clearChatViewEnterTimer();

      if (isOpen || !wasOpen) {
        setIsEnteringChatView(false);
        return;
      }

      setIsEnteringChatView(true);
      chatViewEnterTimer = window.setTimeout(() => {
        chatViewEnterTimer = undefined;
        setIsEnteringChatView(false);
      }, CHAT_VIEW_ENTER_DURATION_MS);
    })
  );

  createEffect(
    on(
      openAttentionSessionsKey,
      () => {
        openAttentionSessionsFromCommand();
      },
      { defer: true }
    )
  );

  const openAllSessions = async () => {
    setSessionFilter(null);
    setSubagentParentId(null);
    const sessionId = state.activeSessionId;
    if (sessionId && shouldDiscardActiveBlankSession()) {
      setShowSessionPicker(true);
      await deleteSession(sessionId);
      return;
    }
    setShowSessionPicker(true);
  };

  const openRunningSessions = () => {
    void openSessionFilter('running', runningSessionsCount());
  };

  const openAttentionSessions = () => {
    void openSessionFilter('attention', attentionSessionsCount());
  };

  const openAttentionSessionsFromCommand = () => {
    void openSessionFilter(
      'attention',
      getHeaderAttentionCount(
        primarySessions(),
        (sessionId) => sessionIndicators().attentionIds.has(sessionId),
        state.activeSessionId,
        false
      )
    );
  };

  const openFailedSessions = () => {
    void openSessionFilter('failed', failedSessionsCount());
  };

  const openPlanReadySessions = () => {
    void openSessionFilter('plan-ready', planReadySessionsCount());
  };

  const openCompletedSessions = () => {
    void openSessionFilter('completed', completedSessionsCount());
  };

  const openSubagentSessions = (parentSessionId: string) => {
    setSessionFilter(null);
    setSubagentParentId(parentSessionId);
    setShowSessionPicker(true);
  };

  const activeRootSessionId = createMemo(() => getSessionTreeRootId(state.activeSessionId) || null);
  const activeSubagentCount = createMemo(() => {
    const rootSessionId = activeRootSessionId();
    if (!rootSessionId) return 0;
    return sessionIndicators().subagentCounts.get(rootSessionId) || 0;
  });
  const activeSubagentLabel = createMemo(() => {
    const count = activeSubagentCount();
    return `Show ${count} sub-agent session${count === 1 ? '' : 's'}`;
  });

  const clearSessionListView = () => {
    setSessionFilter(null);
    setSubagentParentId(null);
  };
  const createSessionFromPicker = async () => {
    if (isCreatingSessionFromPicker()) return;

    setIsCreatingSessionFromPicker(true);
    try {
      const createdId = await createSession();
      if (createdId) setShowSessionPicker(false);
    } finally {
      setIsCreatingSessionFromPicker(false);
    }
  };
  const activeSubagentParent = createMemo(() => {
    const parentId = subagentParentId();
    if (!parentId) return null;
    return sessionsById().get(parentId) || null;
  });
  const sessionListFilterLabel = createMemo(() => {
    if (subagentParentId()) return 'Sub-agents';
    return getSessionListFilterLabel(sessionFilter());
  });
  const sessionListFilterPrefix = createMemo(() => (subagentParentId() ? 'Viewing:' : 'Filtered:'));
  const sessionListFilterTitle = createMemo(() => {
    const subagentParent = activeSubagentParent();
    if (subagentParent) {
      return `Sub-agents for ${normalizeSessionTitle(subagentParent.title) || 'Untitled'}`;
    }

    const label = sessionListFilterLabel();
    return label ? `Filtered by ${label}` : undefined;
  });
  const shouldShowHeaderBadge = (filter: SessionListFilter) =>
    shouldShowSessionHeaderBadge(sessionFilter(), filter);

  return (
    <ChatWorkspace
      isEnteringChatView={isEnteringChatView()}
      shouldRenderWorkspace={shouldRenderWorkspace()}
      isDesktopSessionPaneRight={isDesktopSessionPaneRight()}
      showSessionPicker={showSessionPicker()}
      showSettings={showSettings()}
      showReconnectBanner={showReconnectBanner()}
      sessionFilter={sessionFilter()}
      subagentParentId={subagentParentId()}
      sessionListFilterLabel={sessionListFilterLabel()}
      sessionListFilterPrefix={sessionListFilterPrefix()}
      sessionListFilterTitle={sessionListFilterTitle()}
      primarySessionsCount={primarySessionsCount()}
      shouldShowFailedBadge={shouldShowHeaderBadge('failed')}
      shouldShowAttentionBadge={shouldShowHeaderBadge('attention')}
      shouldShowPlanReadyBadge={shouldShowHeaderBadge('plan-ready')}
      shouldShowCompletedBadge={shouldShowHeaderBadge('completed')}
      shouldShowRunningBadge={shouldShowHeaderBadge('running')}
      failedSessionsCount={failedSessionsCount()}
      attentionSessionsCount={attentionSessionsCount()}
      planReadySessionsCount={planReadySessionsCount()}
      completedSessionsCount={completedSessionsCount()}
      runningSessionsCount={runningSessionsCount()}
      sessionSidebarFailedCount={sessionSidebarFailedCount()}
      sessionSidebarAttentionCount={sessionSidebarAttentionCount()}
      sessionSidebarPlanReadyCount={sessionSidebarPlanReadyCount()}
      sessionSidebarCompletedCount={sessionSidebarCompletedCount()}
      sessionSidebarRunningCount={sessionSidebarRunningCount()}
      isCreatingSessionFromPicker={isCreatingSessionFromPicker()}
      activeTitle={activeTitle()}
      activeSubagentRootId={activeSubagentCount() > 0 ? activeRootSessionId() : null}
      activeSubagentLabel={activeSubagentLabel()}
      onClearSessionListView={clearSessionListView}
      onOpenAllSessions={() => {
        void openAllSessions();
      }}
      onOpenSubagentSessions={openSubagentSessions}
      onOpenFailedSessions={openFailedSessions}
      onOpenAttentionSessions={openAttentionSessions}
      onOpenPlanReadySessions={openPlanReadySessions}
      onOpenCompletedSessions={openCompletedSessions}
      onOpenRunningSessions={openRunningSessions}
      onCreateSessionFromPicker={() => {
        void createSessionFromPicker();
      }}
      onCreateSession={() => {
        void createSession();
      }}
    />
  );
}

export {
  SessionListSectionHeader,
  archiveSessionGroup,
  deriveSessionIndicators,
  getPrimarySessionsForFilter,
  getSessionListFilterLabel,
  getSubagentSessionsForParent,
  groupSessions,
  isFailedSession,
  isRunningSession,
  shouldShowSessionHeaderBadge,
} from './chat/SessionListView';
export type { SessionListFilter } from './chat/SessionListView';

export function getAttentionSessions(
  sessions: typeof state.sessions,
  isNeedingAttention: (sessionId: string) => boolean
) {
  return sessions.filter((session) => isNeedingAttention(session.id));
}

export function getAutoOpenSessionIdForFilter(
  sessions: typeof state.sessions,
  filter: SessionListFilter,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean,
  isRunning: (sessionId: string) => boolean,
  isNeedingAttention: (sessionId: string) => boolean,
  isFailed: (sessionId: string) => boolean,
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean,
  isCompleted: (session: (typeof state.sessions)[number]) => boolean
) {
  if (isSessionPickerOpen) return null;

  const matchingSessions = getPrimarySessionsForFilter(
    sessions,
    filter,
    isRunning,
    isNeedingAttention,
    isFailed,
    isPlanReady,
    isCompleted
  ).filter((session) => session.id !== activeSessionId);

  return matchingSessions.length === 1 ? matchingSessions[0]?.id || null : null;
}

export function getOtherSessions(
  sessions: typeof state.sessions,
  isNeedingAttention: (sessionId: string) => boolean
) {
  return sessions.filter((session) => !isNeedingAttention(session.id));
}

export function getHeaderAttentionCount(
  sessions: typeof state.sessions,
  isNeedingAttention: (sessionId: string) => boolean,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean
) {
  return getAttentionSessions(sessions, isNeedingAttention).reduce((count, session) => {
    if (!isPrimarySession(session)) return count;
    if (!isSessionPickerOpen && session.id === activeSessionId) return count;
    return count + 1;
  }, 0);
}

export function getHeaderFailedCount(
  sessions: typeof state.sessions,
  isFailed: (sessionId: string) => boolean,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean
) {
  return sessions.reduce((count, session) => {
    if (!isPrimarySession(session) || !isFailed(session.id)) return count;
    if (!isSessionPickerOpen && session.id === activeSessionId) return count;
    return count + 1;
  }, 0);
}

export function getHeaderRunningCount(
  sessions: typeof state.sessions,
  isRunning: (sessionId: string) => boolean,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean
) {
  return sessions.reduce((count, session) => {
    if (!isPrimarySession(session) || !isRunning(session.id)) return count;
    if (!isSessionPickerOpen && session.id === activeSessionId) return count;
    return count + 1;
  }, 0);
}

export function getHeaderPlanReadyCount(
  sessions: typeof state.sessions,
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean
) {
  return sessions.reduce((count, session) => {
    if (!isPrimarySession(session) || !isPlanReady(session)) return count;
    if (!isSessionPickerOpen && session.id === activeSessionId) return count;
    return count + 1;
  }, 0);
}

export function getHeaderCompletedCount(
  sessions: typeof state.sessions,
  isCompleted: (session: (typeof state.sessions)[number]) => boolean,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean
) {
  return sessions.reduce((count, session) => {
    if (!isPrimarySession(session) || !isCompleted(session)) return count;
    if (!isSessionPickerOpen && session.id === activeSessionId) return count;
    return count + 1;
  }, 0);
}

function getHeaderSessionCounts(
  sessions: typeof state.sessions,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean,
  isRunning: (sessionId: string) => boolean,
  isNeedingAttention: (sessionId: string) => boolean,
  isFailed: (sessionId: string) => boolean,
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean,
  isCompleted: (session: (typeof state.sessions)[number]) => boolean
): HeaderSessionCounts {
  const counts: HeaderSessionCounts = {
    running: 0,
    attention: 0,
    failed: 0,
    planReady: 0,
    completed: 0,
    sidebarRunning: 0,
    sidebarAttention: 0,
    sidebarFailed: 0,
    sidebarPlanReady: 0,
    sidebarCompleted: 0,
  };

  for (const session of sessions) {
    if (!isPrimarySession(session)) continue;

    const includeHeader = isSessionPickerOpen || session.id !== activeSessionId;
    if (isFailed(session.id)) {
      counts.sidebarFailed += 1;
      if (includeHeader) counts.failed += 1;
    }
    if (isPlanReady(session)) {
      counts.sidebarPlanReady += 1;
      if (includeHeader) counts.planReady += 1;
    }
    if (isCompleted(session)) {
      counts.sidebarCompleted += 1;
      if (includeHeader) counts.completed += 1;
    }
    if (isNeedingAttention(session.id)) {
      counts.sidebarAttention += 1;
      if (includeHeader) counts.attention += 1;
    }
    if (isRunning(session.id)) {
      counts.sidebarRunning += 1;
      if (includeHeader) counts.running += 1;
    }
  }

  return counts;
}

export function getArchiveSessionGroupConfirmationMessage(label: string, count: number) {
  return `Archive ${count} session${count === 1 ? '' : 's'} in ${label}? This cannot be undone.`;
}
