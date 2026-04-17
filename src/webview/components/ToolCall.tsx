import { Show, createSignal } from "solid-js"
import type { ToolPart } from "../types"
import { MarkdownRenderer } from "./MarkdownRenderer"

export function ToolCall(props: { part: ToolPart }) {
  const [expanded, setExpanded] = createSignal(false)
  const tool = () => props.part
  const state = () => tool().state

  const statusIcon = () => {
    switch (state().status) {
      case "pending":
        return "○"
      case "running":
        return "◐"
      case "completed":
        return "●"
      case "error":
        return "✕"
    }
  }

  const statusColor = () => {
    switch (state().status) {
      case "pending":
        return "text-vscode-muted"
      case "running":
        return "text-vscode-accent animate-pulse"
      case "completed":
        return "text-vscode-success"
      case "error":
        return "text-vscode-error"
    }
  }

  const title = () => {
    const s = state()
    if (s.status === "completed") return s.title
    if (s.status === "running") return s.title || tool().tool
    return tool().tool
  }

  return (
    <div class="my-1 rounded border border-vscode-border bg-vscode-card">
      <button
        class="flex w-full items-center gap-2 px-2 py-1.5 text-xs hover:bg-vscode-hover"
        onClick={() => setExpanded(!expanded())}
      >
        <span class={`text-sm ${statusColor()}`}>{statusIcon()}</span>
        <span class="font-medium">{title()}</span>
          <Show when={state().status === "completed"}>
            {(() => {
              const s = state() as import("../types").ToolStateCompleted
              return (
                <span class="ml-auto text-vscode-muted">
                  {formatDuration(s.time.end - s.time.start)}
                </span>
              )
            })()}
          </Show>
        <svg
          class={`h-3 w-3 text-vscode-muted transition-transform ${expanded() ? "rotate-90" : ""}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
      </button>

      <Show when={expanded()}>
        <div class="border-t border-vscode-border px-2 py-1.5">
          <Show when={state().status === "completed"}>
            <div class="max-h-[200px] overflow-y-auto text-xs">
              <MarkdownRenderer content={(state() as any).output || ""} />
            </div>
          </Show>
          <Show when={state().status === "error"}>
            <div class="text-xs text-vscode-error">{(state() as any).error}</div>
          </Show>
          <Show when={state().status === "running"}>
            <div class="text-xs text-vscode-muted">Running...</div>
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
