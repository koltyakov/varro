import type { ContextLineRange, DroppedFile, EditorContext } from './protocol';

function normalizePath(value: string) {
  if (!value) return value;
  const normalized = value.replace(/\\/g, '/');
  const trimmed = normalized.replace(/\/+$/, '');
  return trimmed || normalized;
}

function formatLineRangeValue(range: ContextLineRange) {
  return range.startLine === range.endLine
    ? `${range.startLine}`
    : `${range.startLine}-${range.endLine}`;
}

export function normalizeContextLineRanges(
  lineRanges: ContextLineRange[] | null | undefined
): ContextLineRange[] {
  if (!lineRanges?.length) return [];

  const sorted = lineRanges
    .map((range) => ({
      startLine: Math.max(1, Math.min(range.startLine, range.endLine)),
      endLine: Math.max(1, Math.max(range.startLine, range.endLine)),
    }))
    .toSorted((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  const merged: ContextLineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.startLine > last.endLine + 1) {
      merged.push({ ...range });
      continue;
    }
    last.endLine = Math.max(last.endLine, range.endLine);
  }
  return merged;
}

function normalizeContextFile(file: DroppedFile): DroppedFile {
  if (file.type !== 'file') return { ...file, lineRanges: undefined };

  const lineRanges = normalizeContextLineRanges(file.lineRanges);
  return lineRanges.length > 0 ? { ...file, lineRanges } : { ...file, lineRanges: undefined };
}

export function areContextFilesEqual(a: DroppedFile, b: DroppedFile) {
  if (a.path !== b.path || a.relativePath !== b.relativePath || a.type !== b.type) return false;

  const aRanges = normalizeContextLineRanges(a.lineRanges);
  const bRanges = normalizeContextLineRanges(b.lineRanges);
  if (aRanges.length !== bRanges.length) return false;
  return aRanges.every(
    (range, index) =>
      range.startLine === bRanges[index]?.startLine && range.endLine === bRanges[index]?.endLine
  );
}

export function mergeContextFile(
  current: DroppedFile | undefined,
  incoming: DroppedFile
): DroppedFile {
  const next = normalizeContextFile(incoming);
  if (!current) return next;

  const prev = normalizeContextFile(current);
  if (normalizePath(prev.path) !== normalizePath(next.path)) return next;
  if (prev.type === 'directory' || next.type === 'directory') {
    return { ...prev, ...next, lineRanges: undefined };
  }

  const prevRanges = normalizeContextLineRanges(prev.lineRanges);
  const nextRanges = normalizeContextLineRanges(next.lineRanges);
  if (prevRanges.length === 0 || nextRanges.length === 0) {
    return { ...prev, ...next, lineRanges: undefined };
  }

  return {
    ...prev,
    ...next,
    lineRanges: normalizeContextLineRanges([...prevRanges, ...nextRanges]),
  };
}

export function formatContextLineRanges(
  lineRanges: ContextLineRange[] | null | undefined
): string | null {
  const normalized = normalizeContextLineRanges(lineRanges);
  if (normalized.length === 0) return null;
  return normalized.map((range) => `L${formatLineRangeValue(range)}`).join(', ');
}

export function formatSelectionReference(
  path: string,
  lineRanges: ContextLineRange[] | null | undefined
) {
  const normalized = normalizeContextLineRanges(lineRanges);
  if (normalized.length === 0) return `[Active file: ${path}]`;
  return `[Selection from ${path} lines ${normalized.map(formatLineRangeValue).join(', ')}]`;
}

export function subtractContextLineRanges(
  source: ContextLineRange[] | null | undefined,
  excluded: ContextLineRange[] | null | undefined
): ContextLineRange[] {
  const sourceRanges = normalizeContextLineRanges(source);
  const excludedRanges = normalizeContextLineRanges(excluded);
  if (sourceRanges.length === 0 || excludedRanges.length === 0) return sourceRanges;

  const result: ContextLineRange[] = [];
  let excludedIndex = 0;

  for (const sourceRange of sourceRanges) {
    let cursor = sourceRange.startLine;

    while (
      excludedIndex < excludedRanges.length &&
      excludedRanges[excludedIndex].endLine < cursor
    ) {
      excludedIndex++;
    }

    let index = excludedIndex;
    while (
      index < excludedRanges.length &&
      excludedRanges[index].startLine <= sourceRange.endLine
    ) {
      const excludedRange = excludedRanges[index];
      if (excludedRange.startLine > cursor) {
        result.push({ startLine: cursor, endLine: excludedRange.startLine - 1 });
      }
      cursor = Math.max(cursor, excludedRange.endLine + 1);
      if (cursor > sourceRange.endLine) break;
      index++;
    }

    if (cursor <= sourceRange.endLine) {
      result.push({ startLine: cursor, endLine: sourceRange.endLine });
    }
  }

  return normalizeContextLineRanges(result);
}

export function parseSelectionReference(text: string) {
  const match = text.match(/^\[Selection from (.+?) lines (.+)\]$/);
  if (!match || match[1].startsWith('terminal ')) return null;

  const lineRanges = normalizeContextLineRanges(
    match[2]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const rangeMatch = part.match(/^(\d+)(?:-(\d+))?$/);
        if (!rangeMatch) return null;
        const startLine = parseInt(rangeMatch[1], 10);
        const endLine = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : startLine;
        return { startLine, endLine };
      })
      .filter((range): range is ContextLineRange => range !== null)
  );

  if (lineRanges.length === 0) return null;
  return { path: match[1], lineRanges };
}

export function getFirstContextLine(lineRanges: ContextLineRange[] | null | undefined) {
  return normalizeContextLineRanges(lineRanges)[0]?.startLine;
}

export function hasExplicitContextForPath(
  files: DroppedFile[],
  path: string | null | undefined
): DroppedFile | null {
  if (!path) return null;
  const normalizedPath = normalizePath(path);
  return files.find((file) => normalizePath(file.path) === normalizedPath) || null;
}

export function getSelectionRangesFromEditorContext(
  selection: EditorContext['selection'] | null | undefined
) {
  if (!selection) return [];
  return normalizeContextLineRanges([selection]);
}
