import { For, Show, createEffect, onCleanup } from "solid-js"
import { state, isLoading } from "../lib/state"
import { Message } from "./Message"

export function MessageList() {
  let containerRef: HTMLDivElement | undefined
  let userScrolledUp = false

  function onScroll() {
    if (!containerRef) return
    const near = containerRef.scrollHeight - containerRef.scrollTop - containerRef.clientHeight < 60
    userScrolledUp = !near
  }

  createEffect(() => {
    const _len = state.messages.length
    const _parts = state.messages.reduce((acc, m) => acc + m.parts.length, 0)
    void _len
    void _parts
    if (!containerRef || userScrolledUp) return
    requestAnimationFrame(() => {
      containerRef!.scrollTop = containerRef!.scrollHeight
    })
  })

  onCleanup(() => {})

  return (
    <div
      ref={containerRef}
      class="min-h-0 flex-1 overflow-y-auto scroll-smooth"
      onScroll={onScroll}
    >
      <div class="mx-auto flex w-full max-w-245 flex-col gap-6 px-5 py-6 pb-8">
        <For each={state.messages}>
          {(msg) => <Message info={msg.info} parts={msg.parts} />}
        </For>
        <Show when={isLoading()}>
          <div class="flex items-center gap-3 pl-10 animate-fade-in">
            <div class="flex items-center gap-1.5">
              <span class="h-2 w-2 rounded-full bg-vscode-muted/50 animate-pulse-soft" />
              <span class="h-2 w-2 rounded-full bg-vscode-muted/50 animate-pulse-soft" style={{ "animation-delay": "0.25s" }} />
              <span class="h-2 w-2 rounded-full bg-vscode-muted/50 animate-pulse-soft" style={{ "animation-delay": "0.5s" }} />
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

