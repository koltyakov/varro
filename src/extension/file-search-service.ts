import * as vscode from 'vscode';
import { basename } from 'path';
import type { DroppedFile } from '../shared/protocol';
import { getRelativePath } from './util/path';
import { logger } from './logger';

export type WorkspaceFileSearchEntry = DroppedFile & {
  relativePathLower: string;
  leafLower: string;
};

export type FileSearchResult = {
  requestId: number;
  query: string;
  files: DroppedFile[];
};

const WORKSPACE_FILE_GLOB = '**/*';
const WORKSPACE_FILE_EXCLUDE_GLOB =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/.turbo/**,**/tmp/**,**/coverage/**}';

/**
 * Owns workspace-file discovery and fuzzy ranking for the `@file` picker.
 *
 * Why this is separate from SidebarProvider: the cache, in-flight
 * deduplication, and cancellation state form a cohesive unit that used
 * to be interleaved with unrelated webview concerns.
 */
export class FileSearchService {
  private static readonly CACHE_TTL_MS = 15_000;
  private static readonly CACHE_INVALIDATION_DEBOUNCE_MS = 100;
  private static readonly MAX_CANDIDATES = 4_000;
  private static readonly RESULT_LIMIT = 30;

  private workspaceWatcher: vscode.FileSystemWatcher | null = null;
  private workspaceFileCache: WorkspaceFileSearchEntry[] = [];
  private workspaceFileCacheAt = 0;
  private hasWorkspaceFileCache = false;
  private workspaceFileCachePromise: Promise<WorkspaceFileSearchEntry[]> | null = null;
  private workspaceFileCacheGeneration = 0;
  private fileSearchCts: vscode.CancellationTokenSource | null = null;
  private cacheInvalidationDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watcherInactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private hasPendingWorkspaceFileCacheClear = false;

  /**
   * Launch a search for `query`. Results are delivered through `onResult`.
   * Prior in-flight searches are cancelled.
   */
  search(
    requestId: number,
    query: string,
    limit: number,
    onResult: (result: FileSearchResult) => void
  ): void {
    this.ensureWorkspaceWatcher();
    this.resetWatcherInactivityTimer();
    this.fileSearchCts?.cancel();
    this.fileSearchCts?.dispose();
    this.fileSearchCts = new vscode.CancellationTokenSource();
    const token = this.fileSearchCts.token;
    void this.executeSearch(requestId, query, limit, token, onResult);
  }

  dispose(): void {
    this.fileSearchCts?.cancel();
    this.fileSearchCts?.dispose();
    this.fileSearchCts = null;
    this.disposeWorkspaceWatcher();
    if (this.cacheInvalidationDebounceTimer) {
      clearTimeout(this.cacheInvalidationDebounceTimer);
      this.cacheInvalidationDebounceTimer = null;
    }
    this.hasPendingWorkspaceFileCacheClear = false;
    this.clearWorkspaceFileCache();
  }

  private ensureWorkspaceWatcher() {
    if (this.workspaceWatcher) return;

    const watcher = vscode.workspace.createFileSystemWatcher(
      WORKSPACE_FILE_GLOB,
      false,
      true,
      false
    );
    watcher.onDidCreate(() => this.scheduleWorkspaceFileCacheClear());
    watcher.onDidDelete(() => this.scheduleWorkspaceFileCacheClear());
    this.workspaceWatcher = watcher;
  }

  private resetWatcherInactivityTimer() {
    if (this.watcherInactivityTimer) clearTimeout(this.watcherInactivityTimer);
    this.watcherInactivityTimer = setTimeout(() => {
      this.watcherInactivityTimer = null;
      this.disposeWorkspaceWatcher();
      this.clearWorkspaceFileCache();
    }, FileSearchService.CACHE_TTL_MS);
  }

  private disposeWorkspaceWatcher() {
    if (this.watcherInactivityTimer) {
      clearTimeout(this.watcherInactivityTimer);
      this.watcherInactivityTimer = null;
    }
    this.workspaceWatcher?.dispose();
    this.workspaceWatcher = null;
  }

  private scheduleWorkspaceFileCacheClear() {
    if (this.cacheInvalidationDebounceTimer) {
      this.hasPendingWorkspaceFileCacheClear = true;
      return;
    }

    this.clearWorkspaceFileCache();
    this.startWorkspaceFileCacheClearDebounce();
  }

  private startWorkspaceFileCacheClearDebounce() {
    this.cacheInvalidationDebounceTimer = setTimeout(() => {
      this.cacheInvalidationDebounceTimer = null;
      if (!this.hasPendingWorkspaceFileCacheClear) return;

      this.hasPendingWorkspaceFileCacheClear = false;
      this.clearWorkspaceFileCache();
      this.startWorkspaceFileCacheClearDebounce();
    }, FileSearchService.CACHE_INVALIDATION_DEBOUNCE_MS);
  }

  private clearWorkspaceFileCache() {
    this.workspaceFileCacheGeneration += 1;
    this.workspaceFileCache = [];
    this.workspaceFileCacheAt = 0;
    this.hasWorkspaceFileCache = false;
    this.workspaceFileCachePromise = null;
  }

