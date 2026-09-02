/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- Provider file and event payloads are decoded at this controller boundary. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Provider records are asserted only after event and file schema checks. */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'path';
import * as vscode from 'vscode';
import type { OpenCodeModelRouting, OpenCodeModelRoute } from '../shared/opencode-types';
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
  getWorkspaceDirectories(): readonly string[];
};

type PendingRefreshScope = 'workspace' | 'global';
type PersistedPendingRefreshState =
  | { version: 1; revalidateAuth: boolean }
  | { version: 2; scope: PendingRefreshScope; revalidateAuth: boolean }
  | {
      version: 3;
      scope: PendingRefreshScope;
      revalidateAuth: boolean;
      source: 'auth' | 'config';
    }
  | {
      version: 4;
      scope: PendingRefreshScope;
      revalidateAuth: boolean;
      source: 'auth' | 'config';
      workspaceDirectories: string[];
    };

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
  private readonly pendingWorkspaceDirectories = new Set<string>();
  private readonly workspaceRoutingBaselines = new Map<string, OpenCodeModelRouting>();
  private workspaceRoutingBaseline: OpenCodeModelRouting | null = null;
  private authChangePending = false;
  private configChangePending = false;
  private pendingAuthOnlyInvalidation = false;
  private authRevalidationPending = false;
  private pendingStatusPosted = false;
  private invalidationInFlight = false;
  private pendingRevision = 0;
  private authIdleCandidate: { generation: number; since: number } | null = null;
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
    void this.maybeInvalidate(this.refreshGeneration, 0);
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
      this.pendingRevision = 1;
      this.authRevalidationPending = pendingState.revalidateAuth;
      this.pendingAuthOnlyInvalidation =
        pendingState.version === 3 || pendingState.version === 4
          ? pendingState.source === 'auth'
          : this.pendingScope === 'global' && pendingState.revalidateAuth;
      if (pendingState.version === 4) {
        for (const directory of pendingState.workspaceDirectories) {
          this.pendingWorkspaceDirectories.add(directory);
        }
      }
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

  async refreshWorkspaceState(
    previousRouting?: OpenCodeModelRouting,
    currentRouting?: OpenCodeModelRouting,
    directory?: string
  ) {
    if (this.disposed) return;
    this.dependencies.clearProviderLimitCache();
    const directoryBaseline = directory ? this.workspaceRoutingBaselines.get(directory) : undefined;
    if (
      directory &&
      directoryBaseline &&
      currentRouting &&
      areOpenCodeRoutesEqual(directoryBaseline, currentRouting)
    ) {
      const generation = ++this.refreshGeneration;
      this.pendingWorkspaceDirectories.delete(directory);
      this.workspaceRoutingBaselines.delete(directory);
      if (this.pendingScope === 'workspace' && this.pendingWorkspaceDirectories.size === 0) {
        await this.cancelWorkspaceRefresh();
      } else if (this.pendingScope === 'workspace') {
        await this.markRefreshPending('workspace');
      }
      if (this.disposed || generation !== this.refreshGeneration) return;
      this.dependencies.postRefresh();
      if (this.pendingScope) await this.maybeInvalidate(generation, 0);
      return;
    }
    if (
      directory &&
      previousRouting &&
      currentRouting &&
      areOpenCodeRoutesEqual(previousRouting, currentRouting)
    ) {
      this.dependencies.postRefresh();
      return;
    }
    const generation = ++this.refreshGeneration;
    if (
      !directory &&
      previousRouting &&
      currentRouting &&
      ((!this.pendingScope && areOpenCodeRoutesEqual(previousRouting, currentRouting)) ||
        (this.pendingScope === 'workspace' &&
          this.workspaceRoutingBaseline &&
          areOpenCodeRoutesEqual(this.workspaceRoutingBaseline, currentRouting)))
    ) {
      await this.cancelWorkspaceRefresh();
      if (this.disposed || generation !== this.refreshGeneration) return;
      this.dependencies.postRefresh();
      return;
    }
    if (!this.pendingScope && previousRouting) {
      this.workspaceRoutingBaseline = previousRouting;
    }
    if (directory) {
      if (previousRouting && !this.workspaceRoutingBaselines.has(directory)) {
        this.workspaceRoutingBaselines.set(directory, previousRouting);
      }
      this.pendingWorkspaceDirectories.add(directory);
    }
    await this.markRefreshPending('workspace');
    if (this.disposed || generation !== this.refreshGeneration) return;
    this.dependencies.postRefresh();
    await this.maybeInvalidate(generation, 0);
  }

  async acknowledgeEmbeddedAuthChange() {
    const generation = ++this.refreshGeneration;
    this.authIdleCandidate = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const signature = await this.readFilesSignature();
    if (this.disposed || generation !== this.refreshGeneration) return;
    if (!this.configChangePending) this.observedFilesSignature = signature;
    this.authChangePending = false;
    this.authRevalidationPending = true;
    this.dependencies.clearProviderLimitCache();
    this.dependencies.postRefresh();
    if (this.configChangePending) {
      await this.refreshState(++this.refreshGeneration, true);
      return;
    }
    this.pendingAuthOnlyInvalidation = this.pendingScope ? this.pendingAuthOnlyInvalidation : true;
    await this.markRefreshPending('global');
    if (this.disposed || generation !== this.refreshGeneration) return;
    this.postStatus();
    await this.maybeInvalidate(generation, 0);
  }

  async refreshState(generation = ++this.refreshGeneration, requireSignatureChange = false) {
    if (this.disposed || generation !== this.refreshGeneration) return;
    const signature = await this.readFilesSignature();
    if (this.disposed || generation !== this.refreshGeneration) return;
    if (requireSignatureChange && this.observedFilesSignature === null) {
      this.observedFilesSignature = signature;
      this.updatePendingInvalidationSource(requireSignatureChange);
      this.authRevalidationPending ||= this.authChangePending;
      this.authChangePending = false;
      this.configChangePending = false;
      this.dependencies.clearProviderLimitCache();
      await this.markRefreshPending('global');
      this.dependencies.postRefresh();
      await this.maybeInvalidate(generation, 0);
      return;
    }
    if (requireSignatureChange && signature === this.observedFilesSignature) {
      this.authChangePending = false;
      if (this.pendingScope) {
        await this.maybeInvalidate(generation, 0);
      }
      return;
    }
    this.dependencies.clearProviderLimitCache();
    this.observedFilesSignature = signature;
    this.updatePendingInvalidationSource(requireSignatureChange);
    this.authRevalidationPending ||= this.authChangePending;
    this.authChangePending = false;
    this.configChangePending = false;
    await this.markRefreshPending('global');
    this.dependencies.postRefresh();
    await this.maybeInvalidate(generation, 0);
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
    if (authChanged) this.authChangePending = true;
    else this.configChangePending = true;
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
      await this.maybeInvalidate(generation, 0);
    }
  }

  private async maybeInvalidate(generation: number, retryCount: number) {
    const pendingScope = this.pendingScope;
    if (
      this.disposed ||
      generation !== this.refreshGeneration ||
      !pendingScope ||
      this.invalidationInFlight
    ) {
      return;
    }
    if (this.dependencies.server.status.state === 'starting') {
      this.authIdleCandidate = null;
      this.scheduleInvalidationRetry(generation, retryCount, false);
      return;
    }
    if (this.dependencies.server.status.state !== 'running') {
      this.authIdleCandidate = null;
      return;
    }

    const idleDirectories =
      pendingScope === 'workspace'
        ? [...this.pendingWorkspaceDirectories]
        : [...new Set(this.dependencies.getWorkspaceDirectories().filter(Boolean))];
    const idleResults = await Promise.all(
      idleDirectories.length > 0
        ? idleDirectories.map((directory) => this.isServerIdle(directory))
        : [this.isServerIdle()]
    );
    const idle = idleResults.includes(false) ? false : idleResults.includes(null) ? null : true;
    if (this.disposed || generation !== this.refreshGeneration) return;
    if (idle === false) {
      this.authIdleCandidate = null;
      this.postPendingStatus();
      this.scheduleInvalidationRetry(generation, retryCount, false);
      return;
    }
    if (idle === null) {
      this.authIdleCandidate = null;
      this.scheduleInvalidationRetry(generation, retryCount);
      return;
    }
    if (this.authRevalidationPending && this.authWatcher) {
      const now = Date.now();
      if (
        this.authIdleCandidate?.generation !== generation ||
        now - this.authIdleCandidate.since < ProviderFileRefreshController.RETRY_MS
      ) {
        if (this.authIdleCandidate?.generation !== generation) {
          this.authIdleCandidate = { generation, since: now };
        }
        this.postPendingStatus();
        this.scheduleInvalidationRetry(generation, retryCount, false);
        return;
      }
    }
    this.authIdleCandidate = null;

    const pendingRevision = this.pendingRevision;
    this.invalidationInFlight = true;
    try {
      if (pendingScope === 'workspace') {
        const directories = [...this.pendingWorkspaceDirectories];
        if (directories.length === 0) {
          await this.dependencies.server.request('POST', '/instance/dispose');
        } else {
          await Promise.all(
            directories.map((directory) =>
              this.dependencies.server.request('POST', '/instance/dispose', undefined, {
                directory,
              })
            )
          );
        }
      } else {
        const managedState = this.authRevalidationPending
          ? await this.readManagedServerState()
          : false;
        if (this.disposed || generation !== this.refreshGeneration) return;
        if (managedState === true) {
          await this.dependencies.server.restart();
        } else {
          try {
            await this.dependencies.server.request('POST', '/global/dispose');
          } catch (disposeError) {
            const fallbackManagedState = await this.readManagedServerState();
            if (this.disposed || generation !== this.refreshGeneration) return;
            if (fallbackManagedState !== true) throw disposeError;
            logger.warn(
              `Provider global dispose failed; restarting managed server: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`
            );
            await this.dependencies.server.restart();
          }
        }
        this.unmanagedServerSynchronized = true;
      }
      if (pendingRevision === this.pendingRevision) {
        this.pendingScope = null;
        this.pendingWorkspaceDirectories.clear();
        this.workspaceRoutingBaselines.clear();
        this.pendingAuthOnlyInvalidation = false;
        await this.clearPersistedPendingState();
        if (!this.disposed && this.pendingStatusPosted) {
          this.pendingStatusPosted = false;
          this.dependencies.postPendingStatus(false);
        }
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
      this.scheduleInvalidationRetry(generation, retryCount);
    } finally {
      this.invalidationInFlight = false;
      if (
        !this.disposed &&
        this.pendingScope &&
        !this.refreshTimer &&
        generation !== this.refreshGeneration
      ) {
        void this.maybeInvalidate(this.refreshGeneration, 0);
      }
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

  private updatePendingInvalidationSource(requireSignatureChange: boolean) {
    const authOnly = requireSignatureChange && this.authChangePending && !this.configChangePending;
    this.pendingAuthOnlyInvalidation = this.pendingScope
      ? this.pendingAuthOnlyInvalidation && authOnly
      : authOnly;
  }

  private async isServerIdle(directory?: string): Promise<boolean | null> {
    try {
      const request = (path: string) =>
        directory
          ? this.dependencies.server.request('GET', path, undefined, { directory })
          : this.dependencies.server.request('GET', path);
      const [statuses, questions, permissions] = await Promise.all([
        request('/session/status'),
        request('/question'),
        request('/permission'),
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

  private scheduleInvalidationRetry(generation: number, retryCount: number, bounded = true) {
    if (
      this.disposed ||
      generation !== this.refreshGeneration ||
      !this.pendingScope ||
      (this.configWatchers.length === 0 && !this.authWatcher)
    ) {
      return;
    }
    if (bounded && retryCount >= ProviderFileRefreshController.MAX_RETRIES) {
      logger.info('Provider refresh invalidation remained deferred after bounded retries');
      return;
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.maybeInvalidate(generation, bounded ? retryCount + 1 : 0);
    }, ProviderFileRefreshController.RETRY_MS);
  }

  private postPendingStatus() {
    if (this.pendingStatusPosted) return;
    this.pendingStatusPosted = true;
    this.dependencies.postPendingStatus(true);
  }

  private async markRefreshPending(scope: PendingRefreshScope) {
    this.pendingRevision += 1;
    if (!this.pendingScope || scope === 'global') {
      this.pendingScope = scope;
    }
    if (scope === 'global') {
      this.workspaceRoutingBaseline = null;
      this.workspaceRoutingBaselines.clear();
    }
    try {
      const common = {
        scope: this.pendingScope,
        revalidateAuth: this.authRevalidationPending,
        source: this.pendingAuthOnlyInvalidation ? ('auth' as const) : ('config' as const),
      };
      await this.dependencies.persistence.set(
        ProviderFileRefreshController.PENDING_STATE_KEY,
        this.pendingWorkspaceDirectories.size > 0
          ? {
              version: 4,
              ...common,
              workspaceDirectories: [...this.pendingWorkspaceDirectories],
            }
          : { version: 3, ...common }
      );
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

  private async cancelWorkspaceRefresh() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const wasPending = this.pendingScope === 'workspace';
    if (wasPending) {
      this.pendingScope = null;
      this.pendingWorkspaceDirectories.clear();
      this.workspaceRoutingBaselines.clear();
      await this.clearPersistedPendingState();
    }
    this.workspaceRoutingBaseline = null;
    if (wasPending && this.pendingStatusPosted) {
      this.pendingStatusPosted = false;
      this.dependencies.postPendingStatus(false);
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

function areOpenCodeRoutesEqual(left: OpenCodeModelRouting, right: OpenCodeModelRouting) {
  if (!areModelRoutesEqual(left.smallModel, right.smallModel)) return false;
  const agentNames = new Set([...Object.keys(left.agentModels), ...Object.keys(right.agentModels)]);
  for (const name of agentNames) {
    if (!areModelRoutesEqual(left.agentModels[name] || null, right.agentModels[name] || null)) {
      return false;
    }
  }
  return true;
}

function areModelRoutesEqual(left: OpenCodeModelRoute | null, right: OpenCodeModelRoute | null) {
  return left?.providerID === right?.providerID && left?.modelID === right?.modelID;
}

function isPersistedPendingState(value: unknown): value is PersistedPendingRefreshState {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.version === 1) return typeof record.revalidateAuth === 'boolean';
  if (
    record.version === 2 &&
    (record.scope === 'workspace' || record.scope === 'global') &&
    typeof record.revalidateAuth === 'boolean'
  ) {
    return true;
  }
  return (
    (record.version === 3 || record.version === 4) &&
    (record.scope === 'workspace' || record.scope === 'global') &&
    typeof record.revalidateAuth === 'boolean' &&
    (record.source === 'auth' || record.source === 'config') &&
    (record.version !== 4 ||
      (Array.isArray(record.workspaceDirectories) &&
        record.workspaceDirectories.every((directory) => typeof directory === 'string')))
  );
}
