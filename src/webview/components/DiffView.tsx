import { For } from 'solid-js';
import type { FileDiff } from '../types';

export function DiffView(props: { diffs: FileDiff[] }) {
  return (
    <div class="my-1 rounded border border-vscode-border/15 bg-vscode-card/5 overflow-hidden">
      <div class="flex items-center justify-between border-b border-vscode-border/10 px-2.5 py-1.5">
        <span class="text-[11px] font-medium text-vscode-fg">Changes</span>
        <span class="text-[10px] text-vscode-muted/40">
          {props.diffs.length} file{props.diffs.length !== 1 ? 's' : ''}
        </span>
      </div>
      <For each={props.diffs}>{(diff) => <DiffItem diff={diff} />}</For>
    </div>
  );
}

function DiffItem(props: { diff: FileDiff }) {
  return (
    <div class="flex items-center justify-between border-t border-vscode-border/8 px-2.5 py-1 text-[11px] transition-colors hover:bg-vscode-hover/20">
      <span class="truncate text-vscode-fg/80">{props.diff.file}</span>
      <span class="ml-2 shrink-0 font-mono text-[10px] tabular-nums">
        <span class="text-vscode-success">+{props.diff.additions}</span>
        <span class="mx-0.5 text-vscode-muted/20">/</span>
        <span class="text-vscode-error">-{props.diff.deletions}</span>
      </span>
    </div>
  );
}
