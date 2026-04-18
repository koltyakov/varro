import { For, Show, createMemo, createResource } from "solid-js"
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
      <div class="flex items-start gap-3">
        <div
          class={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center border text-[11px] font-semibold ${
            isUser()
              ? "border-vscode-accent/35 bg-vscode-accent/8 text-vscode-accent"
              : "border-vscode-border/60 bg-vscode-card/60 text-vscode-muted"
          }`}
        >
          {isUser() ? "U" : "A"}
        </div>
        <div class="min-w-0 flex-1">
          <div class="mb-2.5 flex items-center gap-2">
            <span class={`text-[11px] font-medium uppercase tracking-[0.08em] ${isUser() ? "text-vscode-accent" : "text-vscode-muted"}`}>
              {isUser() ? "You" : roleLabel(props.info)}
            </span>
            <Show when={!isUser() && (props.info as any).cost > 0}>
              <span class="text-[10px] text-vscode-muted">
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
            <div class="mt-3 border border-vscode-error/35 bg-vscode-error/8 px-3 py-2.5 text-[12px] leading-6 text-vscode-error">
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
  return (
    <div class="border border-vscode-accent/20 bg-vscode-accent/5 px-4 py-3 space-y-3 text-[14px] leading-7 text-vscode-fg">
      <For each={props.parts.filter((part) => part.type === "text" || part.type === "file")}>
        {(part) => {
          if (part.type === "text") {
            return <div class="whitespace-pre-wrap break-words">{part.text}</div>
          }
          return <MessagePart part={part} />
        }}
      </For>
      <Show when={!props.parts.some((part) => part.type === "text" || part.type === "file")}>
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
    <div class="border border-vscode-border/50 bg-vscode-bg/25 px-4 py-3 space-y-3 text-[14px] leading-7">
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

  return (
    <div class="mt-3 space-y-2.5">
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
    </div>
  )
}

function MetaChip(props: { label: string; value: string }) {
  return (
    <span class="inline-flex max-w-full items-center gap-1.5 border border-vscode-border/50 bg-vscode-card/50 px-2 py-1 text-vscode-muted">
      <span class="uppercase tracking-[0.08em] text-vscode-muted/70 shrink-0">{props.label}</span>
      <span class="text-vscode-fg truncate">{props.value}</span>
    </span>
  )
}

function formatVariantLabel(variant: string) {
  return variant
    .split(/[-_]/g)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}
