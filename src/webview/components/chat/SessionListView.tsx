import {
  getSelectedAgentForSession,
  getSessionTreeIds,
  getSessionTreeRootId,
  hasActiveUsageLimit,
  isSessionAwaitingInput,
  isSessionUnread,
  isSkippedPlanSession,
  setShowSessionPicker,
  state,
} from '../../lib/state';
import {
  Show,
  For,
  createSignal,
  onCleanup,
  onMount,
  createEffect,
  createMemo,
  on,
} from 'solid-js';
import {
  selectSession,
  deleteSession,
  restoreSession,
  deleteSessionPermanently,
  emptyRecycleBin,
} from '../../hooks/useOpenCode';
import { normalizeSessionTitle } from '../../../shared/session-title';
import type { RecycleBinEntry } from '../../../shared/protocol';
import { ralphStore } from '../../lib/stores/ralph-store';

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

export type SessionListFilter = 'running' | 'attention' | 'failed' | 'plan-ready' | 'completed';

type SessionListGroupedSection = 'recent' | 'archive' | 'recycle-bin';

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

export function getSubagentSessionsForParent(
  sessions: typeof state.sessions,
  parentSessionId: string | null
) {
  if (!parentSessionId) return [];
  const descendantIds = new Set(getSessionTreeIds(parentSessionId, sessions));
  descendantIds.delete(parentSessionId);
  return sessions.filter((session) => descendantIds.has(session.id));
}

