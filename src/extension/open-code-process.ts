import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, win32 } from 'path';
import * as vscode from 'vscode';
import type { ServerStatus } from '../shared/protocol';
import { logger } from './logger';
import {
  compareVersions,
  extractVersion,
  isPortInUseMessage,
  waitForProcessExit,
} from './server-utils';
import { resolveServerLaunch } from './util/server-launch';
import { buildServerEnv, getServerPathEntries } from './util/server-path';

export function getOpenCodeConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform = process.platform
) {
  if (platform === 'win32') {
    const base = env.APPDATA?.trim() || win32.join(home, 'AppData', 'Roaming');
    return win32.join(base, 'opencode', 'opencode.json');
  }

  const base = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return join(base, 'opencode', 'opencode.json');
}

export interface OpenCodeCompactionSettings {
  auto: boolean | null;
  reserved: number | null;
}

export function normalizeCompactionSettings(
  value?: Partial<OpenCodeCompactionSettings>
): OpenCodeCompactionSettings {
  return {
    auto: typeof value?.auto === 'boolean' ? value.auto : null,
    reserved:
      typeof value?.reserved === 'number' && Number.isInteger(value.reserved) && value.reserved >= 0
        ? value.reserved
        : null,
  };
}

export function areCompactionSettingsEqual(
  left: OpenCodeCompactionSettings,
  right: OpenCodeCompactionSettings
): boolean {
  return left.auto === right.auto && left.reserved === right.reserved;
}

interface MaintenanceCallbacks {
  isDisposing: () => boolean;
  getStatus: () => ServerStatus;
  readInstalledCliVersion: () => Promise<string | null>;
  maybeSuggestCliUpdate: (installedCliVersion: string | null) => Promise<string | null>;
  readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
  hasActiveSessions: () => Promise<boolean>;
  restartServerForCliUpdate: (serverVersion: string, installedCliVersion: string) => Promise<void>;
}

interface MaybeSuggestCliUpdateCallbacks {
  readLatestCliVersion: () => Promise<string | null>;
  upgradeRunningServer: (targetVersion: string) => Promise<boolean>;
  getWorkspaceCwd: () => string | undefined;
  prepareForWindowsCliUpgrade: () => Promise<void>;
}

interface RestartCallbacks {
  beginManagedRestart: () => number | null;
  finishManagedRestart: () => void;
  stopManagedProcessForRestart: () => Promise<void>;
  start: () => Promise<string>;
}

interface UpdateCompactionSettingsCallbacks {
  status: ServerStatus;
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  restartManagedServerForCompactionSettings: () => Promise<void>;
}

interface LaunchCallbacks {
  getWorkspaceCwd: () => string | undefined;
  onStdout: (data: Buffer) => void;
  onStderr: (data: Buffer) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (err: Error) => void;
}

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

const PROCESS_COMMAND_TIMEOUT_MS = 2000;
const PROCESS_STOP_TIMEOUT_MS = 5000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePids(text: string) {
  const pids = new Set<number>();
  for (const match of text.matchAll(/\b\d+\b/g)) {
    const pid = Number.parseInt(match[0], 10);
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
      pids.add(pid);
    }
  }
  return [...pids];
}

function isOpenCodeCommand(command: string) {
  return command.toLowerCase().includes('opencode');
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs = PROCESS_COMMAND_TIMEOUT_MS
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let proc: ChildProcess | null = null;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      proc?.kill();
      finish({ stdout, stderr, code: null });
    }, timeoutMs);

    try {
      proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      finish({ stdout: '', stderr: err instanceof Error ? err.message : String(err), code: null });
      return;
    }

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('error', (err) => finish({ stdout, stderr: err.message, code: null }));
    proc.on('close', (code) => finish({ stdout, stderr, code }));
  });
}

async function findListeningPids(port: number) {
  if (process.platform === 'win32') {
    const script = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
    const result = await runProcess('powershell.exe', ['-NoProfile', '-Command', script]);
    return parsePids(result.stdout);
  }

  const result = await runProcess('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN']);
  return parsePids(result.stdout);
}

async function readProcessCommand(pid: number) {
  if (process.platform === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
    return (await runProcess('powershell.exe', ['-NoProfile', '-Command', script])).stdout.trim();
  }

  return (await runProcess('ps', ['-p', String(pid), '-o', 'command='])).stdout.trim();
}

