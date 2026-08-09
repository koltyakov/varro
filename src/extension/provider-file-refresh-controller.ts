import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'path';
import * as vscode from 'vscode';
import type { Persistence } from '../shared/persistence';
import type { ServerStatus } from '../shared/protocol';
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
  server: Pick<OpenCodeServer, 'status' | 'request' | 'restart' | 'readServerInfo' | 'on' | 'off'>;
  persistence: Pick<Persistence, 'get' | 'set' | 'remove'>;
  clearProviderLimitCache(): void;
  postRefresh(options?: { revalidateAuth: true }): void;
  postPendingStatus(pending: boolean): void;
};

type PendingRefreshScope = 'workspace' | 'global';
type PersistedPendingRefreshState =
  | { version: 1; revalidateAuth: boolean }
  | { version: 2; scope: PendingRefreshScope; revalidateAuth: boolean };

export class ProviderFileRefreshController {
  private static readonly PENDING_STATE_KEY = 'varro.providerRefresh.pending';
  private static readonly RETRY_MS = 1_000;
  private static readonly MAX_RETRIES = 5;
  private static readonly SIGNATURE_MAX_BYTES = 1024 * 1024;
  private static readonly SIGNATURE_TIMEOUT_MS = 1_000;

  private configWatchers: vscode.FileSystemWatcher[] = [];
  private authWatcher: vscode.FileSystemWatcher | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshGeneration = 0;
  private observedFilesSignature: string | null = null;
  private pendingScope: PendingRefreshScope | null = null;
  private authChangePending = false;
  private authRevalidationPending = false;
  private pendingStatusPosted = false;
  private invalidationInFlight = false;
  private unmanagedServerSynchronized = false;
  private disposed = false;
  private readonly handleServerStatus = (status: ServerStatus) => {
    if (
      status.state !== 'running' ||
      !this.pendingScope ||
      this.invalidationInFlight ||
      this.refreshTimer
    ) {
      return;
    }
    void this.maybeRestart(this.refreshGeneration, 0);
  };

