/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- Server, process, and extension API values are validated before state transitions. */
/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Server assertions follow lifecycle, process, and response validation. */
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { stat } from 'fs/promises';
import * as vscode from 'vscode';
import {
  MINIMUM_SUPPORTED_OPENCODE_VERSION,
  MINIMUM_SUPPORTED_OPENCODE_V2_VERSION,
  OPENCODE_UPDATE_REQUIRED_PREFIX,
} from '../shared/opencode-compatibility';
import {
  getUpgradeCommand,
  OPENCODE_INSTALL_COMMAND,
  OPENCODE_UPGRADE_COMMAND,
  type OpenCodeInstallMethod,
} from '../shared/opencode-install';
import {
  parseServerEvent,
  type RestartBlockedState,
  type ServerErrorBlockedBy,
  type ServerErrorDetail,
  type ServerStatus,
} from '../shared/protocol';
import { normalizeWorkspaceIdentity } from '../shared/workspace-path';
import { asRecord } from '../shared/type-utils';
import {
  measureStartupPhase,
  STARTUP_CREDENTIAL_TIMEOUT_MS,
  STARTUP_HEALTH_TIMEOUT_MS,
  withStartupDeadline,
} from '../shared/startup';
import type { StartupPhase } from '../shared/startup';
import {
  OpenCodeProcess,
  type OpenCodeCompactionSettings,
  type OpenCodePortSetting,
  type OpenCodeServerOwnership,
  type UpgradeFailureReport,
} from './open-code-process';
import {
  OpenCodeTransport,
  type OpenCodeRequestOptions,
  type OpenCodeRescopeResult,
} from './open-code-transport';
import { logger } from './logger';
import { diagnosticTimeline } from './diagnostics';
import { ServerLifecycleStateMachine } from './server-lifecycle';
import {
  compareVersions,
  extractVersion,
  isPortInUseMessage,
  normalizeRunningStatus,
} from './server-utils';
import { FULL_SESSION_LIST_LIMIT } from './util/session-list';
import { basicAuthorization, openCodeApiVersion } from './opencode-connection';
import { inspectLocalServerAccount, isProcessAlive } from './process-inspection';
import { ProcessInspectionTimeoutError } from './process-inspection-error';
import { readLocalServerConnectionInfo } from './server-connection-info';
import type { ServerConnectionInfo } from './server-connection-info';
import { ServerConnectionAdmission } from './server-connection-admission';
import { ServerConnectionMonitor } from './server-connection-monitor';

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
  cliInstalledAt: number | null;
  connections: ServerConnectionInfo;
  installMethod: OpenCodeInstallMethod;
  resolvedCommand: string;
  searchedPaths: string[];
  activeAgentCount: number | null;
  activeAgentError: string | null;
  health: { healthy: boolean; version?: string };
  workspaceCwd: string | undefined;
}

const PROCESS_OUTPUT_LOG_WINDOW_MS = 1_000;
const PROCESS_OUTPUT_LOG_MAX_CHARS = 128 * 1024;
const PROCESS_OUTPUT_LOG_MAX_ENTRY_CHARS = 16 * 1024;
const PROCESS_OUTPUT_LOG_MAX_ENTRIES = 256;
const PROCESS_STDERR_DIAGNOSTIC_CHARS = 64 * 1024;
const PROCESS_STDERR_FALLBACK_DIAGNOSTIC_CHARS = 512;

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
    normalized !== null &&
    openCodeApiVersion(normalized) !== null &&
    compareVersions(normalized, minimumVersion(normalized)) >= 0
  );
}

