import { basename } from 'path';
import * as vscode from 'vscode';

export function getRelativePath(
  uri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined
) {
  if (!workspaceFolder) return basename(uri.fsPath);
  const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  if (!relativePath) return '.';
  if ((vscode.workspace.workspaceFolders?.length || 0) <= 1) return relativePath;
  return `${workspaceFolder.name}/${relativePath}`;
}

export function normalizeRelativeWorkspacePath(path: string) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function resolveWorkspaceRelativePath(
  rawPath: string,
  folders: readonly vscode.WorkspaceFolder[]
) {
  const relativePath = normalizeRelativeWorkspacePath(rawPath);
  if (!relativePath) return null;

  const scopedFolder = folders.find(
    (folder) => relativePath === folder.name || relativePath.startsWith(`${folder.name}/`)
  );

  if (!scopedFolder) {
    return { workspaceFolder: undefined, relativePath };
  }

  return {
    workspaceFolder: scopedFolder,
    relativePath:
      relativePath === scopedFolder.name ? '.' : relativePath.slice(scopedFolder.name.length + 1),
  };
}
