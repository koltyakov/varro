import { state, showSessionPicker, setShowSessionPicker } from "../lib/state"
import { Show, For } from "solid-js"
import { selectSession, createSession, deleteSession, shareSession } from "../hooks/useOpenCode"
import { MessageList } from "./MessageList"
import { ChatInput } from "./ChatInput"
import { ContextBar } from "./ContextBar"
import { PermissionPrompt } from "./PermissionPrompt"
import { TodoList } from "./TodoList"

export function Chat() {
  const activeTitle = () => {
    if (!state.activeSessionId) return "New chat"
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    return session?.title || "New chat"
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex items-center justify-between border-b border-vscode-border/40 bg-vscode-sidebar/95 px-2 py-1.5 backdrop-blur">
        <button
          class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors hover:bg-vscode-hover"
          onClick={() => setShowSessionPicker(!showSessionPicker())}
          title="Switch session"
        >
          <svg class="h-3.5 w-3.5 shrink-0 text-vscode-muted" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 2h12v2H2V2zm0 5h12v2H2V7zm0 5h8v2H2v-2z" />
          </svg>
          <div class="min-w-0 flex-1 text-left">
            <div class="truncate font-medium" title={activeTitle()}>
              {activeTitle()}
            </div>
          </div>
          <svg
            class={`h-3 w-3 shrink-0 text-vscode-muted/50 transition-transform duration-150 ${showSessionPicker() ? "rotate-180" : ""}`}
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M4.5 6l3.5 4 3.5-4z" />
          </svg>
        </button>
        <div class="ml-1 flex shrink-0 items-center gap-0.5">
          <Show when={state.activeSessionId}>
            <button
              class="rounded-md p-1.5 text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
              onClick={shareSession}
              title="Share session"
            >
              <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
                <path d="M12 3a2 2 0 100 4 2 2 0 000-4zM8.5 5a3.5 3.5 0 116.166 2.24l-4.86 2.83a3.5 3.5 0 010 1.86l4.86 2.83a3.5 3.5 0 11-.5.87l-4.86-2.83a3.5 3.5 0 110-4.54l4.86-2.83A3.5 3.5 0 018.5 5zM5 6.5a2 2 0 100 4 2 2 0 000-4zM12 11a2 2 0 100 4 2 2 0 000-4z" />
              </svg>
            </button>
          </Show>
          <button
            class="rounded-md p-1.5 text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
            onClick={() => createSession()}
            title="New session"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
            </svg>
          </button>
        </div>
      </div>

      <Show when={showSessionPicker()}>
        <SessionOverlay />
      </Show>

      <Show when={state.todos.length > 0}>
        <TodoList />
      </Show>

      <MessageList />

      <For each={state.permissions}>
        {(perm) => <PermissionPrompt permission={perm} />}
      </For>

      <ContextBar />
      <ChatInput />
    </div>
  )
}

function SessionOverlay() {
  return (
    <div class="max-h-[260px] overflow-y-auto border-b border-vscode-border/40 bg-vscode-card/95 px-1 py-1 animate-fade-in">
      <Show
        when={state.sessions.length > 0}
        fallback={
          <div class="px-3 py-6 text-center text-[12px] text-vscode-muted">No previous sessions</div>
        }
      >
        <For each={state.sessions}>
          {(session) => (
            <div
              class={`group flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-[13px] transition-colors hover:bg-vscode-hover ${
                session.id === state.activeSessionId ? "bg-vscode-hover" : ""
              }`}
              onClick={() => {
                selectSession(session.id)
                setShowSessionPicker(false)
              }}
            >
              <div class="min-w-0 flex-1">
                <div class="truncate font-medium">{session.title || "Untitled"}</div>
                <Show when={session.summary}>
                  <div class="mt-0.5 text-[11px] text-vscode-muted">
                    {session.summary?.files ?? 0} files · <span class="text-vscode-success">+{session.summary?.additions ?? 0}</span> <span class="text-vscode-error">-{session.summary?.deletions ?? 0}</span>
                  </div>
                </Show>
              </div>
              <button
                class="shrink-0 rounded p-1 text-vscode-muted opacity-0 transition-all hover:text-vscode-error group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteSession(session.id)
                }}
                title="Delete session"
              >
                <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M10 3h3v1h-1v9a2 2 0 01-2 2H6a2 2 0 01-2-2V4H3V3h3V2a1 1 0 011-1h2a1 1 0 011 1v1zM5 4v9a1 1 0 001 1h4a1 1 0 001-1V4H5zm2 2h1v6H7V6zm2 0h1v6H9V6z" />
                </svg>
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}
