import {
  getSelectedAgentForSession,
  getSessionTreeIds,
  getSessionTreeRootId,
  hasActiveUsageLimit,
  isSessionAwaitingInput,
  isSessionCompletedResponseUnread,
  isSessionUnread,
  isSkippedPlanSession,
  setPersistentShowSessionPicker as setShowSessionPicker,
  setError,
  setState,
  sessionSearchFocusKey,
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
  untrack,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  selectSession,
  deleteSession,
  restoreSession,
  deleteSessionPermanently,
  emptyRecycleBin,
  renameSession,
} from '../../hooks/useOpenCode';
import { normalizeSessionTitle } from '../../../shared/session-title';
import type { RecycleBinEntry, SessionDiffSummary } from '../../../shared/protocol';
import type { Part, Session } from '../../types';
import { client } from '../../lib/client';
import { getMessageFileChanges } from '../../lib/tool-file-change';
import { ralphStore } from '../../lib/stores/ralph-store';
import { isEmptySession, shouldHideEmptySessionFromList } from '../../lib/empty-session';
import { formatEditCount } from '../../lib/format';
import { formatDuration, formatRelativeAge } from '../../lib/message-metrics';
import { clampPopupToViewport } from '../../lib/popup-position';
import { compareSessionsByActivity } from '../../lib/session-order';
import { writeClipboard } from '../../lib/write-clipboard';

