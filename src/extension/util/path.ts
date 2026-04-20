import { basename } from 'path';
import * as vscode from 'vscode';

export function getRelativePath(uri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder | undefined) {
  if (!workspaceFolder) return basename(uri.fsPath);
  const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  return relativePath || '.';
}
