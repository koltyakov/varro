import { Show } from "solid-js"
import { useOpenCode } from "./hooks/useOpenCode"
import { state, error, setError } from "./lib/state"
import { Chat } from "./components/Chat"
import { ServerStatus } from "./components/ServerStatus"

export function App() {
  useOpenCode()

  return (
    <div class="flex h-full min-h-0 flex-col bg-vscode-sidebar text-[13px] text-vscode-fg">
      <Show
        when={state.serverStatus.state === "running"}
        fallback={<ServerStatus />}
      >
        <Chat />
      </Show>
      <Show when={error()}>
        <div class="flex items-start justify-between gap-2 border-t border-vscode-error/40 bg-vscode-error/8 px-4 py-2 text-[11px] text-vscode-error">
          <span class="break-words leading-relaxed">{error()}</span>
          <button
            class="shrink-0 px-1 text-vscode-error/60 transition-colors hover:text-vscode-error"
            onClick={() => setError(null)}
            title="Dismiss"
          >
            <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
            </svg>
          </button>
        </div>
      </Show>
    </div>
  )
}
