import { describe, expect, it } from 'vitest';
import {
  areContextFilesEqual,
  formatContextLineRanges,
  formatSelectionReference,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
  mergeContextFile,
  normalizeContextLineRanges,
  parseSelectionReference,
  subtractContextLineRanges,
} from './context-files';

describe('context file helpers', () => {
  it('normalizes and merges overlapping line ranges', () => {
    expect(
      normalizeContextLineRanges([
        { startLine: 8, endLine: 10 },
        { startLine: 2, endLine: 4 },
        { startLine: 4, endLine: 6 },
        { startLine: 12, endLine: 12 },
      ])
    ).toEqual([
      { startLine: 2, endLine: 6 },
      { startLine: 8, endLine: 10 },
      { startLine: 12, endLine: 12 },
    ]);
  });

  it('merges repeated selections for the same file and lets full-file context win', () => {
    const mergedSelections = mergeContextFile(
      {
        path: '/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        lineRanges: [{ startLine: 1, endLine: 2 }],
      },
      {
        path: '/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        lineRanges: [{ startLine: 5, endLine: 6 }],
      }
    );

    expect(mergedSelections.lineRanges).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 5, endLine: 6 },
    ]);

    const mergedFullFile = mergeContextFile(mergedSelections, {
      path: '/repo/a.ts',
      relativePath: 'a.ts',
      type: 'file',
    });

    expect(mergedFullFile.lineRanges).toBeUndefined();
  });

  it('extends same-file selections instead of overwriting them', () => {
    expect(
      mergeContextFile(
        {
          path: '/repo/a.ts',
          relativePath: 'a.ts',
          type: 'file',
          lineRanges: [{ startLine: 1, endLine: 10 }],
        },
        {
          path: '/repo/a.ts',
          relativePath: 'a.ts',
          type: 'file',
          lineRanges: [{ startLine: 15, endLine: 20 }],
        }
      ).lineRanges
    ).toEqual([
      { startLine: 1, endLine: 10 },
      { startLine: 15, endLine: 20 },
    ]);

    expect(
      mergeContextFile(
        {
          path: '/repo/a.ts',
          relativePath: 'a.ts',
          type: 'file',
          lineRanges: [{ startLine: 1, endLine: 10 }],
        },
        {
          path: '/repo/a.ts',
          relativePath: 'a.ts',
          type: 'file',
          lineRanges: [{ startLine: 5, endLine: 20 }],
        }
      ).lineRanges
    ).toEqual([{ startLine: 1, endLine: 20 }]);
  });

  it('formats and parses aggregated selection references', () => {
    const text = formatSelectionReference('src/a.ts', [
      { startLine: 3, endLine: 3 },
      { startLine: 8, endLine: 10 },
    ]);

    expect(text).toBe('[Selection from src/a.ts lines 3, 8-10]');
    expect(parseSelectionReference(text)).toEqual({
      path: 'src/a.ts',
      lineRanges: [
        { startLine: 3, endLine: 3 },
        { startLine: 8, endLine: 10 },
      ],
    });
    expect(formatContextLineRanges([{ startLine: 3, endLine: 3 }, { startLine: 8, endLine: 10 }])).toBe(
      'L3, L8-10'
    );
  });

  it('finds explicit context by path and compares merged items', () => {
    const file = {
      path: 'C:/repo/a.ts',
      relativePath: 'a.ts',
      type: 'file' as const,
      lineRanges: [{ startLine: 3, endLine: 4 }],
    };

    expect(hasExplicitContextForPath([file], 'C:\\repo\\a.ts')).toEqual(file);
    expect(
      areContextFilesEqual(file, {
        path: 'C:/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        lineRanges: [{ startLine: 3, endLine: 4 }],
      })
    ).toBe(true);
    expect(getSelectionRangesFromEditorContext({ startLine: 7, endLine: 9 })).toEqual([
      { startLine: 7, endLine: 9 },
    ]);
  });

  it('subtracts overlapping explicit ranges from the live selection', () => {
    expect(
      subtractContextLineRanges(
        [{ startLine: 3, endLine: 12 }],
        [
          { startLine: 1, endLine: 4 },
          { startLine: 8, endLine: 10 },
          { startLine: 12, endLine: 20 },
        ]
      )
    ).toEqual([
      { startLine: 5, endLine: 7 },
      { startLine: 11, endLine: 11 },
    ]);
  });
});
