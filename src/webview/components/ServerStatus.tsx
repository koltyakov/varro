import { Show } from "solid-js"
import { state } from "../lib/state"

export function ServerStatus() {
  const status = () => state.serverStatus

  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-10 text-center">
      <Show when={status().state === "starting"}>
        <Spinner />
        <div>
          <p class="text-lg font-semibold text-vscode-fg">Starting OpenCode…</p>
          <p class="mt-1 text-sm text-vscode-muted">Spawning the local server</p>
        </div>
      </Show>

      <Show when={status().state === "stopped"}>
        <Dot class="bg-vscode-muted" />
        <div>
          <p class="text-lg font-semibold text-vscode-fg">Server not running</p>
          <p class="mt-1 text-sm text-vscode-muted">
            Waiting to connect…
          </p>
        </div>
      </Show>

      <Show when={status().state === "error"}>
        <Dot class="bg-vscode-error" />
        <div class="max-w-[360px] rounded-md border border-vscode-border bg-vscode-card px-5 py-4">
          <p class="text-lg font-semibold text-vscode-error">OpenCode unavailable</p>
          <p class="mt-2 break-words text-sm text-vscode-muted">
            {(status() as { state: "error"; message: string }).message}
          </p>
          <p class="mt-4 text-[12px] text-vscode-muted">
            Install the CLI with{" "}
            <code class="rounded bg-vscode-input-bg px-1 py-0.5 text-vscode-fg">
              npm i -g opencode-ai
            </code>
            , or start a server manually with{" "}
            <code class="rounded bg-vscode-input-bg px-1 py-0.5 text-vscode-fg">
              opencode serve
            </code>
            .
          </p>
        </div>
      </Show>
    </div>
  )
}

function Spinner() {
  return (
    <div class="flex items-center gap-1.5">
      <span class="h-2.5 w-2.5 animate-pulse rounded-full bg-vscode-accent" />
      <span
        class="h-2.5 w-2.5 animate-pulse rounded-full bg-vscode-accent"
        style={{ "animation-delay": "0.2s" }}
      />
      <span
        class="h-2.5 w-2.5 animate-pulse rounded-full bg-vscode-accent"
        style={{ "animation-delay": "0.4s" }}
      />
    </div>
  )
}

function Dot(props: { class: string }) {
  return <span class={`h-3 w-3 rounded-full ${props.class}`} />
}
