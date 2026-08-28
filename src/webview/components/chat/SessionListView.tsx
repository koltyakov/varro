import {
  getSelectedAgentForSession,
  getSelectedModelForSession,
  getSessionTreeIds,
  getSessionTreeRootId,
  hasActiveUsageLimit,
  isLoading,
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
  createUniqueId,
  on,
  untrack,
} from 'solid-js';
import {
  selectSession,
  deleteSession,
  restoreSession,
  deleteSessionPermanently,
  emptyRecycleBin,
  loadMoreSessions,
  reloadSessions,
} from '../../hooks/useOpenCode';
import { normalizeSessionTitle } from '../../../shared/session-title';
import { isSameWorkspacePath } from '../../../shared/workspace-path';
import type { RecycleBinEntry, SessionDiffSummary } from '../../../shared/protocol';
import type { SelectedModel } from '../../lib/app-state-types';
import type { Session } from '../../types';
import { client } from '../../lib/client';
import { postMessage } from '../../lib/bridge';
import { ralphStore } from '../../lib/stores/ralph-store';
import { isEmptySession, shouldHideEmptySessionFromList } from '../../lib/empty-session';
import { formatEditCount, formatModelName, formatVariantLabel } from '../../lib/format';
import { formatDuration, formatRelativeAge } from '../../lib/message-metrics';
import { getProviderIcon } from '../../lib/provider-icons';
import { compareSessionsByActivity } from '../../lib/session-order';
import {
  archiveIcon,
  forwardMessageIcon,
  navArrowRightIcon,
  cableTagIcon,
  pinIcon,
  trashIcon,
  xmarkIcon,
} from '../../lib/ui-icons';
import {
  SessionActionsMenu,
  createSessionActionsState,
  type SessionActionsState,
} from './SessionActionsMenu';
import { SharedSessionIcon } from './SharedSessionIcon';
import { isNumber, isString, type UnknownRecord, isObject } from '../../lib/runtime-values';
import { UiIcon } from '../UiIcon';
import { FolderIcon } from '../FolderIcon';
import { getWorkspaceCompactLabel, WorkspacePicker } from '../chat-input/ToolbarPickers';

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

export type SessionIndicatorSets = {
  subagentCounts: Map<string, number>;
  permissionIds: Set<string>;
  questionIds: Set<string>;
  runningIds: Set<string>;
  failedIds: Set<string>;
  attentionIds: Set<string>;
  planReadyIds: Set<string>;
  newlyCompletedIds: Set<string>;
};

export const SESSION_STATUS_INDICATOR_SETTLE_DELAY_MS = 1200;

