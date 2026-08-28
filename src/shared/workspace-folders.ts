import type { WorkspaceFolderContext } from './protocol';
import { isSameWorkspacePath } from './workspace-path';

export function getWorkspaceFolderForDirectory(
  directory: string | null | undefined,
  folders: readonly WorkspaceFolderContext[]
): WorkspaceFolderContext | null {
  if (!directory) return null;
  return folders.find((folder) => isSameWorkspacePath(folder.path, directory)) ?? null;
}

export function getWorkspaceFolderLabel(
  directory: string | null | undefined,
  folders: readonly WorkspaceFolderContext[]
): string | null {
  const folder = getWorkspaceFolderForDirectory(directory, folders);
  if (!folder) return null;
  const duplicateName = folders.some(
    (candidate) => candidate !== folder && candidate.name === folder.name
  );
  return duplicateName ? `${folder.name} · ${folder.path}` : folder.name;
}
