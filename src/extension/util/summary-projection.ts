import { asRecord } from '../../shared/type-utils';

export const SUMMARY_DIFF_COUNT_BUDGET = 100;
export const SUMMARY_DIFF_BYTE_BUDGET = 64 * 1024;
const GENERATED_DEPENDENCY_SEGMENT =
  /(?:^|\/)(?:node_modules|\.venv|venv|\.tox|__pycache__)(?:\/|$)/;
const FILE_PATH_KEYS = [
  'relativePath',
  'file',
  'path',
  'filePath',
  'filepath',
  'filename',
] as const;

export function projectSummaryDiffs<T>(value: T): T {
  const record = asRecord(value);
  const summary = asRecord(record?.summary);
  if (!record || !summary || !Array.isArray(summary.diffs)) return value;

  let filteredGeneratedDiffs = false;
  const visibleDiffs = summary.diffs.filter((candidate) => {
    const file = asRecord(candidate)?.file;
    if (typeof file !== 'string' || !isGeneratedDependencyPath(file)) return true;
    filteredGeneratedDiffs = true;
    return false;
  });
  const diffs = visibleDiffs.slice(0, SUMMARY_DIFF_COUNT_BUDGET).flatMap((candidate) => {
    const diff = asRecord(candidate);
    if (!diff) return [];
    const projected: Record<string, unknown> = {};
    if (typeof diff.file === 'string') projected.file = diff.file;
    projected.additions = readCount(diff.additions, diff.added);
    projected.deletions = readCount(diff.deletions, diff.removed);
    if (diff.status === 'added' || diff.status === 'deleted' || diff.status === 'modified') {
      projected.status = diff.status;
    }
    return [projected];
  });
  const omitted =
    visibleDiffs.length > SUMMARY_DIFF_COUNT_BUDGET ||
    new TextEncoder().encode(JSON.stringify(diffs)).byteLength > SUMMARY_DIFF_BYTE_BUDGET;
  const visibleTotals = filteredGeneratedDiffs ? summarizeDiffs(visibleDiffs) : null;
  return {
    ...record,
    summary: {
      ...summary,
      ...visibleTotals,
      diffs: omitted ? [] : diffs,
      ...(omitted
        ? {
            diffCount: visibleDiffs.length,
            diffsOmitted: true,
            diffsTruncated: true,
          }
        : { diffCount: undefined, diffsOmitted: undefined, diffsTruncated: undefined }),
    },
  } as T;
}

export function projectFileDiffs<T>(value: T): T {
  if (!Array.isArray(value)) return value;
  const projected = value.filter((candidate) => {
    const file = asRecord(candidate)?.file;
    return typeof file !== 'string' || !isGeneratedDependencyPath(file);
  });
  return (projected.length === value.length ? value : projected) as T;
}

export function projectPartFileLists<T>(value: T): T {
  const part = asRecord(value);
  if (!part) return value;

  let projected = part;
  if (Array.isArray(part.files)) {
    const files = filterFileList(part.files);
    if (files !== part.files) projected = { ...projected, files };
  }

  const state = asRecord(part.state);
  const metadata = asRecord(state?.metadata);
  if (state && metadata && Array.isArray(metadata.files)) {
    const files = filterFileList(metadata.files);
    if (files !== metadata.files) {
      projected = { ...projected, state: { ...state, metadata: { ...metadata, files } } };
    }
  }
  return projected as T;
}

export function isGeneratedDependencyPath(path: string): boolean {
  return GENERATED_DEPENDENCY_SEGMENT.test(path.replace(/\\/g, '/'));
}

function filterFileList(files: unknown[]): unknown[] {
  const projected = files.filter((candidate) => {
    if (typeof candidate === 'string') return !isGeneratedDependencyPath(candidate);
    const record = asRecord(candidate);
    if (!record) return true;
    return !FILE_PATH_KEYS.some(
      (key) => typeof record[key] === 'string' && isGeneratedDependencyPath(record[key] as string)
    );
  });
  return projected.length === files.length ? files : projected;
}

function summarizeDiffs(diffs: unknown[]) {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const candidate of diffs) {
    const diff = asRecord(candidate);
    if (!diff) continue;
    files += 1;
    additions += readCount(diff.additions, diff.added);
    deletions += readCount(diff.deletions, diff.removed);
  }
  return { files, additions, deletions };
}

function readCount(primary: unknown, fallback: unknown): number {
  if (typeof primary === 'number' && Number.isFinite(primary)) return primary;
  return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 0;
}
