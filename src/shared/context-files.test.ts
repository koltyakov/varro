import { describe, expect, it } from 'vitest';
import {
  areContextFilesEqual,
  formatContextLineRanges,
  formatSelectionReference,
  getFirstContextLine,
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

    expect(
      normalizeContextLineRanges([
        { startLine: 9, endLine: 4 },
        { startLine: 0, endLine: -3 },
        { startLine: -2, endLine: 1 },
      ])
    ).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 4, endLine: 9 },
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

  it('replaces context when the incoming file path differs', () => {
    expect(
      mergeContextFile(
        {
          path: '/repo/a.ts',
          relativePath: 'a.ts',
          type: 'file',
          lineRanges: [{ startLine: 1, endLine: 10 }],
        },
        {
          path: '/repo/b.ts',
          relativePath: 'b.ts',
          type: 'file',
          lineRanges: [{ startLine: 20, endLine: 30 }],
        }
      )
    ).toEqual({
      path: '/repo/b.ts',
      relativePath: 'b.ts',
      type: 'file',
      lineRanges: [{ startLine: 20, endLine: 30 }],
    });
  });

  it('drops line ranges when either merged context item is a directory', () => {
    expect(
      mergeContextFile(
        {
          path: '/repo/src',
          relativePath: 'src',
          type: 'directory',
        },
        {
          path: '/repo/src',
          relativePath: 'src',
          type: 'file',
          lineRanges: [{ startLine: 5, endLine: 8 }],
        }
      )
    ).toEqual({
      path: '/repo/src',
      relativePath: 'src',
      type: 'file',
      lineRanges: undefined,
    });
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
    expect(
      formatContextLineRanges([
        { startLine: 3, endLine: 3 },
        { startLine: 8, endLine: 10 },
      ])
    ).toBe('L3, L8-10');
  });

  it('rejects malformed selection references', () => {
    expect(parseSelectionReference('')).toBeNull();
    expect(parseSelectionReference('[Selection from src/a.ts lines ]')).toBeNull();
    expect(parseSelectionReference('Selection from src/a.ts lines 3-4]')).toBeNull();
    expect(parseSelectionReference('[Selection from src/a.ts lines two-4]')).toBeNull();
    expect(parseSelectionReference('[Selection from terminal zsh lines 3-4]')).toBeNull();
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

  it('handles subtract edge cases and returns the first normalized line', () => {
    expect(
      subtractContextLineRanges([{ startLine: 3, endLine: 6 }], [{ startLine: 10, endLine: 12 }])
    ).toEqual([{ startLine: 3, endLine: 6 }]);

    expect(
      subtractContextLineRanges([{ startLine: 3, endLine: 6 }], [{ startLine: 1, endLine: 10 }])
    ).toEqual([]);

    expect(
      subtractContextLineRanges([{ startLine: 3, endLine: 6 }], [{ startLine: 7, endLine: 9 }])
    ).toEqual([{ startLine: 3, endLine: 6 }]);

    expect(
      getFirstContextLine([
        { startLine: 9, endLine: 12 },
        { startLine: 4, endLine: 5 },
      ])
    ).toBe(4);
    expect(getFirstContextLine(null)).toBeUndefined();
  });
});
