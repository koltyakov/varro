import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { postMessage } from '../lib/bridge';
import { setExpandedDiffOverlay } from '../lib/diff-overlay-state';
import { trapModalFocus } from '../lib/modal-focus';
import { getLeafPathName } from '../lib/path-display';
import { observeSettledResize } from '../lib/settled-resize-observer';
import { getToolDiffPreviewState, setToolDiffPreviewState } from '../lib/tool-call-expansion-state';
import { state } from '../lib/state';
import type { FileDiff } from '../types';
import { FileTypeIcon } from './FileTypeIcon';
import { renderHighlightedCodeHtml } from './MarkdownRenderer';

type UnifiedDiffLine = {
  kind: 'context' | 'addition' | 'deletion' | 'hunk';
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

type DiffDisplayLine =
  | UnifiedDiffLine
  | {
      kind: 'gap';
      content: string;
      oldLine: null;
      newLine: null;
    };

type UnifiedDiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
};

export type DiffViewFile = FileDiff & {
  changeKind?: 'added' | 'edited' | 'removed' | 'moved';
  fromFile?: string;
  previewStatus?: 'unavailable' | 'truncated';
  previewMessage?: string;
  patchFormat?: 'headerless' | 'unified';
};

type DiffPreviewResult = {
  status: 'ready' | 'unavailable' | 'truncated';
  lines: UnifiedDiffLine[];
  message?: string;
};

type DiffWorkBudget = {
  textBytes: number;
  textLines: number;
  lcsCells: number;
};

type MeasuredText = {
  bytes: number;
  lines: number;
  exceeded: 'bytes' | 'lines' | null;
};

type PreparedDiff = {
  diff: DiffViewFile;
  preview: DiffPreviewResult | null;
};

type RenderedDiffLine = {
  line: DiffDisplayLine;
  index: number;
};

type DiffScrollThumb = {
  size: number;
  offset: number;
};

type DiffScrollAxis = 'vertical' | 'horizontal';

type DiffScrollDrag = {
  axis: DiffScrollAxis;
  pointerId: number;
  startPointer: number;
  startScroll: number;
  maxScroll: number;
  scrollPerPixel: number;
};

const MAX_PATCH_BYTES = 256 * 1024;
const MAX_PATCH_LINES = 2_000;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_SNAPSHOT_LINES = 2_000;
const MAX_DIFF_VIEW_TEXT_BYTES = 512 * 1024;
const MAX_DIFF_VIEW_TEXT_LINES = 4_000;
const MAX_FALLBACK_DIFF_CELLS = 250_000;
const MAX_DIFF_VIEW_LCS_CELLS = 500_000;
const DIFF_CONTEXT_LINES = 3;
const COLLAPSED_DIFF_LINE_COUNT = 6;
const DIFF_FILE_TYPE_OVERRIDES: Record<string, { label?: string; language?: string }> = {
  cc: { label: 'C++', language: 'cpp' },
  cjs: { language: 'javascript' },
  cpp: { label: 'C++' },
  cs: { label: 'C#', language: 'csharp' },
  cts: { language: 'typescript' },
  cxx: { label: 'C++', language: 'cpp' },
  gql: { language: 'graphql' },
  h: { language: 'c' },
  hpp: { label: 'C++', language: 'cpp' },
  htm: { label: '<>' },
  html: { label: '<>' },
  js: { language: 'javascript' },
  json: { label: '{}' },
  jsonc: { label: '{}', language: 'json' },
  jsx: { language: 'javascript' },
  kt: { language: 'kotlin' },
  kts: { language: 'kotlin' },
  mdx: { language: 'markdown' },
  mjs: { language: 'javascript' },
  mts: { language: 'typescript' },
  pl: { language: 'perl' },
  pyi: { language: 'python' },
  rb: { language: 'ruby' },
  rs: { language: 'rust' },
  sass: { language: 'scss' },
  svelte: { label: '<>', language: 'xml' },
  svg: { label: '<>', language: 'xml' },
  toml: { language: 'ini' },
  ts: { language: 'typescript' },
  tsx: { language: 'typescript' },
  vb: { language: 'vbnet' },
  vue: { label: '<>', language: 'xml' },
  xml: { label: '<>' },
};
const DIFF_SPECIAL_FILE_TYPES: Record<string, { label: string; language?: string }> = {
  makefile: { label: 'MK', language: 'makefile' },
};

function getDiffFileType(file: string | undefined) {
  if (!file) return null;

  const filename = getLeafPathName(file).toLowerCase();
  const specialType = DIFF_SPECIAL_FILE_TYPES[filename];
  if (specialType) return specialType;

  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === filename.length - 1) return null;

  const extension = filename.slice(dotIndex + 1);
  const override = DIFF_FILE_TYPE_OVERRIDES[extension];
  return {
    label: override?.label ?? extension.slice(0, 3).toUpperCase(),
    language: override?.language ?? extension,
  };
}

