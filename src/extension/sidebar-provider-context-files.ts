import * as vscode from 'vscode';
import type { DroppedFile, ExtensionMessage } from '../shared/protocol';
import { areContextFilesEqual, mergeContextFile } from '../shared/context-files';
import type { DroppedFilesService } from './dropped-files-service';
import { getRelativePath } from './util/path';

export class SidebarProviderContextFiles {
  private contextFiles: DroppedFile[] = [];
  private onContextFilesChanged?: () => void;
  private clearGeneration = 0;
  private mutationSequence = 0;
  private readonly removedPaths = new Map<string, number>();

  constructor(private readonly droppedFilesService: DroppedFilesService) {}

  setOnContextFilesChanged(fn: () => void) {
    this.onContextFilesChanged = fn;
  }

  notifyContextFilesChanged() {
    this.onContextFilesChanged?.();
  }

  getContextFiles() {
    return this.contextFiles;
  }

  clearContextFiles() {
    this.clearGeneration += 1;
    this.removedPaths.clear();
    const paths = this.contextFiles.map((file) => file.path);
    this.contextFiles = [];
    void this.droppedFilesService.removeOwnedFiles(paths);
  }

  async handleDroppedContent(
    files: Array<{ name: string; content: string; size: number }>,
    post: (message: ExtensionMessage) => void
  ) {
    const clearGeneration = this.clearGeneration;
    const startedAt = this.mutationSequence;
    const valid = await this.droppedFilesService.fromContent(files);
    await this.applyPendingFiles(valid, clearGeneration, startedAt, post);
  }

  async handleDroppedPaths(paths: string[], post: (message: ExtensionMessage) => void) {
    const clearGeneration = this.clearGeneration;
    const startedAt = this.mutationSequence;
    const normalized = await this.droppedFilesService.fromPaths(paths);
    await this.applyPendingFiles(normalized, clearGeneration, startedAt, post);
  }

  removeContextFile(path: string, post: (message: ExtensionMessage) => void) {
    const nextFiles = this.contextFiles.filter((f) => f.path !== path);
    if (nextFiles.length === this.contextFiles.length) return;
    this.removedPaths.set(path, ++this.mutationSequence);
    this.contextFiles = nextFiles;
    void this.droppedFilesService.removeOwnedFile(path);
    post({ type: 'files/removed', payload: { path } });
    this.onContextFilesChanged?.();
  }

  async pickFiles(post: (message: ExtensionMessage) => void) {
    const clearGeneration = this.clearGeneration;
    const startedAt = this.mutationSequence;
    const result = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: true,
      title: 'Add files to context',
    });
    if (!result || result.length === 0) return;

    const files = await Promise.all(
      result.map(async (uri) => {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          const relativePath = getRelativePath(uri, workspaceFolder);
          return {
            path: uri.fsPath,
            relativePath,
            type:
              stat.type & vscode.FileType.Directory ? ('directory' as const) : ('file' as const),
          };
        } catch {
          return null;
        }
      })
    );

    const valid = files.filter(
      (f): f is { path: string; relativePath: string; type: 'file' | 'directory' } => f !== null
    );
    await this.applyPendingFiles(valid, clearGeneration, startedAt, post);
  }

  postContextFiles(post: (message: ExtensionMessage) => void) {
    if (this.contextFiles.length === 0) return;
    post({ type: 'files/dropped', payload: this.contextFiles });
  }

  postDroppedFiles(
    files: Array<Pick<DroppedFile, 'path' | 'relativePath' | 'type'>>,
    post: (message: ExtensionMessage) => void
  ) {
    const updates: DroppedFile[] = [];
    for (const file of files) {
      const incoming = file as DroppedFile;
      const index = this.contextFiles.findIndex((item) => item.path === incoming.path);
      if (index === -1) {
        this.contextFiles.push(incoming);
        updates.push(incoming);
        continue;
      }

      const merged = mergeContextFile(this.contextFiles[index], incoming);
      if (areContextFilesEqual(this.contextFiles[index]!, merged)) {
        continue;
      }
      this.contextFiles[index] = merged;
      updates.push(merged);
    }
    if (updates.length === 0) return;

    post({ type: 'files/dropped', payload: updates });
    this.onContextFilesChanged?.();
  }

  private async applyPendingFiles(
    files: Array<Pick<DroppedFile, 'path' | 'relativePath' | 'type'>>,
    clearGeneration: number,
    startedAt: number,
    post: (message: ExtensionMessage) => void
  ) {
    if (clearGeneration !== this.clearGeneration) {
      await this.droppedFilesService.removeOwnedFiles(files.map((file) => file.path));
      return;
    }

    const accepted = files.filter((file) => (this.removedPaths.get(file.path) ?? 0) <= startedAt);
    if (accepted.length !== files.length) {
      const acceptedPaths = new Set(accepted.map((file) => file.path));
      await this.droppedFilesService.removeOwnedFiles(
        files.filter((file) => !acceptedPaths.has(file.path)).map((file) => file.path)
      );
    }
    if (accepted.length > 0) this.postDroppedFiles(accepted, post);
  }
}
