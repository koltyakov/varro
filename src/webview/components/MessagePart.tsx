import { Show, createMemo, createSignal } from "solid-js"
import { state } from "../lib/state"
import { formatDuration, formatNumber, getAssistantDuration, getAssistantTotalTokens } from "../lib/message-metrics"
import type { AssistantMessage, Part, StepFinishPart, SubtaskPart } from "../types"
import { MarkdownRenderer } from "./MarkdownRenderer"
import { ToolCall } from "./ToolCall"

export function MessagePart(props: {
  part: Part
  messageInfo?: AssistantMessage
  subtaskRun?: AssistantMessage
}) {
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
          <div class="my-2 flex items-center gap-2 border-l-2 border-vscode-accent/40 bg-vscode-accent/5 px-3 py-1.5 text-[12px] text-vscode-muted">
            <svg class="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1.5a.5.5 0 01.5.5v1.05A5 5 0 0113 8a.5.5 0 01-1 0 4 4 0 10-4 4 .5.5 0 010 1 5 5 0 01-.5-9.95V2a.5.5 0 01.5-.5z" />
            </svg>
            <span>Handing off to</span>
            <span class="font-medium text-vscode-fg">{part.name}</span>
          </div>
        )
      case "patch":
        return (
          <div class="my-2 flex items-center gap-2 border-l-2 border-vscode-success/50 bg-vscode-success/5 px-3 py-1.5 text-[12px]">
            <svg class="h-3 w-3 shrink-0 text-vscode-success" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
            </svg>
            <span class="text-vscode-muted">Applied patch to</span>
            <span class="font-medium text-vscode-fg">{part.files.length} file{part.files.length === 1 ? "" : "s"}</span>
          </div>
        )
      case "retry":
        return (
          <div class="my-2 border-l-2 border-vscode-warning/50 bg-vscode-warning/5 px-3 py-1.5 text-[12px] text-vscode-warning">
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
          <div class="my-1 text-[11px] italic text-vscode-muted/50">
            Context compacted ({part.auto ? "auto" : "manual"})
            <Show when={part.overflow}> after overflow</Show>
          </div>
        )
      case "subtask":
        return <SubtaskBlock part={part} run={props.subtaskRun} />
      case "step-finish":
        return <StepFinishBlock part={part} />
      case "file":
        return (
          <div class="my-1 inline-flex items-center gap-1.5 border border-vscode-border bg-vscode-card px-2 py-0.5 text-[11px] text-vscode-muted">
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
        class="flex items-center gap-1.5 px-1 py-0.5 text-[11px] italic text-vscode-muted/60 transition-colors hover:text-vscode-muted"
        onClick={() => setExpanded(!expanded())}
      >
        <svg
          class={`h-3 w-3 transition-transform ${expanded() ? "rotate-90" : ""}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
        Thinking
      </button>
      <Show when={expanded()}>
        <div class="mt-1.5 whitespace-pre-wrap border-l-2 border-vscode-border bg-vscode-card/50 p-3 text-[11px] italic leading-relaxed text-vscode-muted animate-fade-in">
          {props.text}
        </div>
      </Show>
    </div>
  )
}

function SubtaskBlock(props: { part: SubtaskPart; run?: AssistantMessage }) {
  const run = () => props.run
  const selectedModel = createMemo(() => {
    if (run()) {
      const provider = state.providers.find((item) => item.id === run()!.providerID)
      const model = provider?.models[run()!.modelID]
      return `${provider?.name || run()!.providerID} / ${model?.name || run()!.modelID}`
    }

    if (props.part.model) {
      const provider = state.providers.find((item) => item.id === props.part.model!.providerID)
      const model = provider?.models[props.part.model!.modelID]
      return `${provider?.name || props.part.model!.providerID} / ${model?.name || props.part.model!.modelID}`
    }

    return null
  })

  return (
    <div class="my-2 border-l-2 border-vscode-border px-3 py-1.5 text-[12px]">
      <div class="flex items-center gap-1.5 font-medium text-vscode-fg">
        <div class="h-1.5 w-1.5 bg-vscode-accent" />
        {props.part.description}
      </div>
      <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-vscode-muted">
        <span>Agent: {props.part.agent}</span>
        <Show when={selectedModel()}>
          <span>Model: {selectedModel()}</span>
        </Show>
        <Show when={props.part.command}>
          <span>Command: {props.part.command}</span>
        </Show>
        <Show when={run()}>
          <span>Time: {formatDuration(getAssistantDuration(run()!))}</span>
        </Show>
        <Show when={run()}>
          <span>Tokens: {formatNumber(getAssistantTotalTokens(run()!))}</span>
        </Show>
        <Show when={run()}>
          <span>In: {formatNumber(run()!.tokens.input)}</span>
        </Show>
        <Show when={run() && run()!.tokens.output > 0}>
          <span>Out: {formatNumber(run()!.tokens.output)}</span>
        </Show>
      </div>
    </div>
  )
}

function StepFinishBlock(props: { part: StepFinishPart }) {
  const totalTokens =
    props.part.tokens.total ||
    props.part.tokens.input +
      props.part.tokens.output +
      props.part.tokens.reasoning +
      (props.part.tokens.cache.read || 0) +
      (props.part.tokens.cache.write || 0)

  return (
    <div class="my-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-vscode-border/50 bg-vscode-card/30 px-3 py-1.5 text-[11px] text-vscode-muted">
      <span class="font-medium text-vscode-fg">Step finished</span>
      <span>Reason: {props.part.reason}</span>
      <span>In: {formatNumber(props.part.tokens.input)}</span>
      <span>Out: {formatNumber(props.part.tokens.output)}</span>
      <Show when={props.part.tokens.reasoning > 0}>
        <span>Thinking: {formatNumber(props.part.tokens.reasoning)}</span>
      </Show>
      <span>Total: {formatNumber(totalTokens)}</span>
    </div>
  )
}
