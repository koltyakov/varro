import * as vscode from 'vscode';
import type { SidebarProvider } from './sidebar-provider';
import { logger } from './logger';

export class DropZoneProvider
  implements
    vscode.TreeDataProvider<vscode.TreeItem>,
    vscode.TreeDragAndDropController<vscode.TreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  readonly dragMimeTypes: readonly string[] = [];
  readonly dropMimeTypes: readonly string[] = ['text/uri-list', 'application/vnd.code.uri-list', 'files'];

  constructor(private sidebar: SidebarProvider) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return [];
  }

  async handleDrop(
    _target: vscode.TreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const paths: string[] = [];

    for (const mime of this.dropMimeTypes) {
      if (mime === 'files') {
        const fileItem = dataTransfer.get('files');
        if (fileItem) {
          const file = fileItem.asFile?.();
          const uri = file?.uri;
          if (uri && uri.scheme === 'file') {
            paths.push(uri.fsPath);
          }
        }
        if (paths.length > 0) break;
        continue;
      }

      const item = dataTransfer.get(mime);
      if (!item) continue;
      const raw = await item.asString();
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        try {
          const uri = vscode.Uri.parse(trimmed);
          if (uri.scheme === 'file') {
            paths.push(uri.fsPath);
          }
        } catch {
          if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
            paths.push(trimmed);
          }
        }
      }
      if (paths.length > 0) break;
    }

    if (paths.length > 0) {
      logger.info('Drop zone received:', paths);
      await this.sidebar.handleDroppedPaths(paths);
    }
  }
}
