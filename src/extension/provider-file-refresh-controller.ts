import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'path';
import * as vscode from 'vscode';
import { logger } from './logger';
import { getOpenCodeConfigPaths } from './open-code-process';
import type { OpenCodeServer } from './server';
import { getOpenCodeAuthFilePath } from './util/provider-limit';

type ProviderFileStats = {
  size: number;
  mtimeMs: number;
  ino: number;
  isFile(): boolean;
};

export type ProviderSignatureFileSystem = {
  stat(path: string): PromiseLike<ProviderFileStats>;
  readFile(path: string, signal: AbortSignal): PromiseLike<Uint8Array>;
};

export const nodeProviderSignatureFileSystem: ProviderSignatureFileSystem = {
  stat,
  readFile: (path, signal) => readFile(path, { signal }),
};

type ProviderFileRefreshDependencies = {
  server: Pick<OpenCodeServer, 'status' | 'request' | 'restart' | 'readServerInfo'>;
  hasLocallyActiveWork(): boolean;
  clearProviderLimitCache(): void;
  postRefresh(): void;
};

export class ProviderFileRefreshController {
  private static readonly RETRY_MS = 1_000;
  private static readonly MAX_RETRIES = 5;
  private static readonly SIGNATURE_MAX_BYTES = 1024 * 1024;
  private static readonly SIGNATURE_TIMEOUT_MS = 1_000;

  private configWatchers: vscode.FileSystemWatcher[] = [];
  private authWatcher: vscode.FileSystemWatcher | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshGeneration = 0;
  private observedFilesSignature: string | null = null;
  private restartPending = false;
  private unmanagedServerSynchronized = false;
  private disposed = false;

  constructor(
    private readonly dependencies: ProviderFileRefreshDependencies,
    private readonly fileSystem: ProviderSignatureFileSystem = nodeProviderSignatureFileSystem
  ) {}

  async initializeSignature() {
    const generation = this.refreshGeneration;
    const signature = await this.readFilesSignature();
    if (
      this.disposed ||
      generation !== this.refreshGeneration ||
      this.observedFilesSignature !== null
    ) {
      return;
    }
    this.observedFilesSignature = signature;
  }

