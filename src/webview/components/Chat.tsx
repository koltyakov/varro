import {
  state,
  showSessionPicker,
  setShowSessionPicker,
  showSettings,
  hasActiveUsageLimit,
  isSessionUnread,
  isSessionAwaitingInput,
  getSelectedAgentForSession,
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

export type SessionListFilter = 'running' | 'attention' | 'failed' | 'plan-ready';

export function Chat() {
  const [sessionFilter, setSessionFilter] = createSignal<SessionListFilter | null>(null);
  const [subagentParentId, setSubagentParentId] = createSignal<string | null>(null);
  const primarySessions = createMemo(() => state.sessions.filter(isPrimarySession));

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
    const session = state.sessions.find((s) => s.id === state.activeSessionId);
    return normalizeSessionTitle(session?.title) || 'New Chat';
  };

  const runningSessionsCount = createMemo(() =>
    getHeaderRunningCount(
      primarySessions(),
      (sessionId) => isRunningSession(sessionId),
      state.activeSessionId,
      showSessionPicker()
    )
  );
  const attentionSessionsCount = createMemo(() =>
    getHeaderAttentionCount(
      primarySessions(),
      (sessionId) => isSessionAwaitingInput(sessionId),
      state.activeSessionId,
      showSessionPicker()
    )
  );
  const failedSessionsCount = createMemo(() =>
    getHeaderFailedCount(
      primarySessions(),
      (sessionId) => isFailedSession(sessionId),
      state.activeSessionId,
      showSessionPicker()
    )
  );
  const planReadySessionsCount = createMemo(() =>
    getHeaderPlanReadyCount(
      primarySessions(),
      (session) => isPlanReadySession(session),
      state.activeSessionId,
      showSessionPicker()
    )
  );

  createEffect(() => {
    if (!showSessionPicker()) {
      setSessionFilter(null);
      setSubagentParentId(null);
    }
  });

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
    if (runningSessionsCount() === 0) return;
    setSubagentParentId(null);
    setSessionFilter('running');
    setShowSessionPicker(true);
  };

  const openAttentionSessions = () => {
    if (attentionSessionsCount() === 0) return;
    setSubagentParentId(null);
    setSessionFilter('attention');
    setShowSessionPicker(true);
  };

  const openFailedSessions = () => {
    if (failedSessionsCount() === 0) return;
    setSubagentParentId(null);
    setSessionFilter('failed');
    setShowSessionPicker(true);
  };

  const openPlanReadySessions = () => {
    if (planReadySessionsCount() === 0) return;
    setSubagentParentId(null);
    setSessionFilter('plan-ready');
    setShowSessionPicker(true);
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
    return state.sessions.find((session) => session.id === parentId) || null;
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
    <div class="interactive-session">
      <div class="chat-header">
        <Show
          when={showSessionPicker()}
          fallback={
            <>
              <div class="chat-header-left">
                <button
                  class="chat-header-btn"
                  onClick={() => void openAllSessions()}
                  title="Back to sessions"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
                  </svg>
                </button>
                <span class="chat-header-title-text">{activeTitle()}</span>
              </div>
              <div class="chat-header-actions">
                <FailedSessionsBadge count={failedSessionsCount()} onClick={openFailedSessions} />
                <AttentionSessionsBadge
                  count={attentionSessionsCount()}
                  onClick={openAttentionSessions}
                />
                <PlanReadyBadge count={planReadySessionsCount()} onClick={openPlanReadySessions} />
                <RunningSessionsBadge
                  count={runningSessionsCount()}
                  onClick={openRunningSessions}
                />
                <button class="chat-header-btn" onClick={() => createSession()} title="New chat">
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
                  </svg>
                </button>
              </div>
            </>
          }
        >
          <div class="chat-header-left">
            <Show
              when={sessionListFilterLabel()}
              fallback={<span class="chat-header-title-text">Sessions</span>}
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
              <FailedSessionsBadge count={failedSessionsCount()} onClick={openFailedSessions} />
            </Show>
            <Show when={shouldShowHeaderBadge('attention')}>
              <AttentionSessionsBadge
                count={attentionSessionsCount()}
                onClick={openAttentionSessions}
              />
            </Show>
            <Show when={shouldShowHeaderBadge('plan-ready')}>
              <PlanReadyBadge count={planReadySessionsCount()} onClick={openPlanReadySessions} />
            </Show>
            <Show when={shouldShowHeaderBadge('running')}>
              <RunningSessionsBadge count={runningSessionsCount()} onClick={openRunningSessions} />
            </Show>
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
          </div>
        </Show>
      </div>

      <Show
        when={
          state.serverStatus.state === 'running' && state.serverStatus.eventStream === 'degraded'
        }
      >
        <div class="chat-transport-banner" role="status" aria-live="polite">
          <div class="chat-transport-copy">
            <span class="chat-transport-title">Live updates are reconnecting</span>
            <span class="chat-transport-message">
              Chat actions still work, but session status may lag until the event stream recovers.
            </span>
          </div>
        </div>
      </Show>

      <Show
        when={!showSessionPicker()}
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

        <MessageList />

        <ChatInput />
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
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean
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
    }
  });
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

