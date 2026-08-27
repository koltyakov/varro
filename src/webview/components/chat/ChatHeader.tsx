import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { SessionDiffSummary } from '../../../shared/protocol';
import { deleteSession } from '../../hooks/useOpenCode';
import { postMessage } from '../../lib/bridge';
import { client } from '../../lib/client';
import { formatDuration } from '../../lib/message-metrics';
import { clampPopupToViewport } from '../../lib/popup-position';
import { appNotificationIcon, cableTagIcon, pinIcon, xmarkIcon } from '../../lib/ui-icons';
import { NavArrowLeftControlIcon } from '../ControlIcons';
import {
  setError,
  setManualWorkspaceSelection,
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

const SIBLING_ALERT_REMINDER_INTERVAL_MS = 30_000;

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

function siblingWorkspaceAlerts() {
  return state.siblingWorkspaceAlerts;
}

function NewChatButton(props: { onCreateSession: () => void }) {
  const [menuPosition, setMenuPosition] = createSignal<{ x: number; y: number } | null>(null);
  let buttonRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;

  const closeMenu = () => setMenuPosition(null);

  createEffect(() => {
    if (!menuPosition()) return;
    const closeIfOutside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef?.contains(target)) return;
      closeMenu();
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

  createEffect(() => {
    if (!menuPosition()) return;
    queueMicrotask(() => {
      if (!menuRef) return;
      clampPopupToViewport(menuRef);
      menuRef.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
  });

  return (
    <>
      <Tooltip content="New chat">
        <button
          ref={(element) => {
            buttonRef = element;
          }}
          class="chat-header-btn"
          onClick={() => props.onCreateSession()}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuPosition({ x: event.clientX, y: event.clientY });
          }}
          aria-label="New chat"
          aria-haspopup="menu"
          aria-expanded={menuPosition() ? 'true' : undefined}
        >
          <PlusIcon class="chat-header-add-icon" />
        </button>
      </Tooltip>
      <Show when={menuPosition()}>
        {(position) => (
          <Portal>
            <div
              ref={(element) => {
                menuRef = element;
              }}
              class="session-item-actions-menu"
              role="menu"
              aria-label="New chat actions"
              style={{ left: `${position().x}px`, top: `${position().y}px` }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                closeMenu();
                buttonRef?.focus();
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  props.onCreateSession();
                }}
              >
                New Chat
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  postMessage({ type: 'chat/new-editor' });
                }}
              >
                New Chat in Editor
              </button>
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}

function SiblingWorkspaceAlertsButton() {
  const [showMenu, setShowMenu] = createSignal(false);
  let buttonRef: HTMLButtonElement | undefined;
  let iconRef: HTMLSpanElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  let previousAlerts = new Map<string, { count: number; kinds: Set<string> }>();
  const label = () =>
    siblingWorkspaceAlerts().length === 1
      ? `Events in sibling workspace ${siblingWorkspaceAlerts()[0]!.name}`
      : `Events in ${siblingWorkspaceAlerts().length} sibling workspaces`;
  const openWorkspace = (path: string) => {
    setShowMenu(false);
    setShowSessionPicker(true);
    setManualWorkspaceSelection(true);
    setState('pendingWorkspaceSelectionPath', path);
    postMessage({ type: 'workspace/select', payload: { path } });
  };
  const moveMenuFocus = (event: KeyboardEvent) => {
    if (!menuRef || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...menuRef.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.findIndex((item) => item === document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  const ringIcon = () => {
    if (!iconRef) return;
    iconRef.classList.remove('is-ringing');
    void iconRef.offsetWidth;
    iconRef.classList.add('is-ringing');
  };

  createEffect(() => {
    const alerts = siblingWorkspaceAlerts();
    const hasNewEvent = alerts.some((alert) => {
      const previous = previousAlerts.get(alert.path);
      return (
        !previous ||
        alert.count > previous.count ||
        alert.kinds.some((kind) => !previous.kinds.has(kind))
      );
    });
    previousAlerts = new Map(
      alerts.map((alert) => [
        alert.path,
        { count: alert.count, kinds: new Set<string>(alert.kinds) },
      ])
    );
    if (alerts.length === 0) return;
    if (hasNewEvent) ringIcon();
    const reminder = window.setInterval(ringIcon, SIBLING_ALERT_REMINDER_INTERVAL_MS);
    onCleanup(() => window.clearInterval(reminder));
  });

  createEffect(() => {
    if (!showMenu()) return;
    if (siblingWorkspaceAlerts().length < 2) {
      setShowMenu(false);
      return;
    }
    const closeIfOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef?.contains(target) || menuRef?.contains(target)) return;
      setShowMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowMenu(false);
      buttonRef?.focus();
    };
    window.addEventListener('pointerdown', closeIfOutside, true);
    window.addEventListener('keydown', closeOnEscape, true);
    onCleanup(() => {
      window.removeEventListener('pointerdown', closeIfOutside, true);
      window.removeEventListener('keydown', closeOnEscape, true);
    });
  });

  createEffect(() => {
    if (!showMenu()) return;
    queueMicrotask(() => {
      if (!buttonRef || !menuRef) return;
      const buttonBox = buttonRef.getBoundingClientRect();
      menuRef.style.left = `${buttonBox.right - menuRef.offsetWidth}px`;
      menuRef.style.top = `${buttonBox.bottom + 4}px`;
      clampPopupToViewport(menuRef);
      menuRef.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
  });

  return (
    <Show when={siblingWorkspaceAlerts().length > 0}>
      <Tooltip content={label()}>
        <button
          ref={(element) => {
            buttonRef = element;
          }}
          type="button"
          class="chat-header-sibling-alerts"
          aria-label={label()}
          aria-haspopup={siblingWorkspaceAlerts().length > 1 ? 'menu' : undefined}
          aria-expanded={siblingWorkspaceAlerts().length > 1 ? showMenu() : undefined}
          onClick={() => {
            const current = siblingWorkspaceAlerts();
            if (current.length === 1) openWorkspace(current[0]!.path);
            else setShowMenu((open) => !open);
          }}
        >
          <UiIcon
            ref={(element) => {
              iconRef = element;
            }}
            class="chat-header-sibling-alert-icon"
            source={appNotificationIcon}
            width={15}
            height={15}
          />
        </button>
      </Tooltip>
      <Show when={showMenu()}>
        <Portal>
          <div
            ref={(element) => {
              menuRef = element;
            }}
            class="session-item-actions-menu sibling-workspace-alerts-menu"
            role="menu"
            aria-label="Sibling workspace events"
            onKeyDown={moveMenuFocus}
          >
            {siblingWorkspaceAlerts().map((alert) => (
              <button type="button" role="menuitem" onClick={() => openWorkspace(alert.path)}>
                <span>{alert.name}</span>
                <span class="sibling-workspace-alert-count">{alert.count}</span>
              </button>
            ))}
          </div>
        </Portal>
      </Show>
    </Show>
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
        <SiblingWorkspaceAlertsButton />
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
          <NewChatButton onCreateSession={props.onCreateSession} />
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
          <SiblingWorkspaceAlertsButton />
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
          <NewChatButton onCreateSession={props.onCreateSession} />
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
