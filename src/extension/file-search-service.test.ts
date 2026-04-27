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

describe('FileSearchService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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

  it('cancels stale searches and only reports the latest result', async () => {
    const pendingFiles = deferred<Array<{ fsPath: string }>>();
    vscodeMock.workspace.findFiles.mockReturnValue(pendingFiles.promise);
    const onResult = vi.fn();
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();

    service.search(1, 'first', 10, onResult);
    service.search(2, 'reader', 10, onResult);
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

    service.search(1, '', 0, firstResult);
    await vi.waitFor(() => {
      expect(firstResult).toHaveBeenCalledTimes(1);
    });
    service.search(2, '', 5, secondResult);
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

    service.search(3, '', 5, thirdResult);
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
    const watcher = vscodeMock.workspace.createFileSystemWatcher.mock.results[0]?.value as {
      fireCreate: () => void;
    };
    const firstResult = vi.fn();
    const secondResult = vi.fn();

    service.search(1, '', 10, firstResult);
    await vi.waitFor(() => {
      expect(firstResult).toHaveBeenCalledTimes(1);
    });

    watcher.fireCreate();

    service.search(2, '', 10, secondResult);
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
  });

  it('resolves workspace folders without per-file getWorkspaceFolder lookups', async () => {
    vscodeMock.workspace.workspaceFolders = [
      { name: 'repo', uri: { fsPath: '/repo' } },
      { name: 'docs', uri: { fsPath: '/docs' } },
    ];
    vscodeMock.workspace.findFiles.mockResolvedValue([
      { fsPath: '/repo/src/app.ts' },
      { fsPath: '/docs/guide.md' },
    ]);
    vscodeMock.workspace.asRelativePath.mockImplementation((uri: { fsPath: string }) => {
      if (uri.fsPath.startsWith('/repo/')) return uri.fsPath.replace('/repo/', '');
      if (uri.fsPath.startsWith('/docs/')) return uri.fsPath.replace('/docs/', '');
      return uri.fsPath;
    });

    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();
    const onResult = vi.fn();

    service.search(1, '', 10, onResult);
    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
    });

    expect(vscodeMock.workspace.getWorkspaceFolder).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith({
      requestId: 1,
      query: '',
      files: [
        { path: '/docs/guide.md', relativePath: 'docs/guide.md', type: 'file' },
        { path: '/repo/src/app.ts', relativePath: 'repo/src/app.ts', type: 'file' },
      ],
    });
  });

  it('returns an empty result and logs a warning when discovery fails', async () => {
    vscodeMock.workspace.findFiles.mockRejectedValue(new Error('boom'));
    const onResult = vi.fn();
    const { FileSearchService } = await loadModule();
    const service = new FileSearchService();

    service.search(7, 'missing', 10, onResult);
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

    service.search(1, 'missing', 5, firstResult);
    await vi.waitFor(() => {
      expect(firstResult).toHaveBeenCalledTimes(1);
    });

    service.search(2, 'missing', 5, secondResult);
    await vi.waitFor(() => {
      expect(secondResult).toHaveBeenCalledTimes(1);
    });

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledTimes(1);
    expect(firstResult).toHaveBeenCalledWith({ requestId: 1, query: 'missing', files: [] });
    expect(secondResult).toHaveBeenCalledWith({ requestId: 2, query: 'missing', files: [] });
  });
});
