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

/**
 * Owns workspace-file discovery and fuzzy ranking for the `@file` picker.
 *
 * Why this is separate from SidebarProvider: the cache, in-flight
 * deduplication, and cancellation state form a cohesive unit that used
 * to be interleaved with unrelated webview concerns.
 */
export class FileSearchService {
  private static readonly CACHE_TTL_MS = 15_000;
  private static readonly MAX_CANDIDATES = 4_000;
  private static readonly RESULT_LIMIT = 30;

  private workspaceFileCache: WorkspaceFileSearchEntry[] = [];
  private workspaceFileCacheAt = 0;
  private workspaceFileCachePromise: Promise<WorkspaceFileSearchEntry[]> | null = null;
  private fileSearchCts: vscode.CancellationTokenSource | null = null;

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
    this.workspaceFileCache = [];
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
      this.workspaceFileCache.length > 0 &&
      now - this.workspaceFileCacheAt < FileSearchService.CACHE_TTL_MS
    ) {
      return this.workspaceFileCache;
    }
    if (this.workspaceFileCachePromise) return this.workspaceFileCachePromise;

    const promise = Promise.resolve(
      vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/.turbo/**,**/coverage/**}',
        FileSearchService.MAX_CANDIDATES,
        token
      )
    )
      .then((files) => {
        const entries = files.map((uri) => {
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          const relativePath = getRelativePath(uri, workspaceFolder);
          return {
            path: uri.fsPath,
            relativePath,
            type: 'file' as const,
            relativePathLower: relativePath.toLowerCase(),
            leafLower: basename(relativePath).toLowerCase(),
          };
        });
        this.workspaceFileCache = entries;
        this.workspaceFileCacheAt = Date.now();
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
