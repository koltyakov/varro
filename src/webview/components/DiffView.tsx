import { For, Show, createMemo } from 'solid-js';
import { postMessage } from '../lib/bridge';
import type { FileDiff } from '../types';

type UnifiedDiffLine = {
  kind: 'context' | 'addition' | 'deletion' | 'hunk';
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

const MAX_FALLBACK_DIFF_CELLS = 1_000_000;
const DIFF_CONTEXT_LINES = 3;

export function parseUnifiedPatch(patch: string | undefined): UnifiedDiffLine[] {
  if (!patch) return [];

  const lines: UnifiedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let insideHunk = false;

  for (const rawLine of patch.replace(/\r\n/g, '\n').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(rawLine);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      insideHunk = true;
      lines.push({ kind: 'hunk', content: rawLine, oldLine: null, newLine: null });
      continue;
    }
    if (!insideHunk || rawLine === '\\ No newline at end of file') continue;

    if (rawLine.startsWith('+')) {
      lines.push({ kind: 'addition', content: rawLine.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (rawLine.startsWith('-')) {
      lines.push({ kind: 'deletion', content: rawLine.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (rawLine.startsWith(' ')) {
      lines.push({ kind: 'context', content: rawLine.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  if (lines.length > 0) return lines;

  for (const rawLine of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (rawLine.startsWith('@@')) {
      lines.push({ kind: 'hunk', content: rawLine, oldLine: null, newLine: null });
    } else if (rawLine.startsWith('+')) {
      lines.push({ kind: 'addition', content: rawLine.slice(1), oldLine: null, newLine: null });
    } else if (rawLine.startsWith('-')) {
      lines.push({ kind: 'deletion', content: rawLine.slice(1), oldLine: null, newLine: null });
    } else if (rawLine.startsWith(' ')) {
      lines.push({ kind: 'context', content: rawLine.slice(1), oldLine: null, newLine: null });
    }
  }

  return lines;
}

export function getDiffLines(diff: FileDiff): UnifiedDiffLine[] {
  const patchLines = parseUnifiedPatch(diff.patch);
  if (patchLines.length > 0) return patchLines;
  if (diff.before === undefined || diff.after === undefined || diff.before === diff.after)
    return [];

  const before = splitFileLines(diff.before);
  const after = splitFileLines(diff.after);
  if ((before.length + 1) * (after.length + 1) > MAX_FALLBACK_DIFF_CELLS) return [];

  const width = after.length + 1;
  const commonLengths = new Uint32Array((before.length + 1) * width);
  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
      const index = oldIndex * width + newIndex;
      commonLengths[index] =
        before[oldIndex] === after[newIndex]
          ? commonLengths[(oldIndex + 1) * width + newIndex + 1]! + 1
          : Math.max(
              commonLengths[(oldIndex + 1) * width + newIndex]!,
              commonLengths[oldIndex * width + newIndex + 1]!
            );
    }
  }

  const allLines: UnifiedDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < before.length || newIndex < after.length) {
    if (
      oldIndex < before.length &&
      newIndex < after.length &&
      before[oldIndex] === after[newIndex]
    ) {
      allLines.push({
        kind: 'context',
        content: before[oldIndex]!,
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < after.length &&
      (oldIndex === before.length ||
        commonLengths[oldIndex * width + newIndex + 1]! >
          commonLengths[(oldIndex + 1) * width + newIndex]!)
    ) {
      allLines.push({
        kind: 'addition',
        content: after[newIndex]!,
        oldLine: null,
        newLine: newIndex + 1,
      });
      newIndex += 1;
    } else {
      allLines.push({
        kind: 'deletion',
        content: before[oldIndex]!,
        oldLine: oldIndex + 1,
        newLine: null,
      });
      oldIndex += 1;
    }
  }

  return addDiffHunks(allLines);
}

function splitFileLines(content: string) {
  if (!content) return [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function addDiffHunks(lines: UnifiedDiffLine[]): UnifiedDiffLine[] {
  const changedIndexes = lines
    .map((line, index) => (line.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(lines.length, index + DIFF_CONTEXT_LINES + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }

  return ranges.flatMap(({ start, end }) => {
    const hunkLines = lines.slice(start, end);
    const oldStart = hunkLines.find((line) => line.oldLine !== null)?.oldLine ?? 0;
    const newStart = hunkLines.find((line) => line.newLine !== null)?.newLine ?? 0;
    const oldCount = hunkLines.filter((line) => line.oldLine !== null).length;
    const newCount = hunkLines.filter((line) => line.newLine !== null).length;
    return [
      {
        kind: 'hunk' as const,
        content: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
        oldLine: null,
        newLine: null,
      },
      ...hunkLines,
    ];
  });
}

export function DiffView(props: { diffs: FileDiff[]; showChanges?: boolean }) {
  return (
    <div class={`diff-view-widget${props.showChanges ? ' diff-view-widget-inline' : ''}`}>
      <For each={props.diffs}>
        {(diff) => <DiffItem diff={diff} showChanges={props.showChanges} />}
      </For>
    </div>
  );
}

function DiffItem(props: { diff: FileDiff; showChanges?: boolean }) {
  const file = () => props.diff.file;
  const lines = createMemo(() => getDiffLines(props.diff));
  const hasLineNumbers = createMemo(() =>
    lines().some((line) => line.oldLine !== null || line.newLine !== null)
  );
  const openFile = () => {
    const path = file();
    if (!path) return;
    postMessage({ type: 'vscode/open', payload: { path, kind: 'file', view: 'diff' } });
  };

  return (
    <div class="diff-view-file">
      <button
        type="button"
        class="diff-view-item diff-view-item-button"
        onClick={openFile}
        disabled={!file()}
        title={file() ? 'Open full diff' : undefined}
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
      <Show when={props.showChanges && lines().length > 0}>
        <div
          class={`diff-view-lines${hasLineNumbers() ? '' : ' diff-view-lines-unnumbered'}`}
          role="table"
          tabIndex={0}
          aria-label={`Changes in ${file() || 'file'}`}
        >
          <div class="diff-view-lines-content">
            <For each={lines()}>
              {(line) => (
                <div class={`diff-view-line diff-view-line-${line.kind}`} role="row">
                  <span class="diff-view-line-number" aria-hidden="true">
                    {line.oldLine ?? ''}
                  </span>
                  <span class="diff-view-line-number" aria-hidden="true">
                    {line.newLine ?? ''}
                  </span>
                  <span class="diff-view-line-marker" aria-hidden="true">
                    {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '}
                  </span>
                  <span class="diff-view-line-content">{line.content}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
