/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- These tests verify the VS Code search boundary with partial workspace and cancellation fixtures. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  CancellationTokenSource: vi.fn(
    function (this: {
      token: { isCancellationRequested: boolean };
      cancel: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }) {
      this.token = { isCancellationRequested: false };
      this.cancel = vi.fn(() => {
        this.token.isCancellationRequested = true;
      });
      this.dispose = vi.fn();
    }
  ),
  RelativePattern: vi.fn(function (
    this: { base: unknown; pattern: string },
    base: unknown,
    pattern: string
  ) {
    this.base = base;
    this.pattern = pattern;
  }),
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
    const workspaceFolder = vscodeMock.workspaceFolder;
    vscodeMock.workspace.createFileSystemWatcher.mockImplementation(() => {
      let createListener: (() => void) | undefined;
      let deleteListener: (() => void) | undefined;
      let changeListener: (() => void) | undefined;
      return {
        onDidCreate: vi.fn((listener: () => void) => {
          createListener = listener;
          return { dispose: vi.fn() };
        }),
        onDidDelete: vi.fn((listener: () => void) => {
          deleteListener = listener;
          return { dispose: vi.fn() };
        }),
        onDidChange: vi.fn((listener: () => void) => {
          changeListener = listener;
          return { dispose: vi.fn() };
        }),
        dispose: vi.fn(),
        fireCreate: () => createListener?.(),
        fireDelete: () => deleteListener?.(),
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
    expect(vscodeMock.workspace.findFiles.mock.calls[0]).toHaveLength(3);
    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledWith(
      expect.objectContaining({ base: vscodeMock.workspaceFolder, pattern: '**/*' }),
      '{**/node_modules/**,**/.venv/**,**/venv/**,**/.tox/**,**/__pycache__/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/.turbo/**,**/tmp/**,**/coverage/**}',
      4_000
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
      files: [{ path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' }],
    });
    expect(secondResult).toHaveBeenCalledWith({
      requestId: 2,
      query: '',
      files: [
        { path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
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
      files: [{ path: '/repo/src/first.ts', relativePath: 'src/first.ts', type: 'file' }],
    });
    expect(secondResult).toHaveBeenCalledWith({
      requestId: 2,
      query: '',
      files: [{ path: '/repo/src/second.ts', relativePath: 'src/second.ts', type: 'file' }],
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
      files: [{ path: '/repo/src/fresh.ts', relativePath: 'src/fresh.ts', type: 'file' }],
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
      files: [{ path: '/repo/src/second.ts', relativePath: 'src/second.ts', type: 'file' }],
    });
    expect(thirdResult).toHaveBeenCalledWith({
      requestId: 3,
      query: '',
      files: [{ path: '/repo/src/third.ts', relativePath: 'src/third.ts', type: 'file' }],
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
        { path: '/docs/guide.md', relativePath: 'docs/guide.md', type: 'file' },
        { path: '/repo/src/app.ts', relativePath: 'repo/src/app.ts', type: 'file' },
      ],
    });
    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        base: vscodeMock.workspace.workspaceFolders[0],
        pattern: '**/*',
      }),
      expect.any(String),
      4_000
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
