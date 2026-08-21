import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { SessionDiffSummary } from '../../../shared/protocol';
import { deleteSession } from '../../hooks/useOpenCode';
import { client } from '../../lib/client';
import { formatDuration } from '../../lib/message-metrics';
import {
  setError,
  setPersistentShowSessionPicker as setShowSessionPicker,
  setState,
  state,
} from '../../lib/state';
import {
  AttentionSessionsBadge,
  CompletedSessionsBadge,
  FailedSessionsBadge,
  PlanReadyBadge,
  RunningSessionsBadge,
} from './HeaderBadges';
import type { SessionListFilter } from './SessionListView';
import { SessionActionsMenu, createSessionActionsState } from './SessionActionsMenu';
import { SharedSessionIcon } from './SharedSessionIcon';
import { Tooltip } from '../Tooltip';

function getActiveSession() {
  return state.sessions.find((session) => session.id === state.activeSessionId) ?? null;
}

function isActiveSessionPinned() {
  const sessionId = state.activeSessionId;
  return !!sessionId && state.pinnedSessionIds.includes(sessionId);
}

function isActiveSessionRunning() {
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;
  const type = state.sessionStatus[sessionId]?.type;
  return type === 'busy' || type === 'retry';
}

async function toggleSessionPinned(sessionId: string) {
  const pinned = !state.pinnedSessionIds.includes(sessionId);
  try {
    const pinnedSessionIds = await client.varro.session.setPinned(sessionId, pinned);
    setState('pinnedSessionIds', pinnedSessionIds);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

async function deleteSessionFromHeader(sessionId: string) {
  await deleteSession(sessionId);
  setShowSessionPicker(true);
}

export function SessionPickerHeader(props: {
  filterLabel: string | null;
  filterPrefix: string;
  filterTitle?: string;
  primarySessionsCount: number;
  showBackButton?: boolean;
  backTitle?: string;
  showFailedBadge: boolean;
  showAttentionBadge: boolean;
  showPlanReadyBadge: boolean;
  showCompletedBadge: boolean;
  showRunningBadge: boolean;
  failedCount: number;
  attentionCount: number;
  planReadyCount: number;
  completedCount: number;
  runningCount: number;
  showNewChatButton?: boolean;
  onBack?: () => void;
  onClearFilter: () => void;
  onOpenFailedSessions: () => void;
  onOpenAttentionSessions: () => void;
  onOpenPlanReadySessions: () => void;
  onOpenCompletedSessions: () => void;
  onOpenRunningSessions: () => void;
  onCreateSession: () => void;
}) {
  return (
    <>
      <div class="chat-header-left">
        <Show when={props.showBackButton}>
          <Tooltip content={props.backTitle || 'Back to parent session'}>
            <button
              class="chat-header-btn"
              onClick={() => props.onBack?.()}
              aria-label={props.backTitle || 'Back to parent session'}
            >
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
              </svg>
            </button>
          </Tooltip>
        </Show>
        <Show
          when={props.filterLabel}
          fallback={
            <span class="chat-header-title-text">
              Sessions <span class="chat-header-title-count">({props.primarySessionsCount})</span>
            </span>
          }
        >
          {(label) => (
            <>
              <span class="chat-header-filter-prefix">{props.filterPrefix}</span>
              <span class="chat-header-filter-chip">
                <Tooltip content={props.filterTitle ?? label()} disabled={!props.filterTitle}>
                  <span class="chat-header-filter-chip-label">{label()}</span>
                </Tooltip>
                <Tooltip content="Clear filter">
                  <button
                    type="button"
                    class="chat-header-filter-chip-remove"
                    onClick={props.onClearFilter}
                    aria-label={`Clear ${label()} filter`}
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                    </svg>
                  </button>
                </Tooltip>
              </span>
            </>
          )}
        </Show>
      </div>
      <div class="chat-header-actions">
        <Show when={props.showFailedBadge}>
          <FailedSessionsBadge count={props.failedCount} onClick={props.onOpenFailedSessions} />
        </Show>
        <Show when={props.showAttentionBadge}>
          <AttentionSessionsBadge
            count={props.attentionCount}
            onClick={props.onOpenAttentionSessions}
          />
        </Show>
        <Show when={props.showPlanReadyBadge}>
          <PlanReadyBadge count={props.planReadyCount} onClick={props.onOpenPlanReadySessions} />
        </Show>
        <Show when={props.showCompletedBadge}>
          <CompletedSessionsBadge
            count={props.completedCount}
            onClick={props.onOpenCompletedSessions}
          />
        </Show>
        <Show when={props.showRunningBadge}>
          <RunningSessionsBadge count={props.runningCount} onClick={props.onOpenRunningSessions} />
        </Show>
        <Show when={props.showNewChatButton}>
          <Tooltip content="New chat">
            <button class="chat-header-btn" onClick={props.onCreateSession} aria-label="New chat">
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
              </svg>
            </button>
          </Tooltip>
        </Show>
      </div>
    </>
  );
}

export function ActiveChatHeader(props: {
  title: string;
  showBackButton: boolean;
  backTitle: string;
  showActions?: boolean;
  activeSubagentRootId: string | null;
  activeSubagentCount: number;
  activeSubagentLabel: string;
  failedCount: number;
  attentionCount: number;
  planReadyCount: number;
  completedCount: number;
  runningCount: number;
  onBack: () => void;
  onOpenSubagents: (rootSessionId: string) => void;
  onOpenFailedSessions: () => void;
  onOpenAttentionSessions: () => void;
  onOpenPlanReadySessions: () => void;
  onOpenCompletedSessions: () => void;
  onOpenRunningSessions: () => void;
  onCreateSession: () => void;
}) {
  const [workSummary, setWorkSummary] = createSignal<Pick<
    SessionDiffSummary,
    'durationMs' | 'activeStartedAt'
  > | null>(null);
  const [workNow, setWorkNow] = createSignal(Date.now());
  const workedDurationMs = () => {
    const summary = workSummary();
    if (!summary) return null;
    const activeDuration =
      isActiveSessionRunning() && summary.activeStartedAt !== null
        ? Math.max(0, workNow() - summary.activeStartedAt)
        : 0;
    const total = summary.durationMs + activeDuration;
    return total > 0 ? total : null;
  };

  createEffect(() => {
    const sessionId = getActiveSession()?.id ?? state.activeSessionId;
    if (!sessionId) {
      setWorkSummary(null);
      return;
    }
    isActiveSessionRunning();
    let cancelled = false;
    client.varro.session
      .diffSummary(sessionId)
      .then((summary) => {
        if (cancelled) return;
        setWorkNow(Date.now());
        setWorkSummary({
          durationMs: summary.durationMs,
          activeStartedAt: summary.activeStartedAt,
        });
      })
      .catch(() => {});
    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!isActiveSessionRunning() || workSummary()?.activeStartedAt == null) return;
    const timer = setInterval(() => setWorkNow(Date.now()), 1_000);
    onCleanup(() => clearInterval(timer));
  });

  let titleRef: HTMLSpanElement | undefined;
  let actionsMenuRef: HTMLDivElement | undefined;
  const sessionActions = createSessionActionsState();
  const actionsSession = () => {
    const sessionId = sessionActions.sessionId();
    return sessionId ? (state.sessions.find((session) => session.id === sessionId) ?? null) : null;
  };
  const isActionsSessionPinned = () => {
    const sessionId = sessionActions.sessionId();
    return !!sessionId && state.pinnedSessionIds.includes(sessionId);
  };
  const openActions = (event: MouseEvent) => {
    const session = getActiveSession();
    if (!session) return;
    sessionActions.open(session.id, event);
    queueMicrotask(() =>
      actionsMenuRef?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    );
  };
  createEffect(() => {
    if (!sessionActions.sessionId()) return;
    const closeIfOutside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && actionsMenuRef?.contains(target)) return;
      sessionActions.close();
    };
    window.addEventListener('contextmenu', closeIfOutside, true);
    window.addEventListener('pointerdown', closeIfOutside, true);
    window.addEventListener('focusin', closeIfOutside);
    onCleanup(() => {
      window.removeEventListener('contextmenu', closeIfOutside, true);
      window.removeEventListener('pointerdown', closeIfOutside, true);
      window.removeEventListener('focusin', closeIfOutside);
    });
  });

  return (
    <>
      <div class="chat-header-left">
        <Show when={props.showBackButton}>
          <Tooltip content={props.backTitle}>
            <button class="chat-header-btn" onClick={props.onBack} aria-label={props.backTitle}>
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
              </svg>
            </button>
          </Tooltip>
        </Show>
        <span
          ref={(element) => {
            titleRef = element;
          }}
          class="chat-header-session-title"
          onContextMenu={openActions}
        >
          <span class="chat-header-title-text">{props.title}</span>
          <Show when={isActiveSessionPinned()}>
            <Tooltip content="Pinned session">
              <span class="session-item-pinned-marker" aria-label="Pinned session">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M9.5 14.5 3 21"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <path
                    d="m5 9.485 9.193 9.193 1.697-1.697-.393-3.787 5.51-4.673-5.85-5.85-4.674 5.51-3.786-.393L5 9.485Z"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </span>
            </Tooltip>
          </Show>
          <Show when={getActiveSession()?.share?.url}>
            <Tooltip content="Session is shared">
              <span class="chat-header-shared-marker" aria-label="Session is shared">
                <SharedSessionIcon />
              </span>
            </Tooltip>
          </Show>
        </span>
        <Show when={props.activeSubagentRootId}>
          {(rootSessionId) => (
            <Tooltip content={props.activeSubagentLabel}>
              <button
                type="button"
                class="session-item-subagents session-item-subagents-counter chat-header-subagents"
                onClick={() => props.onOpenSubagents(rootSessionId())}
                aria-label={props.activeSubagentLabel}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M5.5 2.5a2 2 0 110 4 2 2 0 010-4zm5 1a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM2 9.25c0-1.8 2.1-2.75 3.5-2.75S9 7.45 9 9.25V10H2v-.75zm7.5.75v-.5c0-.66-.2-1.23-.54-1.7.5-.19 1.04-.3 1.54-.3 1.22 0 3 .73 3 2.25V10h-4z" />
                </svg>
                <span class="session-item-subagents-count">{props.activeSubagentCount}</span>
              </button>
            </Tooltip>
          )}
        </Show>
        <Show when={workedDurationMs()}>
          {(durationMs) => (
            <span class="chat-header-session-duration">{formatDuration(durationMs())}</span>
          )}
        </Show>
      </div>
      <Show when={props.showActions}>
        <div class="chat-header-actions">
          <FailedSessionsBadge count={props.failedCount} onClick={props.onOpenFailedSessions} />
          <AttentionSessionsBadge
            count={props.attentionCount}
            onClick={props.onOpenAttentionSessions}
          />
          <PlanReadyBadge count={props.planReadyCount} onClick={props.onOpenPlanReadySessions} />
          <CompletedSessionsBadge
            count={props.completedCount}
            onClick={props.onOpenCompletedSessions}
          />
          <RunningSessionsBadge count={props.runningCount} onClick={props.onOpenRunningSessions} />
          <Tooltip content="New chat">
            <button class="chat-header-btn" onClick={props.onCreateSession} aria-label="New chat">
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </Show>
      <Show when={actionsSession()}>
        {(session) => (
          <SessionActionsMenu
            session={session()}
            state={sessionActions}
            isPinned={isActionsSessionPinned()}
            inputIdPrefix="header-session-rename"
            onMenuRef={(element) => {
              actionsMenuRef = element;
            }}
            onEscape={() => titleRef?.focus()}
            onTogglePinned={toggleSessionPinned}
            onDelete={deleteSessionFromHeader}
          />
        )}
      </Show>
    </>
  );
}

export type { SessionListFilter };
