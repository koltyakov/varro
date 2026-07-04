import { describe, expect, it } from 'vitest';
import { parseDroppedText } from './drop-paths';

describe('parseDroppedText', () => {
  it('parses absolute, relative, and uri-list entries while dropping comments and duplicates', () => {
    expect(
      parseDroppedText(
        [
          '# comment',
          'file:///tmp/demo.ts',
          './src/app.ts',
          './src/app.ts',
          '/Users/andrew/Projects/GitHub/varro/README.md',
        ].join('\n')
      )
    ).toEqual(['/tmp/demo.ts', 'src/app.ts', '/Users/andrew/Projects/GitHub/varro/README.md']);
  });

  it('extracts paths from structured vscode drag payloads', () => {
    expect(
      parseDroppedText(
        JSON.stringify({
          resource: 'file:///tmp/from-resource.ts',
          nested: ['src/test.ts', { path: '../docs/guide.md' }],
          ignored: 'not a plain sentence with spaces',
        })
      )
    ).toEqual(['/tmp/from-resource.ts', 'src/test.ts', '../docs/guide.md']);
  });
});