export function shouldShowSessionHeaderBadge(
  activeFilter: SessionListFilter | null,
  badgeFilter: SessionListFilter
) {
  return activeFilter !== badgeFilter;
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

export async function archiveSessionGroup(
  sessions: typeof state.sessions,
  label: string,
  confirmArchive: (message: string) => boolean,
  archiveSession: (sessionId: string) => Promise<void>
) {
  if (sessions.length === 0) return false;
  if (
    !confirmArchive(
      `Archive ${sessions.length} session${sessions.length === 1 ? '' : 's'} in ${label}? This cannot be undone.`
    )
  ) {
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
  ref?: (el: HTMLDivElement) => void;
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onArchive?: () => unknown;
  archiveLabel?: string;
}) {
  const [isConfirmingArchive, setIsConfirmingArchive] = createSignal(false);
  const archiveActionLabel = () => props.archiveLabel || 'Archive';
  const archiveTargetLabel = () =>
    archiveActionLabel().toLowerCase() === props.title.toLowerCase() ? 'sessions' : props.title;

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
    <div ref={(el) => props.ref?.(el)} class="session-list-section-header">
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
                title={`${archiveActionLabel()} ${archiveTargetLabel()}`}
                aria-label={`${archiveActionLabel()} ${archiveTargetLabel()}`}
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
                title={`Confirm ${archiveActionLabel().toLowerCase()} ${archiveTargetLabel()}`}
                aria-label={`Confirm ${archiveActionLabel().toLowerCase()} ${archiveTargetLabel()}`}
              >
                Confirm
              </button>
              <button
                type="button"
                class="session-list-section-cancel"
                onClick={() => setIsConfirmingArchive(false)}
                title={`Cancel ${archiveActionLabel().toLowerCase()} ${archiveTargetLabel()}`}
                aria-label={`Cancel ${archiveActionLabel().toLowerCase()} ${archiveTargetLabel()}`}
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

export function SessionListView(props: {
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
  const [activeGroupedSection, setActiveGroupedSection] =
    createSignal<SessionListGroupedSection | null>(null);
  const [searchQuery, setSearchQuery] = createSignal('');
  let containerRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  let recentHeaderRef: HTMLDivElement | undefined;
  let archiveHeaderRef: HTMLDivElement | undefined;
  let recycleBinHeaderRef: HTMLDivElement | undefined;

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
  const recycleBinEntries = createMemo(() => state.recycleBinEntries || []);
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
  const availableGroupedSections = createMemo(() => {
    const sections: SessionListGroupedSection[] = [];
    if (surfacedSessions().length > 0) sections.push('recent');
    if (overflowOtherSessions().length > 0) sections.push('archive');
    if (recycleBinEntries().length > 0) sections.push('recycle-bin');
    return sections;
  });
  const isDefaultGroupedView = createMemo(
    () => !props.sessionFilter && !props.subagentParentId && !normalizedSearchQuery()
  );
  const showBottomGroups = createMemo(
    () =>
      isDefaultGroupedView() &&
      !activeGroupedSection() &&
      (overflowOtherSessions().length > 0 || recycleBinEntries().length > 0)
  );
  const directSessions = createMemo(() => {
    if (props.subagentParentId) return subagentSessions();
    if (props.sessionFilter) return filteredSessions();
    return [];
  });
  const searchableSessions = createMemo(() => {
    if (props.subagentParentId || props.sessionFilter) return directSessions();
    return [...surfacedSessions(), ...overflowOtherSessions()];
  });
  const baseVisibleSessions = createMemo(() => {
    if (props.subagentParentId || props.sessionFilter) return directSessions();

    switch (activeGroupedSection()) {
      case 'recent':
        return surfacedSessions();
      case 'archive':
        return overflowOtherSessions();
      case 'recycle-bin':
        return [];
      default:
        return surfacedSessions();
    }
  });
  const visibleSessions = createMemo(() => {
    const query = normalizedSearchQuery();
    const sessions =
      shouldShowSearch() && query.length > 0 ? searchableSessions() : baseVisibleSessions();
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
        setActiveGroupedSection(null);
        setSearchQuery('');
        setFocusedIndex(-1);
      }
    )
  );

  createEffect(() => {
    const activeSection = activeGroupedSection();
    if (!activeSection) return;
    if (!availableGroupedSections().includes(activeSection)) setActiveGroupedSection(null);
  });

  createEffect(() => {
    const sessions = visibleSessions();
    setFocusedIndex((current) => {
      if (sessions.length === 0) return -1;
      if (current < 0) return current;
      return Math.min(current, sessions.length - 1);
    });
  });

  createEffect(
    on(
      activeGroupedSection,
      (section, previousSection) => {
        if (!section || section === previousSection) return;
        queueMicrotask(() => {
          const ref =
            section === 'recent'
              ? recentHeaderRef
              : section === 'archive'
                ? archiveHeaderRef
                : recycleBinHeaderRef;
          if (typeof ref?.scrollIntoView === 'function') {
            ref.scrollIntoView({ block: 'nearest' });
          }
        });
      },
      { defer: true }
    )
  );

  const toggleGroupedSection = (section: SessionListGroupedSection) => {
    if (section === 'recent') {
      setActiveGroupedSection(null);
      return;
    }

    setActiveGroupedSection((current) => (current === section ? null : section));
  };

  const renderSessionItems = (sessions: typeof state.sessions, indexOffset = 0) => (
    <For each={sessions}>
      {(session, index) => (
        <SessionListItem
          session={session}
          itemIndex={() => indexOffset + index()}
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
  );

  const renderBottomGroups = () => (
    <div class="session-list-bottom-groups">
      <Show when={overflowOtherSessions().length > 0}>
        <SessionListSectionHeader
          ref={(el) => {
            archiveHeaderRef = el;
          }}
          title="Archive"
          count={overflowOtherSessions().length}
          expanded={false}
          onToggle={() => toggleGroupedSection('archive')}
          onArchive={() => archiveSessions(overflowOtherSessions(), deleteSession)}
        />
      </Show>
      <Show when={recycleBinEntries().length > 0}>
        <SessionListSectionHeader
          ref={(el) => {
            recycleBinHeaderRef = el;
          }}
          title="Recycle Bin"
          count={recycleBinEntries().length}
          expanded={false}
          onToggle={() => toggleGroupedSection('recycle-bin')}
          onArchive={() => emptyRecycleBin()}
          archiveLabel="Empty"
        />
      </Show>
    </div>
  );

  const renderScrollableContent = () => (
    <div class="session-list-scroll">
      <Show when={props.subagentParentId || props.sessionFilter || normalizedSearchQuery()}>
        {renderSessionItems(visibleSessions())}
      </Show>
      <Show
        when={isDefaultGroupedView() && !activeGroupedSection() && surfacedSessions().length > 0}
      >
        {renderSessionItems(surfacedSessions())}
      </Show>
      <Show when={isDefaultGroupedView() && !!activeGroupedSection()}>
        <For each={availableGroupedSections()}>{(section) => renderGroupedSection(section)}</For>
      </Show>
    </div>
  );

  const renderGroupedSection = (section: SessionListGroupedSection) => {
    const expanded = () => activeGroupedSection() === section;

    switch (section) {
      case 'recent':
        return (
          <>
            <SessionListSectionHeader
              ref={(el) => {
                recentHeaderRef = el;
              }}
              title="Recent"
              count={surfacedSessions().length}
              expanded={expanded()}
              onToggle={() => toggleGroupedSection('recent')}
            />
            <Show when={expanded()}>{renderSessionItems(surfacedSessions())}</Show>
          </>
        );
      case 'archive':
        return (
          <>
            <SessionListSectionHeader
              ref={(el) => {
                archiveHeaderRef = el;
              }}
              title="Archive"
              count={overflowOtherSessions().length}
              expanded={expanded()}
              onToggle={() => toggleGroupedSection('archive')}
              onArchive={() => archiveSessions(overflowOtherSessions(), deleteSession)}
            />
            <Show when={expanded()}>{renderSessionItems(overflowOtherSessions())}</Show>
          </>
        );
      case 'recycle-bin':
        return (
          <>
            <SessionListSectionHeader
              ref={(el) => {
                recycleBinHeaderRef = el;
              }}
              title="Recycle Bin"
              count={recycleBinEntries().length}
              expanded={expanded()}
              onToggle={() => toggleGroupedSection('recycle-bin')}
              onArchive={() => emptyRecycleBin()}
              archiveLabel="Empty"
            />
            <Show when={expanded()}>
              <For each={recycleBinEntries()}>
                {(entry) => <RecycleBinListItem entry={entry} now={now} />}
              </For>
            </Show>
          </>
        );
    }
  };

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
    return state.sessions.length > 0 || recycleBinEntries().length > 0;
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
            onFocus={() => setFocusedIndex(-1)}
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
      <Show when={hasVisibleContent()} fallback={<div class="session-empty">{emptyMessage()}</div>}>
        <Show when={showBottomGroups()} fallback={renderScrollableContent()}>
          <div class="session-list-layout">
            <div class="session-list-scroll session-list-scroll-primary">
              {renderSessionItems(surfacedSessions())}
            </div>
            {renderBottomGroups()}
          </div>
        </Show>
      </Show>
    </div>
  );
}

function RecycleBinListItem(props: { entry: RecycleBinEntry; now: () => number }) {
  const childCount = () => Math.max(0, props.entry.sessions.length - 1);

  return (
    <div class="session-item recycle-bin-item">
      <div class="session-item-main recycle-bin-item-main">
        <span class="session-item-indicator-spacer" />
        <div class="session-item-content">
          <span class="session-item-title">
            {normalizeSessionTitle(props.entry.root.title) || 'Untitled'}
          </span>
          <span class="session-item-meta">
            Deleted {formatSessionAge(props.entry.deletedAt, props.now())} ago
            <Show when={childCount() > 0}>
              {' '}
              · {childCount()} sub-agent{childCount() === 1 ? '' : 's'}
            </Show>
            {' · '}expires in {formatDurationFromNow(props.entry.expiresAt, props.now())}
          </span>
        </div>
      </div>
      <div class="session-item-trailing">
        <button
          type="button"
          class="session-item-subagents recycle-bin-restore"
          onClick={() => void restoreSession(props.entry.rootID)}
          title="Restore"
          aria-label="Restore"
        >
          Restore
        </button>
        <button
          type="button"
          class="session-item-archive recycle-bin-delete"
          onClick={() => void deleteSessionPermanently(props.entry.rootID)}
          title="Delete permanently"
          aria-label="Delete permanently"
        >
          <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
            <path d="M17 24h-2v-9h2v9zm4-9h-2v9h2v-9zm-8 0h-2v9h2v-9zm14-2h-1.064l-1 15H7.064l-1-15H5V7h7V4h8v3h7v6zM14 7h4V6h-4v1zm-7 4h18V9H7v2zm16.931 2H8.069l.866 13h14.129l.867-13z" />
          </svg>
        </button>
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
  const showsPlanModeTag = () =>
    getSelectedAgentForSession(props.session.id) === 'plan' &&
    (props.isRunning || props.needsAttention);
  const subagentLabel = () =>
    `Show ${props.subagentCount} sub-agent session${props.subagentCount === 1 ? '' : 's'}`;
  const ralphSummary = () => {
    const run = ralphStore.getRun(props.session.id);
    if (!run) return null;
    const unique = new Set<string>();
    for (const it of run.iterations) {
      for (const f of it.filesChanged) unique.add(f);
    }
    return { files: unique.size, iterations: run.iterations.length };
  };
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
            <Show
              when={ralphSummary()}
              fallback={
                <Show when={props.session.summary}>
                  {props.session.summary!.files} file
                  {props.session.summary!.files !== 1 ? 's' : ''}
                  {' · '}
                  <span class="diff-lines-added">+{props.session.summary!.additions}</span>{' '}
                  <span class="diff-lines-removed">-{props.session.summary!.deletions}</span>
                </Show>
              }
            >
              {(summary) => (
                <>
                  {summary().files} file{summary().files !== 1 ? 's' : ''} changed
                  {' · '}
                  {summary().iterations} iteration{summary().iterations !== 1 ? 's' : ''}
                </>
              )}
            </Show>
          </span>
        </div>
      </button>
      <div class="session-item-trailing">
        <Show when={ralphStore.isRalphSession(props.session.id)}>
          <span class="session-item-ralph-tag" title="Ralph loop" aria-label="Ralph loop">
            Ralph
          </span>
        </Show>
        <Show when={showsPlanModeTag()}>
          <span class="session-item-plan-tag" title="Plan mode" aria-label="Plan mode">
            Plan
          </span>
        </Show>
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

function formatDurationFromNow(timestamp: number, now: number): string {
  return formatSessionAge(now + Math.max(0, timestamp - now), now);
}

export function deriveSessionIndicators(sessions: typeof state.sessions): SessionIndicatorSets {
  const subagentCounts = new Map<string, number>();
  const failedSessionIds = new Set(state.failedSessionIds);
  const rootSessionId = (sessionId: string) => getSessionTreeRootId(sessionId) || sessionId;
  const permissionIds = new Set<string>();
  for (const permission of state.permissions) {
    permissionIds.add(permission.sessionID);
    permissionIds.add(rootSessionId(permission.sessionID));
  }
  const questionIds = new Set<string>();
  for (const question of state.questions) {
    questionIds.add(question.sessionID);
    questionIds.add(rootSessionId(question.sessionID));
  }
  const runningIds = new Set<string>();
  const failedIds = new Set<string>();
  const attentionIds = new Set<string>();
  const planReadyIds = new Set<string>();
  const newlyCompletedIds = new Set<string>();
  const descendantSubagentCountByRoot = new Map<string, number>();
  const isAwaitingInput = (sessionId: string) =>
    permissionIds.has(rootSessionId(sessionId)) || questionIds.has(rootSessionId(sessionId));
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
      const rootId = rootSessionId(session.id);
      descendantSubagentCountByRoot.set(
        rootId,
        (descendantSubagentCountByRoot.get(rootId) || 0) + 1
      );
    }

    const sessionId = session.id;
    const displaySessionId = rootSessionId(sessionId);
    const failed = isFailed(sessionId);
    const hasPrompt = permissionIds.has(displaySessionId) || questionIds.has(displaySessionId);
    const needsAttention = !failed && (hasPrompt || isAwaitingInput(sessionId));
    const running = !needsAttention && isRunning(sessionId);

    if (failed) {
      failedIds.add(displaySessionId);
      failedIds.add(sessionId);
      continue;
    }
    if (needsAttention) {
      attentionIds.add(displaySessionId);
      attentionIds.add(sessionId);
      continue;
    }
    if (running) {
      runningIds.add(displaySessionId);
      runningIds.add(sessionId);
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

  for (const session of sessions) {
    const rootId = rootSessionId(session.id);
    const count = descendantSubagentCountByRoot.get(rootId) || 0;
    if (count > 0) {
      subagentCounts.set(session.id, count);
    }
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

export function isPrimarySession(session: (typeof state.sessions)[number]) {
  return !session.parentID;
}
