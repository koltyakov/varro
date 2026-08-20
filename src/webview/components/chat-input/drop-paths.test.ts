import { describe, expect, it } from 'vitest';
import {
  collectDroppedPaths,
  parseDroppedText,
  readFileAsBase64,
  readFileAsDataUrl,
  readItemByType,
} from './drop-paths';
import { fixture } from '../../test-fixtures';

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

  it('does not treat path-like fragments in test output as dropped files', () => {
    expect(
      parseDroppedText(
        [
          '⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯',
          'FAIL  src/extension/dropped-files-service.test.ts > DroppedFilesService',
          '❯ src/extension/dropped-files-service.test.ts:293:3',
          '⎯⎯⎯⎯⎯[1/2]⎯',
          '❯ src/extension/util/webview-message.test.ts:224:3',
          '⎯⎯⎯⎯⎯[2/2]⎯',
        ].join('\n')
      )
    ).toEqual([]);
  });
});

describe('collectDroppedPaths', () => {
  it('ignores UI-machine File.path values remotely while preserving workspace URI drops', async () => {
    // SAFETY: The fixture provides the File & { path: string } fields read by this statement.
    const localFile = { path: '/Users/local/Desktop/note.txt' } as File & { path: string };
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const dataTransfer = fixture<DataTransfer>({
      types: ['CodeEditors', 'text/uri-list'],
      files: [localFile],
      items: [{ kind: 'file', getAsFile: () => localFile }],
      getData: (type: string) => {
        if (type === 'CodeEditors') {
          return JSON.stringify([{ resource: 'file:///remote-workspace/src/app.ts' }]);
        }
        return type === 'text/uri-list' ? 'file:///Users/local/Desktop/note.txt' : '';
      },
    });

    await expect(
      collectDroppedPaths(dataTransfer, {
        includeFilePaths: false,
        preferFileContent: true,
      })
    ).resolves.toEqual(['/remote-workspace/src/app.ts']);
  });

  it('prefers content over generic local file URIs for remote drops', async () => {
    // SAFETY: The fixture provides the File & { path: string } fields read by this statement.
    const localFile = { path: '/Users/local/Desktop/note.txt' } as File & { path: string };
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const dataTransfer = fixture<DataTransfer>({
      types: ['text/uri-list'],
      files: [localFile],
      items: [{ kind: 'file', getAsFile: () => localFile }],
      getData: (type: string) =>
        type === 'text/uri-list' ? 'file:///Users/local/Desktop/note.txt' : '',
    });

    await expect(
      collectDroppedPaths(dataTransfer, {
        includeFilePaths: false,
        preferFileContent: true,
      })
    ).resolves.toEqual([]);
  });

  it('keeps File.path extraction enabled by default for local extension hosts', async () => {
    // SAFETY: The fixture provides the File & { path: string } fields read by this statement.
    const localFile = { path: '/Users/local/Desktop/note.txt' } as File & { path: string };
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const dataTransfer = fixture<DataTransfer>({
      types: [],
      files: [localFile],
      items: [],
      getData: () => '',
    });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual([
      '/Users/local/Desktop/note.txt',
    ]);
  });
});

function makeDataTransfer(
  data: Record<string, string>,
  overrides: Partial<{
    files: unknown[];
    items: unknown[];
    types: string[];
  }> = {}
) {
  // SAFETY: The fixture provides the unknown fields read by this statement.
  return fixture<DataTransfer>({
    types: overrides.types ?? Object.keys(data),
    files: overrides.files ?? [],
    items: overrides.items ?? [],
    getData: (type: string) => data[type] ?? '',
  });
}