export function createStableSessionIndicators(
  getIndicators: () => SessionIndicatorSets,
  settleDelayMs = SESSION_STATUS_INDICATOR_SETTLE_DELAY_MS
) {
  const [lingeringRunningIds, setLingeringRunningIds] = createSignal(new Set<string>());
  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  createEffect(() => {
    const runningIds = getIndicators().runningIds;
    const lingeringIds = untrack(lingeringRunningIds);
    const nextLingeringIds = new Set(lingeringIds);
    let changed = false;

    for (const sessionId of runningIds) {
      const timer = settleTimers.get(sessionId);
      if (timer !== undefined) {
        clearTimeout(timer);
        settleTimers.delete(sessionId);
      }
      if (!nextLingeringIds.has(sessionId)) {
        nextLingeringIds.add(sessionId);
        changed = true;
      }
    }

    for (const sessionId of nextLingeringIds) {
      if (runningIds.has(sessionId) || settleTimers.has(sessionId)) continue;
      const timer = setTimeout(() => {
        settleTimers.delete(sessionId);
        if (getIndicators().runningIds.has(sessionId)) return;
        setLingeringRunningIds((current) => {
          if (!current.has(sessionId)) return current;
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
      }, settleDelayMs);
      settleTimers.set(sessionId, timer);
    }

    if (changed) setLingeringRunningIds(nextLingeringIds);
  });

  onCleanup(() => {
    for (const timer of settleTimers.values()) clearTimeout(timer);
    settleTimers.clear();
  });

  return createMemo(() => {
    const indicators = getIndicators();
    const stableRunningIds = new Set([...indicators.runningIds, ...lingeringRunningIds()]);
    if (stableRunningIds.size === indicators.runningIds.size) return indicators;

    const failedIds = new Set(indicators.failedIds);
    const attentionIds = new Set(indicators.attentionIds);
    const planReadyIds = new Set(indicators.planReadyIds);
    const newlyCompletedIds = new Set(indicators.newlyCompletedIds);
    for (const sessionId of stableRunningIds) {
      failedIds.delete(sessionId);
      attentionIds.delete(sessionId);
      planReadyIds.delete(sessionId);
      newlyCompletedIds.delete(sessionId);
    }
    return {
      ...indicators,
      runningIds: stableRunningIds,
      failedIds,
      attentionIds,
      planReadyIds,
      newlyCompletedIds,
    };
  });
}

type SessionSummaryStats = {
  files: number;
  filesTruncated?: boolean;
  additions: number;
  deletions: number;
};

function getSessionDisplayModel(
  session: Session,
  diffSummary: SessionDiffSummary | null
): SelectedModel | null {
  const summaryModel = diffSummary?.model;
  if (summaryModel) {
    return {
      providerID: summaryModel.providerID,
      modelID: summaryModel.modelID,
      variant: summaryModel.variant,
    };
  }
  if (session.model) {
    return {
      providerID: session.model.providerID,
      modelID: session.model.id,
      variant: session.model.variant,
    };
  }
  const selectedModel = getSelectedModelForSession(session.id);
  return selectedModel
    ? {
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
        variant: selectedModel.variant,
      }
    : null;
}

function openSessionWithDisplayedModel(session: Session, diffSummary: SessionDiffSummary | null) {
  const selectedModel = getSessionDisplayModel(session, diffSummary);
  if (selectedModel) {
    void selectSession(session.id, { selectedModel, directory: session.directory });
  } else {
    void selectSession(session.id, { directory: session.directory });
  }
}

type SessionDiffSummaryCacheEntry = {
  status: 'loading' | 'ready' | 'error';
  updated: number;
  stats: SessionDiffSummary | null;
};

type SessionDiffSummaryRequest = {
  sessionId: string;
  directory?: string;
  updated: number;
};

export type SessionStatusIndicatorKind =
  | 'failed'
  | 'attention'
  | 'running'
  | 'plan-ready'
  | 'completed';

const SESSION_SHOW_MORE_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ARCHIVE_PRELOAD_TARGET = 50;
const SUBAGENT_SESSION_PAGE_SIZE = 100;
const MAX_SUBAGENT_SESSION_LIMIT = 1_000_000;
const SESSION_SEARCH_LIMIT = 30;
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

function getSessionTreeFailedUpdated(sessionId: string): number | undefined {
  let updated: number | undefined;
  for (const treeSessionId of getSessionTreeIds(sessionId)) {
    const failedAt = state.failedSessionUpdatedAt[treeSessionId];
    if (failedAt !== undefined) updated = Math.max(updated ?? 0, failedAt);
  }
  return updated;
}

export function isSessionFailureUnread(sessionId: string): boolean {
  return isSessionUnread(
    sessionId,
    getSessionTreeFailedUpdated(sessionId) ?? getSessionTreeUpdated(sessionId)
  );
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

function enqueueDiffSummaryRequest(session: Session, updated = getSessionTreeUpdated(session.id)) {
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
  diffSummaryQueue.push({ sessionId: session.id, directory: session.directory, updated });
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
      .diffSummary(request.sessionId, request.updated, { directory: request.directory })
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
        return isRunning(session.id) || isNeedingAttention(session.id);
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
    filesTruncated: summary.diffsTruncated ? true : undefined,
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
    if (!diff || !isObject(diff)) continue;
    // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
    const file = (diff as UnknownRecord).file;
    if (isString(file) && file) files.add(file);
    additions += readDiffCount(diff, 'additions', 'added');
    deletions += readDiffCount(diff, 'deletions', 'removed');
  }

  return {
    files: files.size || diffs.length,
    additions,
    deletions,
  } satisfies SessionSummaryStats;
}

function hasSessionSummaryEdits(stats: SessionSummaryStats) {
  return (
    stats.filesTruncated === true || stats.files > 0 || stats.additions > 0 || stats.deletions > 0
  );
}

function readDiffCount<T>(
  diff: T,
  primaryKey: 'additions' | 'deletions',
  fallbackKey: 'added' | 'removed'
): number {
  if (!diff || !isObject(diff)) return 0;
  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const record = diff as UnknownRecord;
  const primary = record[primaryKey];
  if (isNumber(primary)) return primary;
  const fallback = record[fallbackKey];
  return isNumber(fallback) ? fallback : 0;
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

export function getRecentSessions(groups: SessionGroups): typeof state.sessions {
  return [
    ...groups.pinned,
    ...groups.failed,
    ...groups.planReady,
    ...groups.attention,
    ...groups.running,
    ...groups.newlyCompleted,
    ...groups.surfacedOther,
  ];
}

export function getRecycleBinSessionIds(entries: readonly RecycleBinEntry[]) {
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(entry.rootID);
    if (entry.root?.id) ids.add(entry.root.id);
    for (const session of entry.sessions ?? []) ids.add(session.id);
  }
  return ids;
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
  incomplete?: boolean;
  expanded: boolean;
  onToggle: () => void;
  onArchive?: () => void;
  archiveLabel?: string;
}) {
  const [isConfirmingArchive, setIsConfirmingArchive] = createSignal(false);
  const archiveActionLabel = () => props.archiveLabel || 'Archive';
  const archiveTargetLabel = () =>
    archiveActionLabel().toLowerCase() === props.title.toLowerCase() ? 'sessions' : props.title;

  const confirmArchive = () => {
    setIsConfirmingArchive(false);
    props.onArchive?.();
  };

  return (
    <div ref={(el) => props.ref?.(el)} class="session-list-section-header">
      <button type="button" class="session-list-section-toggle" onClick={props.onToggle}>
        <span class="session-list-section-title">{props.title}</span>
        <Show when={props.count > 0 || !props.incomplete}>
          <span class="session-list-section-count">
            {props.count}
            {props.incomplete ? '+' : ''}
          </span>
        </Show>
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
                <UiIcon
                  source={archiveIcon}
                  class="session-list-section-archive-icon"
                  width={14}
                  height={14}
                />
              </button>
            }
          >
            <>
              <button
                type="button"
                class="session-list-section-confirm"
                onClick={confirmArchive}
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
          <UiIcon
            source={navArrowRightIcon}
            class={`session-list-section-chevron ${props.expanded ? 'expanded' : ''}`}
            width={12}
            height={12}
          />
        </button>
      </div>
    </div>
  );
}

