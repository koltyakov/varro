import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { SessionDiffSummary } from '../../../shared/protocol';
import { normalizeSessionTitle } from '../../../shared/session-title';
import { deleteSession, renameSession } from '../../hooks/useOpenCode';
import { client } from '../../lib/client';
import { formatDuration } from '../../lib/message-metrics';
import { clampPopupToViewport } from '../../lib/popup-position';
import { shareSession, unshareSession } from '../../lib/session-sharing';
import { setError, setState, state } from '../../lib/state';
import { writeClipboard } from '../../lib/write-clipboard';
import {
  AttentionSessionsBadge,
  CompletedSessionsBadge,
  FailedSessionsBadge,
  PlanReadyBadge,
  RunningSessionsBadge,
} from './HeaderBadges';
import type { SessionListFilter } from './SessionListView';
import { showSessionActionFeedback } from './SessionActionFeedback';
import { SharedSessionIcon } from './SharedSessionIcon';

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
          <button
            class="chat-header-btn"
            onClick={() => props.onBack?.()}
            title={props.backTitle || 'Back to parent session'}
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
            </svg>
          </button>
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
              <span class="chat-header-filter-chip" title={props.filterTitle}>
                <span class="chat-header-filter-chip-label">{label()}</span>
                <button
                  type="button"
                  class="chat-header-filter-chip-remove"
                  onClick={props.onClearFilter}
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
          <button class="chat-header-btn" onClick={props.onCreateSession} title="New chat">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
            </svg>
          </button>
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
    const sessionId = state.activeSessionId;
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
  let renameInputRef: HTMLInputElement | undefined;
  const [actionsSessionId, setActionsSessionId] = createSignal<string | null>(null);
  const [actionsPosition, setActionsPosition] = createSignal({ x: 0, y: 0 });
  const [renaming, setRenaming] = createSignal(false);
  const [renameValue, setRenameValue] = createSignal('');
  const [renamePending, setRenamePending] = createSignal(false);
  const actionsSession = () => {
    const sessionId = actionsSessionId();
    return sessionId ? (state.sessions.find((session) => session.id === sessionId) ?? null) : null;
  };
  const isActionsSessionPinned = () => {
    const sessionId = actionsSessionId();
    return !!sessionId && state.pinnedSessionIds.includes(sessionId);
  };
  const closeActions = () => {
    setActionsSessionId(null);
    setRenaming(false);
    setRenamePending(false);
  };
  const openActions = (event: MouseEvent) => {
    const session = getActiveSession();
    if (!session) return;
    event.preventDefault();
    setActionsPosition({ x: event.clientX, y: event.clientY });
    setRenaming(false);
    setActionsSessionId(session.id);
    queueMicrotask(() =>
      actionsMenuRef?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    );
  };
  const beginRename = () => {
    const session = actionsSession();
    if (!session) return;
    setRenameValue(normalizeSessionTitle(session.title) || '');
    setRenaming(true);
    queueMicrotask(() => {
      renameInputRef?.focus();
      renameInputRef?.select();
    });
  };
  const submitRename = async () => {
    if (renamePending()) return;
    const sessionId = actionsSessionId();
    const title = renameValue().trim();
    if (!sessionId || !title) return;
    setRenamePending(true);
    const renamed = await renameSession(sessionId, title);
    if (actionsSessionId() !== sessionId) return;
    setRenamePending(false);
    if (renamed) closeActions();
  };
  const togglePinned = async () => {
    const sessionId = actionsSessionId();
    if (!sessionId) return;
    const pinned = !state.pinnedSessionIds.includes(sessionId);
    closeActions();
    try {
      const pinnedSessionIds = await client.varro.session.setPinned(sessionId, pinned);
      setState('pinnedSessionIds', pinnedSessionIds);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const copySessionId = async () => {
    const sessionId = actionsSessionId();
    closeActions();
    if (!sessionId) return;
    if (!(await writeClipboard(sessionId))) {
      setError('Failed to copy session ID');
      return;
    }
    showSessionActionFeedback('Session ID copied');
  };
  const shareActionsSession = async () => {
    const session = actionsSession();
    closeActions();
    if (!session || !(await shareSession(session))) return;
    showSessionActionFeedback('Share link copied');
  };
  const unshareActionsSession = async () => {
    const session = actionsSession();
    closeActions();
    if (!session || !(await unshareSession(session))) return;
    showSessionActionFeedback('Session unshared');
  };

  createEffect(() => {
    if (!actionsSessionId()) return;
    actionsPosition();
    renaming();
    queueMicrotask(() => {
      if (actionsMenuRef) clampPopupToViewport(actionsMenuRef);
    });
  });

  createEffect(() => {
    if (!actionsSessionId()) return;
    const closeIfOutside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && actionsMenuRef?.contains(target)) return;
      closeActions();
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
          <button class="chat-header-btn" onClick={props.onBack} title={props.backTitle}>
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
            </svg>
          </button>
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
            <span
              class="session-item-pinned-marker"
              title="Pinned session"
              aria-label="Pinned session"
            >
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
          </Show>
          <Show when={getActiveSession()?.share?.url}>
            <span
              class="chat-header-shared-marker"
              title="Session is shared"
              aria-label="Session is shared"
            >
              <SharedSessionIcon />
            </span>
          </Show>
        </span>
        <Show when={props.activeSubagentRootId}>
          {(rootSessionId) => (
            <button
              type="button"
              class="session-item-subagents session-item-subagents-counter chat-header-subagents"
              onClick={() => props.onOpenSubagents(rootSessionId())}
              title={props.activeSubagentLabel}
              aria-label={props.activeSubagentLabel}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M5.5 2.5a2 2 0 110 4 2 2 0 010-4zm5 1a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM2 9.25c0-1.8 2.1-2.75 3.5-2.75S9 7.45 9 9.25V10H2v-.75zm7.5.75v-.5c0-.66-.2-1.23-.54-1.7.5-.19 1.04-.3 1.54-.3 1.22 0 3 .73 3 2.25V10h-4z" />
              </svg>
              <span class="session-item-subagents-count">{props.activeSubagentCount}</span>
            </button>
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
          <button class="chat-header-btn" onClick={props.onCreateSession} title="New chat">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
            </svg>
          </button>
        </div>
      </Show>
      <Show when={actionsSession()}>
        {(session) => (
          <Portal>
            <div
              ref={(element) => {
                actionsMenuRef = element;
              }}
              class="session-item-actions-menu"
              role="menu"
              aria-label="Session actions"
              style={{
                left: `${actionsPosition().x}px`,
                top: `${actionsPosition().y}px`,
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                closeActions();
                titleRef?.focus();
              }}
            >
              <Show
                when={renaming()}
                fallback={
                  <>
                    <button type="button" role="menuitem" onClick={beginRename}>
                      Rename
                    </button>
                    <Show when={!session().parentID}>
                      <button type="button" role="menuitem" onClick={() => void togglePinned()}>
                        {isActionsSessionPinned() ? 'Unpin' : 'Pin'}
                      </button>
                    </Show>
                    <button type="button" role="menuitem" onClick={() => void copySessionId()}>
                      Copy session ID
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void shareActionsSession()}
                    >
                      {session().share?.url ? 'Copy share link' : 'Share session'}
                    </button>
                    <Show when={session().share?.url}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void unshareActionsSession()}
                      >
                        Unshare session
                      </button>
                    </Show>
                    <button
                      type="button"
                      role="menuitem"
                      class="is-destructive"
                      onClick={() => {
                        const sessionId = actionsSessionId();
                        closeActions();
                        if (sessionId) void deleteSession(sessionId);
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
                  <label for={`header-session-rename-${session().id}`}>Session name</label>
                  <input
                    ref={(element) => {
                      renameInputRef = element;
                    }}
                    id={`header-session-rename-${session().id}`}
                    value={renameValue()}
                    onInput={(event) => setRenameValue(event.currentTarget.value)}
                    disabled={renamePending()}
                  />
                  <div class="session-item-rename-actions">
                    <button type="button" onClick={closeActions}>
                      Cancel
                    </button>
                    <button type="submit" disabled={!renameValue().trim() || renamePending()}>
                      Save
                    </button>
                  </div>
                </form>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}

export type { SessionListFilter };
