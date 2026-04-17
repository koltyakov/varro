import { Show, For } from "solid-js"
import { state, removeContextFile, clearContextFiles } from "../lib/state"

export function ContextBar() {
  const files = () => state.droppedFiles
  const selection = () => state.editorContext.selection
  const hasContext = () => files().length > 0 || !!selection()

  return (
    <Show when={hasContext()}>
      <div class="border-t border-vscode-border px-3 py-2">
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-medium uppercase tracking-[0.08em] text-vscode-muted">Context</span>
          <div class="flex flex-1 flex-wrap gap-1 overflow-hidden">
            <Show when={selection()}>
              <ContextChip
                label={`Selection L${selection()!.startLine}-${selection()!.endLine}`}
                onRemove={() => {}}
              />
            </Show>
            <For each={files()}>
              {(file) => (
                <ContextChip
                  label={file.relativePath}
                  onRemove={() => removeContextFile(file.path)}
                />
              )}
            </For>
          </div>
          <button
            class="shrink-0 rounded-md p-1 text-vscode-muted hover:bg-vscode-hover hover:text-vscode-error"
            onClick={clearContextFiles}
            title="Clear all context"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
            </svg>
          </button>
        </div>
      </div>
    </Show>
  )
}

function ContextChip(props: { label: string; onRemove: () => void }) {
  return (
    <span class="inline-flex items-center gap-1 rounded-md border border-vscode-border bg-vscode-card px-2 py-1 text-[11px] text-vscode-fg">
      <span class="max-w-[140px] truncate">{props.label}</span>
      <button
        class="text-vscode-muted hover:text-vscode-error"
        onClick={props.onRemove}
      >
        <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
        </svg>
      </button>
    </span>
  )
}
