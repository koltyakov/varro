import * as vscode from 'vscode';
import { getRelativePathWithinWorkspace } from '../shared/workspace-path';
import { getVarroStateDirectory } from './varro-state-paths';

/** Internal path/authorization roots. Never publish the scratch folder as an open project. */
export function getWorkingFolders(): readonly vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length) return folders;
  return [{ name: 'scratch', uri: vscode.Uri.file(getVarroStateDirectory('scratch')), index: 0 }];
}

export function getWorkingFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder || vscode.workspace.workspaceFolders?.length) return folder;
  const scratch = getWorkingFolders()[0];
  return scratch && getRelativePathWithinWorkspace(uri.fsPath, scratch.uri.fsPath) !== null
    ? scratch
    : undefined;
}
