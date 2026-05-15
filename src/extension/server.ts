import type { ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { join } from 'path';
import * as vscode from 'vscode';
import type { ServerStatus } from '../shared/protocol';
import { OpenCodeProcess, type OpenCodeCompactionSettings } from './open-code-process';
import { OpenCodeTransport } from './open-code-transport';
import { logger } from './logger';
import { ServerLifecycleStateMachine } from './server-lifecycle';
import { isPortInUseMessage, normalizeRunningStatus } from './server-utils';
import { getServerPathEntries } from './util/server-path';

export type { OpenCodeCompactionSettings };

function isSuccessfulUpgradeResult(value: unknown): value is { success: true; version: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { success?: unknown }).success === true &&
    typeof (value as { version?: unknown }).version === 'string'
  );
}

function getUpgradeErrorMessage(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const error = (value as { error?: unknown }).error;
  return typeof error === 'string' ? error : '';
}

export class OpenCodeServer extends EventEmitter {
  private static readonly START_DISPOSED_MESSAGE = 'Server start was cancelled';

  private readonly lifecycle = new ServerLifecycleStateMachine();
  private readonly processManager: OpenCodeProcess;
  private readonly transport: OpenCodeTransport;
  private _status: ServerStatus = { state: 'stopped' };
  private pollHealthTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    port: number,
    autoStart: boolean,
    command?: string,
    simulateMissingCli = false,
    compactionSettings?: Partial<OpenCodeCompactionSettings>
  ) {
    super();
    this.processManager = new OpenCodeProcess(
      port,
      autoStart,
      command,
      simulateMissingCli,
      compactionSettings
    );
    this.transport = new OpenCodeTransport({
      getUrl: () => this.url,
      getWorkspaceCwd: () => this.getWorkspaceCwd(),
      getStatus: () => this._status,
      isDisposing: () => this.isDisposing,
      updateEventStreamState: (eventStream) => this.updateEventStreamState(eventStream),
      emitEvent: (event) => this.emit('event', event),
    });
  }

  get status(): ServerStatus {
    return this._status;
  }

  get url(): string {
    return this.processManager.url;
  }

  private get startAttemptId(): number {
    return this.lifecycle.startAttemptId;
  }

  private set startAttemptId(value: number) {
    this.lifecycle.startAttemptId = value;
  }

  private get disposeGeneration(): number {
    return this.lifecycle.disposeGeneration;
  }

  private set disposeGeneration(value: number) {
    this.lifecycle.disposeGeneration = value;
  }

  private get isDisposing(): boolean {
    return this.lifecycle.isDisposing;
  }

  private get process(): ChildProcess | null {
    return this.processManager.process;
  }

  private set process(value: ChildProcess | null) {
    this.processManager.process = value;
  }

  private get restartTimer(): ReturnType<typeof setTimeout> | null {
    return this.processManager.restartTimer;
  }

  private set restartTimer(value: ReturnType<typeof setTimeout> | null) {
    this.processManager.restartTimer = value;
  }

  private get managedProcess(): boolean {
    return this.processManager.managedProcess;
  }

  private set managedProcess(value: boolean) {
    this.processManager.managedProcess = value;
  }

  private get processStdoutHandler(): ((data: Buffer) => void) | null {
    return this.processManager.processStdoutHandler;
  }

  private set processStdoutHandler(value: ((data: Buffer) => void) | null) {
    this.processManager.processStdoutHandler = value;
  }

  private get processStderrHandler(): ((data: Buffer) => void) | null {
    return this.processManager.processStderrHandler;
  }

  private set processStderrHandler(value: ((data: Buffer) => void) | null) {
    this.processManager.processStderrHandler = value;
  }

  private get processExitHandler():
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | null {
    return this.processManager.processExitHandler;
  }

  private set processExitHandler(
    value: ((code: number | null, signal: NodeJS.Signals | null) => void) | null
  ) {
    this.processManager.processExitHandler = value;
  }

  private get processErrorHandler(): ((err: Error) => void) | null {
    return this.processManager.processErrorHandler;
  }

  private set processErrorHandler(value: ((err: Error) => void) | null) {
    this.processManager.processErrorHandler = value;
  }

  private setStatus(s: ServerStatus) {
    const previousStatus = this._status;
    const nextStatus = normalizeRunningStatus(s, this._status);
    this._status = nextStatus;
    if (nextStatus.state === 'running') {
      this.startMaintenanceLoop();
    } else if (previousStatus.state === 'running') {
      this.stopMaintenanceLoop();
    }
    this.emit('status', nextStatus);
  }

  private setRunningStatus(url = this.url, eventStream?: 'healthy' | 'degraded') {
    this.setStatus({ state: 'running', url, ...(eventStream ? { eventStream } : {}) });
  }

  private updateEventStreamState(eventStream: 'healthy' | 'degraded') {
    if (this._status.state !== 'running') return;
    if (this._status.eventStream === eventStream) return;
    this.setRunningStatus(this._status.url, eventStream);
  }

  private setStartPromise(factory: () => Promise<string>): Promise<string> {
    return this.lifecycle.setStartPromise(factory);
  }

  private clearStartPromise() {
    this.lifecycle.clearStartPromise();
  }

  async start(): Promise<string> {
    return this.setStartPromise(async () => {
      this.clearRestartTimer();
      const disposeGeneration = this.lifecycle.beginStart();
      if (this.processManager.isSimulatingMissingCli) {
        this.stopEventStream();
        this.cancelPollHealth();
        this.setStatus({ state: 'error', message: OpenCodeProcess.MISSING_CLI_MESSAGE });
        throw new Error(OpenCodeProcess.MISSING_CLI_MESSAGE);
      }

      await this.syncInjectedConfigFile();

      const healthy = await this.checkHealth();
      this.throwIfStartCancelled(disposeGeneration);
      if (healthy) {
        logger.info(`Found existing OpenCode server at ${this.url}`);
        this.processManager.prepareForHealthyExistingServer();
        if (this.hasInjectedCompactionOverride()) {
          logger.warn(
            'Varro chat auto-compaction settings require a Varro-managed OpenCode server; project opencode.json still overrides when present'
          );
        }
        this.setRunningStatus(this.url, 'healthy');
        this.startEventStream();
        this.requestMaintenanceCheck();
        return this.url;
      }

      if (!this.processManager.isAutoStartEnabled) {
        this.setStatus({
          state: 'error',
          message: `No server at ${this.url}. Start one with "opencode serve --port ${this.processManager.port}" or enable varro.server.autoStart.`,
        });
        throw new Error(
          this._status.state === 'error'
            ? (this._status as { message: string }).message
            : 'server not running'
        );
      }

      return new Promise((resolve, reject) => {
        this.setStatus({ state: 'starting' });
        const attemptId = this.lifecycle.beginStartAttempt();
        const stderrLines: string[] = [];
        let settled = false;

        const isStaleAttempt = () =>
          settled || !this.lifecycle.isCurrentStartAttempt(attemptId, disposeGeneration);

        const rememberStderr = (text: string) => {
          for (const line of text
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean)) {
            stderrLines.push(line);
          }
          if (stderrLines.length > 8) {
            stderrLines.splice(0, stderrLines.length - 8);
          }
        };

        const describeStartupFailure = (fallback: string) => {
          const recent = stderrLines[stderrLines.length - 1];
          return recent ? `${fallback}: ${recent}` : fallback;
        };

        const failStartup = (message: string, err?: Error) => {
          if (isStaleAttempt()) return;
          settled = true;
          this.cancelPollHealth();
          this.setStatus({ state: 'error', message });
          reject(err || new Error(message));
        };

        const finishStartup = (url: string) => {
          if (isStaleAttempt()) return;
          settled = true;
          this.cancelPollHealth();
          resolve(url);
        };

        const recoverOrFailStartup = async (fallback: string) => {
          if (isStaleAttempt()) return;
          const healthyNow = await this.checkHealth();
          if (isStaleAttempt()) return;
          if (healthyNow) {
            this.setRunningStatus(this.url, 'healthy');
            this.processManager.resetRetryCount();
            this.startEventStream();
            finishStartup(this.url);
            return;
          }

          if (this.processManager.hasPortInUseDetected() && this.tryAdvancePort()) {
            logger.warn(
              `Port ${this.processManager.port - 1} in use by another process; retrying on ${this.processManager.port}`
            );
            this.processManager.setPortInUseDetected(false);
            this.clearStartPromise();
            this.restartTimer = setTimeout(() => {
              this.restartTimer = null;
              if (isStaleAttempt()) return;
              this.start().then(resolve).catch(reject);
            }, 100);
            return;
          }

          if (this.processManager.getRetryCount() < this.processManager.getMaxRetries()) {
            const retryAttempt = this.processManager.incrementRetryCount();
            const delay = this.getRestartDelay(retryAttempt);
            logger.warn(`Retrying server startup in ${delay}ms (attempt ${retryAttempt})`);
            this.clearStartPromise();
            this.restartTimer = setTimeout(() => {
              this.restartTimer = null;
              if (isStaleAttempt()) return;
              this.start().then(resolve).catch(reject);
            }, delay);
            return;
          }

          failStartup(describeStartupFailure(fallback));
        };

        try {
          this.processManager.launchServer({
            getWorkspaceCwd: () => this.getWorkspaceCwd(),
            onStdout: (data) => {
              logger.info(`[server] ${data.toString().trim()}`);
            },
            onStderr: (data) => {
              const text = data.toString().trim();
              rememberStderr(text);
              if (isPortInUseMessage(text)) {
                this.processManager.setPortInUseDetected(true);
              }
              logger.error(`[server] ${text}`);
            },
            onExit: (code, signal) => {
              this.detachProcessListeners(this.process);
              logger.info(`Server process exited with code ${code}`);
              this.process = null;
              this.managedProcess = false;
              this.stopEventStream();
              if (this.isDisposing) {
                return;
              }
              if (isStaleAttempt()) return;
              if (this._status.state === 'running') {
                this.setStatus({ state: 'stopped' });
                if (this.processManager.getRetryCount() < this.processManager.getMaxRetries()) {
                  const retryAttempt = this.processManager.incrementRetryCount();
                  const delay = this.getRestartDelay(retryAttempt);
                  logger.info(`Restarting server in ${delay}ms (attempt ${retryAttempt})`);
                  this.clearStartPromise();
                  this.restartTimer = setTimeout(() => {
                    this.restartTimer = null;
                    if (isStaleAttempt()) return;
                    this.start().then(resolve).catch(reject);
                  }, delay);
                  return;
                }
                const runtimeFailure = `OpenCode server stopped unexpectedly${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}. Restart attempts (${this.processManager.getMaxRetries()}) were exhausted.`;
                this.setStatus({ state: 'error', message: runtimeFailure });
                return;
              }

              void recoverOrFailStartup(
                `OpenCode server exited during startup${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}`
              );
            },
            onError: (err) => {
              this.detachProcessListeners(this.process);
              logger.error(`Server process error: ${err.message}`);
              if (err.message.includes('ENOENT')) {
                failStartup(OpenCodeProcess.MISSING_CLI_MESSAGE);
                return;
              }

              void recoverOrFailStartup(`OpenCode server failed to spawn: ${err.message}`);
            },
          });
        } catch (err) {
          failStartup(String(err), err instanceof Error ? err : new Error(String(err)));
          return;
        }

        this.pollHealth(
          attemptId,
          disposeGeneration,
          (url) => {
            this.processManager.resetRetryCount();
            finishStartup(url);
          },
          (err) => {
            failStartup(describeStartupFailure(err.message), err);
          }
        );
      });
    });
  }

  private cancelPollHealth() {
    if (this.pollHealthTimer) {
      clearTimeout(this.pollHealthTimer);
      this.pollHealthTimer = null;
    }
  }

  private pollHealth(
    startAttemptId: number,
    disposeGeneration: number,
    resolve: (url: string) => void,
    reject: (err: Error) => void,
    attempt = 0
  ) {
    if (attempt > 50) {
      this.cancelPollHealth();
      this.setStatus({ state: 'error', message: 'Server failed to start within timeout' });
      reject(new Error('Server health check timeout'));
      return;
    }

    this.pollHealthTimer = setTimeout(async () => {
      this.pollHealthTimer = null;
      if (startAttemptId !== this.startAttemptId || disposeGeneration !== this.disposeGeneration) {
        return;
      }
      const healthy = await this.checkHealth();
      if (startAttemptId !== this.startAttemptId || disposeGeneration !== this.disposeGeneration) {
        return;
      }
      if (healthy) {
        this.cancelPollHealth();
        this.setRunningStatus(this.url, 'healthy');
        this.processManager.resetRetryCount();
        this.processManager.resetPortRetryState();
        this.startEventStream();
        resolve(this.url);
      } else {
        this.pollHealth(startAttemptId, disposeGeneration, resolve, reject, attempt + 1);
      }
    }, 200);
  }

  private async checkHealth(): Promise<boolean> {
    const data = await this.readHealthInfo();
    return data.healthy === true;
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.transport.request(method, path, body);
  }

  private async startEventStream() {
    await this.transport.startEventStream();
  }

  private stopEventStream() {
    this.transport.stopEventStream();
  }

  private clearRestartTimer() {
    this.processManager.clearRestartTimer();
  }

  private detachProcessListeners(proc: ChildProcess | null) {
    this.processManager.detachProcessListeners(proc);
  }

  private startMaintenanceLoop() {
    this.processManager.startMaintenanceLoop(() => {
      void this.runMaintenanceTick();
    });
  }

  private stopMaintenanceLoop() {
    this.processManager.stopMaintenanceLoop();
  }

  private requestMaintenanceCheck() {
    this.processManager.requestMaintenanceCheck(() => {
      void this.runMaintenanceTick();
    });
  }

  private async runMaintenanceTick() {
    await this.processManager.runMaintenanceTick({
      isDisposing: () => this.isDisposing,
      getStatus: () => this._status,
      readInstalledCliVersion: () => this.readInstalledCliVersion(),
      maybeSuggestCliUpdate: (installedCliVersion) =>
        this.maybeSuggestCliUpdate(installedCliVersion),
      readHealthInfo: () => this.readHealthInfo(),
      hasActiveSessions: () => this.hasActiveSessions(),
      restartManagedServer: (serverVersion, installedCliVersion) =>
        this.restartManagedServer(serverVersion, installedCliVersion),
    });
  }

  private async restartManagedServer(serverVersion: string, installedCliVersion: string) {
    await this.processManager.restartManagedServer(serverVersion, installedCliVersion, {
      beginManagedRestart: () => this.lifecycle.beginManagedRestart(),
      finishManagedRestart: () => this.lifecycle.finishManagedRestart(),
      stopManagedProcessForRestart: () => this.stopManagedProcessForRestart(),
      start: () => this.start(),
    });
  }

  private async stopManagedProcessForRestart() {
    this.clearRestartTimer();
    this.cancelPollHealth();
    this.stopEventStream();
    this.transport.abortRequests();
    await this.processManager.stopManagedProcessForRestart();
  }

  private async hasActiveSessions(): Promise<boolean> {
    const [statuses, questions] = await Promise.allSettled([
      this.request('GET', '/session/status'),
      this.request('GET', '/question'),
    ]);

    if (statuses.status === 'rejected') {
      throw statuses.reason;
    }

    const sessionStatuses =
      statuses.value && typeof statuses.value === 'object'
        ? (statuses.value as Record<string, unknown>)
        : {};
    for (const value of Object.values(sessionStatuses)) {
      const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
      const type = typeof entry?.type === 'string' ? entry.type : undefined;
      if (type === 'busy' || type === 'retry') {
        return true;
      }
    }

    if (
      questions.status === 'fulfilled' &&
      Array.isArray(questions.value) &&
      questions.value.length > 0
    ) {
      return true;
    }

    return this.transport.hasPendingAttentionRequests();
  }

  private async maybeSuggestCliUpdate(installedCliVersion: string | null) {
    await this.processManager.maybeSuggestCliUpdate(installedCliVersion, {
      readLatestCliVersion: () => this.readLatestCliVersion(),
      upgradeRunningServer: (targetVersion) => this.upgradeRunningServer(targetVersion),
      getWorkspaceCwd: () => this.getWorkspaceCwd(),
      prepareForWindowsCliUpgrade: () => this.prepareForWindowsCliUpgrade(),
    });
  }

  private async upgradeRunningServer(targetVersion: string) {
    if (this._status.state !== 'running') return false;
    try {
      const result = await this.request('POST', '/global/upgrade', { target: targetVersion });
      if (isSuccessfulUpgradeResult(result)) {
        logger.info(`Requested OpenCode upgrade to ${result.version} through the running server`);
        return true;
      }
      logger.warn(
        `OpenCode server upgrade failed: ${getUpgradeErrorMessage(result) || 'unknown error'}`
      );
      return false;
    } catch (err) {
      logger.warn(
        `OpenCode server upgrade unavailable, falling back to CLI upgrade: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  private async prepareForWindowsCliUpgrade() {
    if (process.platform !== 'win32') return;
    if (!this.process || !this.managedProcess) return;

    await this.stopManagedProcessForRestart();
    this.setStatus({ state: 'stopped' });
  }

  private async readInstalledCliVersion(): Promise<string | null> {
    return this.processManager.readInstalledCliVersion();
  }

  private async readLatestCliVersion(): Promise<string | null> {
    return this.processManager.readLatestCliVersion();
  }

  private async readHealthInfo(): Promise<{ healthy: boolean; version?: string }> {
    return this.transport.readHealthInfo();
  }

  async dispose() {
    await this.disposeResources({ stopProcess: true });
  }

  async disconnect() {
    await this.disposeResources({ stopProcess: false });
  }

  async updateCompactionSettings(value?: Partial<OpenCodeCompactionSettings>) {
    await this.processManager.updateCompactionSettings(value, {
      status: this._status,
      request: (method, path, body) =>
        body === undefined ? this.request(method, path) : this.request(method, path, body),
      restartManagedServerForCompactionSettings: () =>
        this.restartManagedServerForCompactionSettings(),
    });
  }

  async restart(): Promise<string> {
    if (this.lifecycle.beginManagedRestart() === null) return this.start();
    try {
      this.clearRestartTimer();
      this.stopMaintenanceLoop();
      this.cancelPollHealth();
      this.stopEventStream();
      this.transport.clearPendingAttentionRequests();
      this.transport.abortRequests();
      await this.processManager.stopServerForRestart();
      this.setStatus({ state: 'stopped' });
      return await this.start();
    } finally {
      this.lifecycle.finishManagedRestart();
    }
  }

  private async disposeResources(options: { stopProcess: boolean }) {
    this.lifecycle.beginDispose();
    this.clearRestartTimer();
    this.stopMaintenanceLoop();
    this.cancelPollHealth();
    this.stopEventStream();
    this.transport.clearPendingAttentionRequests();
    this.transport.abortRequests();
    await this.processManager.disposeProcess(options);
    this.setStatus({ state: 'stopped' });
  }

  getWorkspaceCwd(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    if (activeFolder) {
      return activeFolder.uri.fsPath;
    }

    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  resolveCommand(): string {
    const configuredCommand = (
      this.processManager as unknown as { command?: string }
    ).command?.trim();
    if (configuredCommand) return configuredCommand;

    const cacheKey = this.getResolvedCommandCacheKey();
    if (this.resolvedCommandCache?.key === cacheKey) {
      return this.resolvedCommandCache.value;
    }

    const candidates =
      process.platform === 'win32'
        ? ['opencode.exe', 'opencode.cmd', 'opencode.bat']
        : ['opencode'];

    for (const dir of this.serverPathEntries()) {
      for (const candidate of candidates) {
        const fullPath = join(dir, candidate);
        if (existsSync(fullPath)) {
          this.resolvedCommandCache = { key: cacheKey, value: fullPath };
          return fullPath;
        }
      }
    }

    const fallback = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
    this.resolvedCommandCache = { key: cacheKey, value: fallback };
    return fallback;
  }

  private async syncInjectedConfigFile() {
    await this.processManager.syncInjectedConfigFile();
  }

  private serializeInjectedConfig() {
    return this.processManager.serializeInjectedConfig();
  }

  private async restartManagedServerForCompactionSettings() {
    await this.processManager.restartManagedServerForCompactionSettings({
      beginManagedRestart: () => this.lifecycle.beginManagedRestart(),
      finishManagedRestart: () => this.lifecycle.finishManagedRestart(),
      stopManagedProcessForRestart: () => this.stopManagedProcessForRestart(),
      start: () => this.start(),
    });
  }

  private hasInjectedCompactionOverride() {
    return this.processManager.hasInjectedCompactionOverride();
  }

  private serverPathEntries(): string[] {
    return getServerPathEntries();
  }

  private resolvedCommandCache: {
    key: string;
    value: string;
  } | null = null;

  private getResolvedCommandCacheKey() {
    return JSON.stringify({
      platform: process.platform,
      pathEntries: this.serverPathEntries(),
      home: process.env.HOME || process.env.USERPROFILE || '',
      pnpmHome: process.env.PNPM_HOME || '',
      appData: process.env.APPDATA || '',
      localAppData: process.env.LOCALAPPDATA || '',
    });
  }

  private throwIfStartCancelled(disposeGeneration: number) {
    this.lifecycle.throwIfStartCancelled(disposeGeneration, OpenCodeServer.START_DISPOSED_MESSAGE);
  }

  private getRestartDelay(attempt: number) {
    return this.processManager.getRestartDelay(attempt);
  }

  private tryAdvancePort(): boolean {
    return this.processManager.tryAdvancePort();
  }
}
