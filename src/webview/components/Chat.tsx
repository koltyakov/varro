import {
  state,
  showSessionPicker,
  setShowSessionPicker,
  showSettings,
  isSessionUnread,
} from '../lib/state';
import { Show, For, createSignal, onMount, onCleanup, createEffect } from 'solid-js';
import { selectSession, createSession, deleteSession } from '../hooks/useOpenCode';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { SettingsPanel } from './SettingsPanel';

export function Chat() {
  const [focusRunningSessions, setFocusRunningSessions] = createSignal(false);

  const activeTitle = () => {
    if (!state.activeSessionId) return 'New Chat';
    const session = state.sessions.find((s) => s.id === state.activeSessionId);
    return session?.title || 'New Chat';
  };

  const runningSessionsCount = () =>
    state.sessions.reduce((count, session) => {
      if (!isRunningSession(session.id)) return count;
      if (!showSessionPicker() && session.id === state.activeSessionId) return count;
      return count + 1;
    }, 0);

  const openAllSessions = () => {
    setFocusRunningSessions(false);
    setShowSessionPicker(true);
  };

  const openRunningSessions = () => {
    if (runningSessionsCount() === 0) return;
    setFocusRunningSessions(true);
    setShowSessionPicker(true);
  };

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
                  onClick={openAllSessions}
                  title="Back to sessions"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
                  </svg>
                </button>
                <span class="chat-header-title-text">{activeTitle()}</span>
              </div>
              <div class="chat-header-actions">
                <RunningSessionsBadge count={runningSessionsCount()} onClick={openRunningSessions} />
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
            <span class="chat-header-title-text">Sessions</span>
          </div>
          <div class="chat-header-actions">
            <RunningSessionsBadge count={runningSessionsCount()} onClick={openRunningSessions} />
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

      <Show when={!showSessionPicker()} fallback={<SessionListView focusRunningSessions={focusRunningSessions()} />}>
        <Show when={showSettings()}>
          <SettingsPanel />
        </Show>

        <MessageList />

        <ChatInput />
      </Show>
    </div>
  );
}

