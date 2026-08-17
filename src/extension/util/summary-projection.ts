import { asRecord } from '../../shared/type-utils';

export const SUMMARY_DIFF_COUNT_BUDGET = 100;
export const SUMMARY_DIFF_BYTE_BUDGET = 64 * 1024;

export function projectSummaryDiffs<T>(value: T): T {
  const record = asRecord(value);
  const summary = asRecord(record?.summary);
  if (!record || !summary || !Array.isArray(summary.diffs)) return value;

  const diffs = summary.diffs.slice(0, SUMMARY_DIFF_COUNT_BUDGET).flatMap((candidate) => {
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
    summary.diffs.length > SUMMARY_DIFF_COUNT_BUDGET ||
    new TextEncoder().encode(JSON.stringify(diffs)).byteLength > SUMMARY_DIFF_BYTE_BUDGET;
  return {
    ...record,
    summary: {
      ...summary,
      diffs: omitted ? [] : diffs,
      ...(omitted
        ? {
            diffCount: summary.diffs.length,
            diffsOmitted: true,
            diffsTruncated: true,
          }
        : { diffCount: undefined, diffsOmitted: undefined, diffsTruncated: undefined }),
    },
  } as T;
}

function readCount(primary: unknown, fallback: unknown): number {
  if (typeof primary === 'number' && Number.isFinite(primary)) return primary;
  return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 0;
}
