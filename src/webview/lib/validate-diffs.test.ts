import { describe, expect, it } from 'vitest';
import { validateFileDiffs } from './validate-diffs';

const validDiff = {
  file: 'src/index.ts',
  before: '',
  after: 'console.log("hello")',
  additions: 1,
  deletions: 0,
};

describe('validateFileDiffs', () => {
  it('returns a valid array unchanged', () => {
    const input = [validDiff, { ...validDiff, file: 'src/other.ts' }];
    expect(validateFileDiffs(input)).toEqual(input);
  });

  it('preserves reference identity when all entries are valid', () => {
    const input = [validDiff];
    expect(validateFileDiffs(input)).toBe(input);
  });

  it('accepts entries with missing file', () => {
    const diff = { additions: 1, deletions: 0 };
    const result = validateFileDiffs([validDiff, diff]);
    expect(result).toEqual([validDiff, diff]);
  });

  it('filters out entries with non-string file', () => {
    const result = validateFileDiffs([{ file: 42, additions: 1, deletions: 0 }]);
    expect(result).toEqual([]);
  });

  it('filters out entries with missing additions or deletions', () => {
    const result = validateFileDiffs([
      { file: 'a.ts', deletions: 0 },
      { file: 'b.ts', additions: 1 },
      validDiff,
    ]);
    expect(result).toEqual([validDiff]);
  });

  it('filters out non-object entries', () => {
    const result = validateFileDiffs([null, undefined, 'string', 42, true, validDiff]);
    expect(result).toEqual([validDiff]);
  });

  it('wraps a single diff object', () => {
    expect(validateFileDiffs(validDiff)).toEqual([validDiff]);
  });

  it('reads keyed diff objects', () => {
    expect(validateFileDiffs({ first: validDiff })).toEqual([validDiff]);
  });

  it('filters invalid keyed diff object entries', () => {
    expect(
      validateFileDiffs({
        first: validDiff,
        missingFile: { additions: 1, deletions: 0 },
        invalidFile: { file: 42, additions: 1, deletions: 0 },
      })
    ).toEqual([validDiff, { additions: 1, deletions: 0 }]);
  });

  it('returns empty array for unsupported input', () => {
    expect(validateFileDiffs(null)).toEqual([]);
    expect(validateFileDiffs(undefined)).toEqual([]);
    expect(validateFileDiffs('string')).toEqual([]);
    expect(validateFileDiffs(42)).toEqual([]);
    expect(validateFileDiffs({})).toEqual([]);
  });

  it('returns empty array for empty array', () => {
    expect(validateFileDiffs([])).toEqual([]);
  });

  it('accepts diffs without optional before/after fields', () => {
    const minimal = { file: 'x.ts', additions: 3, deletions: 1 };
    expect(validateFileDiffs([minimal])).toEqual([minimal]);
  });
});