function SessionListView(props: { focusRunningSessions: boolean }) {
  const MAX_SURFACED_OTHER_SESSIONS = 10;
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(clock));

  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  const [showOtherSessions, setShowOtherSessions] = createSignal(!props.focusRunningSessions);
  // oxlint-disable-next-line no-unassigned-vars
  let containerRef: HTMLDivElement | undefined;

  const isSessionNeedingAttention = (sessionId: string) =>
    !isRunningSession(sessionId) &&
    (state.permissions.some((permission) => permission.sessionID === sessionId) ||
      state.questions.some((question) => question.sessionID === sessionId));
  const runningSessions = () => state.sessions.filter((session) => isRunningSession(session.id));
  const attentionSessions = () =>
    state.sessions.filter(
      (session) => !isRunningSession(session.id) && isSessionNeedingAttention(session.id)
    );
  const recentOtherSessions = () =>
    state.sessions.filter(
      (session) =>
        !isRunningSession(session.id) && !isSessionNeedingAttention(session.id)
    );
  const surfacedOtherSessions = () => recentOtherSessions().slice(0, MAX_SURFACED_OTHER_SESSIONS);
  const overflowOtherSessions = () => recentOtherSessions().slice(MAX_SURFACED_OTHER_SESSIONS);
  const surfacedSessions = () => [
    ...runningSessions(),
    ...attentionSessions(),
    ...surfacedOtherSessions(),
  ];
  const visibleSessions = () => {
    if (showOtherSessions()) return [...surfacedSessions(), ...overflowOtherSessions()];
    return surfacedSessions();
  };

  createEffect(() => {
    setShowOtherSessions(!props.focusRunningSessions);
  });

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

  return (
    <div ref={containerRef} class="session-list-view" tabindex="-1" onKeyDown={handleKeydown}>
      <Show
        when={state.sessions.length > 0}
        fallback={<div class="session-empty">No sessions yet</div>}
      >
        <Show when={runningSessions().length > 0}>
          <For each={runningSessions()}>
            {(session, index) => (
              <SessionListItem
                session={session}
                itemIndex={() => index()}
                focusedIndex={focusedIndex}
                setFocusedIndex={setFocusedIndex}
                now={now}
              />
            )}
          </For>
        </Show>
        <Show when={attentionSessions().length > 0}>
          <For each={attentionSessions()}>
            {(session, index) => (
              <SessionListItem
                session={session}
                itemIndex={() => runningSessions().length + index()}
                focusedIndex={focusedIndex}
                setFocusedIndex={setFocusedIndex}
                now={now}
              />
            )}
          </For>
        </Show>
        <Show when={surfacedOtherSessions().length > 0}>
          <For each={surfacedOtherSessions()}>
            {(session, index) => (
              <SessionListItem
                session={session}
                itemIndex={() => runningSessions().length + attentionSessions().length + index()}
                focusedIndex={focusedIndex}
                setFocusedIndex={setFocusedIndex}
                now={now}
              />
            )}
          </For>
        </Show>
        <Show when={overflowOtherSessions().length > 0}>
            <button
              type="button"
              class="session-list-section-toggle"
              onClick={() => setShowOtherSessions((value) => !value)}
            >
              <span class="session-list-section-title">Other sessions</span>
              <span class="session-list-section-count">{overflowOtherSessions().length}</span>
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                class={`session-list-section-chevron ${showOtherSessions() ? 'expanded' : ''}`}
                aria-hidden="true"
              >
                <path d="M5.5 3.5L10 8l-4.5 4.5-.7-.7L8.6 8 4.8 4.2z" />
              </svg>
            </button>
            <Show when={showOtherSessions()}>
              <For each={overflowOtherSessions()}>
                {(session, index) => (
                  <SessionListItem
                    session={session}
                    itemIndex={() => surfacedSessions().length + index()}
                    focusedIndex={focusedIndex}
                    setFocusedIndex={setFocusedIndex}
                    now={now}
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
}) {
  const isActive = () => props.session.id === state.activeSessionId;
  const isFocused = () => props.focusedIndex() === props.itemIndex();
  const status = () => state.sessionStatus[props.session.id];
  const hasPermissionRequest = () =>
    state.permissions.some((permission) => permission.sessionID === props.session.id);
  const hasQuestionRequest = () =>
    state.questions.some((question) => question.sessionID === props.session.id);
  const isRunning = () => isRunningSession(props.session.id);
  const needsAttention = () => !isRunning() && (hasPermissionRequest() || hasQuestionRequest());
  const isNewlyCompleted = () =>
    !isRunning() && !needsAttention() && isSessionUnread(props.session.id, props.session.time.updated);
  const indicatorClass = () => {
    if (isRunning()) return 'is-running';
    if (needsAttention()) return 'is-attention';
    return 'is-completed';
  };
  const indicatorTitle = () => {
    if (isRunning()) return status()?.type === 'retry' ? 'Retrying' : 'Running';
    if (hasPermissionRequest() && hasQuestionRequest()) return 'Attention needed';
    if (hasPermissionRequest()) return 'Permission request pending';
    if (hasQuestionRequest()) return 'Attention needed';
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
          when={isRunning() || needsAttention() || isNewlyCompleted()}
          fallback={<span class="session-item-indicator-spacer" />}
        >
          <span
            class={`session-item-indicator ${indicatorClass()}`}
            title={indicatorTitle()}
            aria-label={indicatorTitle()}
          />
        </Show>
        <div class="session-item-content">
          <span class="session-item-title">{props.session.title || 'Untitled'}</span>
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
        <span class="session-item-age" title={new Date(props.session.time.updated).toLocaleString()}>
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
  const label = () =>
    `${props.count} running session${props.count === 1 ? '' : 's'}`;

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

function isRunningSession(sessionId: string) {
  if (hasPendingSessionPrompt(sessionId)) return false;
  const type = state.sessionStatus[sessionId]?.type;
  return type === 'busy' || type === 'retry';
}

function hasPendingSessionPrompt(sessionId: string) {
  return (
    state.permissions.some((permission) => permission.sessionID === sessionId) ||
    state.questions.some((question) => question.sessionID === sessionId)
  );
}
