import { Show, createSignal } from "solid-js"
import type { Part } from "../types"
import { MarkdownRenderer } from "./MarkdownRenderer"
import { ToolCall } from "./ToolCall"

export function MessagePart(props: { part: Part }) {
  const part = () => props.part

  return (
    <Show
      when={visible(part())}
    >
      {(() => {
        const p = part()
        switch (p.type) {
          case "text":
            return (
              <div class="markdown-content">
                <MarkdownRenderer content={p.text} />
              </div>
            )
          case "tool":
            return <ToolCall part={p} />
          case "step-start":
            return (
              <div class="my-1 border-l-2 border-vscode-accent pl-2 text-xs text-vscode-muted">
                Step started
              </div>
            )
          case "step-finish":
            return (
              <div class="my-1 border-l-2 border-vscode-success pl-2 text-xs text-vscode-muted">
                Step completed
              </div>
            )
          case "reasoning":
            return <ReasoningBlock text={p.text} />
          case "agent":
            return (
              <div class="my-0.5 text-xs text-vscode-muted">
                Using agent: <span class="font-medium text-vscode-fg">{p.name}</span>
              </div>
            )
          case "patch":
            return (
              <div class="my-1 text-xs text-vscode-muted">
                Applied patch: {p.files.join(", ")}
              </div>
            )
          case "snapshot":
            return null
          case "retry":
            return (
              <div class="my-1 text-xs text-vscode-warning">
                Retry attempt {p.attempt}
              </div>
            )
          case "compaction":
            return (
              <div class="my-1 text-xs text-vscode-muted italic">
                Context compacted ({p.auto ? "auto" : "manual"})
              </div>
            )
          case "subtask":
            return (
              <div class="my-1 rounded border border-vscode-border bg-vscode-card px-2 py-1 text-xs">
                <div class="font-medium">{p.description}</div>
                <div class="mt-0.5 text-vscode-muted">Agent: {p.agent}</div>
              </div>
            )
          default:
            return null
        }
      })()}
    </Show>
  )
}

function visible(p: Part): boolean {
  if (p.type === "text" && (p as any).ignored) return false
  if (p.type === "text" && (p as any).synthetic) return true
  if (p.type === "text" && !(p as any).text?.trim()) return false
  return true
}

function ReasoningBlock(props: { text: string }) {
  const [expanded, setExpanded] = createSignal(false)

  return (
    <div class="my-1">
      <button
        class="flex items-center gap-1 text-xs text-vscode-muted hover:text-vscode-fg"
        onClick={() => setExpanded(!expanded())}
      >
        <svg
          class={`h-3 w-3 transition-transform ${expanded() ? "rotate-90" : ""}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
        Reasoning
      </button>
      <Show when={expanded()}>
        <div class="mt-1 rounded border border-vscode-border bg-vscode-card p-2 text-xs text-vscode-muted">
          {props.text}
        </div>
      </Show>
    </div>
  )
}