type SessionGroups = {
  pinned: (typeof state.sessions)[number][];
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

type SessionSummaryStats = {
  files: number;
  additions: number;
  deletions: number;
};

type SessionDiffSummaryCacheEntry = {
  status: 'loading' | 'ready' | 'error';
  updated: number;
  stats: SessionDiffSummary | null;
};

type SessionDiffSummaryRequest = {
  sessionId: string;
  updated: number;
};

type SessionActionsState = {
  sessionId: () => string | null;
  position: () => { x: number; y: number };
  renaming: () => boolean;
  renameValue: () => string;
  renameSelection: () => { start: number; end: number } | null;
  renamePending: () => boolean;
  open: (sessionId: string, event: MouseEvent) => void;
  close: () => void;
  beginRename: (title: string) => void;
  setRenaming: (renaming: boolean) => void;
  setRenameValue: (value: string) => void;
  setRenameSelection: (selection: { start: number; end: number }) => void;
  setRenamePending: (pending: boolean) => void;
};

export type SessionStatusIndicatorKind =
  | 'failed'
  | 'attention'
  | 'running'
  | 'plan-ready'
  | 'completed';

const SESSION_SHOW_MORE_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_DIFF_SUMMARY_CONCURRENCY = 4;
const SESSION_DIFF_SUMMARY_QUEUE_LIMIT = 100;
const SESSION_DIFF_SUMMARY_CACHE_LIMIT = 200;

function getDiffSummaryKey(sessionId: string, updated: number): string {
  return `${sessionId}:${updated}`;
}

function getSessionTreeUpdated(sessionId: string): number {
  const treeIds = new Set(getSessionTreeIds(sessionId));
  let updated = 0;
  for (const session of state.sessions) {
    if (treeIds.has(session.id)) updated = Math.max(updated, session.time.updated);
  }
  return updated;
}

// Module-scoped so cached diff summaries survive the session list being
// unmounted and remounted (navigating away and back). Persisting the cache and
// keeping the last-known stats while refreshing avoids the "0 0 0 -> numbers"
// flash on every return.
const [sessionDiffSummaryCache, setSessionDiffSummaryCache] = createSignal<
  Record<string, SessionDiffSummaryCacheEntry | undefined>
>({});
let activeDiffSummaryRequests = 0;
const diffSummaryQueue: SessionDiffSummaryRequest[] = [];
const queuedDiffSummaryKeys = new Set<string>();
const activeDiffSummaryKeys = new Set<string>();
const diffSummaryCacheOrder: string[] = [];
const relevantDiffSummarySessionsByOwner = new Map<symbol, Set<string>>();
let relevantDiffSummarySessionIds = new Set<string>();

function setDiffSummaryCacheEntry(sessionId: string, entry: SessionDiffSummaryCacheEntry) {
  const previousOrderIndex = diffSummaryCacheOrder.indexOf(sessionId);
  if (previousOrderIndex !== -1) diffSummaryCacheOrder.splice(previousOrderIndex, 1);
  diffSummaryCacheOrder.push(sessionId);

  const evictedSessionIds: string[] = [];
  while (diffSummaryCacheOrder.length > SESSION_DIFF_SUMMARY_CACHE_LIMIT) {
    const evicted = diffSummaryCacheOrder.shift();
    if (evicted) evictedSessionIds.push(evicted);
  }

  setSessionDiffSummaryCache((cache) => {
    const next = { ...cache, [sessionId]: entry };
    for (const evictedSessionId of evictedSessionIds) delete next[evictedSessionId];
    return next;
  });
}

function updateRelevantDiffSummarySessions(owner: symbol, sessionIds: Set<string> | null) {
  if (sessionIds) relevantDiffSummarySessionsByOwner.set(owner, sessionIds);
  else relevantDiffSummarySessionsByOwner.delete(owner);

  relevantDiffSummarySessionIds = new Set(
    Array.from(relevantDiffSummarySessionsByOwner.values()).flatMap((ids) => Array.from(ids))
  );

  for (let index = diffSummaryQueue.length - 1; index >= 0; index -= 1) {
    const request = diffSummaryQueue[index]!;
    if (relevantDiffSummarySessionIds.has(request.sessionId)) continue;
    diffSummaryQueue.splice(index, 1);
    queuedDiffSummaryKeys.delete(getDiffSummaryKey(request.sessionId, request.updated));
  }
}

function isCurrentDiffSummaryRequest(request: SessionDiffSummaryRequest) {
  return (
    relevantDiffSummarySessionIds.has(request.sessionId) &&
    getSessionTreeUpdated(request.sessionId) === request.updated
  );
}

function enqueueDiffSummaryRequest(session: Session) {
  const updated = getSessionTreeUpdated(session.id);
  const cache = untrack(sessionDiffSummaryCache);
  const cached = cache[session.id];
  // A matching failure is settled for this revision. Retrying from this reactive
  // effect would otherwise form a tight request loop until the server recovers.
  if (cached?.updated === updated && (cached.status === 'ready' || cached.status === 'error')) {
    return;
  }

  const key = getDiffSummaryKey(session.id, updated);
  if (queuedDiffSummaryKeys.has(key) || activeDiffSummaryKeys.has(key)) return;
  if (diffSummaryQueue.length >= SESSION_DIFF_SUMMARY_QUEUE_LIMIT) return;

  queuedDiffSummaryKeys.add(key);
  diffSummaryQueue.push({ sessionId: session.id, updated });
  setDiffSummaryCacheEntry(session.id, {
    // Keep showing the previous numbers while the refresh is in flight.
    status: 'loading',
    updated,
    stats: cached?.stats ?? null,
  });
  pumpDiffSummaryQueue();
}

function pumpDiffSummaryQueue() {
  while (
    activeDiffSummaryRequests < SESSION_DIFF_SUMMARY_CONCURRENCY &&
    diffSummaryQueue.length > 0
  ) {
    const request = diffSummaryQueue.shift()!;
    const requestKey = getDiffSummaryKey(request.sessionId, request.updated);
    queuedDiffSummaryKeys.delete(requestKey);

    if (!isCurrentDiffSummaryRequest(request)) continue;

    activeDiffSummaryRequests += 1;
    activeDiffSummaryKeys.add(requestKey);
    void client.varro.session
      .diffSummary(request.sessionId)
      .then((summary) => {
        if (!isCurrentDiffSummaryRequest(request)) return;
        setDiffSummaryCacheEntry(request.sessionId, {
          status: 'ready',
          updated: request.updated,
          stats: summary,
        });
      })
      .catch(() => {
        if (!isCurrentDiffSummaryRequest(request)) return;
        setDiffSummaryCacheEntry(request.sessionId, {
          status: 'error',
          updated: request.updated,
          stats: sessionDiffSummaryCache()[request.sessionId]?.stats ?? null,
        });
      })
      .finally(() => {
        activeDiffSummaryRequests -= 1;
        activeDiffSummaryKeys.delete(requestKey);
        pumpDiffSummaryQueue();
      });
  }
}

export function getSessionDiffSummaryStateForTests() {
  return {
    active: activeDiffSummaryRequests,
    queued: diffSummaryQueue.length,
    cached: Object.keys(sessionDiffSummaryCache()).length,
    queueLimit: SESSION_DIFF_SUMMARY_QUEUE_LIMIT,
    cacheLimit: SESSION_DIFF_SUMMARY_CACHE_LIMIT,
  };
}

export function resetSessionDiffSummaryStateForTests() {
  activeDiffSummaryRequests = 0;
  diffSummaryQueue.length = 0;
  queuedDiffSummaryKeys.clear();
  activeDiffSummaryKeys.clear();
  diffSummaryCacheOrder.length = 0;
  relevantDiffSummarySessionsByOwner.clear();
  relevantDiffSummarySessionIds.clear();
  setSessionDiffSummaryCache({});
}

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

export function getSessionStatusIndicatorKind(input: {
  isFailed: boolean;
  hasPendingInput: boolean;
  isRunning: boolean;
  isPlanReady: boolean;
  isCompleted: boolean;
}): SessionStatusIndicatorKind | null {
  if (input.isFailed) return 'failed';
  if (input.hasPendingInput) return 'attention';
  if (input.isRunning) return 'running';
  if (input.isPlanReady) return 'plan-ready';
  if (input.isCompleted) return 'completed';
  return null;
}

export function getSessionStatusIndicatorClass(kind: SessionStatusIndicatorKind) {
  switch (kind) {
    case 'failed':
      return 'is-failed';
    case 'attention':
      return 'is-attention';
    case 'running':
      return 'is-running';
    case 'plan-ready':
      return 'is-plan-completed';
    case 'completed':
      return 'is-completed';
  }
}

export function getSessionStatusIndicatorTitle(
  kind: SessionStatusIndicatorKind,
  options?: { retrying?: boolean }
) {
  switch (kind) {
    case 'failed':
      return 'Failed';
    case 'attention':
      return 'Attention needed';
    case 'running':
      return options?.retrying ? 'Retrying' : 'Running';
    case 'plan-ready':
      return 'Plan ready';
    case 'completed':
      return 'Completed';
  }
}

export function getSessionSummaryStats(
  session: Pick<Session, 'summary'>,
  fallback?: SessionSummaryStats | null
): SessionSummaryStats | null {
  const summary = session.summary;
  if (!summary) return fallback ?? null;

  const diffs = Array.isArray(summary.diffs) ? summary.diffs : [];
  if (diffs.length > 0) {
    return getDiffSummaryStats(diffs);
  }

  const aggregate = {
    files: summary.files,
    additions: summary.additions,
    deletions: summary.deletions,
  } satisfies SessionSummaryStats;
  return fallback && !hasSessionSummaryEdits(aggregate) ? fallback : aggregate;
}

export function getDiffSummaryStats(diffs: readonly unknown[]): SessionSummaryStats | null {
  if (diffs.length === 0) return null;

  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const diff of diffs) {
    if (!diff || typeof diff !== 'object') continue;
    const file = (diff as Record<string, unknown>).file;
    if (typeof file === 'string' && file) files.add(file);
    additions += readDiffCount(diff, 'additions', 'added');
    deletions += readDiffCount(diff, 'deletions', 'removed');
  }

  return {
    files: files.size || diffs.length,
    additions,
    deletions,
  } satisfies SessionSummaryStats;
}

