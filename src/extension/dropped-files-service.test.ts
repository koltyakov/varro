import { access, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
}));

const vscodeMock = vi.hoisted(() => ({
  Uri: {
    file: vi.fn((fsPath: string) => ({ fsPath })),
  },
  workspace: {
    asRelativePath: vi.fn(),
    fs: {
      stat: vi.fn(),
    },
    getWorkspaceFolder: vi.fn(),
    workspaceFolders: [] as Array<{ name: string; uri: { fsPath: string } }>,
  },
  FileType: {
    Directory: 2,
  },
}));

vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('vscode', () => vscodeMock);

import { DroppedFilesService } from './dropped-files-service';

let services: DroppedFilesService[] = [];

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function missingFileError() {
  return Object.assign(new Error('Missing owner marker'), { code: 'ENOENT' });
}

describe('DroppedFilesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services = [];
    vscodeMock.workspace.asRelativePath.mockReset();
    vscodeMock.workspace.workspaceFolders = [];
  });

  afterEach(async () => {
    await Promise.allSettled(services.map((service) => service.dispose()));
    services = [];
  });

  it('writes dropped files with restricted permissions in a private temp directory', async () => {
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never);
    services.push(service);

    const files = await service.fromContent([
      { name: '../secret.txt', content: Buffer.from('hello').toString('base64'), size: 5 },
    ]);

    expect(files).toHaveLength(1);
    expect(files[0]?.relativePath).toBe('secret.txt');

    const droppedPath = files[0]!.path;
    expect(droppedPath).toMatch(/[\\/]varro-drops[\\/]drop-[^\\/]+[\\/].+-secret\.txt$/);

    const droppedStat = await stat(droppedPath);
    expect(droppedStat.isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect(droppedStat.mode & 0o777).toBe(0o600);
    }
  });

  it('writes the actual host owner marker and removes its directory on dispose', async () => {
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never);
    services.push(service);
    const createdAfter = Date.now();

    const files = await service.fromContent([
      { name: 'note.txt', content: Buffer.from('hello').toString('base64'), size: 5 },
    ]);
    const dropsDir = dirname(files[0]!.path);
    const marker = JSON.parse(
      await readFile(join(dropsDir, '.varro-owner.json'), 'utf8')
    ) as Record<string, unknown>;

    expect(marker).toEqual({
      version: 1,
      pid: process.pid,
      createdAt: expect.any(Number),
    });
    expect(marker.createdAt).toEqual(expect.any(Number));
    expect(marker.createdAt as number).toBeGreaterThanOrEqual(createdAfter);
    expect(marker.createdAt as number).toBeLessThanOrEqual(Date.now());

    await service.dispose();

    await expect(access(dropsDir)).rejects.toBeDefined();
  });

  it('keeps absolute dropped files outside the workspace', async () => {
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never);
    services.push(service);
    const externalPath = '/tmp/varro-drop.txt';
    const externalUri = { fsPath: externalPath };

    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscodeMock.Uri.file.mockReturnValueOnce(externalUri);

    const files = await service.fromPaths([externalPath]);

    expect(files).toEqual([
      {
        path: externalPath,
        relativePath: 'varro-drop.txt',
        type: 'file',
      },
    ]);
  });

  it('resolves relative dropped paths against the preferred workspace folder', async () => {
    const service = new DroppedFilesService({ context: { workspacePath: '/repo/beta' } } as never);
    services.push(service);

    const alphaFolder = { name: 'alpha', uri: { fsPath: '/repo/alpha' } };
    const betaFolder = { name: 'beta', uri: { fsPath: '/repo/beta' } };
    const notePath = join('/repo/beta', 'src/note.txt');
    vscodeMock.workspace.workspaceFolders = [alphaFolder, betaFolder];
    vscodeMock.workspace.fs.stat.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === notePath) {
        return { type: 0 };
      }
      throw new Error(`Missing path: ${uri.fsPath}`);
    });
    vscodeMock.workspace.getWorkspaceFolder.mockImplementation((uri: { fsPath: string }) => {
      const fsPath = uri.fsPath.replace(/\\/g, '/');
      if (fsPath.startsWith('/repo/alpha')) return alphaFolder;
      if (fsPath.startsWith('/repo/beta')) return betaFolder;
      return undefined;
    });
    vscodeMock.workspace.asRelativePath.mockReturnValue('src/note.txt');

    const files = await service.fromPaths(['.\\src\\note.txt//']);

    expect(files).toEqual([
      {
        path: notePath,
        relativePath: 'beta/src/note.txt',
        type: 'file',
      },
    ]);
  });

  it('deduplicates absolute paths and preserves directory drops', async () => {
    const service = new DroppedFilesService({ context: { workspacePath: '/repo/alpha' } } as never);
    services.push(service);

    const alphaFolder = { name: 'alpha', uri: { fsPath: '/repo/alpha' } };
    const directoryPath = '/repo/alpha/docs';
    vscodeMock.workspace.workspaceFolders = [alphaFolder];
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: vscodeMock.FileType.Directory });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(alphaFolder);
    vscodeMock.workspace.asRelativePath.mockReturnValue('docs');

    const files = await service.fromPaths([directoryPath, directoryPath]);

    expect(files).toEqual([
      {
        path: directoryPath,
        relativePath: 'docs',
        type: 'directory',
      },
    ]);
    expect(vscodeMock.workspace.fs.stat).toHaveBeenCalledTimes(2);
  });

  it('ignores blank and workspace-escaping relative paths', async () => {
    const service = new DroppedFilesService({ context: { workspacePath: '/repo/alpha' } } as never);
    services.push(service);

    const alphaFolder = { name: 'alpha', uri: { fsPath: '/repo/alpha' } };
    vscodeMock.workspace.workspaceFolders = [alphaFolder];
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockImplementation((uri: { fsPath: string }) => {
      if (uri.fsPath.startsWith('/repo/alpha/../')) return undefined;
      return alphaFolder;
    });

    const files = await service.fromPaths(['   ', '../secrets.txt']);

    expect(files).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledWith('Ignoring dropped path    : Path does not exist');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Ignoring dropped path ../secrets.txt: Path does not exist'
    );
  });

  it('rejects oversized dropped content before decoding base64', async () => {
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never);
    services.push(service);
    const bufferFromSpy = vi.spyOn(Buffer, 'from');

    try {
      const files = await service.fromContent([
        { name: 'huge.bin', content: 'AAAA', size: 11 * 1024 * 1024 },
      ]);

      expect(files).toEqual([]);
      expect(bufferFromSpy).not.toHaveBeenCalled();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Ignoring dropped file huge.bin: file is larger than 10485760 bytes'
      );
    } finally {
      bufferFromSpy.mockRestore();
    }
  });

  it('rejects dropped content beyond the aggregate raw-byte limit', async () => {
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never);
    services.push(service);
    const bufferFromSpy = vi.spyOn(Buffer, 'from');

    try {
      const files = await service.fromContent(
        Array.from({ length: 6 }, (_, index) => ({
          name: `part-${index}.bin`,
          content: 'YQ==',
          size: 10 * 1024 * 1024,
        }))
      );

      expect(files).toEqual([]);
      expect(bufferFromSpy).not.toHaveBeenCalled();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Ignoring dropped file part-5.bin: aggregate content is larger than 52428800 bytes'
      );
    } finally {
      bufferFromSpy.mockRestore();
    }
  });

  it('uses a single temp directory creation for concurrent content drops', async () => {
    const creation = createDeferred<string>();
    const create = vi.fn(() => creation.promise);
    const remove = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never, {
      create,
      remove,
      write,
    });
    services.push(service);

    const first = service.fromContent([{ name: 'first.txt', content: 'YQ==', size: 1 }]);
    const second = service.fromContent([{ name: 'second.txt', content: 'Yg==', size: 1 }]);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    creation.resolve('/tmp/varro-drops/drop-single-flight');
    await Promise.all([first, second]);

    expect(create).toHaveBeenCalledOnce();
  });

  it('removes a temp directory if dispose races its creation', async () => {
    const creation = createDeferred<string>();
    const dropsDir = '/tmp/varro-drops/drop-dispose-race';
    const create = vi.fn(() => creation.promise);
    const remove = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never, {
      create,
      remove,
      write,
    });
    services.push(service);

    const pendingFiles = service.fromContent([{ name: 'race.txt', content: 'cmFjZQ==', size: 4 }]);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const pendingDispose = service.dispose();
    creation.resolve(dropsDir);

    await expect(pendingFiles).resolves.toEqual([]);
    await pendingDispose;
    expect(remove).toHaveBeenCalledWith(dropsDir, { recursive: true, force: true });
  });

  it('enforces the live owned-content cap and releases bytes after removal', async () => {
    const dropsDir = join(tmpdir(), 'varro-drops', 'drop-owned-cap');
    const create = vi.fn(async () => dropsDir);
    const remove = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never, {
      create,
      remove,
      write,
    });
    services.push(service);
    const tenMiB = Buffer.alloc(10 * 1024 * 1024).toString('base64');

    const initial = await service.fromContent(
      Array.from({ length: 5 }, (_, index) => ({
        name: `part-${index}.bin`,
        content: tenMiB,
        size: 10 * 1024 * 1024,
      }))
    );
    expect(initial).toHaveLength(5);
    expect(write).toHaveBeenCalledTimes(6);

    await expect(
      service.fromContent([{ name: 'blocked.txt', content: 'YQ==', size: 1 }])
    ).resolves.toEqual([]);
    expect(write).toHaveBeenCalledTimes(6);

    await expect(service.removeOwnedFile(initial[0]!.path)).resolves.toBe(true);
    await expect(
      service.fromContent([{ name: 'accepted.txt', content: 'YQ==', size: 1 }])
    ).resolves.toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(7);
  });

  it('sweeps stale matching drop directories with absent owner markers on first use', async () => {
    const dropsRoot = join(tmpdir(), 'varro-drops');
    const dropsDir = join(dropsRoot, 'drop-current');
    const staleDir = join(dropsRoot, 'drop-stale123');
    const freshDir = join(dropsRoot, 'drop-fresh123');
    const foreignDir = join(dropsRoot, 'other-stale');
    const create = vi.fn(async () => dropsDir);
    const remove = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const read = vi.fn(async () => {
      throw missingFileError();
    });
    const list = vi.fn(async () => [
      { name: 'drop-stale123', isDirectory: () => true },
      { name: 'drop-fresh123', isDirectory: () => true },
      { name: 'other-stale', isDirectory: () => true },
      { name: 'drop-file123', isDirectory: () => false },
    ]);
    const readStat = vi.fn(async (path: string) => ({
      mtimeMs: path === staleDir ? Date.now() - 2 * 24 * 60 * 60 * 1000 : Date.now(),
    }));
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never, {
      create,
      remove,
      write,
      read,
      list,
      stat: readStat,
    });
    services.push(service);

    await service.fromContent([{ name: 'note.txt', content: 'YQ==', size: 1 }]);
    await service.fromContent([{ name: 'note-2.txt', content: 'Yg==', size: 1 }]);

    expect(list).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(staleDir, { recursive: true, force: true });
    expect(remove).not.toHaveBeenCalledWith(freshDir, expect.anything());
    expect(remove).not.toHaveBeenCalledWith(foreignDir, expect.anything());
  });

  it('preserves a stale drop directory owned by a live extension host', async () => {
    const dropsRoot = join(tmpdir(), 'varro-drops');
    const liveDir = join(dropsRoot, 'drop-live123');
    const createdAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const create = vi.fn(async () => join(dropsRoot, 'drop-current'));
    const remove = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const read = vi.fn(async () => JSON.stringify({ version: 1, pid: 4_242, createdAt }));
    const isProcessAlive = vi.fn(() => true);
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never, {
      create,
      remove,
      write,
      read,
      list: vi.fn(async () => [{ name: 'drop-live123', isDirectory: () => true }]),
      stat: vi.fn(async () => ({ mtimeMs: createdAt })),
      isProcessAlive,
    });
    services.push(service);

    await service.fromContent([{ name: 'note.txt', content: 'YQ==', size: 1 }]);

    expect(isProcessAlive).toHaveBeenCalledWith(4_242);
    expect(remove).not.toHaveBeenCalledWith(liveDir, expect.anything());
  });

  it('removes a stale drop directory owned by a dead extension host', async () => {
    const dropsRoot = join(tmpdir(), 'varro-drops');
    const deadDir = join(dropsRoot, 'drop-dead123');
    const createdAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const create = vi.fn(async () => join(dropsRoot, 'drop-current'));
    const remove = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const read = vi.fn(async () => JSON.stringify({ version: 1, pid: 4_243, createdAt }));
    const isProcessAlive = vi.fn(() => false);
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never, {
      create,
      remove,
      write,
      read,
      list: vi.fn(async () => [{ name: 'drop-dead123', isDirectory: () => true }]),
      stat: vi.fn(async () => ({ mtimeMs: createdAt })),
      isProcessAlive,
    });
    services.push(service);

    await service.fromContent([{ name: 'note.txt', content: 'YQ==', size: 1 }]);

    expect(isProcessAlive).toHaveBeenCalledWith(4_243);
    expect(remove).toHaveBeenCalledWith(deadDir, { recursive: true, force: true });
  });

  it('preserves stale drop directories with malformed owner markers', async () => {
    const dropsRoot = join(tmpdir(), 'varro-drops');
    const malformedDir = join(dropsRoot, 'drop-malformed123');
    const oldTimestamp = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const create = vi.fn(async () => join(dropsRoot, 'drop-current'));
    const remove = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const isProcessAlive = vi.fn(() => false);
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never, {
      create,
      remove,
      write,
      read: vi.fn(async () => '{not-json'),
      list: vi.fn(async () => [{ name: 'drop-malformed123', isDirectory: () => true }]),
      stat: vi.fn(async () => ({ mtimeMs: oldTimestamp })),
      isProcessAlive,
    });
    services.push(service);

    await service.fromContent([{ name: 'note.txt', content: 'YQ==', size: 1 }]);

    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalledWith(malformedDir, expect.anything());
  });

  it('bounds concurrent path stat work for large drops', async () => {
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never);
    services.push(service);
    const folder = { name: 'repo', uri: { fsPath: '/repo' } };
    let activeStats = 0;
    let maxActiveStats = 0;

    vscodeMock.workspace.workspaceFolders = [folder];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(folder);
    vscodeMock.workspace.asRelativePath.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath.replace('/repo/', '')
    );
    vscodeMock.workspace.fs.stat.mockImplementation(async () => {
      activeStats += 1;
      maxActiveStats = Math.max(maxActiveStats, activeStats);
      await Promise.resolve();
      activeStats -= 1;
      return { type: 0 };
    });

    const files = await service.fromPaths(
      Array.from({ length: 24 }, (_, index) => `/repo/file-${index}.txt`)
    );

    expect(files).toHaveLength(24);
    expect(maxActiveStats).toBeLessThanOrEqual(8);
  });
});