function SessionListContinuation() {
  let sentinelRef: HTMLDivElement | undefined;
  let observer: IntersectionObserver | undefined;
  let requestInFlight = false;

  const loadNextPage = async () => {
    if (requestInFlight || state.sessionsLoadingMore || !state.sessionsHasMore) return;
    requestInFlight = true;
    try {
      await loadMoreSessions();
    } finally {
      requestInFlight = false;
      if (sentinelRef && observer && state.sessionsHasMore && !state.sessionsPaginationError) {
        observer.unobserve(sentinelRef);
        observer.observe(sentinelRef);
      }
    }
  };

  const disconnectObserver = () => {
    observer?.disconnect();
    observer = undefined;
    sentinelRef = undefined;
  };

  const observeSentinel = (element: HTMLDivElement) => {
    disconnectObserver();
    sentinelRef = element;
    if (globalThis.IntersectionObserver === undefined) return;
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadNextPage();
      },
      {
        root: sentinelRef.closest('.session-list-scroll'),
        rootMargin: '120px 0px',
      }
    );
    observer.observe(element);
  };

  createEffect(() => {
    if (state.sessionsHasMore || state.sessionsPaginationError) return;
    disconnectObserver();
  });
  onCleanup(disconnectObserver);

  return (
    <Show when={state.sessionsHasMore || state.sessionsPaginationError}>
      <div
        ref={observeSentinel}
        class={`session-list-continuation ${state.sessionsLoadingMore || state.sessionsPaginationError ? 'visible' : ''}`}
      >
        <Show when={state.sessionsLoadingMore}>
          <span class="session-list-continuation-status" role="status">
            Loading…
          </span>
        </Show>
        <Show when={state.sessionsPaginationError}>
          {(message) => (
            <div class="session-list-continuation-error" role="alert">
              <span>{message()}</span>
              <button type="button" onClick={() => void loadNextPage()}>
                Retry
              </button>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}

function SessionListWorkspaceSelector(props: {
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}) {
  const [showPicker, setShowPicker] = createSignal(false);
  let buttonRef: HTMLButtonElement | undefined;
  let popoverRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (!showPicker()) return;
    const closeIfOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef?.contains(target) || popoverRef?.contains(target)) return;
      setShowPicker(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowPicker(false);
      buttonRef?.focus();
    };
    window.addEventListener('pointerdown', closeIfOutside, true);
    window.addEventListener('keydown', closeOnEscape, true);
    onCleanup(() => {
      window.removeEventListener('pointerdown', closeIfOutside, true);
      window.removeEventListener('keydown', closeOnEscape, true);
    });
  });

  return (
    <Show when={(state.editorContext.workspaceFolders?.length ?? 0) > 1}>
      <div class="session-list-workspace-selector">
        <span class="session-list-workspace-label">Folder:</span>
        <div class="session-list-workspace-picker">
          <WorkspacePicker
            buttonRef={(element) => {
              buttonRef = element;
            }}
            popoverRef={(element) => {
              popoverRef = element;
            }}
            folders={state.editorContext.workspaceFolders ?? []}
            selectedPath={props.selectedPath}
            showIcon={false}
            allLabel="All folders"
            popoverTitle="Session folder"
            showPicker={showPicker()}
            onToggle={() => setShowPicker((open) => !open)}
            onSelect={(path) => {
              setShowPicker(false);
              props.onSelect(path);
            }}
            onSelectAll={() => {
              setShowPicker(false);
              props.onSelect(null);
            }}
          />
        </div>
      </div>
    </Show>
  );
}

