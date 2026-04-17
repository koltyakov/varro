import { For } from "solid-js"
import type { FileDiff } from "../types"

export function DiffView(props: { diffs: FileDiff[] }) {
  return (
    <div class="my-2 border border-vscode-border">
      <div class="flex items-center justify-between bg-vscode-card px-3 py-1.5">
        <span class="text-[11px] font-medium text-vscode-fg">Changes</span>
        <span class="text-[10px] text-vscode-muted">
          {props.diffs.length} file{props.diffs.length !== 1 ? "s" : ""}
        </span>
      </div>
      <For each={props.diffs}>
        {(diff) => <DiffItem diff={diff} />}
      </For>
    </div>
  )
}

function DiffItem(props: { diff: FileDiff }) {
  return (
    <div class="flex items-center justify-between border-t border-vscode-border px-3 py-1 text-[12px] transition-colors hover:bg-vscode-hover">
      <span class="truncate text-vscode-fg">{props.diff.file}</span>
      <span class="ml-2 shrink-0 text-[10px] font-mono">
        <span class="text-vscode-success">+{props.diff.additions}</span>
        <span class="mx-0.5 text-vscode-muted/40">/</span>
        <span class="text-vscode-error">-{props.diff.deletions}</span>
      </span>
    </div>
  )
}