function parseUnifiedHunk(line: string): UnifiedDiffHunk | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return null;

  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function getDisplayDiffLines(lines: UnifiedDiffLine[]): DiffDisplayLine[] {
  const displayLines: DiffDisplayLine[] = [];
  let previousHunk: UnifiedDiffHunk | null = null;

  for (const line of lines) {
    if (line.kind !== 'hunk') {
      displayLines.push(line);
      continue;
    }

    const hunk = parseUnifiedHunk(line.content);
    if (hunk && previousHunk) {
      const oldGap = hunk.oldStart - (previousHunk.oldStart + previousHunk.oldCount);
      const newGap = hunk.newStart - (previousHunk.newStart + previousHunk.newCount);
      const unchangedLines = Math.min(oldGap, newGap);
      if (unchangedLines > 0) {
        displayLines.push({
          kind: 'gap',
          content: `${unchangedLines} unmodified line${unchangedLines === 1 ? '' : 's'}`,
          oldLine: null,
          newLine: null,
        });
      }
    }
    previousHunk = hunk;
  }

  return displayLines;
}

function getScrollThumb(
  viewportSize: number,
  scrollSize: number,
  scrollOffset: number,
  minimumSize: number
): DiffScrollThumb | null {
  if (scrollSize <= viewportSize + 1) return null;

  const trackSize = Math.max(0, viewportSize - 4);
  const size = Math.min(trackSize, Math.max(minimumSize, (trackSize * viewportSize) / scrollSize));
  const maxScrollOffset = scrollSize - viewportSize;
  const offset = 2 + ((trackSize - size) * scrollOffset) / maxScrollOffset;
  return { size, offset };
}

function scrollDiffToFirstChange(viewport: HTMLDivElement | undefined) {
  const anchor = viewport?.querySelector<HTMLElement>('.diff-view-scroll-anchor');
  if (!viewport || !anchor) return;
  viewport.scrollTop = anchor.offsetTop;
  viewport.scrollLeft = 0;
}

export function parseUnifiedPatch(
  patch: string | undefined,
  options?: { headerless?: boolean }
): UnifiedDiffLine[] {
  if (!patch) return [];

  const patchLines = patch.replace(/\r\n/g, '\n').split('\n');
  const lines: UnifiedDiffLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let oldRemaining: number | null = null;
  let newRemaining: number | null = null;
  let insideHunk = false;
  let sawHunk = false;

  for (const rawLine of patchLines) {
    if (rawLine.startsWith('@@')) {
      const hunk = parseUnifiedHunk(rawLine);
      oldLine = hunk?.oldStart ?? null;
      newLine = hunk?.newStart ?? null;
      oldRemaining = hunk?.oldCount ?? null;
      newRemaining = hunk?.newCount ?? null;
      insideHunk = true;
      sawHunk = true;
      lines.push({ kind: 'hunk', content: rawLine, oldLine: null, newLine: null });
      continue;
    }
    if (!insideHunk || rawLine === '\\ No newline at end of file') continue;
    if (oldRemaining === 0 && newRemaining === 0) {
      insideHunk = false;
      continue;
    }

    if (rawLine.startsWith('+')) {
      lines.push({ kind: 'addition', content: rawLine.slice(1), oldLine: null, newLine });
      if (newLine !== null) newLine += 1;
      if (newRemaining !== null) newRemaining = Math.max(0, newRemaining - 1);
    } else if (rawLine.startsWith('-')) {
      lines.push({ kind: 'deletion', content: rawLine.slice(1), oldLine, newLine: null });
      if (oldLine !== null) oldLine += 1;
      if (oldRemaining !== null) oldRemaining = Math.max(0, oldRemaining - 1);
    } else if (rawLine.startsWith(' ')) {
      lines.push({ kind: 'context', content: rawLine.slice(1), oldLine, newLine });
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
      if (oldRemaining !== null) oldRemaining = Math.max(0, oldRemaining - 1);
      if (newRemaining !== null) newRemaining = Math.max(0, newRemaining - 1);
    }
  }

  if (sawHunk) return lines;
  if ((!options?.headerless && hasUnifiedFileHeaders(patchLines)) || isBinaryPatch(patchLines)) {
    return [];
  }

  for (const rawLine of patchLines) {
    if (rawLine === '\\ No newline at end of file') continue;
    if (rawLine.startsWith('+')) {
      lines.push({ kind: 'addition', content: rawLine.slice(1), oldLine: null, newLine: null });
    } else if (rawLine.startsWith('-')) {
      lines.push({ kind: 'deletion', content: rawLine.slice(1), oldLine: null, newLine: null });
    } else if (rawLine.startsWith(' ')) {
      lines.push({ kind: 'context', content: rawLine.slice(1), oldLine: null, newLine: null });
    }
  }

  return lines;
}

