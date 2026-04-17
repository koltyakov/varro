import { Show } from "solid-js"
import { state, inputText, setInputText, isLoading, setState } from "../lib/state"
import { sendMessage, abortSession } from "../hooks/useOpenCode"

export function ChatInput() {
  let textareaRef: HTMLTextAreaElement | undefined

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  async function handleSend() {
    const text = inputText().trim()
    if (!text && state.droppedFiles.length === 0) return
    setInputText("")
    await sendMessage(text)
  }

  function autoResize() {
    if (!textareaRef) return
    textareaRef.style.height = "auto"
    textareaRef.style.height = Math.min(textareaRef.scrollHeight, 200) + "px"
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    const text = e.dataTransfer?.getData("text/uri-list")
    if (text) {
      const uris = text.split("\n").filter(Boolean)
      for (const uri of uris) {
        const path = uri.replace("file://", "")
        const relativePath = path.split("/").pop() || path
        setState(
          "droppedFiles",
          (prev) => {
            if (prev.find((f) => f.path === path)) return prev
            return [...prev, { path, relativePath, type: "file" as const }]
          },
        )
      }
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault()
  }

  return (
    <div class="border-t border-vscode-border px-2 pb-2 pt-1">
      <div
        class="relative rounded-md border border-vscode-input-border bg-vscode-input-bg focus-within:border-vscode-accent"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <textarea
          ref={textareaRef!}
          class="w-full resize-none bg-transparent px-2.5 py-2 text-sm text-vscode-input-fg outline-none placeholder:text-vscode-muted"
          rows={1}
          placeholder="Ask OpenCode..."
          value={inputText()}
          onInput={(e) => {
            setInputText(e.currentTarget.value)
            autoResize()
          }}
          onKeyDown={handleKeydown}
        />
        <div class="flex items-center justify-between px-1.5 pb-1">
          <div class="flex items-center gap-1">
            <Show when={state.editorContext.activeFile}>
              <span class="inline-flex items-center gap-0.5 rounded bg-vscode-card px-1 py-0.5 text-[10px] text-vscode-muted">
                <svg class="h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
                </svg>
                {state.editorContext.activeFile!.relativePath}
              </span>
            </Show>
          </div>
          <Show
            when={!isLoading()}
            fallback={
              <button
                class="rounded p-1 text-vscode-error hover:bg-vscode-hover"
                onClick={abortSession}
                title="Stop"
              >
                <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="3" y="3" width="10" height="10" rx="1" />
                </svg>
              </button>
            }
          >
            <button
              class={`rounded p-1 ${
                inputText().trim() || state.droppedFiles.length > 0
                  ? "text-vscode-button-bg hover:bg-vscode-hover"
                  : "text-vscode-muted"
              }`}
              onClick={handleSend}
              disabled={!inputText().trim() && state.droppedFiles.length === 0}
              title="Send message"
            >
              <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3 2l10 6-10 6V2z" />
              </svg>
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}
