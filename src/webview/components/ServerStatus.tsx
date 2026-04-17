import { Show } from "solid-js"
import { state } from "../lib/state"

export function ServerStatus() {
  const status = () => state.serverStatus

  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-4">
      <Show
        when={status().state === "error"}
        fallback={
          <div class="text-center text-vscode-muted">
            <svg class="mx-auto mb-2 h-8 w-8 opacity-50" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1zM9 2H4v13h8V5.5L9 2z" />
              <path d="M5 7h6v1H5V7zm0 2h6v1H5V9zm0 2h4v1H5v-1z" />
            </svg>
            <p class="text-sm">Connect to OpenCode to get started</p>
            <Show when={status().state === "stopped"}>
              <p class="mt-1 text-xs opacity-70">
                Run <code class="rounded bg-vscode-input-bg px-1 py-0.5">opencode serve</code> or
                check your settings
              </p>
            </Show>
          </div>
        }
      >
        <div class="text-center">
          <svg class="mx-auto mb-2 h-8 w-8 text-vscode-error" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.56 1h.88l6.54 12.26-.44.74H1.44l-.42-.74L7.56 1z" />
            <path d="M8 5v4H7V5h1zm0 6V9H7v2h1z" />
          </svg>
          <p class="text-sm text-vscode-error">
            {(status() as { state: "error"; message: string }).message}
          </p>
        </div>
      </Show>
    </div>
  )
}
