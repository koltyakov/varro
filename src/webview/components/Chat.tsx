import { state, showSessionPicker, setShowSessionPicker, showSettings } from '../lib/state';
import { Show, For } from 'solid-js';
import { selectSession, createSession, deleteSession, shareSession } from '../hooks/useOpenCode';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { PermissionPrompt } from './PermissionPrompt';
import { TodoList } from './TodoList';
import { SettingsPanel } from './SettingsPanel';

export function Chat() {
  const activeTitle = () => {
    if (!state.activeSessionId) return 'New Chat';
    const session = state.sessions.find((s) => s.id === state.activeSessionId);
    return session?.title || 'New Chat';
  };

  return (
    <div class="interactive-session">
      <div class="flex h-[36px] shrink-0 items-center justify-between px-3">
        <button
          class="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-vscode-muted transition-colors hover:bg-vscode-toolbar-hover hover:text-vscode-fg"
          onClick={() => setShowSessionPicker(!showSessionPicker())}
          title="Switch session"
        >
          <svg class="h-[14px] w-[14px] shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.2A5.8 5.8 0 1113.8 8 5.8 5.8 0 018 2.2zM7.4 4v4.4l3.2 1.9.6-1-2.6-1.5V4H7.4z" />
          </svg>
          <span class="max-w-[180px] truncate">{activeTitle()}</span>
          <svg
            class={`h-3 w-3 shrink-0 opacity-50 transition-transform ${showSessionPicker() ? 'rotate-180' : ''}`}
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M4.5 6l3.5 4 3.5-4z" />
          </svg>
        </button>

        <div class="flex items-center">
          <Show when={state.activeSessionId}>
            <button
              class="flex h-[26px] w-[26px] items-center justify-center rounded text-vscode-muted transition-colors hover:bg-vscode-toolbar-hover hover:text-vscode-fg"
              onClick={shareSession}
              title="Share session"
            >
              <svg class="h-[14px] w-[14px]" viewBox="0 0 16 16" fill="currentColor">
                <path d="M12 3a2 2 0 100 4 2 2 0 000-4zM8.5 5a3.5 3.5 0 116.166 2.24l-4.86 2.83a3.5 3.5 0 010 1.86l4.86 2.83a3.5 3.5 0 11-.5.87l-4.86-2.83a3.5 3.5 0 110-4.54l4.86-2.83A3.5 3.5 0 018.5 5zM5 6.5a2 2 0 100 4 2 2 0 000-4zM12 11a2 2 0 100 4 2 2 0 000-4z" />
              </svg>
            </button>
          </Show>
          <button
            class="flex h-[26px] w-[26px] items-center justify-center rounded text-vscode-muted transition-colors hover:bg-vscode-toolbar-hover hover:text-vscode-fg"
            onClick={() => createSession()}
            title="New chat"
          >
            <svg class="h-[14px] w-[14px]" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
            </svg>
          </button>
        </div>
      </div>

      <Show when={showSessionPicker()}>
        <SessionOverlay />
      </Show>

      <Show when={showSettings()}>
        <SettingsPanel />
      </Show>

      <Show when={state.todos.length > 0}>
        <TodoList />
      </Show>

      <MessageList />

      <For each={state.permissions}>{(perm) => <PermissionPrompt permission={perm} />}</For>

      <ChatInput />
    </div>
  );
}

function SessionOverlay() {
  return (
    <div class="absolute inset-x-0 top-[36px] z-40 max-h-[400px] overflow-hidden border-b border-vscode-request-border/30 bg-vscode-sidebar shadow-[0_4px_16px_rgba(0,0,0,0.3)] animate-fade-in">
      <div class="flex h-[32px] items-center justify-between px-4">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-vscode-muted">
          Sessions
        </span>
        <div class="flex items-center gap-0.5">
          <button
            class="flex h-[22px] w-[22px] items-center justify-center rounded text-vscode-muted transition-colors hover:bg-vscode-toolbar-hover hover:text-vscode-fg"
            onClick={() => createSession()}
            title="New session"
          >
            <svg class="h-[14px] w-[14px]" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
            </svg>
          </button>
        </div>
      </div>

      <div class="max-h-[368px] overflow-y-auto">
        <Show
          when={state.sessions.length > 0}
          fallback={
            <div class="px-4 py-8 text-center text-[12px] text-vscode-muted">
              No previous sessions
            </div>
          }
        >
          <For each={state.sessions}>
            {(session) => {
              const isActive = () => session.id === state.activeSessionId;
              return (
                <div
                  class={`group flex w-full cursor-pointer items-start gap-2.5 px-4 py-2 transition-colors hover:bg-vscode-hover ${
                    isActive() ? 'bg-vscode-hover/50' : ''
                  }`}
                  onClick={() => {
                    selectSession(session.id);
                    setShowSessionPicker(false);
                  }}
                >
                  <div class="mt-[5px] flex h-[10px] w-[10px] shrink-0 items-center justify-center">
                    <Show
                      when={isActive()}
                      fallback={
                        <span class="block h-[8px] w-[8px] rounded-full bg-vscode-accent" />
                      }
                    >
                      <span class="block h-[8px] w-[8px] rounded-full border-[1.5px] border-vscode-muted" />
                    </Show>
                  </div>

                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[13px] text-vscode-fg">
                      {session.title || 'Untitled'}
                    </div>
                    <div class="mt-0.5 truncate text-[12px] text-vscode-muted">
                      <Show when={session.summary} fallback={formatTimeAgo(session.time.updated)}>
                        {session.summary!.files} file{session.summary!.files !== 1 ? 's' : ''} ·{' '}
                        <span class="diff-lines-added">+{session.summary!.additions}</span>{' '}
                        <span class="diff-lines-removed">-{session.summary!.deletions}</span>
                      </Show>
                    </div>
                  </div>

                  <button
                    class="mt-0.5 shrink-0 rounded p-1 text-vscode-muted opacity-0 transition-all hover:bg-vscode-error/10 hover:text-vscode-error group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSession(session.id);
                    }}
                    title="Delete session"
                  >
                    <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M10 3h3v1h-1v9a2 2 0 01-2 2H6a2 2 0 01-2-2V4H3V3h3V2a1 1 0 011-1h2a1 1 0 011 1v1zM5 4v9a1 1 0 001 1h4a1 1 0 001-1V4H5zm2 2h1v6H7V6zm2 0h1v6H9V6z" />
                    </svg>
                  </button>
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes !== 1 ? 's' : ''} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
  return new Date(timestamp).toLocaleDateString();
}
