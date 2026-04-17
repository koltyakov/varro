import { For, Show, createEffect, onCleanup } from "solid-js"
import { state, isLoading } from "../lib/state"
import { Message } from "./Message"

export function MessageList() {
  let containerRef: HTMLDivElement | undefined
  let userScrolledUp = false

  function onScroll() {
    if (!containerRef) return
    const near = containerRef.scrollHeight - containerRef.scrollTop - containerRef.clientHeight < 80
    userScrolledUp = !near
  }

  createEffect(() => {
    // touch state to track streaming updates
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
      class="min-h-0 flex-1 overflow-y-auto"
      onScroll={onScroll}
    >
      <Show
        when={state.messages.length > 0}
        fallback={<EmptyState />}
      >
        <div class="space-y-1 px-2 py-3">
          <For each={state.messages}>
            {(msg) => <Message info={msg.info} parts={msg.parts} />}
          </For>
          <Show when={isLoading()}>
            <div class="mx-2 my-3 flex items-center gap-2 rounded-md border border-vscode-border bg-vscode-card px-3 py-2 text-sm text-vscode-muted">
              <div class="flex gap-1">
                <span class="h-2 w-2 animate-pulse rounded-full bg-vscode-accent" />
                <span
                  class="h-2 w-2 animate-pulse rounded-full bg-vscode-accent"
                  style={{ "animation-delay": "0.2s" }}
                />
                <span
                  class="h-2 w-2 animate-pulse rounded-full bg-vscode-accent"
                  style={{ "animation-delay": "0.4s" }}
                />
              </div>
              <span>Thinking…</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function EmptyState() {
  return (
    <div class="flex h-full flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <div class="flex h-14 w-14 items-center justify-center rounded-md border border-vscode-border bg-vscode-card">
        <svg class="h-6 w-6 text-vscode-muted" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1 3.5A1.5 1.5 0 012.5 2h11A1.5 1.5 0 0115 3.5v7a1.5 1.5 0 01-1.5 1.5H6.8l-3.4 2.55A.5.5 0 012.5 14v-2h-.001A1.5 1.5 0 011 10.5v-7z" />
        </svg>
      </div>
      <div class="space-y-1">
        <p class="text-lg font-semibold text-vscode-fg">How can I help?</p>
        <p class="text-sm text-vscode-muted">
          Ask a question, paste code, or drop a file into the input.
        </p>
      </div>
      <div class="mt-2 w-full max-w-[320px] space-y-2">
        <Hint text="Explain the code I have open" />
        <Hint text="Refactor the current selection" />
        <Hint text="Find bugs in @path/to/file" />
      </div>
    </div>
  )
}

function Hint(props: { text: string }) {
  return (
    <div class="rounded-md border border-vscode-border bg-vscode-card px-3 py-2 text-left text-sm text-vscode-muted">
      {props.text}
    </div>
  )
}