async function findOpenCodeListenerPids(port: number) {
  const pids = await findListeningPids(port);
  const matches: number[] = [];
  for (const pid of pids) {
    const command = await readProcessCommand(pid);
    if (isOpenCodeCommand(command)) matches.push(pid);
  }
  return matches;
}

async function waitForPortListenersToExit(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await findListeningPids(port)).length === 0) return true;
    await delay(100);
  }
  return (await findListeningPids(port)).length === 0;
}

async function stopOpenCodeListenerOnPort(port: number) {
  const pids = await findOpenCodeListenerPids(port);
  if (pids.length === 0) return false;

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') throw err;
    }
  }

  if (await waitForPortListenersToExit(port, PROCESS_STOP_TIMEOUT_MS)) return true;

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') throw err;
    }
  }
  return true;
}

export class OpenCodeProcess {
  static readonly MISSING_CLI_MESSAGE =
    'OpenCode CLI not found. Install it with: npm install -g opencode-ai';

  private static readonly CLI_UPGRADE_COMMAND = 'opencode upgrade';
  private static readonly CLI_UPGRADE_ACTION = 'Run Upgrade';
  private static readonly CLI_COMMAND_TIMEOUT_MS = 5000;
  private static readonly CLI_BACKGROUND_UPGRADE_TIMEOUT_MS = 2 * 60_000;
  private static readonly VERSION_CHECK_INTERVAL_MS = 5 * 60_000;
  private static readonly CLI_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60_000;
  private static readonly CLI_REGISTRY_TIMEOUT_MS = 10_000;
  private static readonly MAX_EVENT_RECONNECT_DELAY_MS = 30_000;
  private static readonly PORT_FALLBACK_MAX_OFFSET = 10;

  private _process: ChildProcess | null = null;
  private _port: number;
  private readonly originalPort: number;
  private retries = 0;
  private readonly maxRetries = 3;
  private portFallbackAttempts = 0;
  private portInUseDetected = false;
  private readonly autoStart: boolean;
  private readonly command: string;
  private readonly simulateMissingCli: boolean;
  private _restartTimer: ReturnType<typeof setTimeout> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceInFlight = false;
  private _managedProcess = false;
  private lastCliUpdateCheckAt = 0;
  private lastSuggestedCliVersion = '';
  private lastLoggedUnmanagedRestartKey = '';
  private resolvedCommandCache: {
    key: string;
    value: string;
  } | null = null;
  private _processStdoutHandler: ((data: Buffer) => void) | null = null;
  private _processStderrHandler: ((data: Buffer) => void) | null = null;
  private _processExitHandler:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | null = null;
  private _processErrorHandler: ((err: Error) => void) | null = null;
  private compactionSettings: OpenCodeCompactionSettings;
  private injectedConfigContent = '{}\n';

  constructor(
    port: number,
    autoStart: boolean,
    command?: string,
    simulateMissingCli = false,
    compactionSettings?: Partial<OpenCodeCompactionSettings>
  ) {
    this._port = port;
    this.originalPort = port;
    this.autoStart = autoStart;
    this.command = command?.trim() || '';
    this.simulateMissingCli = simulateMissingCli;
    this.compactionSettings = normalizeCompactionSettings(compactionSettings);
  }

  get port(): number {
    return this._port;
  }

  set port(value: number) {
    this._port = value;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  get isAutoStartEnabled(): boolean {
    return this.autoStart;
  }

  get isSimulatingMissingCli(): boolean {
    return this.simulateMissingCli;
  }

  get process(): ChildProcess | null {
    return this._process;
  }

  set process(value: ChildProcess | null) {
    this._process = value;
  }

  get managedProcess(): boolean {
    return this._managedProcess;
  }

  set managedProcess(value: boolean) {
    this._managedProcess = value;
  }

  get restartTimer(): ReturnType<typeof setTimeout> | null {
    return this._restartTimer;
  }

  set restartTimer(value: ReturnType<typeof setTimeout> | null) {
    this._restartTimer = value;
  }

  get processStdoutHandler(): ((data: Buffer) => void) | null {
    return this._processStdoutHandler;
  }

  set processStdoutHandler(value: ((data: Buffer) => void) | null) {
    this._processStdoutHandler = value;
  }

  get processStderrHandler(): ((data: Buffer) => void) | null {
    return this._processStderrHandler;
  }

  set processStderrHandler(value: ((data: Buffer) => void) | null) {
    this._processStderrHandler = value;
  }

  get processExitHandler(): ((code: number | null, signal: NodeJS.Signals | null) => void) | null {
    return this._processExitHandler;
  }

  set processExitHandler(
    value: ((code: number | null, signal: NodeJS.Signals | null) => void) | null
  ) {
    this._processExitHandler = value;
  }

  get processErrorHandler(): ((err: Error) => void) | null {
    return this._processErrorHandler;
  }

  set processErrorHandler(value: ((err: Error) => void) | null) {
    this._processErrorHandler = value;
  }

  getRetryCount(): number {
    return this.retries;
  }

  resetRetryCount() {
    this.retries = 0;
  }

  incrementRetryCount(): number {
    this.retries += 1;
    return this.retries;
  }

  getMaxRetries(): number {
    return this.maxRetries;
  }

  clearRestartTimer() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  }

