import { describe, expect, it } from 'vitest';
import {
  createCommentMetadata,
  formatCommentNote,
  parseCommentNote,
  readCommentMetadata,
} from './comment-note';

describe('formatCommentNote', () => {
  it('formats a single-line selection', () => {
    expect(
      formatCommentNote({
        path: 'src/main.ts',
        selection: { startLine: 5, endLine: 5 },
        comment: 'Fix this',
      })
    ).toBe('The user made the following comment regarding line 5 of src/main.ts: Fix this');
  });

  it('formats a multi-line selection', () => {
    expect(
      formatCommentNote({
        path: 'src/main.ts',
        selection: { startLine: 5, endLine: 10 },
        comment: 'Refactor',
      })
    ).toBe(
      'The user made the following comment regarding lines 5 through 10 of src/main.ts: Refactor'
    );
  });

  it('formats a whole-file comment when no selection', () => {
    expect(formatCommentNote({ path: 'README.md', comment: 'Needs update' })).toBe(
      'The user made the following comment regarding this file of README.md: Needs update'
    );
  });

  it('normalizes reversed line ranges', () => {
    expect(
      formatCommentNote({
        path: 'a.ts',
        selection: { startLine: 10, endLine: 3 },
        comment: 'Reversed',
      })
    ).toBe('The user made the following comment regarding lines 3 through 10 of a.ts: Reversed');
  });
});

describe('parseCommentNote', () => {
  it('parses a single-line comment', () => {
    expect(
      parseCommentNote(
        'The user made the following comment regarding line 5 of src/main.ts: Fix this'
      )
    ).toEqual({
      path: 'src/main.ts',
      selection: { startLine: 5, startChar: 0, endLine: 5, endChar: 0 },
      comment: 'Fix this',
    });
  });

  it('parses a multi-line comment', () => {
    expect(
      parseCommentNote(
        'The user made the following comment regarding lines 5 through 10 of src/main.ts: Refactor'
      )
    ).toEqual({
      path: 'src/main.ts',
      selection: { startLine: 5, startChar: 0, endLine: 10, endChar: 0 },
      comment: 'Refactor',
    });
  });

  it('parses a whole-file comment', () => {
    expect(
      parseCommentNote(
        'The user made the following comment regarding this file of README.md: Needs update'
      )
    ).toEqual({
      path: 'README.md',
      selection: undefined,
      comment: 'Needs update',
    });
  });

  it('returns undefined for non-matching text', () => {
    expect(parseCommentNote('Just some regular text')).toBeUndefined();
    expect(parseCommentNote('')).toBeUndefined();
  });

  it('handles comments with colons', () => {
    expect(
      parseCommentNote(
        'The user made the following comment regarding line 1 of a.ts: key: value: nested'
      )
    ).toEqual({
      path: 'a.ts',
      selection: { startLine: 1, startChar: 0, endLine: 1, endChar: 0 },
      comment: 'key: value: nested',
    });
  });
});

describe('formatCommentNote / parseCommentNote roundtrip', () => {
  it('roundtrips a single-line selection', () => {
    const input = {
      path: 'src/utils.ts',
      selection: { startLine: 42, endLine: 42 },
      comment: 'Check bounds',
    };
    const formatted = formatCommentNote(input);
    const parsed = parseCommentNote(formatted);
    expect(parsed).toEqual({
      path: 'src/utils.ts',
      selection: { startLine: 42, startChar: 0, endLine: 42, endChar: 0 },
      comment: 'Check bounds',
    });
  });

  it('roundtrips a multi-line selection', () => {
    const input = {
      path: 'lib/cache.ts',
      selection: { startLine: 10, endLine: 25 },
      comment: 'Extract helper',
    };
    const formatted = formatCommentNote(input);
    const parsed = parseCommentNote(formatted);
    expect(parsed).toEqual({
      path: 'lib/cache.ts',
      selection: { startLine: 10, startChar: 0, endLine: 25, endChar: 0 },
      comment: 'Extract helper',
    });
  });

  it('roundtrips a whole-file comment', () => {
    const input = { path: 'README.md', comment: 'Outdated' };
    const formatted = formatCommentNote(input);
    const parsed = parseCommentNote(formatted);
    expect(parsed).toEqual({
      path: 'README.md',
      selection: undefined,
      comment: 'Outdated',
    });
  });
});

describe('createCommentMetadata / readCommentMetadata', () => {
  it('roundtrips full metadata', () => {
    const input = {
      path: 'src/app.tsx',
      selection: { startLine: 1, startChar: 0, endLine: 5, endChar: 0 },
      comment: 'Simplify this',
      preview: 'const x = 1;',
      origin: 'review' as const,
    };
    const metadata = createCommentMetadata(input);
    expect(readCommentMetadata(metadata)).toEqual(input);
  });

  it('roundtrips metadata without optional fields', () => {
    const input = { path: 'a.ts', comment: 'Fix' };
    const metadata = createCommentMetadata(input);
    expect(readCommentMetadata(metadata)).toEqual({
      path: 'a.ts',
      selection: undefined,
      comment: 'Fix',
      preview: undefined,
      origin: undefined,
    });
  });

  it('returns undefined for non-object input', () => {
    expect(readCommentMetadata(null)).toBeUndefined();
    expect(readCommentMetadata(undefined)).toBeUndefined();
    expect(readCommentMetadata('string')).toBeUndefined();
    expect(readCommentMetadata(42)).toBeUndefined();
  });

  it('returns undefined when opencodeComment is missing', () => {
    expect(readCommentMetadata({})).toBeUndefined();
    expect(readCommentMetadata({ other: 'field' })).toBeUndefined();
  });

  it('returns undefined when required fields are missing', () => {
    expect(readCommentMetadata({ opencodeComment: { path: 'a.ts' } })).toBeUndefined();
    expect(readCommentMetadata({ opencodeComment: { comment: 'text' } })).toBeUndefined();
  });

  it('ignores invalid selection shapes', () => {
    const result = readCommentMetadata({
      opencodeComment: { path: 'a.ts', comment: 'x', selection: { startLine: 'bad' } },
    });
    expect(result).toEqual({
      path: 'a.ts',
      comment: 'x',
      selection: undefined,
      preview: undefined,
      origin: undefined,
    });
  });

  it('ignores invalid origin values', () => {
    const result = readCommentMetadata({
      opencodeComment: { path: 'a.ts', comment: 'x', origin: 'invalid' },
    });
    expect(result?.origin).toBeUndefined();
  });
});
