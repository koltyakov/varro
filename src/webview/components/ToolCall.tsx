import { Show, createSignal } from "solid-js"
import type { ToolPart } from "../types"

export function ToolCall(props: { part: ToolPart }) {
  const [expanded, setExpanded] = createSignal(false)
  const tool = () => props.part
  const state = () => tool().state

  const statusColor = () => {
    switch (state().status) {
      case "pending":
        return "text-vscode-muted"
      case "running":
        return "text-vscode-accent"
      case "completed":
        return "text-vscode-success"
      case "error":
        return "text-vscode-error"
    }
  }

  const statusIcon = () => {
    switch (state().status) {
      case "pending":
        return "○"
      case "running":
        return "◐"
      case "completed":
        return "✓"
      case "error":
        return "✕"
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
      if (typeof input[k] === "string") return String(input[k]).slice(0, 120)
    }
    return ""
  }

  return (
    <div class="my-1 rounded border border-vscode-border bg-vscode-card">
      <button
        class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-vscode-hover"
        onClick={() => setExpanded(!expanded())}
      >
        <span class={`shrink-0 text-sm ${statusColor()} ${state().status === "running" ? "animate-pulse" : ""}`}>
          {statusIcon()}
        </span>
        <span class="shrink-0 font-medium">{title()}</span>
        <Show when={preview()}>
          <span class="min-w-0 flex-1 truncate font-mono text-vscode-muted">
            {preview()}
          </span>
        </Show>
        <Show when={state().status === "completed"}>
          {(() => {
            const s = state() as import("../types").ToolStateCompleted
            return (
              <span class="shrink-0 text-vscode-muted">
                {formatDuration(s.time.end - s.time.start)}
              </span>
            )
          })()}
        </Show>
        <svg
          class={`h-3 w-3 shrink-0 text-vscode-muted transition-transform ${expanded() ? "rotate-90" : ""}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
      </button>

      <Show when={expanded()}>
        <div class="border-t border-vscode-border px-2 py-1.5 text-xs">
          <Show when={Object.keys(state().input || {}).length > 0}>
            <div class="mb-1.5">
              <div class="mb-0.5 text-[10px] uppercase tracking-wider text-vscode-muted">
                Input
              </div>
              <pre class="overflow-x-auto whitespace-pre-wrap rounded bg-vscode-input-bg p-1.5 font-mono text-[11px] text-vscode-fg">
                {JSON.stringify(state().input, null, 2)}
              </pre>
            </div>
          </Show>
          <Show when={state().status === "completed"}>
            <div>
              <div class="mb-0.5 text-[10px] uppercase tracking-wider text-vscode-muted">
                Output
              </div>
              <pre class="max-h-[240px] overflow-auto whitespace-pre-wrap rounded bg-vscode-input-bg p-1.5 font-mono text-[11px]">
                {(state() as any).output || "(empty)"}
              </pre>
            </div>
          </Show>
          <Show when={state().status === "error"}>
            <div class="rounded bg-vscode-input-bg p-1.5 text-vscode-error">
              {(state() as any).error}
            </div>
          </Show>
          <Show when={state().status === "running"}>
            <div class="text-vscode-muted">Running…</div>
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
