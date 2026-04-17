import { Show, For } from "solid-js"
import type { Message as MessageType, Part } from "../types"
import { MessagePart } from "./MessagePart"

export function Message(props: { info: MessageType; parts: Part[] }) {
  const isUser = () => props.info.role === "user"

  return (
    <div class={`group msg ${isUser() ? "msg-user" : "msg-assistant"} animate-fade-in`}>
      <div class="flex items-start gap-3">
        <div class={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold ${isUser() ? "bg-vscode-accent/20 text-vscode-accent" : "bg-vscode-card text-vscode-fg ring-1 ring-vscode-border"}`}>
          {isUser() ? "U" : "A"}
        </div>
        <div class="min-w-0 flex-1">
          <div class="mb-1 flex items-center gap-2">
            <span class={`text-[11px] font-semibold ${isUser() ? "text-vscode-accent" : "text-vscode-fg"}`}>
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
          <Show when={!isUser()}>
            <AssistantMessageContent parts={props.parts} />
          </Show>
          <Show when={(props.info as any).error?.data?.message}>
            <div class="mt-2 rounded-md border border-vscode-error/30 bg-vscode-error/10 px-3 py-1.5 text-xs text-vscode-error">
              {((props.info as any).error?.data?.message as string) || "error"}
            </div>
          </Show>
        </div>
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
    <div class="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-vscode-fg">
      {text() || <span class="text-vscode-muted italic">(no content)</span>}
    </div>
  )
}

function AssistantMessageContent(props: { parts: Part[] }) {
  return (
    <div class="space-y-1.5 text-[13px] leading-relaxed">
      <For each={props.parts}>
        {(part) => <MessagePart part={part} />}
      </For>
    </div>
  )
}
