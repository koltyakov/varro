import { writeFile, mkdtemp, mkdir, readFile, readdir, rm, stat as statPath } from 'fs/promises';
import { tmpdir } from 'os';
import { Buffer } from 'buffer';
import { randomBytes } from 'crypto';
import { join, isAbsolute, relative } from 'path';
import * as vscode from 'vscode';
import {
  MAX_DROPPED_CONTENT_FILES,
  MAX_DROPPED_CONTENT_FILE_BYTES,
  MAX_DROPPED_CONTENT_TOTAL_BYTES,
} from '../shared/dropped-content-policy';
import type { DroppedFile } from '../shared/protocol';
import type { ContextProvider } from './context-provider';
import { logger } from './logger';
import { getRelativePath } from './util/path';

type DroppedFileInput = Pick<DroppedFile, 'path' | 'relativePath' | 'type'>;
const MAX_CONCURRENT_DROPPED_CONTENT_WRITES = 2;
const MAX_CONCURRENT_DROPPED_PATH_STATS = 8;
const STALE_DROPS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DROP_DIRECTORY_NAME_PATTERN = /^drop-[a-zA-Z0-9_-]+$/;
const DROP_OWNER_MARKER_NAME = '.varro-owner.json';

interface DropOwnerMarker {
  version: 1;
  pid: number;
  createdAt: number;
}

type DropOwnerReadResult =
  | { kind: 'valid'; marker: DropOwnerMarker }
  | { kind: 'absent' }
  | { kind: 'malformed' };

interface TempDropsOps {
  create(prefix: string): Promise<string>;
  remove(path: string, options: { recursive?: boolean; force: true }): Promise<void>;
  write(path: string, data: Uint8Array, options: { mode: number }): Promise<void>;
  read?(path: string): Promise<Uint8Array | string>;
  list?(path: string): Promise<Array<{ name: string; isDirectory(): boolean }>>;
  stat?(path: string): Promise<{ mtimeMs: number }>;
  isProcessAlive?(pid: number): boolean;
}

const DEFAULT_TEMP_DROPS_OPS: TempDropsOps = {
  create: mkdtemp,
  remove: rm,
  write: writeFile,
  read: readFile,
  list: (path) => readdir(path, { withFileTypes: true }),
  stat: statPath,
  isProcessAlive,
};

export class DroppedFilesService {
  private tempDropsDir: string | null = null;
  private dropsDirCreation: Promise<string | null> | null = null;
  private disposePromise: Promise<void> | null = null;
  private dropsDirGeneration = 0;
  private staleSweepPromise: Promise<void> | null = null;
  private readonly activeContentWrites = new Set<Promise<unknown>>();
  private readonly ownedContentFiles = new Map<string, number>();
  private readonly ownedRemovalPromises = new Map<string, Promise<boolean>>();
  private ownedContentBytes = 0;
  private reservedContentBytes = 0;

  constructor(
    private readonly contextProvider: Pick<ContextProvider, 'context'>,
    private readonly tempDropsOps = DEFAULT_TEMP_DROPS_OPS
  ) {}

  async fromContent(files: Array<{ name: string; content: string; size: number }>) {
    if (this.disposePromise) await this.disposePromise;
    const operation = this.fromContentNow(files);
    this.activeContentWrites.add(operation);
    try {
      return await operation;
    } finally {
      this.activeContentWrites.delete(operation);
    }
  }

