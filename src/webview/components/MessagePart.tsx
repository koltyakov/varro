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
          <div class="markdown-content text-[13px] leading-relaxed">
            <MarkdownRenderer content={(part as any).text} />
          </div>
        )
      case "tool":
        return <ToolCall part={part} />
      case "reasoning":
        return <ReasoningBlock text={part.text} />
      case "agent":
        return (
          <div class="my-1 flex items-center gap-2 rounded-md border border-vscode-border/40 bg-vscode-card/40 px-2.5 py-1 text-[12px] text-vscode-muted">
            <svg class="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1.5a.5.5 0 01.5.5v1.05A5 5 0 0113 8a.5.5 0 01-1 0 4 4 0 10-4 4 .5.5 0 010 1 5 5 0 01-.5-9.95V2a.5.5 0 01.5-.5z" />
            </svg>
            <span>Handing off to</span>
            <span class="font-medium text-vscode-fg">{part.name}</span>
          </div>
        )
      case "patch":
        return (
          <div class="my-1 flex items-center gap-2 rounded-md border border-vscode-success/20 bg-vscode-success/5 px-2.5 py-1.5 text-[12px]">
            <svg class="h-3 w-3 shrink-0 text-vscode-success" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
            </svg>
            <span class="text-vscode-muted">Applied patch to </span>
            <span class="font-medium text-vscode-fg">{part.files.length} file{part.files.length === 1 ? "" : "s"}</span>
          </div>
        )
      case "retry":
        return (
          <div class="my-1 rounded-md border border-vscode-warning/30 bg-vscode-warning/8 px-2.5 py-1.5 text-[12px] text-vscode-warning">
            <div class="flex items-center gap-1.5">
              <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 2a6 6 0 106 6 1 1 0 012 0 8 8 0 11-3.5-6.6V1a1 1 0 012 0v3.5a1 1 0 01-1 1H10a1 1 0 010-2h1.3A5.98 5.98 0 008 2z" />
              </svg>
              <span>Retry attempt {part.attempt}</span>
            </div>
            <Show when={part.error?.data?.message}>
              <div class="mt-1 text-[11px] opacity-70">{part.error.data.message}</div>
            </Show>
          </div>
        )
      case "compaction":
        return (
          <div class="my-1 text-[11px] italic text-vscode-muted/60">
            Context compacted ({part.auto ? "auto" : "manual"})
          </div>
        )
      case "subtask":
        return (
          <div class="my-1 rounded-md border border-vscode-border/50 bg-vscode-card/50 px-2.5 py-2 text-[12px]">
            <div class="flex items-center gap-1.5 font-medium text-vscode-fg">
              <div class="h-1.5 w-1.5 rounded-full bg-vscode-accent" />
              {part.description}
            </div>
            <div class="mt-1 text-[11px] text-vscode-muted">Agent: {part.agent}</div>
          </div>
        )
      case "file":
        return (
          <div class="my-1 inline-flex items-center gap-1.5 rounded-md border border-vscode-border/50 bg-vscode-card/50 px-2 py-0.5 text-[11px] text-vscode-muted">
            <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
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
        class="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] italic text-vscode-muted/60 transition-colors hover:text-vscode-muted hover:bg-vscode-hover/50"
        onClick={() => setExpanded(!expanded())}
      >
        <svg
          class={`h-3 w-3 transition-transform duration-150 ${expanded() ? "rotate-90" : ""}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
        Thinking
      </button>
      <Show when={expanded()}>
        <div class="mt-1.5 whitespace-pre-wrap rounded-md border border-vscode-border/40 bg-vscode-card/40 p-2.5 text-[11px] italic leading-relaxed text-vscode-muted animate-fade-in">
          {props.text}
        </div>
      </Show>
    </div>
  )
}
