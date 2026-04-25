import { access, stat } from 'fs/promises';
import { dirname } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
}));

const vscodeMock = vi.hoisted(() => ({
  Uri: {
    file: vi.fn((fsPath: string) => ({ fsPath })),
  },
  workspace: {
    fs: {
      stat: vi.fn(),
    },
    getWorkspaceFolder: vi.fn(),
    workspaceFolders: [],
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
    expect(droppedPath).toMatch(/\/varro-drops\/drop-[^/]+\/.+-secret\.txt$/);

    const droppedStat = await stat(droppedPath);
    expect(droppedStat.isFile()).toBe(true);
    expect(droppedStat.mode & 0o777).toBe(0o600);
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
});
