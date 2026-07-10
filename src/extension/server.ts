import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
  MINIMUM_SUPPORTED_OPENCODE_VERSION,
  OPENCODE_UPDATE_REQUIRED_PREFIX,
} from '../shared/opencode-compatibility';
import type { ServerStatus } from '../shared/protocol';
import { OpenCodeProcess, type OpenCodeCompactionSettings } from './open-code-process';
import {
  OpenCodeTransport,
  type OpenCodeRequestOptions,
  type OpenCodeRescopeResult,
} from './open-code-transport';
import { logger } from './logger';
import { ServerLifecycleStateMachine } from './server-lifecycle';
import {
  compareVersions,
  extractVersion,
  isPortInUseMessage,
  normalizeRunningStatus,
} from './server-utils';

export type { OpenCodeCompactionSettings };

export interface OpenCodeServerInfo {
  status: ServerStatus;
  url: string;
  port: number;
  command: string;
  autoStart: boolean;
  managedProcess: boolean;
  processId: number | null;
  cliVersion: string | null;
  cliVersionError: string | null;
  health: { healthy: boolean; version?: string };
  workspaceCwd: string | undefined;
}

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

function isSupportedOpenCodeVersion(version: string | undefined): boolean {
  const normalized = typeof version === 'string' ? extractVersion(version) : null;
  return (
    normalized !== null && compareVersions(normalized, MINIMUM_SUPPORTED_OPENCODE_VERSION) >= 0
  );
}

function createUpdateRequiredMessage(observed: string, reason: string): string {
  return `${OPENCODE_UPDATE_REQUIRED_PREFIX} Varro requires OpenCode ${MINIMUM_SUPPORTED_OPENCODE_VERSION} or newer, but ${observed}. ${reason} Run "opencode upgrade", stop any running OpenCode server, then run "Varro: Restart Server".`;
}

export class OpenCodeServer extends EventEmitter {
  private static readonly START_DISPOSED_MESSAGE = 'Server start was cancelled';
  private static readonly MAX_RETRIES = 3;
  private static readonly MAX_RESTART_DELAY_MS = 30_000;
  private static readonly CRASH_STABILITY_WINDOW_MS = 30_000;

  private readonly lifecycle = new ServerLifecycleStateMachine();
  private readonly processManager: OpenCodeProcess;
  private readonly transport: OpenCodeTransport;
  private _status: ServerStatus = { state: 'stopped' };
  private pollHealthTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResetTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private restartReadyToStart = false;

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
      getWorkspaceCwd: () => this.processManager.getWorkspaceCwd(),
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

  private setStartPromise(factory: (signal: AbortSignal) => Promise<string>): Promise<string> {
    return this.lifecycle.setStartPromise(factory);
  }

  start(): Promise<string> {
    if (!this.restartReadyToStart) {
      const restartPromise = this.lifecycle.getRestartPromise<string>();
      if (restartPromise) return restartPromise;
    }
    return this.startOperation(false);
  }

