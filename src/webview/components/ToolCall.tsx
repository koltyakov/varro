import { Show, createSignal } from "solid-js"
import type { ToolPart } from "../types"

export function ToolCall(props: { part: ToolPart }) {
  const [expanded, setExpanded] = createSignal(false)
  const tool = () => props.part
  const state = () => tool().state
  const statusLabel = () => {
    switch (state().status) {
      case "pending":
        return "Pending"
      case "running":
        return "Running"
      case "completed":
        return "Done"
      case "error":
        return "Error"
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
    <div class={`my-2 rounded-lg border transition-colors ${
      state().status === "running"
        ? "border-vscode-accent/25 bg-vscode-accent/4"
        : state().status === "error"
          ? "border-vscode-error/25 bg-vscode-error/4"
          : "border-vscode-border/35 bg-vscode-card/12"
    }`}>
      <button
        class="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-vscode-hover/30"
        onClick={() => setExpanded(!expanded())}
      >
        <span class={`mt-1 h-2 w-2 shrink-0 rounded-full ${statusDot()}`} />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-[13px] font-medium text-vscode-fg">{title()}</span>
            <span class="rounded border border-vscode-border/35 bg-vscode-bg/30 px-1.5 py-0.5 text-[10px] text-vscode-muted">
              {statusLabel()}
            </span>
            <Show when={state().status === "completed"}>
              {(() => {
                const s = state() as import("../types").ToolStateCompleted
                return (
                  <span class="text-[11px] text-vscode-muted">
                    {formatDuration(s.time.end - s.time.start)}
                  </span>
                )
              })()}
            </Show>
          </div>
          <Show when={preview()}>
            <div class="mt-0.5 truncate font-mono text-[11px] leading-5 text-vscode-muted">
              {preview()}
            </div>
          </Show>
        </div>
        <svg
          class={`mt-1 h-3 w-3 shrink-0 text-vscode-muted/50 transition-transform ${expanded() ? "rotate-90" : ""}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
      </button>

      <Show when={expanded()}>
        <div class="border-t border-vscode-border/25 px-3 py-3 text-[11px] animate-fade-in">
          <Show when={Object.keys(state().input || {}).length > 0}>
            <div class="mb-2.5">
              <div class="mb-1 text-[10px] font-medium uppercase tracking-wide text-vscode-muted">
                Input
              </div>
              <pre class="overflow-x-auto whitespace-pre-wrap rounded-md border border-vscode-border/30 bg-vscode-bg/30 px-3 py-2 font-mono text-[11px] leading-6 text-vscode-fg">
                {JSON.stringify(state().input, null, 2)}
              </pre>
            </div>
          </Show>
          <Show when={state().status === "completed"}>
            <div>
              <div class="mb-1 text-[10px] font-medium uppercase tracking-wide text-vscode-muted">
                Output
              </div>
              <pre class="max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md border border-vscode-border/30 bg-vscode-bg/30 px-3 py-2 font-mono text-[11px] leading-6 text-vscode-fg">
                {(state() as any).output || "(empty)"}
              </pre>
            </div>
          </Show>
          <Show when={state().status === "error"}>
            <div class="rounded-md border border-vscode-error/25 bg-vscode-error/8 px-3 py-2 leading-6 text-vscode-error">
              {(state() as any).error}
            </div>
          </Show>
          <Show when={state().status === "running"}>
            <div class="flex items-center gap-2 rounded-md border border-vscode-accent/15 bg-vscode-accent/4 px-3 py-2 text-[11px] text-vscode-muted">
              <span class="h-1.5 w-1.5 rounded-full bg-vscode-accent animate-pulse-soft" />
              Running...
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
