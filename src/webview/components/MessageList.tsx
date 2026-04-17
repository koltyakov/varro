import { For, Show, createEffect } from "solid-js"
import { state, isLoading } from "../lib/state"
import { Message } from "./Message"

export function MessageList() {
  let containerRef: HTMLDivElement | undefined

  createEffect(() => {
    const len = state.messages.length
    if (containerRef) {
      requestAnimationFrame(() => {
        containerRef!.scrollTop = containerRef!.scrollHeight
      })
    }
  })

  return (
    <div ref={containerRef} class="flex-1 overflow-y-auto px-2 py-1">
      <Show
        when={state.messages.length > 0}
        fallback={
          <div class="flex h-full items-center justify-center text-vscode-muted">
            <p class="text-sm">Start a conversation</p>
          </div>
        }
      >
        <For each={state.messages}>
          {(msg) => <Message info={msg.info} parts={msg.parts} />}
        </For>
        <Show when={isLoading() && state.sessionStatus[state.activeSessionId!]?.type === "busy"}>
          <div class="flex items-center gap-2 px-2 py-1 text-xs text-vscode-muted">
            <div class="flex gap-0.5">
              <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-vscode-accent" />
              <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-vscode-accent [animation-delay:0.2s]" />
              <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-vscode-accent [animation-delay:0.4s]" />
            </div>
            <span>Thinking...</span>
          </div>
        </Show>
      </Show>
    </div>
  )
}
