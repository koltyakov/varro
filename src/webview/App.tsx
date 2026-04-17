import { Show } from "solid-js"
import { useOpenCode } from "./hooks/useOpenCode"
import { state, error } from "./lib/state"
import { Chat } from "./components/Chat"
import { ServerStatus } from "./components/ServerStatus"

export function App() {
  useOpenCode()

  return (
    <div class="flex h-full flex-col bg-vscode-sidebar">
      <Show
        when={state.serverStatus.state === "running" || state.serverStatus.state === "starting"}
        fallback={<ServerStatus />}
      >
        <Show when={state.serverStatus.state === "running"}>
          <Chat />
        </Show>
        <Show when={state.serverStatus.state === "starting"}>
          <div class="flex flex-1 items-center justify-center">
            <div class="text-vscode-muted">Starting OpenCode server...</div>
          </div>
        </Show>
      </Show>
      <Show when={error()}>
        <div class="border-t border-vscode-border px-3 py-2 text-xs text-vscode-error">
          {error()}
        </div>
      </Show>
    </div>
  )
}