  prepareForHealthyExistingServer() {
    this._managedProcess = false;
    this.portFallbackAttempts = 0;
    this.portInUseDetected = false;
  }

  resetPortRetryState() {
    this.portFallbackAttempts = 0;
    this.portInUseDetected = false;
  }

  setPortInUseDetected(value: boolean) {
    this.portInUseDetected = value;
  }

  hasPortInUseDetected(): boolean {
    return this.portInUseDetected;
  }

  tryAdvancePort(): boolean {
    if (this.portFallbackAttempts >= OpenCodeProcess.PORT_FALLBACK_MAX_OFFSET) return false;
    this.portFallbackAttempts += 1;
    this._port = this.originalPort + this.portFallbackAttempts;
    return true;
  }

  getRestartDelay(attempt: number) {
    return Math.min(
      1000 * 2 ** Math.max(0, attempt - 1),
      OpenCodeProcess.MAX_EVENT_RECONNECT_DELAY_MS
    );
  }

  async syncInjectedConfigFile() {
    this.injectedConfigContent = await this.serializeInjectedConfig();
  }

  async serializeInjectedConfig() {
    const compaction = {
      ...(this.compactionSettings.auto !== null ? { auto: this.compactionSettings.auto } : {}),
      ...(this.compactionSettings.reserved !== null
        ? { reserved: this.compactionSettings.reserved }
        : {}),
    };
    const config = {
      ...(await this.readBaseConfig()),
      $schema: 'https://opencode.ai/config.json',
      ...(Object.keys(compaction).length > 0 ? { compaction } : {}),
    };
    return `${JSON.stringify(config, null, 2)}\n`;
  }

