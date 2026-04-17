import { For, Show, createEffect, onCleanup } from "solid-js"
import { state, isLoading, inputText, setInputText } from "../lib/state"
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
      <Show
        when={state.messages.length > 0}
        fallback={<EmptyState />}
      >
        <div class="space-y-6 px-4 py-5">
          <For each={state.messages}>
            {(msg) => <Message info={msg.info} parts={msg.parts} />}
          </For>
          <Show when={isLoading()}>
            <div class="flex items-center gap-2 px-8 py-2 text-xs text-vscode-muted animate-fade-in">
              <div class="flex items-center gap-1.5">
                <span class="h-1 w-1 bg-vscode-accent animate-pulse-soft" />
                <span class="h-1 w-1 bg-vscode-accent animate-pulse-soft" style={{ "animation-delay": "0.3s" }} />
                <span class="h-1 w-1 bg-vscode-accent animate-pulse-soft" style={{ "animation-delay": "0.6s" }} />
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
  function useHint(text: string) {
    setInputText(text)
  }

  return (
    <div class="flex h-full flex-col items-center justify-center gap-5 px-8 py-12 text-center">
      <svg class="h-6 w-6 text-vscode-muted" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1 3.5A1.5 1.5 0 012.5 2h11A1.5 1.5 0 0115 3.5v7a1.5 1.5 0 01-1.5 1.5H6.8l-3.4 2.55A.5.5 0 012.5 14v-2h-.001A1.5 1.5 0 011 10.5v-7z" />
      </svg>
      <div>
        <p class="text-sm font-semibold text-vscode-fg">How can I help?</p>
        <p class="mt-1 text-[12px] text-vscode-muted">
          Ask a question, paste code, or drop a file.
        </p>
      </div>
      <div class="mt-2 w-full max-w-[280px] space-y-1">
        <Hint text="Explain the code I have open" onClick={useHint} />
        <Hint text="Refactor the current selection" onClick={useHint} />
        <Hint text="Find bugs in @path/to/file" onClick={useHint} />
      </div>
    </div>
  )
}

function Hint(props: { text: string; onClick: (text: string) => void }) {
  return (
    <button
      class="w-full border border-vscode-border bg-transparent px-3 py-1.5 text-left text-[12px] text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
      onClick={() => props.onClick(props.text)}
    >
      {props.text}
    </button>
  )
}
