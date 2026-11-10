import { describe, expect, it, vi } from 'vitest';
import { fixture } from '../../test-fixtures';
import { readDroppedDirectory } from './drop-directories';

function directory(name: string, batches: FileSystemEntry[][] = []): FileSystemDirectoryEntry {
  return fixture<FileSystemDirectoryEntry>({
    name,
    isDirectory: true,
    isFile: false,
    createReader: () => {
      let index = 0;
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) =>
          resolve(batches[index++] ?? []),
      };
    },
  });
}

function fileEntry(name: string, file = new File(['hello'], name)): FileSystemFileEntry {
  return fixture<FileSystemFileEntry>({
    name,
    isDirectory: false,
    isFile: true,
    file: (resolve: (value: File) => void) => resolve(file),
  });
}

describe('readDroppedDirectory', () => {
  it('preserves nested paths, empty folders, and all reader batches', async () => {
    const root = directory('external', [
      [directory('nested', [[fileEntry('note.txt')]]), directory('empty')],
      [fileEntry('root.txt')],
    ]);

    await expect(readDroppedDirectory(root)).resolves.toEqual({
      directory: { name: 'external', directories: ['nested', 'empty'] },
      files: [
        { name: 'nested/note.txt', content: btoa('hello'), size: 5 },
        { name: 'root.txt', content: btoa('hello'), size: 5 },
      ],
    });
  });

  it('supports a completely empty folder', async () => {
    await expect(readDroppedDirectory(directory('empty'))).resolves.toEqual({
      directory: { name: 'empty', directories: [] },
      files: [],
    });
  });

  it('rejects excess files before encoding any content', async () => {
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    try {
      await expect(
        readDroppedDirectory(
          directory('large', [Array.from({ length: 21 }, (_, i) => fileEntry(`${i}.txt`))])
        )
      ).rejects.toThrow('at most 20 files');
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('bounds empty-directory traversal', async () => {
    await expect(
      readDroppedDirectory(
        directory('large', [Array.from({ length: 201 }, (_, i) => directory(`${i}`))])
      )
    ).rejects.toThrow('too many entries');
  });

  it('rejects files over the size limit', async () => {
    const oversized = fixture<File>({ size: 10 * 1024 * 1024 + 1 });
    await expect(
      readDroppedDirectory(directory('large', [[fileEntry('large.bin', oversized)]]))
    ).rejects.toThrow('10 MiB per file');
  });

  it('rejects folders over the aggregate size limit before encoding', async () => {
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    try {
      const file = fixture<File>({ size: 10 * 1024 * 1024 });
      await expect(
        readDroppedDirectory(
          directory('large', [Array.from({ length: 6 }, (_, i) => fileEntry(`${i}.bin`, file))])
        )
      ).rejects.toThrow('50 MiB total');
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it.each(['../outside', '/absolute', 'C:\\outside', 'nested/../outside'])(
    'rejects unsafe entry paths: %s',
    async (name) => {
      await expect(readDroppedDirectory(directory('root', [[fileEntry(name)]]))).rejects.toThrow(
        'unsupported path'
      );
    }
  );

  it('does not return a partial folder when a reader fails', async () => {
    const unreadable = fixture<FileSystemDirectoryEntry>({
      name: 'unreadable',
      isDirectory: true,
      createReader: () => ({
        readEntries: (
          _resolve: (entries: FileSystemEntry[]) => void,
          reject: (error: Error) => void
        ) => reject(new Error('Access denied')),
      }),
    });
    await expect(
      readDroppedDirectory(directory('root', [[fileEntry('ok.txt'), unreadable]]))
    ).rejects.toThrow('Access denied');
  });
});
