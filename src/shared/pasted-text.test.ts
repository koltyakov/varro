import { describe, expect, it } from 'vitest';
import {
  createPastedText,
  isLargeTextPaste,
  pastedTextDataUrl,
  readPastedTextDataUrl,
  MAX_PASTED_TEXT_BYTES,
} from './pasted-text';

describe('pasted text snapshots', () => {
  it('uses independent character and line thresholds, including CRLF', () => {
    expect(isLargeTextPaste('x'.repeat(1999))).toBe(false);
    expect(isLargeTextPaste('x'.repeat(2000))).toBe(true);
    expect(isLargeTextPaste(Array(25).fill('x').join('\r\n'))).toBe(true);
  });
  it('preserves Unicode, CRLF, whitespace and attachment identity across serialization', () => {
    const text = '  café 👩🏽‍💻\r\n\t雪\n\n';
    const file = createPastedText(text);
    expect(JSON.parse(JSON.stringify(file)).pastedText).toBe(text);
    expect(readPastedTextDataUrl(pastedTextDataUrl(text))).toBe(text);
    expect(createPastedText(text).path).not.toBe(file.path);
    expect(readPastedTextDataUrl('data:text/plain;charset=utf-8,%ZZ')).toBeNull();
  });
  it('applies the byte limit without clipping a multibyte paste', () => {
    expect(() => createPastedText('雪'.repeat(MAX_PASTED_TEXT_BYTES / 3 + 1))).toThrow('64 KB');
  });
});
