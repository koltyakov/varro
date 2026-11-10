/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: VS Code URI values are established by the editor API before conversion. */
import * as vscode from 'vscode';
import { Buffer } from 'buffer';
import { randomUUID } from 'crypto';
import type { DroppedFile, ExtensionMessage, TerminalSelection } from '../shared/protocol';
import { areContextFilesEqual, mergeContextFile } from '../shared/context-files';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../shared/workspace-path';
import {
  MAX_NATIVE_PDF_TOTAL_BYTES,
  MAX_NATIVE_PDF_FILENAME_LENGTH,
  NATIVE_PDF_MIME,
  isPdfBytes,
  type NativePdfAttachment,
} from '../shared/native-pdf';
import type { DroppedFilesService } from './dropped-files-service';
import type { DroppedContentDirectory } from '../shared/dropped-content-policy';
import { getRelativePath } from './util/path';

export class SidebarProviderContextFiles {
  private contextFiles: DroppedFile[] = [];
  private terminalSelection: TerminalSelection | null = null;
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

  getTerminalSelection() {
    return this.terminalSelection;
  }

  setTerminalSelection(selection: TerminalSelection | null) {
    this.terminalSelection = selection;
  }

  clearContextFiles(sentSessionId?: string) {
    this.clearGeneration += 1;
    this.removedPaths.clear();
    const paths = this.contextFiles.map((file) => file.path);
    this.contextFiles = [];
    if (sentSessionId) {
      for (const path of paths) this.droppedFilesService.retainOwnedFile(path, sentSessionId);
    }
    void this.droppedFilesService.removeOwnedFiles(paths);
  }

  async handleDroppedContent(
    files: Array<{ name: string; content: string; size: number }>,
    post: (message: ExtensionMessage) => void,
    directory?: DroppedContentDirectory
  ) {
    const clearGeneration = this.clearGeneration;
    const startedAt = this.mutationSequence;
    const valid = await (directory
      ? this.droppedFilesService.fromContent(files, { directory })
      : this.droppedFilesService.fromContent(files));
    await this.applyPendingFiles(valid, clearGeneration, startedAt, post);
  }

  async handleDroppedPaths(paths: string[], post: (message: ExtensionMessage) => void) {
    const clearGeneration = this.clearGeneration;
    const startedAt = this.mutationSequence;
    const normalized = await this.droppedFilesService.fromPaths(paths);
    await this.applyPendingFiles(normalized, clearGeneration, startedAt, post);
  }

  removeContextFile(
    path: string,
    post: (message: ExtensionMessage) => void,
    sentSessionId?: string
  ) {
    const nextFiles = this.contextFiles.filter(
      (file) => file.path !== path && !isSameWorkspacePath(file.path, path)
    );
    if (nextFiles.length === this.contextFiles.length) return;
    this.removedPaths.set(contextPathKey(path), ++this.mutationSequence);
    this.contextFiles = nextFiles;
    if (sentSessionId) this.droppedFilesService.retainOwnedFile(path, sentSessionId);
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

    let pdfBytes = 0;
    let rejectedPdf = false;
    const files: Array<
      { type: 'pdf'; value: NativePdfAttachment } | { type: 'context'; value: DroppedFile }
    > = [];
    for (const uri of result) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const relativePath = getRelativePath(uri, workspaceFolder);
        if (!(stat.type & vscode.FileType.Directory) && uri.path.toLowerCase().endsWith('.pdf')) {
          const filename = uri.path.split('/').pop() || 'document.pdf';
          if (
            !Number.isSafeInteger(stat.size) ||
            stat.size <= 0 ||
            pdfBytes + stat.size > MAX_NATIVE_PDF_TOTAL_BYTES ||
            filename.length > MAX_NATIVE_PDF_FILENAME_LENGTH
          ) {
            rejectedPdf = true;
            continue;
          }
          const content = await vscode.workspace.fs.readFile(uri);
          if (!isPdfBytes(content) || content.byteLength !== stat.size) {
            rejectedPdf = true;
            continue;
          }
          pdfBytes += content.byteLength;
          files.push({
            type: 'pdf',
            value: {
              id: randomUUID(),
              url: `data:${NATIVE_PDF_MIME};base64,${Buffer.from(content).toString('base64')}`,
              mime: NATIVE_PDF_MIME,
              filename,
              size: content.byteLength,
              contextFile: {
                path: uri.fsPath,
                relativePath,
                type: 'file',
              },
            },
          });
          continue;
        }
        files.push({
          type: 'context',
          value: {
            path: uri.fsPath,
            relativePath,
            type: stat.type & vscode.FileType.Directory ? 'directory' : 'file',
          },
        });
      } catch {
        if (uri.path.toLowerCase().endsWith('.pdf')) rejectedPdf = true;
      }
    }

    // The webview assigns shared attachment sequences in arrival order.
    // Keep adjacent items batched so ordinary selections still use one message.
    const groups: Array<typeof files> = [];
    for (const file of files) {
      const previous = groups.at(-1);
      if (previous?.[0]?.type === file.type) previous.push(file);
      else groups.push([file]);
    }
    for (const group of groups) {
      if (group[0]?.type === 'pdf') {
        if (clearGeneration === this.clearGeneration)
          post({
            type: 'pdfs/picked',
            payload: group.flatMap((file) => (file.type === 'pdf' ? [file.value] : [])),
          });
      } else {
        await this.applyPendingFiles(
          group.flatMap((file) => (file.type === 'context' ? [file.value] : [])),
          clearGeneration,
          startedAt,
          post
        );
      }
    }
    if (rejectedPdf && clearGeneration === this.clearGeneration) {
      void vscode.window.showWarningMessage(
        'Some PDFs could not be attached. PDFs need a PDF header, filenames of 512 characters or less, and a total size of 20 MiB or less.'
      );
    }
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
      const index = this.contextFiles.findIndex(
        (item) => item.path === incoming.path || isSameWorkspacePath(item.path, incoming.path)
      );
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

    const accepted = files.filter(
      (file) => (this.removedPaths.get(contextPathKey(file.path)) ?? 0) <= startedAt
    );
    if (accepted.length !== files.length) {
      const acceptedPaths = new Set(accepted.map((file) => contextPathKey(file.path)));
      await this.droppedFilesService.removeOwnedFiles(
        files
          .filter((file) => !acceptedPaths.has(contextPathKey(file.path)))
          .map((file) => file.path)
      );
    }
    if (accepted.length > 0) this.postDroppedFiles(accepted, post);
  }
}

function contextPathKey(path: string): string {
  return normalizeWorkspaceIdentity(path) ?? path;
}
