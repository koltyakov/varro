import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  state,
  inputText,
  setInputText,
  isLoading,
  setSelectedAgent,
  setSelectedModel,
  resolveSelectedModel,
  addClipboardImage,
  showModelPicker,
  setShowModelPicker,
} from "../lib/state"
import { postMessage } from "../lib/bridge"
import { sendMessage, abortSession } from "../hooks/useOpenCode"
import { ModelPicker } from "./ModelPicker"
import { isAssistantMessage, sumAssistantTokens } from "../lib/message-metrics"

export function ChatInput() {
  let textareaRef: HTMLTextAreaElement | undefined
  let containerRef: HTMLDivElement | undefined
  const [isDraggingOver, setIsDraggingOver] = createSignal(false)
  const [busyPromptMode, setBusyPromptMode] = createSignal<"queue" | "steer">("queue")

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  async function handleSend() {
    const text = inputText()
    if (!text.trim() && state.droppedFiles.length === 0 && state.clipboardImages.length === 0) return
    const sendMode = isLoading() ? busyPromptMode() : "queue"
    setInputText("")
    if (textareaRef) textareaRef.style.height = "auto"
    await sendMessage(text, { noReply: sendMode === "steer" })
  }

  function autoResize() {
    if (!textareaRef) return
    textareaRef.style.height = "auto"
    textareaRef.style.height = Math.min(textareaRef.scrollHeight, 200) + "px"
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingOver(false)
    const paths = await collectDroppedPaths(e.dataTransfer)
    if (paths.length > 0) {
      postMessage({ type: "files/drop", payload: { paths } })
    }
  }

  async function handlePaste(e: ClipboardEvent) {
    const clipboardData = e.clipboardData
    if (!clipboardData) return

    const imageItems = Array.from(clipboardData.items).filter(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    )

    if (imageItems.length === 0) return

    e.preventDefault()

    for (const [index, item] of imageItems.entries()) {
      const file = item.getAsFile()
      if (!file) continue

      const url = await readFileAsDataUrl(file)
      addClipboardImage({
        id: createAttachmentID(),
        url,
        mime: file.type || "image/png",
        filename: file.name || `pasted-image-${Date.now()}-${index + 1}.${extensionForMime(file.type)}`,
        size: file.size,
      })
    }
  }

  onMount(() => {
    const handleWindowDragOver = (e: DragEvent) => {
      if (!isPathDrop(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
    }

    const handleWindowDrop = async (e: DragEvent) => {
      if (!isPathDrop(e.dataTransfer)) return
      e.preventDefault()

      if (!containerRef?.contains(e.target as Node | null)) {
        setIsDraggingOver(false)
        return
      }

      await handleDrop(e)
    }

    window.addEventListener("dragover", handleWindowDragOver)
    window.addEventListener("drop", handleWindowDrop)

    onCleanup(() => {
      window.removeEventListener("dragover", handleWindowDragOver)
      window.removeEventListener("drop", handleWindowDrop)
    })
  })

  const canSend = () =>
    inputText().trim().length > 0 || state.droppedFiles.length > 0 || state.clipboardImages.length > 0

  const currentModel = () => {
    const selected = resolveSelectedModel(state.selectedModel, state.providers, state.providerDefaults)
    if (selected) {
      const provider = state.providers.find((item) => item.id === selected.providerID)
      const model = provider?.models[selected.modelID]
      return {
        providerID: selected.providerID,
        modelID: selected.modelID,
        variant: selected.variant || null,
        providerName: provider?.name || selected.providerID,
        modelName: model?.name || selected.modelID,
        contextLimit: model?.limit?.context || null,
      }
    }

    const latestAuto = [...assistantMessages()].reverse()[0]
    if (latestAuto) {
      const provider = state.providers.find((item) => item.id === latestAuto.providerID)
      const model = provider?.models[latestAuto.modelID]
      return {
        providerID: latestAuto.providerID,
        modelID: latestAuto.modelID,
        variant: latestAuto.variant || null,
        providerName: provider?.name || latestAuto.providerID,
        modelName: model?.name || latestAuto.modelID,
        contextLimit: model?.limit?.context || null,
      }
    }

    const firstProvider = state.providers[0]
    if (firstProvider) {
      const defaultModelID = state.providerDefaults[firstProvider.id]
      const defaultModel = defaultModelID ? firstProvider.models[defaultModelID] : Object.values(firstProvider.models)[0]
      if (defaultModel) {
        return {
          providerID: firstProvider.id,
          modelID: defaultModel.id,
          variant: null,
          providerName: firstProvider.name,
          modelName: defaultModel.name,
          contextLimit: defaultModel.limit?.context || null,
        }
      }
    }

    return {
      providerID: null as string | null,
      modelID: null as string | null,
      variant: null as string | null,
      providerName: "",
      modelName: "",
      contextLimit: null as number | null,
    }
  }

  const assistantMessages = createMemo(() =>
    state.messages
      .map((entry) => entry.info)
      .filter(isAssistantMessage),
  )

  const sessionTokenTotals = createMemo(() => sumAssistantTokens(assistantMessages()))

  return (
    <div class="relative shrink-0 border-t border-vscode-border/40 bg-vscode-sidebar px-3 pb-3.5 pt-2.5">
      <Show when={showModelPicker()}>
        <ModelPicker
          onSelect={(sel) => {
            if (sel.agent) setSelectedAgent(sel.agent)
            if (sel.providerID && sel.modelID) {
              setSelectedModel({ providerID: sel.providerID, modelID: sel.modelID, variant: sel.variant })
            }
          }}
          onClose={() => setShowModelPicker(false)}
        />
      </Show>

      <div
        ref={containerRef}
        class={`flex flex-col rounded-md border transition-all duration-150 ${
          isDraggingOver()
            ? "border-vscode-accent bg-vscode-accent/5"
            : "border-vscode-border/60 bg-vscode-input-bg focus-within:border-vscode-accent/60"
        }`}
        onDrop={(e) => handleDrop(e as DragEvent)}
        onDragEnter={(e) => {
          if (!isPathDrop(e.dataTransfer)) return
          e.preventDefault()
          setIsDraggingOver(true)
        }}
        onDragOver={(e) => {
          if (!isPathDrop(e.dataTransfer)) return
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
          setIsDraggingOver(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setIsDraggingOver(false)
        }}
      >
        <textarea
          ref={textareaRef!}
          class="min-h-20 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-[14px] leading-relaxed text-vscode-input-fg outline-none placeholder:text-vscode-muted/50"
          rows={2}
          placeholder={
            isLoading()
              ? busyPromptMode() === "steer"
                ? "Steer current run..."
                : "Queue next prompt..."
              : state.activeSessionId
                ? "Message..."
                : "Ask anything..."
          }
          value={inputText()}
          onInput={(e) => {
            setInputText(e.currentTarget.value)
            autoResize()
          }}
          onKeyDown={handleKeydown}
          onPaste={handlePaste}
        />

        <div class="flex items-center justify-between gap-2 px-3 pb-3 pt-1.5">
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <button
              class="inline-flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
              onClick={() => setShowModelPicker(!showModelPicker())}
              title={
                currentModel().modelName
                  ? `${currentModel().modelName}${currentModel().variant ? ` [${formatThinkingLabel(currentModel().variant!)}]` : ""} — ${currentModel().providerName}`
                  : "Choose model"
              }
            >
              <svg class="h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1l2 4.5L15 6l-3.5 3.5L12.5 15 8 12.5 3.5 15l1-5.5L1 6l5-.5L8 1z" />
              </svg>
              <Show when={currentModel().modelName} fallback={<span>Pick model</span>}>
                <span class="truncate max-w-[200px]">
                  {currentModel().modelName}
                  <Show when={currentModel().variant}>
                    <span class="text-vscode-muted/70"> [{formatThinkingLabel(currentModel().variant!)}]</span>
                  </Show>
                </span>
              </Show>
            </button>

          </div>

          <div class="flex items-center gap-2">
            <Show when={sessionTokenTotals().total > 0}>
              <span class="tabular-nums text-[12px] text-vscode-muted/60">
                {formatCompactNumber(sessionTokenTotals().total)} tok
              </span>
            </Show>
            <Show when={isLoading()}>
              <>
                <BusyModeButton
                  active={busyPromptMode() === "queue"}
                  label="Queue"
                  title="Queue a follow-up prompt after the current run"
                  onClick={() => setBusyPromptMode("queue")}
                />
                <BusyModeButton
                  active={busyPromptMode() === "steer"}
                  label="Steer"
                  title="Send guidance to the current run without expecting a separate reply"
                  onClick={() => setBusyPromptMode("steer")}
                />
              </>
            </Show>
            <button
              class={`flex h-8 w-8 items-center justify-center rounded-md transition-all duration-150 ${
                canSend()
                  ? "bg-vscode-accent text-white hover:bg-vscode-accent/80"
                  : "text-vscode-muted/30"
              }`}
              onClick={handleSend}
              disabled={!canSend()}
              title={isLoading() ? (busyPromptMode() === "steer" ? "Steer current run (Enter)" : "Queue prompt (Enter)") : "Send (Enter)"}
            >
              <svg class="h-4.5 w-4.5" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 2.5l12 5.5L2 13.5V9l8-1-8-1V2.5z" />
              </svg>
            </button>
            <Show when={isLoading()}>
              <button
                class="flex h-8 w-8 items-center justify-center rounded-md bg-vscode-error/12 text-vscode-error transition-colors hover:bg-vscode-error/20"
                onClick={abortSession}
                title="Stop"
              >
                <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="4" y="4" width="8" height="8" rx="1" />
                </svg>
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}


async function collectDroppedPaths(dataTransfer: DataTransfer | null): Promise<string[]> {
  if (!dataTransfer) return []

  const paths = new Set<string>()

  for (const type of ["text/uri-list", "text/plain"]) {
    for (const path of parseDroppedText(dataTransfer.getData(type))) {
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

  if (paths.size === 0) {
    const itemText = await Promise.all(
      Array.from(dataTransfer.items)
        .filter((item) => item.kind === "string" && (item.type === "text/uri-list" || item.type === "text/plain"))
        .map(readDroppedItem),
    )

    for (const value of itemText) {
      for (const path of parseDroppedText(value)) {
        paths.add(path)
      }
    }
  }

  return Array.from(paths)
}

function isPathDrop(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types || [])
  return types.includes("Files") || types.includes("text/uri-list")
}

function readDroppedItem(item: DataTransferItem): Promise<string> {
  return new Promise((resolve) => {
    item.getAsString((value) => resolve(value || ""))
  })
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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ""))
    reader.onerror = () => reject(reader.error || new Error("Failed to read clipboard image"))
    reader.readAsDataURL(file)
  })
}

function createAttachmentID() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function extensionForMime(mime: string) {
  switch (mime) {
    case "image/jpeg":
      return "jpg"
    case "image/gif":
      return "gif"
    case "image/webp":
      return "webp"
    default:
      return "png"
  }
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  })
    .format(value)
    .toLowerCase()
}

function BusyModeButton(props: { active: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      class={`rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
        props.active
          ? "border-vscode-accent/40 bg-vscode-accent/8 text-vscode-fg"
          : "border-vscode-border/40 text-vscode-muted hover:bg-vscode-hover hover:text-vscode-fg"
      }`}
      onClick={props.onClick}
      title={props.title}
    >
      {props.label}
    </button>
  )
}

function formatThinkingLabel(variant: string) {
  return variant
    .split(/[-_]/g)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}
