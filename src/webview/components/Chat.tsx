import { state } from "../lib/state"
import { createSignal, Show, For } from "solid-js"
import { selectSession, createSession, deleteSession } from "../hooks/useOpenCode"
import { MessageList } from "./MessageList"
import { ChatInput } from "./ChatInput"
import { ContextBar } from "./ContextBar"
import { PermissionPrompt } from "./PermissionPrompt"
import { TodoList } from "./TodoList"

export function Chat() {
  const [showSessions, setShowSessions] = createSignal(false)

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b border-vscode-border px-2 py-1.5">
        <button
          class="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs hover:bg-vscode-hover"
          onClick={() => setShowSessions(!showSessions())}
        >
          <span class="truncate max-w-[160px]" title={activeTitle()}>
            {activeTitle()}
          </span>
          <svg class="h-3 w-3 text-vscode-muted" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.5 6l3.5 4 3.5-4z" />
          </svg>
        </button>
        <div class="flex items-center gap-1">
          <button
            class="rounded p-1 text-vscode-muted hover:bg-vscode-hover hover:text-vscode-fg"
            onClick={() => createSession()}
            title="New session"
          >
            <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
            </svg>
          </button>
        </div>
      </div>

      <Show when={showSessions()}>
        <SessionOverlay onSelect={() => setShowSessions(false)} />
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

  function activeTitle() {
    if (!state.activeSessionId) return "New chat"
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    return session?.title || "New chat"
  }
}

function SessionOverlay(props: { onSelect: () => void }) {
  return (
    <div class="border-b border-vscode-border bg-vscode-card max-h-[200px] overflow-y-auto">
      <For each={state.sessions}>
        {(session) => (
          <div
            class={`flex w-full items-center justify-between px-3 py-1.5 text-xs hover:bg-vscode-hover cursor-pointer ${
              session.id === state.activeSessionId ? "bg-vscode-hover" : ""
            }`}
            onClick={() => {
              selectSession(session.id)
              props.onSelect()
            }}
          >
            <span class="truncate">{session.title || "Untitled"}</span>
            <button
              class="ml-2 rounded p-0.5 text-vscode-muted hover:text-vscode-error"
              onClick={(e) => {
                e.stopPropagation()
                deleteSession(session.id)
              }}
            >
              <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
              </svg>
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
