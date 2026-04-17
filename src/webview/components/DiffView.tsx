import { Show, For } from "solid-js"
import { state } from "../lib/state"
import type { FileDiff } from "../types"

export function DiffView(props: { diffs: FileDiff[] }) {
  return (
    <div class="mx-1 my-1 rounded border border-vscode-border">
      <div class="flex items-center justify-between border-b border-vscode-border px-2 py-1">
        <span class="text-xs font-medium">Changes</span>
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
  const stats = () =>
    `+${props.diff.additions} -${props.diff.deletions}`

  return (
    <div class="flex items-center justify-between px-2 py-1 text-xs hover:bg-vscode-hover">
      <span class="truncate text-vscode-fg">{props.diff.file}</span>
      <span class="shrink-0 text-[10px]">
        <span class="text-vscode-success">+{props.diff.additions}</span>
        <span class="mx-0.5 text-vscode-muted">/</span>
        <span class="text-vscode-error">-{props.diff.deletions}</span>
      </span>
    </div>
  )
}