function minimumVersion(version: string | undefined): string {
  return openCodeApiVersion(extractVersion(version ?? '') ?? '') === 2
    ? MINIMUM_SUPPORTED_OPENCODE_V2_VERSION
    : MINIMUM_SUPPORTED_OPENCODE_VERSION;
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
  const required = minimumVersion(options.observed);
  const summary = `${OPENCODE_UPDATE_REQUIRED_PREFIX} Varro requires OpenCode ${required} or newer, but ${options.observed}. ${options.reason}`;
  const installMethod = options.failure?.installMethod ?? options.installMethod;
  const suggestedCommand = installMethod
    ? getUpgradeCommand(
        installMethod,
        process.platform,
        openCodeApiVersion(required) === 2 ? '@opencode/cli' : 'opencode-ai'
      ) || OPENCODE_UPGRADE_COMMAND
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
    required,
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

class SeparateAutomaticServerRequested extends Error {
  override readonly name = 'SeparateAutomaticServerRequested';
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
  private startupOperationId = '';

  private measureStartup<T>(phase: StartupPhase, operation: () => PromiseLike<T>): Promise<T> {
    const operationId = this.startupOperationId;
    const generation = this.disposeGeneration;
    const attempt = this.lifecycle.startAttemptId;
    return measureStartupPhase(phase, operation, (timing) => {
      diagnosticTimeline.record({
        event: 'startup-phase',
        operationId,
        generation,
        attempt,
        platform: process.platform,
        arch: process.arch,
        runtime: process.version,
        ...timing,
      });
    });
  }
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResetTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private restartReadyToStart = false;
  private pendingTerminalCliUpgrades = 0;
  private restoreServerAfterTerminalCliUpgrade = false;
  private terminalCliUpgradeWorkspaceIdentity: string | null = null;
  private terminalCliUpgradeTargetVersion: string | null = null;
  private terminalCliUpgradePreparationOperation: Promise<void> | null = null;
  private terminalCliUpgradeFinishOperation: Promise<void> | null = null;
  private lastRestartBlockers: RestartBlockedState | null = null;
  private adoptedServerRecoveryOperation: Promise<void> | null = null;
  private existingServerPreparationOperation: Promise<void> | null = null;
  private streamTimeoutReconciliationOperation: Promise<void> | null = null;
  private askAgentReconciliationOperation: Promise<void> | null = null;
  private runtimeAskRecoveryPending = false;
  private savedServerAuthorization: { url: string; value: string } | undefined;
  private readonly admission: ServerConnectionAdmission;
  private readonly connectionMonitor: ServerConnectionMonitor;
  private preserveExistingProcess = false;
  private registeredEndpoint = false;
  private externalEndpoint = false;

  constructor(
    port: OpenCodePortSetting,
    autoStart: boolean,
    command?: string,
    simulateMissingCli = false,
    compactionSettings?: Partial<OpenCodeCompactionSettings>,
    ownershipLeasePath?: string,
    private readonly secrets?: vscode.SecretStorage,
    private readonly legacyDefaultEndpoint = false
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
    this.admission = new ServerConnectionAdmission(
      () => this.url,
      () => inspectLocalServerAccount(this.processManager.port),
      async (account, url) => {
        const description =
          account.kind === 'different-user'
            ? 'The listening process belongs to another OS user.'
            : 'Varro could not verify which OS user owns the listening process.';
        const answer = await vscode.window.showWarningMessage(
          `Connect to OpenCode at ${url}? ${description} Connecting can expose that server's sessions and execute tools under its account. Supplied credentials alone do not prove the server enforces authentication.`,
          { modal: true },
          ...(this.processManager.isAutomaticPort &&
          !this.registeredEndpoint &&
          this._status.state !== 'running'
            ? ['Start my server on another port', 'Connect anyway']
            : ['Connect anyway'])
        );
        if (answer === 'Start my server on another port')
          throw new SeparateAutomaticServerRequested();
        return answer === 'Connect anyway';
      }
    );
    this.connectionMonitor = new ServerConnectionMonitor({
      getUrl: () => this.url,
      getManagedIdentity: () => this.processManager.connectionIdentity,
      getAccount: () => this.admission.confirmedAccount,
      isProcessAlive,
      inspectAccount: () => inspectLocalServerAccount(this.processManager.port),
      verifyManagedConnection: () => this.processManager.verifyManagedServerConnection(true),
      reportDiagnostic: (message) => logger.warn(message),
    });
    this.transport = new OpenCodeTransport({
      authorizeConnection: async (reconnect) => {
        const url = this.url;
        const generation = this.disposeGeneration;
        if (!reconnect && this._status.state === 'running' && this.connectionMonitor.canReuse()) {
          // A short adapter ticket, not another OS inspection. The confirmed
          // connection remains monitored independently of request frequency.
          return { expiresAt: Date.now() + 1000 };
        }
        if (reconnect) this.connectionMonitor.invalidate();
        const force = this.connectionMonitor.requiresVerification;
        const monitorGeneration = this.connectionMonitor.generation;
        try {
          // Both independent checks must succeed before transport use. Serial
          // Windows inspections can expire the other's one-second cache.
          await Promise.all([
            this.processManager.verifyManagedServerConnection(
              force || (reconnect && this._status.state === 'running')
            ),
            this.admission.verify(reconnect, force),
          ]);
          if (url !== this.url || generation !== this.disposeGeneration)
            throw new Error('OpenCode connection changed during verification');
          if (this._status.state === 'running' && !this.isDisposing)
            this.connectionMonitor.confirm(this.admission.confirmedAccount, monitorGeneration);
          return {
            expiresAt: Math.min(
              this.processManager.connectionVerificationExpiresAt,
              this.admission.verificationExpiresAt
            ),
          };
        } catch (error) {
          if (
            this._status.state === 'running' &&
            url === this.url &&
            generation === this.disposeGeneration &&
            !this.isDisposing &&
            !(error instanceof ProcessInspectionTimeoutError)
          ) {
            this.stopEventStream();
            this.setStatus({
              state: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
      },
      getUrl: () => this.url,
      getWorkspaceCwd: () => this.processManager.getWorkspaceCwd(),
      getStatus: () => this._status,
      isDisposing: () => this.isDisposing,
      updateEventStreamState: (eventStream) => this.updateEventStreamState(eventStream),
      emitEvent: (event) => this.handleServerEvent(event),
      getAuthorization: () =>
        this.savedServerAuthorization?.url === this.url
          ? this.savedServerAuthorization.value
          : this.processManager.serverAuthorization,
      refreshAuthorization: () => this.processManager.discoverServerCredentials(),
      openExternal: async (value) => {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
          throw new Error('Unsupported OpenCode authentication URL');
        return vscode.env.openExternal(vscode.Uri.parse(url.href));
      },
    });
  }

  private handleServerEvent(event: unknown) {
    const parsed = parseServerEvent(event);
    this.emit('event', event);
    if (parsed?.type !== 'session.status') return;
    const status = (parsed.properties as { status?: unknown } | undefined)?.status;
    if (status && typeof status === 'object' && (status as { type?: unknown }).type === 'idle') {
      this.requestMaintenanceCheck(this.runtimeAskRecoveryPending);
    }
  }

  get status(): ServerStatus {
    return this._status;
  }

  get apiVersion() {
    return this.transport.version;
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
    if (previousStatus.state !== nextStatus.state) {
      diagnosticTimeline.record({ event: 'server-state', state: nextStatus.state });
    }
    this._status = nextStatus;
    if (nextStatus.state !== 'running') this.connectionMonitor.reset();
    if (nextStatus.state === 'running') {
      this.startMaintenanceLoop();
    } else if (previousStatus.state === 'running') {
      this.stopMaintenanceLoop();
    }
    this.emit('status', nextStatus);
  }

  private setRunningStatus(url = this.url, eventStream?: 'healthy' | 'degraded') {
    const status: Extract<ServerStatus, { state: 'running' }> = {
      state: 'running',
      url,
      apiVersion: this.apiVersion,
    };
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

  private startExistingServerPreparation(disposeGeneration: number, signal: AbortSignal) {
    if (this.isAttachOnly) return;
    if (this.existingServerPreparationOperation) return;
    const operation = (async () => {
      try {
        if (this.processManager.hasOwnershipLeaseCandidate) {
          await this.processManager.recoverManagedServerOwnership();
        }
        await this.processManager.prepareForHealthyExistingServer();
        if (signal.aborted || disposeGeneration !== this.disposeGeneration) return;
        if (this.hasInjectedCompactionOverride() && !this.managedProcess) {
          logger.warn(
            'Varro chat auto-compaction settings require a Varro-managed OpenCode server; project opencode.json still overrides when present'
          );
        }
        this.requestMaintenanceCheck();
      } catch (err) {
        logger.warn(
          `Failed to prepare existing OpenCode server ownership: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();
    this.existingServerPreparationOperation = operation;
    void operation.finally(() => {
      if (this.existingServerPreparationOperation === operation) {
        this.existingServerPreparationOperation = null;
      }
    });
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

  private async recoverServerAuthentication(signal: AbortSignal) {
    const url = this.url;
    const secrets = this.secrets;
    if (!secrets) return { healthy: false };
    const key = `varro.opencode.serverCredentials:${url}`;
    const checkCurrent = () => {
      signal.throwIfAborted();
      if (this.url !== url)
        throw new Error('OpenCode server address changed during authentication');
    };
    const stored = await withStartupDeadline(
      () => secrets.get(key),
      STARTUP_CREDENTIAL_TIMEOUT_MS,
      'Server credential lookup',
      signal
    );
    checkCurrent();
    let username = 'opencode';
    if (stored) {
      try {
        const credentials: unknown = JSON.parse(stored);
        if (
          credentials &&
          typeof credentials === 'object' &&
          'username' in credentials &&
          typeof credentials.username === 'string' &&
          'password' in credentials &&
          typeof credentials.password === 'string' &&
          credentials.password
        ) {
          username = credentials.username;
          this.savedServerAuthorization = {
            url,
            value: basicAuthorization(credentials.password, username),
          };
        }
      } catch {
        logger.warn('Could not parse saved OpenCode server credentials');
      }
      if (this.savedServerAuthorization?.url === url) {
        logger.info('Using OpenCode server credentials from VS Code secret storage; password=*');
        const health = await this.transport.readHealthInfo(signal);
        checkCurrent();
        if (health.healthy || !this.transport.healthError?.includes('authentication'))
          return health;
      }
    }

    const enteredUsername = await vscode.window.showInputBox({
      title: 'Connect to OpenCode server',
      prompt: `Authentication required for ${url}. Enter the server username.`,
      value: username,
      ignoreFocusOut: true,
      validateInput: (value) =>
        !value.trim()
          ? 'Enter a username'
          : value.includes(':')
            ? 'Username cannot contain :'
            : null,
    });
    checkCurrent();
    if (enteredUsername === undefined) return { healthy: false };
    const password = await vscode.window.showInputBox({
      title: 'Connect to OpenCode server',
      prompt: `Enter the password for ${url}. Verified credentials are saved in VS Code secret storage.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value ? null : 'Enter a password'),
    });
    checkCurrent();
    if (!password) return { healthy: false };
    this.savedServerAuthorization = {
      url,
      value: basicAuthorization(password, enteredUsername),
    };
    const health = await this.transport.readHealthInfo(signal);
    checkCurrent();
    if (health.healthy) {
      void withStartupDeadline(
        () => secrets.store(key, JSON.stringify({ username: enteredUsername, password })),
        STARTUP_CREDENTIAL_TIMEOUT_MS,
        'Server credential persistence'
      ).catch(() =>
        logger.warn('Could not persist verified OpenCode credentials in secret storage')
      );
    } else {
      this.savedServerAuthorization = undefined;
    }
    return health;
  }

  private startOperation(preserveRetryCount: boolean): Promise<string> {
    return this.setStartPromise(async (signal) => {
      this.startupOperationId = diagnosticTimeline.nextId('startup');
      try {
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

        if (
          this.process &&
          this._status.state !== 'running' &&
          !this.processManager.hasConfirmedManagedProcess
        ) {
          await this.processManager.stopServerForRestart();
          this.throwIfStartCancelled(disposeGeneration, signal);
        }
        const registered = await this.measureStartup('registration', () =>
          this.processManager.refreshStartupRegistration()
        );
        this.registeredEndpoint = registered;
        if (registered) await this.restoreRegistrationCredentials(signal);
        this.throwIfStartCancelled(disposeGeneration, signal);
        const probeExistingEndpoint =
          registered ||
          !this.processManager.isAutomaticPort ||
          (this.legacyDefaultEndpoint && !this.processManager.hasHistoricalRegistration) ||
          !this.processManager.isAutoStartEnabled;
        let health = probeExistingEndpoint
          ? await this.measureStartup('health', () => this.readHealthInfo(signal))
          : { healthy: false };
        this.throwIfStartCancelled(disposeGeneration, signal);
        if (
          !health.healthy &&
          probeExistingEndpoint &&
          this.transport.healthError?.includes('authentication') &&
          this.secrets
        ) {
          health = await this.recoverServerAuthentication(signal);
          this.throwIfStartCancelled(disposeGeneration, signal);
          if (!health.healthy) {
            const message =
              this.transport.healthError ?? 'Could not verify OpenCode server credentials.';
            this.setStatus({ state: 'error', message });
            throw new Error(message);
          }
        }
        if (
          probeExistingEndpoint &&
          this.transport.healthError?.startsWith('Unsupported OpenCode')
        ) {
          const message = this.transport.healthError;
          this.setStatus({ state: 'error', message });
          throw new Error(message);
        }
        if (
          probeExistingEndpoint &&
          !health.healthy &&
          this.transport.healthError?.includes('authentication')
        ) {
          const message = this.transport.healthError;
          this.setStatus({ state: 'error', message });
          throw new Error(message);
        }
        if (health.healthy && (await this.admitExistingEndpoint())) {
          this.throwIfStartCancelled(disposeGeneration, signal);
          this.preserveExistingProcess = true;
          this.externalEndpoint = !registered;
          if (isSupportedOpenCodeVersion(health.version)) {
            logger.info(`Found existing OpenCode server at ${this.url}`);
            const restored = await this.restoreManagedRuntimeConfigAtStartup(
              disposeGeneration,
              signal
            );
            if (restored) return restored;
            this.beginRunningEventStream();
            this.startExistingServerPreparation(disposeGeneration, signal);
            return this.url;
          }

          if (this.preserveExistingProcess || this.admission.isExternal)
            throw new Error(
              'The existing OpenCode server is unsupported and was left running. Update it explicitly when its sessions have finished.'
            );
          await this.replaceIncompatibleServer(health.version, disposeGeneration, signal);
          this.throwIfStartCancelled(disposeGeneration, signal);
        }

        if (registered)
          throw new Error(
            'The registered OpenCode process is still running but unavailable; it was left untouched.'
          );

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

        this.setStatus({ state: 'starting' });

        if (this.managedProcess || this.process) {
          await this.processManager.stopServerForRestart();
          this.throwIfStartCancelled(disposeGeneration, signal);
        }

        this.throwIfStartCancelled(disposeGeneration, signal);
        return await this.launchManagedServer(disposeGeneration, preserveRetryCount, signal);
      } catch (error) {
        if (!signal.aborted && !this.isDisposing && this._status.state !== 'error') {
          this.setStatus({
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    });
  }

  private async launchManagedServer(
    disposeGeneration: number,
    preserveRetryCount: boolean,
    signal: AbortSignal
  ): Promise<string> {
    this.throwIfStartCancelled(disposeGeneration, signal);
    const release = await this.measureStartup('claim', () =>
      this.processManager.acquireManagedServerLaunchClaim(signal)
    );
    try {
      // Another window may have published a server while this window waited.
      const registered = await this.processManager.refreshStartupRegistration();
      this.registeredEndpoint = registered;
      if (registered) await this.restoreRegistrationCredentials(signal);
      this.throwIfStartCancelled(disposeGeneration, signal);
      if (registered) {
        const health = await this.measureStartup('health', () => this.readHealthInfo(signal));
        this.throwIfStartCancelled(disposeGeneration, signal);
        if (!health.healthy || !isSupportedOpenCodeVersion(health.version))
          throw new Error(
            'The registered OpenCode process could not be reused and was left untouched'
          );
        await release();
        await this.admission.admit();
        this.throwIfStartCancelled(disposeGeneration, signal);
        this.preserveExistingProcess = true;
        this.externalEndpoint = false;
        await release();
        const restored = await this.restoreManagedRuntimeConfigAtStartup(disposeGeneration, signal);
        if (restored) return restored;
        this.beginRunningEventStream();
        this.startExistingServerPreparation(disposeGeneration, signal);
        return this.url;
      }
      // Recheck registration under the launch claim before any CLI update. A
      // window that lost the startup race must reuse the winner without updating it.
      await this.measureStartup('cli', () =>
        this.ensureCompatibleCliForLaunch(undefined, disposeGeneration, signal)
      );
      this.throwIfStartCancelled(disposeGeneration, signal);
      const sharedServer = this.processManager.discoverSharedServer();
      if (sharedServer && (await sharedServer)) {
        this.throwIfStartCancelled(disposeGeneration, signal);
        const managedRegistration =
          await this.processManager.refreshDiscoveredServerRegistration(signal);
        this.registeredEndpoint = managedRegistration;
        if (managedRegistration) await this.restoreRegistrationCredentials(signal);
        this.throwIfStartCancelled(disposeGeneration, signal);
        const health = await this.measureStartup('health', () => this.readHealthInfo(signal));
        this.throwIfStartCancelled(disposeGeneration, signal);
        if (!health.healthy || !isSupportedOpenCodeVersion(health.version)) {
          throw new Error('The registered OpenCode service is unavailable or unsupported');
        }
        logger.info(`Found shared OpenCode service at ${this.url}`);
        await release();
        await this.admission.admit();
        this.throwIfStartCancelled(disposeGeneration, signal);
        this.preserveExistingProcess = true;
        this.externalEndpoint = !managedRegistration;
        await release();
        const restored = await this.restoreManagedRuntimeConfigAtStartup(disposeGeneration, signal);
        if (restored) return restored;
        this.beginRunningEventStream();
        this.startExistingServerPreparation(disposeGeneration, signal);
        return this.url;
      }
      this.processManager.selectAutomaticPort();
      this.preserveExistingProcess = false;
      this.externalEndpoint = false;
      this.admission.reset();
      this.connectionMonitor.reset();
      await this.measureStartup('configuration', () => this.syncInjectedConfigFile());
      try {
        this.throwIfStartCancelled(disposeGeneration, signal);
      } catch (err) {
        await this.processManager.cleanupPreparedInjectedConfigFile();
        throw err;
      }
      return await this.launchPreparedManagedServer(disposeGeneration, preserveRetryCount, signal);
    } finally {
      await release();
    }
  }

  private async hasMissingRuntimeAskAgent(signal?: AbortSignal): Promise<boolean> {
    if (
      this.isAttachOnly ||
      !this.processManager.needsRuntimeConfigRecovery ||
      !(await this.processManager.shouldRestoreRuntimeAskAgent())
    ) {
      signal?.throwIfAborted();
      this.runtimeAskRecoveryPending = false;
      return false;
    }
    signal?.throwIfAborted();
    const agents = await this.transport.request(
      'GET',
      '/agent',
      undefined,
      signal ? { signal } : undefined
    );
    signal?.throwIfAborted();
    if (
      !Array.isArray(agents) ||
      agents.some((value) => {
        const name = asRecord(value)?.name;
        return typeof name !== 'string' || !name.trim();
      })
    )
      throw new Error('OpenCode returned an invalid agent catalog');
    this.runtimeAskRecoveryPending = !agents.some((value) => {
      const name = asRecord(value)?.name;
      return typeof name === 'string' && name.toLowerCase() === 'ask';
    });
    return this.runtimeAskRecoveryPending;
  }

  private async restoreManagedRuntimeConfigAtStartup(
    disposeGeneration: number,
    signal: AbortSignal
  ): Promise<string | undefined> {
    // A service replacement can retain our credentials but lose OPENCODE_CONFIG.
    // Restore the runtime before publishing running state and routing catalogs.
    // Ordinary reuse keeps the background ownership-preparation fast path.
    if (!this.processManager.hasRuntimeConfigRecoveryCandidate || this.isAttachOnly) return;
    this.startExistingServerPreparation(disposeGeneration, signal);
    await this.existingServerPreparationOperation;
    this.throwIfStartCancelled(disposeGeneration, signal);
    if (!(await this.hasMissingRuntimeAskAgent())) return;
    this.throwIfStartCancelled(disposeGeneration, signal);
    if ((await this.readRestartBlockers()).totalSessionCount > 0) return;
    this.throwIfStartCancelled(disposeGeneration, signal);
    const release = await this.processManager.acquireManagedServerRestartOwnership();
    try {
      this.throwIfStartCancelled(disposeGeneration, signal);
      // The claim protects ownership, not work submitted by other clients.
      if ((await this.readRestartBlockers()).totalSessionCount > 0) return;
      this.throwIfStartCancelled(disposeGeneration, signal);
      logger.info('Restoring Varro runtime Ask agent on the replaced managed OpenCode server');
      await this.stopServerForRestart(true);
    } finally {
      await release();
    }
    this.throwIfStartCancelled(disposeGeneration, signal);
    return this.launchManagedServer(disposeGeneration, false, signal);
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

      const attemptId = this.lifecycle.beginStartAttempt();
      const stderrLines: string[] = [];
      let attemptFinished = false;
      let operationSettled = false;
      let awaitedBoundaries = 0;
      let attemptProcess: ChildProcess | null = null;
      let attemptProcessExited = false;
      let attemptCleanup: Promise<void> | null = null;
      let outcomeCleanup: Promise<void> | null = null;
      let processLogWindowStartedAt = Date.now();
      let processLogChars = 0;
      let processLogEntries = 0;
      let processStderrDiagnosticChars = 0;
      let processLogDropReported = false;
      let processLogEntryTruncationReported = false;

      const refreshProcessLogWindow = () => {
        const now = Date.now();
        if (now - processLogWindowStartedAt >= PROCESS_OUTPUT_LOG_WINDOW_MS) {
          processLogWindowStartedAt = now;
          processLogChars = 0;
          processLogEntries = 0;
          processStderrDiagnosticChars = 0;
          processLogDropReported = false;
          processLogEntryTruncationReported = false;
        }
      };
      const processOutputLogAvailable = () => {
        refreshProcessLogWindow();
        if (
          processLogEntries < PROCESS_OUTPUT_LOG_MAX_ENTRIES &&
          processLogChars < PROCESS_OUTPUT_LOG_MAX_CHARS
        ) {
          return true;
        }
        if (!processLogDropReported) {
          processLogDropReported = true;
          logger.warn('Managed server output exceeded 128 KiB/s; suppressing excess output');
        }
        return false;
      };
      const logProcessOutput = (
        level: 'error' | 'info',
        rawText: string,
        sourceTruncated = false
      ) => {
        refreshProcessLogWindow();
        const prefix = '[server] ';
        const available =
          processLogEntries < PROCESS_OUTPUT_LOG_MAX_ENTRIES
            ? Math.min(
                PROCESS_OUTPUT_LOG_MAX_ENTRY_CHARS,
                Math.max(0, PROCESS_OUTPUT_LOG_MAX_CHARS - processLogChars - prefix.length)
              )
            : 0;
        const loggedChars = Math.min(rawText.length, available);
        const text = rawText.slice(0, loggedChars).trim();
        processLogChars += loggedChars;
        processLogEntries += 1;
        if (text) {
          const message = `${prefix}${text}`;
          processLogChars += prefix.length;
          if (level === 'error') logger.error(message);
          else logger.info(message);
        }
        if (
          (sourceTruncated || rawText.length > loggedChars) &&
          available === PROCESS_OUTPUT_LOG_MAX_ENTRY_CHARS &&
          !processLogEntryTruncationReported
        ) {
          processLogEntryTruncationReported = true;
          logger.warn('Managed server output chunk exceeded 16 KiB; truncating the chunk');
        }
        if (
          (processLogEntries >= PROCESS_OUTPUT_LOG_MAX_ENTRIES ||
            available < PROCESS_OUTPUT_LOG_MAX_ENTRY_CHARS) &&
          rawText.length > loggedChars &&
          !processLogDropReported
        ) {
          processLogDropReported = true;
          logger.warn('Managed server output exceeded 128 KiB/s; suppressing excess output');
        }
      };

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
            this.processManager.isAutomaticPort
              ? 'Automatic OpenCode port collision retries were exhausted. Retry startup or select an available integer port.'
              : `Port ${occupiedPort} is already in use. Explicit ports never fall back. Set varro.server.port to auto or an available integer between 1 and 65535.`
          );
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
          await awaitBoundary(this.admitManagedServer(signal));
          if (isInvalidAttempt()) {
            rejectCancelledAttempt();
            return;
          }
          this.processManager.resetPortRetryState();
          this.beginRunningEventStream();
          finishStartup(this.url);
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
            if (!processOutputLogAvailable()) return;
            const bounded = data.subarray(0, PROCESS_OUTPUT_LOG_MAX_ENTRY_CHARS * 4);
            logProcessOutput(
              'info',
              bounded.toString().slice(0, PROCESS_OUTPUT_LOG_MAX_ENTRY_CHARS),
              bounded.length < data.length
            );
          },
          onStderr: (data) => {
            const shouldLog = processOutputLogAvailable();
            const availableDiagnosticChars = Math.max(
              0,
              PROCESS_STDERR_DIAGNOSTIC_CHARS - processStderrDiagnosticChars
            );
            if (availableDiagnosticChars > 0 && !operationSettled) {
              const diagnostic = data
                .subarray(-Math.min(data.length, availableDiagnosticChars * 4))
                .toString()
                .slice(-availableDiagnosticChars);
              processStderrDiagnosticChars += diagnostic.length;
              const text = diagnostic.trim();
              rememberStderr(text);
              if (isPortInUseMessage(text)) {
                this.processManager.setPortInUseDetected(true);
              }
            } else if (!operationSettled) {
              const diagnostic = data
                .subarray(-PROCESS_STDERR_FALLBACK_DIAGNOSTIC_CHARS)
                .toString()
                .slice(-PROCESS_STDERR_FALLBACK_DIAGNOSTIC_CHARS)
                .trim();
              rememberStderr(diagnostic);
              if (isPortInUseMessage(diagnostic)) {
                this.processManager.setPortInUseDetected(true);
              }
            }
            if (shouldLog) {
              const bounded = data.subarray(0, PROCESS_OUTPUT_LOG_MAX_ENTRY_CHARS * 4);
              logProcessOutput(
                'error',
                bounded.toString().slice(0, PROCESS_OUTPUT_LOG_MAX_ENTRY_CHARS),
                bounded.length < data.length
              );
            }
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
        (probeSignal) =>
          awaitBoundary(this.measureStartup('health', () => this.readHealthInfo(probeSignal))),
        () =>
          awaitBoundary(
            this.measureStartup('ownership', () =>
              attemptProcess
                ? this.processManager.confirmManagedServerOwnership(attemptProcess)
                : Promise.resolve(false)
            )
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
    readHealth: (signal?: AbortSignal) => Promise<{ healthy: boolean; version?: string }> = (
      probeSignal
    ) => this.readHealthInfo(probeSignal),
    confirmOwnership: () => Promise<boolean> = () =>
      this.processManager.confirmManagedServerOwnership(),
    deadline = performance.now() + STARTUP_HEALTH_TIMEOUT_MS
  ) {
    if (
      signal?.aborted ||
      !this.lifecycle.isCurrentStartAttempt(startAttemptId, disposeGeneration)
    ) {
      reject(this.getCancellationError(signal));
      return;
    }
    if (performance.now() >= deadline) {
      this.cancelPollHealth();
      this.setStatus({ state: 'error', message: 'Server failed to start within timeout' });
      reject(new Error(`Server health check timed out after ${STARTUP_HEALTH_TIMEOUT_MS}ms`));
      return;
    }

    const pollOnce = async () => {
      this.pollHealthTimer = null;
      if (
        signal?.aborted ||
        !this.lifecycle.isCurrentStartAttempt(startAttemptId, disposeGeneration)
      ) {
        reject(this.getCancellationError(signal));
        return;
      }
      if (performance.now() >= deadline) {
        reject(new Error(`Server health check timed out after ${STARTUP_HEALTH_TIMEOUT_MS}ms`));
        return;
      }
      let health: { healthy: boolean; version?: string };
      try {
        health = await withStartupDeadline(
          (probeSignal) => readHealth(probeSignal),
          Math.max(1, deadline - performance.now()),
          'Server health check',
          signal
        );
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
        await this.admitManagedServer(signal);
        if (
          signal?.aborted ||
          !this.lifecycle.isCurrentStartAttempt(startAttemptId, disposeGeneration)
        ) {
          reject(this.getCancellationError(signal));
          return;
        }
        this.processManager.resetPortRetryState();
        this.beginRunningEventStream();
        resolve(this.url);
      } else if (/authentication|^Unsupported OpenCode/i.test(this.transport.healthError ?? '')) {
        reject(new Error(this.transport.healthError));
      } else {
        this.pollHealth(
          startAttemptId,
          disposeGeneration,
          resolve,
          reject,
          attempt + 1,
          signal,
          readHealth,
          confirmOwnership,
          deadline
        );
      }
    };
    this.pollHealthTimer = setTimeout(
      () => {
        // An unexpected throw must fail startup instead of leaving it pending.
        void pollOnce().catch((err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      },
      Math.min(200, Math.max(0, deadline - performance.now()))
    );
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    options?: OpenCodeRequestOptions
  ): Promise<unknown> {
    if (this.isTerminalCliUpgradeActive()) {
      throw new Error('OpenCode server is not accepting requests while the CLI is being updated');
    }
    const restartPromise = this.lifecycle.getRestartPromise<string>();
    if (restartPromise) await restartPromise;
    if (
      this.isTerminalCliUpgradeActive() ||
      this.lifecycle.phase === 'disposing' ||
      this.lifecycle.phase === 'restarting'
    ) {
      throw new Error('OpenCode server is not accepting requests while stopping');
    }
    if (method === 'GET' && new URL(path, 'http://localhost').pathname === '/agent') {
      // Catalog reads must observe a completed runtime repair, not a fake agent
      // which the server would reject when selected.
      options?.signal?.throwIfAborted();
      await this.reconcileManagedAskAgent();
      options?.signal?.throwIfAborted();
    }
    if (
      method === 'POST' &&
      /^\/session\/[^/]+\/(?:prompt_async|prompt|message|command|resume-steering)$/.test(
        new URL(path, 'http://localhost').pathname
      )
    ) {
      options?.signal?.throwIfAborted();
      // Do not leave the first send after editor reload waiting for the
      // five-minute maintenance interval to protect an owned idle backend.
      try {
        await this.reconcileManagedAskAgent();
      } catch (err) {
        logger.warn(
          `OpenCode Ask agent preflight failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        await this.reconcileManagedStreamTimeout();
      } catch (err) {
        logger.warn(
          `OpenCode stream timeout preflight failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      options?.signal?.throwIfAborted();
      if (
        this.isDisposing ||
        this.isTerminalCliUpgradeActive() ||
        this.lifecycle.getRestartPromise<string>()
      )
        throw new Error('OpenCode server is not accepting requests while stopping');
    }
    return this.transport.request(method, path, body, options);
  }

  async rescopeEventStream(directory?: string): Promise<OpenCodeRescopeResult> {
    const result = await this.transport.rescopeEventStream(directory);
    return this._status.state === 'running' ? result : { state: 'inactive', directory };
  }

  async readServerInfo(): Promise<OpenCodeServerInfo> {
    // About/diagnostics must not report a verified lease as unmanaged while its
    // asynchronous ownership observation or handoff is still being prepared.
    if (this.existingServerPreparationOperation) await this.existingServerPreparationOperation;
    let cliVersion: string | null = null;
    let cliVersionError: string | null = null;
    let activeAgentCount: number | null = null;
    let activeAgentError: string | null = null;

    try {
      // Local version inspection does not grant lifecycle rights to the connected server.
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
    const connectionUrl = this.url;
    const serverPid = this.transport.serverPid ?? this.processManager.managedProcessId;
    let connections: ServerConnectionInfo = {
      startedAt: null,
      vscodeClients: null,
      otherClients: null,
    };
    if (health.healthy && this._status.state === 'running') {
      connections = await readLocalServerConnectionInfo(this.processManager.port, serverPid);
    }
    let cliInstalledAt: number | null = null;
    if (install.found) {
      try {
        // stat follows CLI symlinks. Modification times can be package build dates,
        // so only use the local file creation time as an installation estimate.
        const { birthtimeMs } = await stat(install.resolvedCommand);
        if (Number.isFinite(birthtimeMs) && birthtimeMs > 0) cliInstalledAt = birthtimeMs;
      } catch {
        // Installation dates are best-effort when the CLI is missing or inaccessible.
      }
    }
    if (
      this.url !== connectionUrl ||
      this._status.state !== 'running' ||
      (this.transport.serverPid ?? this.processManager.managedProcessId) !== serverPid
    ) {
      connections = { startedAt: null, vscodeClients: null, otherClients: null };
    }

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
      cliInstalledAt,
      connections,
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
    await this.measureStartup('sse', () => this.transport.startEventStream());
  }

  private async admitExistingEndpoint(): Promise<boolean> {
    try {
      await this.measureStartup('admission', () => this.admission.admit());
      return true;
    } catch (error) {
      if (error instanceof SeparateAutomaticServerRequested) return false;
      this.setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async admitManagedServer(signal?: AbortSignal) {
    await this.measureStartup('admission', () => this.admission.admit());
    signal?.throwIfAborted();
    if (this.secrets) {
      const persistence = this.processManager.persistManagedServerCredentials(this.secrets);
      // Private lease credentials are already durable. This redundant vault copy
      // cannot retain the launch claim or alter connection state on completion.
      void this.measureStartup('credentials', () =>
        withStartupDeadline(
          () => persistence,
          STARTUP_CREDENTIAL_TIMEOUT_MS,
          'Managed credential persistence'
        )
      ).catch((error: unknown) => {
        logger.warn(
          `Could not copy managed credentials to secret storage; the private lease was retained: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
    signal?.throwIfAborted();
  }

  private async restoreRegistrationCredentials(signal?: AbortSignal) {
    if (!this.secrets) return;
    const secrets = this.secrets;
    try {
      await this.measureStartup('credentials', () =>
        this.processManager.restoreManagedServerCredentials(secrets, signal)
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (!this.processManager.serverAuthorization) throw error;
      logger.warn(
        `Managed secret storage unavailable; retaining the private lease credential: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private beginRunningEventStream() {
    // Start the subscription request before publishing running state so snapshot
    // reads triggered by that status cannot get ahead of the SSE subscription.
    const stream = this.startEventStream();
    this.setRunningStatus(this.url, 'degraded');
    void stream.catch((error: unknown) => {
      if (this.isDisposing) return;
      this.setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
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
    this.processManager.startMaintenanceLoop(() => this.runMaintenanceTickSafely());
  }

  private stopMaintenanceLoop() {
    this.processManager.stopMaintenanceLoop();
  }

  private requestMaintenanceCheck(force = false) {
    this.processManager.requestMaintenanceCheck(() => this.runMaintenanceTickSafely(), force);
  }

  private runMaintenanceTickSafely() {
    void this.runMaintenanceTick().catch((err: unknown) => {
      logger.warn(
        `OpenCode maintenance check failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  private reconcileManagedStreamTimeout(): Promise<void> {
    if (this.streamTimeoutReconciliationOperation) return this.streamTimeoutReconciliationOperation;
    const operation = this.runManagedStreamTimeoutReconciliation();
    this.streamTimeoutReconciliationOperation = operation;
    const finish = () => {
      if (this.streamTimeoutReconciliationOperation === operation)
        this.streamTimeoutReconciliationOperation = null;
    };
    void operation.then(finish, finish);
    return operation;
  }

  private reconcileManagedAskAgent(): Promise<void> {
    if (this.askAgentReconciliationOperation) return this.askAgentReconciliationOperation;
    const operation = this.runManagedAskAgentReconciliation();
    this.askAgentReconciliationOperation = operation;
    const finish = () => {
      if (this.askAgentReconciliationOperation === operation)
        this.askAgentReconciliationOperation = null;
    };
    void operation.then(finish, finish);
    return operation;
  }

  private async runManagedAskAgentReconciliation() {
    if (this.isDisposing || this.isTerminalCliUpgradeActive() || this._status.state !== 'running')
      return;
    const generation = this.disposeGeneration;
    const url = this.url;
    const current = () =>
      !this.isDisposing &&
      !this.isTerminalCliUpgradeActive() &&
      generation === this.disposeGeneration &&
      url === this.url &&
      this._status.state === 'running';
    const prepared = await withStartupDeadline(
      async (signal) => {
        if (this.existingServerPreparationOperation) await this.existingServerPreparationOperation;
        signal.throwIfAborted();
        if (!current() || !(await this.hasMissingRuntimeAskAgent(signal)) || !current())
          return false;
        const blockers = await this.readRestartBlockers(signal);
        signal.throwIfAborted();
        return current() && blockers.totalSessionCount === 0;
      },
      2000,
      'OpenCode Ask agent preparation'
    );
    if (!prepared || !current()) return;
    if (!(await this.processManager.refreshManagedServerOwnership()) || !current()) return;
    // runRestart reserves the lifecycle, drains requests, rechecks global work
    // and acquires verified ownership before stopping. Never force this repair.
    await this.runRestart(async () => {
      logger.info('Restoring Varro runtime Ask agent on the replaced managed OpenCode server');
      await this.processManager.stopServerForRestart();
    });
    this.runtimeAskRecoveryPending = false;
  }

  private async runManagedStreamTimeoutReconciliation() {
    if (
      this.isAttachOnly ||
      this.isDisposing ||
      this.isTerminalCliUpgradeActive() ||
      this._status.state !== 'running'
    )
      return;
    if (this.transport.version !== 2) return;
    const generation = this.disposeGeneration;
    const url = this.url;
    const current = () =>
      !this.isDisposing &&
      !this.isTerminalCliUpgradeActive() &&
      generation === this.disposeGeneration &&
      url === this.url &&
      this._status.state === 'running';
    // This best-effort repair also runs before sends. Only its read-only
    // preparation may time out; never race an owned config write or reload.
    const version = await withStartupDeadline(
      async (signal) => {
        if (this.existingServerPreparationOperation) await this.existingServerPreparationOperation;
        signal.throwIfAborted();
        if (!current() || !this.managedProcess || this.isAttachOnly) return undefined;
        const health = await this.readHealthInfo(signal);
        signal.throwIfAborted();
        if (
          !current() ||
          !health.healthy ||
          !health.version ||
          compareVersions(health.version, '2.0.20') < 0
        )
          return undefined;
        const directory = this.getWorkspaceCwd();
        const query = directory ? `?location[directory]=${encodeURIComponent(directory)}` : '';
        const provider = asRecord(
          asRecord(
            await this.transport.request('GET', `/api/provider/openai${query}`, undefined, {
              signal,
            })
          )?.data
        );
        signal.throwIfAborted();
        const settings = asRecord(provider?.settings);
        if (!settings)
          throw new Error('Could not inspect the effective OpenAI stream timeout policy');
        if ('chunkTimeout' in settings || 'timeout' in settings) return undefined;
        const blockers = await this.readRestartBlockers(signal);
        signal.throwIfAborted();
        return current() && blockers.totalSessionCount === 0 ? health.version : undefined;
      },
      2000,
      'OpenCode stream timeout preparation'
    );
    if (!version || !current()) return;
    if (!(await this.processManager.reconcileInjectedStreamTimeout(version))) return;
    // Reload cancels pending attention, so it must never be used as a way to
    // unstick an active execution. Recheck all workspaces and ownership first.
    const blockers = await withStartupDeadline(
      (signal) => this.readRestartBlockers(signal),
      2000,
      'OpenCode stream timeout reload verification'
    );
    if (!current() || blockers.totalSessionCount > 0) return;
    if (!(await this.processManager.refreshManagedServerOwnership()) || !current()) return;
    await this.transport.request('POST', '/global/dispose');
    logger.info(
      'Applied five-minute OpenAI stream silence protection to the reused managed server'
    );
  }

  private async runMaintenanceTick() {
    try {
      await this.reconcileManagedAskAgent();
    } catch (err) {
      logger.warn(
        `OpenCode Ask agent reconciliation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      await this.reconcileManagedStreamTimeout();
    } catch (err) {
      logger.warn(
        `OpenCode stream timeout reconciliation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (this.isAttachOnly || this.preserveExistingProcess) return;
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

    if (this.isAttachOnly) {
      const message = `OpenCode update required: ${observed}. Update OpenCode on the server host or rebuild the Docker image, then reconnect Varro. Local updates are not supported in attach-only mode.`;
      this.setStatus({ state: 'error', message, detail: { kind: 'generic' } });
      throw new Error(message);
    }

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
    await this.upgradeRunningServer(minimumVersion(serverVersion));
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
      // The connected server can predate an install or use a different CLI.
      // Every new launch must select its executable and flags from disk.
      this.processManager.clearResolvedCommandCache();
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
    if (Number(installedVersion.split('.')[0]) > 2) {
      const message = `Unsupported OpenCode CLI version: ${installedVersion}. Varro supports the v1 and v2 APIs.`;
      this.setStatus({ state: 'error', message });
      throw new Error(message);
    }

    const observed = observedServer || `the installed CLI is ${installedVersion}`;
    if (!this.processManager.isAutoUpdateEnabled) {
      this.failForRequiredUpdate(observed, 'Automatic updates are disabled.', {
        blockedBy: 'auto-update-disabled',
        settingId: 'varro.server.autoUpdate',
      });
    }

    logger.info(
      `Updating OpenCode CLI ${installedVersion} to meet Varro's minimum ${minimumVersion(installedVersion)}`
    );
    // Kept for the case below: `opencode upgrade` can print why it failed and
    // still exit 0, and that text is the only basis for actionable guidance.
    let upgradeDiagnostics = '';
    try {
      this.throwIfStartCancelled(disposeGeneration, signal);
      upgradeDiagnostics = await this.processManager.upgradeCli(minimumVersion(installedVersion));
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
        suggestedCommand: OPENCODE_INSTALL_COMMAND,
        settingId: 'varro.server.command',
        searchedPaths: install.searchedPaths,
      },
    };
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

  async readRestartBlockers(signal?: AbortSignal): Promise<RestartBlockedState> {
    // Use the transport directly: restart preflight runs after the lifecycle
    // has reserved the restart operation, while public request() intentionally
    // waits behind that operation.
    const observedSessionDirectories = this.transport.getObservedSessionDirectories();
    const blockingSessionIDs = new Set<string>();
    const directoriesBySessionID = new Map(observedSessionDirectories);
    const readSnapshot = async (directory?: string) => {
      signal?.throwIfAborted();
      const scope = directory ? { directory } : { unscoped: true };
      const options = signal ? { ...scope, signal } : scope;
      const [statuses, questions, permissions] = await Promise.all([
        this.transport.request('GET', '/session/status', undefined, options),
        this.transport.request('GET', '/question', undefined, options),
        this.transport.request('GET', '/permission', undefined, options),
      ]);
      signal?.throwIfAborted();
      return { directory, statuses, questions, permissions };
    };
    const collectSnapshot = (snapshot: Awaited<ReturnType<typeof readSnapshot>>) => {
      const { directory, statuses, questions, permissions } = snapshot;
      if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
        throw new Error('OpenCode returned an invalid session status response');
      }
      if (!Array.isArray(questions)) {
        throw new Error('OpenCode returned an invalid pending question response');
      }
      if (!Array.isArray(permissions)) {
        throw new Error('OpenCode returned an invalid pending permission response');
      }
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
        if (directory && !directoriesBySessionID.has(sessionID)) {
          directoriesBySessionID.set(sessionID, directory);
        }
        if (status.type === 'busy' || status.type === 'retry') blockingSessionIDs.add(sessionID);
      }
      for (const question of questions) {
        const sessionID = getSessionID(question);
        if (!sessionID) throw new Error('OpenCode returned an invalid pending question response');
        if (directory && !directoriesBySessionID.has(sessionID)) {
          directoriesBySessionID.set(sessionID, directory);
        }
        blockingSessionIDs.add(sessionID);
      }
      for (const permission of permissions) {
        const sessionID = getSessionID(permission);
        if (!sessionID) {
          throw new Error('OpenCode returned an invalid pending permission response');
        }
        if (directory && !directoriesBySessionID.has(sessionID)) {
          directoriesBySessionID.set(sessionID, directory);
        }
        blockingSessionIDs.add(sessionID);
      }
    };

    collectSnapshot(await readSnapshot());

    const sessionInventory = await this.transport.request(
      'GET',
      `/experimental/session?limit=${FULL_SESSION_LIST_LIMIT}`,
      undefined,
      signal ? { unscoped: true, signal } : { unscoped: true }
    );
    signal?.throwIfAborted();
    if (!Array.isArray(sessionInventory)) {
      throw new Error('OpenCode returned an invalid global session list');
    }
    if (sessionInventory.length >= FULL_SESSION_LIST_LIMIT) {
      throw new Error('OpenCode global session list exceeded the restart safety limit');
    }

    const probeDirectories = new Map<string, string>();
    for (const directory of observedSessionDirectories.values()) {
      const identity = normalizeWorkspaceIdentity(directory);
      if (identity) probeDirectories.set(identity, directory);
    }
    for (const value of sessionInventory) {
      if (!value || typeof value !== 'object') {
        throw new Error('OpenCode returned an invalid global session list');
      }
      const session = value as Record<string, unknown>;
      const id = typeof session.id === 'string' && session.id.trim() ? session.id : null;
      const directory = typeof session.directory === 'string' ? session.directory : null;
      const directoryIdentity = normalizeWorkspaceIdentity(directory);
      if (!id || !directory || !directoryIdentity) {
        throw new Error('OpenCode returned an invalid global session list');
      }
      directoriesBySessionID.set(id, directory);
      probeDirectories.set(directoryIdentity, directory);
    }

    const directories = [...probeDirectories.values()];
    const readDirectorySnapshot = async (directory: string) => {
      signal?.throwIfAborted();
      if (this.transport.hasGlobalSessionStatus) {
        try {
          await stat(directory);
          signal?.throwIfAborted();
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          // V2's global status above still catches running sessions in deleted
          // directories. Opening their old locations just to check attention
          // can fail with HTTP 500 and permanently prevent an idle restart.
          return null;
        }
      }
      return readSnapshot(directory);
    };
    for (let index = 0; index < directories.length; index += 8) {
      const snapshots = await Promise.all(
        directories.slice(index, index + 8).map(readDirectorySnapshot)
      );
      for (const snapshot of snapshots) {
        if (snapshot) collectSnapshot(snapshot);
      }
    }
    for (const sessionID of this.transport.getPendingAttentionSessionIDs()) {
      blockingSessionIDs.add(sessionID);
    }

    if (blockingSessionIDs.size === 0) {
      const result = { totalSessionCount: 0, directories: [] };
      this.lastRestartBlockers = result;
      return result;
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
      readLatestCliVersion: () => this.readLatestCliVersion(installedCliVersion),
      upgradeRunningServer: (targetVersion) => this.upgradeRunningServer(targetVersion),
      requestMaintenanceCheck: () => this.requestMaintenanceCheck(true),
      getWorkspaceCwd: () => this.getWorkspaceCwd(),
      prepareForWindowsCliUpgrade: (targetVersion) =>
        this.prepareForWindowsCliUpgrade(targetVersion),
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
  async prepareForWindowsCliUpgrade(targetVersion?: string) {
    if (process.platform !== 'win32') return;
    if (this.terminalCliUpgradePreparationOperation) {
      await this.terminalCliUpgradePreparationOperation;
    }
    if (this.terminalCliUpgradeFinishOperation) {
      await this.terminalCliUpgradeFinishOperation;
    }
    if (this.pendingTerminalCliUpgrades > 0) {
      throw new Error('An OpenCode update terminal is already open; close it before retrying');
    }

    const operation = this.prepareWindowsCliUpgrade(targetVersion);
    this.terminalCliUpgradePreparationOperation = operation;
    try {
      await operation;
    } finally {
      if (this.terminalCliUpgradePreparationOperation === operation) {
        this.terminalCliUpgradePreparationOperation = null;
      }
    }
  }

  private async prepareWindowsCliUpgrade(targetVersion?: string) {
    if (this.processManager.hasForeignActiveOwnership) {
      throw new Error(
        'The running OpenCode server is owned by another Varro window; close that window or stop its server before updating OpenCode'
      );
    }

    const shouldRestore = this.managedProcess;
    const workspaceIdentity = normalizeWorkspaceIdentity(this.getWorkspaceCwd());
    await this.transport.waitForRequestsToSettle();
    if (!this.managedProcess) {
      const health = await this.readHealthInfo();
      if (this._status.state === 'running' || health.healthy) {
        throw new Error(
          'A running OpenCode server is not owned by this Varro window; stop it before updating OpenCode'
        );
      }
    } else {
      await this.ensureSafeToStopLiveServer();
      await this.stopManagedProcessForRestart();
      this.setStatus({ state: 'stopped' });
    }

    this.restoreServerAfterTerminalCliUpgrade = shouldRestore;
    this.terminalCliUpgradeWorkspaceIdentity = workspaceIdentity;
    this.terminalCliUpgradeTargetVersion = targetVersion ?? null;
    this.pendingTerminalCliUpgrades = 1;
  }

  private isTerminalCliUpgradeActive(): boolean {
    return (
      this.terminalCliUpgradePreparationOperation !== null ||
      this.pendingTerminalCliUpgrades > 0 ||
      // Restoration publishes running before the finish operation resolves.
      // Snapshot requests triggered by that status must reach the restored server.
      (this.terminalCliUpgradeFinishOperation !== null && this._status.state !== 'running')
    );
  }

  async finishWindowsCliUpgrade() {
    if (process.platform !== 'win32') return;
    if (this.pendingTerminalCliUpgrades === 0) {
      if (this.terminalCliUpgradeFinishOperation) {
        await this.terminalCliUpgradeFinishOperation;
      }
      return;
    }

    this.pendingTerminalCliUpgrades -= 1;
    if (this.pendingTerminalCliUpgrades > 0) return;

    const shouldRestore = this.restoreServerAfterTerminalCliUpgrade;
    const workspaceIdentity = this.terminalCliUpgradeWorkspaceIdentity;
    const targetVersion = this.terminalCliUpgradeTargetVersion;
    this.restoreServerAfterTerminalCliUpgrade = false;
    this.terminalCliUpgradeWorkspaceIdentity = null;
    this.terminalCliUpgradeTargetVersion = null;

    const operation = (async () => {
      this.processManager.clearResolvedCommandCache();
      try {
        const installedVersion = await this.readInstalledCliVersion();
        if (!installedVersion) {
          logger.warn(
            'Windows OpenCode terminal update closed, but the installed CLI is unreadable'
          );
        } else if (targetVersion && compareVersions(installedVersion, targetVersion) < 0) {
          logger.warn(
            `Windows OpenCode terminal update closed, but CLI ${installedVersion} is older than requested ${targetVersion}`
          );
        } else {
          logger.info(`Verified installed OpenCode CLI ${installedVersion} after terminal update`);
        }
      } catch (err) {
        logger.warn(
          `Could not verify OpenCode CLI after terminal update: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (
        shouldRestore &&
        this.processManager.isAutoStartEnabled &&
        this.lifecycle.phase !== 'disposing' &&
        normalizeWorkspaceIdentity(this.getWorkspaceCwd()) === workspaceIdentity
      ) {
        try {
          await this.start();
        } catch (err) {
          logger.warn(
            `Failed to restore OpenCode server after terminal update: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    })();
    this.terminalCliUpgradeFinishOperation = operation;
    try {
      await operation;
    } finally {
      if (this.terminalCliUpgradeFinishOperation === operation) {
        this.terminalCliUpgradeFinishOperation = null;
      }
    }
  }

  private async readInstalledCliVersion(): Promise<string | null> {
    return this.processManager.readInstalledCliVersion();
  }

  private async readLatestCliVersion(installedVersion?: string | null): Promise<string | null> {
    return this.processManager.readLatestCliVersion(installedVersion);
  }

  private async readHealthInfo(
    signal?: AbortSignal
  ): Promise<{ healthy: boolean; version?: string }> {
    const url = this.url;
    const generation = this.disposeGeneration;
    const health = await this.transport.readHealthInfo(signal);
    signal?.throwIfAborted();
    if (
      health.healthy &&
      health.version &&
      url === this.url &&
      generation === this.disposeGeneration
    )
      this.processManager.rememberRunningServerVersion(health.version);
    return health;
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

  /** Attach-only endpoints may be Docker ports or tunnels, even on loopback. */
  get isAttachOnly(): boolean {
    return (
      this.externalEndpoint ||
      this.admission.isExternal ||
      (!this.processManager.isAutoStartEnabled && !this.managedProcess)
    );
  }

  restart(options: { force?: boolean } = {}): Promise<string> {
    if (this.isAttachOnly) {
      if (this._status.state !== 'running') return this.start();
      return Promise.reject(
        new Error(
          'Restart is not supported in attach-only mode. Restart OpenCode on its server host or with Docker, then reconnect Varro.'
        )
      );
    }
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
    const owned = await this.processManager.takeOwnershipOfExistingServer();
    // An error can mean attachment failed, not that a managed process needs
    // replacement. Retry startup so an existing service can authenticate and attach.
    if (!owned && !this.managedProcess && !this.process) return this.start();
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
      if (this.existingServerPreparationOperation) {
        await this.existingServerPreparationOperation;
        this.throwIfOperationCancelled(signal);
      }
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
    this.connectionMonitor.reset();
    this.admission.reset();
    this.pendingTerminalCliUpgrades = 0;
    this.restoreServerAfterTerminalCliUpgrade = false;
    this.terminalCliUpgradeWorkspaceIdentity = null;
    this.terminalCliUpgradeTargetVersion = null;
    this.lifecycle.beginDispose(OpenCodeServer.START_DISPOSED_MESSAGE);
    this.clearRestartTimer();
    this.clearRetryResetTimer();
    this.stopMaintenanceLoop();
    this.cancelPollHealth();
    this.stopEventStream();
    this.transport.clearPendingAttentionRequests();
    this.transport.abortRequests();
    await this.lifecycle.waitForOperationsSettlement();
    if (this.existingServerPreparationOperation) {
      await this.existingServerPreparationOperation;
    }
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
