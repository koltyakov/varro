import { describe, expect, it } from 'vitest';
import {
  SUMMARY_DIFF_BYTE_BUDGET,
  SUMMARY_DIFF_COUNT_BUDGET,
  projectSummaryDiffs,
} from './summary-projection';

describe('summary diff projection', () => {
  it('keeps lightweight change sets within both budgets', () => {
    const value = {
      summary: {
        diffs: Array.from({ length: SUMMARY_DIFF_COUNT_BUDGET }, (_, index) => ({
          file: `src/file-${index}.ts`,
          additions: 1,
          deletions: 0,
          before: 'discarded content',
        })),
      },
    };

    const projected = projectSummaryDiffs(value);

    expect(projected.summary.diffs).toHaveLength(SUMMARY_DIFF_COUNT_BUDGET);
    expect(projected.summary.diffs[0]).toEqual({
      file: 'src/file-0.ts',
      additions: 1,
      deletions: 0,
    });
    expect((projected.summary as Record<string, unknown>).diffsOmitted).toBeUndefined();
  });

  it('omits change events when the count budget is exceeded', () => {
    const projected = projectSummaryDiffs({
      summary: {
        diffs: Array.from({ length: SUMMARY_DIFF_COUNT_BUDGET + 1 }, (_, index) => ({
          file: `generated/file-${index}.js`,
          additions: 1,
          deletions: 0,
        })),
      },
    });

    expect(projected.summary as Record<string, unknown>).toMatchObject({
      diffs: [],
      diffCount: SUMMARY_DIFF_COUNT_BUDGET + 1,
      diffsOmitted: true,
      diffsTruncated: true,
    });
  });

  it('omits change events when projected metadata exceeds the byte budget', () => {
    const projected = projectSummaryDiffs({
      summary: {
        diffs: [
          {
            file: `generated/${'x'.repeat(SUMMARY_DIFF_BYTE_BUDGET)}.js`,
            additions: 1,
            deletions: 0,
          },
        ],
      },
    });

    expect(projected.summary as Record<string, unknown>).toMatchObject({
      diffs: [],
      diffCount: 1,
      diffsOmitted: true,
      diffsTruncated: true,
    });
  });
});
