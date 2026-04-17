import { Show, For } from "solid-js"
import type { Message as MessageType, Part } from "../types"
import { MessagePart } from "./MessagePart"

export function Message(props: { info: MessageType; parts: Part[] }) {
  const isUser = () => props.info.role === "user"

  return (
    <div class={`py-1 ${isUser() ? "pl-8 pr-1" : "px-1"}`}>
      <div class="flex items-center gap-2 pb-1.5">
        <span class={`text-xs font-semibold uppercase tracking-[0.08em] ${isUser() ? "text-vscode-accent" : "text-vscode-fg"}`}>
          {isUser() ? "You" : roleLabel(props.info)}
        </span>
        <Show when={!isUser() && (props.info as any).cost > 0}>
          <span class="text-[11px] text-vscode-muted">
            ${((props.info as any).cost as number).toFixed(4)}
          </span>
        </Show>
        <Show when={(props.info as any).error?.data?.message}>
          <span class="text-[11px] text-vscode-error">
            {((props.info as any).error?.data?.message as string) || "error"}
          </span>
        </Show>
      </div>
      <div
        class={`min-w-0 ${
          isUser()
            ? "rounded-md border border-vscode-border bg-vscode-card px-4 py-3"
            : "rounded-sm border border-transparent px-3 py-2"
        }`}
      >
        <Show when={isUser()}>
          <UserMessageContent parts={props.parts} />
        </Show>
        <Show when={!isUser()}>
          <AssistantMessageContent parts={props.parts} />
        </Show>
      </div>
    </div>
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
  const text = () =>
    props.parts
      .filter((p): p is Part & { type: "text" } => p.type === "text")
      .map((p) => p.text)
      .join("\n\n")

  return (
    <div class="whitespace-pre-wrap break-words text-[14px] leading-7">
      {text() || <span class="text-vscode-muted">(no content)</span>}
    </div>
  )
}

function AssistantMessageContent(props: { parts: Part[] }) {
  return (
    <div class="space-y-2 text-[14px] leading-7">
      <For each={props.parts}>
        {(part) => <MessagePart part={part} />}
      </For>
    </div>
  )
}
