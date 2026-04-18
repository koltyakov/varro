import { For } from 'solid-js';
import type { FileDiff } from '../types';

export function DiffView(props: { diffs: FileDiff[] }) {
  return (
    <div class="my-1 rounded border border-vscode-border/20 bg-vscode-card/8 overflow-hidden">
      <div class="flex items-center justify-between border-b border-vscode-border/15 px-2.5 py-1.5">
        <span class="text-[11px] font-medium text-vscode-fg">Changes</span>
        <span class="text-[10px] text-vscode-muted/60">
          {props.diffs.length} file{props.diffs.length !== 1 ? 's' : ''}
        </span>
      </div>
      <For each={props.diffs}>{(diff) => <DiffItem diff={diff} />}</For>
    </div>
  );
}

function DiffItem(props: { diff: FileDiff }) {
  return (
    <div class="flex items-center justify-between border-t border-vscode-border/10 px-2.5 py-1.5 text-[11px] transition-colors hover:bg-vscode-hover/30">
      <div class="flex min-w-0 items-center gap-1.5">
        <svg class="h-3 w-3 shrink-0 text-vscode-muted/50" viewBox="0 0 16 16" fill="currentColor">
          <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
        </svg>
        <span class="truncate text-vscode-fg/80">{props.diff.file}</span>
      </div>
      <span class="ml-2 shrink-0 font-mono text-[10px] tabular-nums">
        <span class="text-vscode-success">+{props.diff.additions}</span>
        <span class="mx-0.5 text-vscode-muted/30">/</span>
        <span class="text-vscode-error">-{props.diff.deletions}</span>
      </span>
    </div>
  );
}