  private async executeSearch(
    requestId: number,
    query: string,
    limit: number,
    token: vscode.CancellationToken,
    onResult: (result: FileSearchResult) => void
  ): Promise<void> {
    try {
      const files = await this.getWorkspaceFiles(token);
      if (token.isCancellationRequested) return;
      const normalizedQuery = query.trim().toLowerCase();
      const ranked = rankWorkspaceFiles(
        files,
        normalizedQuery,
        Math.max(1, Math.min(limit, FileSearchService.RESULT_LIMIT))
      );
      onResult({ requestId, query, files: ranked });
    } catch (err) {
      if (token.isCancellationRequested) return;
      onResult({ requestId, query, files: [] });
      logger.warn(`searchFiles failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async getWorkspaceFiles(
    token?: vscode.CancellationToken
  ): Promise<WorkspaceFileSearchEntry[]> {
    const now = Date.now();
    if (
      this.hasWorkspaceFileCache &&
      now - this.workspaceFileCacheAt < FileSearchService.CACHE_TTL_MS
    ) {
      return this.workspaceFileCache;
    }
    if (this.workspaceFileCachePromise) return this.workspaceFileCachePromise;

    const cacheGeneration = this.workspaceFileCacheGeneration;
    const promise = Promise.resolve(
      vscode.workspace.findFiles(
        WORKSPACE_FILE_GLOB,
        WORKSPACE_FILE_EXCLUDE_GLOB,
        FileSearchService.MAX_CANDIDATES,
        token
      )
    )
      .then((files) => {
        const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((folder) => ({
          folder,
          normalizedPath: normalizeWorkspacePath(folder.uri.fsPath),
        }));
        const entries = files.map((uri) => {
          const workspaceFolder = findWorkspaceFolder(uri.fsPath, workspaceFolders);
          const relativePath = getRelativePath(uri, workspaceFolder);
          return {
            path: uri.fsPath,
            relativePath,
            type: 'file' as const,
            relativePathLower: relativePath.toLowerCase(),
            leafLower: basename(relativePath).toLowerCase(),
          };
        });
        if (cacheGeneration === this.workspaceFileCacheGeneration) {
          this.workspaceFileCache = entries;
          this.hasWorkspaceFileCache = true;
          this.workspaceFileCacheAt = Date.now();
        }
        return entries;
      })
      .finally(() => {
        if (this.workspaceFileCachePromise === promise) {
          this.workspaceFileCachePromise = null;
        }
      });

    this.workspaceFileCachePromise = promise;
    return promise;
  }
}

type RankedWorkspaceFile = {
  file: WorkspaceFileSearchEntry;
  score: number;
};

function rankWorkspaceFiles(
  files: WorkspaceFileSearchEntry[],
  query: string,
  limit: number
): DroppedFile[] {
  const ranked: RankedWorkspaceFile[] = [];

  for (const file of files) {
    const score = getFileSearchScore(file, query);
    if (score === Number.NEGATIVE_INFINITY) continue;
    insertRankedWorkspaceFile(ranked, { file, score }, limit);
  }

  return ranked.map(({ file }) => ({
    path: file.path,
    relativePath: file.relativePath,
    type: file.type,
    ...(file.lineRanges ? { lineRanges: file.lineRanges } : {}),
  }));
}

function insertRankedWorkspaceFile(
  ranked: RankedWorkspaceFile[],
  candidate: RankedWorkspaceFile,
  limit: number
) {
  let insertAt = ranked.findIndex(
    (item) =>
      candidate.score > item.score ||
      (candidate.score === item.score &&
        candidate.file.relativePath.localeCompare(item.file.relativePath) < 0)
  );

  if (insertAt === -1) {
    if (ranked.length >= limit) return;
    insertAt = ranked.length;
  }

  ranked.splice(insertAt, 0, candidate);
  if (ranked.length > limit) ranked.pop();
}

function getFileSearchScore(file: WorkspaceFileSearchEntry, query: string) {
  if (!query) {
    return 1 / Math.max(file.relativePath.length, 1);
  }

  const haystack = file.relativePathLower;
  const leaf = file.leafLower;
  if (leaf === query) return 10_000;
  if (haystack === query) return 9_000;
  if (leaf.startsWith(query)) return 8_000 - leaf.length;
  if (haystack.startsWith(query)) return 7_000 - haystack.length;
  if (leaf.includes(query)) return 6_000 - leaf.indexOf(query) * 8 - leaf.length;
  if (haystack.includes(query)) return 5_000 - haystack.indexOf(query) * 4 - haystack.length;

  let score = 0;
  let index = 0;
  for (const char of query) {
    const next = haystack.indexOf(char, index);
    if (next === -1) return Number.NEGATIVE_INFINITY;
    score += 12 - Math.min(next - index, 11);
    index = next + 1;
  }
  return score - haystack.length;
}

function normalizeWorkspacePath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function findWorkspaceFolder(
  filePath: string,
  folders: Array<{ folder: vscode.WorkspaceFolder; normalizedPath: string }>
) {
  const normalizedFilePath = normalizeWorkspacePath(filePath);
  let bestMatch: vscode.WorkspaceFolder | undefined;

  for (const { folder, normalizedPath } of folders) {
    if (
      normalizedFilePath === normalizedPath ||
      normalizedFilePath.startsWith(`${normalizedPath}/`)
    ) {
      if (
        !bestMatch ||
        normalizedPath.length > normalizeWorkspacePath(bestMatch.uri.fsPath).length
      ) {
        bestMatch = folder;
      }
    }
  }

  return bestMatch;
}
