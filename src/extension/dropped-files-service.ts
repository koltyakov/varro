import { writeFile, mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { Buffer } from 'buffer';
import { randomBytes } from 'crypto';
import { join, isAbsolute } from 'path';
import * as vscode from 'vscode';
import type { DroppedFile } from '../shared/protocol';
import type { ContextProvider } from './context-provider';
import { logger } from './logger';
import { getRelativePath } from './util/path';

type DroppedFileInput = Pick<DroppedFile, 'path' | 'relativePath' | 'type'>;
const MAX_CONCURRENT_DROPPED_CONTENT_WRITES = 2;

export class DroppedFilesService {
  private tempDropsDir: string | null = null;

  constructor(private readonly contextProvider: Pick<ContextProvider, 'context'>) {}

  async fromContent(files: Array<{ name: string; content: string; size: number }>) {
    const dropsDir = await this.ensureDropsDir();
    if (!dropsDir) return [];

    const createdPaths: string[] = [];
    try {
      const results: Array<DroppedFileInput | null> = [];
      for (let index = 0; index < files.length; index += MAX_CONCURRENT_DROPPED_CONTENT_WRITES) {
        const chunk = files.slice(index, index + MAX_CONCURRENT_DROPPED_CONTENT_WRITES);
        const chunkResults = await Promise.all(
          chunk.map(async (file) => {
            try {
              const buffer = Buffer.from(file.content, 'base64');
              const safeName = sanitizeDroppedFileName(file.name);
              const targetPath = join(
                dropsDir,
                `${Date.now()}-${randomBytes(4).toString('hex')}-${safeName}`
              );
              await writeFile(targetPath, buffer, { mode: 0o600 });
              createdPaths.push(targetPath);
              const uri = vscode.Uri.file(targetPath);
              return {
                path: uri.fsPath,
                relativePath: safeName,
                type: 'file' as const,
              } satisfies DroppedFileInput;
            } catch (err) {
              logger.warn(
                `Failed to write dropped file ${file.name}: ${err instanceof Error ? err.message : String(err)}`
              );
              return null;
            }
          })
        );
        results.push(...chunkResults);
      }

      return results.filter(
        (item): item is { path: string; relativePath: string; type: 'file' } => item !== null
      );
    } catch (err) {
      await Promise.allSettled(createdPaths.map((path) => rm(path, { force: true })));
      logger.warn(
        `Failed to persist dropped files: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  async fromPaths(paths: string[]) {
    const dropped = await Promise.all(
      Array.from(new Set(paths)).map(async (path) => {
        try {
          const uri = await this.resolveDroppedUri(path);
          if (!uri) {
            throw new Error('Path does not exist');
          }
          const stat = await vscode.workspace.fs.stat(uri);
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          const relativePath = getRelativePath(uri, workspaceFolder);

          return {
            path: uri.fsPath,
            relativePath,
            type:
              stat.type & vscode.FileType.Directory ? ('directory' as const) : ('file' as const),
          } satisfies DroppedFileInput;
        } catch (err) {
          logger.warn(
            `Ignoring dropped path ${path}: ${err instanceof Error ? err.message : String(err)}`
          );
          return null;
        }
      })
    );

    return dropped.filter((item): item is DroppedFileInput => Boolean(item));
  }

  private async resolveDroppedUri(rawPath: string): Promise<vscode.Uri | null> {
    const input = rawPath.trim();
    if (!input) return null;

    const absoluteUri = vscode.Uri.file(input);
    if (isAbsolute(input)) {
      try {
        await vscode.workspace.fs.stat(absoluteUri);
        return absoluteUri;
      } catch {
        return null;
      }
    }

    const relativePath = input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!relativePath) return null;

    const preferredWorkspacePath = this.contextProvider.context.workspacePath;
    const folders = vscode.workspace.workspaceFolders || [];
    const preferredFolder = preferredWorkspacePath
      ? folders.find((folder) => folder.uri.fsPath === preferredWorkspacePath)
      : undefined;
    const resolutionOrder = preferredFolder
      ? [
          preferredFolder,
          ...folders.filter((folder) => folder.uri.fsPath !== preferredWorkspacePath),
        ]
      : folders;

    for (const folder of resolutionOrder) {
      const candidate = vscode.Uri.file(join(folder.uri.fsPath, relativePath));
      try {
        await vscode.workspace.fs.stat(candidate);
        if (vscode.workspace.getWorkspaceFolder(candidate)?.uri.fsPath === folder.uri.fsPath) {
          return candidate;
        }
      } catch {}
    }

    return null;
  }

  async dispose() {
    const dropsDir = this.tempDropsDir;
    this.tempDropsDir = null;
    if (!dropsDir) return;

    try {
      await rm(dropsDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `Failed to remove drop temp dir: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async ensureDropsDir(): Promise<string | null> {
    if (this.tempDropsDir) return this.tempDropsDir;

    const dropsRoot = join(tmpdir(), 'varro-drops');
    try {
      await mkdir(dropsRoot, { recursive: true, mode: 0o700 });
      this.tempDropsDir = await mkdtemp(join(dropsRoot, 'drop-'));
      return this.tempDropsDir;
    } catch (err) {
      logger.warn(
        `Failed to create drop temp dir: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }
}

function sanitizeDroppedFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'dropped';
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || 'dropped';
}