  private async fromContentNow(files: Array<{ name: string; content: string; size: number }>) {
    const candidates = files.slice(0, MAX_DROPPED_CONTENT_FILES);
    if (files.length > candidates.length) {
      logger.warn(
        `Ignoring ${files.length - candidates.length} dropped files beyond the ${MAX_DROPPED_CONTENT_FILES} file limit`
      );
    }

    const acceptedFiles: typeof candidates = [];
    let totalSize = 0;
    for (const file of candidates) {
      if (!isDroppedContentSizeWithinLimits(file)) continue;
      if (totalSize + file.size > MAX_DROPPED_CONTENT_TOTAL_BYTES) {
        logger.warn(
          `Ignoring dropped file ${file.name}: aggregate content is larger than ${MAX_DROPPED_CONTENT_TOTAL_BYTES} bytes`
        );
        continue;
      }
      totalSize += file.size;
      if (isDroppedContentEncodingValid(file)) acceptedFiles.push(file);
    }

    if (acceptedFiles.length === 0) return [];
    const dropsDir = await this.ensureDropsDir();
    if (!dropsDir) return [];

    const writableFiles: typeof acceptedFiles = [];
    for (const file of acceptedFiles) {
      if (
        this.ownedContentBytes + this.reservedContentBytes + file.size >
        MAX_DROPPED_CONTENT_TOTAL_BYTES
      ) {
        logger.warn(
          `Ignoring dropped file ${file.name}: live temporary content is larger than ${MAX_DROPPED_CONTENT_TOTAL_BYTES} bytes`
        );
        continue;
      }
      this.reservedContentBytes += file.size;
      writableFiles.push(file);
    }

    if (writableFiles.length === 0) return [];

    const createdPaths: string[] = [];
    try {
      const results: Array<DroppedFileInput | null> = [];
      for (
        let index = 0;
        index < writableFiles.length;
        index += MAX_CONCURRENT_DROPPED_CONTENT_WRITES
      ) {
        const chunk = writableFiles.slice(index, index + MAX_CONCURRENT_DROPPED_CONTENT_WRITES);
        const chunkResults = await Promise.all(
          chunk.map(async (file) => {
            try {
              const buffer = Buffer.from(file.content, 'base64');
              const safeName = sanitizeDroppedFileName(file.name);
              const targetPath = join(
                dropsDir,
                `${Date.now()}-${randomBytes(4).toString('hex')}-${safeName}`
              );
              await this.tempDropsOps.write(targetPath, buffer, { mode: 0o600 });
              createdPaths.push(targetPath);
              this.ownedContentFiles.set(targetPath, file.size);
              this.ownedContentBytes += file.size;
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
            } finally {
              this.reservedContentBytes -= file.size;
            }
          })
        );
        results.push(...chunkResults);
      }

      return results.filter(
        (item): item is { path: string; relativePath: string; type: 'file' } => item !== null
      );
    } catch (err) {
      await this.removeOwnedFiles(createdPaths);
      logger.warn(
        `Failed to persist dropped files: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  async removeOwnedFile(path: string): Promise<boolean> {
    const pending = this.ownedRemovalPromises.get(path);
    if (pending) return pending;
    const size = this.ownedContentFiles.get(path);
    if (size === undefined) return false;
    const removal = this.removeOwnedFileNow(path, size);
    this.ownedRemovalPromises.set(path, removal);
    try {
      return await removal;
    } finally {
      if (this.ownedRemovalPromises.get(path) === removal) {
        this.ownedRemovalPromises.delete(path);
      }
    }
  }

  private async removeOwnedFileNow(path: string, size: number): Promise<boolean> {
    try {
      await this.tempDropsOps.remove(path, { force: true });
      this.ownedContentFiles.delete(path);
      this.ownedContentBytes = Math.max(0, this.ownedContentBytes - size);
      return true;
    } catch (err) {
      logger.warn(
        `Failed to remove dropped content file ${path}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  async removeOwnedFiles(paths: Iterable<string>): Promise<void> {
    await Promise.allSettled(Array.from(paths, (path) => this.removeOwnedFile(path)));
  }

  async fromPaths(paths: string[]) {
    const uniquePaths = Array.from(new Set(paths));
    const dropped: Array<DroppedFileInput | null> = [];
    for (let index = 0; index < uniquePaths.length; index += MAX_CONCURRENT_DROPPED_PATH_STATS) {
      const chunk = uniquePaths.slice(index, index + MAX_CONCURRENT_DROPPED_PATH_STATS);
      const chunkResults = await Promise.all(
        chunk.map(async (path) => {
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
      dropped.push(...chunkResults);
    }

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
      const folderRelativePath = relative(folder.uri.fsPath, candidate.fsPath);
      if (folderRelativePath.startsWith('..') || isAbsolute(folderRelativePath)) {
        continue;
      }
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
    if (this.disposePromise) return this.disposePromise;
    const disposePromise = this.disposeDropsDir();
    this.disposePromise = disposePromise;
    try {
      await disposePromise;
    } finally {
      if (this.disposePromise === disposePromise) this.disposePromise = null;
    }
  }

  private async disposeDropsDir() {
    this.dropsDirGeneration += 1;
    const dropsDir = this.tempDropsDir;
    this.tempDropsDir = null;
    await this.dropsDirCreation;
    await Promise.allSettled(this.activeContentWrites);
    if (dropsDir && (await this.removeDropsDir(dropsDir))) {
      this.ownedContentFiles.clear();
      this.ownedContentBytes = 0;
    }
  }

  private async removeDropsDir(dropsDir: string): Promise<boolean> {
    try {
      await this.tempDropsOps.remove(dropsDir, { recursive: true, force: true });
      return true;
    } catch (err) {
      logger.warn(
        `Failed to remove drop temp dir: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  private async ensureDropsDir(): Promise<string | null> {
    if (this.disposePromise) await this.disposePromise;
    if (this.tempDropsDir) return this.tempDropsDir;

    const creation = this.dropsDirCreation ?? this.createDropsDir();
    this.dropsDirCreation = creation;
    try {
      return await creation;
    } finally {
      if (this.dropsDirCreation === creation) this.dropsDirCreation = null;
    }
  }

  private async createDropsDir(): Promise<string | null> {
    const generation = this.dropsDirGeneration;
    const dropsRoot = join(tmpdir(), 'varro-drops');
    try {
      await mkdir(dropsRoot, { recursive: true, mode: 0o700 });
      this.staleSweepPromise ??= this.sweepStaleDrops(dropsRoot);
      await this.staleSweepPromise;
      const dropsDir = await this.tempDropsOps.create(join(dropsRoot, 'drop-'));
      try {
        await this.writeOwnerMarker(dropsDir);
      } catch (err) {
        await this.removeDropsDir(dropsDir);
        throw err;
      }
      if (generation !== this.dropsDirGeneration) {
        await this.removeDropsDir(dropsDir);
        return null;
      }
      this.tempDropsDir = dropsDir;
      return dropsDir;
    } catch (err) {
      logger.warn(
        `Failed to create drop temp dir: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  private writeOwnerMarker(dropsDir: string): Promise<void> {
    const marker: DropOwnerMarker = {
      version: 1,
      pid: process.pid,
      createdAt: Date.now(),
    };
    return this.tempDropsOps.write(
      join(dropsDir, DROP_OWNER_MARKER_NAME),
      Buffer.from(JSON.stringify(marker), 'utf8'),
      { mode: 0o600 }
    );
  }

  private async sweepStaleDrops(dropsRoot: string): Promise<void> {
    if (!this.tempDropsOps.list || !this.tempDropsOps.stat) return;
    try {
      const entries = await this.tempDropsOps.list(dropsRoot);
      const staleBefore = Date.now() - STALE_DROPS_MAX_AGE_MS;
      for (const entry of entries) {
        if (!entry.isDirectory() || !DROP_DIRECTORY_NAME_PATTERN.test(entry.name)) continue;
        const candidate = join(dropsRoot, entry.name);
        if (candidate === this.tempDropsDir) continue;
        try {
          const metadata = await this.tempDropsOps.stat(candidate);
          if (metadata.mtimeMs >= staleBefore) continue;
          const owner = await this.readOwnerMarker(candidate);
          if (owner.kind === 'malformed') continue;
          if (owner.kind === 'valid') {
            if (owner.marker.createdAt >= staleBefore) continue;
            if (!this.tempDropsOps.isProcessAlive) continue;
            if (this.tempDropsOps.isProcessAlive(owner.marker.pid)) continue;
          }
          await this.removeDropsDir(candidate);
        } catch {
          // Best-effort cleanup must not block new drops.
        }
      }
    } catch {
      // The root can disappear between mkdir and listing during shutdown.
    }
  }

  private async readOwnerMarker(dropsDir: string): Promise<DropOwnerReadResult> {
    if (!this.tempDropsOps.read) return { kind: 'malformed' };
    try {
      const raw = await this.tempDropsOps.read(join(dropsDir, DROP_OWNER_MARKER_NAME));
      const value = JSON.parse(
        typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
      ) as unknown;
      if (!isDropOwnerMarker(value)) return { kind: 'malformed' };
      return { kind: 'valid', marker: value };
    } catch (err) {
      return isMissingFileError(err) ? { kind: 'absent' } : { kind: 'malformed' };
    }
  }
}

function isDropOwnerMarker(value: unknown): value is DropOwnerMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    'version' in value &&
    value.version === 1 &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    'createdAt' in value &&
    typeof value.createdAt === 'number' &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt >= 0
  );
}

function isMissingFileError(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'code' in value && value.code === 'ENOENT';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !isProcessMissingError(err);
  }
}

function isProcessMissingError(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'code' in value && value.code === 'ESRCH';
}

function sanitizeDroppedFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'dropped';
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || 'dropped';
}

function isDroppedContentSizeWithinLimits(file: { name: string; size: number }) {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > MAX_DROPPED_CONTENT_FILE_BYTES
  ) {
    logger.warn(
      `Ignoring dropped file ${file.name}: file is larger than ${MAX_DROPPED_CONTENT_FILE_BYTES} bytes`
    );
    return false;
  }
  return true;
}

function isDroppedContentEncodingValid(file: { name: string; content: string; size: number }) {
  const maxBase64Length = Math.ceil(MAX_DROPPED_CONTENT_FILE_BYTES / 3) * 4;
  if (typeof file.content !== 'string' || file.content.length > maxBase64Length) {
    logger.warn(
      `Ignoring dropped file ${file.name}: encoded content is larger than ${MAX_DROPPED_CONTENT_FILE_BYTES} bytes`
    );
    return false;
  }

  if (getBase64DecodedSize(file.content) !== file.size) {
    logger.warn(`Ignoring dropped file ${file.name}: encoded content does not match declared size`);
    return false;
  }

  return true;
}

function getBase64DecodedSize(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
