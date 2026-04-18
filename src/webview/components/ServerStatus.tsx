import { Show } from "solid-js"
import { state } from "../lib/state"

export function ServerStatus() {
  const status = () => state.serverStatus

  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-10 text-center">
      <Show when={status().state === "starting"}>
        <div class="flex items-center gap-1.5">
          <span class="h-1.5 w-1.5 rounded-full bg-vscode-accent animate-pulse-soft" />
          <span class="h-1.5 w-1.5 rounded-full bg-vscode-accent animate-pulse-soft" style={{ "animation-delay": "0.3s" }} />
          <span class="h-1.5 w-1.5 rounded-full bg-vscode-accent animate-pulse-soft" style={{ "animation-delay": "0.6s" }} />
        </div>
        <div>
          <p class="text-[13px] font-medium text-vscode-fg">Starting OpenCode...</p>
          <p class="mt-1 text-[12px] text-vscode-muted">Spawning the local server</p>
        </div>
      </Show>

      <Show when={status().state === "stopped"}>
        <div class="h-1.5 w-1.5 rounded-full bg-vscode-muted/30" />
        <div>
          <p class="text-[13px] font-medium text-vscode-fg">Server not running</p>
          <p class="mt-1 text-[12px] text-vscode-muted">Waiting to connect...</p>
        </div>
      </Show>

      <Show when={status().state === "error"}>
        <div class="h-1.5 w-1.5 rounded-full bg-vscode-error" />
        <div class="max-w-[300px] rounded-lg border border-vscode-border/30 bg-vscode-card px-4 py-3 text-left">
          <p class="text-[13px] font-medium text-vscode-error">OpenCode unavailable</p>
          <p class="mt-1.5 break-words text-[12px] leading-[1.4] text-vscode-muted">
            {(status() as { state: "error"; message: string }).message}
          </p>
          <div class="mt-3 border-t border-vscode-border/20 pt-2.5 text-[11px] text-vscode-muted">
            <p>Install: <code class="rounded bg-vscode-bg/50 px-1 py-px font-mono text-vscode-fg">npm i -g opencode-ai</code></p>
            <p class="mt-0.5">Or run: <code class="rounded bg-vscode-bg/50 px-1 py-px font-mono text-vscode-fg">opencode serve</code></p>
          </div>
        </div>
      </Show>
    </div>
  )
}
