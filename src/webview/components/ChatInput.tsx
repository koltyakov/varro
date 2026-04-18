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
import { formatNumber, getContextWindow, isAssistantMessage, sumAssistantTokens } from "../lib/message-metrics"

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

    return {
      providerID: null,
      modelID: null,
      variant: null,
      providerName: "OpenCode",
      modelName: "Default",
      contextLimit: null,
    }
  }

  const assistantMessages = createMemo(() =>
    state.messages
      .map((entry) => entry.info)
      .filter(isAssistantMessage),
  )

  const sessionTokenTotals = createMemo(() => sumAssistantTokens(assistantMessages()))

  const activeModelContext = createMemo(() => {
    const model = currentModel()
    if (!model.providerID || !model.modelID) return null

    const latestMatch = [...assistantMessages()]
      .reverse()
      .find(
        (message) =>
          message.providerID === model.providerID &&
          message.modelID === model.modelID &&
          (message.variant || null) === (model.variant || null),
      )

    if (latestMatch) {
      return getContextWindow(latestMatch, state.providers)
    }

    if (!model.contextLimit) return null
    return {
      used: 0,
      limit: model.contextLimit,
      percent: 0,
    }
  })
  return (
    <div class="relative shrink-0 border-t border-vscode-border/60 bg-vscode-sidebar px-4 pb-4 pt-3">
      <Show when={showModelPicker()}>
        <ModelPicker
          onSelect={(sel) => {
            if (sel.agent) setSelectedAgent(sel.agent)
            if (sel.providerID && sel.modelID) {
              setSelectedModel({ providerID: sel.providerID, modelID: sel.modelID, variant: sel.variant })
            } else if (!sel.providerID && !sel.modelID) {
              setSelectedModel(null)
            }
          }}
          onClose={() => setShowModelPicker(false)}
        />
      </Show>

      <div
        ref={containerRef}
        class={`flex flex-col border transition-all duration-150 ${
          isDraggingOver()
            ? "border-vscode-accent bg-vscode-accent/5"
            : "border-vscode-border/60 bg-vscode-input-bg focus-within:border-vscode-accent/60"
        }`}
        onDropCapture={handleDrop}
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
          class="min-h-[60px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-relaxed text-vscode-input-fg outline-none placeholder:text-vscode-muted/60"
          rows={2}
          placeholder={
            isLoading()
              ? busyPromptMode() === "steer"
                ? "Steer current run…"
                : "Queue next prompt…"
              : state.activeSessionId
                ? "Message…"
                : "Ask anything…"
          }
          value={inputText()}
          onInput={(e) => {
            setInputText(e.currentTarget.value)
            autoResize()
          }}
          onKeyDown={handleKeydown}
          onPaste={handlePaste}
        />

        <div class="flex flex-wrap items-center justify-between gap-3 px-3 pb-3 pt-2">
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <button
              class="inline-flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[12px] text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
              onClick={() => setShowModelPicker(!showModelPicker())}
              title="Choose model"
            >
              <svg class="h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1l2 4.5L15 6l-3.5 3.5L12.5 15 8 12.5 3.5 15l1-5.5L1 6l5-.5L8 1z" />
              </svg>
              <span class="truncate max-w-[260px]">
                {(state.selectedAgent || "Default") +
                  " · " +
                  currentModel().modelName +
                  (currentModel().variant ? ` [${formatThinkingLabel(currentModel().variant!)}]` : "") +
                  " (" +
                  currentModel().providerName +
                  ")"}
              </span>
            </button>

            <StatChip
              label="Session"
              value={`${formatNumber(sessionTokenTotals().total)} tok`}
              title={`Input ${formatNumber(sessionTokenTotals().input)} · Output ${formatNumber(sessionTokenTotals().output)} · Thinking ${formatNumber(sessionTokenTotals().reasoning)}`}
            />
            <Show when={sessionTokenTotals().reasoning > 0}>
              <StatChip
                label="Think"
                value={formatNumber(sessionTokenTotals().reasoning)}
                title="Reasoning tokens"
              />
            </Show>
            <Show when={activeModelContext()}>
              <ContextWindowChip used={activeModelContext()!.used} limit={activeModelContext()!.limit} />
            </Show>
          </div>
          <div class="flex items-center gap-2">
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
            <span class="hidden text-[11px] text-vscode-muted/60 sm:inline">Drop files, folders, or paste images</span>
            <span class="hidden text-[11px] text-vscode-muted/50 sm:inline">
              <kbd>↵</kbd> send
            </span>
            <button
              class={`flex h-9 w-9 items-center justify-center transition-all duration-150 ${
                canSend()
                  ? "bg-vscode-accent text-white hover:bg-vscode-accent/80"
                  : "text-vscode-muted/40"
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
                class="flex h-9 w-9 items-center justify-center bg-vscode-error/15 text-vscode-error transition-colors hover:bg-vscode-error/25"
                onClick={abortSession}
                title="Stop"
              >
                <svg class="h-4.5 w-4.5" viewBox="0 0 16 16" fill="currentColor">
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

function StatChip(props: { label: string; value: string; title?: string }) {
  return (
    <span
      class="inline-flex items-center gap-2 border border-vscode-border/50 bg-vscode-card/50 px-2.5 py-1.5 text-[11px] text-vscode-muted"
      title={props.title}
    >
      <span class="uppercase tracking-[0.08em] text-vscode-muted/70">{props.label}</span>
      <span class="text-vscode-fg">{props.value}</span>
    </span>
  )
}

function ContextWindowChip(props: { used: number; limit: number }) {
  const percentUsed = () => Math.min(props.limit > 0 ? (props.used / props.limit) * 100 : 0, 100)
  const percentLeft = () => Math.max(0, 100 - percentUsed())

  return (
    <span class="group relative inline-flex">
      <span
        class="inline-flex items-center gap-2 border border-vscode-border/50 bg-vscode-card/50 px-2.5 py-1.5 text-[11px] text-vscode-muted transition-colors group-hover:border-vscode-accent/40 group-hover:text-vscode-fg"
        tabindex="0"
      >
        <span class="uppercase tracking-[0.08em] text-vscode-muted/70">Ctx</span>
        <span class="text-vscode-fg">{percentUsed().toFixed(0)}%</span>
      </span>

      <span class="pointer-events-none absolute bottom-[calc(100%+10px)] left-0 z-20 w-52 border border-vscode-border bg-vscode-card px-4 py-3.5 text-[12px] text-vscode-fg opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.35)] transition-all duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <span class="block text-vscode-muted">Context window:</span>
        <span class="mt-1 block font-medium">
          {percentUsed().toFixed(1)}% used ({percentLeft().toFixed(1)}% left)
        </span>
        <span class="mt-1 block text-vscode-muted">
          {formatCompactNumber(props.used)} / {formatCompactNumber(props.limit)} tokens used
        </span>
        <span class="mt-2 block leading-relaxed text-vscode-fg/85">
          Codex automatically compacts its context
        </span>
      </span>
    </span>
  )
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
      class={`border px-2.5 py-1.5 text-[11px] transition-colors ${
        props.active
          ? "border-vscode-accent/50 bg-vscode-accent/10 text-vscode-fg"
          : "border-vscode-border/50 bg-vscode-card/40 text-vscode-muted hover:bg-vscode-hover hover:text-vscode-fg"
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
