import { Show } from "solid-js"
import { state } from "../lib/state"

export function ServerStatus() {
  const status = () => state.serverStatus

  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-6 px-8 py-10 text-center">
      <Show when={status().state === "starting"}>
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-full bg-vscode-accent animate-pulse-soft" />
          <span class="h-2 w-2 rounded-full bg-vscode-accent animate-pulse-soft" style={{ "animation-delay": "0.3s" }} />
          <span class="h-2 w-2 rounded-full bg-vscode-accent animate-pulse-soft" style={{ "animation-delay": "0.6s" }} />
        </div>
        <div>
          <p class="text-[15px] font-semibold text-vscode-fg">Starting OpenCode…</p>
          <p class="mt-1 text-[12px] text-vscode-muted">Spawning the local server</p>
        </div>
      </Show>

      <Show when={status().state === "stopped"}>
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-vscode-card ring-1 ring-vscode-border">
          <div class="h-2.5 w-2.5 rounded-full bg-vscode-muted/50" />
        </div>
        <div>
          <p class="text-[15px] font-semibold text-vscode-fg">Server not running</p>
          <p class="mt-1 text-[12px] text-vscode-muted">
            Waiting to connect…
          </p>
        </div>
      </Show>

      <Show when={status().state === "error"}>
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-vscode-error/10 ring-1 ring-vscode-error/30">
          <div class="h-2.5 w-2.5 rounded-full bg-vscode-error" />
        </div>
        <div class="max-w-[340px] rounded-xl border border-vscode-border/60 bg-vscode-card px-5 py-4">
          <p class="text-[15px] font-semibold text-vscode-error">OpenCode unavailable</p>
          <p class="mt-2 break-words text-[12px] text-vscode-muted leading-relaxed">
            {(status() as { state: "error"; message: string }).message}
          </p>
          <div class="mt-4 rounded-lg bg-vscode-input-bg/60 px-3 py-2.5 text-[11px] text-vscode-muted leading-relaxed">
            <p>Install: <code class="rounded bg-vscode-sidebar px-1 py-0.5 font-mono text-vscode-fg">npm i -g opencode-ai</code></p>
            <p class="mt-1">Or run: <code class="rounded bg-vscode-sidebar px-1 py-0.5 font-mono text-vscode-fg">opencode serve</code></p>
          </div>
        </div>
      </Show>
    </div>
  )
}
