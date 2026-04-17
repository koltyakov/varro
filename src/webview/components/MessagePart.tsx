import { Show, createSignal } from "solid-js"
import type { Part } from "../types"
import { MarkdownRenderer } from "./MarkdownRenderer"
import { ToolCall } from "./ToolCall"

export function MessagePart(props: { part: Part }) {
  const p = () => props.part

  const render = () => {
    const part = p()
    switch (part.type) {
      case "text":
        return (
          <div class="markdown-content text-[14px] leading-7">
            <MarkdownRenderer content={(part as any).text} />
          </div>
        )
      case "tool":
        return <ToolCall part={part} />
      case "reasoning":
        return <ReasoningBlock text={part.text} />
      case "agent":
        return (
          <div class="my-1 flex items-center gap-2 text-sm text-vscode-muted">
            <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1.5a.5.5 0 01.5.5v1.05A5 5 0 0113 8a.5.5 0 01-1 0 4 4 0 10-4 4 .5.5 0 010 1 5 5 0 01-.5-9.95V2a.5.5 0 01.5-.5z" />
            </svg>
            <span>Handing off to</span>
            <span class="font-medium text-vscode-fg">{part.name}</span>
          </div>
        )
      case "patch":
        return (
          <div class="my-1 flex items-center gap-2 text-sm text-vscode-muted">
            <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
            </svg>
            <span>Applied patch to {part.files.length} file{part.files.length === 1 ? "" : "s"}</span>
          </div>
        )
      case "retry":
        return (
          <div class="my-1 rounded-md border border-vscode-warning/40 bg-vscode-warning/10 px-3 py-2 text-sm text-vscode-warning">
            Retry attempt {part.attempt}
            <Show when={part.error?.data?.message}>
              <div class="mt-1 text-[12px] opacity-80">{part.error.data.message}</div>
            </Show>
          </div>
        )
      case "compaction":
        return (
          <div class="my-1 text-[12px] italic text-vscode-muted">
            Context compacted ({part.auto ? "auto" : "manual"})
          </div>
        )
      case "subtask":
        return (
          <div class="my-1 rounded-md border border-vscode-border bg-vscode-card px-3 py-2 text-sm">
            <div class="flex items-center gap-1 font-medium">
              <span class="h-1.5 w-1.5 rounded-full bg-vscode-accent" />
              {part.description}
            </div>
            <div class="mt-1 text-[12px] text-vscode-muted">Agent: {part.agent}</div>
          </div>
        )
      case "file":
        return (
          <div class="my-1 inline-flex items-center gap-1.5 rounded-md border border-vscode-border bg-vscode-card px-2 py-1 text-[12px] text-vscode-muted">
            <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
            </svg>
            {part.filename || "(file)"}
          </div>
        )
      default:
        return null
    }
  }

  return <>{render()}</>
}

function ReasoningBlock(props: { text: string }) {
  const [expanded, setExpanded] = createSignal(false)

  return (
    <div class="my-1">
      <button
        class="flex items-center gap-1.5 text-[12px] italic text-vscode-muted hover:text-vscode-fg"
        onClick={() => setExpanded(!expanded())}
      >
        <svg
          class={`h-3.5 w-3.5 transition-transform ${expanded() ? "rotate-90" : ""}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
        Thinking
      </button>
      <Show when={expanded()}>
        <div class="mt-2 whitespace-pre-wrap rounded-md border border-vscode-border bg-vscode-card p-3 text-[12px] italic text-vscode-muted">
          {props.text}
        </div>
      </Show>
    </div>
  )
}
