import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from 'solid-js';
import { postMessage } from '../lib/bridge';
import { getLeafPathName } from '../lib/path-display';
import { getToolDiffPreviewState, setToolDiffPreviewState } from '../lib/tool-call-expansion-state';
import type { FileDiff } from '../types';
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

const MAX_FALLBACK_DIFF_CELLS = 1_000_000;
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

export function parseUnifiedPatch(patch: string | undefined): UnifiedDiffLine[] {
  if (!patch) return [];

  const lines: UnifiedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let insideHunk = false;

  for (const rawLine of patch.replace(/\r\n/g, '\n').split('\n')) {
    const hunk = parseUnifiedHunk(rawLine);
    if (hunk) {
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
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

export function DiffView(props: { diffs: FileDiff[]; showChanges?: boolean; stateKey?: string }) {
  return (
    <div class={`diff-view-widget${props.showChanges ? ' diff-view-widget-inline' : ''}`}>
      <Index each={props.diffs}>
        {(diff, index) => (
          <DiffItem
            diff={diff()}
            showChanges={props.showChanges}
            stateKey={
              props.stateKey
                ? `${props.stateKey}\u0000${diff().file || `unknown:${index}`}`
                : undefined
            }
          />
        )}
      </Index>
    </div>
  );
}

function DiffItem(props: { diff: FileDiff; showChanges?: boolean; stateKey?: string }) {
  let linesViewport: HTMLDivElement | undefined;
  let scrollDrag: DiffScrollDrag | null = null;
  let scrollbarActivityTimer: ReturnType<typeof setTimeout> | undefined;
  let renderedFile = props.diff.file;
  let renderedStateKey = props.stateKey;
  let previewStateReady = !props.stateKey;
  const initialPreviewState = props.stateKey ? getToolDiffPreviewState(props.stateKey) : null;
  const file = () => props.diff.file;
  const displayName = () => {
    const path = file();
    if (!path) return 'Unknown file';
    return props.showChanges ? getLeafPathName(path) : path;
  };
  const fileType = createMemo(() => getDiffFileType(file()));
  const lines = createMemo(() => getDiffLines(props.diff));
  const displayLines = createMemo(() => getDisplayDiffLines(lines()));
  const firstChangeIndex = createMemo(() =>
    displayLines().findIndex((line) => line.kind === 'addition' || line.kind === 'deletion')
  );
  const scrollAnchorIndex = createMemo(() => Math.max(0, firstChangeIndex() - 1));
  const canExpand = createMemo(() => displayLines().length > COLLAPSED_DIFF_LINE_COUNT);
  const [expanded, setExpanded] = createSignal(initialPreviewState?.expanded ?? false);
  const [scrollbarsActive, setScrollbarsActive] = createSignal(false);
  const [verticalThumb, setVerticalThumb] = createSignal<DiffScrollThumb | null>(null);
  const [horizontalThumb, setHorizontalThumb] = createSignal<DiffScrollThumb | null>(null);
  const hasLineNumbers = createMemo(() =>
    displayLines().some((line) => line.oldLine !== null || line.newLine !== null)
  );
  const savePreviewState = () => {
    if (!props.stateKey || !previewStateReady || !linesViewport) return;
    setToolDiffPreviewState(props.stateKey, {
      expanded: expanded(),
      scrollTop: linesViewport.scrollTop,
      scrollLeft: linesViewport.scrollLeft,
    });
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
  const scrollToFirstChange = () => {
    const anchor = linesViewport?.querySelector<HTMLElement>('.diff-view-scroll-anchor');
    if (!linesViewport || !anchor) return;
    linesViewport.scrollTop = anchor.offsetTop;
    linesViewport.scrollLeft = 0;
  };
  const toggleExpanded = () => {
    const nextExpanded = !expanded();
    setExpanded(nextExpanded);
    queueMicrotask(() => {
      if (!nextExpanded) scrollToFirstChange();
      updateScrollThumbs();
    });
  };
  const showScrollbarsTemporarily = () => {
    if (!expanded() && document.activeElement !== linesViewport) return;
    setScrollbarsActive(true);
    if (scrollbarActivityTimer !== undefined) clearTimeout(scrollbarActivityTimer);
    scrollbarActivityTimer = setTimeout(() => {
      scrollbarActivityTimer = undefined;
      setScrollbarsActive(false);
    }, 900);
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
    postMessage({ type: 'vscode/open', payload: { path, kind: 'file', view: 'diff' } });
  };

  createEffect(() => {
    const nextFile = file();
    const nextStateKey = props.stateKey;
    displayLines();
    const itemChanged = nextFile !== renderedFile || nextStateKey !== renderedStateKey;
    renderedFile = nextFile;
    renderedStateKey = nextStateKey;
    if (itemChanged) {
      const state = nextStateKey ? getToolDiffPreviewState(nextStateKey) : null;
      previewStateReady = !nextStateKey;
      setExpanded(state?.expanded ?? false);
      queueMicrotask(() => {
        if (state && linesViewport) {
          linesViewport.scrollTop = state.scrollTop;
          linesViewport.scrollLeft = state.scrollLeft;
        } else {
          scrollToFirstChange();
        }
        previewStateReady = true;
        updateScrollThumbs();
      });
      return;
    }
    queueMicrotask(() => {
      updateScrollThumbs();
    });
  });

  onMount(() => {
    queueMicrotask(() => {
      if (initialPreviewState && linesViewport) {
        linesViewport.scrollTop = initialPreviewState.scrollTop;
        linesViewport.scrollLeft = initialPreviewState.scrollLeft;
      } else {
        scrollToFirstChange();
      }
      previewStateReady = true;
      updateScrollThumbs();
    });

    if (!linesViewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateScrollThumbs);
    observer.observe(linesViewport);
    onCleanup(() => observer.disconnect());
  });

  onCleanup(() => {
    if (scrollbarActivityTimer !== undefined) clearTimeout(scrollbarActivityTimer);
  });

  return (
    <div class="diff-view-file">
      <button
        type="button"
        class="diff-view-item diff-view-item-button"
        onClick={openFile}
        disabled={!file()}
        title={file() ? `Open full diff: ${file()}` : undefined}
      >
        <Show
          when={fileType()}
          fallback={
            <svg
              class="diff-view-icon"
              width="14"
              height="14"
              viewBox="0 0 32 32"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M13 4 6 11v17h20V4H13Zm-1 3.828V10H9.828L12 7.828ZM24 26H8V12h6V6h10v20Z" />
            </svg>
          }
        >
          {(type) => (
            <span class="diff-view-file-type" aria-hidden="true">
              {type().label}
            </span>
          )}
        </Show>
        <span class="diff-view-filename">{displayName()}</span>
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
      </button>
      <Show when={props.showChanges && displayLines().length > 0}>
        <div
          class={`diff-view-lines-shell${expanded() ? ' diff-view-lines-shell-expanded' : ''}${scrollbarsActive() ? ' diff-view-lines-shell-scrolling' : ''}`}
        >
          <div
            ref={(element) => (linesViewport = element)}
            class={`diff-view-lines${hasLineNumbers() ? '' : ' diff-view-lines-unnumbered'}${expanded() ? ' diff-view-lines-expanded' : ''}`}
            role="table"
            tabIndex={0}
            aria-label={`Changes in ${file() || 'file'}`}
            onClick={() => {
              if (!expanded()) linesViewport?.focus({ preventScroll: true });
            }}
            onFocus={updateScrollThumbs}
            onScroll={updateScrollThumbs}
            onTouchMove={showScrollbarsTemporarily}
            onWheel={showScrollbarsTemporarily}
          >
            <div class="diff-view-lines-content">
              <For each={displayLines()}>
                {(line, index) =>
                  line.kind === 'gap' ? (
                    <div
                      class={`diff-view-gap${index() === scrollAnchorIndex() ? ' diff-view-scroll-anchor' : ''}`}
                      role="row"
                    >
                      {line.content}
                    </div>
                  ) : (
                    <div
                      class={`diff-view-line diff-view-line-${line.kind}${index() === scrollAnchorIndex() ? ' diff-view-scroll-anchor' : ''}`}
                      role="row"
                    >
                      <span class="diff-view-line-number" aria-hidden="true">
                        {line.newLine ?? line.oldLine ?? ''}
                      </span>
                      <span class="diff-view-line-marker" aria-hidden="true">
                        {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '}
                      </span>
                      <span
                        class="diff-view-line-content hljs"
                        innerHTML={renderHighlightedCodeHtml(line.content, fileType()?.language)}
                      />
                    </div>
                  )
                }
              </For>
            </div>
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
          <Show when={horizontalThumb()}>
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
          <Show when={canExpand()}>
            <div class="diff-view-toggle-overlay">
              <button
                type="button"
                class="diff-view-toggle"
                aria-expanded={expanded()}
                aria-label={`${expanded() ? 'Collapse' : 'Expand'} changes in ${displayName()}`}
                title={`${expanded() ? 'Collapse' : 'Expand'} diff preview`}
                onClick={toggleExpanded}
              >
                <svg
                  width="14"
                  height="14"
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
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
