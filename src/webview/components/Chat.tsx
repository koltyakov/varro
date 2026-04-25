import {
  desktopSessionPaneSide,
  state,
  showSessionPicker,
  setShowSessionPicker,
  showSettings,
  openAttentionSessionsKey,
  hasActiveUsageLimit,
  isSessionUnread,
  isSessionAwaitingInput,
  getSelectedAgentForSession,
  isSkippedPlanSession,
  getSessionTreeRootId,
} from '../lib/state';
import {
  Show,
  For,
  createSignal,
  onMount,
  onCleanup,
  createEffect,
  createMemo,
  on,
} from 'solid-js';
import { selectSession, createSession, deleteSession } from '../hooks/useOpenCode';
import { normalizeSessionTitle } from '../../shared/session-title';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { SettingsPanel } from './SettingsPanel';

type SessionGroups = {
  failed: (typeof state.sessions)[number][];
  planReady: (typeof state.sessions)[number][];
  newlyCompleted: (typeof state.sessions)[number][];
  running: (typeof state.sessions)[number][];
  attention: (typeof state.sessions)[number][];
  surfacedOther: (typeof state.sessions)[number][];
  overflowOther: (typeof state.sessions)[number][];
  subagents: (typeof state.sessions)[number][];
};

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

type SessionIndicatorSets = {
  subagentCounts: Map<string, number>;
  permissionIds: Set<string>;
  questionIds: Set<string>;
  runningIds: Set<string>;
  failedIds: Set<string>;
  attentionIds: Set<string>;
  planReadyIds: Set<string>;
  newlyCompletedIds: Set<string>;
};

const SESSION_SHOW_MORE_AGE_MS = 24 * 60 * 60 * 1000;
const DESKTOP_SESSION_LAYOUT_MEDIA_QUERY = '(min-width: 1400px)';

export type SessionListFilter = 'running' | 'attention' | 'failed' | 'plan-ready' | 'completed';