  private async readBaseConfig() {
    const configPath = getOpenCodeConfigPath();
    try {
      const raw = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn(`Ignoring invalid OpenCode config at ${configPath}: expected an object`);
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code === 'ENOENT') return {};
      logger.warn(
        `Failed to read OpenCode config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      return {};
    }
  }

  hasInjectedCompactionOverride() {
    return this.compactionSettings.auto !== null || this.compactionSettings.reserved !== null;
  }

  async updateCompactionSettings(
    value: Partial<OpenCodeCompactionSettings> | undefined,
    callbacks: UpdateCompactionSettingsCallbacks
  ) {
    const next = normalizeCompactionSettings(value);
    const changed = !areCompactionSettingsEqual(this.compactionSettings, next);
    this.compactionSettings = next;
    await this.syncInjectedConfigFile();
    if (!changed || callbacks.status.state !== 'running') return;
    await this.reapplyCompactionSettings(callbacks);
  }

  async reapplyCompactionSettings(callbacks: UpdateCompactionSettingsCallbacks) {
    if (!this._process || !this._managedProcess) {
      logger.warn(
        'Varro chat auto-compaction settings can only be reapplied automatically for a Varro-managed OpenCode server'
      );
      return;
    }
    try {
      await callbacks.request('POST', '/global/dispose');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `Failed to dispose OpenCode instances after compaction setting change: ${message}`
      );
      await callbacks.restartManagedServerForCompactionSettings();
    }
  }

  launchServer(callbacks: LaunchCallbacks) {
    const command = this.resolveCommand();
    const args = ['serve', '--port', String(this._port)];
    const launch = resolveServerLaunch(command, args);
    logger.info(`Starting OpenCode server with command: ${command}`);

    this._process = spawn(launch.command, launch.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      cwd: callbacks.getWorkspaceCwd(),
      env: this.buildServerEnv(),
      windowsHide: true,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    this._managedProcess = true;

    this._processStdoutHandler = callbacks.onStdout;
    this._processStderrHandler = callbacks.onStderr;
    this._processExitHandler = callbacks.onExit;
    this._processErrorHandler = callbacks.onError;
    this._process.stdout?.on('data', this._processStdoutHandler);
    this._process.stderr?.on('data', this._processStderrHandler);
    this._process.on('exit', this._processExitHandler);
    this._process.on('error', this._processErrorHandler);
  }

  detachProcessListeners(proc: ChildProcess | null) {
    if (!proc) return;
    if (this._processStdoutHandler) {
      proc.stdout?.off('data', this._processStdoutHandler);
    }
    if (this._processStderrHandler) {
      proc.stderr?.off('data', this._processStderrHandler);
    }
    if (this._processExitHandler) {
      proc.off('exit', this._processExitHandler);
    }
    if (this._processErrorHandler) {
      proc.off('error', this._processErrorHandler);
    }
    this._processStdoutHandler = null;
    this._processStderrHandler = null;
    this._processExitHandler = null;
    this._processErrorHandler = null;
  }

  async stopManagedProcessForRestart() {
    this.clearRestartTimer();
    const proc = this._process;
    this._process = null;
    this._managedProcess = false;
    if (!proc) return;
    this.detachProcessListeners(proc);

    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
    }
    const exited = await waitForProcessExit(proc, 5000);
    if (!exited && proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
    }
  }

  async stopServerForRestart() {
    this.clearRestartTimer();
    const ports = [...new Set([this._port, this.originalPort])];
    if (this._process && this._managedProcess) {
      await this.stopManagedProcessForRestart();
    } else if (this._process) {
      this.detachProcessListeners(this._process);
      this._process = null;
      this._managedProcess = false;
    }

    for (const port of ports) {
      try {
        await stopOpenCodeListenerOnPort(port);
      } catch (err) {
        logger.warn(
          `Failed to stop OpenCode listener on port ${port}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    this._port = this.originalPort;
    this.portFallbackAttempts = 0;
    this.portInUseDetected = false;
  }

  async disposeProcess(options: { stopProcess: boolean }) {
    if (options.stopProcess) {
      this._port = this.originalPort;
      this.portFallbackAttempts = 0;
      this.portInUseDetected = false;
    }
    if (options.stopProcess && this._process) {
      const proc = this._process;
      this._process = null;
      this._managedProcess = false;
      this.detachProcessListeners(proc);
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
      }
      const exited = await waitForProcessExit(proc, 5000);
      if (!exited && proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
      }
    } else if (!options.stopProcess && this._process) {
      this.detachProcessListeners(this._process);
      this._process = null;
      this._managedProcess = false;
    }
  }

