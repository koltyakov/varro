import { Show } from "solid-js"
import { useOpenCode } from "./hooks/useOpenCode"
import { state, error, setError } from "./lib/state"
import { Chat } from "./components/Chat"
import { ServerStatus } from "./components/ServerStatus"

export function App() {
  useOpenCode()

  return (
    <div class="flex h-full min-h-0 flex-col bg-vscode-sidebar text-[14px] text-vscode-fg">
      <Show
        when={state.serverStatus.state === "running"}
        fallback={<ServerStatus />}
      >
        <Chat />
      </Show>
      <Show when={error()}>
        <div class="flex items-start justify-between gap-2 border-t border-vscode-border bg-vscode-card px-3 py-2 text-xs text-vscode-error">
          <span class="break-words">{error()}</span>
          <button
            class="shrink-0 rounded px-1 text-vscode-muted hover:text-vscode-fg"
            onClick={() => setError(null)}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      </Show>
    </div>
  )
}
