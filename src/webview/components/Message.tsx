import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { state } from "../lib/state"
import { client } from "../lib/client"
import {
  formatDuration,
  formatNumber,
  getAssistantDuration,
  getAssistantTotalTokens,
  getContextWindow,
  getDescendantAssistants,
  getStepFinishParts,
  isAssistantMessage,
  sumAssistantTokens,
} from "../lib/message-metrics"
import type { AssistantMessage, FileDiff, Message as MessageType, Part } from "../types"
import { DiffView } from "./DiffView"
import { MessagePart } from "./MessagePart"

export function Message(props: { info: MessageType; parts: Part[] }) {
  const isUser = () => props.info.role === "user"
  const assistant = () => (isAssistantMessage(props.info) ? props.info : null)

  const subagentMessages = createMemo(() => {
    const info = assistant()
    if (!info) return []
    return getDescendantAssistants(info.id, state.messages).filter((entry) => entry.info.mode === "subagent")
  })

  const subagentTokens = createMemo(() => sumAssistantTokens(subagentMessages().map((entry) => entry.info)))
  const subagentDuration = createMemo(() =>
    subagentMessages().reduce((total, entry) => total + (getAssistantDuration(entry.info) || 0), 0),
  )
  const stepParts = createMemo(() => getStepFinishParts(props.parts))

  const [diffs] = createResource(
    () => {
      const info = assistant()
      if (!info?.time.completed) return null
      return `${info.sessionID}:${info.id}`
    },
    async (key) => {
      const [sessionID, messageID] = key.split(":")
      return client.session.diff(sessionID, messageID).catch(() => [] as FileDiff[])
    },
  )

  return (
    <article class="animate-fade-in">
      <div class="flex items-start gap-3.5">
        <div
          class={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
            isUser()
              ? "bg-vscode-accent/20 text-vscode-accent"
              : "bg-vscode-muted/15 text-vscode-muted"
          }`}
        >
          {isUser() ? "U" : "A"}
        </div>
        <div class="min-w-0 flex-1">
          <div class="mb-2.5 flex items-center gap-2">
            <span class={`text-[13px] font-semibold ${isUser() ? "text-vscode-accent" : "text-vscode-fg"}`}>
              {isUser() ? "You" : roleLabel(props.info)}
            </span>
            <Show when={!isUser() && (props.info as any).cost > 0}>
              <span class="text-[12px] text-vscode-muted/60">
                ${(Number((props.info as any).cost)).toFixed(4)}
              </span>
            </Show>
          </div>
          <Show when={isUser()}>
            <UserMessageContent parts={props.parts} />
          </Show>
          <Show when={!isUser() && assistant()}>
            <AssistantMessageContent info={assistant()!} parts={props.parts} />
          </Show>
          <Show when={(props.info as any).error?.data?.message}>
            <div class="mt-2.5 rounded-md border border-vscode-error/30 bg-vscode-error/6 px-3.5 py-2.5 text-[13px] leading-relaxed text-vscode-error">
              {((props.info as any).error?.data?.message as string) || "error"}
            </div>
          </Show>
          <Show when={assistant()}>
            <AssistantMeta
              info={assistant()!}
              stepCount={stepParts().length}
              subagentCount={subagentMessages().length}
              subagentTokens={subagentTokens()}
              subagentDuration={subagentDuration()}
              diffs={diffs() || []}
            />
          </Show>
        </div>
      </div>
    </article>
  )
}

function roleLabel(info: MessageType): string {
  const agent = (info as any).agent || (info as any).mode
  if (agent && agent !== "primary") return `${cap(agent)}`
  return "Assistant"
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function UserMessageContent(props: { parts: Part[] }) {
  const visibleParts = () => props.parts.filter(
    (p) => (p.type === "text" && !(p as any).text?.startsWith("[Working directory:") && !(p as any).text?.startsWith("[Selection from")) || p.type === "file"
  )
  return (
    <div class="rounded-xl bg-vscode-accent/[0.07] px-4 py-3.5 space-y-2.5 text-[14px] leading-relaxed text-vscode-fg">
      <For each={visibleParts()}>
        {(part) => {
          if (part.type === "text") {
            return <div class="whitespace-pre-wrap wrap-break-word">{(part as any).text}</div>
          }
          return <MessagePart part={part} />
        }}
      </For>
      <Show when={visibleParts().length === 0}>
        <span class="text-vscode-muted italic">(no content)</span>
      </Show>
    </div>
  )
}

function AssistantMessageContent(props: { info: AssistantMessage; parts: Part[] }) {
  let subtaskIndex = 0

  const childRuns = createMemo(() =>
    state.messages
      .filter(
        (entry): entry is { info: AssistantMessage; parts: Part[] } =>
          isAssistantMessage(entry.info) &&
          entry.info.parentID === props.info.id &&
          entry.info.mode === "subagent",
      )
      .sort((a, b) => a.info.time.created - b.info.time.created),
  )

  return (
    <div class="space-y-2 text-[14px] leading-relaxed text-vscode-fg">
      <For each={props.parts}>
        {(part) => {
          const matchedRun = part.type === "subtask" ? childRuns()[subtaskIndex++] : undefined
          return <MessagePart part={part} messageInfo={props.info} subtaskRun={matchedRun?.info} />
        }}
      </For>
    </div>
  )
}

function AssistantMeta(props: {
  info: AssistantMessage
  stepCount: number
  subagentCount: number
  subagentTokens: ReturnType<typeof sumAssistantTokens>
  subagentDuration: number
  diffs: FileDiff[]
}) {
  const [expanded, setExpanded] = createSignal(false)
  const contextWindow = createMemo(() => getContextWindow(props.info, state.providers))
  const taskDuration = () => getAssistantDuration(props.info)
  const totalTokens = () => getAssistantTotalTokens(props.info)
  const modelLabel = createMemo(() => {
    const provider = state.providers.find((item) => item.id === props.info.providerID)
    const model = provider?.models[props.info.modelID]
    const base = `${provider?.name || props.info.providerID} / ${model?.name || props.info.modelID}`
    return props.info.variant ? `${base} [${formatVariantLabel(props.info.variant)}]` : base
  })
  const diffSummary = createMemo(() =>
    props.diffs.reduce(
      (acc, diff) => {
        acc.additions += diff.additions
        acc.deletions += diff.deletions
        return acc
      },
      { additions: 0, deletions: 0 },
    ),
  )

  const compactSummary = createMemo(() => {
    const parts: string[] = []
    parts.push(`${formatNumber(totalTokens())} tok`)
    const dur = taskDuration()
    if (dur) parts.push(formatDuration(dur))
    if (props.stepCount > 0) parts.push(`${props.stepCount} step${props.stepCount !== 1 ? "s" : ""}`)
    if (props.diffs.length > 0) parts.push(`${props.diffs.length} file${props.diffs.length !== 1 ? "s" : ""} changed`)
    return parts.join(" · ")
  })

  return (
    <div class="mt-2.5 space-y-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        class="flex items-center gap-2 text-[12px] text-vscode-muted/60 hover:text-vscode-muted transition-colors cursor-pointer group"
      >
        <span class="truncate">{compactSummary()}</span>
        <span class="shrink-0 opacity-40 group-hover:opacity-80 transition-opacity select-none">
          {expanded() ? "▴" : "▾"}
        </span>
      </button>
      <Show when={expanded()}>
        <div class="flex flex-wrap gap-1.5 text-[11px]">
          <MetaChip label="Model" value={modelLabel()} />
          <MetaChip label="In" value={`${formatNumber(props.info.tokens.input)} tok`} />
          <MetaChip label="Out" value={`${formatNumber(props.info.tokens.output)} tok`} />
          <Show when={props.info.tokens.reasoning > 0}>
            <MetaChip label="Thinking" value={`${formatNumber(props.info.tokens.reasoning)} tok`} />
          </Show>
          <MetaChip label="Total" value={`${formatNumber(totalTokens())} tok`} />
          <Show when={taskDuration()}>
            <MetaChip label="Time" value={formatDuration(taskDuration())} />
          </Show>
          <Show when={contextWindow()}>
            <MetaChip
              label="Context"
              value={`${formatNumber(contextWindow()!.used)} / ${formatNumber(contextWindow()!.limit)} tok (${contextWindow()!.percent.toFixed(1)}%)`}
            />
          </Show>
          <Show when={props.stepCount > 0}>
            <MetaChip label="Steps" value={String(props.stepCount)} />
          </Show>
          <Show when={props.subagentCount > 0}>
            <MetaChip
              label="Subagents"
              value={`${props.subagentCount} · ${formatNumber(props.subagentTokens.total)} tok · ${formatDuration(props.subagentDuration)}`}
            />
          </Show>
          <Show when={props.diffs.length > 0}>
            <MetaChip
              label="Changed"
              value={`${props.diffs.length} files · +${formatNumber(diffSummary().additions)} / -${formatNumber(diffSummary().deletions)}`}
            />
          </Show>
        </div>
        <Show when={props.diffs.length > 0}>
          <DiffView diffs={props.diffs} />
        </Show>
      </Show>
    </div>
  )
}

function MetaChip(props: { label: string; value: string }) {
  return (
    <span class="inline-flex max-w-full items-center gap-1.5 rounded border border-vscode-border/40 bg-vscode-card/40 px-2 py-0.5 text-vscode-muted">
      <span class="uppercase tracking-wide text-vscode-muted/60 shrink-0 text-[10px]">{props.label}</span>
      <span class="text-vscode-fg truncate text-[11px]">{props.value}</span>
    </span>
  )
}

function formatVariantLabel(variant: string) {
  return variant
    .split(/[-_]/g)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}