export function groupSessions(
  sessions: typeof state.sessions,
  isRunning: (sessionId: string) => boolean,
  isNeedingAttention: (sessionId: string) => boolean,
  isFailed: (sessionId: string) => boolean,
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean,
  isNewlyCompleted: (session: (typeof state.sessions)[number]) => boolean,
  maxSurfacedOtherSessions: number
): SessionGroups {
  const primaries = sessions
    .filter((session) => !session.parentID)
    .slice()
    .toSorted((left, right) => {
      const priorityDiff =
        getSessionPriorityRank(
          left,
          isRunning,
          isNeedingAttention,
          isFailed,
          isPlanReady,
          isNewlyCompleted
        ) -
        getSessionPriorityRank(
          right,
          isRunning,
          isNeedingAttention,
          isFailed,
          isPlanReady,
          isNewlyCompleted
        );

      if (priorityDiff !== 0) return priorityDiff;
      return right.time.updated - left.time.updated;
    });
  const failed = primaries.filter(
    (session) =>
      getSessionPriorityRank(
        session,
        isRunning,
        isNeedingAttention,
        isFailed,
        isPlanReady,
        isNewlyCompleted
      ) === 0
  );
  const planReady = primaries.filter(
    (session) =>
      getSessionPriorityRank(
        session,
        isRunning,
        isNeedingAttention,
        isFailed,
        isPlanReady,
        isNewlyCompleted
      ) === 1
  );
  const attention = primaries.filter(
    (session) =>
      getSessionPriorityRank(
        session,
        isRunning,
        isNeedingAttention,
        isFailed,
        isPlanReady,
        isNewlyCompleted
      ) === 2
  );
  const running = primaries.filter(
    (session) =>
      getSessionPriorityRank(
        session,
        isRunning,
        isNeedingAttention,
        isFailed,
        isPlanReady,
        isNewlyCompleted
      ) === 3
  );
  const newlyCompleted = primaries.filter(
    (session) =>
      getSessionPriorityRank(
        session,
        isRunning,
        isNeedingAttention,
        isFailed,
        isPlanReady,
        isNewlyCompleted
      ) === 4
  );
  const recentOther = primaries.filter(
    (session) =>
      getSessionPriorityRank(
        session,
        isRunning,
        isNeedingAttention,
        isFailed,
        isPlanReady,
        isNewlyCompleted
      ) === 5
  );

  return {
    failed,
    planReady,
    newlyCompleted,
    running,
    attention,
    surfacedOther: recentOther.slice(0, maxSurfacedOtherSessions),
    overflowOther: recentOther.slice(maxSurfacedOtherSessions),
    subagents: sessions.filter((session) => !!session.parentID),
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
  sessionFilter: SessionListFilter | null;
  subagentParentId: string | null;
  onOpenSubagents: (parentSessionId: string) => void;
}) {
  const MAX_SURFACED_OTHER_SESSIONS = 10;
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(clock));

  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  const [showOtherSessions, setShowOtherSessions] = createSignal(false);
  // oxlint-disable-next-line no-unassigned-vars
  let containerRef: HTMLDivElement | undefined;

  const isSessionNeedingAttention = (sessionId: string) =>
    !isRunningSession(sessionId) && isSessionAwaitingInput(sessionId);
  const isSessionFailed = (sessionId: string) => isFailedSession(sessionId);
  const primarySessions = createMemo(() => state.sessions.filter(isPrimarySession));
  const groupedSessions = createMemo(() =>
    groupSessions(
      state.sessions,
      (sessionId) => isRunningSession(sessionId),
      (sessionId) => isSessionNeedingAttention(sessionId),
      (sessionId) => isSessionFailed(sessionId),
      (session) => isPlanReadySession(session),
      (session) => isSessionUnread(session.id, session.time.updated),
      MAX_SURFACED_OTHER_SESSIONS
    )
  );
  const failedSessions = () => groupedSessions().failed;
  const planReadySessions = () => groupedSessions().planReady;
  const attentionSessions = () => groupedSessions().attention;
  const runningSessions = () => groupedSessions().running;
  const newlyCompletedSessions = () => groupedSessions().newlyCompleted;
  const surfacedOtherSessions = () => groupedSessions().surfacedOther;
  const overflowOtherSessions = () => groupedSessions().overflowOther;
  const subagentCounts = createMemo(() => {
    const counts = new Map<string, number>();
    for (const session of state.sessions) {
      if (!session.parentID) continue;
      counts.set(session.parentID, (counts.get(session.parentID) || 0) + 1);
    }
    return counts;
  });
  const subagentSessions = createMemo(() =>
    getSubagentSessionsForParent(state.sessions, props.subagentParentId)
  );
  const filteredSessions = createMemo(() =>
    props.sessionFilter
      ? getPrimarySessionsForFilter(
          primarySessions(),
          props.sessionFilter,
          (sessionId) => isRunningSession(sessionId),
          (sessionId) => isSessionNeedingAttention(sessionId),
          (sessionId) => isSessionFailed(sessionId),
          (session) => isPlanReadySession(session)
        )
      : []
  );
  const directSessions = createMemo(() => {
    if (props.subagentParentId) return subagentSessions();
    if (props.sessionFilter) return filteredSessions();
    return [];
  });
  const prioritySessions = createMemo(() => [
    ...failedSessions(),
    ...planReadySessions(),
    ...attentionSessions(),
    ...runningSessions(),
    ...newlyCompletedSessions(),
  ]);
  const surfacedSessions = createMemo(() => [...prioritySessions(), ...surfacedOtherSessions()]);
  const visibleSessions = createMemo(() => {
    if (props.subagentParentId || props.sessionFilter) return directSessions();

    const sessions = showOtherSessions()
      ? [...surfacedSessions(), ...overflowOtherSessions()]
      : surfacedSessions();
    return sessions;
  });

  createEffect(
    on(
      () => [props.sessionFilter, props.subagentParentId],
      () => {
        setShowOtherSessions(false);
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
        setShowSessionPicker(false);
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setShowSessionPicker(false);
    }
  }

  onMount(() => {
    requestAnimationFrame(() => containerRef?.focus());
  });

  const emptyMessage = () => {
    if (props.subagentParentId) return 'No sub-agent sessions';
    const label = getSessionListFilterLabel(props.sessionFilter);
    return label ? `No ${label.toLowerCase()} sessions` : 'No sessions yet';
  };

  return (
    <div ref={containerRef} class="session-list-view" tabindex="-1" onKeyDown={handleKeydown}>
      <Show
        when={
          props.subagentParentId
            ? subagentSessions().length > 0
            : props.sessionFilter
              ? filteredSessions().length > 0
              : state.sessions.length > 0
        }
        fallback={<div class="session-empty">{emptyMessage()}</div>}
      >
        <Show when={props.subagentParentId || props.sessionFilter}>
          <For each={directSessions()}>
            {(session, index) => (
              <SessionListItem
                session={session}
                itemIndex={() => index()}
                focusedIndex={focusedIndex}
                setFocusedIndex={setFocusedIndex}
                now={now}
                subagentCount={subagentCounts().get(session.id) || 0}
                onOpenSubagents={props.onOpenSubagents}
              />
            )}
          </For>
        </Show>
        <Show when={!props.sessionFilter && !props.subagentParentId && failedSessions().length > 0}>
          <For each={failedSessions()}>
            {(session, index) => (
              <SessionListItem
                session={session}
                itemIndex={() => index()}
                focusedIndex={focusedIndex}
                setFocusedIndex={setFocusedIndex}
                now={now}
                subagentCount={subagentCounts().get(session.id) || 0}
                onOpenSubagents={props.onOpenSubagents}
              />
            )}
          </For>
        </Show>
        <Show
          when={!props.sessionFilter && !props.subagentParentId && planReadySessions().length > 0}
        >
          <For each={planReadySessions()}>
            {(session, index) => (
              <SessionListItem
                session={session}
                itemIndex={() => failedSessions().length + index()}
                focusedIndex={focusedIndex}
                setFocusedIndex={setFocusedIndex}
                now={now}
                subagentCount={subagentCounts().get(session.id) || 0}
                onOpenSubagents={props.onOpenSubagents}
              />
            )}
          </For>
        </Show>
        <Show
          when={!props.sessionFilter && !props.subagentParentId && attentionSessions().length > 0}
        >
          <For each={attentionSessions()}>
            {(session, index) => (
              <SessionListItem
                session={session}
                itemIndex={() => failedSessions().length + planReadySessions().length + index()}
                focusedIndex={focusedIndex}
                setFocusedIndex={setFocusedIndex}
                now={now}
                subagentCount={subagentCounts().get(session.id) || 0}
                onOpenSubagents={props.onOpenSubagents}
              />
            )}
          </For>
        </Show>
        <Show
          when={!props.sessionFilter && !props.subagentParentId && runningSessions().length > 0}
        >
          <For each={runningSessions()}>
            {(session, index) => (
              <SessionListItem
                session={session}
                itemIndex={() =>
                  failedSessions().length +
                  planReadySessions().length +
                  attentionSessions().length +
                  index()
                }
                focusedIndex={focusedIndex}
                setFocusedIndex={setFocusedIndex}
                now={now}
                subagentCount={subagentCounts().get(session.id) || 0}
                onOpenSubagents={props.onOpenSubagents}
              />
            )}
          </For>
        </Show>
        <Show
          when={
            !props.sessionFilter && !props.subagentParentId && newlyCompletedSessions().length > 0
          }
        >
          <For each={newlyCompletedSessions()}>
            {(session, index) => (
              <SessionListItem
                session={session}
                itemIndex={() =>
                  failedSessions().length +
                  planReadySessions().length +
                  attentionSessions().length +
                  runningSessions().length +
                  index()
                }
                focusedIndex={focusedIndex}
                setFocusedIndex={setFocusedIndex}
                now={now}
                subagentCount={subagentCounts().get(session.id) || 0}
                onOpenSubagents={props.onOpenSubagents}
              />
            )}
          </For>
        </Show>
        <Show
          when={
            !props.sessionFilter && !props.subagentParentId && surfacedOtherSessions().length > 0
          }
        >
          <For each={surfacedOtherSessions()}>
            {(session, index) => (
              <SessionListItem
                session={session}
                itemIndex={() => prioritySessions().length + index()}
                focusedIndex={focusedIndex}
                setFocusedIndex={setFocusedIndex}
                now={now}
                subagentCount={subagentCounts().get(session.id) || 0}
                onOpenSubagents={props.onOpenSubagents}
              />
            )}
          </For>
        </Show>
        <Show
          when={
            !props.sessionFilter && !props.subagentParentId && overflowOtherSessions().length > 0
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
                  subagentCount={subagentCounts().get(session.id) || 0}
                  onOpenSubagents={props.onOpenSubagents}
                />
              )}
            </For>
          </Show>
        </Show>
      </Show>
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
  onOpenSubagents: (parentSessionId: string) => void;
}) {
  const isActive = () => props.session.id === state.activeSessionId;
  const isFocused = () => props.focusedIndex() === props.itemIndex();
  const status = () => state.sessionStatus[props.session.id];
  const hasPermissionRequest = () =>
    state.permissions.some((permission) => permission.sessionID === props.session.id);
  const hasQuestionRequest = () =>
    state.questions.some((question) => question.sessionID === props.session.id);
  const isRunning = () => isRunningSession(props.session.id);
  const isFailed = () => isFailedSession(props.session.id);
  const needsAttention = () => !isRunning() && isSessionAwaitingInput(props.session.id);
  const isNewlyCompleted = () =>
    !isRunning() &&
    !isFailed() &&
    !needsAttention() &&
    isSessionUnread(props.session.id, props.session.time.updated);
  const isCompletedPlanSession = () => isPlanReadySession(props.session);
  const hasSubagents = () => props.subagentCount > 0;
  const subagentLabel = () =>
    `Show ${props.subagentCount} sub-agent session${props.subagentCount === 1 ? '' : 's'}`;
  const indicatorClass = () => {
    if (isRunning()) return 'is-running';
    if (isFailed()) return 'is-failed';
    if (needsAttention()) return 'is-attention';
    if (isCompletedPlanSession()) return 'is-plan-completed';
    return 'is-completed';
  };
  const indicatorTitle = () => {
    if (isRunning()) return status()?.type === 'retry' ? 'Retrying' : 'Running';
    if (isFailed()) return 'Failed';
    if (hasPermissionRequest() && hasQuestionRequest()) return 'Attention needed';
    if (hasPermissionRequest()) return 'Permission request pending';
    if (hasQuestionRequest()) return 'Attention needed';
    if (needsAttention()) return 'Input needed';
    if (isCompletedPlanSession()) return 'Plan completed';
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
          setShowSessionPicker(false);
        }}
      >
        <Show
          when={isRunning() || isFailed() || needsAttention() || isNewlyCompleted()}
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
            onClick={() => props.onOpenSubagents(props.session.id)}
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

function isPlanReadySession(session: (typeof state.sessions)[number]) {
  return (
    !isRunningSession(session.id) &&
    !isFailedSession(session.id) &&
    !isSessionAwaitingInput(session.id) &&
    isSessionUnread(session.id, session.time.updated) &&
    getSelectedAgentForSession(session.id) === 'plan'
  );
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
