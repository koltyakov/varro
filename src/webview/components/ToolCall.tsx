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
    <div class={`my-3 border transition-colors ${
      state().status === "running"
        ? "border-vscode-accent/35 bg-vscode-accent/5"
        : state().status === "error"
          ? "border-vscode-error/35 bg-vscode-error/5"
          : "border-vscode-border/45 bg-vscode-card/18"
    }`}>
      <button
        class="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-vscode-hover/35"
        onClick={() => setExpanded(!expanded())}
      >
        <span class={`mt-1.5 h-2 w-2 shrink-0 ${statusDot()}`} />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[13px] font-medium text-vscode-fg">{title()}</span>
            <span class="border border-vscode-border/45 bg-vscode-bg/35 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-vscode-muted">
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
            <div class="mt-1 truncate font-mono text-[11px] leading-5 text-vscode-muted">
              {preview()}
            </div>
          </Show>
        </div>
        <svg
          class={`mt-1 h-3.5 w-3.5 shrink-0 text-vscode-muted/60 transition-transform ${expanded() ? "rotate-90" : ""}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
      </button>

      <Show when={expanded()}>
        <div class="border-t border-vscode-border/30 px-3 py-3 text-[11px] animate-fade-in">
          <Show when={Object.keys(state().input || {}).length > 0}>
            <div class="mb-3">
              <div class="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-vscode-muted">
                Input
              </div>
              <pre class="overflow-x-auto whitespace-pre-wrap border border-vscode-border/35 bg-vscode-bg/40 px-3 py-2.5 font-mono text-[11px] leading-6 text-vscode-fg">
                {JSON.stringify(state().input, null, 2)}
              </pre>
            </div>
          </Show>
          <Show when={state().status === "completed"}>
            <div>
              <div class="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-vscode-muted">
                Output
              </div>
              <pre class="max-h-[240px] overflow-auto whitespace-pre-wrap border border-vscode-border/35 bg-vscode-bg/40 px-3 py-2.5 font-mono text-[11px] leading-6 text-vscode-fg">
                {(state() as any).output || "(empty)"}
              </pre>
            </div>
          </Show>
          <Show when={state().status === "error"}>
            <div class="border border-vscode-error/30 bg-vscode-error/10 px-3 py-2.5 leading-6 text-vscode-error">
              {(state() as any).error}
            </div>
          </Show>
          <Show when={state().status === "running"}>
            <div class="flex items-center gap-2 border border-vscode-accent/20 bg-vscode-accent/5 px-3 py-2 text-[11px] text-vscode-muted">
              <span class="h-1.5 w-1.5 bg-vscode-accent animate-pulse-soft" />
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
