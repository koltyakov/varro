/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise the VS Code search and filesystem boundaries with deterministic providers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { posix } from 'node:path';

const mocks = vi.hoisted(() => {
  const sources: CancellationTokenSource[] = [];
  class CancellationTokenSource {
    private readonly listeners = new Set<() => void>();
    readonly token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      },
    };
    readonly dispose = vi.fn();
    constructor() {
      sources.push(this);
    }
    cancel() {
      this.token.isCancellationRequested = true;
      this.listeners.forEach((listener) => listener());
    }
  }
  return {
    sources,
    CancellationTokenSource,
    settings: new Map<string, Record<string, boolean | { when: string }>>(),
    workspace: {
      findFiles: vi.fn(),
      getConfiguration: vi.fn(),
      getWorkspaceFolder: vi.fn(),
      fs: { readDirectory: vi.fn() },
    },
    readdir: vi.fn(),
    Uri: { file: vi.fn(), joinPath: vi.fn() },
    RelativePattern: class RelativePattern {
      constructor(
        public readonly base: { fsPath: string },
        public readonly pattern: string
      ) {}
    },
    FileType: { File: 1, Directory: 2 },
  };
});

vi.mock('vscode', () => mocks);
vi.mock('node:fs/promises', () => ({ readdir: mocks.readdir }));