export function Chat() {
  const [sessionFilter, setSessionFilter] = createSignal<SessionListFilter | null>(null);
  const [subagentParentId, setSubagentParentId] = createSignal<string | null>(null);
  const [isDesktopSessionLayout, setIsDesktopSessionLayout] = createSignal(false);
  const isDesktopSessionPaneRight = () => desktopSessionPaneSide() === 'right';
  const primarySessions = createMemo(() => state.sessions.filter(isPrimarySession));
  const sessionIndicators = createMemo(() => deriveSessionIndicators(state.sessions));
  const sessionsById = createMemo(
    () => new Map(state.sessions.map((session) => [session.id, session]))
  );
  const shouldRenderWorkspace = () => !showSessionPicker() || isDesktopSessionLayout();

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
  };

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

  const renderSessionPickerHeader = (showNewChatButton = true, useSidebarCounts = false) => (
    <>
      <div class="chat-header-left">
        <Show
          when={sessionListFilterLabel()}
          fallback={
            <span class="chat-header-title-text">
              Sessions <span class="chat-header-title-count">({primarySessionsCount()})</span>
            </span>
          }
        >
          {(label) => (
            <>
              <span class="chat-header-filter-prefix">{sessionListFilterPrefix()}</span>
              <span class="chat-header-filter-chip" title={sessionListFilterTitle()}>
                <span class="chat-header-filter-chip-label">{label()}</span>
                <button
                  type="button"
                  class="chat-header-filter-chip-remove"
                  onClick={clearSessionListView}
                  title="Clear filter"
                  aria-label={`Clear ${label()} filter`}
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                  </svg>
                </button>
              </span>
            </>
          )}
        </Show>
      </div>
      <div class="chat-header-actions">
        <Show when={shouldShowHeaderBadge('failed')}>
          <FailedSessionsBadge
            count={useSidebarCounts ? sessionSidebarFailedCount() : failedSessionsCount()}
            onClick={openFailedSessions}
          />
        </Show>
        <Show when={shouldShowHeaderBadge('attention')}>
          <AttentionSessionsBadge
            count={useSidebarCounts ? sessionSidebarAttentionCount() : attentionSessionsCount()}
            onClick={openAttentionSessions}
          />
        </Show>
        <Show when={shouldShowHeaderBadge('plan-ready')}>
          <PlanReadyBadge
            count={useSidebarCounts ? sessionSidebarPlanReadyCount() : planReadySessionsCount()}
            onClick={openPlanReadySessions}
          />
        </Show>
        <Show when={shouldShowHeaderBadge('completed')}>
          <CompletedSessionsBadge
            count={useSidebarCounts ? sessionSidebarCompletedCount() : completedSessionsCount()}
            onClick={openCompletedSessions}
          />
        </Show>
        <Show when={shouldShowHeaderBadge('running')}>
          <RunningSessionsBadge
            count={useSidebarCounts ? sessionSidebarRunningCount() : runningSessionsCount()}
            onClick={openRunningSessions}
          />
        </Show>
        <Show when={showNewChatButton}>
          <button
            class="chat-header-btn"
            onClick={() => {
              createSession();
              setShowSessionPicker(false);
            }}
            title="New chat"
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
            </svg>
          </button>
        </Show>
      </div>
    </>
  );

  const renderChatHeader = (showBackButton: boolean, showActions = true) => (
    <>
      <div class="chat-header-left">
        <Show when={showBackButton}>
          <button
            class="chat-header-btn"
            onClick={() => void openAllSessions()}
            title="Back to sessions"
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
            </svg>
          </button>
        </Show>
        <span class="chat-header-title-text">{activeTitle()}</span>
      </div>
      <Show when={showActions}>
        <div class="chat-header-actions">
          <Show when={showActions}>
            <>
              <FailedSessionsBadge count={failedSessionsCount()} onClick={openFailedSessions} />
              <AttentionSessionsBadge
                count={attentionSessionsCount()}
                onClick={openAttentionSessions}
              />
              <PlanReadyBadge count={planReadySessionsCount()} onClick={openPlanReadySessions} />
              <CompletedSessionsBadge
                count={completedSessionsCount()}
                onClick={openCompletedSessions}
              />
            </>
          </Show>
          <RunningSessionsBadge count={runningSessionsCount()} onClick={openRunningSessions} />
          <button class="chat-header-btn" onClick={() => createSession()} title="New chat">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
            </svg>
          </button>
        </div>
      </Show>
    </>
  );

  const renderSessionSidebar = () => (
    <aside class="chat-session-sidebar" aria-label="Sessions">
      <div class="chat-header chat-session-sidebar-header">
        <div class="chat-header-inner chat-session-sidebar-header-inner">
          {renderSessionPickerHeader(true, true)}
        </div>
      </div>
      <SessionListView
        embedded
        class="session-list-view-sidebar"
        sessionFilter={showSessionPicker() ? sessionFilter() : null}
        subagentParentId={showSessionPicker() ? subagentParentId() : null}
        onOpenSubagents={showSessionPicker() ? openSubagentSessions : undefined}
      />
    </aside>
  );

  const renderMainShell = () => (
    <div class="chat-main-shell">
      <div class="chat-header chat-header-chat-desktop">
        <div class="chat-header-inner">{renderChatHeader(false, false)}</div>
      </div>
      <div class="chat-main-column-shell">
        <MessageList />

        <ChatInput />
      </div>
    </div>
  );

  return (
    <div class="interactive-session">
      <div
        class={`chat-header ${shouldRenderWorkspace() ? 'chat-header-centered chat-header-chat-layout' : ''}`}
      >
        <div class="chat-header-inner">
          <Show when={showSessionPicker()} fallback={renderChatHeader(true)}>
            {renderSessionPickerHeader()}
          </Show>
        </div>
      </div>

      <Show
        when={
          state.serverStatus.state === 'running' && state.serverStatus.eventStream === 'degraded'
        }
      >
        <div
          class={`chat-transport-banner ${shouldRenderWorkspace() ? 'chat-main-column' : ''}`}
          role="status"
          aria-live="polite"
        >
          <div class="chat-transport-copy">
            <span class="chat-transport-title">Live updates are reconnecting</span>
            <span class="chat-transport-message">
              Chat actions still work, but session status may lag until the event stream recovers.
            </span>
          </div>
        </div>
      </Show>

      <Show
        when={shouldRenderWorkspace()}
        fallback={
          <SessionListView
            sessionFilter={sessionFilter()}
            subagentParentId={subagentParentId()}
            onOpenSubagents={openSubagentSessions}
          />
        }
      >
        <Show when={showSettings()}>
          <SettingsPanel />
        </Show>

        <div
          class={`chat-workspace ${isDesktopSessionPaneRight() ? 'chat-workspace-pane-right' : ''}`}
        >
          <Show
            when={isDesktopSessionPaneRight()}
            fallback={
              <>
                {renderSessionSidebar()}
                {renderMainShell()}
              </>
            }
          >
            <>
              {renderMainShell()}
              {renderSessionSidebar()}
            </>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export function getAttentionSessions(
  sessions: typeof state.sessions,
  isNeedingAttention: (sessionId: string) => boolean
) {
  return sessions.filter((session) => isNeedingAttention(session.id));
}

export function getSessionListFilterLabel(filter: SessionListFilter | null) {
  switch (filter) {
    case 'running':
      return 'Running';
    case 'attention':
      return 'Needs attention';
    case 'failed':
      return 'Failed';
    case 'plan-ready':
      return 'Plan ready';
    case 'completed':
      return 'Completed';
    default:
      return null;
  }
}

export function getPrimarySessionsForFilter(
  sessions: typeof state.sessions,
  filter: SessionListFilter,
  isRunning: (sessionId: string) => boolean,
  isNeedingAttention: (sessionId: string) => boolean,
  isFailed: (sessionId: string) => boolean,
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean,
  isCompleted: (session: (typeof state.sessions)[number]) => boolean
) {
  return sessions.filter((session) => {
    if (!isPrimarySession(session)) return false;

    switch (filter) {
      case 'running':
        return isRunning(session.id);
      case 'attention':
        return isNeedingAttention(session.id);
      case 'failed':
        return isFailed(session.id);
      case 'plan-ready':
        return isPlanReady(session);
      case 'completed':
        return isCompleted(session);
    }
  });
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

export function getSubagentSessionsForParent(
  sessions: typeof state.sessions,
  parentSessionId: string | null
) {
  if (!parentSessionId) return [];
  return sessions.filter((session) => session.parentID === parentSessionId);
}

export function shouldShowSessionHeaderBadge(
  activeFilter: SessionListFilter | null,
  badgeFilter: SessionListFilter
) {
  return activeFilter !== badgeFilter;
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

export function groupSessions(
  sessions: typeof state.sessions,
  isRunning: (sessionId: string) => boolean,
  isNeedingAttention: (sessionId: string) => boolean,
  isFailed: (sessionId: string) => boolean,
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean,
  isNewlyCompleted: (session: (typeof state.sessions)[number]) => boolean,
  now: number
): SessionGroups {
  const primaries: (typeof state.sessions)[number][] = [];
  const subagents: (typeof state.sessions)[number][] = [];

  for (const session of sessions) {
    if (session.parentID) subagents.push(session);
    else primaries.push(session);
  }

  primaries.sort((left, right) => right.time.updated - left.time.updated);
  const failed: SessionGroups['failed'] = [];
  const planReady: SessionGroups['planReady'] = [];
  const attention: SessionGroups['attention'] = [];
  const running: SessionGroups['running'] = [];
  const newlyCompleted: SessionGroups['newlyCompleted'] = [];
  const surfacedOther: SessionGroups['surfacedOther'] = [];
  const overflowOther: SessionGroups['overflowOther'] = [];
  const recentSessionCutoff = now - SESSION_SHOW_MORE_AGE_MS;

  for (const session of primaries) {
    switch (
      getSessionPriorityRank(
        session,
        isRunning,
        isNeedingAttention,
        isFailed,
        isPlanReady,
        isNewlyCompleted
      )
    ) {
      case 0:
        failed.push(session);
        break;
      case 1:
        planReady.push(session);
        break;
      case 2:
        attention.push(session);
        break;
      case 3:
        running.push(session);
        break;
      case 4:
        newlyCompleted.push(session);
        break;
      default:
        if (session.time.updated >= recentSessionCutoff) surfacedOther.push(session);
        else overflowOther.push(session);
        break;
    }
  }

  return {
    failed,
    planReady,
    newlyCompleted,
    running,
    attention,
    surfacedOther,
    overflowOther,
    subagents,
  };
}

function getSessionPriorityRank(
  session: (typeof state.sessions)[number],
  isRunning: (sessionId: string) => boolean,
  isNeedingAttention: (sessionId: string) => boolean,
  isFailed: (sessionId: string) => boolean,
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean,
  isNewlyCompleted: (session: (typeof state.sessions)[number]) => boolean
) {
  if (isFailed(session.id)) return 0;
  if (isPlanReady(session)) return 1;
  if (isNeedingAttention(session.id)) return 2;
  if (isRunning(session.id)) return 3;
  if (isNewlyCompleted(session)) return 4;
  return 5;
}

export function getArchiveSessionGroupConfirmationMessage(label: string, count: number) {
  return `Archive ${count} session${count === 1 ? '' : 's'} in ${label}? This cannot be undone.`;
}

export async function archiveSessionGroup(
  sessions: typeof state.sessions,
  label: string,
  confirmArchive: (message: string) => boolean,
  archiveSession: (sessionId: string) => Promise<void>
) {
  if (sessions.length === 0) return false;
  if (!confirmArchive(getArchiveSessionGroupConfirmationMessage(label, sessions.length))) {
    return false;
  }

  for (const session of sessions) {
    await archiveSession(session.id);
  }

  return true;
}

async function archiveSessions(
  sessions: typeof state.sessions,
  archiveSession: (sessionId: string) => Promise<void>
) {
  if (sessions.length === 0) return false;

  for (const session of sessions) {
    await archiveSession(session.id);
  }

  return true;
}

export function SessionListSectionHeader(props: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onArchive?: () => unknown;
}) {
  const [isConfirmingArchive, setIsConfirmingArchive] = createSignal(false);

  createEffect(
    on(
      () => props.count,
      () => {
        setIsConfirmingArchive(false);
      }
    )
  );

  const confirmArchive = async () => {
    setIsConfirmingArchive(false);
    await props.onArchive?.();
  };

  return (
    <div class="session-list-section-header">
      <button type="button" class="session-list-section-toggle" onClick={props.onToggle}>
        <span class="session-list-section-title">{props.title}</span>
        <span class="session-list-section-count">{props.count}</span>
      </button>
      <div class="session-list-section-actions">
        <Show when={props.onArchive !== undefined}>
          <Show
            when={isConfirmingArchive()}
            fallback={
              <button
                type="button"
                class="session-list-section-archive"
                onClick={() => setIsConfirmingArchive(true)}
                title={`Archive ${props.title}`}
                aria-label={`Archive ${props.title}`}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M14.5 1h-13a.5.5 0 00-.5.5V4h14V1.5a.5.5 0 00.5-.5zM1 5v9.5a.5.5 0 00.5.5h13a.5.5 0 00.5-.5V5H1zm5 3h4v1H6V8z" />
                </svg>
              </button>
            }
          >
            <>
              <button
                type="button"
                class="session-list-section-confirm"
                onClick={() => void confirmArchive()}
                title={`Confirm archive ${props.title}`}
                aria-label={`Confirm archive ${props.title}`}
              >
                Confirm
              </button>
              <button
                type="button"
                class="session-list-section-cancel"
                onClick={() => setIsConfirmingArchive(false)}
                title={`Cancel archive ${props.title}`}
                aria-label={`Cancel archive ${props.title}`}
              >
                Cancel
              </button>
            </>
          </Show>
        </Show>
        <button
          type="button"
          class="session-list-section-chevron-button"
          onClick={props.onToggle}
          aria-label={`${props.expanded ? 'Collapse' : 'Expand'} ${props.title}`}
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            class={`session-list-section-chevron ${props.expanded ? 'expanded' : ''}`}
            aria-hidden="true"
          >
            <path d="M5.5 3.5L10 8l-4.5 4.5-.7-.7L8.6 8 4.8 4.2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function SessionListView(props: {
  sessionFilter?: SessionListFilter | null;
  subagentParentId?: string | null;
  onOpenSubagents?: (parentSessionId: string) => void;
  embedded?: boolean;
  class?: string;
}) {
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(clock));

  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  const [showOtherSessions, setShowOtherSessions] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');
  let containerRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const normalizedSearchQuery = createMemo(() => searchQuery().trim().toLowerCase());
  const shouldShowSearch = createMemo(() => !props.subagentParentId && !props.sessionFilter);

  const primarySessions = createMemo(() => state.sessions.filter(isPrimarySession));
  const sessionIndicators = createMemo(() => deriveSessionIndicators(state.sessions));
  const groupedSessions = createMemo(() =>
    groupSessions(
      state.sessions,
      (sessionId) => sessionIndicators().runningIds.has(sessionId),
      (sessionId) => sessionIndicators().attentionIds.has(sessionId),
      (sessionId) => sessionIndicators().failedIds.has(sessionId),
      (session) => sessionIndicators().planReadyIds.has(session.id),
      (session) => sessionIndicators().newlyCompletedIds.has(session.id),
      now()
    )
  );
  const failedSessions = () => groupedSessions().failed;
  const planReadySessions = () => groupedSessions().planReady;
  const attentionSessions = () => groupedSessions().attention;
  const runningSessions = () => groupedSessions().running;
  const newlyCompletedSessions = () => groupedSessions().newlyCompleted;
  const surfacedOtherSessions = () => groupedSessions().surfacedOther;
  const overflowOtherSessions = () => groupedSessions().overflowOther;
  const subagentSessions = createMemo(() =>
    getSubagentSessionsForParent(state.sessions, props.subagentParentId ?? null)
  );
  const filteredSessions = createMemo(() =>
    props.sessionFilter
      ? getPrimarySessionsForFilter(
          primarySessions(),
          props.sessionFilter,
          (sessionId) => sessionIndicators().runningIds.has(sessionId),
          (sessionId) => sessionIndicators().attentionIds.has(sessionId),
          (sessionId) => sessionIndicators().failedIds.has(sessionId),
          (session) => sessionIndicators().planReadyIds.has(session.id),
          (session) => sessionIndicators().newlyCompletedIds.has(session.id)
        )
      : []
  );
  const surfacedSessions = createMemo(() =>
    [
      ...failedSessions(),
      ...planReadySessions(),
      ...attentionSessions(),
      ...runningSessions(),
      ...newlyCompletedSessions(),
      ...surfacedOtherSessions(),
    ].toSorted((left, right) => right.time.updated - left.time.updated)
  );
  const directSessions = createMemo(() => {
    if (props.subagentParentId) return subagentSessions();
    if (props.sessionFilter) return filteredSessions();
    return [];
  });
  const baseVisibleSessions = createMemo(() => {
    if (props.subagentParentId || props.sessionFilter) return directSessions();

    const sessions = showOtherSessions()
      ? [...surfacedSessions(), ...overflowOtherSessions()]
      : surfacedSessions();
    return sessions;
  });
  const visibleSessions = createMemo(() => {
    const query = normalizedSearchQuery();
    const sessions = baseVisibleSessions();
    if (!shouldShowSearch() || query.length === 0) return sessions;

    return sessions.filter((session) => {
      const title = normalizeSessionTitle(session.title).toLowerCase();
      return (
        title.includes(query) ||
        session.id.toLowerCase().includes(query) ||
        session.directory.toLowerCase().includes(query)
      );
    });
  });

  createEffect(
    on(
      () => [props.sessionFilter, props.subagentParentId],
      () => {
        setShowOtherSessions(false);
        setSearchQuery('');
        setFocusedIndex(-1);
      }
    )
  );

  createEffect(() => {
    const sessions = visibleSessions();
    setFocusedIndex((current) => {
      if (sessions.length === 0) return -1;
      if (current < 0) return current;
      return Math.min(current, sessions.length - 1);
    });
  });

  function handleKeydown(e: KeyboardEvent) {
    const sessions = visibleSessions();
    if (sessions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex((i) => {
        const next = i + 1;
        return next >= sessions.length ? 0 : next;
      });
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex((i) => {
        const next = i - 1;
        return next < 0 ? sessions.length - 1 : next;
      });
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const idx = focusedIndex();
      if (idx >= 0 && idx < sessions.length) {
        selectSession(sessions[idx].id);
        if (!props.embedded) setShowSessionPicker(false);
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (!props.embedded) setShowSessionPicker(false);
    }
  }

  onMount(() => {
    if (props.embedded) return;
    requestAnimationFrame(() => {
      if (shouldShowSearch()) {
        searchInputRef?.focus();
        return;
      }
      containerRef?.focus();
    });
  });

  const emptyMessage = () => {
    if (props.subagentParentId) return 'No sub-agent sessions';
    if (normalizedSearchQuery()) return 'No matching sessions';
    const label = getSessionListFilterLabel(props.sessionFilter ?? null);
    return label ? `No ${label.toLowerCase()} sessions` : 'No sessions yet';
  };
  const hasVisibleContent = createMemo(() => {
    if (props.subagentParentId) return subagentSessions().length > 0;
    if (props.sessionFilter) return filteredSessions().length > 0;
    if (normalizedSearchQuery()) return visibleSessions().length > 0;
    return state.sessions.length > 0;
  });

  return (
    <div
      ref={(el) => {
        containerRef = el;
      }}
      class={`session-list-view ${props.class || ''}`.trim()}
      tabindex="-1"
      onKeyDown={handleKeydown}
    >
      <Show when={shouldShowSearch()}>
        <div class="session-list-search">
          <input
            ref={(el) => {
              searchInputRef = el;
            }}
            type="text"
            class="session-list-search-input"
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            placeholder="Search sessions"
            aria-label="Search sessions"
            spellcheck={false}
          />
          <Show when={searchQuery().length > 0}>
            <button
              type="button"
              class="session-list-search-clear"
              onClick={() => {
                setSearchQuery('');
                searchInputRef?.focus();
              }}
              aria-label="Clear search"
              title="Clear search"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M3.22 3.22a.75.75 0 011.06 0L8 6.94l3.72-3.72a.75.75 0 111.06 1.06L9.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 01-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 010-1.06z" />
              </svg>
            </button>
          </Show>
        </div>
      </Show>
      <div class="session-list-scroll">
        <Show
          when={hasVisibleContent()}
          fallback={<div class="session-empty">{emptyMessage()}</div>}
        >
          <Show when={props.subagentParentId || props.sessionFilter || normalizedSearchQuery()}>
            <For each={visibleSessions()}>
              {(session, index) => (
                <SessionListItem
                  session={session}
                  itemIndex={() => index()}
                  focusedIndex={focusedIndex}
                  setFocusedIndex={setFocusedIndex}
                  now={now}
                  subagentCount={sessionIndicators().subagentCounts.get(session.id) || 0}
                  hasPermissionRequest={sessionIndicators().permissionIds.has(session.id)}
                  hasQuestionRequest={sessionIndicators().questionIds.has(session.id)}
                  isRunning={sessionIndicators().runningIds.has(session.id)}
                  isFailed={sessionIndicators().failedIds.has(session.id)}
                  needsAttention={sessionIndicators().attentionIds.has(session.id)}
                  isNewlyCompleted={sessionIndicators().newlyCompletedIds.has(session.id)}
                  isCompletedPlanSession={sessionIndicators().planReadyIds.has(session.id)}
                  onOpenSubagents={props.onOpenSubagents}
                  embedded={props.embedded}
                />
              )}
            </For>
          </Show>
          <Show
            when={
              !props.sessionFilter &&
              !props.subagentParentId &&
              !normalizedSearchQuery() &&
              surfacedSessions().length > 0
            }
          >
            <For each={surfacedSessions()}>
              {(session, index) => (
                <SessionListItem
                  session={session}
                  itemIndex={() => index()}
                  focusedIndex={focusedIndex}
                  setFocusedIndex={setFocusedIndex}
                  now={now}
                  subagentCount={sessionIndicators().subagentCounts.get(session.id) || 0}
                  hasPermissionRequest={sessionIndicators().permissionIds.has(session.id)}
                  hasQuestionRequest={sessionIndicators().questionIds.has(session.id)}
                  isRunning={sessionIndicators().runningIds.has(session.id)}
                  isFailed={sessionIndicators().failedIds.has(session.id)}
                  needsAttention={sessionIndicators().attentionIds.has(session.id)}
                  isNewlyCompleted={sessionIndicators().newlyCompletedIds.has(session.id)}
                  isCompletedPlanSession={sessionIndicators().planReadyIds.has(session.id)}
                  onOpenSubagents={props.onOpenSubagents}
                  embedded={props.embedded}
                />
              )}
            </For>
          </Show>
          <Show
            when={
              !props.sessionFilter &&
              !props.subagentParentId &&
              !normalizedSearchQuery() &&
              overflowOtherSessions().length > 0
            }
          >
            <SessionListSectionHeader
              title="Show more"
              count={overflowOtherSessions().length}
              expanded={showOtherSessions()}
              onToggle={() => setShowOtherSessions((value) => !value)}
              onArchive={() => archiveSessions(overflowOtherSessions(), deleteSession)}
            />
            <Show when={showOtherSessions()}>
              <For each={overflowOtherSessions()}>
                {(session, index) => (
                  <SessionListItem
                    session={session}
                    itemIndex={() => surfacedSessions().length + index()}
                    focusedIndex={focusedIndex}
                    setFocusedIndex={setFocusedIndex}
                    now={now}
                    subagentCount={sessionIndicators().subagentCounts.get(session.id) || 0}
                    hasPermissionRequest={sessionIndicators().permissionIds.has(session.id)}
                    hasQuestionRequest={sessionIndicators().questionIds.has(session.id)}
                    isRunning={sessionIndicators().runningIds.has(session.id)}
                    isFailed={sessionIndicators().failedIds.has(session.id)}
                    needsAttention={sessionIndicators().attentionIds.has(session.id)}
                    isNewlyCompleted={sessionIndicators().newlyCompletedIds.has(session.id)}
                    isCompletedPlanSession={sessionIndicators().planReadyIds.has(session.id)}
                    onOpenSubagents={props.onOpenSubagents}
                    embedded={props.embedded}
                  />
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function SessionListItem(props: {
  session: (typeof state.sessions)[number];
  itemIndex: () => number;
  focusedIndex: () => number;
  setFocusedIndex: (index: number) => void;
  now: () => number;
  subagentCount: number;
  hasPermissionRequest: boolean;
  hasQuestionRequest: boolean;
  isRunning: boolean;
  isFailed: boolean;
  needsAttention: boolean;
  isNewlyCompleted: boolean;
  isCompletedPlanSession: boolean;
  onOpenSubagents?: (parentSessionId: string) => void;
  embedded?: boolean;
}) {
  const isActive = () => props.session.id === state.activeSessionId;
  const isFocused = () => props.focusedIndex() === props.itemIndex();
  const status = () => state.sessionStatus[props.session.id];
  const hasUnreadCompletion = () =>
    props.isNewlyCompleted ||
    (props.isCompletedPlanSession && isSessionUnread(props.session.id, props.session.time.updated));
  const hasSubagents = () => !!props.onOpenSubagents && props.subagentCount > 0;
  const subagentLabel = () =>
    `Show ${props.subagentCount} sub-agent session${props.subagentCount === 1 ? '' : 's'}`;
  const indicatorClass = () => {
    if (props.isFailed) return 'is-failed';
    if (props.isRunning) return 'is-running';
    if (props.needsAttention) return 'is-attention';
    if (props.isCompletedPlanSession) return 'is-plan-completed';
    if (hasUnreadCompletion()) return 'is-completed';
    return 'is-completed';
  };
  const indicatorTitle = () => {
    if (props.isFailed) return 'Failed';
    if (props.isRunning) return status()?.type === 'retry' ? 'Retrying' : 'Running';
    if (props.hasPermissionRequest && props.hasQuestionRequest) return 'Attention needed';
    if (props.hasPermissionRequest) return 'Permission request pending';
    if (props.hasQuestionRequest) return 'Attention needed';
    if (props.needsAttention) return 'Attention needed';
    if (props.isCompletedPlanSession) return 'Plan ready';
    if (hasUnreadCompletion()) return 'Completed';
    return 'Completed';
  };

  return (
    <div
      class={`session-item ${isActive() ? 'active' : ''} ${isFocused() ? 'keyboard-focus' : ''}`}
      onMouseEnter={() => props.setFocusedIndex(props.itemIndex())}
    >
      <button
        type="button"
        class="session-item-main"
        onClick={() => {
          selectSession(props.session.id);
          if (!props.embedded) setShowSessionPicker(false);
        }}
      >
        <Show
          when={
            props.isRunning ||
            props.isFailed ||
            props.needsAttention ||
            props.isCompletedPlanSession ||
            props.isNewlyCompleted
          }
          fallback={<span class="session-item-indicator-spacer" />}
        >
          <span
            class={`session-item-indicator ${indicatorClass()}`}
            title={indicatorTitle()}
            aria-label={indicatorTitle()}
          />
        </Show>
        <div class="session-item-content">
          <span class="session-item-title">
            {normalizeSessionTitle(props.session.title) || 'Untitled'}
          </span>
          <span class="session-item-meta">
            <Show when={props.session.summary}>
              {props.session.summary!.files} file{props.session.summary!.files !== 1 ? 's' : ''}
              {' · '}
              <span class="diff-lines-added">+{props.session.summary!.additions}</span>{' '}
              <span class="diff-lines-removed">-{props.session.summary!.deletions}</span>
            </Show>
          </span>
        </div>
      </button>
      <div class="session-item-trailing">
        <Show when={hasSubagents()}>
          <button
            type="button"
            class="session-item-subagents"
            onClick={() => props.onOpenSubagents?.(props.session.id)}
            title={subagentLabel()}
            aria-label={subagentLabel()}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M5.5 2.5a2 2 0 110 4 2 2 0 010-4zm5 1a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM2 9.25c0-1.8 2.1-2.75 3.5-2.75S9 7.45 9 9.25V10H2v-.75zm7.5.75v-.5c0-.66-.2-1.23-.54-1.7.5-.19 1.04-.3 1.54-.3 1.22 0 3 .73 3 2.25V10h-4z" />
            </svg>
          </button>
        </Show>
        <button
          type="button"
          class="session-item-archive"
          onClick={() => {
            deleteSession(props.session.id);
          }}
          title="Archive"
        >
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M14.5 1h-13a.5.5 0 00-.5.5V4h14V1.5a.5.5 0 00.5-.5zM1 5v9.5a.5.5 0 00.5.5h13a.5.5 0 00.5-.5V5H1zm5 3h4v1H6V8z" />
          </svg>
        </button>
        <span
          class="session-item-age"
          title={new Date(props.session.time.updated).toLocaleString()}
        >
          {formatSessionAge(props.session.time.updated, props.now())}
        </span>
      </div>
    </div>
  );
}

function formatSessionAge(timestamp: number, now: number): string {
  const totalMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));

  if (totalMinutes < 1) return '0m';

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor(totalMinutes / 60);

  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${totalMinutes}m`;
}

function RunningSessionsBadge(props: { count: number; onClick: () => void }) {
  const label = () => `${props.count} running session${props.count === 1 ? '' : 's'}`;

  return (
    <Show when={props.count > 0}>
      <button
        type="button"
        class="chat-header-running-badge"
        title={label()}
        aria-label={label()}
        onClick={props.onClick}
      >
        <span class="chat-header-running-spinner" aria-hidden="true" />
        <span class="chat-header-running-count">{props.count}</span>
      </button>
    </Show>
  );
}

function AttentionSessionsBadge(props: { count: number; onClick: () => void }) {
  const label = 'Sessions waiting for input or permission';

  return (
    <Show when={props.count > 0}>
      <button
        type="button"
        class="chat-header-attention-badge"
        title={label}
        aria-label={label}
        onClick={props.onClick}
      >
        <span class="chat-header-attention-dot" aria-hidden="true" />
      </button>
    </Show>
  );
}

function FailedSessionsBadge(props: { count: number; onClick: () => void }) {
  const label = 'Failed sessions';

  return (
    <Show when={props.count > 0}>
      <button
        type="button"
        class="chat-header-failed-badge"
        title={label}
        aria-label={label}
        onClick={props.onClick}
      >
        <span class="chat-header-failed-dot" aria-hidden="true" />
      </button>
    </Show>
  );
}

function PlanReadyBadge(props: { count: number; onClick: () => void }) {
  const label = 'Completed plans ready in another chat';

  return (
    <Show when={props.count > 0}>
      <button
        type="button"
        class="chat-header-plan-badge"
        title={label}
        aria-label={label}
        onClick={props.onClick}
      >
        <span class="chat-header-plan-dot" aria-hidden="true" />
      </button>
    </Show>
  );
}

function CompletedSessionsBadge(props: { count: number; onClick: () => void }) {
  const label = 'Completed sessions';

  return (
    <Show when={props.count > 0}>
      <button
        type="button"
        class="chat-header-completed-badge"
        title={label}
        aria-label={label}
        onClick={props.onClick}
      >
        <span class="chat-header-completed-dot" aria-hidden="true" />
      </button>
    </Show>
  );
}

export function deriveSessionIndicators(sessions: typeof state.sessions): SessionIndicatorSets {
  const subagentCounts = new Map<string, number>();
  const failedSessionIds = new Set(state.failedSessionIds);
  const rootSessionId = (sessionId: string) => getSessionTreeRootId(sessionId) || sessionId;
  const pendingAttentionIds = new Set(state.pendingAttentionSessionIds.map(rootSessionId));
  const permissionIds = new Set(
    state.permissions.map((permission) => rootSessionId(permission.sessionID))
  );
  const questionIds = new Set(state.questions.map((question) => rootSessionId(question.sessionID)));
  const runningIds = new Set<string>();
  const failedIds = new Set<string>();
  const attentionIds = new Set<string>();
  const planReadyIds = new Set<string>();
  const newlyCompletedIds = new Set<string>();
  const isAwaitingInput = (sessionId: string) =>
    pendingAttentionIds.has(rootSessionId(sessionId)) ||
    permissionIds.has(rootSessionId(sessionId)) ||
    questionIds.has(rootSessionId(sessionId));
  const isFailed = (sessionId: string) =>
    failedSessionIds.has(sessionId) || hasActiveUsageLimit(sessionId);
  const isRunning = (sessionId: string) => {
    if (hasActiveUsageLimit(sessionId)) return false;
    if (isAwaitingInput(sessionId)) return false;
    const type = state.sessionStatus[sessionId]?.type;
    return type === 'busy' || type === 'retry';
  };

  for (const session of sessions) {
    if (session.parentID) {
      subagentCounts.set(session.parentID, (subagentCounts.get(session.parentID) || 0) + 1);
    }

    const sessionId = session.id;
    const displaySessionId = rootSessionId(sessionId);
    const failed = isFailed(sessionId);
    const hasPrompt = permissionIds.has(displaySessionId) || questionIds.has(displaySessionId);
    const needsAttention = !failed && (hasPrompt || isAwaitingInput(sessionId));
    const running = !needsAttention && isRunning(sessionId);

    if (failed) {
      failedIds.add(displaySessionId);
      continue;
    }
    if (needsAttention) {
      attentionIds.add(displaySessionId);
      continue;
    }
    if (running) {
      runningIds.add(displaySessionId);
      continue;
    }
    const selectedAgent = getSelectedAgentForSession(sessionId);
    if (selectedAgent === 'plan') {
      if (!isSkippedPlanSession(sessionId, session.time.updated)) {
        planReadyIds.add(sessionId);
      }
      continue;
    }
    if (!isSessionUnread(sessionId, session.time.updated)) {
      continue;
    }
    newlyCompletedIds.add(sessionId);
  }

  return {
    subagentCounts,
    permissionIds,
    questionIds,
    runningIds,
    failedIds,
    attentionIds,
    planReadyIds,
    newlyCompletedIds,
  };
}

export function isFailedSession(sessionId: string) {
  return state.failedSessionIds.includes(sessionId) || hasActiveUsageLimit(sessionId);
}

export function isRunningSession(sessionId: string) {
  if (hasActiveUsageLimit(sessionId)) return false;
  if (isSessionAwaitingInput(sessionId)) return false;
  const type = state.sessionStatus[sessionId]?.type;
  return type === 'busy' || type === 'retry';
}

function isPrimarySession(session: (typeof state.sessions)[number]) {
  return !session.parentID;
}
