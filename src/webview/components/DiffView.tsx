import { For } from 'solid-js';
import { postMessage } from '../lib/bridge';
import type { FileDiff } from '../types';

export function DiffView(props: { diffs: FileDiff[] }) {
  return (
    <div class="diff-view-widget">
      <For each={props.diffs}>{(diff) => <DiffItem diff={diff} />}</For>
    </div>
  );
}

function DiffItem(props: { diff: FileDiff }) {
  const file = () => props.diff.file;
  const openFile = () => {
    const path = file();
    if (!path) return;
    postMessage({ type: 'vscode/open', payload: { path, kind: 'file', view: 'diff' } });
  };

  return (
    <button
      type="button"
      class="diff-view-item diff-view-item-button"
      onClick={openFile}
      disabled={!file()}
    >
      <svg
        class="diff-view-icon"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M9 1H4.5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5L9 1z" />
        <path d="M9 1v4h3.5" />
      </svg>
      <span class="diff-view-filename">{file() || 'Unknown file'}</span>
      <span class="diff-view-stats">
        <span class="diff-lines-added">+{props.diff.additions}</span>{' '}
        <span class="diff-lines-removed">-{props.diff.deletions}</span>
      </span>
    </button>
  );
}
