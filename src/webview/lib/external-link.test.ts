import { describe, expect, it } from 'vitest';
import { splitExternalLinkText } from './external-link';

describe('splitExternalLinkText', () => {
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
