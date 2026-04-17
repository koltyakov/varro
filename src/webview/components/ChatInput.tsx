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
    textareaRef.style.height = Math.min(textareaRef.scrollHeight, 200) + "px"
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

  const modelLabel = () => {
    const m = state.selectedModel
    if (!m) return "auto"
    const provider = state.providers.find((p) => p.id === m.providerID)
    const model = provider?.models[m.modelID]
    return model?.name || m.modelID
  }

  return (
    <div class="relative shrink-0 border-t border-vscode-border/60 bg-vscode-sidebar px-3 pb-3 pt-2">
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
        class={`flex flex-col rounded-lg border transition-all duration-150 ${
          isDraggingOver()
            ? "border-vscode-accent bg-vscode-accent/5"
            : "border-vscode-border/60 bg-vscode-input-bg focus-within:border-vscode-accent/60"
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
          class="min-h-[56px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] leading-relaxed text-vscode-input-fg outline-none placeholder:text-vscode-muted/60"
          rows={2}
          placeholder={
            state.activeSessionId
              ? "Message…"
              : "Ask anything…"
          }
          value={inputText()}
          onInput={(e) => {
            setInputText(e.currentTarget.value)
            autoResize()
          }}
          onKeyDown={handleKeydown}
        />

        <div class="flex items-center justify-between px-2 pb-2 pt-0.5">
          <button
            class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
            onClick={() => setShowModelPicker(!showModelPicker())}
            title="Choose model"
          >
            <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1l2 4.5L15 6l-3.5 3.5L12.5 15 8 12.5 3.5 15l1-5.5L1 6l5-.5L8 1z" />
            </svg>
            <span class="truncate max-w-[140px]">{modelLabel()}</span>
          </button>
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] text-vscode-muted/50 hidden sm:inline">
              <kbd>↵</kbd> send
            </span>
            <Show
              when={!isLoading()}
              fallback={
                <button
                  class="flex h-7 w-7 items-center justify-center rounded-md bg-vscode-error/15 text-vscode-error transition-colors hover:bg-vscode-error/25"
                  onClick={abortSession}
                  title="Stop"
                >
                  <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
                    <rect x="4" y="4" width="8" height="8" rx="1" />
                  </svg>
                </button>
              }
            >
              <button
                class={`flex h-7 w-7 items-center justify-center rounded-md transition-all duration-150 ${
                  canSend()
                    ? "bg-vscode-accent text-white hover:bg-vscode-accent/80"
                    : "text-vscode-muted/40"
                }`}
                onClick={handleSend}
                disabled={!canSend()}
                title="Send (Enter)"
              >
                <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M2 2.5l12 5.5L2 13.5V9l8-1-8-1V2.5z" />
                </svg>
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