  setActive(active: boolean) {
    if (active) {
      if (this.configWatchers.length > 0 || this.authWatcher) return;
      const generation = ++this.refreshGeneration;
      this.configWatchers = getOpenCodeConfigPaths().map((path) => this.createFileWatcher(path));
      this.authWatcher = this.createFileWatcher(getOpenCodeAuthFilePath());
      void this.activate(generation).catch((err) => {
        logger.warn(
          `Failed to activate provider file observation: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      return;
    }

    this.disposeFileWatchers();
  }

  beginDispose() {
    this.disposed = true;
    this.refreshGeneration += 1;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  dispose() {
    this.beginDispose();
    this.disposeFileWatchers();
  }

  async refreshState(generation = ++this.refreshGeneration, requireSignatureChange = false) {
    if (this.disposed || generation !== this.refreshGeneration) return;
    const signature = await this.readFilesSignature();
    if (this.disposed || generation !== this.refreshGeneration) return;
    if (requireSignatureChange && this.observedFilesSignature === null) {
      this.observedFilesSignature = signature;
      this.dependencies.clearProviderLimitCache();
      this.restartPending = true;
      this.dependencies.postRefresh();
      await this.maybeRestart(generation, 0);
      return;
    }
    if (requireSignatureChange && signature === this.observedFilesSignature) {
      if (this.restartPending) {
        await this.maybeRestart(generation, 0);
      }
      return;
    }
    this.dependencies.clearProviderLimitCache();
    this.observedFilesSignature = signature;
    this.restartPending = true;
    this.dependencies.postRefresh();
    await this.maybeRestart(generation, 0);
  }

  async readFilesSignature() {
    const signatures = await Promise.all(
      [...getOpenCodeConfigPaths(), getOpenCodeAuthFilePath()].map(async (path) => {
        try {
          const stats = await this.withSignatureTimeout(this.fileSystem.stat(path));
          if (!stats.isFile()) return `${path}:ignored`;
          if (stats.size > ProviderFileRefreshController.SIGNATURE_MAX_BYTES) {
            return `${path}:oversized:size=${stats.size}:mtime=${stats.mtimeMs}:ino=${stats.ino}`;
          }

          const content = await this.withSignatureTimeout(
            this.fileSystem.readFile(
              path,
              AbortSignal.timeout(ProviderFileRefreshController.SIGNATURE_TIMEOUT_MS)
            )
          );
          if (content.byteLength > ProviderFileRefreshController.SIGNATURE_MAX_BYTES) {
            return `${path}:oversized:size=${content.byteLength}:mtime=${stats.mtimeMs}:ino=${stats.ino}`;
          }
          const digest = createHash('sha256').update(content).digest('hex');
          return `${path}:${digest}`;
        } catch (err) {
          const code =
            err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unavailable';
          return `${path}:${code === 'ENOENT' ? 'missing' : 'unavailable'}`;
        }
      })
    );
    return signatures.join('|');
  }

  private createFileWatcher(path: string) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dirname(path)), basename(path))
    );
    watcher.onDidCreate(() => this.scheduleRefresh());
    watcher.onDidChange(() => this.scheduleRefresh());
    watcher.onDidDelete(() => this.scheduleRefresh());
    return watcher;
  }

  private disposeFileWatchers() {
    this.refreshGeneration += 1;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const watcher of this.configWatchers) watcher.dispose();
    this.authWatcher?.dispose();
    this.configWatchers = [];
    this.authWatcher = null;
  }

  private scheduleRefresh() {
    const generation = ++this.refreshGeneration;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshState(generation, true);
    }, 250);
  }

  private async activate(generation: number) {
    const signature = await this.readFilesSignature();
    if (this.disposed || generation !== this.refreshGeneration) return;

    const changed =
      this.observedFilesSignature !== null && signature !== this.observedFilesSignature;
    this.observedFilesSignature = signature;
    if (changed) {
      this.dependencies.clearProviderLimitCache();
      this.restartPending = true;
    } else if (
      !this.unmanagedServerSynchronized &&
      this.dependencies.server.status.state === 'running'
    ) {
      const managedProcess = await this.readManagedServerState();
      if (this.disposed || generation !== this.refreshGeneration) return;
      if (managedProcess === false) this.restartPending = true;
    }
    this.dependencies.postRefresh();
    if (this.restartPending) {
      await this.maybeRestart(generation, 0);
    }
  }

  private async maybeRestart(
    generation: number,
    retryCount: number,
    managedProcessConfirmed = false
  ) {
    if (this.disposed || generation !== this.refreshGeneration || !this.restartPending) {
      return;
    }
    if (this.dependencies.server.status.state === 'starting') {
      this.scheduleRestartRetry(generation, retryCount, false, managedProcessConfirmed);
      return;
    }
    if (this.dependencies.server.status.state !== 'running') return;

    if (!managedProcessConfirmed) {
      const managedProcess = await this.readManagedServerState();
      if (this.disposed || generation !== this.refreshGeneration) return;
      if (managedProcess === null) {
        this.scheduleRestartRetry(generation, retryCount);
        return;
      }
      managedProcessConfirmed = managedProcess;
    }
    if (this.dependencies.hasLocallyActiveWork()) {
      this.scheduleRestartRetry(generation, retryCount, false, managedProcessConfirmed);
      return;
    }

    const idle = await this.isServerIdle();
    if (this.disposed || generation !== this.refreshGeneration) return;
    if (idle === false) {
      this.scheduleRestartRetry(generation, retryCount, false, managedProcessConfirmed);
      return;
    }
    if (idle === null) {
      this.scheduleRestartRetry(generation, retryCount, true, managedProcessConfirmed);
      return;
    }
    if (
      this.disposed ||
      generation !== this.refreshGeneration ||
      this.dependencies.server.status.state !== 'running' ||
      this.dependencies.hasLocallyActiveWork()
    ) {
      return;
    }
    const stillManaged = await this.readManagedServerState();
    if (this.disposed || generation !== this.refreshGeneration) return;
    if (stillManaged === null) {
      this.scheduleRestartRetry(generation, retryCount, true, managedProcessConfirmed);
      return;
    }
    if (
      this.disposed ||
      generation !== this.refreshGeneration ||
      this.dependencies.server.status.state !== 'running' ||
      this.dependencies.hasLocallyActiveWork()
    ) {
      return;
    }

    try {
      if (stillManaged) {
        await this.dependencies.server.restart();
      } else {
        await this.dependencies.server.request('POST', '/global/dispose');
        this.unmanagedServerSynchronized = true;
      }
      if (this.disposed || generation !== this.refreshGeneration) return;
      this.restartPending = false;
      this.dependencies.clearProviderLimitCache();
      this.dependencies.postRefresh();
    } catch (err) {
      if (this.disposed || generation !== this.refreshGeneration) return;
      logger.warn(
        `Provider refresh invalidation failed: ${err instanceof Error ? err.message : String(err)}`
      );
      this.scheduleRestartRetry(generation, retryCount, true, managedProcessConfirmed);
    }
  }

  private async readManagedServerState(): Promise<boolean | null> {
    try {
      const info = await this.dependencies.server.readServerInfo();
      return typeof info.managedProcess === 'boolean' ? info.managedProcess : null;
    } catch {
      return null;
    }
  }

  private async isServerIdle(): Promise<boolean | null> {
    try {
      const [statuses, questions] = await Promise.all([
        this.dependencies.server.request('GET', '/session/status'),
        this.dependencies.server.request('GET', '/question'),
      ]);
      if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return null;
      if (!Array.isArray(questions)) return null;
      for (const value of Object.values(statuses)) {
        if (!value || typeof value !== 'object') continue;
        const type = (value as Record<string, unknown>).type;
        if (type === 'busy' || type === 'retry') return false;
      }
      return questions.length === 0 && !this.dependencies.hasLocallyActiveWork();
    } catch {
      return null;
    }
  }

  private scheduleRestartRetry(
    generation: number,
    retryCount: number,
    bounded = true,
    managedProcessConfirmed = false
  ) {
    if (
      this.disposed ||
      generation !== this.refreshGeneration ||
      !this.restartPending ||
      (this.configWatchers.length === 0 && !this.authWatcher)
    ) {
      return;
    }
    if (bounded && retryCount >= ProviderFileRefreshController.MAX_RETRIES) {
      logger.info('Provider refresh restart remained deferred after bounded retries');
      return;
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.maybeRestart(generation, bounded ? retryCount + 1 : 0, managedProcessConfirmed);
    }, ProviderFileRefreshController.RETRY_MS);
  }

  private async withSignatureTimeout<T>(operation: PromiseLike<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Provider signature read timed out')),
        ProviderFileRefreshController.SIGNATURE_TIMEOUT_MS
      );
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
