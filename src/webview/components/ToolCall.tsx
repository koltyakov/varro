import { Show, createSignal } from "solid-js"
import type { ToolPart } from "../types"

export function ToolCall(props: { part: ToolPart }) {
  const [expanded, setExpanded] = createSignal(false)
  const tool = () => props.part
  const state = () => tool().state

  const statusColor = () => {
    switch (state().status) {
      case "pending":
        return "text-vscode-muted/60"
      case "running":
        return "text-vscode-accent"
      case "completed":
        return "text-vscode-success"
      case "error":
        return "text-vscode-error"
    }
  }

  const statusDot = () => {
    switch (state().status) {
      case "pending":
        return "bg-vscode-muted/40"
      case "running":
        return "bg-vscode-accent animate-pulse-soft"
      case "completed":
        return "bg-vscode-success"
      case "error":
        return "bg-vscode-error"
    }
  }

  const title = () => {
    const s = state()
    if (s.status === "completed") return s.title || tool().tool
    if (s.status === "running") return s.title || tool().tool
    return tool().tool
  }

  const preview = () => {
    const s = state()
    const input: any = s.input || {}
    const keys = ["file_path", "path", "command", "query", "pattern"]
    for (const k of keys) {
      if (typeof input[k] === "string") return String(input[k]).slice(0, 100)
    }
    return ""
  }

  return (
    <div class={`my-1 rounded-lg border transition-colors ${
      state().status === "running"
        ? "border-vscode-accent/30 bg-vscode-accent/5"
        : state().status === "error"
          ? "border-vscode-error/20 bg-vscode-error/5"
          : "border-vscode-border/50 bg-vscode-card/50"
    }`}>
      <button
        class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-vscode-hover/50"
        onClick={() => setExpanded(!expanded())}
      >
        <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot()}`} />
        <span class="shrink-0 font-medium text-vscode-fg">{title()}</span>
        <Show when={preview()}>
          <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-vscode-muted">
            {preview()}
          </span>
        </Show>
        <Show when={state().status === "completed"}>
          {(() => {
            const s = state() as import("../types").ToolStateCompleted
            return (
              <span class="shrink-0 text-[10px] text-vscode-muted">
                {formatDuration(s.time.end - s.time.start)}
              </span>
            )
          })()}
        </Show>
        <svg
          class={`h-3 w-3 shrink-0 text-vscode-muted/50 transition-transform duration-150 ${expanded() ? "rotate-90" : ""}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
      </button>

      <Show when={expanded()}>
        <div class="border-t border-vscode-border/40 px-2.5 py-2 text-[11px] animate-fade-in">
          <Show when={Object.keys(state().input || {}).length > 0}>
            <div class="mb-2">
              <div class="mb-1 text-[10px] font-medium uppercase tracking-wider text-vscode-muted">
                Input
              </div>
              <pre class="overflow-x-auto whitespace-pre-wrap rounded-md bg-vscode-input-bg/60 p-2 font-mono text-[11px] text-vscode-fg">
                {JSON.stringify(state().input, null, 2)}
              </pre>
            </div>
          </Show>
          <Show when={state().status === "completed"}>
            <div>
              <div class="mb-1 text-[10px] font-medium uppercase tracking-wider text-vscode-muted">
                Output
              </div>
              <pre class="max-h-[200px] overflow-auto whitespace-pre-wrap rounded-md bg-vscode-input-bg/60 p-2 font-mono text-[11px] text-vscode-fg">
                {(state() as any).output || "(empty)"}
              </pre>
            </div>
          </Show>
          <Show when={state().status === "error"}>
            <div class="rounded-md bg-vscode-error/10 p-2 text-vscode-error">
              {(state() as any).error}
            </div>
          </Show>
          <Show when={state().status === "running"}>
            <div class="flex items-center gap-1.5 text-vscode-muted">
              <span class="h-1 w-1 rounded-full bg-vscode-accent animate-pulse-soft" />
              Running…
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return ""
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
