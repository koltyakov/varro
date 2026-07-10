import { describe, expect, it } from 'vitest';
import { collectDroppedPaths, parseDroppedText } from './drop-paths';

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

describe('collectDroppedPaths', () => {
  it('ignores UI-machine File.path values remotely while preserving workspace URI drops', async () => {
    const localFile = { path: '/Users/local/Desktop/note.txt' } as File & { path: string };
    const dataTransfer = {
      types: ['CodeEditors', 'text/uri-list'],
      files: [localFile],
      items: [{ kind: 'file', getAsFile: () => localFile }],
      getData: (type: string) => {
        if (type === 'CodeEditors') {
          return JSON.stringify([{ resource: 'file:///remote-workspace/src/app.ts' }]);
        }
        return type === 'text/uri-list' ? 'file:///Users/local/Desktop/note.txt' : '';
      },
    } as unknown as DataTransfer;

    await expect(
      collectDroppedPaths(dataTransfer, {
        includeFilePaths: false,
        preferFileContent: true,
      })
    ).resolves.toEqual(['/remote-workspace/src/app.ts']);
  });

  it('prefers content over generic local file URIs for remote drops', async () => {
    const localFile = { path: '/Users/local/Desktop/note.txt' } as File & { path: string };
    const dataTransfer = {
      types: ['text/uri-list'],
      files: [localFile],
      items: [{ kind: 'file', getAsFile: () => localFile }],
      getData: (type: string) =>
        type === 'text/uri-list' ? 'file:///Users/local/Desktop/note.txt' : '',
    } as unknown as DataTransfer;

    await expect(
      collectDroppedPaths(dataTransfer, {
        includeFilePaths: false,
        preferFileContent: true,
      })
    ).resolves.toEqual([]);
  });

  it('keeps File.path extraction enabled by default for local extension hosts', async () => {
    const localFile = { path: '/Users/local/Desktop/note.txt' } as File & { path: string };
    const dataTransfer = {
      types: [],
      files: [localFile],
      items: [],
      getData: () => '',
    } as unknown as DataTransfer;

    await expect(collectDroppedPaths(dataTransfer)).resolves.toEqual([
      '/Users/local/Desktop/note.txt',
    ]);
  });
});