  private startOperation(preserveRetryCount: boolean): Promise<string> {
    return this.setStartPromise(async (signal) => {
      this.clearRestartTimer();
      const disposeGeneration = this.lifecycle.beginStart();
      this.throwIfStartCancelled(disposeGeneration, signal);
      if (!preserveRetryCount) {
        this.clearRetryResetTimer();
        this.retryCount = 0;
      }
      if (this.processManager.isSimulatingMissingCli) {
        this.stopEventStream();
        this.cancelPollHealth();
        this.setStatus({ state: 'error', message: OpenCodeProcess.MISSING_CLI_MESSAGE });
        throw new Error(OpenCodeProcess.MISSING_CLI_MESSAGE);
      }

      this.throwIfStartCancelled(disposeGeneration, signal);
      const health = await this.readHealthInfo();
      this.throwIfStartCancelled(disposeGeneration, signal);
      if (health.healthy) {
        if (isSupportedOpenCodeVersion(health.version)) {
          logger.info(`Found existing OpenCode server at ${this.url}`);
          await this.processManager.prepareForHealthyExistingServer();
          this.throwIfStartCancelled(disposeGeneration, signal);
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

        await this.replaceIncompatibleServer(health.version, disposeGeneration, signal);
        this.throwIfStartCancelled(disposeGeneration, signal);
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

      this.throwIfStartCancelled(disposeGeneration, signal);
      await this.ensureCompatibleCliForLaunch(undefined, disposeGeneration, signal);
      this.throwIfStartCancelled(disposeGeneration, signal);

      return this.launchManagedServer(disposeGeneration, preserveRetryCount, signal);
    });
  }

  private async launchManagedServer(
    disposeGeneration: number,
    preserveRetryCount: boolean,
    signal: AbortSignal
  ): Promise<string> {
    this.throwIfStartCancelled(disposeGeneration, signal);
    await this.syncInjectedConfigFile();
    try {
      this.throwIfStartCancelled(disposeGeneration, signal);
    } catch (err) {
      await this.processManager.cleanupPreparedInjectedConfigFile();
      throw err;
    }
    return this.launchPreparedManagedServer(disposeGeneration, preserveRetryCount, signal);
  }

  private launchPreparedManagedServer(
    disposeGeneration: number,
    preserveRetryCount: boolean,
    signal: AbortSignal
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(this.getCancellationError(signal));
        return;
      }

      this.setStatus({ state: 'starting' });
      const attemptId = this.lifecycle.beginStartAttempt();
      const stderrLines: string[] = [];
      let attemptFinished = false;
      let operationSettled = false;
      let awaitedBoundaries = 0;

      const isInvalidAttempt = () =>
        signal.aborted || !this.lifecycle.isCurrentStartAttempt(attemptId, disposeGeneration);

      const cleanup = () => {
        signal.removeEventListener('abort', handleAbort);
      };

      const resolveOperation = (url: string) => {
        if (operationSettled) return;
        operationSettled = true;
        cleanup();
        resolve(url);
      };

      const rejectOperation = (err: Error) => {
        if (operationSettled) return;
        operationSettled = true;
        cleanup();
        reject(err);
      };

      const rejectCancelledAttempt = () => {
        attemptFinished = true;
        this.cancelPollHealth();
        this.clearRestartTimer();
        rejectOperation(this.getCancellationError(signal));
      };

      const handleAbort = () => {
        this.cancelPollHealth();
        this.clearRestartTimer();
        if (awaitedBoundaries === 0) {
          rejectCancelledAttempt();
        }
      };

      const awaitBoundary = async <T>(operation: Promise<T>): Promise<T> => {
        awaitedBoundaries += 1;
        try {
          const result = await operation;
          this.throwIfStartCancelled(disposeGeneration, signal);
          return result;
        } finally {
          awaitedBoundaries -= 1;
          if (signal.aborted && awaitedBoundaries === 0) {
            rejectCancelledAttempt();
          }
        }
      };

      signal.addEventListener('abort', handleAbort, { once: true });

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
        if (attemptFinished || operationSettled) return;
        if (isInvalidAttempt()) {
          rejectCancelledAttempt();
          return;
        }
        attemptFinished = true;
        this.cancelPollHealth();
        this.setStatus({ state: 'error', message });
        void this.processManager.cleanupPreparedInjectedConfigFile().finally(() => {
          rejectOperation(err || new Error(message));
        });
      };

      const finishStartup = (url: string) => {
        if (attemptFinished || operationSettled) return;
        if (isInvalidAttempt()) {
          rejectCancelledAttempt();
          return;
        }
        attemptFinished = true;
        this.cancelPollHealth();
        this.scheduleRetryBudgetReset(attemptId, disposeGeneration);
        resolveOperation(url);
      };

      const scheduleStartupRetry = (delay: number) => {
        if (attemptFinished || operationSettled) return;
        if (isInvalidAttempt()) {
          rejectCancelledAttempt();
          return;
        }
        attemptFinished = true;
        this.cancelPollHealth();
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (isInvalidAttempt()) {
            rejectCancelledAttempt();
            return;
          }
          cleanup();
          this.launchManagedServer(disposeGeneration, preserveRetryCount, signal)
            .then(resolveOperation)
            .catch((err: unknown) =>
              rejectOperation(err instanceof Error ? err : new Error(String(err)))
            );
        }, delay);
      };

      const recoverOrFailStartup = async (fallback: string) => {
        if (attemptFinished || operationSettled) return;
        if (isInvalidAttempt()) {
          rejectCancelledAttempt();
          return;
        }
        let healthNow: { healthy: boolean; version?: string };
        try {
          healthNow = await awaitBoundary(this.readHealthInfo());
        } catch (err) {
          if (isInvalidAttempt()) {
            rejectCancelledAttempt();
          } else {
            failStartup(fallback, err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }
        if (attemptFinished || operationSettled) return;
        if (isInvalidAttempt()) {
          rejectCancelledAttempt();
          return;
        }
        if (healthNow.healthy && !isSupportedOpenCodeVersion(healthNow.version)) {
          failStartup(
            createUpdateRequiredMessage(
              healthNow.version
                ? `the running server is ${healthNow.version}`
                : 'the running server version could not be determined',
              'The server that started is not compatible.'
            )
          );
          return;
        }
        if (healthNow.healthy) {
          this.setRunningStatus(this.url, 'healthy');
          this.processManager.resetPortRetryState();
          this.startEventStream();
          finishStartup(this.url);
          return;
        }

        if (this.processManager.hasPortInUseDetected() && this.tryAdvancePort()) {
          logger.warn(
            `Port ${this.processManager.port - 1} in use by another process; retrying on ${this.processManager.port}`
          );
          this.processManager.setPortInUseDetected(false);
          scheduleStartupRetry(100);
          return;
        }

        if (this.retryCount < OpenCodeServer.MAX_RETRIES) {
          const retryAttempt = ++this.retryCount;
          const delay = this.getRestartDelay(retryAttempt);
          logger.warn(`Retrying server startup in ${delay}ms (attempt ${retryAttempt})`);
          scheduleStartupRetry(delay);
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
          onExit: (code, exitSignal) => {
            this.detachProcessListeners(this.process);
            logger.info(`Server process exited with code ${code}`);
            this.process = null;
            this.managedProcess = false;
            this.stopEventStream();
            if (isInvalidAttempt()) return;
            if (this._status.state === 'running') {
              this.handleRuntimeProcessExit(code, exitSignal, attemptId, disposeGeneration);
              return;
            }

            this.cancelPollHealth();
            void recoverOrFailStartup(
              `OpenCode server exited during startup${exitSignal ? ` (${exitSignal})` : code !== null ? ` (code ${code})` : ''}`
            );
          },
          onError: (err) => {
            this.detachProcessListeners(this.process);
            logger.error(`Server process error: ${err.message}`);
            if (err.message.includes('ENOENT')) {
              failStartup(OpenCodeProcess.MISSING_CLI_MESSAGE);
              return;
            }

            this.cancelPollHealth();
            void recoverOrFailStartup(`OpenCode server failed to spawn: ${err.message}`);
          },
        });
      } catch (err) {
        void this.processManager.cleanupPreparedInjectedConfigFile().finally(() => {
          failStartup(String(err), err instanceof Error ? err : new Error(String(err)));
        });
        return;
      }

      this.pollHealth(
        attemptId,
        disposeGeneration,
        (url) => {
          finishStartup(url);
        },
        (err) => {
          failStartup(describeStartupFailure(err.message), err);
        },
        0,
        signal,
        () => awaitBoundary(this.readHealthInfo())
      );
    });
  }

  private cancelPollHealth() {
    if (this.pollHealthTimer) {
      clearTimeout(this.pollHealthTimer);
      this.pollHealthTimer = null;
    }
  }

  private handleRuntimeProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    startAttemptId: number,
    disposeGeneration: number
  ) {
    this.clearRetryResetTimer();
    this.setStatus({ state: 'stopped' });
    if (this.retryCount >= OpenCodeServer.MAX_RETRIES) {
      const runtimeFailure = `OpenCode server stopped unexpectedly${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}. Restart attempts (${OpenCodeServer.MAX_RETRIES}) were exhausted.`;
      this.setStatus({ state: 'error', message: runtimeFailure });
      return;
    }

    const retryAttempt = ++this.retryCount;
    const delay = this.getRestartDelay(retryAttempt);
    logger.info(`Restarting server in ${delay}ms (attempt ${retryAttempt})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.lifecycle.isCurrentStartAttempt(startAttemptId, disposeGeneration)) return;
      void this.startOperation(true).catch(() => {
        // Startup reports its own error status; this catch only owns the background promise.
      });
    }, delay);
  }

  private pollHealth(
    startAttemptId: number,
    disposeGeneration: number,
    resolve: (url: string) => void,
    reject: (err: Error) => void,
    attempt = 0,
    signal?: AbortSignal,
    readHealth: () => Promise<{ healthy: boolean; version?: string }> = () => this.readHealthInfo()
  ) {
    if (
      signal?.aborted ||
      !this.lifecycle.isCurrentStartAttempt(startAttemptId, disposeGeneration)
    ) {
      reject(this.getCancellationError(signal));
      return;
    }
    if (attempt > 50) {
      this.cancelPollHealth();
      this.setStatus({ state: 'error', message: 'Server failed to start within timeout' });
      reject(new Error('Server health check timeout'));
      return;
    }

    this.pollHealthTimer = setTimeout(async () => {
      this.pollHealthTimer = null;
      if (
        signal?.aborted ||
        !this.lifecycle.isCurrentStartAttempt(startAttemptId, disposeGeneration)
      ) {
        reject(this.getCancellationError(signal));
        return;
      }
      let health: { healthy: boolean; version?: string };
      try {
        health = await readHealth();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (
        signal?.aborted ||
        !this.lifecycle.isCurrentStartAttempt(startAttemptId, disposeGeneration)
      ) {
        reject(this.getCancellationError(signal));
        return;
      }
      if (health.healthy && !isSupportedOpenCodeVersion(health.version)) {
        this.cancelPollHealth();
        const message = createUpdateRequiredMessage(
          health.version
            ? `the running server is ${health.version}`
            : 'the running server version could not be determined',
          'The server that started is not compatible.'
        );
        this.setStatus({ state: 'error', message });
        reject(new Error(message));
      } else if (health.healthy) {
        this.cancelPollHealth();
        this.setRunningStatus(this.url, 'healthy');
        this.processManager.resetPortRetryState();
        this.startEventStream();
        resolve(this.url);
      } else {
        this.pollHealth(
          startAttemptId,
          disposeGeneration,
          resolve,
          reject,
          attempt + 1,
          signal,
          readHealth
        );
      }
    }, 200);
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    options?: OpenCodeRequestOptions
  ): Promise<unknown> {
    return this.transport.request(method, path, body, options);
  }

  async rescopeEventStream(directory?: string): Promise<OpenCodeRescopeResult> {
    if (this._status.state !== 'running') return { state: 'inactive', directory };
    return this.transport.rescopeEventStream(directory);
  }

  async readServerInfo(): Promise<OpenCodeServerInfo> {
    let cliVersion: string | null = null;
    let cliVersionError: string | null = null;

    try {
      cliVersion = await this.readInstalledCliVersion();
    } catch (err) {
      cliVersionError = err instanceof Error ? err.message : String(err);
    }

    return {
      status: this._status,
      url: this.url,
      port: this.processManager.port,
      command: this.resolveCommand(),
      autoStart: this.processManager.isAutoStartEnabled,
      managedProcess: this.managedProcess,
      processId: this.process?.pid ?? null,
      cliVersion,
      cliVersionError,
      health: await this.readHealthInfo(),
      workspaceCwd: this.getWorkspaceCwd(),
    };
  }

  private async startEventStream() {
    await this.transport.startEventStream();
  }

  private stopEventStream() {
    this.transport.stopEventStream();
  }

  private clearRestartTimer() {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private clearRetryResetTimer() {
    if (!this.retryResetTimer) return;
    clearTimeout(this.retryResetTimer);
    this.retryResetTimer = null;
  }

  private scheduleRetryBudgetReset(startAttemptId: number, disposeGeneration: number) {
    this.clearRetryResetTimer();
    this.retryResetTimer = setTimeout(() => {
      this.retryResetTimer = null;
      if (this._status.state !== 'running') return;
      if (!this.lifecycle.isCurrentStartAttempt(startAttemptId, disposeGeneration)) return;
      this.retryCount = 0;
    }, OpenCodeServer.CRASH_STABILITY_WINDOW_MS);
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
      restartServerForCliUpdate: (serverVersion, installedCliVersion) =>
        this.restartServerForCliUpdate(serverVersion, installedCliVersion),
    });
  }

  private async replaceIncompatibleServer(
    serverVersion: string | undefined,
    disposeGeneration: number,
    signal: AbortSignal
  ) {
    const observed = serverVersion
      ? `the running server is ${serverVersion}`
      : 'the running server version could not be determined';

    if (!this.processManager.isAutoUpdateEnabled) {
      this.failForRequiredUpdate(observed, 'Automatic updates are disabled.');
    }
    if (!this.processManager.isAutoStartEnabled) {
      this.failForRequiredUpdate(
        observed,
        'Varro server auto-start is disabled, so Varro cannot safely replace the running server.'
      );
    }

    let activeSessions: boolean;
    try {
      this.throwIfStartCancelled(disposeGeneration, signal);
      activeSessions = await this.hasActiveSessions();
      this.throwIfStartCancelled(disposeGeneration, signal);
    } catch (err) {
      this.throwIfStartCancelled(disposeGeneration, signal);
      this.failForRequiredUpdate(
        observed,
        `Varro could not verify that the old server is idle: ${err instanceof Error ? err.message : String(err)}.`
      );
    }
    if (activeSessions) {
      this.failForRequiredUpdate(
        observed,
        'The old server has active sessions and was not stopped to avoid interrupting work.'
      );
    }

    logger.info(
      `OpenCode server ${serverVersion || 'unknown'} is older than required ${MINIMUM_SUPPORTED_OPENCODE_VERSION}; attempting a safe update`
    );
    this.throwIfStartCancelled(disposeGeneration, signal);
    await this.upgradeRunningServer(MINIMUM_SUPPORTED_OPENCODE_VERSION);
    this.throwIfStartCancelled(disposeGeneration, signal);
    await this.stopServerForRestart();
    this.throwIfStartCancelled(disposeGeneration, signal);
    await this.ensureCompatibleCliForLaunch(observed, disposeGeneration, signal);
    this.throwIfStartCancelled(disposeGeneration, signal);
  }

  private async ensureCompatibleCliForLaunch(
    observedServer: string | undefined,
    disposeGeneration: number,
    signal: AbortSignal
  ) {
    let installedVersion: string | null;
    try {
      this.throwIfStartCancelled(disposeGeneration, signal);
      installedVersion = await this.readInstalledCliVersion();
      this.throwIfStartCancelled(disposeGeneration, signal);
    } catch (err) {
      this.throwIfStartCancelled(disposeGeneration, signal);
      logger.warn(
        `Could not verify the installed OpenCode CLI version before startup: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    if (!installedVersion || isSupportedOpenCodeVersion(installedVersion)) return;

    const observed = observedServer || `the installed CLI is ${installedVersion}`;
    if (!this.processManager.isAutoUpdateEnabled) {
      this.failForRequiredUpdate(observed, 'Automatic updates are disabled.');
    }

    logger.info(
      `Updating OpenCode CLI ${installedVersion} to meet Varro's minimum ${MINIMUM_SUPPORTED_OPENCODE_VERSION}`
    );
    try {
      this.throwIfStartCancelled(disposeGeneration, signal);
      await this.processManager.upgradeCli(MINIMUM_SUPPORTED_OPENCODE_VERSION);
      this.throwIfStartCancelled(disposeGeneration, signal);
    } catch (err) {
      this.throwIfStartCancelled(disposeGeneration, signal);
      this.failForRequiredUpdate(
        observed,
        `The automatic update failed: ${err instanceof Error ? err.message : String(err)}.`
      );
    }

    let updatedVersion: string | null;
    try {
      this.throwIfStartCancelled(disposeGeneration, signal);
      updatedVersion = await this.readInstalledCliVersion();
      this.throwIfStartCancelled(disposeGeneration, signal);
    } catch (err) {
      this.throwIfStartCancelled(disposeGeneration, signal);
      this.failForRequiredUpdate(
        observed,
        `The update finished, but Varro could not verify it: ${err instanceof Error ? err.message : String(err)}.`
      );
    }
    if (!updatedVersion || !isSupportedOpenCodeVersion(updatedVersion)) {
      this.failForRequiredUpdate(
        observed,
        `The automatic update did not install a compatible CLI${updatedVersion ? ` (found ${updatedVersion})` : ''}.`
      );
    }

    logger.info(`OpenCode CLI updated successfully to ${updatedVersion}`);
  }

  private failForRequiredUpdate(observed: string, reason: string): never {
    const message = createUpdateRequiredMessage(observed, reason);
    this.cancelPollHealth();
    this.stopEventStream();
    this.setStatus({ state: 'error', message });
    throw new Error(message);
  }

  private async restartServerForCliUpdate(serverVersion: string, installedCliVersion: string) {
    await this.runRestart(async () => {
      logger.info(
        `Restarting OpenCode server to use CLI ${installedCliVersion} instead of server ${serverVersion}`
      );
      await this.stopServerForRestart();
    });
  }

  private async stopManagedProcessForRestart() {
    this.clearRestartTimer();
    this.clearRetryResetTimer();
    this.cancelPollHealth();
    this.stopEventStream();
    this.transport.abortRequests();
    await this.processManager.stopManagedProcessForRestart();
  }

  private async stopServerForRestart() {
    this.clearRestartTimer();
    this.clearRetryResetTimer();
    this.cancelPollHealth();
    this.stopEventStream();
    this.transport.abortRequests();
    await this.processManager.stopServerForRestart();
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
    return this.processManager.maybeSuggestCliUpdate(installedCliVersion, {
      readLatestCliVersion: () => this.readLatestCliVersion(),
      upgradeRunningServer: (targetVersion) => this.upgradeRunningServer(targetVersion),
      getWorkspaceCwd: () => this.getWorkspaceCwd(),
      prepareForWindowsCliUpgrade: () => this.prepareForWindowsCliUpgrade(),
    });
  }

  private async upgradeRunningServer(targetVersion: string) {
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

  restart(): Promise<string> {
    return this.runRestart(async () => {
      this.clearRestartTimer();
      this.stopMaintenanceLoop();
      this.cancelPollHealth();
      this.stopEventStream();
      this.transport.clearPendingAttentionRequests();
      this.transport.abortRequests();
      await this.processManager.stopServerForRestart();
      this.setStatus({ state: 'stopped' });
    });
  }

  private runRestart(stop: () => Promise<void>): Promise<string> {
    this.clearRetryResetTimer();
    return this.lifecycle.setRestartPromise(async (signal) => {
      this.throwIfOperationCancelled(signal);
      await stop();
      this.throwIfOperationCancelled(signal);
      this.restartReadyToStart = true;
      try {
        const url = await this.start();
        this.throwIfOperationCancelled(signal);
        return url;
      } finally {
        this.restartReadyToStart = false;
      }
    }, OpenCodeServer.START_DISPOSED_MESSAGE);
  }

  private async disposeResources(options: { stopProcess: boolean }) {
    this.lifecycle.beginDispose(OpenCodeServer.START_DISPOSED_MESSAGE);
    this.clearRestartTimer();
    this.clearRetryResetTimer();
    this.stopMaintenanceLoop();
    this.cancelPollHealth();
    this.stopEventStream();
    this.transport.clearPendingAttentionRequests();
    this.transport.abortRequests();
    await this.lifecycle.waitForOperationsSettlement();
    await this.processManager.disposeProcess(options);
    this.setStatus({ state: 'stopped' });
  }

  getWorkspaceCwd(): string | undefined {
    return this._status.state === 'running'
      ? this.transport.getWorkspaceDirectory()
      : this.processManager.getWorkspaceCwd();
  }

  resolveCommand(): string {
    return this.processManager.resolveCommand();
  }

  private async syncInjectedConfigFile() {
    await this.processManager.syncInjectedConfigFile();
  }

  private serializeInjectedConfig() {
    return this.processManager.serializeInjectedConfig();
  }

  private async restartManagedServerForCompactionSettings() {
    await this.runRestart(async () => {
      logger.info('Restarting managed OpenCode server to apply updated Varro compaction settings');
      await this.stopManagedProcessForRestart();
    });
  }

  private hasInjectedCompactionOverride() {
    return this.processManager.hasInjectedCompactionOverride();
  }

  private throwIfStartCancelled(disposeGeneration: number, signal: AbortSignal) {
    this.throwIfOperationCancelled(signal);
    this.lifecycle.throwIfStartCancelled(disposeGeneration, OpenCodeServer.START_DISPOSED_MESSAGE);
  }

  private throwIfOperationCancelled(signal: AbortSignal) {
    if (!signal.aborted) return;
    throw this.getCancellationError(signal);
  }

  private getCancellationError(signal?: AbortSignal) {
    return signal?.reason instanceof Error
      ? signal.reason
      : new Error(OpenCodeServer.START_DISPOSED_MESSAGE);
  }

  private getRestartDelay(attempt: number) {
    return Math.min(1000 * 2 ** Math.max(0, attempt - 1), OpenCodeServer.MAX_RESTART_DELAY_MS);
  }

  private tryAdvancePort(): boolean {
    return this.processManager.tryAdvancePort();
  }
}
