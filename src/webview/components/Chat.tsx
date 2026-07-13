import {
  desktopSessionPaneSide,
  state,
  showSessionPicker,
  setPersistentShowSessionPicker as setShowSessionPicker,
  showSettings,
  openAttentionSessionsKey,
  sessionSearchFocusKey,
  isSessionAwaitingInput,
  getSessionTreeRootId,
  setShowSettings,
} from '../lib/state';
import { createSignal, onMount, onCleanup, createEffect, createMemo, on } from 'solid-js';
import { selectSession, deleteSessionImmediately } from '../hooks/useOpenCode';
import { normalizeSessionTitle } from '../../shared/session-title';
import { ChatWorkspace } from './chat/ChatWorkspace';
import { ralphStore } from '../lib/stores/ralph-store';
import { getDiscardableActiveBlankSessionId, startNewChatDraft } from '../lib/new-chat-draft';
import {
  shouldHideEmptySessionFromList,
  isEmptySession as isEmptySessionMetadata,
  shouldPruneEmptySession,
} from '../lib/empty-session';
import {
  deriveSessionIndicators,
  getPrimarySessionsForFilter,
  getSessionListFilterLabel,
  isPrimarySession,
  shouldShowSessionHeaderBadge,
} from './chat/SessionListView';
import type { SessionListFilter } from './chat/SessionListView';
import { onMessage, onSlowApiRequestsChange, type SlowApiRequest } from '../lib/bridge';
import { compareSessionsByActivity } from '../lib/session-order';

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
const EMPTY_SESSION_DELETE_DELAY_MS = 0;

function isDesktopSessionPaneRight() {
  return desktopSessionPaneSide() === 'right';
}