import { CitationFileSearch } from './citation-file-search';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('CitationFileSearch', () => {
  let search: CitationFileSearch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mocks.sources.length = 0;
    mocks.settings.clear();
    mocks.Uri.file.mockImplementation((fsPath: string) => ({ fsPath }));
    mocks.Uri.joinPath.mockImplementation((uri: { fsPath: string }, name: string) => ({
      fsPath: posix.join(uri.fsPath, name),
    }));
    mocks.workspace.getConfiguration.mockImplementation(
      (section: string, scope: { fsPath: string }) => ({
        get: () => mocks.settings.get(`${scope.fsPath}:${section}`),
      })
    );
    mocks.workspace.findFiles.mockResolvedValue([]);
    mocks.workspace.fs.readDirectory.mockResolvedValue([]);
    mocks.readdir.mockResolvedValue([]);
    search = new CitationFileSearch();
  });

  afterEach(() => {
    search.dispose();
    vi.useRealTimers();
  });

  it('treats a successful empty search as final without walking either filesystem', async () => {
    await expect(search.find('missing.py', [mocks.Uri.file('/repo')])).resolves.toEqual([]);

    expect(mocks.workspace.fs.readDirectory).not.toHaveBeenCalled();
    expect(mocks.readdir).not.toHaveBeenCalled();
    expect(mocks.workspace.findFiles).toHaveBeenCalledWith(
      new mocks.RelativePattern(mocks.Uri.file('/repo'), '**/missing.py'),
      expect.any(mocks.RelativePattern),
      100,
      mocks.sources[0]!.token
    );
    expect(mocks.sources[0]!.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry an empty fallback directory through Node', async () => {
    mocks.workspace.findFiles.mockRejectedValue(new Error('Index unavailable'));

    await expect(search.find('missing.py', [mocks.Uri.file('/repo')])).resolves.toEqual([]);

    expect(mocks.workspace.fs.readDirectory).toHaveBeenCalledExactlyOnceWith(
      mocks.Uri.file('/repo')
    );
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it('uses Node only for the unreadable directory instead of restarting the walk', async () => {
    mocks.workspace.findFiles.mockRejectedValue(new Error('Index unavailable'));
    mocks.workspace.fs.readDirectory.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/repo') return [['src', 2]];
      throw new Error('Provider unavailable');
    });
    mocks.readdir.mockResolvedValue([{ name: 'train.py', isDirectory: () => false }]);

    await expect(search.find('train.py', [mocks.Uri.file('/repo')])).resolves.toEqual([
      mocks.Uri.file('/repo/src/train.py'),
    ]);

    expect(mocks.workspace.fs.readDirectory.mock.calls).toEqual([
      [mocks.Uri.file('/repo')],
      [mocks.Uri.file('/repo/src')],
    ]);
    expect(mocks.readdir).toHaveBeenCalledExactlyOnceWith('/repo/src', { withFileTypes: true });
  });

  it('merges resource-scoped file and search excludes with false overrides', async () => {
    mocks.settings.set('/repo:files', { '**/generated/**': true, '**/keep/**': true });
    mocks.settings.set('/repo:search', { '**/vendor/**': true, '**/keep/**': false });
    mocks.workspace.findFiles.mockResolvedValue([
      mocks.Uri.file('/repo/generated/train.py'),
      mocks.Uri.file('/repo/vendor/train.py'),
      mocks.Uri.file('/repo/node_modules/train.py'),
      mocks.Uri.file('/repo/keep/train.py'),
    ]);

    await expect(search.find('train.py', [mocks.Uri.file('/repo')])).resolves.toEqual([
      mocks.Uri.file('/repo/keep/train.py'),
    ]);

    const exclude = mocks.workspace.findFiles.mock.calls[0]![1];
    expect(exclude.base).toEqual(mocks.Uri.file('/repo'));
    expect(exclude.pattern).toContain('**/generated/**');
    expect(exclude.pattern).toContain('**/vendor/**');
    expect(exclude.pattern).toContain('**/node_modules/**');
    expect(exclude.pattern).not.toContain('**/keep/**');
    expect(mocks.workspace.getConfiguration.mock.calls).toEqual([
      ['files', mocks.Uri.file('/repo')],
      ['search', mocks.Uri.file('/repo')],
    ]);
  });

  it('anchors exclusions to the owning workspace for a nested session', async () => {
    mocks.workspace.getWorkspaceFolder.mockReturnValue({ uri: mocks.Uri.file('/repo') });
    mocks.settings.set('/repo:search', { 'packages/app/generated/**': true });
    mocks.workspace.findFiles.mockResolvedValue([
      mocks.Uri.file('/repo/packages/app/generated/train.py'),
      mocks.Uri.file('/repo/packages/app/src/train.py'),
    ]);

    await expect(search.find('train.py', [mocks.Uri.file('/repo/packages/app')])).resolves.toEqual([
      mocks.Uri.file('/repo/packages/app/src/train.py'),
    ]);

    expect(mocks.workspace.findFiles.mock.calls[0]![0].base).toEqual(
      mocks.Uri.file('/repo/packages/app')
    );
    expect(mocks.workspace.findFiles.mock.calls[0]![1].base).toEqual(mocks.Uri.file('/repo'));
  });

  it('does not restore implicit file excludes when all merged exclusions are disabled', async () => {
    mocks.settings.set('/repo:files', { '**/generated/**': true });
    mocks.settings.set('/repo:search', {
      ...Object.fromEntries(
        ['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out'].map(
          (name) => [`**/${name}/**`, false]
        )
      ),
      '**/generated/**': false,
    });
    mocks.workspace.findFiles.mockResolvedValue([mocks.Uri.file('/repo/generated/train.py')]);

    await expect(search.find('train.py', [mocks.Uri.file('/repo')])).resolves.toEqual([
      mocks.Uri.file('/repo/generated/train.py'),
    ]);
    expect(mocks.workspace.findFiles.mock.calls[0]![1]).toBeNull();
  });

  it.each(['provider', 'node'])(
    'prunes excluded directories during %s fallback',
    async (backend) => {
      mocks.workspace.findFiles.mockRejectedValue(new Error('Index unavailable'));
      mocks.settings.set('/repo:files', { '**/generated/**': true });
      mocks.settings.set('/repo:search', { '**/vendor/**': true, '**/dist/**': false });
      const directories = new Map<string, [string, number][]>([
        [
          '/repo',
          [
            ['generated', 2],
            ['vendor', 2],
            ['node_modules', 2],
            ['dist', 2],
            ['src', 2],
          ],
        ],
        ['/repo/dist', [['train.py', 1]]],
        ['/repo/src', [['train.py', 1]]],
      ]);
      if (backend === 'provider') {
        mocks.workspace.fs.readDirectory.mockImplementation(
          async (uri: { fsPath: string }) => directories.get(uri.fsPath) ?? []
        );
      } else {
        mocks.workspace.fs.readDirectory.mockRejectedValue(new Error('Provider unavailable'));
        mocks.readdir.mockImplementation(
          async (path: string) =>
            directories
              .get(path)
              ?.map(([name, type]) => ({ name, isDirectory: () => type === 2 })) ?? []
        );
      }

      await expect(search.find('train.py', [mocks.Uri.file('/repo')])).resolves.toEqual([
        mocks.Uri.file('/repo/dist/train.py'),
        mocks.Uri.file('/repo/src/train.py'),
      ]);

      expect(mocks.workspace.fs.readDirectory.mock.calls.map(([uri]) => uri.fsPath)).toEqual([
        '/repo',
        '/repo/dist',
        '/repo/src',
      ]);
    }
  );

  it.each(['index', 'fallback'])(
    'honors sibling-dependent excludes in %s results',
    async (backend) => {
      mocks.settings.set('/repo:files', { '**/*.js': { when: '$(basename).ts' } });
      mocks.workspace.fs.readDirectory.mockResolvedValue([
        ['foo.js', 1],
        ['foo.ts', 1],
        ['bar.js', 1],
      ]);
      if (backend === 'index') {
        mocks.workspace.findFiles.mockResolvedValue([
          mocks.Uri.file('/repo/foo.js'),
          mocks.Uri.file('/repo/bar.js'),
        ]);
      } else {
        mocks.workspace.findFiles.mockRejectedValue(new Error('Index unavailable'));
      }

      await expect(search.find('bar.js', [mocks.Uri.file('/repo')])).resolves.toEqual([
        mocks.Uri.file('/repo/bar.js'),
      ]);
      if (backend === 'fallback') {
        await expect(search.find('foo.js', [mocks.Uri.file('/repo')])).resolves.toEqual([]);
      }
      expect(mocks.workspace.findFiles.mock.calls[0]![1].pattern).not.toContain('**/*.js');
    }
  );

  it('keeps exclusion settings separate across workspace roots', async () => {
    mocks.settings.set('/a:search', { '**/generated/**': true });
    mocks.settings.set('/b:search', { '**/vendor/**': true });

    await expect(
      search.find('train.py', [mocks.Uri.file('/a'), mocks.Uri.file('/b')])
    ).resolves.toEqual([]);

    expect(mocks.workspace.findFiles).toHaveBeenCalledTimes(2);
    expect(mocks.workspace.findFiles.mock.calls[0]![1].pattern).not.toContain('**/vendor/**');
    expect(mocks.workspace.findFiles.mock.calls[1]![1].pattern).not.toContain('**/generated/**');
    expect(mocks.workspace.fs.readDirectory).not.toHaveBeenCalled();
  });

  it('cancels a hung index at the deadline and ignores a late rejection', async () => {
    const index = deferred<never>();
    mocks.workspace.findFiles.mockReturnValue(index.promise);
    const result = search.find('train.py', [mocks.Uri.file('/repo')]);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBeNull();
    expect(mocks.sources[0]!.token.isCancellationRequested).toBe(true);
    expect(mocks.workspace.fs.readDirectory).not.toHaveBeenCalled();
    expect(mocks.readdir).not.toHaveBeenCalled();
    index.reject(new Error('Late provider failure'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['provider', 'node'])(
    'shares the index deadline with a hung %s fallback',
    async (backend) => {
      const index = deferred<never>();
      mocks.workspace.findFiles.mockReturnValue(index.promise);
      if (backend === 'provider') {
        mocks.workspace.fs.readDirectory.mockReturnValue(new Promise(() => {}));
      } else {
        mocks.workspace.fs.readDirectory.mockRejectedValue(new Error('Provider unavailable'));
        mocks.readdir.mockReturnValue(new Promise(() => {}));
      }
      let settled = false;
      const result = search.find('train.py', [mocks.Uri.file('/repo')]).then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(4_000);
      index.reject(new Error('Index unavailable'));
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBeNull();
      expect(mocks.sources[0]!.token.isCancellationRequested).toBe(true);
      expect(mocks.workspace.findFiles).toHaveBeenCalledOnce();
      expect(mocks.workspace.fs.readDirectory).toHaveBeenCalledOnce();
      expect(mocks.readdir).toHaveBeenCalledTimes(backend === 'node' ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('shares the deadline across roots rather than granting each root five seconds', async () => {
    const first = deferred<[]>();
    mocks.workspace.findFiles
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(new Promise(() => {}));
    const result = search.find('train.py', [mocks.Uri.file('/a'), mocks.Uri.file('/b')]);
    await vi.advanceTimersByTimeAsync(4_000);
    first.resolve([]);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBeNull();
    expect(mocks.workspace.findFiles).toHaveBeenCalledTimes(2);
    expect(mocks.workspace.findFiles.mock.calls[0]![3]).toBe(
      mocks.workspace.findFiles.mock.calls[1]![3]
    );
    expect(mocks.workspace.fs.readDirectory).not.toHaveBeenCalled();
  });

  it('shares the traversal entry cap across roots without accepting partial results', async () => {
    mocks.workspace.findFiles.mockRejectedValue(new Error('Index unavailable'));
    mocks.workspace.fs.readDirectory
      .mockResolvedValueOnce(Array.from({ length: 10_000 }, (_, index) => [`a-${index}.txt`, 1]))
      .mockResolvedValueOnce([
        ['train.py', 1],
        ...Array.from({ length: 10_000 }, (_, index) => [`b-${index}.txt`, 1]),
      ]);

    await expect(
      search.find('train.py', [mocks.Uri.file('/a'), mocks.Uri.file('/b')])
    ).resolves.toBeNull();

    expect(mocks.workspace.fs.readDirectory).toHaveBeenCalledTimes(2);
    expect(mocks.readdir).not.toHaveBeenCalled();
    expect(mocks.sources[0]!.token.isCancellationRequested).toBe(true);
  });

  it('cancels superseded discovery without discarding the new search', async () => {
    const first = deferred<never>();
    mocks.workspace.findFiles
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([mocks.Uri.file('/repo/src/new.py')]);
    const oldResult = search.find('old.py', [mocks.Uri.file('/repo')]);

    await expect(search.find('new.py', [mocks.Uri.file('/repo')])).resolves.toEqual([
      mocks.Uri.file('/repo/src/new.py'),
    ]);
    await expect(oldResult).resolves.toBeNull();
    expect(mocks.sources[0]!.token.isCancellationRequested).toBe(true);
    expect(mocks.sources[1]!.token.isCancellationRequested).toBe(false);
    expect(mocks.sources.every((source) => source.dispose.mock.calls.length === 1)).toBe(true);
    expect(mocks.workspace.fs.readDirectory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending discovery when its owner is disposed', async () => {
    mocks.workspace.findFiles.mockReturnValue(new Promise(() => {}));
    const result = search.find('train.py', [mocks.Uri.file('/repo')]);

    search.dispose();

    await expect(result).resolves.toBeNull();
    expect(mocks.sources[0]!.token.isCancellationRequested).toBe(true);
    expect(mocks.sources[0]!.dispose).toHaveBeenCalledOnce();
    expect(mocks.workspace.fs.readDirectory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(search.find('later.py', [mocks.Uri.file('/repo')])).resolves.toBeNull();
    expect(mocks.workspace.findFiles).toHaveBeenCalledOnce();
  });
});