function hasUnifiedFileHeaders(lines: readonly string[]) {
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (
      isCanonicalUnifiedHeader(lines[index]!, '---', 'a') &&
      isCanonicalUnifiedHeader(lines[index + 1]!, '+++', 'b')
    ) {
      return true;
    }
  }
  return false;
}

function isCanonicalUnifiedHeader(line: string, marker: '---' | '+++', prefix: 'a' | 'b') {
  if (!line.startsWith(`${marker} `)) return false;
  const path = line.slice(marker.length + 1).trimStart();
  return (
    path.startsWith('/dev/null') || path.startsWith(`${prefix}/`) || path.startsWith(`"${prefix}/`)
  );
}

function isBinaryPatch(lines: readonly string[]) {
  return lines.some(
    (line) =>
      /^Binary files .+ differ$/i.test(line) ||
      /^GIT binary patch$/i.test(line) ||
      /^literal \d+$/i.test(line)
  );
}

function measureText(content: string, maxBytes: number, maxLines: number): MeasuredText {
  let bytes = 0;
  let lines = content.length > 0 ? 1 : 0;
  if (lines > maxLines) return { bytes, lines, exceeded: 'lines' };

  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }

    if (bytes > maxBytes) return { bytes, lines, exceeded: 'bytes' };
    if (code === 10 || (code === 13 && content.charCodeAt(index + 1) !== 10)) {
      lines += 1;
      if (lines > maxLines) return { bytes, lines, exceeded: 'lines' };
    }
  }

  return { bytes, lines, exceeded: null };
}

function unavailablePreview(message: string): DiffPreviewResult {
  return { status: 'unavailable', lines: [], message };
}

function truncatedPreview(message: string): DiffPreviewResult {
  return { status: 'truncated', lines: [], message };
}

function previewKind(diff: DiffViewFile) {
  if (diff.changeKind) return diff.changeKind;
  if (diff.status === 'added') return 'added';
  if (diff.status === 'deleted') return 'removed';
  return 'edited';
}

