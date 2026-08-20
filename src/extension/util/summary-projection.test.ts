/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These tests deliberately pass open, malformed summary payloads through projection. */
import { describe, expect, it } from 'vitest';
import {
  SUMMARY_DIFF_BYTE_BUDGET,
  SUMMARY_DIFF_COUNT_BUDGET,
  projectFileDiffs,
  projectPartFileLists,
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

  it('filters generated dependencies and recalculates visible summary totals', () => {
    const projected = projectSummaryDiffs({
      summary: {
        files: 3,
        additions: 103,
        deletions: 21,
        diffs: [
          { file: 'src/index.ts', additions: 3, deletions: 1 },
          { file: 'node_modules/pkg/index.js', additions: 100, deletions: 20 },
          { file: 'packages/api/.venv/lib/pkg.py', additions: 0, deletions: 0 },
        ],
      },
    });

    expect(projected.summary).toMatchObject({
      files: 1,
      additions: 3,
      deletions: 1,
      diffs: [{ file: 'src/index.ts', additions: 3, deletions: 1 }],
    });
  });

  it('filters generated dependencies from direct diffs and part file lists', () => {
    const sourceDiff = { file: 'src/index.ts', additions: 1, deletions: 0 };
    expect(
      projectFileDiffs([
        sourceDiff,
        { file: 'node_modules/pkg/index.js', additions: 1, deletions: 0 },
      ])
    ).toEqual([sourceDiff]);

    expect(
      projectPartFileLists({
        type: 'patch',
        files: ['src/index.ts', 'node_modules/pkg/index.js'],
        state: {
          metadata: {
            files: [
              { relativePath: 'src/index.ts' },
              { filePath: 'C:\\repo\\node_modules\\pkg\\index.js' },
            ],
          },
        },
      })
    ).toMatchObject({
      files: ['src/index.ts'],
      state: { metadata: { files: [{ relativePath: 'src/index.ts' }] } },
    });
  });
});
