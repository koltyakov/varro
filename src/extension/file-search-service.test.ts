/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- These tests verify the VS Code search boundary with partial workspace and cancellation fixtures. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import type * as ChildProcess from 'child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const gitMock = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile: gitMock.execFile,
}));

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
}));

const vscodeMock = vi.hoisted(() => ({
  workspaceFolder: { name: 'repo', uri: { fsPath: '/repo' } },
  workspace: {
    asRelativePath: vi.fn((uri: { fsPath: string }) => uri.fsPath.replace('/repo/', '')),
    createFileSystemWatcher: vi.fn(),
    findFiles: vi.fn(),
    getWorkspaceFolder: vi.fn(),
    workspaceFolders: [] as Array<{ name: string; uri: { fsPath: string } }>,
  },
  CancellationTokenSource: vi.fn(function (this: {
    token: { isCancellationRequested: boolean };
    cancel: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }) {
    this.token = { isCancellationRequested: false };
    this.cancel = vi.fn(() => {
      this.token.isCancellationRequested = true;
    });
    this.dispose = vi.fn();
  }),
  RelativePattern: vi.fn(function (
    this: { base: unknown; pattern: string },
    base: unknown,
    pattern: string
  ) {
    this.base = base;
    this.pattern = pattern;
  }),
  Uri: { file: vi.fn((fsPath: string) => ({ fsPath })) },
}));

vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('vscode', () => vscodeMock);

