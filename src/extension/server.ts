/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- Server, process, and extension API values are validated before state transitions. */
/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Server assertions follow lifecycle, process, and response validation. */
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import {
  MINIMUM_SUPPORTED_OPENCODE_VERSION,
  OPENCODE_UPDATE_REQUIRED_PREFIX,
} from '../shared/opencode-compatibility';
import {
  getUpgradeCommand,
  OPENCODE_UPGRADE_COMMAND,
  type OpenCodeInstallMethod,
} from '../shared/opencode-install';
import { readMaximumTestedOpenCodeVersion } from './extension-manifest';
import {
  parseServerEvent,
  type RestartBlockedState,
  type ServerErrorBlockedBy,
  type ServerErrorDetail,
  type ServerStatus,
} from '../shared/protocol';
import { normalizeWorkspaceIdentity } from '../shared/workspace-path';
import {
  OpenCodeProcess,
  type OpenCodeCompactionSettings,
  type OpenCodeServerOwnership,
  type UpgradeFailureReport,
} from './open-code-process';
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
  ownership: OpenCodeServerOwnership;
  processId: number | null;
  cliVersion: string | null;
  cliVersionError: string | null;
  installMethod: OpenCodeInstallMethod;
  resolvedCommand: string;
  searchedPaths: string[];
  activeAgentCount: number | null;
  activeAgentError: string | null;
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

function addActiveAgentIDs(value: unknown, activeAgentIDs: Set<string>) {
  if (!value || typeof value !== 'object') return;
  for (const [sessionID, status] of Object.entries(value as Record<string, unknown>)) {
    const entry = status && typeof status === 'object' ? (status as Record<string, unknown>) : null;
    const type = typeof entry?.type === 'string' ? entry.type : undefined;
    if (type === 'busy' || type === 'retry') activeAgentIDs.add(sessionID);
  }
}

function getSessionID(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const info =
    record.info && typeof record.info === 'object'
      ? (record.info as Record<string, unknown>)
      : null;
  const id = record.sessionID ?? record.sessionId ?? info?.sessionID ?? info?.sessionId;
  return typeof id === 'string' && id.trim() ? id : null;
}

export class RestartBlockedError extends Error {
  constructor(readonly blockers: RestartBlockedState) {
    super('OpenCode has active sessions; finish them before restarting the server');
    this.name = 'RestartBlockedError';
  }
}

function isSupportedOpenCodeVersion(version: string | undefined): boolean {
  const normalized = typeof version === 'string' ? extractVersion(version) : null;
  return (
    normalized !== null && compareVersions(normalized, MINIMUM_SUPPORTED_OPENCODE_VERSION) >= 0
  );
}

// Read once: the manifest cannot change while the extension host is alive.
const maximumTestedOpenCodeVersion = readMaximumTestedOpenCodeVersion();

/** True when `version` is at least one minor release beyond `baseline`. */
function isMinorVersionAhead(version: string, baseline: string): boolean {
  const [versionMajor = 0, versionMinor = 0] = version.split('.').map(Number);
  const [baselineMajor = 0, baselineMinor = 0] = baseline.split('.').map(Number);
  return versionMajor !== baselineMajor || versionMinor !== baselineMinor;
}

/**
 * Builds the message and the structured detail together so the two can never
 * disagree. The closing instruction is the important part: after an upgrade
 * has actually failed it must not recommend the command that just failed.
 */
function createUpdateRequiredError(options: {
  observed: string;
  reason: string;
  blockedBy?: ServerErrorBlockedBy;
  settingId?: string;
  installMethod?: OpenCodeInstallMethod;
  failure?: UpgradeFailureReport;
}): { message: string; detail: ServerErrorDetail } {
  const summary = `${OPENCODE_UPDATE_REQUIRED_PREFIX} Varro requires OpenCode ${MINIMUM_SUPPORTED_OPENCODE_VERSION} or newer, but ${options.observed}. ${options.reason}`;
  const installMethod = options.failure?.installMethod ?? options.installMethod;
  const suggestedCommand = installMethod
    ? getUpgradeCommand(installMethod, process.platform) || OPENCODE_UPGRADE_COMMAND
    : OPENCODE_UPGRADE_COMMAND;
  const canSuggestCommand =
    !options.blockedBy ||
    options.blockedBy === 'auto-update-disabled' ||
    options.blockedBy === 'auto-start-disabled';
  let instruction = `Run "${suggestedCommand}", stop any running OpenCode server, then restart the Varro server.`;
  if (options.failure) {
    instruction = options.failure.guidance;
  } else {
    switch (options.blockedBy) {
      case 'active-sessions':
        instruction = 'Finish or close those sessions, then check again.';
        break;
      case 'auto-update-disabled':
        instruction = 'Enable varro.server.autoUpdate, then restart the Varro server.';
        break;
      case 'auto-start-disabled':
        instruction = 'Enable varro.server.autoStart, then restart the Varro server.';
        break;
      case 'foreign-owner':
        instruction =
          'Finish work in the other Varro window and close it before retrying from this window.';
        break;
      case 'verify-failed':
        instruction = 'Check the Varro output, then retry when the OpenCode server is responding.';
        break;
    }
  }

  const detail: ServerErrorDetail = {
    kind: options.failure
      ? 'update-failed'
      : options.blockedBy
        ? 'update-blocked'
        : 'update-required',
    required: MINIMUM_SUPPORTED_OPENCODE_VERSION,
    observed: options.observed,
  };
  if (installMethod) detail.installMethod = installMethod;
  if (options.blockedBy) detail.blockedBy = options.blockedBy;
  if (options.settingId) detail.settingId = options.settingId;
  if (options.failure) {
    detail.cause = options.failure.cause;
    if (options.failure.suggestedCommand) {
      detail.suggestedCommand = options.failure.suggestedCommand;
    }
  } else if (canSuggestCommand) {
    detail.suggestedCommand = suggestedCommand;
  }
  return { message: `${summary} ${instruction}`, detail };
}