export function SessionListView(props: {
  sessionFilter?: SessionListFilter | null;
  subagentParentId?: string | null;
  onOpenSubagents?: (parentSessionId: string) => void;
  onActiveSessionReselect?: () => void;
  embedded?: boolean;
  class?: string;
}) {
  const diffSummaryOwner = Symbol('session-list');
  const initialNow = Date.now();
  const [activeNow, setActiveNow] = createSignal(initialNow);
  const [ageNow, setAgeNow] = createSignal(initialNow);
  const clock = setInterval(() => {
    const nextNow = Date.now();
    setActiveNow(nextNow);
    setAgeNow((current) =>
      Math.floor(current / 60_000) === Math.floor(nextNow / 60_000) ? current : nextNow
    );
  }, 1_000);
  onCleanup(() => clearInterval(clock));

  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  const [activeGroupedSection, setActiveGroupedSection] =
    createSignal<SessionListGroupedSection | null>(null);
  const [searchQuery, setSearchQuery] = createSignal('');
  const [folderFilter, setFolderFilter] = createSignal<string | null>(null);
  const [allSessionsForSubagent, setAllSessionsForSubagent] = createSignal<Session[] | null>(null);
  const [isResolvingSubagents, setIsResolvingSubagents] = createSignal(false);
  const [nativeSearchResults, setNativeSearchResults] = createSignal<Session[] | null>(null);
  const [isSearchingAllSessions, setIsSearchingAllSessions] = createSignal(false);
  const [showAllModelDetails, setShowAllModelDetails] = createSignal(false);
  const [frozenSessionOrder, setFrozenSessionOrder] = createSignal<string[] | null>(null);
  let containerRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  let hasPointerInteraction = false;

  const handleAltDown = (event: KeyboardEvent) => {
    if (event.key === 'Alt') setShowAllModelDetails(true);
  };
  const hideAllModelDetails = () => setShowAllModelDetails(false);
  const handleAltUp = (event: KeyboardEvent) => {
    if (event.key === 'Alt') hideAllModelDetails();
  };
  window.addEventListener('keydown', handleAltDown);
  window.addEventListener('keyup', handleAltUp);
  window.addEventListener('blur', hideAllModelDetails);
  onCleanup(() => {
    window.removeEventListener('keydown', handleAltDown);
    window.removeEventListener('keyup', handleAltUp);
    window.removeEventListener('blur', hideAllModelDetails);
  });

  const sessionActions = createSessionActionsState({
    onOpen: () => {
      setFocusedIndex(-1);
      setFrozenSessionOrder(visibleSessions().map((session) => session.id));
    },
    onClose: () => {
      setFrozenSessionOrder(null);
    },
  });

  const trimmedSearchQuery = createMemo(() => searchQuery().trim());
  const shouldShowSearch = createMemo(() => !props.subagentParentId && !props.sessionFilter);

  let resolutionRequestKey = 0;
  let resolutionRequestActive = false;
  createEffect(() => {
    const resolutionActive = Boolean(props.subagentParentId);
    if (!resolutionActive) {
      resolutionRequestActive = false;
      resolutionRequestKey += 1;
      setAllSessionsForSubagent(null);
      setIsResolvingSubagents(false);
      return;
    }
    if (resolutionRequestActive) return;

    resolutionRequestActive = true;
    const requestKey = ++resolutionRequestKey;
    setIsResolvingSubagents(true);
    void (async () => {
      let limit = SUBAGENT_SESSION_PAGE_SIZE;
      while (true) {
        if (requestKey !== resolutionRequestKey) return;
        const page = await client.session.list({ limit });
        if (requestKey !== resolutionRequestKey) return;
        if (Array.isArray(page)) throw new Error('Expected a paginated session list');
        setAllSessionsForSubagent(page.items);
        if (!page.hasMore) return;

        const nextLimit = Math.min(limit + SUBAGENT_SESSION_PAGE_SIZE, MAX_SUBAGENT_SESSION_LIMIT);
        if (nextLimit === limit) throw new Error('Session lookup exceeded the supported limit');
        limit = nextLimit;
      }
    })()
      .catch((error) => {
        if (requestKey !== resolutionRequestKey) return;
        setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (requestKey === resolutionRequestKey) setIsResolvingSubagents(false);
      });
  });

  let searchRequestKey = 0;
  let searchAbortController: AbortController | undefined;
  createEffect(() => {
    const query = trimmedSearchQuery();
    const searchActive = shouldShowSearch() && query.length > 0;
    searchAbortController?.abort();
    searchAbortController = undefined;
    searchRequestKey += 1;
    setNativeSearchResults(null);
    if (!searchActive) {
      setIsSearchingAllSessions(false);
      return;
    }

    const requestKey = searchRequestKey;
    const controller = new AbortController();
    searchAbortController = controller;
    setIsSearchingAllSessions(true);
    void client.session
      .list({
        limit: SESSION_SEARCH_LIMIT,
        search: query,
        roots: true,
        directory: folderFilter() ?? undefined,
        signal: controller.signal,
      })
      .then((page) => {
        if (requestKey !== searchRequestKey || controller.signal.aborted) return;
        if (Array.isArray(page)) throw new Error('Expected a paginated session search');
        setNativeSearchResults(page.items);
      })
      .catch((error) => {
        if (requestKey !== searchRequestKey || controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (requestKey === searchRequestKey) setIsSearchingAllSessions(false);
      });
  });
  onCleanup(() => {
    resolutionRequestKey += 1;
    searchRequestKey += 1;
    searchAbortController?.abort();
  });

  const rawSessionIndicators = createMemo(() => deriveSessionIndicators(state.sessions));
  const sessionIndicators = createStableSessionIndicators(rawSessionIndicators);
  const queuedMessageCounts = createMemo(() => {
    const counts = new Map<string, number>();
    for (const item of state.queuedMessages) {
      counts.set(item.sessionId, (counts.get(item.sessionId) ?? 0) + 1);
    }
    return counts;
  });
  const matchesFolderFilter = (directory: string | null | undefined) => {
    const selected = folderFilter();
    return !selected || isSameWorkspacePath(directory, selected);
  };
  const recycleBinEntries = createMemo(() =>
    (state.recycleBinEntries || []).filter((entry) => matchesFolderFilter(entry.root?.directory))
  );
  const recycleBinSessionIds = createMemo(() => getRecycleBinSessionIds(recycleBinEntries()));
  const isVisibleSession = (session: Session) => {
    if (recycleBinSessionIds().has(session.id)) return false;
    return !shouldHideEmptySessionFromList(session, {
      isQueued: (sessionId) => queuedMessageCounts().has(sessionId),
      isAwaitingInput: isSessionAwaitingInput,
      isRunning: (sessionId) => sessionIndicators().runningIds.has(sessionId),
      needsAttention: (sessionId) => sessionIndicators().attentionIds.has(sessionId),
      isFailed: (sessionId) => sessionIndicators().failedIds.has(sessionId),
      isPlanReady: (item) => sessionIndicators().planReadyIds.has(item.id),
      preserve: ralphStore.isRalphSession(session.id),
      statusType: state.sessionStatus[session.id]?.type,
    });
  };
  const visibleSessionsForList = createMemo(() =>
    state.sessions.filter(
      (session) => isVisibleSession(session) && matchesFolderFilter(session.directory)
    )
  );
  const groupedSessions = createMemo(() =>
    groupSessions(
      visibleSessionsForList(),
      (sessionId) => sessionIndicators().runningIds.has(sessionId),
      (sessionId) => sessionIndicators().attentionIds.has(sessionId),
      (sessionId) => sessionIndicators().failedIds.has(sessionId),
      (session) => sessionIndicators().planReadyIds.has(session.id),
      (session) => sessionIndicators().newlyCompletedIds.has(session.id),
      ageNow(),
      (sessionId) => state.pinnedSessionIds.includes(sessionId)
    )
  );
  const overflowOtherSessions = () => groupedSessions().overflowOther;
  const recentSessions = createMemo(() => getRecentSessions(groupedSessions()));
  const resolvedSubagentSessions = createMemo(() => {
    const resolvedSessions = allSessionsForSubagent();
    if (!resolvedSessions) return visibleSessionsForList();

    const mergedSessions = new Map(resolvedSessions.map((session) => [session.id, session]));
    for (const session of state.sessions) mergedSessions.set(session.id, session);
    return [...mergedSessions.values()].filter(
      (session) => isVisibleSession(session) && matchesFolderFilter(session.directory)
    );
  });
  const subagentSessions = createMemo(() =>
    getSubagentSessionsForParent(resolvedSubagentSessions(), props.subagentParentId ?? null)
  );
  const searchResultSessions = createMemo(() => {
    const results = nativeSearchResults();
    if (!results) return [];
    const loadedSessions = new Map(state.sessions.map((session) => [session.id, session]));
    return results
      .map((session) => loadedSessions.get(session.id) ?? session)
      .filter((session) => isVisibleSession(session) && matchesFolderFilter(session.directory));
  });
  const filteredSessions = createMemo(() =>
    props.sessionFilter
      ? getPrimarySessionsForFilter(
          recentSessions(),
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
    sortSessionsForDisplay(recentSessions(), ageNow())
  );
  const surfacedSessions = createMemo(() => {
    const sessions = defaultSurfacedSessions();
    return sessions.length > 0 ? sessions : overflowOtherSessions();
  });
  const availableGroupedSections = createMemo(() => {
    const sections: SessionListGroupedSection[] = [];
    if (defaultSurfacedSessions().length > 0) sections.push('recent');
    if (overflowOtherSessions().length > 0 || state.sessionsHasMore) {
      sections.push('archive');
    }
    if (recycleBinEntries().length > 0) sections.push('recycle-bin');
    return sections;
  });
  const expandedGroupedSection = createMemo<SessionListGroupedSection | null>(() => {
    const sections = availableGroupedSections();
    const active = activeGroupedSection();
    if (active && sections.includes(active)) return active;
    return sections.includes('recent') ? 'recent' : (sections[0] ?? null);
  });
  const isDefaultGroupedView = createMemo(
    () => !props.sessionFilter && !props.subagentParentId && !trimmedSearchQuery()
  );
  createEffect(() => {
    if (
      !isDefaultGroupedView() ||
      overflowOtherSessions().length >= SESSION_ARCHIVE_PRELOAD_TARGET ||
      !state.sessionsHasMore ||
      state.sessionsLoadingMore ||
      state.sessionsPaginationError
    ) {
      return;
    }
    void loadMoreSessions();
  });
  const directSessions = createMemo(() => {
    if (props.subagentParentId) return subagentSessions();
    if (props.sessionFilter) return filteredSessions();
    return [];
  });
  const baseVisibleSessions = createMemo(() => {
    if (props.subagentParentId || props.sessionFilter) return directSessions();

    switch (expandedGroupedSection()) {
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
    if (shouldShowSearch() && trimmedSearchQuery()) return searchResultSessions();
    return baseVisibleSessions();
  });

  createEffect(() => {
    const sessions = visibleSessions();
    updateRelevantDiffSummarySessions(
      diffSummaryOwner,
      new Set(sessions.map((session) => session.id))
    );
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

  createEffect(
    on(folderFilter, () => {
      setActiveGroupedSection(null);
      setFocusedIndex(-1);
    })
  );

  createEffect(() => {
    const selected = folderFilter();
    if (
      selected &&
      !(state.editorContext.workspaceFolders ?? []).some((folder) =>
        isSameWorkspacePath(folder.path, selected)
      )
    ) {
      setFolderFilter(null);
    }
  });

  createEffect(() => {
    const activeSection = activeGroupedSection();
    if (!activeSection) return;
    if (!availableGroupedSections().includes(activeSection)) setActiveGroupedSection(null);
  });

  createEffect(() => {
    const sessionId = sessionActions.sessionId();
    if (sessionId && !state.sessions.some((session) => session.id === sessionId)) {
      sessionActions.close();
    }
  });

  createEffect(() => {
    const sessions = visibleSessions();
    setFocusedIndex((current) => {
      if (sessions.length === 0) return -1;
      if (current < 0) return current;
      return Math.min(current, sessions.length - 1);
    });
  });

  const toggleGroupedSection = (section: SessionListGroupedSection) => {
    if (section === 'recent') {
      setActiveGroupedSection(null);
      return;
    }

    setActiveGroupedSection((current) => (current === section ? null : section));
  };

  const renderSessionItems = (
    sessions: () => typeof state.sessions,
    indexOffset = 0,
    separatePinnedSessions = false
  ) => {
    const orderedSessions = createMemo(() => {
      const items = sessions();
      const frozenOrder = frozenSessionOrder();
      if (!frozenOrder) return items;
      const positions = new Map(frozenOrder.map((sessionId, index) => [sessionId, index]));
      return items.toSorted((a, b) => {
        const aPosition = positions.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bPosition = positions.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return aPosition - bPosition;
      });
    });
    const sessionsById = createMemo(
      () => new Map(orderedSessions().map((session) => [session.id, session]))
    );

    return (
      <For each={orderedSessions().map((session) => session.id)}>
        {(sessionId, index) => {
          const session = () => sessionsById().get(sessionId)!;
          const startsUnpinnedGroup = () => {
            if (!separatePinnedSessions || index() === 0) return false;
            const previousSession = orderedSessions()[index() - 1];
            return (
              !state.pinnedSessionIds.includes(sessionId) &&
              !!previousSession &&
              state.pinnedSessionIds.includes(previousSession.id)
            );
          };
          return (
            <SessionListItem
              session={session()}
              summaryUpdated={getSessionTreeUpdated(sessionId)}
              onRequestSummary={(updated) => enqueueDiffSummaryRequest(session(), updated)}
              diffSummary={sessionDiffSummaryCache()[sessionId]?.stats ?? null}
              isSummaryLoading={
                sessionDiffSummaryCache()[sessionId]?.status === 'loading' &&
                sessionDiffSummaryCache()[sessionId]?.stats === null
              }
              tokens={
                sessionDiffSummaryCache()[sessionId]?.stats?.historyStatsUnavailable
                  ? null
                  : (sessionDiffSummaryCache()[sessionId]?.stats?.tokens ?? null)
              }
              durationMs={
                sessionDiffSummaryCache()[sessionId]?.stats?.historyStatsUnavailable
                  ? null
                  : (sessionDiffSummaryCache()[sessionId]?.stats?.durationMs ?? null)
              }
              activeStartedAt={
                sessionDiffSummaryCache()[sessionId]?.stats?.historyStatsUnavailable
                  ? null
                  : (sessionDiffSummaryCache()[sessionId]?.stats?.activeStartedAt ?? null)
              }
              itemIndex={() => indexOffset + index()}
              focusedIndex={focusedIndex}
              setFocusedIndex={setFocusedIndex}
              actions={sessionActions}
              ageNow={ageNow}
              activeNow={activeNow}
              queuedMessageCount={queuedMessageCounts().get(sessionId) ?? 0}
              subagentCount={sessionIndicators().subagentCounts.get(sessionId) || 0}
              hasPermissionRequest={sessionIndicators().permissionIds.has(sessionId)}
              hasQuestionRequest={sessionIndicators().questionIds.has(sessionId)}
              isRunning={sessionIndicators().runningIds.has(sessionId)}
              isFailed={sessionIndicators().failedIds.has(sessionId)}
              needsAttention={sessionIndicators().attentionIds.has(sessionId)}
              isNewlyCompleted={sessionIndicators().newlyCompletedIds.has(sessionId)}
              isCompletedPlanSession={sessionIndicators().planReadyIds.has(sessionId)}
              isPinned={state.pinnedSessionIds.includes(sessionId)}
              startsUnpinnedGroup={startsUnpinnedGroup()}
              showFolder={
                !folderFilter() && (state.editorContext.workspaceFolders?.length ?? 0) > 1
              }
              onTogglePinned={async () => {
                try {
                  const pinnedSessionIds = await client.varro.session.setPinned(
                    sessionId,
                    !state.pinnedSessionIds.includes(sessionId),
                    { directory: session().directory }
                  );
                  setState('pinnedSessionIds', pinnedSessionIds);
                } catch (error) {
                  setError(error instanceof Error ? error.message : String(error));
                }
              }}
              onOpenSubagents={props.onOpenSubagents}
              onActiveSessionReselect={props.onActiveSessionReselect}
              embedded={props.embedded}
            />
          );
        }}
      </For>
    );
  };

  const renderScrollableContent = () => (
    <div class="session-list-scroll">
      {renderSessionItems(visibleSessions)}
      <Show when={!trimmedSearchQuery() && !props.subagentParentId && !props.sessionFilter}>
        <SessionListContinuation />
      </Show>
    </div>
  );

  const renderGroupedSection = (section: SessionListGroupedSection) => {
    const expanded = () => expandedGroupedSection() === section;

    switch (section) {
      case 'recent':
        return (
          <div class={`session-list-section ${expanded() ? 'expanded' : ''}`}>
            <Show when={!expanded()}>
              <SessionListSectionHeader
                title="Recent"
                count={surfacedSessions().length}
                expanded={false}
                onToggle={() => toggleGroupedSection('recent')}
              />
            </Show>
            <Show when={expanded()}>
              <div class="session-list-scroll session-list-section-scroll">
                {renderSessionItems(surfacedSessions, 0, true)}
              </div>
            </Show>
          </div>
        );
      case 'archive':
        return (
          <div class={`session-list-section ${expanded() ? 'expanded' : ''}`}>
            <SessionListSectionHeader
              title="Archive"
              count={overflowOtherSessions().length}
              incomplete={state.sessionsHasMore}
              expanded={expanded()}
              onToggle={() => toggleGroupedSection('archive')}
            />
            <Show when={expanded()}>
              <div class="session-list-scroll session-list-section-scroll">
                {renderSessionItems(overflowOtherSessions)}
                <SessionListContinuation />
              </div>
            </Show>
          </div>
        );
      case 'recycle-bin':
        return (
          <div class={`session-list-section ${expanded() ? 'expanded' : ''}`}>
            <SessionListSectionHeader
              title="Recycle Bin"
              count={recycleBinEntries().length}
              expanded={expanded()}
              onToggle={() => toggleGroupedSection('recycle-bin')}
              onArchive={() => emptyRecycleBin()}
              archiveLabel="Empty"
            />
            <Show when={expanded()}>
              <div class="session-list-scroll session-list-section-scroll">
                <For each={recycleBinEntries()}>
                  {(entry) => (
                    <RecycleBinListItem
                      entry={entry}
                      now={ageNow}
                      showFolder={
                        !folderFilter() && (state.editorContext.workspaceFolders?.length ?? 0) > 1
                      }
                    />
                  )}
                </For>
              </div>
            </Show>
          </div>
        );
    }
  };

  const renderGroupedSections = () => (
    <div class="session-list-sections">
      <For each={availableGroupedSections()}>{(section) => renderGroupedSection(section)}</For>
    </div>
  );

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
        const session = sessions[idx]!;
        openSessionWithDisplayedModel(
          session,
          sessionDiffSummaryCache()[session.id]?.stats ?? null
        );
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
    if (props.subagentParentId && isResolvingSubagents()) return 'Loading sub-agent sessions…';
    if (props.subagentParentId) return 'No sub-agent sessions';
    if (trimmedSearchQuery() && isSearchingAllSessions()) return 'Searching sessions…';
    if (trimmedSearchQuery()) return 'No matching sessions';
    const label = getSessionListFilterLabel(props.sessionFilter ?? null);
    return label ? `No ${label.toLowerCase()} sessions` : 'No sessions yet';
  };
  const loadErrorMessage = () =>
    props.subagentParentId || props.sessionFilter || trimmedSearchQuery()
      ? null
      : (state.sessionsLoadError ?? state.recycleBinLoadError);
  const [isRetryingLoad, setIsRetryingLoad] = createSignal(false);
  const retryLoadSessions = async () => {
    if (isRetryingLoad()) return;
    setIsRetryingLoad(true);
    try {
      await reloadSessions();
    } finally {
      setIsRetryingLoad(false);
    }
  };
  const hasVisibleContent = createMemo(() => {
    if (trimmedSearchQuery()) return visibleSessions().length > 0;
    if (props.subagentParentId) return subagentSessions().length > 0;
    if (props.sessionFilter) return filteredSessions().length > 0;
    if (state.sessionsHasMore) return true;
    return visibleSessionsForList().length > 0 || recycleBinEntries().length > 0;
  });

  return (
    <div
      ref={(el) => {
        containerRef = el;
      }}
      class={`session-list-view ${showAllModelDetails() ? 'show-all-model-details' : ''} ${props.class || ''}`.trim()}
      tabindex="-1"
      onPointerDown={() => {
        hasPointerInteraction = true;
      }}
      onKeyDown={handleKeydown}
    >
      <SessionListWorkspaceSelector
        selectedPath={folderFilter()}
        onSelect={(path) => {
          setFolderFilter(path);
          if (path && !isSameWorkspacePath(path, state.editorContext.workspacePath)) {
            postMessage({ type: 'workspace/select', payload: { path } });
          }
        }}
      />
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
              <UiIcon
                source={xmarkIcon}
                class="session-list-search-clear-icon"
                width={10}
                height={10}
              />
            </button>
          </Show>
        </div>
      </Show>
      <div class="session-list-content">
        <Show
          when={hasVisibleContent()}
          fallback={
            <Show
              when={loadErrorMessage()}
              fallback={<div class="session-empty">{emptyMessage()}</div>}
            >
              {(message) => (
                <div class="session-empty session-load-error" role="alert">
                  <span>{message()}</span>
                  <button
                    type="button"
                    class="session-load-error-retry"
                    disabled={isRetryingLoad()}
                    onClick={() => void retryLoadSessions()}
                  >
                    {isRetryingLoad() ? 'Retrying…' : 'Retry'}
                  </button>
                </div>
              )}
            </Show>
          }
        >
          <Show when={isDefaultGroupedView()} fallback={renderScrollableContent()}>
            {renderGroupedSections()}
          </Show>
        </Show>
      </div>
    </div>
  );
}

function RecycleBinListItem(props: {
  entry: RecycleBinEntry;
  now: () => number;
  showFolder: boolean;
}) {
  const [isConfirmingDelete, setIsConfirmingDelete] = createSignal(false);
  const title = () => normalizeSessionTitle(props.entry.root?.title || props.entry.rootID);
  const childCount = () => {
    const sessions = Array.isArray(props.entry.sessions) ? props.entry.sessions : [];
    return Math.max(0, sessions.length - 1);
  };

  const confirmDelete = async () => {
    setIsConfirmingDelete(false);
    await deleteSessionPermanently(props.entry.rootID);
  };

  return (
    <div class="session-item recycle-bin-item">
      <div class="session-item-main recycle-bin-item-main">
        <span class="session-item-indicator-spacer" />
        <div class="session-item-content">
          <span class="session-item-title">{title() || 'Untitled'}</span>
          <span class="session-item-meta">
            <Show when={props.showFolder}>
              <span class="session-item-folder" title={props.entry.root.directory}>
                <FolderIcon class="session-item-folder-meta-icon" width={10} height={10} />
                <span>
                  {getWorkspaceCompactLabel(
                    props.entry.root.directory,
                    state.editorContext.workspaceFolders ?? []
                  )}
                </span>
              </span>
              {' · '}
            </Show>
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
        <Show
          when={isConfirmingDelete()}
          fallback={
            <>
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
                onClick={() => setIsConfirmingDelete(true)}
                title="Delete permanently"
                aria-label="Delete permanently"
              >
                <UiIcon
                  source={trashIcon}
                  class="session-item-archive-icon"
                  width={14}
                  height={14}
                />
              </button>
            </>
          }
        >
          <>
            <button
              type="button"
              class="session-list-section-confirm"
              onClick={() => void confirmDelete()}
              title="Confirm permanent delete"
              aria-label="Confirm permanent delete"
            >
              Confirm
            </button>
            <button
              type="button"
              class="session-list-section-cancel"
              onClick={() => setIsConfirmingDelete(false)}
              title="Cancel delete"
              aria-label="Cancel delete"
            >
              Cancel
            </button>
          </>
        </Show>
      </div>
    </div>
  );
}

function SessionListItem(props: {
  session: (typeof state.sessions)[number];
  summaryUpdated: number;
  onRequestSummary: (updated: number) => void;
  diffSummary: SessionDiffSummary | null;
  isSummaryLoading: boolean;
  tokens: number | null;
  durationMs: number | null;
  activeStartedAt: number | null;
  itemIndex: () => number;
  focusedIndex: () => number;
  setFocusedIndex: (index: number) => void;
  actions: SessionActionsState;
  ageNow: () => number;
  activeNow: () => number;
  queuedMessageCount: number;
  subagentCount: number;
  hasPermissionRequest: boolean;
  hasQuestionRequest: boolean;
  isRunning: boolean;
  isFailed: boolean;
  needsAttention: boolean;
  isNewlyCompleted: boolean;
  isCompletedPlanSession: boolean;
  isPinned: boolean;
  startsUnpinnedGroup: boolean;
  showFolder: boolean;
  onTogglePinned: () => Promise<void>;
  onOpenSubagents?: (parentSessionId: string) => void;
  onActiveSessionReselect?: () => void;
  embedded?: boolean;
}) {
  let rowRef: HTMLDivElement | undefined;
  let sessionButtonRef: HTMLButtonElement | undefined;
  let actionsMenuRef: HTMLDivElement | undefined;
  let openedPointerId: number | null = null;
  let pointerClickTimer: ReturnType<typeof setTimeout> | undefined;
  const [shouldLoadSummary, setShouldLoadSummary] = createSignal(false);
  const isFocused = () => props.focusedIndex() === props.itemIndex();
  const isActive = () => !!props.embedded && state.activeSessionId === props.session.id;
  const showActions = () => props.actions.sessionId() === props.session.id;
  const status = () => state.sessionStatus[props.session.id];
  const hasUnreadCompletion = () =>
    props.isNewlyCompleted ||
    (props.isCompletedPlanSession && isSessionUnread(props.session.id, props.session.time.updated));
  const hasUnreadFailure = () => props.isFailed && isSessionFailureUnread(props.session.id);
  const hasPendingInput = () =>
    props.hasPermissionRequest || props.hasQuestionRequest || props.needsAttention;
  const queuedMessageLabel = () =>
    `${props.queuedMessageCount} queued message${props.queuedMessageCount === 1 ? '' : 's'}`;
  const queuedMessageDescriptionId = createUniqueId();
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
        ? Math.max(0, props.activeNow() - props.activeStartedAt)
        : 0;
    return props.durationMs + activeDuration;
  };
  const modelDetails = createMemo(() => {
    const selectedModel = getSessionDisplayModel(props.session, props.diffSummary);
    const model = selectedModel
      ? {
          providerID: selectedModel.providerID,
          id: selectedModel.modelID,
          variant: selectedModel.variant,
        }
      : null;
    if (!model) return null;
    const provider = state.providers.find((item) => item.id === model.providerID);
    const modelName = formatModelName(provider?.models[model.id]?.name || model.id);
    const reasoningLabel = model.variant ? formatVariantLabel(model.variant) : 'Default';
    return {
      providerID: model.providerID,
      providerName: provider?.name || model.providerID,
      modelName,
      reasoningLabel,
    };
  });
  const indicatorKind = () =>
    getSessionStatusIndicatorKind({
      isFailed: hasUnreadFailure(),
      hasPendingInput: hasPendingInput(),
      isRunning: props.isRunning,
      isPlanReady: props.isCompletedPlanSession && hasUnreadCompletion(),
      isCompleted: hasUnreadCompletion(),
    });
  const indicatorTitle = (kind: SessionStatusIndicatorKind) => {
    if (kind === 'attention') {
      if (props.hasPermissionRequest && props.hasQuestionRequest) return 'Attention needed';
      if (props.hasPermissionRequest) return 'Permission request pending';
    }
    return getSessionStatusIndicatorTitle(kind, { retrying: status()?.type === 'retry' });
  };
  const openActions = (event: MouseEvent) => {
    props.actions.open(props.session.id, event);
    queueMicrotask(() =>
      actionsMenuRef?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    );
  };
  const openSession = (openInEditor = false) => {
    const sessionRootId = getSessionTreeRootId(props.session.id) || props.session.id;
    if (openInEditor || (!props.embedded && state.editorTabsOpen)) {
      const model = getSessionDisplayModel(props.session, props.diffSummary);
      postMessage({
        type: 'session/open-in-editor',
        payload: {
          sessionId: props.session.id,
          directory: props.session.directory,
          rootSessionId: sessionRootId,
          title: props.session.title,
          model: model ?? undefined,
        },
      });
      return;
    }
    if (isActive()) {
      props.onActiveSessionReselect?.();
      return;
    }
    openSessionWithDisplayedModel(props.session, props.diffSummary);
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
    openSession(event.altKey);
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
      openSession(event.altKey);
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

  onMount(() => {
    if (!rowRef || globalThis.IntersectionObserver === undefined) {
      setShouldLoadSummary(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoadSummary(true);
        observer.disconnect();
      },
      {
        root: rowRef.closest('.session-list-scroll'),
        rootMargin: '300px 0px',
      }
    );
    observer.observe(rowRef);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    if (!shouldLoadSummary()) return;
    props.onRequestSummary(props.summaryUpdated);
  });

  onCleanup(() => {
    if (pointerClickTimer !== undefined) clearTimeout(pointerClickTimer);
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
      ref={(element) => {
        rowRef = element;
      }}
      class={`session-item ${isActive() ? 'active' : ''} ${props.isPinned ? 'is-pinned' : ''} ${props.startsUnpinnedGroup ? 'starts-unpinned-group' : ''} ${showActions() ? 'is-context-selected' : ''} ${props.actions.sessionId() && !showActions() ? 'is-context-obscured' : ''} ${isFocused() ? 'keyboard-focus' : ''} ${modelDetails() ? 'has-model-details' : ''}`}
      data-session-id={props.session.id}
      inert={props.actions.sessionId() ? true : undefined}
      onMouseMove={() => {
        if (!props.actions.sessionId()) props.setFocusedIndex(props.itemIndex());
      }}
      onMouseLeave={() => {
        if (!props.actions.sessionId()) props.setFocusedIndex(-1);
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
        aria-describedby={props.queuedMessageCount > 0 ? queuedMessageDescriptionId : undefined}
        onFocus={() => {
          if (!props.actions.sessionId()) props.setFocusedIndex(props.itemIndex());
        }}
      >
        <Show when={indicatorKind()} fallback={<span class="session-item-indicator-spacer" />}>
          {(kind) => (
            <span class="session-item-indicator-slot">
              <span
                class={`session-item-indicator session-status-indicator ${getSessionStatusIndicatorClass(kind())}`}
                title={indicatorTitle(kind())}
                aria-label={indicatorTitle(kind())}
              />
            </span>
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
                <UiIcon source={pinIcon} class="session-item-pinned-icon" width={12} height={12} />
              </span>
            </Show>
            <Show when={props.session.share?.url}>
              <span
                class="session-item-shared-marker"
                title="Session is shared"
                aria-label="Session is shared"
              >
                <SharedSessionIcon />
              </span>
            </Show>
            <Show when={modelDetails()}>
              {(details) => (
                <Show
                  when={getProviderIcon(details().providerID)}
                  fallback={
                    <span class="session-item-provider-name">{details().providerName}</span>
                  }
                >
                  {(icon) => (
                    <span
                      class="provider-icon session-item-provider-icon"
                      style={{ '--provider-icon-mask': `url("${icon()}")` }}
                      aria-hidden="true"
                    />
                  )}
                </Show>
              )}
            </Show>
          </span>
          <span class="session-item-meta session-item-stats-meta">
            <Show when={props.showFolder}>
              <span class="session-item-folder" title={props.session.directory}>
                <FolderIcon class="session-item-folder-meta-icon" width={10} height={10} />
                <span>
                  {getWorkspaceCompactLabel(
                    props.session.directory,
                    state.editorContext.workspaceFolders ?? []
                  )}
                </span>
              </span>
              {' · '}
            </Show>
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
                      <Show when={!summary().filesTruncated} fallback={<>Large change set</>}>
                        {summary().files} file
                        {summary().files !== 1 ? 's' : ''}
                        {' · '}
                        <span class="diff-lines-added">
                          +{formatEditCount(summary().additions)}
                        </span>{' '}
                        <span class="diff-lines-removed">
                          -{formatEditCount(summary().deletions)}
                        </span>
                      </Show>
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
            <Show when={modelDetails()}>
              {(details) => (
                <span class="session-item-model-meta">
                  {` · ${details().modelName} · ${details().reasoningLabel}`}
                </span>
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
        <Show when={props.queuedMessageCount > 0}>
          <span
            id={queuedMessageDescriptionId}
            class="session-item-queued-counter"
            data-session-id={props.session.id}
            data-queued-message-count={props.queuedMessageCount}
            title={queuedMessageLabel()}
            aria-label={queuedMessageLabel()}
          >
            <UiIcon
              source={forwardMessageIcon}
              class="session-item-queued-icon"
              width={16}
              height={16}
            />
            <span class="session-item-queued-count">{props.queuedMessageCount}</span>
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
            <UiIcon
              source={cableTagIcon}
              class="session-item-subagents-icon"
              width={16}
              height={16}
            />
            <span class="session-item-subagents-count">{props.subagentCount}</span>
          </button>
        </Show>
        <span
          class="session-item-age"
          title={new Date(props.session.time.updated).toLocaleString()}
        >
          {formatRelativeAge(props.session.time.updated, props.ageNow())}
        </span>
      </div>
      <Show when={showActions()}>
        <SessionActionsMenu
          session={props.session}
          state={props.actions}
          isPinned={props.isPinned}
          showOpenInSidebar
          showOpenAsEditor
          inputIdPrefix="session-rename"
          onMenuRef={(element) => {
            actionsMenuRef = element;
          }}
          onEscape={() => sessionButtonRef?.focus()}
          onTogglePinned={() => props.onTogglePinned()}
          onDelete={(sessionId) => deleteSession(sessionId)}
        />
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
  const editorSessionIds = new Set(state.editorSessionIds);
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
    return (
      type === 'busy' || type === 'retry' || (sessionId === state.activeSessionId && isLoading())
    );
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
    if (editorSessionIds.has(displaySessionId)) continue;
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
