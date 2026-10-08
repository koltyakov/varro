import { describe, expect, it } from 'vitest';
import { isSafeExternalHref, splitExternalLinkText } from './external-link';

describe('isSafeExternalHref', () => {
  it.each(['https://example.com', 'http://localhost:3000', 'http://app.above-all.test'])(
    'allows %s',
    (href) => {
      expect(isSafeExternalHref(href)).toBe(true);
    }
  );

  it.each([null, '', 'javascript:alert(1)', 'file:///etc/passwd', '//example.com', 'http://'])(
    'rejects %s',
    (href) => {
      expect(isSafeExternalHref(href)).toBe(false);
    }
  );
});

describe('splitExternalLinkText', () => {
  it.each([
    'http://localhost:3000',
    'http://app.above-all.test/documentation',
    'http://[::1]:8001',
  ])('links the HTTP URL %s without trailing punctuation', (href) => {
    expect(splitExternalLinkText(`See ${href}.`)).toEqual([
      { type: 'text', content: 'See ' },
      { type: 'external-link', href, target: href, kind: 'web' },
      { type: 'text', content: '.' },
    ]);
  });

  it('trims punctuation exposed by unmatched closing delimiters', () => {
    expect(splitExternalLinkText('(see https://example.com/page.)')).toEqual([
      { type: 'text', content: '(see ' },
      {
        type: 'external-link',
        href: 'https://example.com/page',
        target: 'https://example.com/page',
        kind: 'web',
      },
      { type: 'text', content: '.)' },
    ]);
  });

  it('keeps balanced closing delimiters in URLs', () => {
    expect(splitExternalLinkText('https://example.com/page_(one).')).toEqual([
      {
        type: 'external-link',
        href: 'https://example.com/page_(one)',
        target: 'https://example.com/page_(one)',
        kind: 'web',
      },
      { type: 'text', content: '.' },
    ]);
  });
});
