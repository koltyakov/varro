import { Show } from "solid-js"
import { state } from "../lib/state"

export function ServerStatus() {
  const status = () => state.serverStatus

  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-5 px-8 py-12 text-center">
      <Show when={status().state === "starting"}>
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full bg-vscode-accent animate-pulse-soft" />
          <span class="h-1.5 w-1.5 rounded-full bg-vscode-accent animate-pulse-soft" style={{ "animation-delay": "0.3s" }} />
          <span class="h-1.5 w-1.5 rounded-full bg-vscode-accent animate-pulse-soft" style={{ "animation-delay": "0.6s" }} />
        </div>
        <div>
          <p class="text-[14px] font-semibold text-vscode-fg">Starting OpenCode...</p>
          <p class="mt-1 text-[12px] text-vscode-muted">Spawning the local server</p>
        </div>
      </Show>

      <Show when={status().state === "stopped"}>
        <div class="h-2 w-2 rounded-full bg-vscode-muted/40" />
        <div>
          <p class="text-[14px] font-semibold text-vscode-fg">Server not running</p>
          <p class="mt-1 text-[12px] text-vscode-muted">
            Waiting to connect...
          </p>
        </div>
      </Show>

      <Show when={status().state === "error"}>
        <div class="h-2 w-2 rounded-full bg-vscode-error" />
        <div class="max-w-[340px] rounded-lg border border-vscode-border/40 bg-vscode-card px-5 py-4 text-left">
          <p class="text-[14px] font-semibold text-vscode-error">OpenCode unavailable</p>
          <p class="mt-2 break-words text-[12px] leading-relaxed text-vscode-muted">
            {(status() as { state: "error"; message: string }).message}
          </p>
          <div class="mt-4 border-t border-vscode-border/30 pt-3 text-[11px] leading-relaxed text-vscode-muted">
            <p>Install: <code class="rounded bg-vscode-sidebar/80 px-1.5 py-0.5 font-mono text-vscode-fg">npm i -g opencode-ai</code></p>
            <p class="mt-1">Or run: <code class="rounded bg-vscode-sidebar/80 px-1.5 py-0.5 font-mono text-vscode-fg">opencode serve</code></p>
          </div>
        </div>
      </Show>
    </div>
  )
}