function describeManagedProcessCleanupFailure(context: string, err: unknown): string {
  return `${context}. Failed to stop the managed startup process: ${err instanceof Error ? err.message : String(err)}`;
}

export class OpenCodeServer extends EventEmitter {
  private static readonly START_DISPOSED_MESSAGE = 'Server start was cancelled';
  private static readonly MAX_RETRIES = 3;
  private static readonly MAX_RESTART_DELAY_MS = 30_000;
  private static readonly CRASH_STABILITY_WINDOW_MS = 30_000;
  private static readonly OWNERSHIP_CONFIRMATION_FAILED_MESSAGE =
    'Could not confirm ownership of the OpenCode server started by Varro';

  private readonly lifecycle = new ServerLifecycleStateMachine();
  private readonly processManager: OpenCodeProcess;
  private readonly transport: OpenCodeTransport;
  private _status: ServerStatus = { state: 'stopped' };
  private pollHealthTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResetTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private restartReadyToStart = false;
  private pendingTerminalCliUpgrades = 0;
  private lastCeilingNoticeVersion = '';
  private lastRestartBlockers: RestartBlockedState | null = null;
  private adoptedServerRecoveryOperation: Promise<void> | null = null;

  constructor(
    port: number,
    autoStart: boolean,
    command?: string,
    simulateMissingCli = false,
    compactionSettings?: Partial<OpenCodeCompactionSettings>,
    ownershipLeasePath?: string
  ) {
    super();
    this.processManager = new OpenCodeProcess(
      port,
      autoStart,
      command,
      simulateMissingCli,
      compactionSettings,
      ownershipLeasePath
    );
    this.transport = new OpenCodeTransport({
      getUrl: () => this.url,
      getWorkspaceCwd: () => this.processManager.getWorkspaceCwd(),
      getStatus: () => this._status,
      isDisposing: () => this.isDisposing,
      updateEventStreamState: (eventStream) => this.updateEventStreamState(eventStream),
      emitEvent: (event) => this.handleServerEvent(event),
    });
  }

  private handleServerEvent(event: unknown) {
    const parsed = parseServerEvent(event);
    this.emit('event', event);
    if (parsed?.type !== 'session.status') return;
    const status = (parsed.properties as { status?: unknown } | undefined)?.status;
    if (status && typeof status === 'object' && (status as { type?: unknown }).type === 'idle') {
      this.requestMaintenanceCheck();
    }
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
    const status: Extract<ServerStatus, { state: 'running' }> = { state: 'running', url };
    if (eventStream) status.eventStream = eventStream;
    this.setStatus(status);
  }

  private updateEventStreamState(eventStream: 'healthy' | 'degraded') {
    if (this._status.state !== 'running') return;
    if (eventStream === 'degraded') this.requestAdoptedServerRecovery();
    if (this._status.eventStream === eventStream) return;
    this.setRunningStatus(this._status.url, eventStream);
  }

  private requestAdoptedServerRecovery() {
    if (this.adoptedServerRecoveryOperation || !this.processManager.isAdoptedManagedServer) return;
    const startAttemptId = this.startAttemptId;
    const disposeGeneration = this.disposeGeneration;
    const operation = this.recoverDegradedAdoptedServer(startAttemptId, disposeGeneration);
    this.adoptedServerRecoveryOperation = operation;
    const finish = () => {
      if (this.adoptedServerRecoveryOperation === operation) {
        this.adoptedServerRecoveryOperation = null;
      }
    };
    void operation.then(finish, (err: unknown) => {
      logger.warn(
        `Failed to recover degraded adopted OpenCode server: ${err instanceof Error ? err.message : String(err)}`
      );
      finish();
    });
  }

  private async recoverDegradedAdoptedServer(startAttemptId: number, disposeGeneration: number) {
    const serverStillAlive = await this.processManager.revalidateAdoptedManagedServer();
    if (!this.lifecycle.isCurrentStartAttempt(startAttemptId, disposeGeneration)) return;
    if (this._status.state !== 'running') return;
    if (serverStillAlive) return;

    logger.warn('Adopted OpenCode server became unavailable; scheduling managed recovery');
    this.stopEventStream();
    this.handleRuntimeProcessExit(null, null, startAttemptId, disposeGeneration, Promise.resolve());
  }

  private async waitForAdoptedServerRecovery() {
    try {
      await this.adoptedServerRecoveryOperation;
    } catch {
      // Recovery reports its own failure and lifecycle operations can continue safely.
    }
  }

  private setStartPromise(factory: (signal: AbortSignal) => Promise<string>): Promise<string> {
    return this.lifecycle.setStartPromise(factory);
  }

  start(): Promise<string> {
    if (!this.restartReadyToStart && this.pendingTerminalCliUpgrades > 0) {
      return Promise.reject(
        new Error('OpenCode is being updated in a terminal; restart the server after it finishes')
      );
    }
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
        const { message, detail } = this.buildMissingCliError();
        this.setStatus({ state: 'error', message, detail });
        throw new Error(message);
      }

