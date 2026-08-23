import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { SessionDiffSummary } from '../../../shared/protocol';
import { deleteSession } from '../../hooks/useOpenCode';
import { postMessage } from '../../lib/bridge';
import { client } from '../../lib/client';
import { formatDuration } from '../../lib/message-metrics';
import { cableTagIcon, pinIcon, xmarkIcon } from '../../lib/ui-icons';
import { NavArrowLeftControlIcon } from '../ControlIcons';
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
import { UiIcon } from '../UiIcon';
import { PlusIcon } from '../PlusIcon';

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

function createSessionFromClick(event: MouseEvent, onCreateSession: () => void) {
  if (event.altKey) {
    postMessage({ type: 'chat/new-editor' });
    return;
  }
  onCreateSession();
}

export function getNewChatEditorShortcut(platform = navigator.platform) {
  return /^Mac/i.test(platform) ? 'Option-click to open in editor' : 'Alt-click to open in editor';
}

function NewChatTooltipContent() {
  return (
    <span class="new-chat-tooltip">
      <strong class="new-chat-tooltip-title">New chat</strong>
      <span class="new-chat-tooltip-shortcut">{getNewChatEditorShortcut()}</span>
    </span>
  );
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
              <NavArrowLeftControlIcon class="chat-header-button-icon chat-header-back-icon" />
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
                    <UiIcon
                      source={xmarkIcon}
                      class="chat-header-filter-chip-remove-icon"
                      width={10}
                      height={10}
                    />
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
          <Tooltip content={<NewChatTooltipContent />}>
            <button
              class="chat-header-btn"
              onClick={(event) => createSessionFromClick(event, props.onCreateSession)}
              aria-label="New chat"
            >
              <PlusIcon class="chat-header-add-icon" />
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
              <NavArrowLeftControlIcon class="chat-header-button-icon chat-header-back-icon" />
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
                <UiIcon source={pinIcon} class="session-item-pinned-icon" width={12} height={12} />
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
                <UiIcon
                  source={cableTagIcon}
                  class="session-item-subagents-icon"
                  width={16}
                  height={16}
                />
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
          <Tooltip content={<NewChatTooltipContent />}>
            <button
              class="chat-header-btn"
              onClick={(event) => createSessionFromClick(event, props.onCreateSession)}
              aria-label="New chat"
            >
              <PlusIcon class="chat-header-add-icon" />
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
            showOpenAsEditor
            inputIdPrefix="header-session-rename"
            onMenuRef={(element) => {
              actionsMenuRef = element;
            }}
            onEscape={() => titleRef?.focus()}
            onOpenAsEditor={() => setShowSessionPicker(true)}
            onTogglePinned={toggleSessionPinned}
            onDelete={deleteSessionFromHeader}
          />
        )}
      </Show>
    </>
  );
}

export type { SessionListFilter };