export function getMessageToolSummaryStats(
  messages: readonly { info?: { summary?: unknown }; parts: readonly Part[] }[]
): SessionSummaryStats | null {
  // Derive from the shared file-change enumeration so the session list count
  // matches the in-chat Files block exactly.
  const changes = getMessageFileChanges(messages, state.editorContext.workspacePath);
  if (changes.length === 0) return null;

  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    additions += change.additions ?? 0;
    deletions += change.deletions ?? 0;
  }
  return { files: changes.length, additions, deletions } satisfies SessionSummaryStats;
}

function hasSessionSummaryEdits(stats: SessionSummaryStats) {
  return stats.files > 0 || stats.additions > 0 || stats.deletions > 0;
}

function readDiffCount(
  diff: unknown,
  primaryKey: 'additions' | 'deletions',
  fallbackKey: 'added' | 'removed'
): number {
  if (!diff || typeof diff !== 'object') return 0;
  const record = diff as Record<string, unknown>;
  const primary = record[primaryKey];
  if (typeof primary === 'number') return primary;
  const fallback = record[fallbackKey];
  return typeof fallback === 'number' ? fallback : 0;
}

export function groupSessions(
  sessions: typeof state.sessions,
  isRunning: (sessionId: string) => boolean,
  isNeedingAttention: (sessionId: string) => boolean,
  isFailed: (sessionId: string) => boolean,
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean,
  isNewlyCompleted: (session: (typeof state.sessions)[number]) => boolean,
  now: number,
  isPinned: (sessionId: string) => boolean = () => false
): SessionGroups {
  const primaries: (typeof state.sessions)[number][] = [];
  const subagents: (typeof state.sessions)[number][] = [];

  for (const session of sessions) {
    if (session.parentID) subagents.push(session);
    else primaries.push(session);
  }

  primaries.sort((left, right) => compareSessionsByActivity(left, right, now));
  const failed: SessionGroups['failed'] = [];
  const pinned: SessionGroups['pinned'] = [];
  const planReady: SessionGroups['planReady'] = [];
  const attention: SessionGroups['attention'] = [];
  const running: SessionGroups['running'] = [];
  const newlyCompleted: SessionGroups['newlyCompleted'] = [];
  const surfacedOther: SessionGroups['surfacedOther'] = [];
  const overflowOther: SessionGroups['overflowOther'] = [];
  const recentSessionCutoff = now - SESSION_SHOW_MORE_AGE_MS;

  for (const session of primaries) {
    if (isPinned(session.id)) {
      pinned.push(session);
      continue;
    }
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
    pinned,
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

function sortSessionsForDisplay(sessions: typeof state.sessions, now: number) {
  return sessions.toSorted((left, right) => {
    const pinRank =
      Number(state.pinnedSessionIds.includes(right.id)) -
      Number(state.pinnedSessionIds.includes(left.id));
    return pinRank || compareSessionsByActivity(left, right, now);
  });
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
  const diffSummaryOwner = Symbol('session-list');
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1_000);
  onCleanup(() => clearInterval(clock));

  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  const [activeGroupedSection, setActiveGroupedSection] =
    createSignal<SessionListGroupedSection | null>(null);
  const [searchQuery, setSearchQuery] = createSignal('');
  const [actionsSessionId, setActionsSessionId] = createSignal<string | null>(null);
  const [actionsPosition, setActionsPosition] = createSignal({ x: 0, y: 0 });
  const [frozenSessionOrder, setFrozenSessionOrder] = createSignal<string[] | null>(null);
  const [renaming, setRenaming] = createSignal(false);
  const [renameValue, setRenameValue] = createSignal('');
  const [renameSelection, setRenameSelection] = createSignal<{
    start: number;
    end: number;
  } | null>(null);
  const [renamePending, setRenamePending] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  let recentHeaderRef: HTMLDivElement | undefined;
  let archiveHeaderRef: HTMLDivElement | undefined;
  let recycleBinHeaderRef: HTMLDivElement | undefined;
  let hasPointerInteraction = false;

  const closeActions = () => {
    setActionsSessionId(null);
    setFrozenSessionOrder(null);
    setRenaming(false);
    setRenamePending(false);
  };
  const sessionActions: SessionActionsState = {
    sessionId: actionsSessionId,
    position: actionsPosition,
    renaming,
    renameValue,
    renameSelection,
    renamePending,
    open: (sessionId, event) => {
      event.preventDefault();
      setFocusedIndex(-1);
      setActionsPosition({ x: event.clientX, y: event.clientY });
      setFrozenSessionOrder(visibleSessions().map((session) => session.id));
      setRenaming(false);
      setActionsSessionId(sessionId);
    },
    close: closeActions,
    beginRename: (title) => {
      setRenameValue(normalizeSessionTitle(title) || '');
      setRenameSelection(null);
      setRenaming(true);
    },
    setRenaming,
    setRenameValue,
    setRenameSelection,
    setRenamePending,
  };

  const normalizedSearchQuery = createMemo(() => searchQuery().trim().toLowerCase());
  const shouldShowSearch = createMemo(() => !props.subagentParentId && !props.sessionFilter);

  const sessionIndicators = createMemo(() => deriveSessionIndicators(state.sessions));
  const visibleSessionsForList = createMemo(() => {
    return state.sessions.filter((session) => {
      return !shouldHideEmptySessionFromList(session, {
        isQueued: (sessionId) => state.queuedMessages.some((item) => item.sessionId === sessionId),
        isAwaitingInput: isSessionAwaitingInput,
        isRunning: (sessionId) => sessionIndicators().runningIds.has(sessionId),
        needsAttention: (sessionId) => sessionIndicators().attentionIds.has(sessionId),
        isFailed: (sessionId) => sessionIndicators().failedIds.has(sessionId),
        isPlanReady: (item) => sessionIndicators().planReadyIds.has(item.id),
        preserve: ralphStore.isRalphSession(session.id),
        statusType: state.sessionStatus[session.id]?.type,
      });
    });
  });
  const primarySessions = createMemo(() => visibleSessionsForList().filter(isPrimarySession));
  const groupedSessions = createMemo(() =>
    groupSessions(
      visibleSessionsForList(),
      (sessionId) => sessionIndicators().runningIds.has(sessionId),
      (sessionId) => sessionIndicators().attentionIds.has(sessionId),
      (sessionId) => sessionIndicators().failedIds.has(sessionId),
      (session) => sessionIndicators().planReadyIds.has(session.id),
      (session) => sessionIndicators().newlyCompletedIds.has(session.id),
      now(),
      (sessionId) => state.pinnedSessionIds.includes(sessionId)
    )
  );
  const pinnedSessions = () => groupedSessions().pinned;
  const failedSessions = () => groupedSessions().failed;
  const planReadySessions = () => groupedSessions().planReady;
  const attentionSessions = () => groupedSessions().attention;
  const runningSessions = () => groupedSessions().running;
  const newlyCompletedSessions = () => groupedSessions().newlyCompleted;
  const surfacedOtherSessions = () => groupedSessions().surfacedOther;
  const overflowOtherSessions = () => groupedSessions().overflowOther;
  const subagentSessions = createMemo(() =>
    getSubagentSessionsForParent(visibleSessionsForList(), props.subagentParentId ?? null)
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
  const defaultSurfacedSessions = createMemo(() =>
    sortSessionsForDisplay(
      [
        ...pinnedSessions(),
        ...failedSessions(),
        ...planReadySessions(),
        ...attentionSessions(),
        ...runningSessions(),
        ...newlyCompletedSessions(),
        ...surfacedOtherSessions(),
      ],
      now()
    )
  );
  const surfacedSessions = createMemo(() => {
    const sessions = defaultSurfacedSessions();
    return sessions.length > 0 ? sessions : overflowOtherSessions();
  });
  const availableGroupedSections = createMemo(() => {
    const sections: SessionListGroupedSection[] = [];
    if (defaultSurfacedSessions().length > 0) sections.push('recent');
    if (defaultSurfacedSessions().length > 0 && overflowOtherSessions().length > 0) {
      sections.push('archive');
    }
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
      ((defaultSurfacedSessions().length > 0 && overflowOtherSessions().length > 0) ||
        recycleBinEntries().length > 0)
  );
  const directSessions = createMemo(() => {
    if (props.subagentParentId) return subagentSessions();
    if (props.sessionFilter) return filteredSessions();
    return [];
  });
  const searchableSessions = createMemo(() => {
    if (props.subagentParentId) return directSessions();
    if (props.sessionFilter) return sortSessionsForDisplay(directSessions(), now());
    if (defaultSurfacedSessions().length === 0) return overflowOtherSessions();
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

  createEffect(() => {
    const sessions = visibleSessions();
    updateRelevantDiffSummarySessions(
      diffSummaryOwner,
      new Set(sessions.map((session) => session.id))
    );
    for (const session of sessions) {
      enqueueDiffSummaryRequest(session);
    }
  });
  onCleanup(() => updateRelevantDiffSummarySessions(diffSummaryOwner, null));

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
    const sessionId = actionsSessionId();
    if (sessionId && !state.sessions.some((session) => session.id === sessionId)) closeActions();
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
    <For
      each={(() => {
        const frozenOrder = frozenSessionOrder();
        if (!frozenOrder) return sessions;
        const positions = new Map(frozenOrder.map((sessionId, index) => [sessionId, index]));
        return sessions.toSorted((a, b) => {
          const aPosition = positions.get(a.id) ?? Number.MAX_SAFE_INTEGER;
          const bPosition = positions.get(b.id) ?? Number.MAX_SAFE_INTEGER;
          return aPosition - bPosition;
        });
      })()}
    >
      {(session, index) => (
        <SessionListItem
          session={session}
          diffSummary={sessionDiffSummaryCache()[session.id]?.stats ?? null}
          isSummaryLoading={
            sessionDiffSummaryCache()[session.id]?.status === 'loading' &&
            sessionDiffSummaryCache()[session.id]?.stats === null
          }
          tokens={sessionDiffSummaryCache()[session.id]?.stats?.tokens ?? null}
          durationMs={sessionDiffSummaryCache()[session.id]?.stats?.durationMs ?? null}
          activeStartedAt={sessionDiffSummaryCache()[session.id]?.stats?.activeStartedAt ?? null}
          itemIndex={() => indexOffset + index()}
          focusedIndex={focusedIndex}
          setFocusedIndex={setFocusedIndex}
          actions={sessionActions}
          now={now}
          subagentCount={sessionIndicators().subagentCounts.get(session.id) || 0}
          hasPermissionRequest={sessionIndicators().permissionIds.has(session.id)}
          hasQuestionRequest={sessionIndicators().questionIds.has(session.id)}
          isRunning={sessionIndicators().runningIds.has(session.id)}
          isFailed={sessionIndicators().failedIds.has(session.id)}
          needsAttention={sessionIndicators().attentionIds.has(session.id)}
          isNewlyCompleted={sessionIndicators().newlyCompletedIds.has(session.id)}
          isCompletedPlanSession={sessionIndicators().planReadyIds.has(session.id)}
          isPinned={state.pinnedSessionIds.includes(session.id)}
          onTogglePinned={async () => {
            try {
              const pinnedSessionIds = await client.varro.session.setPinned(
                session.id,
                !state.pinnedSessionIds.includes(session.id)
              );
              setState('pinnedSessionIds', pinnedSessionIds);
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            }
          }}
          onOpenSubagents={props.onOpenSubagents}
          embedded={props.embedded}
        />
      )}
    </For>
  );

  const renderBottomGroups = () => (
    <div class="session-list-bottom-groups">
      <Show when={overflowOtherSessions().length > 0}>
        <Show when={defaultSurfacedSessions().length > 0}>
          <SessionListSectionHeader
            ref={(el) => {
              archiveHeaderRef = el;
            }}
            title="Archive"
            count={overflowOtherSessions().length}
            expanded={false}
            onToggle={() => toggleGroupedSection('archive')}
          />
        </Show>
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

    const scrollFocusedIntoView = () => {
      queueMicrotask(() => {
        containerRef
          ?.querySelector<HTMLElement>('.session-item.keyboard-focus')
          ?.scrollIntoView({ block: 'nearest' });
      });
    };

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex((i) => {
        const next = i + 1;
        return next >= sessions.length ? 0 : next;
      });
      scrollFocusedIntoView();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex((i) => {
        const next = i - 1;
        return next < 0 ? sessions.length - 1 : next;
      });
      scrollFocusedIntoView();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const idx = focusedIndex();
      if (idx >= 0 && idx < sessions.length) {
        selectSession(sessions[idx]!.id);
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
    const focusFrame = requestAnimationFrame(() => {
      if (hasPointerInteraction) return;
      if (shouldShowSearch()) {
        searchInputRef?.focus();
        return;
      }
      containerRef?.focus();
    });
    onCleanup(() => cancelAnimationFrame(focusFrame));
  });

  createEffect(
    on(
      sessionSearchFocusKey,
      (key) => {
        if (key === 0) return;
        queueMicrotask(() => {
          if (shouldShowSearch()) searchInputRef?.focus();
        });
      },
      { defer: true }
    )
  );

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
      onPointerDown={() => {
        hasPointerInteraction = true;
      }}
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
      <div class="session-list-content">
        <Show
          when={hasVisibleContent()}
          fallback={<div class="session-empty">{emptyMessage()}</div>}
        >
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
    </div>
  );
}

function RecycleBinListItem(props: { entry: RecycleBinEntry; now: () => number }) {
  const title = () => normalizeSessionTitle(props.entry.root?.title || props.entry.rootID);
  const childCount = () => {
    const sessions = Array.isArray(props.entry.sessions) ? props.entry.sessions : [];
    return Math.max(0, sessions.length - 1);
  };

  return (
    <div class="session-item recycle-bin-item">
      <div class="session-item-main recycle-bin-item-main">
        <span class="session-item-indicator-spacer" />
        <div class="session-item-content">
          <span class="session-item-title">{title() || 'Untitled'}</span>
          <span class="session-item-meta">
            Deleted {formatRelativeAge(props.entry.deletedAt, props.now())} ago
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
  diffSummary: SessionSummaryStats | null;
  isSummaryLoading: boolean;
  tokens: number | null;
  durationMs: number | null;
  activeStartedAt: number | null;
  itemIndex: () => number;
  focusedIndex: () => number;
  setFocusedIndex: (index: number) => void;
  actions: SessionActionsState;
  now: () => number;
  subagentCount: number;
  hasPermissionRequest: boolean;
  hasQuestionRequest: boolean;
  isRunning: boolean;
  isFailed: boolean;
  needsAttention: boolean;
  isNewlyCompleted: boolean;
  isCompletedPlanSession: boolean;
  isPinned: boolean;
  onTogglePinned: () => Promise<void>;
  onOpenSubagents?: (parentSessionId: string) => void;
  embedded?: boolean;
}) {
  let sessionButtonRef: HTMLButtonElement | undefined;
  let actionsMenuRef: HTMLDivElement | undefined;
  let renameInputRef: HTMLInputElement | undefined;
  let openedPointerId: number | null = null;
  let pointerClickTimer: ReturnType<typeof setTimeout> | undefined;
  const isFocused = () => props.focusedIndex() === props.itemIndex();
  const isActive = () => !!props.embedded && state.activeSessionId === props.session.id;
  const showActions = () => props.actions.sessionId() === props.session.id;
  const status = () => state.sessionStatus[props.session.id];
  const hasUnreadCompletion = () =>
    props.isNewlyCompleted ||
    (props.isCompletedPlanSession && isSessionUnread(props.session.id, props.session.time.updated));
  const hasPendingInput = () =>
    props.hasPermissionRequest || props.hasQuestionRequest || props.needsAttention;
  const hasSubagents = () => !!props.onOpenSubagents && props.subagentCount > 0;
  const showsPlanModeTag = () =>
    getSelectedAgentForSession(props.session.id) === 'plan' &&
    (props.isRunning || props.needsAttention || props.isCompletedPlanSession);
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
  const summaryStats = () => props.diffSummary ?? getSessionSummaryStats(props.session);
  const workedDurationMs = () => {
    if (props.durationMs === null) return null;
    const activeDuration =
      props.isRunning && props.activeStartedAt !== null
        ? Math.max(0, props.now() - props.activeStartedAt)
        : 0;
    return props.durationMs + activeDuration;
  };
  const indicatorKind = () =>
    getSessionStatusIndicatorKind({
      isFailed: props.isFailed,
      hasPendingInput: hasPendingInput(),
      isRunning: props.isRunning,
      isPlanReady: props.isCompletedPlanSession,
      isCompleted: hasUnreadCompletion(),
    });
  const indicatorTitle = (kind: SessionStatusIndicatorKind) => {
    if (kind === 'attention') {
      if (props.hasPermissionRequest && props.hasQuestionRequest) return 'Attention needed';
      if (props.hasPermissionRequest) return 'Permission request pending';
    }
    return getSessionStatusIndicatorTitle(kind, { retrying: status()?.type === 'retry' });
  };
  const beginRename = () => {
    props.actions.beginRename(props.session.title);
    queueMicrotask(() => {
      renameInputRef?.focus();
      renameInputRef?.select();
    });
  };
  const submitRename = async () => {
    if (props.actions.renamePending()) return;
    const title = props.actions.renameValue().trim();
    if (!title) return;
    const sessionId = props.session.id;
    props.actions.setRenamePending(true);
    const renamed = await renameSession(sessionId, title);
    if (props.actions.sessionId() !== sessionId) return;
    props.actions.setRenamePending(false);
    if (renamed) props.actions.close();
  };
  const copySessionId = async () => {
    props.actions.close();
    if (!(await writeClipboard(props.session.id))) setError('Failed to copy session ID');
  };

  const openActions = (event: MouseEvent) => {
    props.actions.open(props.session.id, event);
    queueMicrotask(() =>
      actionsMenuRef?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    );
  };
  const openSession = () => {
    if (isActive()) return;
    selectSession(props.session.id);
    if (!props.embedded) setShowSessionPicker(false);
  };
  const handleRowClick = (event: MouseEvent) => {
    if (openedPointerId !== null) {
      openedPointerId = null;
      if (pointerClickTimer !== undefined) clearTimeout(pointerClickTimer);
      pointerClickTimer = undefined;
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    const interactive = target.closest('button, a, input, textarea, select');
    if (interactive && !interactive.classList.contains('session-item-main')) return;
    openSession();
  };
  const handleRowPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || props.actions.sessionId()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const interactive = target.closest('button, a, input, textarea, select');
    if (interactive && !interactive.classList.contains('session-item-main')) return;
    const row = event.currentTarget;
    if (row instanceof HTMLElement) row.setPointerCapture?.(event.pointerId);
    if (event.pointerType === 'mouse') {
      event.preventDefault();
      openedPointerId = event.pointerId;
      openSession();
    }
  };
  const handleRowPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== openedPointerId) return;
    if (pointerClickTimer !== undefined) clearTimeout(pointerClickTimer);
    pointerClickTimer = setTimeout(() => {
      openedPointerId = null;
      pointerClickTimer = undefined;
    }, 0);
  };
  const handleRowPointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== openedPointerId) return;
    openedPointerId = null;
    if (pointerClickTimer !== undefined) clearTimeout(pointerClickTimer);
    pointerClickTimer = undefined;
  };

  onCleanup(() => {
    if (pointerClickTimer !== undefined) clearTimeout(pointerClickTimer);
  });

  createEffect(() => {
    if (!showActions()) return;
    props.actions.position();
    props.actions.renaming();
    queueMicrotask(() => {
      if (actionsMenuRef) clampPopupToViewport(actionsMenuRef);
    });
  });

  createEffect(() => {
    if (!showActions()) return;
    let dismissOnSessionClick = false;
    const closeIfOutside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && actionsMenuRef?.contains(target)) return;
      if (
        event.type === 'pointerdown' &&
        event instanceof PointerEvent &&
        event.button === 0 &&
        target instanceof Element &&
        target.closest('.session-item')
      ) {
        dismissOnSessionClick = true;
        return;
      }
      if (
        event.type === 'focusin' &&
        dismissOnSessionClick &&
        target instanceof Element &&
        target.closest('.session-item')
      ) {
        return;
      }
      dismissOnSessionClick = false;
      props.actions.close();
    };
    const dismissSessionClick = (event: MouseEvent) => {
      if (!dismissOnSessionClick) return;
      dismissOnSessionClick = false;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('.session-item')) return;
      event.preventDefault();
      event.stopPropagation();
      props.actions.close();
    };
    window.addEventListener('contextmenu', closeIfOutside, true);
    window.addEventListener('pointerdown', closeIfOutside, true);
    window.addEventListener('focusin', closeIfOutside);
    window.addEventListener('click', dismissSessionClick, true);
    onCleanup(() => {
      window.removeEventListener('contextmenu', closeIfOutside, true);
      window.removeEventListener('pointerdown', closeIfOutside, true);
      window.removeEventListener('focusin', closeIfOutside);
      window.removeEventListener('click', dismissSessionClick, true);
    });
  });

  return (
    <div
      class={`session-item ${isActive() ? 'active' : ''} ${props.isPinned ? 'is-pinned' : ''} ${showActions() ? 'is-context-selected' : ''} ${props.actions.sessionId() && !showActions() ? 'is-context-obscured' : ''} ${isFocused() ? 'keyboard-focus' : ''}`}
      inert={props.actions.sessionId() ? true : undefined}
      onMouseMove={() => {
        if (!props.actions.sessionId()) props.setFocusedIndex(props.itemIndex());
      }}
      onPointerDown={handleRowPointerDown}
      onPointerUp={handleRowPointerUp}
      onPointerCancel={handleRowPointerCancel}
      onContextMenu={openActions}
      onClick={handleRowClick}
    >
      <button
        ref={(element) => {
          sessionButtonRef = element;
        }}
        type="button"
        class="session-item-main"
        aria-current={isActive() ? 'page' : undefined}
        onFocus={() => {
          if (!props.actions.sessionId()) props.setFocusedIndex(props.itemIndex());
        }}
      >
        <Show when={indicatorKind()} fallback={<span class="session-item-indicator-spacer" />}>
          {(kind) => (
            <span
              class={`session-item-indicator session-status-indicator ${getSessionStatusIndicatorClass(kind())}`}
              title={indicatorTitle(kind())}
              aria-label={indicatorTitle(kind())}
            />
          )}
        </Show>
        <div class="session-item-content">
          <span class="session-item-title">
            <span class="session-item-title-text">
              {normalizeSessionTitle(props.session.title) || 'Untitled'}
            </span>
            <Show when={props.isPinned}>
              <span
                class="session-item-pinned-marker"
                title="Pinned session"
                aria-label="Pinned session"
              >
                <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
                  <path d="M27.79 26.386l-6.458-8.303L25.414 14h-4L14 6.586v-4L2.586 14h4L14 21.414v4l4.083-4.083 8.303 6.458 1.404-1.403zM7.414 12L12 7.414 20.586 16 16 20.586 7.414 12zm12.094 7.906.398-.398 1.393 1.791-1.791-1.393z" />
                </svg>
              </span>
            </Show>
          </span>
          <span class="session-item-meta">
            <Show
              when={ralphSummary()}
              fallback={
                <Show
                  when={!props.isSummaryLoading}
                  fallback={
                    <span
                      class="session-item-meta-skeleton"
                      role="status"
                      aria-label="Loading session statistics"
                    />
                  }
                >
                  <Show when={summaryStats()}>
                    {(summary) => (
                      <>
                        {summary().files} file
                        {summary().files !== 1 ? 's' : ''}
                        {' · '}
                        <span class="diff-lines-added">
                          +{formatEditCount(summary().additions)}
                        </span>{' '}
                        <span class="diff-lines-removed">
                          -{formatEditCount(summary().deletions)}
                        </span>
                      </>
                    )}
                  </Show>
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
            <Show when={props.tokens !== null}>
              {' · '}
              <span title={`${props.tokens!.toLocaleString('en-US')} tokens spent`}>
                {formatSessionTokens(props.tokens!)} tokens
              </span>
            </Show>
            <Show when={workedDurationMs()}>
              {(durationMs) => (
                <>
                  {' · '}
                  <span title={`${formatDuration(durationMs())} total time worked`}>
                    {formatDuration(durationMs())}
                  </span>
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
            class="session-item-subagents session-item-subagents-counter"
            onClick={() => props.onOpenSubagents?.(props.session.id)}
            title={subagentLabel()}
            aria-label={subagentLabel()}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M5.5 2.5a2 2 0 110 4 2 2 0 010-4zm5 1a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM2 9.25c0-1.8 2.1-2.75 3.5-2.75S9 7.45 9 9.25V10H2v-.75zm7.5.75v-.5c0-.66-.2-1.23-.54-1.7.5-.19 1.04-.3 1.54-.3 1.22 0 3 .73 3 2.25V10h-4z" />
            </svg>
            <span class="session-item-subagents-count">{props.subagentCount}</span>
          </button>
        </Show>
        <span
          class="session-item-age"
          title={new Date(props.session.time.updated).toLocaleString()}
        >
          {formatRelativeAge(props.session.time.updated, props.now())}
        </span>
      </div>
      <Show when={showActions()}>
        <Portal>
          <div
            ref={(element) => {
              actionsMenuRef = element;
            }}
            class="session-item-actions-menu"
            role="menu"
            aria-label="Session actions"
            style={{
              left: `${props.actions.position().x}px`,
              top: `${props.actions.position().y}px`,
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              props.actions.close();
              sessionButtonRef?.focus();
            }}
          >
            <Show
              when={props.actions.renaming()}
              fallback={
                <>
                  <button type="button" role="menuitem" onClick={beginRename}>
                    Rename
                  </button>
                  <Show when={!props.session.parentID}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        props.actions.close();
                        void props.onTogglePinned();
                      }}
                    >
                      {props.isPinned ? 'Unpin' : 'Pin'}
                    </button>
                  </Show>
                  <button type="button" role="menuitem" onClick={() => void copySessionId()}>
                    Copy session ID
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    class="is-destructive"
                    onClick={() => {
                      props.actions.close();
                      void deleteSession(props.session.id);
                    }}
                  >
                    Move to Recycle Bin
                  </button>
                </>
              }
            >
              <form
                class="session-item-rename-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitRename();
                }}
              >
                <label for={`session-rename-${props.session.id}`}>Session name</label>
                <input
                  ref={(element) => {
                    renameInputRef = element;
                    const selection = untrack(props.actions.renameSelection);
                    if (!selection) return;
                    queueMicrotask(() => {
                      element.focus();
                      element.setSelectionRange(selection.start, selection.end);
                    });
                  }}
                  id={`session-rename-${props.session.id}`}
                  value={props.actions.renameValue()}
                  onInput={(event) => {
                    props.actions.setRenameValue(event.currentTarget.value);
                    props.actions.setRenameSelection({
                      start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                      end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                    });
                  }}
                  onSelect={(event) =>
                    props.actions.setRenameSelection({
                      start: event.currentTarget.selectionStart ?? 0,
                      end: event.currentTarget.selectionEnd ?? 0,
                    })
                  }
                  onMouseUp={(event) =>
                    props.actions.setRenameSelection({
                      start: event.currentTarget.selectionStart ?? 0,
                      end: event.currentTarget.selectionEnd ?? 0,
                    })
                  }
                  onKeyUp={(event) =>
                    props.actions.setRenameSelection({
                      start: event.currentTarget.selectionStart ?? 0,
                      end: event.currentTarget.selectionEnd ?? 0,
                    })
                  }
                  disabled={props.actions.renamePending()}
                />
                <div class="session-item-rename-actions">
                  <button type="button" onClick={props.actions.close}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!props.actions.renameValue().trim() || props.actions.renamePending()}
                  >
                    Save
                  </button>
                </div>
              </form>
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  );
}

function formatSessionTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function formatDurationFromNow(timestamp: number, now: number): string {
  return formatRelativeAge(now + Math.max(0, timestamp - now), now);
}

function rootSessionId(sessionId: string) {
  return getSessionTreeRootId(sessionId) || sessionId;
}

export function deriveSessionIndicators(sessions: typeof state.sessions): SessionIndicatorSets {
  const subagentCounts = new Map<string, number>();
  const failedSessionIds = new Set(state.failedSessionIds);
  const ralphChildToManager = new Map<string, string>();
  const ralphManagerManualStopIds = new Set<string>();
  const childSessionIdsByParent = new Map<string, string[]>();
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
  const descendantSubagentCountBySession = new Map<string, number>();
  const isManuallyStoppedRalphManager = (sessionId: string) =>
    ralphManagerManualStopIds.has(sessionId);
  const isAwaitingInput = (sessionId: string) =>
    permissionIds.has(rootSessionId(sessionId)) || questionIds.has(rootSessionId(sessionId));
  const isFailed = (sessionId: string) => {
    if (isManuallyStoppedRalphManager(sessionId)) return false;
    if (hasActiveUsageLimit(sessionId)) return true;
    return state.sessionStatus[sessionId]?.type !== 'busy' && failedSessionIds.has(sessionId);
  };
  const isRunning = (sessionId: string) => {
    if (hasActiveUsageLimit(sessionId)) return false;
    if (isAwaitingInput(sessionId)) return false;
    const ralphRun = ralphStore.getRun(rootSessionId(sessionId));
    if (ralphRun && ralphRun.status !== 'running') return false;
    const type = state.sessionStatus[sessionId]?.type;
    return type === 'busy' || type === 'retry';
  };

  for (const run of ralphStore.getAllRuns()) {
    if (run.stopReason === 'manual_stop') {
      ralphManagerManualStopIds.add(run.config.managerSessionId);
    }
    for (const iteration of run.iterations) {
      if (iteration.childSessionId) {
        ralphChildToManager.set(iteration.childSessionId, run.config.managerSessionId);
      }
      for (const repairSessionId of iteration.repairSessionIds || []) {
        ralphChildToManager.set(repairSessionId, run.config.managerSessionId);
      }
    }
  }

  for (const session of sessions) {
    if (session.parentID) {
      const existingChildren = childSessionIdsByParent.get(session.parentID);
      if (existingChildren) existingChildren.push(session.id);
      else childSessionIdsByParent.set(session.parentID, [session.id]);
    }

    const sessionId = session.id;
    const displaySessionId = rootSessionId(sessionId);
    const failed = isFailed(sessionId);
    const hasPrompt = permissionIds.has(displaySessionId) || questionIds.has(displaySessionId);
    const needsAttention = !failed && (hasPrompt || isAwaitingInput(sessionId));
    const running = !needsAttention && isRunning(sessionId);

    if (failed) {
      if (!isManuallyStoppedRalphManager(displaySessionId)) {
        failedIds.add(displaySessionId);
      }
      failedIds.add(sessionId);
      const managerSessionId = ralphChildToManager.get(sessionId);
      if (managerSessionId && !ralphManagerManualStopIds.has(managerSessionId)) {
        failedIds.add(managerSessionId);
      }
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
      const managerSessionId = ralphChildToManager.get(sessionId);
      if (managerSessionId && !failedIds.has(managerSessionId)) runningIds.add(managerSessionId);
      continue;
    }
    const selectedAgent = getSelectedAgentForSession(sessionId);
    if (selectedAgent === 'plan') {
      // An empty session cannot contain a plan; the plan agent may have been
      // registered for it merely by selecting the session in the list.
      if (!isEmptySession(session) && !isSkippedPlanSession(sessionId, session.time.updated)) {
        planReadyIds.add(sessionId);
      }
      continue;
    }
    if (!isSessionCompletedResponseUnread(sessionId)) {
      continue;
    }
    newlyCompletedIds.add(sessionId);
  }

  const countDescendants = (sessionId: string): number => {
    const cachedCount = descendantSubagentCountBySession.get(sessionId);
    if (cachedCount !== undefined) return cachedCount;

    let count = 0;
    for (const childId of childSessionIdsByParent.get(sessionId) || []) {
      count += 1 + countDescendants(childId);
    }

    descendantSubagentCountBySession.set(sessionId, count);
    return count;
  };

  for (const session of sessions) {
    const count = countDescendants(session.id);
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
  const ralphRun = ralphStore.getRun(sessionId);
  if (ralphRun?.stopReason === 'manual_stop') return false;
  if (hasActiveUsageLimit(sessionId)) return true;
  return (
    state.sessionStatus[sessionId]?.type !== 'busy' && state.failedSessionIds.includes(sessionId)
  );
}

export function isRunningSession(sessionId: string) {
  if (hasActiveUsageLimit(sessionId)) return false;
  if (isSessionAwaitingInput(sessionId)) return false;
  const ralphRun = ralphStore.getRun(getSessionTreeRootId(sessionId) || sessionId);
  if (ralphRun && ralphRun.status !== 'running') return false;
  const type = state.sessionStatus[sessionId]?.type;
  return type === 'busy' || type === 'retry';
}

export function isPrimarySession(session: (typeof state.sessions)[number]) {
  return !session.parentID;
}