function getDiffPreview(diff: DiffViewFile, budget: DiffWorkBudget): DiffPreviewResult {
  if (diff.previewStatus) {
    return {
      status: diff.previewStatus,
      lines: [],
      message: diff.previewMessage || 'Text preview unavailable for this change.',
    };
  }

  let patchUnavailableMessage: string | undefined;
  if (diff.patch !== undefined) {
    const measured = measureText(diff.patch, MAX_PATCH_BYTES, MAX_PATCH_LINES);
    if (measured.exceeded) {
      return truncatedPreview(
        `Preview truncated: patch exceeds ${MAX_PATCH_LINES.toLocaleString()} lines or 256 KB.`
      );
    }
    if (measured.bytes > budget.textBytes || measured.lines > budget.textLines) {
      return truncatedPreview('Preview truncated: inline diff work limit reached.');
    }
    budget.textBytes -= measured.bytes;
    budget.textLines -= measured.lines;

    const patchLines = parseUnifiedPatch(diff.patch, {
      headerless: diff.patchFormat === 'headerless',
    });
    if (patchLines.some((line) => line.kind === 'addition' || line.kind === 'deletion')) {
      return { status: 'ready', lines: patchLines };
    }
    if (isBinaryPatch(diff.patch.replace(/\r\n/g, '\n').split('\n'))) {
      return unavailablePreview('Binary file changed; text preview unavailable.');
    }
    patchUnavailableMessage = 'Text preview unavailable for this patch.';
  }

  let before = diff.before;
  let after = diff.after;
  const kind = previewKind(diff);
  if (kind === 'added' && before === undefined && after !== undefined) before = '';
  if (kind === 'removed' && after === undefined && before !== undefined) after = '';

  if (before === undefined || after === undefined) {
    if (before === undefined && after !== undefined) {
      return unavailablePreview('Previous content was not provided; text preview unavailable.');
    }
    if (after === undefined && before !== undefined) {
      return unavailablePreview('Updated content was not provided; text preview unavailable.');
    }
    if (kind === 'moved') return unavailablePreview('File moved; no text preview available.');
    return unavailablePreview(
      patchUnavailableMessage || 'Text preview unavailable for this change.'
    );
  }
  if (before === after) return unavailablePreview('No textual changes to preview.');

  const beforeMeasured = measureText(before, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_LINES);
  if (beforeMeasured.exceeded) {
    return truncatedPreview('Preview truncated: file snapshots exceed inline preview limits.');
  }
  const afterMeasured = measureText(
    after,
    MAX_SNAPSHOT_BYTES - beforeMeasured.bytes,
    MAX_SNAPSHOT_LINES - beforeMeasured.lines
  );
  if (afterMeasured.exceeded) {
    return truncatedPreview('Preview truncated: file snapshots exceed inline preview limits.');
  }
  const snapshotBytes = beforeMeasured.bytes + afterMeasured.bytes;
  const snapshotLines = beforeMeasured.lines + afterMeasured.lines;
  if (snapshotBytes > budget.textBytes || snapshotLines > budget.textLines) {
    return truncatedPreview('Preview truncated: inline diff work limit reached.');
  }
  budget.textBytes -= snapshotBytes;
  budget.textLines -= snapshotLines;

  const beforeLines = splitFileLines(before);
  const afterLines = splitFileLines(after);
  const lcsCells = (beforeLines.length + 1) * (afterLines.length + 1);
  if (lcsCells > MAX_FALLBACK_DIFF_CELLS || lcsCells > budget.lcsCells) {
    return unavailablePreview('Files are too large to compare in an inline preview.');
  }
  budget.lcsCells -= lcsCells;

  const width = afterLines.length + 1;
  const commonLengths = new Uint32Array(lcsCells);
  for (let oldIndex = beforeLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = afterLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const index = oldIndex * width + newIndex;
      commonLengths[index] =
        beforeLines[oldIndex] === afterLines[newIndex]
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
  while (oldIndex < beforeLines.length || newIndex < afterLines.length) {
    if (
      oldIndex < beforeLines.length &&
      newIndex < afterLines.length &&
      beforeLines[oldIndex] === afterLines[newIndex]
    ) {
      allLines.push({
        kind: 'context',
        content: beforeLines[oldIndex]!,
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < afterLines.length &&
      (oldIndex === beforeLines.length ||
        commonLengths[oldIndex * width + newIndex + 1]! >
          commonLengths[(oldIndex + 1) * width + newIndex]!)
    ) {
      allLines.push({
        kind: 'addition',
        content: afterLines[newIndex]!,
        oldLine: null,
        newLine: newIndex + 1,
      });
      newIndex += 1;
    } else {
      allLines.push({
        kind: 'deletion',
        content: beforeLines[oldIndex]!,
        oldLine: oldIndex + 1,
        newLine: null,
      });
      oldIndex += 1;
    }
  }

  return { status: 'ready', lines: addDiffHunks(allLines) };
}

export function getDiffLines(diff: FileDiff): UnifiedDiffLine[] {
  return getDiffPreview(diff, {
    textBytes: MAX_DIFF_VIEW_TEXT_BYTES,
    textLines: MAX_DIFF_VIEW_TEXT_LINES,
    lcsCells: MAX_DIFF_VIEW_LCS_CELLS,
  }).lines;
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

function getDiffLineAriaLabel(line: UnifiedDiffLine) {
  if (line.kind !== 'addition' && line.kind !== 'deletion') return undefined;
  const lineNumber = line.kind === 'addition' ? line.newLine : line.oldLine;
  const label = line.kind === 'addition' ? 'Added' : 'Deleted';
  return `${label}${lineNumber === null ? ' line' : ` line ${lineNumber}`}: ${line.content}`;
}

function DiffLinesContent(props: {
  entries: readonly RenderedDiffLine[];
  firstChangeIndex: number;
  language?: string;
}) {
  return (
    <div class="diff-view-lines-content" role="list">
      <For each={props.entries}>
        {(entry) =>
          entry.line.kind === 'gap' ? (
            <div
              class={`diff-view-gap${entry.index === Math.max(0, props.firstChangeIndex) ? ' diff-view-scroll-anchor' : ''}`}
              role="listitem"
            >
              {entry.line.content}
            </div>
          ) : (
            <div
              class={`diff-view-line diff-view-line-${entry.line.kind}${entry.index === Math.max(0, props.firstChangeIndex) ? ' diff-view-scroll-anchor' : ''}`}
              role="listitem"
              aria-label={getDiffLineAriaLabel(entry.line)}
            >
              <span class="diff-view-line-number" aria-hidden="true">
                {entry.line.newLine ?? entry.line.oldLine ?? ''}
              </span>
              <span class="diff-view-line-marker" aria-hidden="true">
                {entry.line.kind === 'addition' ? '+' : entry.line.kind === 'deletion' ? '-' : ' '}
              </span>
              <HighlightedDiffLineContent content={entry.line.content} language={props.language} />
            </div>
          )
        }
      </For>
    </div>
  );
}

function HighlightedDiffLineContent(props: { content: string; language?: string }) {
  const html = createMemo(() => renderHighlightedCodeHtml(props.content, props.language));
  return <span class="diff-view-line-content hljs" innerHTML={html()} />;
}

export function DiffView(props: {
  diffs: readonly DiffViewFile[];
  showChanges?: boolean;
  stateKey?: string;
}) {
  const preparedDiffs = createMemo<PreparedDiff[]>(() => {
    if (!props.showChanges) {
      return props.diffs.map((diff) => ({ diff, preview: null }));
    }

    const budget: DiffWorkBudget = {
      textBytes: MAX_DIFF_VIEW_TEXT_BYTES,
      textLines: MAX_DIFF_VIEW_TEXT_LINES,
      lcsCells: MAX_DIFF_VIEW_LCS_CELLS,
    };
    return props.diffs.map((diff) => ({ diff, preview: getDiffPreview(diff, budget) }));
  });

  return (
    <div class={`diff-view-widget${props.showChanges ? ' diff-view-widget-inline' : ''}`}>
      <Index each={preparedDiffs()}>
        {(prepared, index) => (
          <DiffItem
            diff={prepared().diff}
            preview={prepared().preview}
            showChanges={props.showChanges}
            stateKey={
              props.stateKey
                ? `${props.stateKey}\u0000${prepared().diff.file || `unknown:${index}`}`
                : undefined
            }
          />
        )}
      </Index>
    </div>
  );
}

function DiffItem(props: {
  diff: DiffViewFile;
  preview: DiffPreviewResult | null;
  showChanges?: boolean;
  stateKey?: string;
}) {
  let linesViewport: HTMLDivElement | undefined;
  let overlayViewport: HTMLDivElement | undefined;
  let fileElement: HTMLDivElement | undefined;
  let toggleButton: HTMLButtonElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  const [viewportElement, setViewportElement] = createSignal<HTMLDivElement>();
  const [overlayViewportElement, setOverlayViewportElement] = createSignal<HTMLDivElement>();
  const [overlayMount, setOverlayMount] = createSignal<HTMLElement>();
  const overlayOwner = Symbol();
  let scrollDrag: DiffScrollDrag | null = null;
  // The parent builds `stateKey` from a dynamic expression, so reading
  // `props.stateKey` allocates a fresh computation on every access. Scroll and
  // resize callbacks run without an owner, where those computations would never
  // be disposed, so resolve the prop once here and read the memo everywhere else.
  const stateKey = createMemo(() => props.stateKey);
  let renderedFile = props.diff.file;
  let renderedStateKey = stateKey();
  let previewStateReady = !stateKey();
  const initialPreviewState = stateKey() ? getToolDiffPreviewState(stateKey()!) : null;
  let restoreExpandedScroll = initialPreviewState?.expanded ?? false;
  const file = () => props.diff.file;
  const fromFile = () => props.diff.fromFile;
  const displayName = () => {
    const path = file();
    if (!path) return 'Unknown file';
    const sourcePath = fromFile();
    const formatPath = props.showChanges ? getLeafPathName : (value: string) => value;
    return sourcePath && sourcePath !== path
      ? `${formatPath(sourcePath)} -> ${formatPath(path)}`
      : formatPath(path);
  };
  const fileType = createMemo(() => getDiffFileType(file()));
  const lines = createMemo(() => props.preview?.lines ?? []);
  const displayLines = createMemo(() => getDisplayDiffLines(lines()));
  const firstChangeIndex = createMemo(() =>
    displayLines().findIndex((line) => line.kind === 'addition' || line.kind === 'deletion')
  );
  const canExpand = createMemo(
    () => displayLines().length > COLLAPSED_DIFF_LINE_COUNT || firstChangeIndex() > 0
  );
  const [expanded, setExpanded] = createSignal(initialPreviewState?.expanded ?? false);
  const [verticalThumb, setVerticalThumb] = createSignal<DiffScrollThumb | null>(null);
  const [horizontalThumb, setHorizontalThumb] = createSignal<DiffScrollThumb | null>(null);
  const renderedDisplayLines = createMemo(() => {
    const allLines = displayLines();
    const start = Math.max(0, firstChangeIndex());
    return allLines
      .slice(start, start + COLLAPSED_DIFF_LINE_COUNT)
      .map((line, index) => ({ line, index: start + index }));
  });
  const allDisplayLines = createMemo(() => displayLines().map((line, index) => ({ line, index })));
  const hasLineNumbers = createMemo(() =>
    renderedDisplayLines().some(({ line }) => line.oldLine !== null || line.newLine !== null)
  );
  const previewNotice = () =>
    props.showChanges && props.preview?.status !== 'ready' ? props.preview : null;
  const savePreviewState = () => {
    const key = stateKey();
    const viewport = expanded() ? overlayViewport : linesViewport;
    if (!key || !previewStateReady || !viewport) return;
    setToolDiffPreviewState(key, {
      expanded: expanded(),
      scrollTop: viewport.scrollTop,
      scrollLeft: viewport.scrollLeft,
    });
  };
  const resolveOverlayMount = () => {
    if (!fileElement?.isConnected) return;
    setOverlayMount(fileElement.closest<HTMLElement>('.interactive-list-shell') ?? document.body);
  };
  const updateScrollThumbs = () => {
    if (!linesViewport) return;
    setVerticalThumb(
      getScrollThumb(
        linesViewport.clientHeight,
        linesViewport.scrollHeight,
        linesViewport.scrollTop,
        28
      )
    );
    setHorizontalThumb(
      getScrollThumb(
        linesViewport.clientWidth,
        linesViewport.scrollWidth,
        linesViewport.scrollLeft,
        36
      )
    );
    savePreviewState();
  };
  const setExpandedState = (nextExpanded: boolean, restoreToggleFocus = true) => {
    restoreExpandedScroll = false;
    if (nextExpanded) resolveOverlayMount();
    setExpanded(nextExpanded);
    queueMicrotask(() => {
      if (nextExpanded) {
        closeButton?.focus({ preventScroll: true });
      } else if (linesViewport) {
        linesViewport.scrollTop = 0;
        linesViewport.scrollLeft = 0;
        if (restoreToggleFocus) toggleButton?.focus({ preventScroll: true });
      }
      savePreviewState();
      updateScrollThumbs();
    });
  };
  const toggleExpanded = () => setExpandedState(!expanded());
  const collapseExpanded = () => {
    if (expanded()) setExpandedState(false, false);
  };
  const scrollFromTrack = (
    axis: DiffScrollAxis,
    event: PointerEvent & { currentTarget: HTMLDivElement }
  ) => {
    if (!linesViewport || event.button !== 0) return;
    const thumb = axis === 'vertical' ? verticalThumb() : horizontalThumb();
    if (!thumb) return;

    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const viewportSize =
      axis === 'vertical' ? linesViewport.clientHeight : linesViewport.clientWidth;
    const scrollSize = axis === 'vertical' ? linesViewport.scrollHeight : linesViewport.scrollWidth;
    const trackSize = Math.max(0, viewportSize - 4);
    const thumbTravel = trackSize - thumb.size;
    if (thumbTravel <= 0) return;

    const pointer = axis === 'vertical' ? event.clientY - bounds.top : event.clientX - bounds.left;
    const thumbOffset = Math.max(0, Math.min(thumbTravel, pointer - 2 - thumb.size / 2));
    const nextScroll = (thumbOffset / thumbTravel) * (scrollSize - viewportSize);
    if (axis === 'vertical') linesViewport.scrollTop = nextScroll;
    else linesViewport.scrollLeft = nextScroll;
    linesViewport.focus({ preventScroll: true });
    updateScrollThumbs();
  };
  const beginScrollDrag = (
    axis: DiffScrollAxis,
    event: PointerEvent & { currentTarget: HTMLSpanElement }
  ) => {
    if (!linesViewport || event.button !== 0) return;
    const thumb = axis === 'vertical' ? verticalThumb() : horizontalThumb();
    if (!thumb) return;

    const viewportSize =
      axis === 'vertical' ? linesViewport.clientHeight : linesViewport.clientWidth;
    const scrollSize = axis === 'vertical' ? linesViewport.scrollHeight : linesViewport.scrollWidth;
    const thumbTravel = Math.max(0, viewportSize - 4 - thumb.size);
    const maxScroll = scrollSize - viewportSize;
    if (thumbTravel <= 0 || maxScroll <= 0) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    scrollDrag = {
      axis,
      pointerId: event.pointerId,
      startPointer: axis === 'vertical' ? event.clientY : event.clientX,
      startScroll: axis === 'vertical' ? linesViewport.scrollTop : linesViewport.scrollLeft,
      maxScroll,
      scrollPerPixel: maxScroll / thumbTravel,
    };
  };
  const moveScrollDrag = (event: PointerEvent) => {
    if (!linesViewport || !scrollDrag || event.pointerId !== scrollDrag.pointerId) return;
    event.preventDefault();
    const pointer = scrollDrag.axis === 'vertical' ? event.clientY : event.clientX;
    const nextScroll = Math.max(
      0,
      Math.min(
        scrollDrag.maxScroll,
        scrollDrag.startScroll + (pointer - scrollDrag.startPointer) * scrollDrag.scrollPerPixel
      )
    );
    if (scrollDrag.axis === 'vertical') linesViewport.scrollTop = nextScroll;
    else linesViewport.scrollLeft = nextScroll;
    updateScrollThumbs();
  };
  const endScrollDrag = (event: PointerEvent) => {
    if (!scrollDrag || event.pointerId !== scrollDrag.pointerId) return;
    scrollDrag = null;
  };
  const openFile = () => {
    const path = file();
    if (!path) return;
    postMessage({
      type: 'vscode/open',
      payload: {
        path,
        kind: 'file',
        view: 'diff',
        ...(state.activeSessionId ? { sessionID: state.activeSessionId } : {}),
      },
    });
  };
  const toggleExpandedFromPreview = () => {
    linesViewport?.focus({ preventScroll: true });
    if (window.getSelection()?.toString()) return;
    if (canExpand()) toggleExpanded();
  };

  createEffect(() => {
    const nextFile = file();
    const nextStateKey = stateKey();
    displayLines();
    const itemChanged = nextFile !== renderedFile || nextStateKey !== renderedStateKey;
    renderedFile = nextFile;
    renderedStateKey = nextStateKey;
    if (itemChanged) {
      const previewState = nextStateKey ? getToolDiffPreviewState(nextStateKey) : null;
      previewStateReady = !nextStateKey;
      restoreExpandedScroll = previewState?.expanded ?? false;
      setExpanded(previewState?.expanded ?? false);
      return;
    }
    queueMicrotask(() => {
      updateScrollThumbs();
    });
  });

  createEffect(() => {
    const viewport = viewportElement();
    if (!viewport) return;

    queueMicrotask(() => {
      if (viewport !== linesViewport || !viewport.isConnected) return;
      viewport.scrollTop = 0;
      viewport.scrollLeft = 0;
      previewStateReady = true;
      updateScrollThumbs();
    });

    onCleanup(observeSettledResize(viewport, updateScrollThumbs));
  });

  createEffect(() => {
    const viewport = overlayViewportElement();
    if (!expanded() || !viewport) return;
    const previewState = stateKey() ? getToolDiffPreviewState(stateKey()!) : null;

    queueMicrotask(() => {
      if (viewport !== overlayViewport || !viewport.isConnected || !expanded()) return;
      if (restoreExpandedScroll && previewState?.expanded) {
        viewport.scrollTop = previewState.scrollTop;
        viewport.scrollLeft = previewState.scrollLeft;
      } else {
        scrollDiffToFirstChange(viewport);
      }
      restoreExpandedScroll = true;
      previewStateReady = true;
      savePreviewState();
    });
  });

  createEffect(() => {
    if (!expanded()) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      toggleExpanded();
    };
    document.addEventListener('keydown', closeOnEscape, true);
    onCleanup(() => document.removeEventListener('keydown', closeOnEscape, true));
  });

  createEffect(() => {
    setExpandedDiffOverlay(overlayOwner, expanded(), collapseExpanded);
  });

  onCleanup(() => setExpandedDiffOverlay(overlayOwner, false));

  return (
    <div
      class="diff-view-file"
      ref={(element) => {
        fileElement = element;
        queueMicrotask(resolveOverlayMount);
      }}
    >
      <div
        class={`diff-view-item${canExpand() ? ' diff-view-item-expandable' : ''}`}
        onClick={() => {
          if (canExpand()) toggleExpanded();
        }}
      >
        <FileTypeIcon path={file()} class="diff-view-icon" />
        <span class="diff-view-filename-slot">
          <button
            type="button"
            class="diff-view-filename"
            onClick={(event) => {
              event.stopPropagation();
              openFile();
            }}
            disabled={!file()}
            title={
              file()
                ? `Open full diff: ${fromFile() ? `${fromFile()} -> ${file()}` : file()}`
                : undefined
            }
          >
            {displayName()}
          </button>
        </span>
        <Show when={props.diff.additions > 0 || props.diff.deletions > 0}>
          <span class="diff-view-stats">
            <Show when={props.diff.additions > 0}>
              <span class="diff-lines-added">+{props.diff.additions}</span>
            </Show>
            <Show when={props.diff.deletions > 0}>
              <span class="diff-lines-removed">-{props.diff.deletions}</span>
            </Show>
          </span>
        </Show>
        <Show when={canExpand()}>
          <button
            ref={(element) => {
              toggleButton = element;
            }}
            type="button"
            class="diff-view-toggle"
            aria-expanded={expanded()}
            aria-label={`${expanded() ? 'Collapse' : 'Expand'} changes in ${displayName()}`}
            title={`${expanded() ? 'Collapse' : 'Expand'} diff preview`}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d={expanded() ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} />
            </svg>
          </button>
        </Show>
      </div>
      <Show when={previewNotice()}>
        {(notice) => (
          <div class={`diff-view-preview-state diff-view-preview-${notice().status}`} role="note">
            {notice().message}
          </div>
        )}
      </Show>
      <Show when={props.showChanges && displayLines().length > 0}>
        <div
          class={`diff-view-lines-shell${canExpand() ? ' diff-view-lines-shell-expandable' : ''}`}
        >
          <div
            ref={(element) => {
              linesViewport = element;
              setViewportElement(element);
            }}
            class={`diff-view-lines${hasLineNumbers() ? '' : ' diff-view-lines-unnumbered'}`}
            role="region"
            tabIndex={0}
            aria-label={`Changes in ${file() || 'file'}`}
            onClick={toggleExpandedFromPreview}
            onFocus={updateScrollThumbs}
            onScroll={updateScrollThumbs}
          >
            <DiffLinesContent
              entries={renderedDisplayLines()}
              firstChangeIndex={firstChangeIndex()}
              language={fileType()?.language}
            />
          </div>
          <Show when={verticalThumb()}>
            {(thumb) => (
              <div
                class="diff-view-scrollbar diff-view-scrollbar-vertical"
                aria-hidden="true"
                onPointerDown={(event) => scrollFromTrack('vertical', event)}
              >
                <span
                  class="diff-view-scrollbar-thumb"
                  style={{
                    height: `${thumb().size}px`,
                    transform: `translateY(${thumb().offset}px)`,
                  }}
                  onPointerDown={(event) => beginScrollDrag('vertical', event)}
                  onPointerMove={moveScrollDrag}
                  onPointerUp={endScrollDrag}
                  onPointerCancel={endScrollDrag}
                />
              </div>
            )}
          </Show>
          <Show when={!canExpand() ? horizontalThumb() : null}>
            {(thumb) => (
              <div
                class="diff-view-scrollbar diff-view-scrollbar-horizontal"
                aria-hidden="true"
                onPointerDown={(event) => scrollFromTrack('horizontal', event)}
              >
                <span
                  class="diff-view-scrollbar-thumb"
                  style={{
                    width: `${thumb().size}px`,
                    transform: `translateX(${thumb().offset}px)`,
                  }}
                  onPointerDown={(event) => beginScrollDrag('horizontal', event)}
                  onPointerMove={moveScrollDrag}
                  onPointerUp={endScrollDrag}
                  onPointerCancel={endScrollDrag}
                />
              </div>
            )}
          </Show>
        </div>
      </Show>
      <Show when={expanded() ? overlayMount() : undefined}>
        {(mount) => (
          <Portal mount={mount()}>
            <section
              ref={(element) =>
                onCleanup(trapModalFocus(element, { preventScrollOnRestore: true }))
              }
              class="diff-view-overlay animate-fade-in"
              role="dialog"
              aria-modal="true"
              aria-label={`Expanded changes in ${displayName()}`}
              onClick={toggleExpanded}
            >
              <div class="diff-view-overlay-panel" onClick={(event) => event.stopPropagation()}>
                <header class="diff-view-overlay-header" onClick={toggleExpanded}>
                  <div class="diff-view-overlay-title">
                    <FileTypeIcon path={file()} class="diff-view-icon" />
                    <button
                      type="button"
                      class="diff-view-overlay-filename"
                      title={
                        file()
                          ? `Open full diff: ${fromFile() ? `${fromFile()} -> ${file()}` : file()}`
                          : undefined
                      }
                      disabled={!file()}
                      onClick={(event) => {
                        event.stopPropagation();
                        openFile();
                      }}
                    >
                      {displayName()}
                    </button>
                    <Show when={props.diff.additions > 0 || props.diff.deletions > 0}>
                      <span class="diff-view-stats">
                        <Show when={props.diff.additions > 0}>
                          <span class="diff-lines-added">+{props.diff.additions}</span>
                        </Show>
                        <Show when={props.diff.deletions > 0}>
                          <span class="diff-lines-removed">-{props.diff.deletions}</span>
                        </Show>
                      </span>
                    </Show>
                  </div>
                  <button
                    ref={(element) => {
                      closeButton = element;
                    }}
                    type="button"
                    class="diff-view-overlay-close"
                    aria-label="Close expanded diff"
                    title="Close expanded diff"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleExpanded();
                    }}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      aria-hidden="true"
                    >
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </header>
                <div class="diff-view-overlay-content">
                  <div
                    ref={(element) => {
                      overlayViewport = element;
                      setOverlayViewportElement(element);
                    }}
                    class={`diff-view-lines diff-view-overlay-lines${hasLineNumbers() ? '' : ' diff-view-lines-unnumbered'}`}
                    role="region"
                    tabIndex={0}
                    aria-label={`All changes in ${file() || 'file'}`}
                    onScroll={savePreviewState}
                  >
                    <DiffLinesContent
                      entries={allDisplayLines()}
                      firstChangeIndex={firstChangeIndex()}
                      language={fileType()?.language}
                    />
                  </div>
                </div>
              </div>
            </section>
          </Portal>
        )}
      </Show>
    </div>
  );
}
