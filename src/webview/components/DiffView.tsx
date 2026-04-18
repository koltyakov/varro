import { For } from "solid-js"
import type { FileDiff } from "../types"

export function DiffView(props: { diffs: FileDiff[] }) {
  return (
    <div class="my-3 border border-vscode-border/45 bg-vscode-card/18">
      <div class="flex items-center justify-between border-b border-vscode-border/30 bg-vscode-card/45 px-3 py-2.5">
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
    <div class="flex items-center justify-between border-t border-vscode-border/30 px-3 py-2 text-[12px] transition-colors hover:bg-vscode-hover/35">
      <span class="truncate text-vscode-fg">{props.diff.file}</span>
      <span class="ml-3 shrink-0 font-mono text-[11px]">
        <span class="text-vscode-success">+{props.diff.additions}</span>
        <span class="mx-0.5 text-vscode-muted/40">/</span>
        <span class="text-vscode-error">-{props.diff.deletions}</span>
      </span>
    </div>
  )
}
