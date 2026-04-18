import { For } from "solid-js"
import type { FileDiff } from "../types"

export function DiffView(props: { diffs: FileDiff[] }) {
  return (
    <div class="my-2 rounded-lg border border-vscode-border/35 bg-vscode-card/12 overflow-hidden">
      <div class="flex items-center justify-between border-b border-vscode-border/25 bg-vscode-card/35 px-3 py-2">
        <span class="text-[12px] font-medium text-vscode-fg">Changes</span>
        <span class="text-[11px] text-vscode-muted">
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
    <div class="flex items-center justify-between border-t border-vscode-border/20 px-3 py-1.5 text-[12px] transition-colors hover:bg-vscode-hover/30">
      <span class="truncate text-vscode-fg">{props.diff.file}</span>
      <span class="ml-3 shrink-0 font-mono text-[11px]">
        <span class="text-vscode-success">+{props.diff.additions}</span>
        <span class="mx-0.5 text-vscode-muted/30">/</span>
        <span class="text-vscode-error">-{props.diff.deletions}</span>
      </span>
    </div>
  )
}
