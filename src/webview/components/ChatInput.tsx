import { For, Show, createSignal } from "solid-js"
import {
  state,
  inputText,
  setInputText,
  isLoading,
  setSelectedAgent,
  setSelectedModel,
  showModelPicker,
  setShowModelPicker,
} from "../lib/state"
import { postMessage } from "../lib/bridge"
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
    const paths = collectDroppedPaths(e.dataTransfer)
    if (paths.length > 0) {
      postMessage({ type: "files/drop", payload: { paths } })
    }
  }

  const canSend = () => inputText().trim().length > 0 || state.droppedFiles.length > 0

  const selectedAgent = () => state.agents.find((agent) => agent.name === state.selectedAgent) || null

  const currentModel = () => {
    const selected = state.selectedModel
    if (selected) {
      const provider = state.providers.find((item) => item.id === selected.providerID)
      const model = provider?.models[selected.modelID]
      return {
        providerName: provider?.name || selected.providerID,
        modelName: model?.name || selected.modelID,
      }
    }

    const fallback = parseModelRef(state.providerDefaults.model)
    if (fallback) {
      const provider = state.providers.find((item) => item.id === fallback.providerID)
      const model = provider?.models[fallback.modelID]
      return {
        providerName: provider?.name || fallback.providerID,
        modelName: model?.name || fallback.modelID,
      }
    }

    return { providerName: "Auto", modelName: "Automatic" }
  }

  const metadata = () => [
    { label: "Provider", value: currentModel().providerName },
    { label: "Agent", value: state.selectedAgent || "Default" },
    { label: "Mode", value: selectedAgent()?.mode || "default" },
    { label: "Context", value: state.editorContext.activeFile?.relativePath || "No file" },
  ]

  return (
    <div class="relative shrink-0 border-t border-vscode-border/60 bg-vscode-sidebar px-3 pb-3 pt-2">
      <Show when={showModelPicker()}>
        <ModelPicker
          onSelect={(sel) => {
            if (sel.agent) setSelectedAgent(sel.agent)
            if (sel.providerID && sel.modelID) {
              setSelectedModel({ providerID: sel.providerID, modelID: sel.modelID })
            } else if (!sel.providerID && !sel.modelID) {
              setSelectedModel(null)
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
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setIsDraggingOver(false)
        }}
      >
        <div class="flex flex-wrap gap-x-3 gap-y-1 border-b border-vscode-border/40 px-3 py-2 text-[10px] text-vscode-muted">
          <For each={metadata()}>
            {(item) => (
              <span class="inline-flex max-w-full items-center gap-1">
                <span class="uppercase tracking-[0.08em] text-vscode-muted/70">{item.label}</span>
                <span class="truncate text-vscode-fg/85" title={item.value}>
                  {item.value}
                </span>
              </span>
            )}
          </For>
        </div>

        <textarea
          ref={textareaRef!}
          class="min-h-[56px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] leading-relaxed text-vscode-input-fg outline-none placeholder:text-vscode-muted/60"
          rows={2}
          placeholder={state.activeSessionId ? "Message…" : "Ask anything…"}
          value={inputText()}
          onInput={(e) => {
            setInputText(e.currentTarget.value)
            autoResize()
          }}
          onKeyDown={handleKeydown}
        />

        <div class="flex items-center justify-between gap-2 px-2 pb-2 pt-0.5">
          <button
            class="inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
            onClick={() => setShowModelPicker(!showModelPicker())}
            title="Choose model"
          >
            <svg class="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1l2 4.5L15 6l-3.5 3.5L12.5 15 8 12.5 3.5 15l1-5.5L1 6l5-.5L8 1z" />
            </svg>
            <span class="truncate max-w-[180px]">{currentModel().modelName}</span>
          </button>
          <div class="flex items-center gap-1.5">
            <span class="hidden text-[10px] text-vscode-muted/60 sm:inline">Drop files or folders</span>
            <span class="hidden text-[10px] text-vscode-muted/50 sm:inline">
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

function collectDroppedPaths(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) return []

  const paths = new Set<string>()
  const uriList = dataTransfer.getData("text/uri-list")
  const plainText = dataTransfer.getData("text/plain")

  for (const value of [uriList, plainText]) {
    for (const path of parseDroppedText(value)) {
      paths.add(path)
    }
  }

  for (const file of Array.from(dataTransfer.files)) {
    const path = (file as File & { path?: string }).path
    if (path) paths.add(path)
  }

  for (const item of Array.from(dataTransfer.items)) {
    const file = item.getAsFile() as (File & { path?: string }) | null
    if (file?.path) paths.add(file.path)
  }

  return Array.from(paths)
}

function parseDroppedText(value: string): string[] {
  if (!value) return []
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(decodeDroppedPath)
    .filter((path): path is string => Boolean(path))
}

function decodeDroppedPath(value: string): string | null {
  if (value.startsWith("file://")) {
    try {
      const pathname = decodeURIComponent(new URL(value).pathname)
      return pathname.replace(/^\/([A-Za-z]:\/)/, "$1")
    } catch {
      return null
    }
  }
  return value.startsWith("/") ? value : null
}

function parseModelRef(value?: string): { providerID: string; modelID: string } | null {
  if (!value) return null
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return null
  return {
    providerID: value.slice(0, slash),
    modelID: value.slice(slash + 1),
  }
}
