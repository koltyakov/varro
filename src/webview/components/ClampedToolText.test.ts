import { describe, expect, it } from 'vitest';
import { CLAMP_CHARS, CLAMP_LINES, clampToolText, countLines } from './ClampedToolText';

describe('countLines', () => {
  it('ignores the trailing newline so "a\\n" is one line, not two', () => {
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
  });

  it('counts CRLF the same as LF', () => {
    expect(countLines('a\r\nb\r\n')).toBe(2);
  });

  it('reports empty content as zero lines', () => {
    expect(countLines('')).toBe(0);
  });
});

describe('clampToolText', () => {
  it('leaves short content untouched', () => {
    const content = 'one\ntwo\nthree';
    const result = clampToolText(content);

    expect(result.clamped).toBe(false);
    expect(result.preview).toBe(content);
    expect(result.lineCount).toBe(3);
  });

  it('clamps to CLAMP_LINES and reports the true total', () => {
    const content = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const result = clampToolText(content);

    expect(result.clamped).toBe(true);
    expect(countLines(result.preview)).toBe(CLAMP_LINES);
    expect(result.preview.startsWith('line 0\n')).toBe(true);
    expect(result.lineCount).toBe(40);
  });

  it('clamps a single enormous line that has no newlines to break on', () => {
    const content = 'x'.repeat(CLAMP_CHARS * 3);
    const result = clampToolText(content);

    expect(result.clamped).toBe(true);
    expect(result.preview).toHaveLength(CLAMP_CHARS);
    expect(result.lineCount).toBe(1);
  });

  it('does not clamp content sitting exactly on both limits', () => {
    const content = Array.from({ length: CLAMP_LINES }, () => 'a').join('\n');
    const result = clampToolText(content);

    expect(content.length).toBeLessThanOrEqual(CLAMP_CHARS);
    expect(result.clamped).toBe(false);
  });

  it('ends the preview on a line with text so the fade has something to fade over', () => {
    // Real command output: leading blank line, a blank line inside, more after.
    const content = [
      '',
      'file one | 2 +-',
      'file two | 3 ++-',
      '',
      'Changes:',
      '',
      'x',
      'y',
      'z',
    ].join('\n');
    const result = clampToolText(content);

    expect(result.clamped).toBe(true);
    expect(result.preview.split('\n').at(-1)?.trim()).not.toBe('');
    expect(result.preview.startsWith('file one')).toBe(true);
  });

  it('drops blank edges before counting, so leading blank lines do not eat the budget', () => {
    const content = `\n\n${Array.from({ length: CLAMP_LINES }, (_, i) => `line ${i}`).join('\n')}\n\n`;
    const result = clampToolText(content);

    expect(result.lineCount).toBe(CLAMP_LINES);
    expect(result.clamped).toBe(false);
    expect(result.preview).toBe(
      Array.from({ length: CLAMP_LINES }, (_, i) => `line ${i}`).join('\n')
    );
  });

  it('keeps indentation on the lines it does show', () => {
    const content = ['', '    indented first', '\tsecond', 'third', '', ''].join('\n');
    const result = clampToolText(content);

    expect(result.preview.split('\n')[0]).toBe('    indented first');
    expect(result.preview.split('\n')[1]).toBe('\tsecond');
  });

  it('treats whitespace-only content as having no lines', () => {
    const result = clampToolText('\n   \n\t\n');

    expect(result.preview).toBe('');
    expect(result.lineCount).toBe(0);
    expect(result.clamped).toBe(false);
  });

  it('applies the character ceiling to the line-clamped preview too', () => {
    const content = Array.from({ length: CLAMP_LINES + 5 }, () => 'y'.repeat(400)).join('\n');
    const result = clampToolText(content);

    expect(result.clamped).toBe(true);
    expect(result.preview.length).toBeLessThanOrEqual(CLAMP_CHARS);
  });
});
