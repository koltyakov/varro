import {
  state,
  showSessionPicker,
  setShowSessionPicker,
  showSettings,
  isSessionUnread,
} from '../lib/state';
import { Show, For, createSignal, onMount } from 'solid-js';
import { selectSession, createSession, deleteSession } from '../hooks/useOpenCode';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { SettingsPanel } from './SettingsPanel';

export function Chat() {
  const activeTitle = () => {
    if (!state.activeSessionId) return 'New Chat';
    const session = state.sessions.find((s) => s.id === state.activeSessionId);
    return session?.title || 'New Chat';
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
                  onClick={() => setShowSessionPicker(true)}
                  title="Back to sessions"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
                  </svg>
                </button>
                <span class="chat-header-title-text">{activeTitle()}</span>
              </div>
              <div class="chat-header-actions">
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

      <Show when={!showSessionPicker()} fallback={<SessionListView />}>
        <Show when={showSettings()}>
          <SettingsPanel />
        </Show>

        <MessageList />

        <ChatInput />
      </Show>
    </div>
  );
}

function SessionListView() {
  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  // oxlint-disable-next-line no-unassigned-vars
  let containerRef: HTMLDivElement | undefined;

  function handleKeydown(e: KeyboardEvent) {
    const sessions = state.sessions;
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
        <For each={state.sessions}>
          {(session, index) => {
            const isActive = () => session.id === state.activeSessionId;
            const isFocused = () => focusedIndex() === index();
            const status = () => state.sessionStatus[session.id];
            const isRunning = () => {
              const t = status()?.type;
              return t === 'busy' || t === 'retry';
            };
            const isUnread = () =>
              !isRunning() && isSessionUnread(session.id, session.time.updated);
            const indicatorTitle = () => {
              if (isRunning()) return status()?.type === 'retry' ? 'Retrying' : 'Running';
              if (isUnread()) return 'Updated since last viewed';
              return '';
            };
            return (
              <div
                class={`session-item ${isActive() ? 'active' : ''} ${isFocused() ? 'keyboard-focus' : ''}`}
                onMouseEnter={() => setFocusedIndex(index())}
              >
                <button
                  type="button"
                  class="session-item-main"
                  onClick={() => {
                    selectSession(session.id);
                    setShowSessionPicker(false);
                  }}
                >
                  <Show
                    when={isRunning() || isUnread()}
                    fallback={<span class="session-item-indicator-spacer" />}
                  >
                    <span
                      class={`session-item-indicator ${isRunning() ? 'is-running' : 'is-unread'}`}
                      title={indicatorTitle()}
                      aria-label={indicatorTitle()}
                    />
                  </Show>
                  <div class="session-item-content">
                    <span class="session-item-title">{session.title || 'Untitled'}</span>
                    <span class="session-item-meta">
                      <Show when={session.summary} fallback={formatTimeAgo(session.time.updated)}>
                        {session.summary!.files} file{session.summary!.files !== 1 ? 's' : ''}
                        {' · '}
                        <span class="diff-lines-added">+{session.summary!.additions}</span>{' '}
                        <span class="diff-lines-removed">-{session.summary!.deletions}</span>
                      </Show>
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  class="session-item-archive"
                  onClick={() => {
                    deleteSession(session.id);
                  }}
                  title="Archive"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M14.5 1h-13a.5.5 0 00-.5.5V4h14V1.5a.5.5 0 00-.5-.5zM1 5v9.5a.5.5 0 00.5.5h13a.5.5 0 00.5-.5V5H1zm5 3h4v1H6V8z" />
                  </svg>
                </button>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
