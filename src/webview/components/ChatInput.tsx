import { Show, createSignal } from "solid-js"
import {
  state,
  inputText,
  setInputText,
  isLoading,
  setState,
  showModelPicker,
  setShowModelPicker,
} from "../lib/state"
import { sendMessage, abortSession } from "../hooks/useOpenCode"
import { ModelPicker } from "./ModelPicker"

export function ChatInput() {
  let textareaRef: HTMLTextAreaElement | undefined
  const [isDraggingOver, setIsDraggingOver] = createSignal(false)

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  async function handleSend() {
    const text = inputText()
    if (!text.trim() && state.droppedFiles.length === 0) return
    setInputText("")
    if (textareaRef) textareaRef.style.height = "auto"
    await sendMessage(text)
  }

  function autoResize() {
    if (!textareaRef) return
    textareaRef.style.height = "auto"
    textareaRef.style.height = Math.min(textareaRef.scrollHeight, 240) + "px"
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    setIsDraggingOver(false)
    const text = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain")
    if (!text) return
    const uris = text.split(/\r?\n/).filter(Boolean)
    for (const uri of uris) {
      const path = uri.replace(/^file:\/\//, "")
      const relativePath = path.split("/").pop() || path
      setState("droppedFiles", (prev) => {
        if (prev.find((f) => f.path === path)) return prev
        return [...prev, { path, relativePath, type: "file" as const }]
      })
    }
  }

  const canSend = () => inputText().trim().length > 0 || state.droppedFiles.length > 0

  const agentLabel = () => state.selectedAgent || "agent"
  const modelLabel = () => {
    const m = state.selectedModel
    if (!m) return "auto"
    const provider = state.providers.find((p) => p.id === m.providerID)
    const model = provider?.models[m.modelID]
    return model?.name || m.modelID
  }

  return (
    <div class="relative border-t border-vscode-border bg-vscode-sidebar px-3 pb-3 pt-3">
      <Show when={showModelPicker()}>
        <ModelPicker
          onSelect={(sel) => {
            if (sel.agent) setState("selectedAgent", sel.agent)
            if (sel.providerID && sel.modelID) {
              setState("selectedModel", { providerID: sel.providerID, modelID: sel.modelID })
            } else if (!sel.providerID && !sel.modelID) {
              setState("selectedModel", null)
            }
          }}
          onClose={() => setShowModelPicker(false)}
        />
      </Show>

      <div
        class={`flex flex-col rounded-md border bg-vscode-input-bg transition-colors ${
          isDraggingOver()
            ? "border-vscode-accent"
            : "border-vscode-input-border focus-within:border-vscode-accent"
        }`}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDraggingOver(true)
        }}
        onDragLeave={() => setIsDraggingOver(false)}
      >
        <textarea
          ref={textareaRef!}
          class="min-h-[72px] w-full resize-none bg-transparent px-3.5 pb-2 pt-3 text-[14px] leading-6 text-vscode-input-fg outline-none placeholder:text-vscode-muted"
          rows={2}
          placeholder={
            state.activeSessionId
              ? "Reply..."
              : "Ask anything. Drag files here, or press Cmd+Shift+K to add the active file."
          }
          value={inputText()}
          onInput={(e) => {
            setInputText(e.currentTarget.value)
            autoResize()
          }}
          onKeyDown={handleKeydown}
        />

        <div class="flex items-center justify-between gap-2 border-t border-vscode-border/60 px-2.5 pb-2 pt-2">
          <div class="flex min-w-0 items-center gap-2">
            <button
              class="inline-flex items-center gap-1.5 rounded-md border border-vscode-border px-2.5 py-1 text-[12px] text-vscode-muted hover:bg-vscode-hover hover:text-vscode-fg"
              onClick={() => setShowModelPicker(!showModelPicker())}
              title="Choose agent and model"
            >
              <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1l2 4.5L15 6l-3.5 3.5L12.5 15 8 12.5 3.5 15l1-5.5L1 6l5-.5L8 1z" />
              </svg>
              <span class="truncate max-w-[88px]">{agentLabel()}</span>
              <span class="text-vscode-muted">·</span>
              <span class="truncate max-w-[112px]">{modelLabel()}</span>
            </button>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <span class="text-[11px] text-vscode-muted">
              <kbd class="font-mono">⏎</kbd> send · <kbd class="font-mono">⇧⏎</kbd> newline
            </span>
            <Show
              when={!isLoading()}
              fallback={
                <button
                  class="rounded-md bg-vscode-error/20 p-2 text-vscode-error hover:bg-vscode-error/30"
                  onClick={abortSession}
                  title="Stop generation"
                >
                  <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                    <rect x="3" y="3" width="10" height="10" rx="1" />
                  </svg>
                </button>
              }
            >
              <button
                class={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  canSend()
                    ? "bg-vscode-button-bg text-vscode-button-fg hover:bg-vscode-button-hover"
                    : "border border-vscode-border text-vscode-muted"
                }`}
                onClick={handleSend}
                disabled={!canSend()}
                title="Send (Enter)"
              >
                <span class="inline-flex items-center gap-1.5">
                  <span>Send</span>
                  <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2 2.5l12 5.5L2 13.5V9l8-1-8-1V2.5z" />
                  </svg>
                </span>
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
