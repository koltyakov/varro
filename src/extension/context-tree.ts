import * as vscode from 'vscode';
import type { DroppedFile } from '../shared/protocol';

export type ContextFileItem = DroppedFile;

export class ContextTreeProvider implements vscode.TreeDataProvider<ContextFileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ContextFileItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private files: ContextFileItem[] = [];

  setFiles(files: ContextFileItem[]) {
    this.files = files;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ContextFileItem): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.relativePath,
      element.type === 'directory'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.iconPath = element.type === 'directory' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    item.contextValue = 'contextFile';
    item.description = element.type === 'directory' ? 'folder' : undefined;
    if (element.type === 'file') {
      item.command = {
        command: 'vscode.open',
        arguments: [vscode.Uri.file(element.path)],
        title: 'Open File',
      };
    }
    return item;
  }

  getChildren(_element?: ContextFileItem): Thenable<ContextFileItem[]> {
    return Promise.resolve(this.files);
  }
}

export class ContextDropController implements vscode.TreeDragAndDropController<ContextFileItem> {
  readonly dropMimeTypes = ['text/uri-list'];
  readonly dragMimeTypes: string[] = [];

  private onDrop: (paths: string[]) => void;

  constructor(onDrop: (paths: string[]) => void) {
    this.onDrop = onDrop;
  }

  async handleDrop(
    _target: ContextFileItem | undefined,
    sources: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const item = sources.get('text/uri-list');
    if (!item) return;

    const text = await item.asString();
    const paths = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((uri) => {
        try {
          return vscode.Uri.parse(uri).fsPath;
        } catch {
          return null;
        }
      })
      .filter((p): p is string => p !== null);

    if (paths.length > 0) {
      this.onDrop(paths);
    }
  }
}
