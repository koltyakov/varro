import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, join, win32 } from 'path';
import * as vscode from 'vscode';
import { MAXIMUM_TESTED_OPENCODE_VERSION } from '../shared/opencode-compatibility';
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

export function getOpenCodeConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform = process.platform
) {
  const configured = env.XDG_CONFIG_HOME?.trim();
  if (platform === 'win32') {
    return win32.join(configured || win32.join(home, '.config'), 'opencode');
  }

  return join(configured || join(home, '.config'), 'opencode');
}

export function getOpenCodeConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform = process.platform
) {
  const directory = getOpenCodeConfigDirectory(env, home, platform);
  const pathJoin = platform === 'win32' ? win32.join : join;
  return ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) =>
    pathJoin(directory, name)
  );
}

export function getOpenCodeConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform = process.platform
) {
  return getOpenCodeConfigPaths(env, home, platform)[1]!;
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
const INJECTED_CONFIG_DIRECTORY_PREFIX = 'varro-opencode-config-';
const INJECTED_CONFIG_OWNER_FILE = 'owner.json';
const STALE_INJECTED_CONFIG_AGE_MS = 7 * 24 * 60 * 60_000;
let staleConfigSweep: Promise<void> = Promise.resolve();

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
  if (process.platform === 'win32') {
    const pids = await findListeningPids(port);
    if (pids.length === 0) return false;
    throw new Error(
      `Port ${port} is occupied by a process Varro does not own; stop it explicitly before restarting`
    );
  }

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

function getEnvironmentValue(env: NodeJS.ProcessEnv, name: string) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function setEnvironmentValue(env: NodeJS.ProcessEnv, name: string, value: string) {
  for (const key of Object.keys(env)) {
    if (key !== name && key.toLowerCase() === name.toLowerCase()) delete env[key];
  }
  env[name] = value;
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function sweepStaleInjectedConfigDirectories(now = Date.now()): Promise<void> {
  const sweep = async () => {
    let entries;
    try {
      entries = await readdir(tmpdir(), { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || !entry.name.startsWith(INJECTED_CONFIG_DIRECTORY_PREFIX))
          return;
        const directory = join(tmpdir(), entry.name);
        try {
          const info = await lstat(directory);
          if (!info.isDirectory() || now - info.mtimeMs < STALE_INJECTED_CONFIG_AGE_MS) return;
          try {
            const owner = JSON.parse(
              await readFile(join(directory, INJECTED_CONFIG_OWNER_FILE), 'utf-8')
            ) as { pid?: unknown };
            if (typeof owner.pid === 'number' && isProcessAlive(owner.pid)) return;
          } catch {}
          await rm(directory, { recursive: true, force: true });
        } catch {}
      })
    );
  };
  staleConfigSweep = staleConfigSweep.then(sweep, sweep);
  return staleConfigSweep;
}

// Owns OpenCode spawn and termination mechanics; OpenCodeServer owns lifecycle and retry policy.
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
  private static readonly PORT_FALLBACK_MAX_OFFSET = 10;

  private _process: ChildProcess | null = null;
  private _port: number;
  private readonly originalPort: number;
  private portFallbackAttempts = 0;
  private portInUseDetected = false;
  private readonly autoStart: boolean;
  private readonly command: string;
  private readonly simulateMissingCli: boolean;
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
  private injectedConfigPath: string | null = null;
  private injectedConfigOwnerPid: number | null = null;
  private injectedConfigOperation: Promise<void> = Promise.resolve();

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

  get isAutoUpdateEnabled(): boolean {
    return vscode.workspace.getConfiguration('varro').get<boolean>('server.autoUpdate', true);
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

  async prepareForHealthyExistingServer() {
    this._managedProcess = false;
    this.portFallbackAttempts = 0;
    this.portInUseDetected = false;
    await this.cleanupInjectedConfigFile();
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

  async syncInjectedConfigFile() {
    await this.runInjectedConfigOperation(async () => {
      await sweepStaleInjectedConfigDirectories();
      if (!this.hasInjectedCompactionOverride()) {
        await this.removeInjectedConfigFile(this.injectedConfigPath);
        return;
      }
      if (getEnvironmentValue(process.env, 'OPENCODE_CONFIG')?.trim()) {
        await this.removeInjectedConfigFile(this.injectedConfigPath);
        logger.warn(
          'Preserving caller-provided OPENCODE_CONFIG; Varro compaction settings are not injected for this managed server'
        );
        return;
      }

      if (this.injectedConfigPath && !this._process && !this.injectedConfigOwnerPid) {
        await this.removeInjectedConfigFile(this.injectedConfigPath);
      }
      const directory = await mkdtemp(join(tmpdir(), INJECTED_CONFIG_DIRECTORY_PREFIX));
      const configPath = join(directory, 'opencode.json');
      try {
        await writeFile(configPath, await this.serializeInjectedConfig(), 'utf-8');
        this.injectedConfigPath = configPath;
        this.injectedConfigOwnerPid = null;
      } catch (err) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    });
  }

  async serializeInjectedConfig() {
    const compaction = {
      ...(this.compactionSettings.auto !== null ? { auto: this.compactionSettings.auto } : {}),
      ...(this.compactionSettings.reserved !== null
        ? { reserved: this.compactionSettings.reserved }
        : {}),
    };
    const config = Object.keys(compaction).length > 0 ? { compaction } : {};
    return `${JSON.stringify(config, null, 2)}\n`;
  }

  async cleanupPreparedInjectedConfigFile() {
    await this.cleanupInjectedConfigFile();
  }

  private cleanupInjectedConfigFile(configPath = this.injectedConfigPath) {
    return this.runInjectedConfigOperation(() => this.removeInjectedConfigFile(configPath));
  }

  private async removeInjectedConfigFile(configPath: string | null) {
    if (!configPath) return;
    if (this.injectedConfigPath === configPath) {
      this.injectedConfigPath = null;
      this.injectedConfigOwnerPid = null;
    }
    try {
      await rm(dirname(configPath), { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `Failed to clean up temporary OpenCode config: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private runInjectedConfigOperation(operation: () => Promise<void>) {
    const result = this.injectedConfigOperation.then(operation, operation);
    this.injectedConfigOperation = result.catch(() => {});
    return result;
  }

  private async rewriteInjectedConfigFile() {
    const configPath = this.injectedConfigPath;
    if (!configPath) return;
    await this.runInjectedConfigOperation(async () => {
      if (this.injectedConfigPath !== configPath) return;
      await writeFile(configPath, await this.serializeInjectedConfig(), 'utf-8');
    });
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
    await this.rewriteInjectedConfigFile();
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

    const configPath = this.injectedConfigPath;
    try {
      this._process = spawn(launch.command, launch.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        cwd: callbacks.getWorkspaceCwd(),
        env: this.buildServerEnv(configPath),
        windowsHide: true,
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      void this.cleanupInjectedConfigFile(configPath);
      throw err;
    }
    try {
      this.bindInjectedConfigOwner(configPath, this._process);
    } catch (err) {
      const proc = this._process;
      this._process = null;
      if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      void this.cleanupInjectedConfigFile(configPath);
      throw err;
    }
    this._managedProcess = true;

    this._processStdoutHandler = callbacks.onStdout;
    this._processStderrHandler = callbacks.onStderr;
    if (configPath) {
      this._process.once('exit', () => void this.cleanupInjectedConfigFile(configPath));
    }
    this._processExitHandler = callbacks.onExit;
    this._processErrorHandler = (err) => {
      if (!configPath) {
        callbacks.onError(err);
        return;
      }
      void this.cleanupInjectedConfigFile(configPath).then(() => callbacks.onError(err));
    };
    this._process.stdout?.on('data', this._processStdoutHandler);
    this._process.stderr?.on('data', this._processStderrHandler);
    this._process.on('exit', this._processExitHandler);
    this._process.on('error', this._processErrorHandler);
  }

  private bindInjectedConfigOwner(configPath: string | null, proc: ChildProcess) {
    if (!configPath) return;
    if (!proc.pid) {
      throw new Error('Failed to bind temporary OpenCode config to the managed child process');
    }
    writeFileSync(
      join(dirname(configPath), INJECTED_CONFIG_OWNER_FILE),
      `${JSON.stringify({ pid: proc.pid, createdAt: Date.now() })}\n`,
      'utf-8'
    );
    if (this.injectedConfigPath === configPath) this.injectedConfigOwnerPid = proc.pid;
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
    const proc = this._process;
    const configPath = this.injectedConfigPath;
    this._process = null;
    this._managedProcess = false;
    if (!proc) {
      await this.cleanupInjectedConfigFile(configPath);
      return;
    }
    this.detachProcessListeners(proc);
    try {
      await this.terminateManagedProcess(proc);
    } finally {
      await this.cleanupInjectedConfigFile(configPath);
    }
  }

  private async terminateManagedProcess(proc: ChildProcess) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
    }
    const exited = await waitForProcessExit(proc, PROCESS_STOP_TIMEOUT_MS);
    if (process.platform !== 'win32') {
      if (!exited && proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
      }
      return;
    }

    if (!exited && proc.pid) {
      await runProcess(
        'taskkill.exe',
        ['/PID', String(proc.pid), '/T', '/F'],
        PROCESS_STOP_TIMEOUT_MS
      );
    }

    if (!(await waitForPortListenersToExit(this._port, PROCESS_STOP_TIMEOUT_MS))) {
      throw new Error(`Port ${this._port} is still occupied after stopping managed OpenCode`);
    }
  }

  async stopServerForRestart() {
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
        if (process.platform === 'win32') throw err;
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
      const configPath = this.injectedConfigPath;
      this._process = null;
      this._managedProcess = false;
      this.detachProcessListeners(proc);
      try {
        await this.terminateManagedProcess(proc);
      } finally {
        await this.cleanupInjectedConfigFile(configPath);
      }
    } else if (!options.stopProcess && this._process) {
      this.detachProcessListeners(this._process);
      this._process = null;
      this._managedProcess = false;
    } else if (!options.stopProcess && this.injectedConfigOwnerPid) {
      return;
    } else {
      await this.cleanupInjectedConfigFile();
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

    const exceedsTestedCeiling =
      compareVersions(latestCliVersion, MAXIMUM_TESTED_OPENCODE_VERSION) > 0;
    if (
      !exceedsTestedCeiling &&
      this.isBackgroundCliAutoUpdateEnabled() &&
      process.platform !== 'win32'
    ) {
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
    const message = exceedsTestedCeiling
      ? `OpenCode CLI ${latestCliVersion} is available, but Varro has only been tested through ${MAXIMUM_TESTED_OPENCODE_VERSION}. Review compatibility before updating with: ${upgradeCommand}`
      : `OpenCode CLI ${latestCliVersion} is available (installed: ${installedCliVersion}). Update with: ${upgradeCommand}`;
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
    return this.isAutoUpdateEnabled;
  }

  async upgradeCli(targetVersion: string) {
    await this.runCliCommand(
      ['upgrade', targetVersion],
      OpenCodeProcess.CLI_BACKGROUND_UPGRADE_TIMEOUT_MS
    );
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
    await this.upgradeCli(latestCliVersion);
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

  private buildServerEnv(configPath = this.injectedConfigPath): NodeJS.ProcessEnv {
    const env = buildServerEnv();
    if (configPath) {
      setEnvironmentValue(env, 'OPENCODE_CONFIG', configPath);
    }
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
