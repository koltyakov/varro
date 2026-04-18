import { Show, For } from "solid-js"
import { state, removeClipboardImage, removeContextFile, clearClipboardImages, clearContextFiles } from "../lib/state"

export function ContextBar() {
  const files = () => state.droppedFiles
  const clipboardImages = () => state.clipboardImages
  const selection = () => state.editorContext.selection
  const activeFile = () => state.editorContext.activeFile
  const hasContext = () => files().length > 0 || clipboardImages().length > 0 || !!selection()
  const activeContext = () => {
    const file = activeFile()
    if (!file) return null

    const selectedLines = selection()
    if (!selectedLines) return { filename: file.relativePath, lineRange: null as string | null }

    const lineRange =
      selectedLines.startLine === selectedLines.endLine
        ? `L${selectedLines.startLine}`
        : `L${selectedLines.startLine}-${selectedLines.endLine}`

    return { filename: file.relativePath, lineRange }
  }

  return (
    <Show when={hasContext()}>
      <div class="border-t border-vscode-border/30 px-3 py-2">
        <div class="flex items-center gap-2">
          <div class="flex flex-1 flex-wrap gap-1.5 overflow-hidden">
            <Show when={activeContext()}>
              <ContextChip
                label={activeContext()!.filename}
                detail={activeContext()!.lineRange}
                title={
                  activeContext()!.lineRange
                    ? `${activeContext()!.filename} ${activeContext()!.lineRange}`
                    : activeContext()!.filename
                }
              />
            </Show>
            <For each={files()}>
              {(file) => (
                <ContextChip
                  label={file.relativePath}
                  title={file.relativePath}
                  onRemove={files().length > 0 ? () => removeContextFile(file.path) : undefined}
                />
              )}
            </For>
            <For each={clipboardImages()}>
              {(image) => (
                <ImageContextChip image={image} onRemove={() => removeClipboardImage(image.id)} />
              )}
            </For>
          </div>
          <div class="flex items-center gap-0.5">
            <Show when={clipboardImages().length > 0}>
              <button
                class="shrink-0 rounded p-1 text-vscode-muted/50 transition-colors hover:bg-vscode-hover hover:text-vscode-error"
                onClick={clearClipboardImages}
                title="Clear pasted images"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                </svg>
              </button>
            </Show>
            <Show when={files().length > 0}>
              <button
                class="shrink-0 rounded p-1 text-vscode-muted/50 transition-colors hover:bg-vscode-hover hover:text-vscode-error"
                onClick={clearContextFiles}
                title="Clear dropped files"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                </svg>
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}

function ContextChip(props: { label: string; detail?: string | null; title?: string; onRemove?: () => void }) {
  return (
    <span
      class="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-vscode-border/40 bg-vscode-card/40 px-2 py-1 text-[11px] text-vscode-fg transition-colors hover:border-vscode-accent/25"
      title={props.title}
    >
      <span class="max-w-[180px] truncate">{props.label}</span>
      <Show when={props.detail}>
        <span class="shrink-0 text-vscode-muted/70">{props.detail}</span>
      </Show>
      <Show when={props.onRemove}>
        <button
          class="text-vscode-muted/40 transition-colors hover:text-vscode-error"
          onClick={() => props.onRemove?.()}
        >
          <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
        </button>
      </Show>
    </span>
  )
}

function ImageContextChip(props: {
  image: { url: string; filename: string; size: number }
  onRemove?: () => void
}) {
  return (
    <span
      class="inline-flex min-w-0 items-center gap-2 rounded-md border border-vscode-border/40 bg-vscode-card/40 px-2 py-1 text-[11px] text-vscode-fg transition-colors hover:border-vscode-accent/25"
      title={`${props.image.filename} · ${formatImageSize(props.image.size)}`}
    >
      <img
        src={props.image.url}
        alt={props.image.filename}
        class="h-7 w-7 shrink-0 rounded border border-vscode-border/30 object-cover"
      />
      <span class="min-w-0">
        <span class="block max-w-[180px] truncate">{props.image.filename}</span>
        <span class="block text-vscode-muted/70">{formatImageSize(props.image.size)}</span>
      </span>
      <Show when={props.onRemove}>
        <button
          class="text-vscode-muted/40 transition-colors hover:text-vscode-error"
          onClick={() => props.onRemove?.()}
        >
          <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
        </button>
      </Show>
    </span>
  )
}

function formatImageSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size >= 100 * 1024 ? 0 : 1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
