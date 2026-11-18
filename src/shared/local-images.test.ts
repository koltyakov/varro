import { describe, expect, it } from 'vitest';
import { parseLocalImagePath } from './local-images';

describe('parseLocalImagePath', () => {
  it.each([
    ['artifacts/screenshot.png', 'artifacts/screenshot.png'],
    ['./screenshots/screen%20shot.png', './screenshots/screen shot.png'],
    ['/workspace/screenshot.png', '/workspace/screenshot.png'],
    ['file:///workspace/screen%20shot.png', '/workspace/screen shot.png'],
    ['file:///C:/workspace/screenshot.png', 'C:/workspace/screenshot.png'],
    ['C:\\workspace\\screenshot.png', 'C:\\workspace\\screenshot.png'],
    ['file:///workspace/screen%23shot.png', '/workspace/screen#shot.png'],
    ['screen%shot.png', 'screen%shot.png'],
  ])('parses %s', (source, expected) => {
    expect(parseLocalImagePath(source)).toBe(expected);
  });

  it.each([
    '',
    'https://images.test/example.png',
    'http://images.test/example.png',
    '//images.test/example.png',
    'file://images.test/example.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'image.png?query=1',
    'image.png#fragment',
    'image%00.png',
    'file:///image%0a.png',
    'a'.repeat(4097),
  ])('rejects %s', (source) => {
    expect(parseLocalImagePath(source)).toBeNull();
  });
});
