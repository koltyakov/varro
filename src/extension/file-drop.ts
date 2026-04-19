import * as vscode from 'vscode';
import { basename } from 'path';
import type { DroppedFile } from '../shared/protocol';
import { logger } from './logger';

type DroppedFileLike = { path: string; relativePath: string; type: 'file' | 'directory' };

export class ContextTreeProvider
  implements vscode.TreeDataProvider<ContextItem>, vscode.TreeDragAndDropController<ContextItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<ContextItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  dropMimeTypes = ['text/uri-list', 'application/vnd.code.uri-list'];
  dragMimeTypes: string[] = [];

  private sidebar: {
    postDroppedFiles: (files: DroppedFileLike[]) => void;
    removeContextFile: (path: string) => void;
    getContextFiles: () => DroppedFile[];
  };

  constructor(sidebar: {
    postDroppedFiles: (files: DroppedFileLike[]) => void;
    removeContextFile: (path: string) => void;
    getContextFiles: () => DroppedFile[];
  }) {
    this.sidebar = sidebar;
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ContextItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ContextItem[] {
    return this.sidebar.getContextFiles().map((f) => {
      const item = new ContextItem(f.relativePath, vscode.TreeItemCollapsibleState.None);
      item.description = f.type === 'directory' ? 'folder' : undefined;
      item.iconPath =
        f.type === 'directory' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
      item.contextValue = 'contextFile';
      item.tooltip = f.path;
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [vscode.Uri.file(f.path)],
      };
      return item;
    });
  }

  handleDrag(
    _source: ContextItem[],
    _dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {}

  async handleDrop(
    _target: ContextItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const uris = extractUrisFromDataTransfer(dataTransfer);
    if (uris.length === 0) return;

    const files = await Promise.all(
      uris.map(async (uri) => {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          const relativePath = getRelativePath(uri, workspaceFolder);
          return {
            path: uri.fsPath,
            relativePath,
            type:
              stat.type & vscode.FileType.Directory
                ? ('directory' as const)
                : ('file' as const),
          };
        } catch {
          return null;
        }
      })
    );

    const valid = files.filter(
      (f): f is { path: string; relativePath: string; type: 'file' | 'directory' } => f !== null
    );

    if (valid.length > 0) {
      logger.info(
        'Context tree drop:',
        valid.map((f) => f.relativePath)
      );
      this.sidebar.postDroppedFiles(valid);
    }
  }
}

class ContextItem extends vscode.TreeItem {}

function extractUrisFromDataTransfer(dataTransfer: vscode.DataTransfer): vscode.Uri[] {
  const uris: vscode.Uri[] = [];

  for (const type of ['text/uri-list', 'application/vnd.code.uri-list']) {
    const item = dataTransfer.get(type);
    if (!item) continue;
    const value = typeof item.value === 'string' ? item.value : String(item.value ?? '');
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      try {
        uris.push(vscode.Uri.parse(trimmed));
      } catch {
        try {
          uris.push(vscode.Uri.file(trimmed));
        } catch {}
      }
    }
    if (uris.length > 0) break;
  }

  return uris;
}

function getRelativePath(uri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder | undefined) {
  if (!workspaceFolder) return basename(uri.fsPath);
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/') || '.';
}
