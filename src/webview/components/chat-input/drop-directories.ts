import {
  MAX_DROPPED_CONTENT_FILES,
  MAX_DROPPED_CONTENT_FILE_BYTES,
  MAX_DROPPED_CONTENT_TOTAL_BYTES,
  MAX_DROPPED_DIRECTORY_ENTRIES,
  isSafeDroppedRelativePath,
} from '../../../shared/dropped-content-policy';
import type { WebviewMessage } from '../../../shared/protocol';
import { readFileAsBase64 } from './drop-paths';

type DirectoryContent = Extract<WebviewMessage, { type: 'files/drop-content' }>['payload'];

/** Read the complete directory or reject it, never attach a silently truncated copy. */
export async function readDroppedDirectory(
  root: FileSystemDirectoryEntry
): Promise<DirectoryContent> {
  if (!isSafeDroppedRelativePath(root.name) || root.name.includes('/') || root.name.length > 255) {
    throw new Error(
      'The dropped folder has an unsupported name. Use the attachment picker instead.'
    );
  }
  const directories: string[] = [];
  const files: Array<{ name: string; file: File }> = [];
  let totalSize = 0;
  let entryCount = 0;

  async function visit(directory: FileSystemDirectoryEntry, prefix: string): Promise<void> {
    const reader = directory.createReader();
    while (true) {
      const entries = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject)
      );
      if (entries.length === 0) return;
      for (const entry of entries) {
        entryCount += 1;
        if (entryCount > MAX_DROPPED_DIRECTORY_ENTRIES) {
          throw new Error(
            'The dropped folder has too many entries. Use the attachment picker instead.'
          );
        }
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!isSafeDroppedRelativePath(name)) {
          throw new Error(
            'The dropped folder contains an unsupported path. Use the attachment picker instead.'
          );
        }
        if (entry.isDirectory) {
          directories.push(name);
          // SAFETY: The browser reports this entry as a directory.
          await visit(entry as FileSystemDirectoryEntry, name);
        } else if (entry.isFile) {
          if (files.length >= MAX_DROPPED_CONTENT_FILES) {
            throw new Error(
              'Dropped folders can contain at most 20 files. Use the attachment picker instead.'
            );
          }
          // SAFETY: The browser reports this entry as a file.
          const fileEntry = entry as FileSystemFileEntry;
          const file = await new Promise<File>((resolve, reject) =>
            fileEntry.file(resolve, reject)
          );
          if (
            !Number.isSafeInteger(file.size) ||
            file.size < 0 ||
            file.size > MAX_DROPPED_CONTENT_FILE_BYTES ||
            totalSize + file.size > MAX_DROPPED_CONTENT_TOTAL_BYTES
          ) {
            throw new Error(
              'Dropped folders are limited to 10 MiB per file and 50 MiB total. Use the attachment picker instead.'
            );
          }
          totalSize += file.size;
          files.push({ name, file });
        } else {
          throw new Error(
            'The dropped folder contains an unreadable entry. Use the attachment picker instead.'
          );
        }
      }
    }
  }

  await visit(root, '');
  const content: DirectoryContent['files'] = [];
  for (const { name, file } of files) {
    content.push({ name, content: await readFileAsBase64(file), size: file.size });
  }
  return { files: content, directory: { name: root.name, directories } };
}