async function loadModule() {
  return import('./file-search-service');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function search(
  service: {
    search(
      requestId: number,
      query: string,
      limit: number,
      workspaceDirectory: string,
      onResult: (result: unknown) => void
    ): void;
  },
  requestId: number,
  query: string,
  limit: number,
  onResult: (result: unknown) => void,
  workspaceDirectory = '/repo'
) {
  service.search(requestId, query, limit, workspaceDirectory, onResult);
}

describe('FileSearchService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    gitMock.execFile
      .mockReset()
      .mockImplementation(
        (
          _command: string,
          _args: string[],
          _options: unknown,
          callback: (error: { code: string }, stdout: string, stderr: string) => void
        ) => callback({ code: 'ENOENT' }, '', '')
      );
    const workspaceFolder = vscodeMock.workspaceFolder;
    vscodeMock.workspace.createFileSystemWatcher.mockImplementation(() => {
      let createListener: ((uri: { fsPath: string }) => void) | undefined;
      let deleteListener: ((uri: { fsPath: string }) => void) | undefined;
      let changeListener: (() => void) | undefined;
      return {
        onDidCreate: vi.fn((listener: (uri: { fsPath: string }) => void) => {
          createListener = listener;
          return { dispose: vi.fn() };
        }),
        onDidDelete: vi.fn((listener: (uri: { fsPath: string }) => void) => {
          deleteListener = listener;
          return { dispose: vi.fn() };
        }),
        onDidChange: vi.fn((listener: () => void) => {
          changeListener = listener;
          return { dispose: vi.fn() };
        }),
        dispose: vi.fn(),
        fireCreate: (fsPath = '/repo/src/new.ts') => createListener?.({ fsPath }),
        fireDelete: (fsPath = '/repo/src/old.ts') => deleteListener?.({ fsPath }),
        fireChange: () => changeListener?.(),
      };
    });
    vscodeMock.workspace.asRelativePath.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath.replace('/repo/', '')
    );
    vscodeMock.workspace.findFiles.mockReset();
    vscodeMock.workspace.getWorkspaceFolder.mockImplementation(() => workspaceFolder);
    vscodeMock.workspace.workspaceFolders = [workspaceFolder];
  });

  it('creates the workspace watcher lazily on first search', async () => {
    vscodeMock.workspace.findFiles.mockResolvedValue([]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();

    expect(vscodeMock.workspace.createFileSystemWatcher).not.toHaveBeenCalled();

    const onResult = vi.fn();
    search(service, 1, '', 10, onResult);
    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
    });

    expect(vscodeMock.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(1);
    expect(vscodeMock.workspace.createFileSystemWatcher).toHaveBeenCalledWith(
      expect.objectContaining({ base: vscodeMock.workspaceFolder, pattern: '**/*' }),
      false,
      true,
      false
    );
    service.dispose();
  });

  it('searches tracked and new project files without ignored artifacts, including nested Git rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'varro-file-search-'));
    const { execFile } = await vi.importActual<typeof ChildProcess>('child_process');
    gitMock.execFile.mockImplementation(execFile);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    try {
      execFileSync('git', ['init', '--quiet', root]);
      await mkdir(join(root, 'artifacts'));
      await mkdir(join(root, 'src'));
      await writeFile(join(root, '.gitignore'), 'artifacts/\n*.log\n');
      await writeFile(join(root, 'src/.gitignore'), '*.md\n!README-new.md\n');
      const paths = [
        'README.md',
        'src/README-new.md',
        'src/README-hidden.md',
        'artifacts/README.md',
        'README.log',
      ];
      await Promise.all(paths.map((path) => writeFile(join(root, path), 'test')));
      execFileSync('git', ['-C', root, 'add', 'README.md']);
      // A tracked file remains searchable even when an ignore rule matches it.
      await writeFile(join(root, '.gitignore'), 'artifacts/\n*.log\nREADME.md\n');
      const folder = { name: 'project', uri: { fsPath: root } };
      vscodeMock.workspace.workspaceFolders = [folder];
      vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(folder);
      vscodeMock.workspace.asRelativePath.mockImplementation((uri: { fsPath: string }) =>
        uri.fsPath.slice(root.length + 1)
      );
      vscodeMock.workspace.findFiles.mockResolvedValue(
        paths.map((path) => ({ fsPath: join(root, path) }))
      );
      const onResult = vi.fn();
      search(service, 1, 'README', 12, onResult, root);
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
      expect(onResult).toHaveBeenCalledWith({
        requestId: 1,
        query: 'README',
        files: [
          { path: join(root, 'README.md'), relativePath: 'README.md', type: 'file' },
          {
            path: join(root, 'src/README-new.md'),
            relativePath: 'src/README-new.md',
            type: 'file',
          },
        ],
      });
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores content changes when maintaining the file-name cache', async () => {
    vscodeMock.workspace.findFiles.mockResolvedValue([{ fsPath: '/repo/src/first.ts' }]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const firstResult = vi.fn();
    const secondResult = vi.fn();

    search(service, 1, '', 10, firstResult);
    await vi.waitFor(() => expect(firstResult).toHaveBeenCalledTimes(1));

    const watcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]?.value as {
      fireChange: () => void;
    };
    watcher.fireChange();
    search(service, 2, '', 10, secondResult);
    await vi.waitFor(() => expect(secondResult).toHaveBeenCalledTimes(1));

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it.each(['fireCreate', 'fireDelete'] as const)('ignores excluded paths on %s', async (event) => {
    vscodeMock.workspace.findFiles.mockResolvedValue([{ fsPath: '/repo/src/first.ts' }]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const onResult = vi.fn();
    try {
      search(service, 1, '', 10, onResult);
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
      const watcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]!.value as {
        fireCreate(path: string): void;
        fireDelete(path: string): void;
      };
      for (const directory of ['dist', 'build', 'node_modules', '.git', 'coverage']) {
        watcher[event](`/repo/packages/app/${directory}/output.js`);
      }
      search(service, 2, '', 10, onResult);
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));
      expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(1);
      watcher[event]('/repo/src/new-file.ts');
      search(service, 3, '', 10, onResult);
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(3));
      expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
    }
  });

  it('disposes an inactive watcher and recreates it on the next search', async () => {
    vi.useFakeTimers();
    vscodeMock.workspace.findFiles.mockResolvedValue([]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const firstResult = vi.fn();

    search(service, 1, '', 10, firstResult);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstResult).toHaveBeenCalledTimes(1);
    const firstWatcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]?.value as {
      dispose: ReturnType<typeof vi.fn>;
    };

    await vi.advanceTimersByTimeAsync(14_999);
    expect(firstWatcher.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(firstWatcher.dispose).toHaveBeenCalledTimes(1);

    search(service, 2, '', 10, vi.fn());
    expect(vscodeMock.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('cancels stale delivery without cancelling shared workspace discovery', async () => {
    const pendingFiles = deferred<Array<{ fsPath: string }>>();
    vscodeMock.workspace.findFiles.mockReturnValue(pendingFiles.promise);
    const onResult = vi.fn();
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();

    search(service, 1, 'first', 10, onResult);
    search(service, 2, 'reader', 10, onResult);
    pendingFiles.resolve([{ fsPath: '/repo/docs/readme.md' }, { fsPath: '/repo/src/reader.ts' }]);
    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
    });

    const [firstSearch, secondSearch] = vscodeMock.CancellationTokenSource.mock.instances as Array<{
      cancel: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }>;

    expect(firstSearch?.cancel).toHaveBeenCalledTimes(1);
    expect(firstSearch?.dispose).toHaveBeenCalledTimes(1);
    expect(vscodeMock.workspace.findFiles.mock.calls[0]).toHaveLength(2);
    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledWith(
      expect.objectContaining({ base: vscodeMock.workspaceFolder, pattern: '**/*' }),
      '{**/node_modules/**,**/.venv/**,**/venv/**,**/.tox/**,**/__pycache__/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/.turbo/**,**/tmp/**,**/coverage/**}'
    );
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({
      requestId: 2,
      query: 'reader',
      files: [{ path: '/repo/src/reader.ts', relativePath: 'src/reader.ts', type: 'file' }],
    });

    service.dispose();
    expect(secondSearch?.cancel).toHaveBeenCalledTimes(1);
    expect(secondSearch?.dispose).toHaveBeenCalledTimes(1);
  });

  it('finds files beyond the first 4,000 discovered workspace entries', async () => {
    const files = Array.from({ length: 4_000 }, (_, index) => ({
      fsPath: `/repo/src/file-${index}.ts`,
    }));
    files.push({ fsPath: '/repo/src/last-file.ts' });
    vscodeMock.workspace.findFiles.mockImplementation(
      (_include: unknown, _exclude: unknown, maxResults?: number) =>
        Promise.resolve(maxResults === undefined ? files : files.slice(0, maxResults))
    );
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const onResult = vi.fn();
    try {
      search(service, 1, 'last-file.ts', 10, onResult);
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
      expect(onResult).toHaveBeenCalledWith({
        requestId: 1,
        query: 'last-file.ts',
        files: [{ path: '/repo/src/last-file.ts', relativePath: 'src/last-file.ts', type: 'file' }],
      });
    } finally {
      service.dispose();
    }
  });

  it('matches read as contiguous text instead of scattered letters in unrelated paths', async () => {
    vscodeMock.workspace.findFiles.mockResolvedValue([
      { fsPath: '/repo/README.md' },
      { fsPath: '/repo/src/session-read-state.ts' },
      { fsPath: '/repo/docs/reading/guide.md' },
      { fsPath: '/repo/scripts/vscode-sandbox/run.ts' },
      { fsPath: '/repo/src/shared/pasted-text.ts' },
    ]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const onResult = vi.fn();
    try {
      search(service, 1, 'ReAd', 12, onResult);
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
      expect(onResult).toHaveBeenCalledWith({
        requestId: 1,
        query: 'ReAd',
        files: [
          { path: '/repo/docs/reading', relativePath: 'docs/reading', type: 'directory' },
          { path: '/repo/README.md', relativePath: 'README.md', type: 'file' },
          {
            path: '/repo/src/session-read-state.ts',
            relativePath: 'src/session-read-state.ts',
            type: 'file',
          },
          {
            path: '/repo/docs/reading/guide.md',
            relativePath: 'docs/reading/guide.md',
            type: 'file',
          },
        ],
      });
    } finally {
      service.dispose();
    }
  });

  it('returns unique parent folders ahead of their matching files', async () => {
    vscodeMock.workspace.findFiles.mockResolvedValue([
      { fsPath: '/repo/src/components/Button.tsx' },
      { fsPath: '/repo/src/components/Input.tsx' },
    ]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const onResult = vi.fn();
    try {
      search(service, 1, 'src', 10, onResult);
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
      expect(onResult).toHaveBeenCalledWith({
        requestId: 1,
        query: 'src',
        files: [
          { path: '/repo/src', relativePath: 'src', type: 'directory' },
          {
            path: '/repo/src/components',
            relativePath: 'src/components',
            type: 'directory',
          },
          {
            path: '/repo/src/components/Input.tsx',
            relativePath: 'src/components/Input.tsx',
            type: 'file',
          },
          {
            path: '/repo/src/components/Button.tsx',
            relativePath: 'src/components/Button.tsx',
            type: 'file',
          },
        ],
      });
    } finally {
      service.dispose();
    }
  });

  it('reuses cached workspace files until dispose clears the cache', async () => {
    vscodeMock.workspace.findFiles.mockResolvedValue([
      { fsPath: '/repo/src/very/long-name.ts' },
      { fsPath: '/repo/a.ts' },
    ]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const firstResult = vi.fn();
    const secondResult = vi.fn();
    const thirdResult = vi.fn();

    search(service, 1, '', 0, firstResult);
    await vi.waitFor(() => {
      expect(firstResult).toHaveBeenCalledTimes(1);
    });
    search(service, 2, '', 5, secondResult);
    await vi.waitFor(() => {
      expect(secondResult).toHaveBeenCalledTimes(1);
    });

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(1);
    expect(firstResult).toHaveBeenCalledWith({
      requestId: 1,
      query: '',
      files: [{ path: '/repo/src', relativePath: 'src', type: 'directory' }],
    });
    expect(secondResult).toHaveBeenCalledWith({
      requestId: 2,
      query: '',
      files: [
        { path: '/repo/src', relativePath: 'src', type: 'directory' },
        { path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
        { path: '/repo/src/very', relativePath: 'src/very', type: 'directory' },
        {
          path: '/repo/src/very/long-name.ts',
          relativePath: 'src/very/long-name.ts',
          type: 'file',
        },
      ],
    });

    service.dispose();

    search(service, 3, '', 5, thirdResult);
    await vi.waitFor(() => {
      expect(thirdResult).toHaveBeenCalledTimes(1);
    });

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(2);
    expect(thirdResult).toHaveBeenCalledTimes(1);
  });

  it('invalidates the workspace cache when files change', async () => {
    vscodeMock.workspace.findFiles
      .mockResolvedValueOnce([{ fsPath: '/repo/src/first.ts' }])
      .mockResolvedValueOnce([{ fsPath: '/repo/src/second.ts' }]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const firstResult = vi.fn();
    const secondResult = vi.fn();

    search(service, 1, '', 10, firstResult);
    await vi.waitFor(() => {
      expect(firstResult).toHaveBeenCalledTimes(1);
    });

    const watcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]?.value as {
      fireCreate: () => void;
    };

    watcher.fireCreate();

    search(service, 2, '', 10, secondResult);
    await vi.waitFor(() => {
      expect(secondResult).toHaveBeenCalledTimes(1);
    });

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(2);
    expect(firstResult).toHaveBeenCalledWith({
      requestId: 1,
      query: '',
      files: [
        { path: '/repo/src', relativePath: 'src', type: 'directory' },
        { path: '/repo/src/first.ts', relativePath: 'src/first.ts', type: 'file' },
      ],
    });
    expect(secondResult).toHaveBeenCalledWith({
      requestId: 2,
      query: '',
      files: [
        { path: '/repo/src', relativePath: 'src', type: 'directory' },
        { path: '/repo/src/second.ts', relativePath: 'src/second.ts', type: 'file' },
      ],
    });
    service.dispose();
  });

  it('reruns discovery instead of publishing a snapshot invalidated in flight', async () => {
    const staleFiles = deferred<Array<{ fsPath: string }>>();
    const freshFiles = deferred<Array<{ fsPath: string }>>();
    vscodeMock.workspace.findFiles
      .mockReturnValueOnce(staleFiles.promise)
      .mockReturnValueOnce(freshFiles.promise);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const onResult = vi.fn();

    search(service, 1, '', 10, onResult);
    const watcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]?.value as {
      fireCreate: () => void;
    };
    watcher.fireCreate();
    staleFiles.resolve([{ fsPath: '/repo/src/stale.ts' }]);
    await vi.waitFor(() => expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(2));

    expect(onResult).not.toHaveBeenCalled();
    freshFiles.resolve([{ fsPath: '/repo/src/fresh.ts' }]);
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
    expect(onResult).toHaveBeenCalledWith({
      requestId: 1,
      query: '',
      files: [
        { path: '/repo/src', relativePath: 'src', type: 'directory' },
        { path: '/repo/src/fresh.ts', relativePath: 'src/fresh.ts', type: 'file' },
      ],
    });
    service.dispose();
  });

  it('stops retrying after repeated in-flight invalidations', async () => {
    vi.useFakeTimers();
    const firstFiles = deferred<Array<{ fsPath: string }>>();
    const secondFiles = deferred<Array<{ fsPath: string }>>();
    vscodeMock.workspace.findFiles
      .mockReturnValueOnce(firstFiles.promise)
      .mockReturnValueOnce(secondFiles.promise);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const onResult = vi.fn();

    search(service, 1, '', 10, onResult);
    const watcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]?.value as {
      fireCreate: () => void;
      fireDelete: () => void;
    };

    watcher.fireCreate();
    firstFiles.resolve([{ fsPath: '/repo/src/first-stale.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(2);

    watcher.fireDelete();
    await vi.advanceTimersByTimeAsync(100);
    secondFiles.resolve([{ fsPath: '/repo/src/second-stale.ts' }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith({ requestId: 1, query: '', files: [] });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'searchFiles failed: Workspace file cache was repeatedly invalidated during discovery'
    );
    service.dispose();
  });

  it('debounces repeated workspace cache invalidations', async () => {
    vscodeMock.workspace.findFiles
      .mockResolvedValueOnce([{ fsPath: '/repo/src/first.ts' }])
      .mockResolvedValueOnce([{ fsPath: '/repo/src/second.ts' }]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const firstResult = vi.fn();
    const secondResult = vi.fn();

    search(service, 1, '', 10, firstResult);
    await vi.waitFor(() => {
      expect(firstResult).toHaveBeenCalledTimes(1);
    });

    const watcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]?.value as {
      fireCreate: () => void;
      fireDelete: () => void;
    };
    watcher.fireCreate();
    watcher.fireDelete();

    search(service, 2, '', 10, secondResult);
    await vi.waitFor(() => {
      expect(secondResult).toHaveBeenCalledTimes(1);
    });

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('clears the cache again after a debounced follow-up file event', async () => {
    vi.useFakeTimers();
    vscodeMock.workspace.findFiles
      .mockResolvedValueOnce([{ fsPath: '/repo/src/first.ts' }])
      .mockResolvedValueOnce([{ fsPath: '/repo/src/second.ts' }])
      .mockResolvedValueOnce([{ fsPath: '/repo/src/third.ts' }]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const firstResult = vi.fn();
    const secondResult = vi.fn();
    const thirdResult = vi.fn();

    search(service, 1, '', 10, firstResult);
    await vi.waitFor(() => {
      expect(firstResult).toHaveBeenCalledTimes(1);
    });

    const watcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]?.value as {
      fireCreate: () => void;
      fireDelete: () => void;
    };

    watcher.fireCreate();

    search(service, 2, '', 10, secondResult);
    await vi.waitFor(() => {
      expect(secondResult).toHaveBeenCalledTimes(1);
    });

    watcher.fireDelete();

    await vi.advanceTimersByTimeAsync(100);

    search(service, 3, '', 10, thirdResult);
    await vi.waitFor(() => {
      expect(thirdResult).toHaveBeenCalledTimes(1);
    });

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(3);
    expect(secondResult).toHaveBeenCalledWith({
      requestId: 2,
      query: '',
      files: [
        { path: '/repo/src', relativePath: 'src', type: 'directory' },
        { path: '/repo/src/second.ts', relativePath: 'src/second.ts', type: 'file' },
      ],
    });
    expect(thirdResult).toHaveBeenCalledWith({
      requestId: 3,
      query: '',
      files: [
        { path: '/repo/src', relativePath: 'src', type: 'directory' },
        { path: '/repo/src/third.ts', relativePath: 'src/third.ts', type: 'file' },
      ],
    });

    service.dispose();
  });

  it('discovers and root-qualifies results from every open workspace folder', async () => {
    vscodeMock.workspace.workspaceFolders = [
      { name: 'repo', uri: { fsPath: '/repo' } },
      { name: 'docs', uri: { fsPath: '/docs' } },
    ];
    vscodeMock.workspace.findFiles.mockImplementation(
      (pattern: { base: { uri: { fsPath: string } } }) =>
        Promise.resolve(
          pattern.base.uri.fsPath === '/repo'
            ? [{ fsPath: '/repo/src/app.ts' }]
            : [{ fsPath: '/docs/guide.md' }]
        )
    );
    vscodeMock.workspace.getWorkspaceFolder.mockImplementation((uri: { fsPath: string }) =>
      vscodeMock.workspace.workspaceFolders.find((folder) =>
        uri.fsPath.startsWith(folder.uri.fsPath)
      )
    );
    vscodeMock.workspace.asRelativePath.mockImplementation((uri: { fsPath: string }) => {
      if (uri.fsPath.startsWith('/repo/')) return uri.fsPath.replace('/repo/', '');
      if (uri.fsPath.startsWith('/docs/')) return uri.fsPath.replace('/docs/', '');
      return uri.fsPath;
    });

    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const onResult = vi.fn();

    search(service, 1, '', 10, onResult);
    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
    });

    expect(onResult).toHaveBeenCalledWith({
      requestId: 1,
      query: '',
      files: [
        { path: '/docs', relativePath: 'docs', type: 'directory' },
        { path: '/repo', relativePath: 'repo', type: 'directory' },
        { path: '/repo/src', relativePath: 'repo/src', type: 'directory' },
        { path: '/docs/guide.md', relativePath: 'docs/guide.md', type: 'file' },
        { path: '/repo/src/app.ts', relativePath: 'repo/src/app.ts', type: 'file' },
      ],
    });
    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        base: vscodeMock.workspace.workspaceFolders[0],
        pattern: '**/*',
      }),
      expect.any(String)
    );
  });

  it('keeps the shared workspace cache when only the primary directory changes', async () => {
    const repo = vscodeMock.workspaceFolder;
    const docs = { name: 'docs', uri: { fsPath: '/docs' } };
    vscodeMock.workspace.workspaceFolders = [repo, docs];
    vscodeMock.workspace.findFiles
      .mockResolvedValueOnce([{ fsPath: '/repo/src/app.ts' }])
      .mockResolvedValueOnce([{ fsPath: '/docs/guide.md' }]);
    vscodeMock.workspace.getWorkspaceFolder.mockImplementation((uri: { fsPath: string }) =>
      vscodeMock.workspace.workspaceFolders.find((folder) =>
        uri.fsPath.startsWith(folder.uri.fsPath)
      )
    );
    vscodeMock.workspace.asRelativePath.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath.replace(/^\/(?:repo|docs)\//, '')
    );
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const repoResult = vi.fn();
    const docsResult = vi.fn();

    search(service, 1, '', 10, repoResult, '/repo');
    await vi.waitFor(() => expect(repoResult).toHaveBeenCalledOnce());
    search(service, 2, '', 10, docsResult, '/docs');
    await vi.waitFor(() => expect(docsResult).toHaveBeenCalledOnce());

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(2);
    expect(vscodeMock.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
    expect(docsResult).toHaveBeenCalledWith({
      requestId: 2,
      query: '',
      files: [
        { path: '/docs', relativePath: 'docs', type: 'directory' },
        { path: '/repo', relativePath: 'repo', type: 'directory' },
        { path: '/repo/src', relativePath: 'repo/src', type: 'directory' },
        { path: '/docs/guide.md', relativePath: 'docs/guide.md', type: 'file' },
        { path: '/repo/src/app.ts', relativePath: 'repo/src/app.ts', type: 'file' },
      ],
    });
  });

  it('returns no files when the endpoint workspace is not open', async () => {
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const onResult = vi.fn();

    search(service, 1, 'app', 10, onResult, '/closed');

    expect(onResult).toHaveBeenCalledWith({ requestId: 1, query: 'app', files: [] });
    expect(vscodeMock.workspace.findFiles).not.toHaveBeenCalled();
    expect(vscodeMock.workspace.createFileSystemWatcher).not.toHaveBeenCalled();
  });

  it('searches only scratch in an empty window and stops authorizing it when a project opens', async () => {
    const { getVarroStateDirectory } = await import('./varro-state-paths');
    const scratch = getVarroStateDirectory('scratch');
    vscodeMock.workspace.workspaceFolders = [];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscodeMock.workspace.findFiles.mockResolvedValue([{ fsPath: `${scratch}/notes/todo.txt` }]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    try {
      const onResult = vi.fn();
      search(service, 1, 'todo', 10, onResult, scratch);
      await vi.waitFor(() =>
        expect(onResult).toHaveBeenCalledWith({
          requestId: 1,
          query: 'todo',
          files: [
            { path: `${scratch}/notes/todo.txt`, relativePath: 'notes/todo.txt', type: 'file' },
          ],
        })
      );
      expect(vscodeMock.workspace.findFiles).toHaveBeenCalledWith(
        expect.objectContaining({ base: expect.objectContaining({ uri: { fsPath: scratch } }) }),
        expect.any(String)
      );
      vscodeMock.workspace.workspaceFolders = [vscodeMock.workspaceFolder];
      const closedResult = vi.fn();
      search(service, 2, 'todo', 10, closedResult, scratch);
      expect(closedResult).toHaveBeenCalledWith({ requestId: 2, query: 'todo', files: [] });
      expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
    }
  });

  it('returns an empty result and logs a warning when discovery fails', async () => {
    vscodeMock.workspace.findFiles.mockRejectedValue(new Error('boom'));
    const onResult = vi.fn();
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();

    search(service, 7, 'missing', 10, onResult);
    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
    });

    expect(onResult).toHaveBeenCalledWith({ requestId: 7, query: 'missing', files: [] });
    expect(loggerMock.warn).toHaveBeenCalledWith('searchFiles failed: boom');
  });

  it('reuses an empty workspace cache until dispose clears it', async () => {
    vscodeMock.workspace.findFiles.mockResolvedValue([]);
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const firstResult = vi.fn();
    const secondResult = vi.fn();

    search(service, 1, 'missing', 5, firstResult);
    await vi.waitFor(() => {
      expect(firstResult).toHaveBeenCalledTimes(1);
    });

    search(service, 2, 'missing', 5, secondResult);
    await vi.waitFor(() => {
      expect(secondResult).toHaveBeenCalledTimes(1);
    });

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(1);
    expect(firstResult).toHaveBeenCalledWith({ requestId: 1, query: 'missing', files: [] });
    expect(secondResult).toHaveBeenCalledWith({ requestId: 2, query: 'missing', files: [] });
  });
});