      if (this.processManager.hasOwnershipLeaseCandidate) {
        this.throwIfStartCancelled(disposeGeneration, signal);
        await this.processManager.recoverManagedServerOwnership();
        this.throwIfStartCancelled(disposeGeneration, signal);
      }
      if (this.process && this._status.state !== 'running') {
        await this.processManager.stopServerForRestart();
        this.throwIfStartCancelled(disposeGeneration, signal);
      }
      const health = await this.readHealthInfo();
      this.throwIfStartCancelled(disposeGeneration, signal);
      if (health.healthy) {
        if (isSupportedOpenCodeVersion(health.version)) {
          this.notifyIfAboveTestedCeiling(health.version);
          logger.info(`Found existing OpenCode server at ${this.url}`);
          await this.processManager.prepareForHealthyExistingServer();
          this.throwIfStartCancelled(disposeGeneration, signal);
          if (this.hasInjectedCompactionOverride() && !this.managedProcess) {
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

      if (this.managedProcess || this.process) {
        await this.processManager.stopServerForRestart();
        this.throwIfStartCancelled(disposeGeneration, signal);
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
      let attemptProcess: ChildProcess | null = null;
      let attemptProcessExited = false;
      let attemptCleanup: Promise<void> | null = null;
      let outcomeCleanup: Promise<void> | null = null;

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

      const cleanupAttemptProcess = () => {
        if (attemptCleanup) return attemptCleanup;
        attemptCleanup = attemptProcess
          ? attemptProcessExited
            ? this.processManager.releaseExitedProcess(attemptProcess)
            : this.processManager.terminateLaunchAttempt(attemptProcess)
          : this.processManager.cleanupPreparedInjectedConfigFile();
        return attemptCleanup;
      };

      const beginAttemptCleanup = () => {
        attemptFinished = true;
        this.cancelPollHealth();
        outcomeCleanup ||= cleanupAttemptProcess();
        return outcomeCleanup;
      };

      const rejectCancelledAttempt = () => {
        if (operationSettled) return;
        this.cancelPollHealth();
        this.clearRestartTimer();
        const cancellation = this.getCancellationError(signal);
        void (outcomeCleanup || beginAttemptCleanup()).then(
          () => rejectOperation(cancellation),
          (err: unknown) => {
            logger.error(describeManagedProcessCleanupFailure(cancellation.message, err));
            rejectOperation(cancellation);
          }
        );
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

      // A CLI that is not on disk fails differently per platform: POSIX fails
      // the spawn with ENOENT, while the Windows fallback (`opencode.cmd`) is
      // run through cmd.exe, which starts fine and reports the missing shim on
      // stderr. Both must reach the install guidance, not a generic error.
      // Neither an ENOENT in the server's output nor a shell's "not recognized"
      // says *which* file was missing: a present CLI failing on an absent config
      // path prints ENOENT too. Telling that user to install OpenCode hides the
      // real error, so nothing here overrides a CLI that did resolve on disk.
      // The genuine spawn failure is classified at its own call site, where the
      // missing file is unambiguously the executable.
      const isMissingCliStartupFailure = (message: string) => {
        if (this.processManager.getInstallInfo().found) return false;
        return [message, ...stderrLines].some(
          (line) =>
            OpenCodeProcess.isMissingCliFailure(line) ||
            OpenCodeProcess.isShellCommandNotFoundFailure(line)
        );
      };

      const failStartup = (rawMessage: string, err?: Error, rawDetail?: ServerErrorDetail) => {
        if (attemptFinished || operationSettled) return;
        if (isInvalidAttempt()) {
          rejectCancelledAttempt();
          return;
        }
        const missing =
          !rawDetail && isMissingCliStartupFailure(rawMessage) ? this.buildMissingCliError() : null;
        const message = missing ? missing.message : rawMessage;
        const detail = missing ? missing.detail : rawDetail;
        const status: Extract<ServerStatus, { state: 'error' }> = { state: 'error', message };
        if (detail) status.detail = detail;
        this.setStatus(status);
        const failure = err || new Error(message);
        void beginAttemptCleanup().then(
          () => {
            if (isInvalidAttempt()) rejectOperation(this.getCancellationError(signal));
            else rejectOperation(failure);
          },
          (cleanupErr: unknown) => {
            if (isInvalidAttempt()) {
              rejectOperation(this.getCancellationError(signal));
              return;
            }
            const cleanupMessage = describeManagedProcessCleanupFailure(message, cleanupErr);
            this.setStatus({ state: 'error', message: cleanupMessage });
            rejectOperation(new Error(cleanupMessage, { cause: cleanupErr }));
          }
        );
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
        void beginAttemptCleanup().then(
          () => {
            if (isInvalidAttempt()) {
              rejectCancelledAttempt();
              return;
            }
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
          },
          (cleanupErr: unknown) => {
            if (isInvalidAttempt()) {
              rejectOperation(this.getCancellationError(signal));
              return;
            }
            const message = describeManagedProcessCleanupFailure(
              'Could not retry OpenCode server startup',
              cleanupErr
            );
            this.setStatus({ state: 'error', message });
            rejectOperation(new Error(message, { cause: cleanupErr }));
          }
        );
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
          const incompatible = createUpdateRequiredError({
            observed: healthNow.version
              ? `the running server is ${healthNow.version}`
              : 'the running server version could not be determined',
            reason: 'The server that started is not compatible.',
            installMethod: this.processManager.getInstallInfo().installMethod,
          });
          failStartup(incompatible.message, undefined, incompatible.detail);
          return;
        }
        if (healthNow.healthy) {
          let ownershipConfirmed: boolean;
          try {
            ownershipConfirmed = await awaitBoundary(
              attemptProcess
                ? this.processManager.confirmManagedServerOwnership(attemptProcess)
                : Promise.resolve(false)
            );
          } catch (err) {
            if (isInvalidAttempt()) rejectCancelledAttempt();
            else {
              failStartup(
                OpenCodeServer.OWNERSHIP_CONFIRMATION_FAILED_MESSAGE,
                err instanceof Error ? err : new Error(String(err))
              );
            }
            return;
          }
          if (isInvalidAttempt()) {
            rejectCancelledAttempt();
            return;
          }
          if (!ownershipConfirmed) {
            failStartup(OpenCodeServer.OWNERSHIP_CONFIRMATION_FAILED_MESSAGE);
            return;
          }
          this.setRunningStatus(this.url, 'healthy');
          this.processManager.resetPortRetryState();
          this.startEventStream();
          finishStartup(this.url);
          return;
        }

        if (this.processManager.hasPortInUseDetected()) {
          const occupiedPort = this.processManager.port;
          if (this.tryAdvancePort()) {
            logger.warn(
              `Port ${occupiedPort} in use by another process; retrying on ${this.processManager.port}`
            );
            this.processManager.setPortInUseDetected(false);
            scheduleStartupRetry(100);
            return;
          }

          failStartup(
            `Port ${occupiedPort} is already in use, and Varro has no valid fallback port available. Set varro.server.port to an available integer between 1 and 65535.`
          );
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
        attemptProcess = this.processManager.launchServer({
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
          onExit: (proc, code, exitSignal) => {
            const wasCurrentProcess = this.process === proc;
            const ownershipTransferred =
              this.processManager.hasTransferredManagedServerOwnership(proc);
            attemptProcessExited = true;
            const processCleanup = this.processManager.releaseExitedProcess(proc);
            attemptCleanup ||= processCleanup;
            logger.info(`Server process exited with code ${code}`);
            if (!wasCurrentProcess || (attemptProcess && attemptProcess !== proc)) return;
            if (!ownershipTransferred) this.stopEventStream();
            if (isInvalidAttempt()) {
              rejectCancelledAttempt();
              return;
            }
            if (this._status.state === 'running') {
              if (ownershipTransferred) {
                void processCleanup.catch((err: unknown) => {
                  logger.warn(
                    `Failed to clean up transferred OpenCode process state: ${err instanceof Error ? err.message : String(err)}`
                  );
                });
                return;
              }
              this.handleRuntimeProcessExit(
                code,
                exitSignal,
                attemptId,
                disposeGeneration,
                processCleanup
              );
              return;
            }

            this.cancelPollHealth();
            void processCleanup.then(
              () =>
                recoverOrFailStartup(
                  `OpenCode server exited during startup${exitSignal ? ` (${exitSignal})` : code !== null ? ` (code ${code})` : ''}`
                ),
              (err: unknown) =>
                failStartup(
                  describeManagedProcessCleanupFailure(
                    'OpenCode server exited during startup',
                    err
                  ),
                  err instanceof Error ? err : new Error(String(err))
                )
            );
          },
          onError: (proc, err) => {
            logger.error(`Server process error: ${err.message}`);
            if ((attemptProcess && attemptProcess !== proc) || this.process !== proc) {
              void this.processManager.terminateLaunchAttempt(proc).catch((cleanupErr: unknown) => {
                logger.error(
                  describeManagedProcessCleanupFailure('Stale OpenCode process error', cleanupErr)
                );
              });
              return;
            }
            if (isInvalidAttempt()) {
              rejectCancelledAttempt();
              return;
            }
            if (attemptFinished || operationSettled) {
              const processCleanup = this.processManager.terminateLaunchAttempt(proc);
              if (this._status.state === 'running') {
                this.stopEventStream();
                this.handleRuntimeProcessExit(
                  null,
                  null,
                  attemptId,
                  disposeGeneration,
                  processCleanup
                );
              } else {
                void processCleanup.catch((cleanupErr: unknown) => {
                  logger.error(
                    describeManagedProcessCleanupFailure(
                      'OpenCode process error after startup',
                      cleanupErr
                    )
                  );
                });
              }
              return;
            }
            if (err.message.includes('ENOENT')) {
              const missing = this.buildMissingCliError();
              failStartup(missing.message, undefined, missing.detail);
              return;
            }

            failStartup(`OpenCode server failed to spawn: ${err.message}`, err);
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
          finishStartup(url);
        },
        (err) => {
          failStartup(describeStartupFailure(err.message), err);
        },
        0,
        signal,
        () => awaitBoundary(this.readHealthInfo()),
        () =>
          awaitBoundary(
            attemptProcess
              ? this.processManager.confirmManagedServerOwnership(attemptProcess)
              : Promise.resolve(false)
          )
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
    disposeGeneration: number,
    processCleanup: Promise<void>
  ) {
    this.transport.clearPendingAttentionRequests();
    this.transport.abortRequests();
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
    void Promise.all([processCleanup, this.transport.waitForRequestsToSettle()]).then(
      () => {
        if (!this.lifecycle.isCurrentStartAttempt(startAttemptId, disposeGeneration)) return;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.lifecycle.isCurrentStartAttempt(startAttemptId, disposeGeneration)) return;
          void this.startOperation(true).catch(() => {
            // Startup reports its own error status; this catch only owns the background promise.
          });
        }, delay);
      },
      (err: unknown) => {
        const message = `Failed to clean up the stopped OpenCode server: ${err instanceof Error ? err.message : String(err)}`;
        this.setStatus({ state: 'error', message });
      }
    );
  }

  private pollHealth(
    startAttemptId: number,
    disposeGeneration: number,
    resolve: (url: string) => void,
    reject: (err: Error) => void,
    attempt = 0,
    signal?: AbortSignal,
    readHealth: () => Promise<{ healthy: boolean; version?: string }> = () => this.readHealthInfo(),
    confirmOwnership: () => Promise<boolean> = () =>
      this.processManager.confirmManagedServerOwnership()
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
        const { message, detail } = createUpdateRequiredError({
          observed: health.version
            ? `the running server is ${health.version}`
            : 'the running server version could not be determined',
          reason: 'The server that started is not compatible.',
          installMethod: this.processManager.getInstallInfo().installMethod,
        });
        this.setStatus({ state: 'error', message, detail });
        reject(new Error(message));
      } else if (health.healthy) {
        this.cancelPollHealth();
        let ownershipConfirmed: boolean;
        try {
          ownershipConfirmed = await confirmOwnership();
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
        if (!ownershipConfirmed) {
          reject(new Error(OpenCodeServer.OWNERSHIP_CONFIRMATION_FAILED_MESSAGE));
          return;
        }
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
          readHealth,
          confirmOwnership
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
    const restartPromise = this.lifecycle.getRestartPromise<string>();
    if (restartPromise) await restartPromise;
    if (this.lifecycle.phase === 'disposing' || this.lifecycle.phase === 'restarting') {
      throw new Error('OpenCode server is not accepting requests while stopping');
    }
    return this.transport.request(method, path, body, options);
  }

  async rescopeEventStream(directory?: string): Promise<OpenCodeRescopeResult> {
    const result = await this.transport.rescopeEventStream(directory);
    return this._status.state === 'running' ? result : { state: 'inactive', directory };
  }

  async readServerInfo(): Promise<OpenCodeServerInfo> {
    let cliVersion: string | null = null;
    let cliVersionError: string | null = null;
    let activeAgentCount: number | null = null;
    let activeAgentError: string | null = null;

    try {
      cliVersion = await this.readInstalledCliVersion();
    } catch (err) {
      cliVersionError = err instanceof Error ? err.message : String(err);
    }
    if (this._status.state === 'running') {
      try {
        activeAgentCount = await this.readActiveAgentCount();
      } catch (err) {
        activeAgentError = err instanceof Error ? err.message : String(err);
      }
    }

    const install = this.processManager.getInstallInfo();
    const health = await this.readHealthInfo();

    return {
      status: this._status,
      url: this.url,
      port: this.processManager.port,
      command: this.resolveCommand(),
      installMethod: install.installMethod,
      resolvedCommand: install.resolvedCommand,
      searchedPaths: install.searchedPaths,
      autoStart: this.processManager.isAutoStartEnabled,
      managedProcess: this.managedProcess,
      ownership: this.processManager.serverOwnership,
      processId: this.processManager.managedProcessId,
      cliVersion,
      cliVersionError,
      activeAgentCount,
      activeAgentError,
      health,
      workspaceCwd: this.getWorkspaceCwd(),
    };
  }

  private async readActiveAgentCount() {
    const sessions = await this.request('GET', '/experimental/session?limit=100', undefined, {
      unscoped: true,
    });
    if (!Array.isArray(sessions)) {
      throw new Error('OpenCode returned an invalid global session list');
    }

    const directories = new Set<string>();
    for (const value of sessions) {
      if (!value || typeof value !== 'object') continue;
      const directory = (value as Record<string, unknown>).directory;
      if (typeof directory === 'string' && directory.trim()) directories.add(directory);
    }
    const workspaceCwd = this.getWorkspaceCwd();
    if (workspaceCwd) directories.add(workspaceCwd);

    const activeAgentIDs = new Set<string>();
    const values = [...directories];
    for (let index = 0; index < values.length; index += 8) {
      const statuses = await Promise.all(
        values
          .slice(index, index + 8)
          .map((directory) =>
            this.request('GET', `/session/status?directory=${encodeURIComponent(directory)}`)
          )
      );
      for (const status of statuses) addActiveAgentIDs(status, activeAgentIDs);
    }
    return activeAgentIDs.size;
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

  private startMaintenanceLoop() {
    this.processManager.startMaintenanceLoop(() => {
      void this.runMaintenanceTick();
    });
  }

  private stopMaintenanceLoop() {
    this.processManager.stopMaintenanceLoop();
  }

  private requestMaintenanceCheck(force = false) {
    this.processManager.requestMaintenanceCheck(() => {
      void this.runMaintenanceTick();
    }, force);
  }

  private async runMaintenanceTick() {
    await this.processManager.runMaintenanceTick({
      isDisposing: () => this.isDisposing,
      getStatus: () => this._status,
      readInstalledCliVersion: () => this.readInstalledCliVersion(),
      maybeSuggestCliUpdate: (installedCliVersion) =>
        this.maybeSuggestCliUpdate(installedCliVersion),
      readHealthInfo: async () => {
        const health = await this.readHealthInfo();
        // Covers servers Varro launched itself, which never pass through the
        // existing-server branch in startOperation.
        if (health.healthy) this.notifyIfAboveTestedCeiling(health.version);
        return health;
      },
      hasActiveSessions: () => this.hasActiveSessions(),
      takeOwnershipOfExistingServer: () => this.processManager.takeOwnershipOfExistingServer(),
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
      this.failForRequiredUpdate(observed, 'Automatic updates are disabled.', {
        blockedBy: 'auto-update-disabled',
        settingId: 'varro.server.autoUpdate',
      });
    }
    if (!this.processManager.isAutoStartEnabled) {
      this.failForRequiredUpdate(
        observed,
        'Varro server auto-start is disabled, so Varro cannot safely replace the running server.',
        { blockedBy: 'auto-start-disabled', settingId: 'varro.server.autoStart' }
      );
    }

    await this.ensureOldServerIsIdle(observed, disposeGeneration, signal);

    logger.info(
      `OpenCode server ${serverVersion || 'unknown'} is older than required ${MINIMUM_SUPPORTED_OPENCODE_VERSION}; attempting a safe update`
    );
    this.throwIfStartCancelled(disposeGeneration, signal);
    await this.upgradeRunningServer(MINIMUM_SUPPORTED_OPENCODE_VERSION);
    this.throwIfStartCancelled(disposeGeneration, signal);
    // The upgrade request can take long enough for another client to start
    // work, so the initial check is not sufficient authorization to stop.
    await this.ensureOldServerIsIdle(observed, disposeGeneration, signal);
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
      this.failForRequiredUpdate(observed, 'Automatic updates are disabled.', {
        blockedBy: 'auto-update-disabled',
        settingId: 'varro.server.autoUpdate',
      });
    }

    logger.info(
      `Updating OpenCode CLI ${installedVersion} to meet Varro's minimum ${MINIMUM_SUPPORTED_OPENCODE_VERSION}`
    );
    // Kept for the case below: `opencode upgrade` can print why it failed and
    // still exit 0, and that text is the only basis for actionable guidance.
    let upgradeDiagnostics = '';
    try {
      this.throwIfStartCancelled(disposeGeneration, signal);
      upgradeDiagnostics = await this.processManager.upgradeCli(MINIMUM_SUPPORTED_OPENCODE_VERSION);
      this.throwIfStartCancelled(disposeGeneration, signal);
    } catch (err) {
      this.throwIfStartCancelled(disposeGeneration, signal);
      const failure = this.processManager.describeUpgradeError(err);
      logger.warn(`Automatic OpenCode CLI update failed (${failure.kind}): ${failure.cause}`);
      this.failForRequiredUpdate(observed, 'The automatic update failed.', { failure });
    }

    let updatedVersion: string | null;
    try {
      this.throwIfStartCancelled(disposeGeneration, signal);
      // The upgrade may have replaced a binary Varro resolved before it ran.
      this.processManager.clearResolvedCommandCache();
      updatedVersion = await this.readInstalledCliVersion();
      this.throwIfStartCancelled(disposeGeneration, signal);
    } catch (err) {
      this.throwIfStartCancelled(disposeGeneration, signal);
      this.failForRequiredUpdate(
        observed,
        `The update finished, but Varro could not verify it: ${err instanceof Error ? err.message : String(err)}.`,
        { blockedBy: 'verify-failed' }
      );
    }
    if (!updatedVersion || !isSupportedOpenCodeVersion(updatedVersion)) {
      // The upgrade command reported success but the on-disk CLI did not move,
      // so say the part the user cannot see: an older shim earlier on PATH is
      // what usually shadows the freshly installed binary.
      this.failForRequiredUpdate(
        observed,
        `The automatic update did not install a compatible CLI${updatedVersion ? ` (found ${updatedVersion})` : ''}, which usually means an older OpenCode earlier on PATH is shadowing it.`,
        {
          failure: this.processManager.describeUpgradeError(
            new Error(upgradeDiagnostics.trim() || 'the updated CLI was not picked up')
          ),
        }
      );
    }

    logger.info(`OpenCode CLI updated successfully to ${updatedVersion}`);
  }

  private failForRequiredUpdate(
    observed: string,
    reason: string,
    options: {
      blockedBy?: ServerErrorBlockedBy;
      settingId?: string;
      failure?: UpgradeFailureReport;
    } = {}
  ): never {
    const { installMethod } = this.processManager.getInstallInfo();
    const { message, detail } = createUpdateRequiredError({
      observed,
      reason,
      installMethod,
      ...options,
    });
    this.cancelPollHealth();
    this.stopEventStream();
    this.setStatus({ state: 'error', message, detail });
    throw new Error(message);
  }

  /**
   * "Not installed" and "installed somewhere Varro did not look" need opposite
   * instructions, and telling someone with a working CLI to reinstall it is the
   * most misleading thing Varro can say. Split them on what actually resolved.
   */
  private buildMissingCliError(): { message: string; detail: ServerErrorDetail } {
    const install = this.processManager.getInstallInfo();

    if (install.configuredCommandMissing) {
      return {
        message: `OpenCode CLI not found at the configured path: ${install.configuredCommand}. Update varro.server.command to point at your OpenCode executable, or clear it to let Varro search PATH.`,
        detail: {
          kind: 'cli-path-invalid',
          configuredCommand: install.configuredCommand,
          settingId: 'varro.server.command',
        },
      };
    }

    return {
      message: OpenCodeProcess.MISSING_CLI_MESSAGE,
      detail: {
        kind: 'cli-missing',
        suggestedCommand: 'npm i -g opencode-ai',
        settingId: 'varro.server.command',
        searchedPaths: install.searchedPaths,
      },
    };
  }

  /**
   * A CLI newer than Varro's tested ceiling is the normal state right after an
   * OpenCode release, so this only informs: blocking it would be worse than the
   * silence it replaces. Patch-level drift is expected within days of every
   * release and is always logged but never popped up - only a minor or major
   * ahead of the tested version is worth interrupting for.
   */
  private notifyIfAboveTestedCeiling(observedVersion: string | undefined) {
    const normalized = typeof observedVersion === 'string' ? extractVersion(observedVersion) : null;
    if (!normalized) return;
    if (this.lastCeilingNoticeVersion === normalized) return;
    const testedThrough = maximumTestedOpenCodeVersion;
    if (compareVersions(normalized, testedThrough) <= 0) return;
    this.lastCeilingNoticeVersion = normalized;

    const message = `OpenCode ${normalized} is newer than the version Varro has been tested against (${testedThrough}). Varro will keep working; report anything broken so compatibility can be updated.`;
    logger.warn(message);
    if (!isMinorVersionAhead(normalized, testedThrough)) return;
    void vscode.window
      .showInformationMessage(message, 'Report Issue', 'Show Logs')
      .then((action) => {
        if (action === 'Show Logs') logger.show();
        else if (action === 'Report Issue') {
          void vscode.env.openExternal(
            vscode.Uri.parse('https://github.com/koltyakov/varro/issues')
          );
        }
      });
  }

  private async restartServerForCliUpdate(serverVersion: string, installedCliVersion: string) {
    await this.runRestart(async () => {
      logger.info(
        `Restarting OpenCode server to use CLI ${installedCliVersion} instead of server ${serverVersion}`
      );
      await this.stopServerForRestart(true);
    });
  }

  private async stopManagedProcessForRestart(ownershipAcquired = false) {
    const ownership = ownershipAcquired
      ? null
      : this.processManager.acquireManagedServerRestartOwnership();
    const releaseOwnership =
      ownership === null ? null : typeof ownership === 'function' ? ownership : await ownership;
    try {
      this.clearRestartTimer();
      this.clearRetryResetTimer();
      this.cancelPollHealth();
      this.stopEventStream();
      this.transport.abortRequests();
      await this.processManager.stopManagedProcessForRestart();
    } finally {
      await releaseOwnership?.();
    }
  }

  private async stopServerForRestart(ownershipAcquired = false) {
    if (ownershipAcquired) {
      this.clearRestartTimer();
      this.clearRetryResetTimer();
      this.cancelPollHealth();
      this.stopEventStream();
      this.transport.abortRequests();
      await this.processManager.stopServerForRestart();
      return;
    }
    const ownership = this.processManager.acquireManagedServerRestartOwnership();
    const releaseOwnership = typeof ownership === 'function' ? ownership : await ownership;
    try {
      this.clearRestartTimer();
      this.clearRetryResetTimer();
      this.cancelPollHealth();
      this.stopEventStream();
      this.transport.abortRequests();
      await this.processManager.stopServerForRestart();
    } finally {
      await releaseOwnership();
    }
  }

  async readRestartBlockers(): Promise<RestartBlockedState> {
    // Use the transport directly: restart preflight runs after the lifecycle
    // has reserved the restart operation, while public request() intentionally
    // waits behind that operation.
    const [statuses, questions, permissions] = await Promise.all([
      this.transport.request('GET', '/session/status', undefined, { unscoped: true }),
      this.transport.request('GET', '/question', undefined, { unscoped: true }),
      this.transport.request('GET', '/permission', undefined, { unscoped: true }),
    ]);

    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
      throw new Error('OpenCode returned an invalid session status response');
    }
    if (!Array.isArray(questions)) {
      throw new Error('OpenCode returned an invalid pending question response');
    }
    if (!Array.isArray(permissions)) {
      throw new Error('OpenCode returned an invalid pending permission response');
    }
    const blockingSessionIDs = new Set<string>();
    for (const [sessionID, value] of Object.entries(statuses)) {
      const status =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      if (
        !sessionID.trim() ||
        !status ||
        (status.type !== 'idle' && status.type !== 'busy' && status.type !== 'retry')
      ) {
        throw new Error('OpenCode returned an invalid session status response');
      }
      if (status.type === 'busy' || status.type === 'retry') blockingSessionIDs.add(sessionID);
    }
    for (const question of questions) {
      const sessionID = getSessionID(question);
      if (!sessionID) throw new Error('OpenCode returned an invalid pending question response');
      blockingSessionIDs.add(sessionID);
    }
    for (const permission of permissions) {
      const sessionID = getSessionID(permission);
      if (!sessionID) throw new Error('OpenCode returned an invalid pending permission response');
      blockingSessionIDs.add(sessionID);
    }
    for (const sessionID of this.transport.getPendingAttentionSessionIDs()) {
      blockingSessionIDs.add(sessionID);
    }

    if (blockingSessionIDs.size === 0) {
      const result = { totalSessionCount: 0, directories: [] };
      this.lastRestartBlockers = result;
      return result;
    }

    let sessions: unknown[] = [];
    try {
      const value = await this.transport.request('GET', '/session', undefined, { unscoped: true });
      if (Array.isArray(value)) sessions = value;
      else
        logger.warn('OpenCode returned an invalid session list while describing restart blockers');
    } catch (err) {
      logger.warn(
        `Could not read session directories for restart blockers: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const directoriesBySessionID = new Map<string, string>();
    for (const value of sessions) {
      if (!value || typeof value !== 'object') continue;
      const session = value as Record<string, unknown>;
      if (typeof session.id !== 'string' || typeof session.directory !== 'string') continue;
      directoriesBySessionID.set(session.id, session.directory);
    }

    const grouped = new Map<string, { directory: string | null; sessionCount: number }>();
    for (const sessionID of blockingSessionIDs) {
      const directory = directoriesBySessionID.get(sessionID) ?? null;
      const key = normalizeWorkspaceIdentity(directory) ?? '';
      const current = grouped.get(key);
      if (current) current.sessionCount += 1;
      else grouped.set(key, { directory, sessionCount: 1 });
    }

    const result = {
      totalSessionCount: blockingSessionIDs.size,
      directories: [...grouped.values()].toSorted((left, right) => {
        if (left.directory === null) return 1;
        if (right.directory === null) return -1;
        return left.directory.localeCompare(right.directory);
      }),
    };
    this.lastRestartBlockers = result;
    return result;
  }

  private async hasActiveSessions(): Promise<boolean> {
    return (await this.readRestartBlockers()).totalSessionCount > 0;
  }

  private async ensureOldServerIsIdle(
    observed: string,
    disposeGeneration: number,
    signal: AbortSignal
  ) {
    let activeSessions: boolean;
    try {
      this.throwIfStartCancelled(disposeGeneration, signal);
      activeSessions = await this.hasActiveSessions();
      this.throwIfStartCancelled(disposeGeneration, signal);
    } catch (err) {
      this.throwIfStartCancelled(disposeGeneration, signal);
      this.failForRequiredUpdate(
        observed,
        `Varro could not verify that the old server is idle: ${err instanceof Error ? err.message : String(err)}.`,
        { blockedBy: 'verify-failed' }
      );
    }
    if (activeSessions) {
      this.failForRequiredUpdate(
        observed,
        'The old server has active sessions and was not stopped to avoid interrupting work.',
        { blockedBy: 'active-sessions' }
      );
    }
  }

  private async ensureSafeToStopLiveServer(allowUnresponsiveManagedProcess = false) {
    const health = await this.readHealthInfo();
    if (!health.healthy) {
      if (this.managedProcess && !allowUnresponsiveManagedProcess) {
        throw new Error(
          'Varro could not verify that the managed OpenCode server is idle; retry when the server is responding'
        );
      }
      return;
    }

    let activeSessions: boolean;
    try {
      activeSessions = await this.hasActiveSessions();
    } catch (err) {
      throw new Error(
        `Varro could not verify that the OpenCode server is idle: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    if (activeSessions) {
      throw new RestartBlockedError(
        this.lastRestartBlockers ?? {
          totalSessionCount: 1,
          directories: [{ directory: null, sessionCount: 1 }],
        }
      );
    }
  }

  private async maybeSuggestCliUpdate(installedCliVersion: string | null) {
    return this.processManager.maybeSuggestCliUpdate(installedCliVersion, {
      readLatestCliVersion: () => this.readLatestCliVersion(),
      upgradeRunningServer: (targetVersion) => this.upgradeRunningServer(targetVersion),
      requestMaintenanceCheck: () => this.requestMaintenanceCheck(true),
      getWorkspaceCwd: () => this.getWorkspaceCwd(),
      prepareForWindowsCliUpgrade: () => this.prepareForWindowsCliUpgrade(),
      finishWindowsCliUpgrade: () => this.finishWindowsCliUpgrade(),
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

  /**
   * Releases the Windows file lock on the OpenCode binary before something
   * tries to replace it. Public because the webview's one-click update runs the
   * command in a terminal, which needs the same prerequisite as Varro's own
   * upgrade path. No-op off Windows and when Varro owns no process.
   */
  async prepareForWindowsCliUpgrade() {
    if (process.platform !== 'win32') return;
    if (!this.managedProcess && !this.processManager.hasForeignActiveOwnership) {
      const health = await this.readHealthInfo();
      if (this._status.state === 'running' || health.healthy) {
        throw new Error(
          'A running OpenCode server is not owned by this Varro window; stop it before updating OpenCode'
        );
      }
      this.pendingTerminalCliUpgrades += 1;
      return;
    }

    await this.ensureSafeToStopLiveServer();
    await this.stopManagedProcessForRestart();
    this.pendingTerminalCliUpgrades += 1;
    this.setStatus({ state: 'stopped' });
  }

  finishWindowsCliUpgrade() {
    this.pendingTerminalCliUpgrades = Math.max(0, this.pendingTerminalCliUpgrades - 1);
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

  updateLaunchSettings(options: { autoStart: boolean; command: string }) {
    this.processManager.updateLaunchSettings(options);
  }

  restart(options: { force?: boolean } = {}): Promise<string> {
    // Restart is how the user says "I just installed it, look again", so the
    // memoized lookup must not survive: its key only covers the environment,
    // which does not change when a CLI appears in a directory already on PATH.
    this.processManager.clearResolvedCommandCache();
    if (this.pendingTerminalCliUpgrades > 0) {
      return Promise.reject(
        new Error('OpenCode is being updated in a terminal; close it before restarting the server')
      );
    }
    if (this._status.state === 'error' && !this.managedProcess && !this.process) {
      return this.recoverOwnershipAndRestart(options);
    }
    return this.startRestart(options);
  }

  private async recoverOwnershipAndRestart(options: { force?: boolean }): Promise<string> {
    await this.processManager.takeOwnershipOfExistingServer();
    return this.startRestart(options);
  }

  private startRestart(options: { force?: boolean }): Promise<string> {
    return this.runRestart(
      async () => {
        await this.processManager.stopServerForRestart();
      },
      { allowUnresponsiveManagedProcess: true, force: options.force }
    );
  }

  private runRestart(
    stop: () => Promise<void>,
    options: { allowUnresponsiveManagedProcess?: boolean; force?: boolean } = {}
  ): Promise<string> {
    const existingRestart = this.lifecycle.getRestartPromise<string>();
    if (existingRestart) return existingRestart;

    const operation = this.lifecycle.setRestartPromise(async (signal) => {
      this.throwIfOperationCancelled(signal);
      if (this.adoptedServerRecoveryOperation) {
        await this.waitForAdoptedServerRecovery();
        this.throwIfOperationCancelled(signal);
      }
      await this.transport.waitForRequestsToSettle();
      this.throwIfOperationCancelled(signal);
      if (!options.force) {
        await this.ensureSafeToStopLiveServer(options.allowUnresponsiveManagedProcess);
      }
      this.throwIfOperationCancelled(signal);
      const ownership = this.processManager.acquireManagedServerRestartOwnership();
      const releaseOwnership = typeof ownership === 'function' ? ownership : await ownership;
      try {
        this.setStatus({ state: 'starting' });
        this.clearRestartTimer();
        this.clearRetryResetTimer();
        this.cancelPollHealth();
        this.stopEventStream();
        this.transport.clearPendingAttentionRequests();
        this.transport.abortRequests();
        try {
          await stop();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.setStatus({
            state: 'error',
            message: `Failed to stop OpenCode server for restart: ${message}`,
          });
          throw err;
        }
        this.throwIfOperationCancelled(signal);
        this.restartReadyToStart = true;
        try {
          const url = await this.start();
          this.throwIfOperationCancelled(signal);
          return url;
        } finally {
          this.restartReadyToStart = false;
        }
      } finally {
        await releaseOwnership();
      }
    }, OpenCodeServer.START_DISPOSED_MESSAGE);
    // Reserve the lifecycle first so no new public request can start, then
    // cancel and drain requests that crossed the reservation boundary before
    // taking the idle snapshot above.
    this.transport.abortRequests();
    return operation;
  }

  private async disposeResources(options: { stopProcess: boolean }) {
    this.pendingTerminalCliUpgrades = 0;
    this.lifecycle.beginDispose(OpenCodeServer.START_DISPOSED_MESSAGE);
    this.clearRestartTimer();
    this.clearRetryResetTimer();
    this.stopMaintenanceLoop();
    this.cancelPollHealth();
    this.stopEventStream();
    this.transport.clearPendingAttentionRequests();
    this.transport.abortRequests();
    await this.lifecycle.waitForOperationsSettlement();
    if (this.adoptedServerRecoveryOperation) await this.waitForAdoptedServerRecovery();
    await this.processManager.disposeProcess(options);
    this.setStatus({ state: 'stopped' });
  }

  getWorkspaceCwd(): string | undefined {
    return this.transport.getWorkspaceDirectory();
  }

  resolveCommand(): string {
    return this.processManager.resolveCommand();
  }

  private async syncInjectedConfigFile() {
    await this.processManager.syncInjectedConfigFile();
  }

  private async restartManagedServerForCompactionSettings() {
    await this.runRestart(async () => {
      logger.info('Restarting managed OpenCode server to apply updated Varro compaction settings');
      await this.stopManagedProcessForRestart(true);
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