  startMaintenanceLoop(tick: () => void) {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      tick();
    }, OpenCodeProcess.VERSION_CHECK_INTERVAL_MS);
  }

  stopMaintenanceLoop() {
    if (!this.maintenanceTimer) return;
    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }

  requestMaintenanceCheck(tick: () => void) {
    tick();
  }

  async runMaintenanceTick(callbacks: MaintenanceCallbacks) {
    if (this.maintenanceInFlight || callbacks.isDisposing()) return;
    this.maintenanceInFlight = true;
    try {
      const installedCliVersion = await callbacks.readInstalledCliVersion();
      const updatedCliVersion = await callbacks.maybeSuggestCliUpdate(installedCliVersion);
      const restartCliVersion = updatedCliVersion || installedCliVersion;

      if (callbacks.getStatus().state !== 'running' || !restartCliVersion) {
        return;
      }

      const health = await callbacks.readHealthInfo();
      const serverVersion = typeof health.version === 'string' ? health.version.trim() : '';
      if (!health.healthy || !serverVersion) {
        return;
      }

      if (compareVersions(restartCliVersion, serverVersion) <= 0) {
        this.lastLoggedUnmanagedRestartKey = '';
        return;
      }

      if (await callbacks.hasActiveSessions()) {
        return;
      }

      if ((!this._process || !this._managedProcess) && !this.autoStart) {
        const key = `${serverVersion}->${restartCliVersion}`;
        if (this.lastLoggedUnmanagedRestartKey !== key) {
          this.lastLoggedUnmanagedRestartKey = key;
          logger.info(
            `OpenCode CLI ${restartCliVersion} is newer than running server ${serverVersion}, but Varro server auto-start is disabled; skipping automatic restart`
          );
        }
        return;
      }

      this.lastLoggedUnmanagedRestartKey = '';
      await callbacks.restartServerForCliUpdate(serverVersion, restartCliVersion);
    } catch (err) {
      logger.warn(
        `OpenCode background maintenance failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.maintenanceInFlight = false;
    }
  }

  async restartServerForCliUpdate(
    serverVersion: string,
    installedCliVersion: string,
    callbacks: RestartCallbacks & { stopServerForRestart: () => Promise<void> }
  ) {
    if (callbacks.beginManagedRestart() === null) return;
    try {
      logger.info(
        `Restarting OpenCode server to use CLI ${installedCliVersion} instead of server ${serverVersion}`
      );
      await callbacks.stopServerForRestart();
      await callbacks.start();
    } finally {
      callbacks.finishManagedRestart();
    }
  }

  async restartManagedServerForCompactionSettings(callbacks: RestartCallbacks) {
    if (callbacks.beginManagedRestart() === null) return;
    try {
      logger.info('Restarting managed OpenCode server to apply updated Varro compaction settings');
      await callbacks.stopManagedProcessForRestart();
      await callbacks.start();
    } finally {
      callbacks.finishManagedRestart();
    }
  }

  async maybeSuggestCliUpdate(
    installedCliVersion: string | null,
    callbacks: MaybeSuggestCliUpdateCallbacks
  ): Promise<string | null> {
    if (!installedCliVersion) return null;

    const now = Date.now();
    if (now - this.lastCliUpdateCheckAt < OpenCodeProcess.CLI_UPDATE_CHECK_INTERVAL_MS) {
      return null;
    }
    this.lastCliUpdateCheckAt = now;

    const latestCliVersion = await callbacks.readLatestCliVersion();
    if (!latestCliVersion || compareVersions(latestCliVersion, installedCliVersion) <= 0) {
      return null;
    }

    if (this.isBackgroundCliAutoUpdateEnabled() && process.platform !== 'win32') {
      if (this.lastSuggestedCliVersion === latestCliVersion) {
        return null;
      }
      try {
        await this.runBackgroundCliUpgrade(installedCliVersion, latestCliVersion, callbacks);
        this.lastSuggestedCliVersion = latestCliVersion;
        return latestCliVersion;
      } catch (err) {
        logger.warn(
          `Failed to auto-update OpenCode CLI in background: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (this.lastSuggestedCliVersion === latestCliVersion) {
      return null;
    }
    this.lastSuggestedCliVersion = latestCliVersion;

    const upgradeCommand = OpenCodeProcess.CLI_UPGRADE_COMMAND;
    const message = `OpenCode CLI ${latestCliVersion} is available (installed: ${installedCliVersion}). Update with: ${upgradeCommand}`;
    logger.info(message);
    void vscode.window
      .showInformationMessage(message, OpenCodeProcess.CLI_UPGRADE_ACTION)
      .then(async (action) => {
        if (action === OpenCodeProcess.CLI_UPGRADE_ACTION) {
          if (await callbacks.upgradeRunningServer(latestCliVersion)) return;
          await this.runTerminalCliUpgrade(callbacks);
        }
      });
    return null;
  }

  async readInstalledCliVersion(): Promise<string | null> {
    if (this.simulateMissingCli) {
      return null;
    }

    try {
      const output = await this.runCliCommand(['--version']);
      return extractVersion(output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ENOENT') || message.includes(OpenCodeProcess.MISSING_CLI_MESSAGE)) {
        return null;
      }
      throw err;
    }
  }

  async readLatestCliVersion(): Promise<string | null> {
    try {
      const res = await fetch('https://registry.npmjs.org/opencode-ai/latest', {
        signal: AbortSignal.timeout(OpenCodeProcess.CLI_REGISTRY_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch latest OpenCode CLI version: ${res.status}`);
      }
      const data = (await res.json()) as { version?: unknown };
      return typeof data.version === 'string' ? extractVersion(data.version) : null;
    } catch (err) {
      logger.warn(
        `Failed to check for OpenCode CLI updates: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  private isBackgroundCliAutoUpdateEnabled() {
    return vscode.workspace.getConfiguration('varro').get<boolean>('server.autoUpdate', false);
  }

  private async runBackgroundCliUpgrade(
    installedCliVersion: string,
    latestCliVersion: string,
    callbacks: MaybeSuggestCliUpdateCallbacks
  ) {
    logger.info(
      `Automatically updating OpenCode CLI from ${installedCliVersion} to ${latestCliVersion} in background`
    );
    if (await callbacks.upgradeRunningServer(latestCliVersion)) {
      logger.info(
        `Updated OpenCode CLI to ${latestCliVersion} through the running OpenCode server`
      );
      return;
    }
    await this.runCliCommand(['upgrade'], OpenCodeProcess.CLI_BACKGROUND_UPGRADE_TIMEOUT_MS);
    logger.info(`Updated OpenCode CLI to ${latestCliVersion} in background`);
  }

  private async runTerminalCliUpgrade(callbacks: MaybeSuggestCliUpdateCallbacks) {
    if (process.platform === 'win32') {
      await callbacks.prepareForWindowsCliUpgrade();
    }
    this.runInTerminal(OpenCodeProcess.CLI_UPGRADE_COMMAND, 'OpenCode Upgrade', callbacks);
  }

  resolveCommand(): string {
    if (this.command) return this.command;

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

  private buildServerEnv(): NodeJS.ProcessEnv {
    const env = buildServerEnv();
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'opencode_config') delete env[key];
    }
    env.OPENCODE_CONFIG_CONTENT = this.injectedConfigContent;
    return env;
  }

  private async runCliCommand(
    args: string[],
    timeoutMs = OpenCodeProcess.CLI_COMMAND_TIMEOUT_MS
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let proc: ChildProcess | null = null;
      let handleStdout: ((data: Buffer) => void) | null = null;
      let handleStderr: ((data: Buffer) => void) | null = null;

      const finish = (result: { output?: string; error?: Error }) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (proc) {
          proc.removeAllListeners();
          if (handleStdout) proc.stdout?.off('data', handleStdout);
          if (handleStderr) proc.stderr?.off('data', handleStderr);
          proc = null;
          handleStdout = null;
          handleStderr = null;
        }
        if (result.error) {
          reject(result.error);
          return;
        }
        resolve(result.output || '');
      };

      try {
        const command = this.resolveCommand();
        const launch = resolveServerLaunch(command, args);
        proc = spawn(launch.command, launch.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: this.getWorkspaceCwd(),
          env: this.buildServerEnv(),
          windowsHide: true,
          ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });

        handleStdout = (data: Buffer) => {
          stdout += data.toString();
        };
        handleStderr = (data: Buffer) => {
          stderr += data.toString();
          if (isPortInUseMessage(data.toString())) {
            this.portInUseDetected = true;
          }
        };
        proc.stdout?.on('data', handleStdout);
        proc.stderr?.on('data', handleStderr);
        proc.once('error', (err) => {
          finish({
            error: err.message.includes('ENOENT')
              ? new Error(OpenCodeProcess.MISSING_CLI_MESSAGE)
              : err,
          });
        });
        proc.once('exit', (code, signal) => {
          if (code === 0) {
            finish({ output: stdout.trim() });
            return;
          }
          const message =
            stderr.trim() ||
            stdout.trim() ||
            `OpenCode CLI command failed${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}`;
          finish({ error: new Error(message) });
        });

        timer = setTimeout(() => {
          const runningProc = proc;
          if (runningProc && runningProc.exitCode === null && runningProc.signalCode === null) {
            runningProc.kill('SIGKILL');
          }
          finish({ error: new Error('OpenCode CLI command timed out') });
        }, timeoutMs);
      } catch (err) {
        finish({ error: err instanceof Error ? err : new Error(String(err)) });
      }
    });
  }

  private runInTerminal(
    command: string,
    title: string,
    callbacks: { getWorkspaceCwd: () => string | undefined }
  ) {
    const text = command.trim();
    if (!text) return;

    const terminal = vscode.window.createTerminal({
      name: title,
      cwd: callbacks.getWorkspaceCwd(),
    });
    terminal.show(false);
    terminal.sendText(text, true);
  }

  getWorkspaceCwd(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    if (activeFolder) {
      return activeFolder.uri.fsPath;
    }

    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0]!.uri.fsPath : undefined;
  }

  private serverPathEntries(): string[] {
    return getServerPathEntries();
  }

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
}