  constructor(
    private readonly dependencies: ProviderFileRefreshDependencies,
    private readonly fileSystem: ProviderSignatureFileSystem = nodeProviderSignatureFileSystem
  ) {
    const pendingState = dependencies.persistence.get<unknown>(
      ProviderFileRefreshController.PENDING_STATE_KEY
    );
    if (isPersistedPendingState(pendingState)) {
      this.pendingScope = pendingState.version === 1 ? 'global' : pendingState.scope;
      this.authRevalidationPending = pendingState.revalidateAuth;
    }
    dependencies.server.on('status', this.handleServerStatus);
  }

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
      this.authWatcher = this.createFileWatcher(getOpenCodeAuthFilePath(), true);
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
    this.dependencies.server.off('status', this.handleServerStatus);
    this.disposeFileWatchers();
  }

  postStatus() {
    this.pendingStatusPosted = this.pendingScope !== null;
    this.dependencies.postPendingStatus(this.pendingScope !== null);
  }

  async refreshWorkspaceState(generation = ++this.refreshGeneration) {
    if (this.disposed || generation !== this.refreshGeneration) return;
    this.dependencies.clearProviderLimitCache();
    await this.markRefreshPending('workspace');
    if (this.disposed || generation !== this.refreshGeneration) return;
    this.dependencies.postRefresh();
    await this.maybeRestart(generation, 0);
  }

  async refreshState(generation = ++this.refreshGeneration, requireSignatureChange = false) {
    if (this.disposed || generation !== this.refreshGeneration) return;
    const signature = await this.readFilesSignature();
    if (this.disposed || generation !== this.refreshGeneration) return;
    if (requireSignatureChange && this.observedFilesSignature === null) {
      this.observedFilesSignature = signature;
      this.authRevalidationPending ||= this.authChangePending;
      this.authChangePending = false;
      this.dependencies.clearProviderLimitCache();
      await this.markRefreshPending('global');
      this.dependencies.postRefresh();
      await this.maybeRestart(generation, 0);
      return;
    }
    if (requireSignatureChange && signature === this.observedFilesSignature) {
      this.authChangePending = false;
      if (this.pendingScope) {
        await this.maybeRestart(generation, 0);
      }
      return;
    }
    this.dependencies.clearProviderLimitCache();
    this.observedFilesSignature = signature;
    this.authRevalidationPending ||= this.authChangePending;
    this.authChangePending = false;
    await this.markRefreshPending('global');
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

  private createFileWatcher(path: string, watchesAuth = false) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dirname(path)), basename(path))
    );
    watcher.onDidCreate(() => this.scheduleRefresh(watchesAuth));
    watcher.onDidChange(() => this.scheduleRefresh(watchesAuth));
    watcher.onDidDelete(() => this.scheduleRefresh(watchesAuth));
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

  private scheduleRefresh(authChanged: boolean) {
    this.authChangePending ||= authChanged;
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
      await this.markRefreshPending('global');
    } else if (
      !this.unmanagedServerSynchronized &&
      this.dependencies.server.status.state === 'running'
    ) {
      const managedProcess = await this.readManagedServerState();
      if (this.disposed || generation !== this.refreshGeneration) return;
      if (managedProcess === false) await this.markRefreshPending('global');
    }
    this.dependencies.postRefresh();
    if (this.pendingScope) {
      await this.maybeRestart(generation, 0);
    }
  }

  private async maybeRestart(
    generation: number,
    retryCount: number,
    managedProcessConfirmed = false
  ) {
    const pendingScope = this.pendingScope;
    if (this.disposed || generation !== this.refreshGeneration || !pendingScope) {
      return;
    }
    if (this.dependencies.server.status.state === 'starting') {
      this.scheduleRestartRetry(generation, retryCount, false, managedProcessConfirmed);
      return;
    }
    if (this.dependencies.server.status.state !== 'running') return;

    if (pendingScope === 'global' && !managedProcessConfirmed) {
      const managedProcess = await this.readManagedServerState();
      if (this.disposed || generation !== this.refreshGeneration) return;
      if (managedProcess === null) {
        this.scheduleRestartRetry(generation, retryCount);
        return;
      }
      managedProcessConfirmed = managedProcess;
    }
    const idle = await this.isServerIdle();
    if (this.disposed || generation !== this.refreshGeneration) return;
    if (idle === false) {
      this.postPendingStatus();
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
      this.dependencies.server.status.state !== 'running'
    ) {
      return;
    }
    let stillManaged = false;
    if (pendingScope === 'global') {
      const managedState = await this.readManagedServerState();
      if (this.disposed || generation !== this.refreshGeneration) return;
      if (managedState === null) {
        this.scheduleRestartRetry(generation, retryCount, true, managedProcessConfirmed);
        return;
      }
      stillManaged = managedState;
    }
    if (
      this.disposed ||
      generation !== this.refreshGeneration ||
      this.dependencies.server.status.state !== 'running'
    ) {
      return;
    }

    this.invalidationInFlight = true;
    try {
      if (pendingScope === 'workspace') {
        await this.dependencies.server.request('POST', '/instance/dispose');
      } else if (stillManaged) {
        await this.dependencies.server.restart();
      } else {
        await this.dependencies.server.request('POST', '/global/dispose');
        this.unmanagedServerSynchronized = true;
      }
      // The invalidation happened, so the pending flag must clear even when the
      // generation moved on (e.g. the webview toggled watching while the server
      // was refreshing); a signature change during the refresh is still caught
      // by the next activation's signature comparison.
      this.pendingScope = null;
      await this.clearPersistedPendingState();
      if (!this.disposed && this.pendingStatusPosted) {
        this.pendingStatusPosted = false;
        this.dependencies.postPendingStatus(false);
      }
      if (this.disposed || generation !== this.refreshGeneration) return;
      const revalidateAuth = this.authRevalidationPending;
      this.authRevalidationPending = false;
      this.dependencies.clearProviderLimitCache();
      this.dependencies.postRefresh(revalidateAuth ? { revalidateAuth: true } : undefined);
    } catch (err) {
      if (this.disposed || generation !== this.refreshGeneration) return;
      logger.warn(
        `Provider refresh invalidation failed: ${err instanceof Error ? err.message : String(err)}`
      );
      this.scheduleRestartRetry(generation, retryCount, true, managedProcessConfirmed);
    } finally {
      this.invalidationInFlight = false;
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
      const [statuses, questions, permissions] = await Promise.all([
        this.dependencies.server.request('GET', '/session/status'),
        this.dependencies.server.request('GET', '/question'),
        this.dependencies.server.request('GET', '/permission'),
      ]);
      if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return null;
      if (!Array.isArray(questions)) return null;
      if (!Array.isArray(permissions)) return null;
      for (const value of Object.values(statuses)) {
        if (!value || typeof value !== 'object') continue;
        const type = (value as Record<string, unknown>).type;
        if (type === 'busy' || type === 'retry') return false;
      }
      return questions.length === 0 && permissions.length === 0;
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
      !this.pendingScope ||
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

  private postPendingStatus() {
    if (this.pendingStatusPosted) return;
    this.pendingStatusPosted = true;
    this.dependencies.postPendingStatus(true);
  }

  private async markRefreshPending(scope: PendingRefreshScope) {
    if (!this.pendingScope || scope === 'global') {
      this.pendingScope = scope;
    }
    try {
      await this.dependencies.persistence.set(ProviderFileRefreshController.PENDING_STATE_KEY, {
        version: 2,
        scope: this.pendingScope,
        revalidateAuth: this.authRevalidationPending,
      });
    } catch (err) {
      logger.warn(
        `Failed to persist provider refresh state: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async clearPersistedPendingState() {
    try {
      await this.dependencies.persistence.remove(ProviderFileRefreshController.PENDING_STATE_KEY);
    } catch (err) {
      logger.warn(
        `Failed to clear provider refresh state: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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

function isPersistedPendingState(value: unknown): value is PersistedPendingRefreshState {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.version === 1) return typeof record.revalidateAuth === 'boolean';
  return (
    record.version === 2 &&
    (record.scope === 'workspace' || record.scope === 'global') &&
    typeof record.revalidateAuth === 'boolean'
  );
}