describe('VS Code drop payload parsers', () => {
  it('reads editor drops from the CodeEditors payload', async () => {
    const dataTransfer = makeDataTransfer({
      CodeEditors: JSON.stringify([
        { resource: 'file:///repo/src/a.ts' },
        { resource: 'file:///repo/src/b.ts' },
      ]),
    });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual([
      '/repo/src/a.ts',
      '/repo/src/b.ts',
    ]);
  });

  it('accepts bare strings inside the CodeEditors payload', async () => {
    const dataTransfer = makeDataTransfer({
      CodeEditors: JSON.stringify(['file:///repo/src/a.ts', null, 42]),
    });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual(['/repo/src/a.ts']);
  });

  it('ignores a malformed CodeEditors payload instead of throwing', async () => {
    const dataTransfer = makeDataTransfer({ CodeEditors: '{not json' });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual([]);
  });

  it('reads explorer drops from the CodeFiles payload', async () => {
    const dataTransfer = makeDataTransfer({
      CodeFiles: JSON.stringify(['/repo/src/a.ts', 7, '/repo/src/b.ts']),
    });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual([
      '/repo/src/a.ts',
      '/repo/src/b.ts',
    ]);
  });

  it('reads a JSON ResourceURLs payload', async () => {
    const dataTransfer = makeDataTransfer({
      ResourceURLs: JSON.stringify(['file:///repo/src/a.ts']),
    });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual(['/repo/src/a.ts']);
  });

  it('falls back to uri-list parsing when ResourceURLs is not JSON', async () => {
    const dataTransfer = makeDataTransfer({
      ResourceURLs: 'file:///repo/src/a.ts\nfile:///repo/src/b.ts',
    });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual([
      '/repo/src/a.ts',
      '/repo/src/b.ts',
    ]);
  });

  it('reads the vscode uri-list payload', async () => {
    const dataTransfer = makeDataTransfer({
      'application/vnd.code.uri-list': 'file:///repo/src/a.ts\r\nfile:///repo/src/b.ts',
    });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual([
      '/repo/src/a.ts',
      '/repo/src/b.ts',
    ]);
  });

  it('deduplicates the same file arriving through several payloads', async () => {
    const dataTransfer = makeDataTransfer({
      CodeEditors: JSON.stringify([{ resource: 'file:///repo/src/a.ts' }]),
      CodeFiles: JSON.stringify(['/repo/src/a.ts']),
      'text/uri-list': 'file:///repo/src/a.ts',
    });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual(['/repo/src/a.ts']);
  });

  it('tolerates a getData implementation that throws for a type', async () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const dataTransfer = fixture<DataTransfer>({
      types: ['text/plain', 'text/uri-list'],
      files: [],
      items: [],
      getData: (type: string) => {
        if (type === 'text/plain') throw new Error('unavailable');
        return 'file:///repo/src/a.ts';
      },
    });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual(['/repo/src/a.ts']);
  });

  it('reads string items asynchronously when no synchronous payload yields a path', async () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const dataTransfer = fixture<DataTransfer>({
      types: [],
      files: [],
      items: [
        {
          kind: 'string',
          type: 'text/plain',
          getAsFile: () => null,
          getAsString: (callback: (value: string) => void) => callback('/repo/src/async.ts'),
        },
        { kind: 'file', getAsFile: () => null },
      ],
      getData: () => '',
    });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual(['/repo/src/async.ts']);
  });

  it('collects File.path from data transfer items as well as the file list', async () => {
    // SAFETY: The fixture provides the File & { path: string } fields read by this statement.
    const itemFile = { path: '/repo/from-item.ts' } as File & { path: string };
    // SAFETY: The fixture provides the File & { path: string } fields read by this statement.
    const dataTransfer = fixture<DataTransfer>({
      types: [],
      files: [{ path: '/repo/from-files.ts' } as File & { path: string }],
      items: [{ kind: 'file', getAsFile: () => itemFile }],
      getData: () => '',
    });

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual([
      '/repo/from-files.ts',
      '/repo/from-item.ts',
    ]);
  });

  it('returns nothing when there is no data transfer at all', async () => {
    await expect(collectDroppedPaths(null)).resolves.toEqual([]);
  });
});

describe('dropped path decoding', () => {
  it.each([
    ['file:///repo/src/a.ts', '/repo/src/a.ts'],
    ['file:///c%3A/repo/a.ts', 'c:/repo/a.ts'],
    ['vscode-file://vscode-app/repo/a.ts', '/repo/a.ts'],
    ['file://server/share/a.ts', '//server/share/a.ts'],
    ['file:///repo/with%20space.ts', '/repo/with space.ts'],
  ])('decodes %s', (input, expected) => {
    expect(parseDroppedText(input)).toEqual([expected]);
  });

  it('keeps an absolute posix path as-is', () => {
    expect(parseDroppedText('/repo/src/a.ts')).toEqual(['/repo/src/a.ts']);
  });

  it('keeps a windows drive path as-is', () => {
    expect(parseDroppedText('C:\\repo\\a.ts')).toEqual(['C:\\repo\\a.ts']);
  });

  it('normalizes workspace-relative paths and strips a leading ./', () => {
    expect(parseDroppedText('./src/a.ts')).toEqual(['src/a.ts']);
  });

  it('rejects bare words that are not path-like', () => {
    expect(parseDroppedText('hello')).toEqual([]);
  });

  it('rejects values containing whitespace as relative paths', () => {
    expect(parseDroppedText('some file.ts')).toEqual([]);
  });

  it('rejects dot and double-dot entries', () => {
    expect(parseDroppedText('.')).toEqual([]);
    expect(parseDroppedText('..')).toEqual([]);
  });

  it('accepts a bare filename with an extension', () => {
    expect(parseDroppedText('README.md')).toEqual(['README.md']);
  });

  it('ignores an unparseable url scheme', () => {
    expect(parseDroppedText('http://')).toEqual([]);
  });
});

describe('readItemByType', () => {
  it('resolves the string item matching the requested type', async () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const dataTransfer = fixture<DataTransfer>({
      items: [
        { kind: 'string', type: 'text/plain', getAsString: (cb: (v: string) => void) => cb('hi') },
      ],
      getData: () => 'unused',
    });

    await expect(readItemByType(dataTransfer, 'text/plain')).resolves.toBe('hi');
  });

  it('falls back to getData when no matching item exists', async () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const dataTransfer = fixture<DataTransfer>({
      items: [],
      getData: (type: string) => (type === 'text/plain' ? 'from-getData' : ''),
    });

    await expect(readItemByType(dataTransfer, 'text/plain')).resolves.toBe('from-getData');
  });

  it('resolves an empty string when the item yields nothing', async () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const dataTransfer = fixture<DataTransfer>({
      items: [
        { kind: 'string', type: 'text/plain', getAsString: (cb: (v: string) => void) => cb('') },
      ],
      getData: () => '',
    });

    await expect(readItemByType(dataTransfer, 'text/plain')).resolves.toBe('');
  });
});

describe('file readers', () => {
  it('reads a file as a data url', async () => {
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });

    await expect(readFileAsDataUrl(file)).resolves.toMatch(/^data:text\/plain;base64,/);
  });

  it('reads a file as bare base64 without the data url prefix', async () => {
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });

    await expect(readFileAsBase64(file)).resolves.toBe(btoa('hello'));
  });
});
