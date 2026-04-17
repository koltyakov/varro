import { Show } from "solid-js"
import { state } from "../lib/state"

export function ServerStatus() {
  const status = () => state.serverStatus

  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-5 px-8 py-12 text-center">
      <Show when={status().state === "starting"}>
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 bg-vscode-accent animate-pulse-soft" />
          <span class="h-1.5 w-1.5 bg-vscode-accent animate-pulse-soft" style={{ "animation-delay": "0.3s" }} />
          <span class="h-1.5 w-1.5 bg-vscode-accent animate-pulse-soft" style={{ "animation-delay": "0.6s" }} />
        </div>
        <div>
          <p class="text-sm font-semibold text-vscode-fg">Starting OpenCode…</p>
          <p class="mt-1 text-[12px] text-vscode-muted">Spawning the local server</p>
        </div>
      </Show>

      <Show when={status().state === "stopped"}>
        <div class="h-2 w-2 bg-vscode-muted/50" />
        <div>
          <p class="text-sm font-semibold text-vscode-fg">Server not running</p>
          <p class="mt-1 text-[12px] text-vscode-muted">
            Waiting to connect…
          </p>
        </div>
      </Show>

      <Show when={status().state === "error"}>
        <div class="h-2 w-2 bg-vscode-error" />
        <div class="max-w-[340px] border border-vscode-border bg-vscode-card px-5 py-4 text-left">
          <p class="text-sm font-semibold text-vscode-error">OpenCode unavailable</p>
          <p class="mt-2 break-words text-[12px] text-vscode-muted leading-relaxed">
            {(status() as { state: "error"; message: string }).message}
          </p>
          <div class="mt-4 border-t border-vscode-border pt-3 text-[11px] text-vscode-muted leading-relaxed">
            <p>Install: <code class="bg-vscode-sidebar px-1 py-0.5 font-mono text-vscode-fg">npm i -g opencode-ai</code></p>
            <p class="mt-1">Or run: <code class="bg-vscode-sidebar px-1 py-0.5 font-mono text-vscode-fg">opencode serve</code></p>
          </div>
        </div>
      </Show>
    </div>
  )
}