export function Chat() {
  const [sessionFilter, setSessionFilter] = createSignal<SessionListFilter | null>(null);
  const [subagentParentId, setSubagentParentId] = createSignal<string | null>(null);
  const [isDesktopSessionLayout, setIsDesktopSessionLayout] = createSignal(false);
  const [isEnteringChatView, setIsEnteringChatView] = createSignal(false);
  const [showReconnectBanner, setShowReconnectBanner] = createSignal(false);
  const [slowApiRequests, setSlowApiRequests] = createSignal<readonly SlowApiRequest[]>([]);
  const sessionIndicators = createMemo(() => deriveSessionIndicators(state.sessions));
  const visibleSessions = createMemo(() => {
    const indicators = sessionIndicators();
    return state.sessions.filter((session) => !shouldHideSessionFromList(session, indicators));
  });
  const primarySessions = createMemo(() => visibleSessions().filter(isPrimarySession));
  const sessionsById = createMemo(
    () => new Map(state.sessions.map((session) => [session.id, session]))
  );
  const isEventStreamDegraded = createMemo(
    () => state.serverStatus.state === 'running' && state.serverStatus.eventStream === 'degraded'
  );
  const shouldRenderWorkspace = () => !showSessionPicker() || isDesktopSessionLayout();
  let reconnectBannerShowTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectBannerHideTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectBannerVisibleSince = 0;
  let chatViewEnterTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingEmptySessionDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearReconnectBannerShowTimer = () => {
    if (reconnectBannerShowTimer == null) return;
    clearTimeout(reconnectBannerShowTimer);
    reconnectBannerShowTimer = undefined;
  };

  const clearReconnectBannerHideTimer = () => {
    if (reconnectBannerHideTimer == null) return;
    clearTimeout(reconnectBannerHideTimer);
    reconnectBannerHideTimer = undefined;
  };

  const clearChatViewEnterTimer = () => {
    if (chatViewEnterTimer == null) return;
    clearTimeout(chatViewEnterTimer);
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

  onMount(() => {
    const unsubscribe = onSlowApiRequestsChange(setSlowApiRequests);
    onCleanup(unsubscribe);
  });

  createEffect(
    on(isEventStreamDegraded, (isDegraded) => {
      if (isDegraded) {
        clearReconnectBannerHideTimer();
        if (showReconnectBanner() || reconnectBannerShowTimer != null) return;

        reconnectBannerShowTimer = setTimeout(() => {
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
      reconnectBannerHideTimer = setTimeout(() => {
        reconnectBannerHideTimer = undefined;
        reconnectBannerVisibleSince = 0;
        if (!isEventStreamDegraded()) setShowReconnectBanner(false);
      }, remainingVisibleMs);
    })
  );

  createEffect(
    on(
      sessionSearchFocusKey,
      (key) => {
        if (key === 0) return;
        setSessionFilter(null);
        setSubagentParentId(null);
        setShowSettings(false);
        setShowSessionPicker(true);
      },
      { defer: true }
    )
  );

  createEffect(() => {
    const indicators = sessionIndicators();
    const candidateIds = new Set<string>();
    for (const session of state.sessions) {
      if (!shouldAutoDeleteEmptySession(session, state.activeSessionId, indicators)) continue;
      candidateIds.add(session.id);
      if (pendingEmptySessionDeleteTimers.has(session.id)) continue;

      const timer = setTimeout(() => {
        pendingEmptySessionDeleteTimers.delete(session.id);
        const latestSession = state.sessions.find((item) => item.id === session.id);
        if (!latestSession) return;
        if (
          !shouldAutoDeleteEmptySession(latestSession, state.activeSessionId, sessionIndicators())
        ) {
          return;
        }
        void deleteEmptySession(session.id);
      }, EMPTY_SESSION_DELETE_DELAY_MS);
      pendingEmptySessionDeleteTimers.set(session.id, timer);
    }

    for (const [sessionId, timer] of pendingEmptySessionDeleteTimers) {
      if (candidateIds.has(sessionId)) continue;
      clearTimeout(timer);
      pendingEmptySessionDeleteTimers.delete(sessionId);
    }
  });

  onCleanup(() => {
    clearReconnectBannerShowTimer();
    clearReconnectBannerHideTimer();
    clearChatViewEnterTimer();
    for (const timer of pendingEmptySessionDeleteTimers.values()) {
      clearTimeout(timer);
    }
    pendingEmptySessionDeleteTimers.clear();
  });

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

  const openParentSession = async (parentSessionId: string) => {
    setSessionFilter(null);
    setSubagentParentId(null);
    setShowSessionPicker(false);
    await selectSession(parentSessionId);
  };

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
      chatViewEnterTimer = setTimeout(() => {
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
    const parentSessionId = sessionId ? sessionsById().get(sessionId)?.parentID : null;
    if (parentSessionId) {
      setSubagentParentId(getSessionTreeRootId(sessionId) || parentSessionId);
      setShowSessionPicker(true);
      return;
    }
    // If the user is currently viewing a Ralph iteration child session, "back"
    // should return to the owning Ralph dashboard instead of the global
    // sessions list.
    const ralphParentId = ralphStore.findManagerSessionIdForChild(sessionId);
    if (ralphParentId && ralphParentId !== sessionId) {
      setShowSessionPicker(false);
      await selectSession(ralphParentId);
      return;
    }
    const discardableActiveBlankSessionId = getDiscardableActiveBlankSessionId();
    if (sessionId && discardableActiveBlankSessionId) {
      setShowSessionPicker(true);
      await deleteEmptySession(discardableActiveBlankSessionId);
      return;
    }
    setShowSessionPicker(true);
  };

  const switchActiveSession = (direction: -1 | 1) => {
    if (!shouldRenderWorkspace() || showSettings()) return;

    const activeSessionId = state.activeSessionId;
    if (!activeSessionId) return;

    const now = Date.now();
    const orderedSessions = primarySessions().toSorted((left, right) => {
      const pinOrder =
        Number(state.pinnedSessionIds.includes(right.id)) -
        Number(state.pinnedSessionIds.includes(left.id));
      return pinOrder || compareSessionsByActivity(left, right, now);
    });
    if (orderedSessions.length < 2) return;

    const activeIndex = orderedSessions.findIndex((session) => session.id === activeSessionId);
    if (activeIndex === -1) return;

    const nextIndex = (activeIndex + direction + orderedSessions.length) % orderedSessions.length;
    void selectSession(orderedSessions[nextIndex]!.id);
  };

  onMount(() => {
    const disposeBridge = onMessage((message) => {
      if (message.type !== 'command/switch-session') return;
      switchActiveSession(message.payload.direction === 'previous' ? -1 : 1);
    });
    const handleKeydown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }

      // Target handlers run before this window listener, while other window
      // handlers may run after it.
      const wasHandled = event.defaultPrevented;
      queueMicrotask(() => {
        if (
          wasHandled ||
          event.defaultPrevented ||
          (event as KeyboardEvent & { varroHandled?: boolean }).varroHandled
        ) {
          return;
        }
        if (showSettings()) {
          setShowSettings(false);
          return;
        }
        if (showSessionPicker()) return;
        void openAllSessions();
      });
    };

    window.addEventListener('keydown', handleKeydown);
    onCleanup(() => {
      disposeBridge();
      window.removeEventListener('keydown', handleKeydown);
    });
  });

  const openSubagentListParentSession = () => {
    const parentSessionId = subagentParentId();
    if (!parentSessionId) return;
    void openParentSession(parentSessionId);
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

  const activeSession = createMemo(() => {
    const sessionId = state.activeSessionId;
    return sessionId ? sessionsById().get(sessionId) || null : null;
  });
  const activeSubagentRootId = createMemo(() => {
    const session = activeSession();
    return session && !session.parentID ? session.id : null;
  });
  const activeSubagentCount = createMemo(() => {
    const rootSessionId = activeSubagentRootId();
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

  const activeSubagentParent = createMemo(() => {
    const parentId = subagentParentId();
    if (!parentId) return null;
    return sessionsById().get(parentId) || null;
  });
  const sessionListFilterLabel = createMemo(() => {
    const subagentParent = activeSubagentParent();
    if (subagentParent) {
      return `Sub-agents for ${normalizeSessionTitle(subagentParent.title) || 'Untitled'}`;
    }
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
      slowApiRequests={slowApiRequests()}
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
      activeTitle={activeTitle()}
      isSubagentSession={!!activeSession()?.parentID}
      activeSubagentRootId={activeSubagentCount() > 0 ? activeSubagentRootId() : null}
      activeSubagentCount={activeSubagentCount()}
      activeSubagentLabel={activeSubagentLabel()}
      onClearSessionListView={clearSessionListView}
      onOpenAllSessions={() => {
        void openAllSessions();
      }}
      onOpenParentSession={openSubagentListParentSession}
      onOpenSubagentSessions={openSubagentSessions}
      onOpenFailedSessions={openFailedSessions}
      onOpenAttentionSessions={openAttentionSessions}
      onOpenPlanReadySessions={openPlanReadySessions}
      onOpenCompletedSessions={openCompletedSessions}
      onOpenRunningSessions={openRunningSessions}
      onCreateSessionFromPicker={startNewChatDraft}
      onCreateSession={startNewChatDraft}
    />
  );
}

async function deleteEmptySession(sessionId: string) {
  await deleteSessionImmediately(sessionId);
}

export {
  SessionListSectionHeader,
  archiveSessionGroup,
  deriveSessionIndicators,
  getDiffSummaryStats,
  getMessageToolSummaryStats,
  getPrimarySessionsForFilter,
  getSessionListFilterLabel,
  getSessionSummaryStats,
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

export function isEmptySession(session: (typeof state.sessions)[number]) {
  return isEmptySessionMetadata(session);
}

export function shouldAutoDeleteEmptySession(
  session: (typeof state.sessions)[number],
  activeSessionId: string | null,
  indicators: Pick<
    ReturnType<typeof deriveSessionIndicators>,
    'runningIds' | 'attentionIds' | 'failedIds' | 'planReadyIds'
  >
) {
  return shouldPruneEmptySession(session, {
    activeSessionId,
    isQueued: (sessionId) => state.queuedMessages.some((item) => item.sessionId === sessionId),
    isAwaitingInput: isSessionAwaitingInput,
    isRunning: (sessionId) => indicators.runningIds.has(sessionId),
    needsAttention: (sessionId) => indicators.attentionIds.has(sessionId),
    isFailed: (sessionId) => indicators.failedIds.has(sessionId),
    isPlanReady: (item) => indicators.planReadyIds.has(item.id),
    preserve: ralphStore.isRalphSession(session.id),
    statusType: state.sessionStatus[session.id]?.type,
  });
}

function shouldHideSessionFromList(
  session: (typeof state.sessions)[number],
  indicators: Pick<
    ReturnType<typeof deriveSessionIndicators>,
    'runningIds' | 'attentionIds' | 'failedIds' | 'planReadyIds'
  >
) {
  return shouldHideEmptySessionFromList(session, {
    isQueued: (sessionId) => state.queuedMessages.some((item) => item.sessionId === sessionId),
    isAwaitingInput: isSessionAwaitingInput,
    isRunning: (sessionId) => indicators.runningIds.has(sessionId),
    needsAttention: (sessionId) => indicators.attentionIds.has(sessionId),
    isFailed: (sessionId) => indicators.failedIds.has(sessionId),
    isPlanReady: (item) => indicators.planReadyIds.has(item.id),
    preserve: ralphStore.isRalphSession(session.id),
    statusType: state.sessionStatus[session.id]?.type,
  });
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
