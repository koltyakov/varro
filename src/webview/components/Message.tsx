import { Show, For } from "solid-js"
import type { Message as MessageType, Part } from "../types"
import { MessagePart } from "./MessagePart"
import { MarkdownRenderer } from "./MarkdownRenderer"

export function Message(props: { info: MessageType; parts: Part[] }) {
  const isUser = () => props.info.role === "user"
  const time = () => {
    const d = new Date(props.info.time.created)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  return (
    <div
      class={`group mx-1 my-2 rounded-lg ${
        isUser() ? "bg-vscode-input-bg" : "bg-transparent"
      }`}
    >
      <div class="flex items-start gap-2 px-2.5 py-2">
        <div
          class={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold ${
            isUser()
              ? "bg-vscode-accent text-white"
              : "bg-vscode-button-bg text-vscode-button-fg"
          }`}
        >
          {isUser() ? "U" : "AI"}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium">
              {isUser() ? "You" : "Assistant"}
            </span>
            <span class="text-[10px] text-vscode-muted">{time()}</span>
            <Show when={!isUser() && props.info.role === "assistant" && props.info.cost > 0}>
              <span class="text-[10px] text-vscode-muted">
                ${(props.info as any).cost.toFixed(4)}
              </span>
            </Show>
          </div>
          <div class="mt-0.5">
            <Show when={isUser()}>
              <UserMessageContent parts={props.parts} />
            </Show>
            <Show when={!isUser()}>
              <AssistantMessageContent parts={props.parts} info={props.info} />
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

function UserMessageContent(props: { parts: Part[] }) {
  const text = () =>
    props.parts
      .filter((p): p is Part & { type: "text" } => p.type === "text")
      .map((p) => p.text)
      .join("\n")

  return (
    <div class="text-sm whitespace-pre-wrap break-words">
      {text() || "(no content)"}
    </div>
  )
}

function AssistantMessageContent(props: { parts: Part[]; info: MessageType }) {
  return (
    <div class="text-sm">
      <For each={props.parts}>
        {(part) => <MessagePart part={part} />}
      </For>
    </div>
  )
}
