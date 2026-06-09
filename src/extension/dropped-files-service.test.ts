import { access, stat } from 'fs/promises';
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

  it('removes the temp drop directory on dispose', async () => {
    const service = new DroppedFilesService({ context: { workspacePath: '/repo' } } as never);
    services.push(service);

    const files = await service.fromContent([
      { name: 'note.txt', content: Buffer.from('hello').toString('base64'), size: 5 },
    ]);
    const dropsDir = dirname(files[0]!.path);

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
