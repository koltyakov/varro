import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import {
  lstat,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join, win32 } from 'path';
import * as vscode from 'vscode';
import type { ServerStatus } from '../shared/protocol';
import { readMaximumTestedOpenCodeVersion } from './extension-manifest';
import {
  parseManagedServerOwnershipLease,
  type ManagedServerOwnershipLease,
} from '../shared/server-ownership';
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
  recoverLegacyManagedServerOwnership: () => Promise<boolean>;
  restartServerForCliUpdate: (serverVersion: string, installedCliVersion: string) => Promise<void>;
}

interface MaybeSuggestCliUpdateCallbacks {
  readLatestCliVersion: () => Promise<string | null>;
  upgradeRunningServer: (targetVersion: string) => Promise<boolean>;
  requestMaintenanceCheck: () => void;
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
const PROCESS_COMMAND_MAX_OUTPUT_CHARS = 1_000_000;
const INJECTED_CONFIG_DIRECTORY_PREFIX = 'varro-opencode-config-';
const INJECTED_CONFIG_OWNER_FILE = 'owner.json';
const STALE_INJECTED_CONFIG_AGE_MS = 7 * 24 * 60 * 60_000;
const SERVER_OWNER_ENV = 'VARRO_SERVER_OWNER';
const maximumTestedOpenCodeVersion = readMaximumTestedOpenCodeVersion();
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
      if (stdout.length < PROCESS_COMMAND_MAX_OUTPUT_CHARS) {
        stdout = (stdout + data.toString()).slice(0, PROCESS_COMMAND_MAX_OUTPUT_CHARS);
      }
    });
    proc.stderr?.on('data', (data) => {
      if (stderr.length < PROCESS_COMMAND_MAX_OUTPUT_CHARS) {
        stderr = (stderr + data.toString()).slice(0, PROCESS_COMMAND_MAX_OUTPUT_CHARS);
      }
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
  const pids = parsePids(result.stdout);
  if (
    pids.length > 0 ||
    process.platform !== 'linux' ||
    (result.code === 0 && !isCommandUnavailable(result))
  ) {
    return pids;
  }

  const fallback = await runProcess('ss', ['-ltnp']);
  const portPattern = new RegExp(`(?:\\]|:|\\*)${port}(?:\\s|$)`);
  const fallbackPids = new Set<number>();
  for (const line of fallback.stdout.split(/\r?\n/)) {
    if (!portPattern.test(line)) continue;
    for (const match of line.matchAll(/\bpid=(\d+)\b/g)) {
      const pid = Number.parseInt(match[1]!, 10);
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) fallbackPids.add(pid);
    }
  }
  return [...fallbackPids];
}

function isCommandUnavailable(result: CommandResult) {
  return result.code === null && /(?:ENOENT|not found|not recognized)/i.test(result.stderr);
}

async function readProcessExecutable(pid: number) {
  if (process.platform === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").ExecutablePath`;
    return (await runProcess('powershell.exe', ['-NoProfile', '-Command', script])).stdout.trim();
  }

  if (process.platform === 'linux') {
    const executable = (await runProcess('readlink', [`/proc/${pid}/exe`])).stdout.trim();
    if (executable) return executable;
  }

  const executable = (
    await runProcess('lsof', ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fn'])
  ).stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('n'))
    ?.slice(1)
    .trim();
  if (executable) return executable;

  return (await runProcess('ps', ['-p', String(pid), '-o', 'comm='])).stdout.trim();
}

async function readProcessBirthIdentity(pid: number) {
  if (process.platform === 'win32') {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().Ticks }`;
    const value = (
      await runProcess('powershell.exe', ['-NoProfile', '-Command', script])
    ).stdout.trim();
    return value ? `win32:${value}` : '';
  }

  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf-8');
      const fields = stat
        .slice(stat.lastIndexOf(') ') + 2)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      if (startTime && /^\d+$/.test(startTime)) return `linux:${startTime}`;
    } catch {}
  }

  const value = (await runProcess('ps', ['-p', String(pid), '-o', 'lstart='])).stdout
    .trim()
    .replace(/\s+/g, ' ');
  return value ? `${process.platform}:${value}` : '';
}

async function readParentPid(pid: number) {
  const result =
    process.platform === 'win32'
      ? await runProcess('powershell.exe', [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").ParentProcessId`,
        ])
      : await runProcess('ps', ['-p', String(pid), '-o', 'ppid=']);
  const parentPid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : null;
}

async function readProcessCommand(pid: number) {
  if (process.platform === 'win32') return '';
  return (await runProcess('ps', ['-p', String(pid), '-o', 'command='])).stdout.trim();
}

async function isProcessOrDescendant(pid: number, ancestorPid: number) {
  let currentPid: number | null = pid;
  for (let depth = 0; currentPid && depth < 32; depth += 1) {
    if (currentPid === ancestorPid) return true;
    currentPid = await readParentPid(currentPid);
  }
  return false;
}

function normalizeExecutableIdentity(value: string) {
  const normalized = value.trim();
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function waitForPortListenersToExit(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await findListeningPids(port)).length === 0) return true;
    await delay(100);
  }
  return (await findListeningPids(port)).length === 0;
}

function getManagedServerOwnershipLeasePath(port: number) {
  return join(tmpdir(), `varro-opencode-server-${port}.json`);
}

async function isSafeInjectedConfigPath(configPath: string) {
  const parent = dirname(configPath);
  const directoryName = basename(parent);
  if (basename(configPath) !== 'opencode.json') return false;
  if (
    !directoryName.startsWith(INJECTED_CONFIG_DIRECTORY_PREFIX) ||
    directoryName.length === INJECTED_CONFIG_DIRECTORY_PREFIX.length
  ) {
    return false;
  }

  try {
    const [realTemporaryDirectory, parentInfo, configInfo, realParent, realConfig] =
      await Promise.all([
        realpath(tmpdir()),
        lstat(parent),
        lstat(configPath),
        realpath(parent),
        realpath(configPath),
      ]);
    return (
      parentInfo.isDirectory() &&
      !parentInfo.isSymbolicLink() &&
      configInfo.isFile() &&
      !configInfo.isSymbolicLink() &&
      dirname(realParent) === realTemporaryDirectory &&
      realConfig === join(realParent, 'opencode.json')
    );
  } catch {
    return false;
  }
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
  private pendingMaintenanceCheck: (() => void) | null = null;
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
  private ownershipLease: ManagedServerOwnershipLease | null = null;
  private ownershipLeaseCandidate: ManagedServerOwnershipLease | null = null;
  private ownershipOwner: string | null = null;
  private ownershipRefreshOperation: Promise<boolean> | null = null;
  private foreignActiveOwnership = false;
  private readonly hostOwner = randomBytes(16).toString('hex');
  private readonly ownershipLeasePath: string;

  constructor(
    port: number,
    autoStart: boolean,
    command?: string,
    simulateMissingCli = false,
    compactionSettings?: Partial<OpenCodeCompactionSettings>,
    ownershipLeasePath = getManagedServerOwnershipLeasePath(port)
  ) {
    this._port = port;
    this.originalPort = port;
    this.autoStart = autoStart;
    this.command = command?.trim() || '';
    this.simulateMissingCli = simulateMissingCli;
    this.compactionSettings = normalizeCompactionSettings(compactionSettings);
    this.ownershipLeasePath = ownershipLeasePath;
    try {
      const rawLease = readFileSync(this.ownershipLeasePath, 'utf-8');
      try {
        this.ownershipLeaseCandidate = parseManagedServerOwnershipLease(JSON.parse(rawLease));
      } catch {}
      if (this.ownershipLeaseCandidate) this._port = this.ownershipLeaseCandidate.port;
      else {
        try {
          if (readFileSync(this.ownershipLeasePath, 'utf-8') === rawLease) {
            rmSync(this.ownershipLeasePath, { force: true });
          }
        } catch {}
      }
    } catch {}
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

  get shouldSuggestUntestedUpdates(): boolean {
    return vscode.workspace
      .getConfiguration('varro')
      .get<boolean>('debug.suggestUntestedOpenCodeUpdates', false);
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

  get managedProcessId(): number | null {
    return this._process?.pid ?? this.ownershipLease?.pid ?? null;
  }

  get hasOwnershipLeaseCandidate(): boolean {
    return this.ownershipLeaseCandidate !== null;
  }

  get hasForeignActiveOwnership(): boolean {
    return this.foreignActiveOwnership;
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
    if (this._managedProcess && this.ownershipLease) {
      this.portFallbackAttempts = Math.max(0, this._port - this.originalPort);
      this.portInUseDetected = false;
      return;
    }
    this._managedProcess = false;
    this.portFallbackAttempts = 0;
    this.portInUseDetected = false;
    await this.cleanupInjectedConfigFile();
  }

  async recoverManagedServerOwnership(): Promise<boolean> {
    if (this._process && this._managedProcess) return true;
    const lease = this.ownershipLeaseCandidate;
    this.ownershipLeaseCandidate = null;
    if (!lease) return false;
    if (!(await this.matchesOwnershipLease(lease))) {
      await this.removeOwnershipLease(lease.owner, lease.host);
      this._port = this.originalPort;
      return false;
    }
    if (lease.state === 'active') {
      this.foreignActiveOwnership = true;
      return false;
    }
    if (lease.configPath && !(await this.matchesInjectedConfigOwner(lease))) {
      await this.removeOwnershipLease(lease.owner, lease.host);
      this._port = this.originalPort;
      return false;
    }

    return this.claimManagedServerOwnership(lease, true);
  }

  refreshManagedServerOwnership(): Promise<boolean> {
    if (this._managedProcess && this.ownershipLease) return Promise.resolve(true);
    if (this.ownershipRefreshOperation) return this.ownershipRefreshOperation;
    const operation = this.runManagedServerOwnershipRefresh();
    this.ownershipRefreshOperation = operation;
    const finish = () => {
      if (this.ownershipRefreshOperation === operation) this.ownershipRefreshOperation = null;
    };
    void operation.then(finish, finish);
    return operation;
  }

  async recoverLegacyManagedServerOwnership(): Promise<boolean> {
    if (process.platform === 'win32' || this._managedProcess || this._process) return false;
    if (await this.readOwnershipLease()) return false;

    const listeners = await findListeningPids(this._port);
    if (listeners.length !== 1) return false;
    const pid = listeners[0]!;
    const configuredExecutable = this.resolveCommand();
    const [executable, parentPid, command, birthIdentity] = await Promise.all([
      readProcessExecutable(pid),
      readParentPid(pid),
      readProcessCommand(pid),
      readProcessBirthIdentity(pid),
    ]);
    if (
      !executable ||
      !birthIdentity ||
      parentPid !== 1 ||
      normalizeExecutableIdentity(executable) !==
        normalizeExecutableIdentity(configuredExecutable) ||
      command !== `${executable} serve --port ${this._port}`
    ) {
      return false;
    }

    const claimPath = `${this.ownershipLeasePath}.claim`;
    let claimHandle: Awaited<ReturnType<typeof openFile>>;
    try {
      claimHandle = await openFile(claimPath, 'wx', 0o600);
    } catch {
      return false;
    }

    try {
      if (await this.readOwnershipLease()) return false;
      const owner = randomBytes(16).toString('hex');
      const lease: ManagedServerOwnershipLease = {
        version: 1,
        pid,
        port: this._port,
        executable,
        birthIdentity,
        owner,
        host: this.hostOwner,
        state: 'active',
        createdAt: Date.now(),
      };
      if (
        !(await this.matchesOwnershipLease(lease)) ||
        (await readParentPid(pid)) !== 1 ||
        (await readProcessCommand(pid)) !== command
      ) {
        return false;
      }
      await this.writeOwnershipLease(lease);
      this.adoptManagedServerOwnership(lease);
      logger.info(`Recovered ownership of legacy Varro OpenCode server PID ${pid}`);
      return true;
    } finally {
      await claimHandle.close().catch(() => {});
      await rm(claimPath, { force: true }).catch(() => {});
    }
  }

  private async runManagedServerOwnershipRefresh(): Promise<boolean> {
    const lease = await this.readOwnershipLease();
    if (!lease) {
      this.foreignActiveOwnership = false;
      return false;
    }
    if (!(await this.matchesOwnershipLease(lease))) {
      await this.removeOwnershipLease(lease.owner, lease.host);
      this.foreignActiveOwnership = false;
      return false;
    }
    if (lease.state === 'active') {
      this.foreignActiveOwnership = true;
      return false;
    }
    if (lease.configPath && !(await this.matchesInjectedConfigOwner(lease))) {
      await this.removeOwnershipLease(lease.owner, lease.host);
      this.foreignActiveOwnership = false;
      return false;
    }

    return this.claimManagedServerOwnership(lease, false);
  }

  private async claimManagedServerOwnership(
    lease: ManagedServerOwnershipLease,
    resetPortOnFailure: boolean
  ) {
    const claimedLease = await this.claimRelinquishedOwnershipLease(lease);
    if (!claimedLease) {
      const current = await this.readOwnershipLease();
      if (
        current?.host === this.hostOwner &&
        current.state === 'active' &&
        (await this.matchesOwnershipLease(current)) &&
        (!current.configPath || (await this.matchesInjectedConfigOwner(current)))
      ) {
        this.adoptManagedServerOwnership(current);
        return true;
      }
      this.foreignActiveOwnership =
        current?.owner === lease.owner && current.birthIdentity === lease.birthIdentity;
      return false;
    }
    if (claimedLease.configPath && !(await isSafeInjectedConfigPath(claimedLease.configPath))) {
      await this.removeOwnershipLease(claimedLease.owner, claimedLease.host);
      if (resetPortOnFailure) this._port = this.originalPort;
      return false;
    }

    this.adoptManagedServerOwnership(claimedLease);
    return true;
  }

  private adoptManagedServerOwnership(lease: ManagedServerOwnershipLease) {
    this.ownershipLease = lease;
    this.ownershipOwner = lease.owner;
    this.foreignActiveOwnership = false;
    this._managedProcess = true;
    this._port = lease.port;
    if (lease.configPath) {
      this.injectedConfigPath = lease.configPath;
      this.injectedConfigOwnerPid = lease.pid;
    }
  }

  async confirmManagedServerOwnership(): Promise<boolean> {
    const proc = this._process;
    const owner = this.ownershipOwner;
    if (!proc?.pid || !owner) {
      this._managedProcess = false;
      return false;
    }

    const listeners = await findListeningPids(this._port);
    let listenerPid: number | undefined;
    for (const pid of listeners) {
      if (await isProcessOrDescendant(pid, proc.pid)) {
        listenerPid = pid;
        break;
      }
    }
    if (!listenerPid) {
      this._managedProcess = false;
      logger.warn(`Could not bind managed OpenCode ownership to port ${this._port}`);
      return false;
    }
    const executable = await readProcessExecutable(listenerPid);
    if (!executable) {
      this._managedProcess = false;
      logger.warn(`Could not read executable identity for managed OpenCode PID ${listenerPid}`);
      return false;
    }
    const birthIdentity = await readProcessBirthIdentity(listenerPid);
    if (!birthIdentity) {
      this._managedProcess = false;
      logger.warn(`Could not read process birth identity for managed OpenCode PID ${listenerPid}`);
      return false;
    }

    const lease: ManagedServerOwnershipLease = {
      version: 1,
      pid: listenerPid,
      port: this._port,
      executable,
      birthIdentity,
      owner,
      host: this.hostOwner,
      state: 'active',
      createdAt: Date.now(),
      ...(this.injectedConfigPath ? { configPath: this.injectedConfigPath } : {}),
    };
    try {
      if (lease.configPath) {
        if (!(await isSafeInjectedConfigPath(lease.configPath))) {
          this._managedProcess = false;
          logger.warn(
            `Refusing to persist untrusted temporary OpenCode config path: ${lease.configPath}`
          );
          return false;
        }
        await writeFile(
          join(dirname(lease.configPath), INJECTED_CONFIG_OWNER_FILE),
          `${JSON.stringify({ pid: lease.pid, owner: lease.owner, createdAt: lease.createdAt })}\n`,
          'utf-8'
        );
        this.injectedConfigOwnerPid = lease.pid;
      }
      await this.writeOwnershipLease(lease);
    } catch (err) {
      this._managedProcess = false;
      logger.warn(
        `Failed to persist managed OpenCode ownership: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
    this.ownershipLease = lease;
    this._managedProcess = true;
    return true;
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
    if (!(await isSafeInjectedConfigPath(configPath))) {
      logger.warn(`Refusing to delete untrusted temporary OpenCode config path: ${configPath}`);
      return;
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
      if (!(await isSafeInjectedConfigPath(configPath))) {
        logger.warn(`Refusing to write untrusted temporary OpenCode config path: ${configPath}`);
        return;
      }
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
    if (callbacks.status.state === 'running' && this.foreignActiveOwnership) {
      await this.refreshManagedServerOwnership();
    }
    await this.rewriteInjectedConfigFile();
    if (!changed || callbacks.status.state !== 'running') return;
    await this.reapplyCompactionSettings(callbacks);
  }

  async reapplyCompactionSettings(callbacks: UpdateCompactionSettingsCallbacks) {
    if (this.foreignActiveOwnership) await this.refreshManagedServerOwnership();
    if (!this._managedProcess) {
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
    const owner = randomBytes(16).toString('hex');
    this.ownershipOwner = owner;
    this.foreignActiveOwnership = false;
    try {
      this._process = spawn(launch.command, launch.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        cwd: callbacks.getWorkspaceCwd(),
        env: this.buildServerEnv(configPath, owner),
        windowsHide: true,
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      this.ownershipOwner = null;
      void this.cleanupInjectedConfigFile(configPath);
      throw err;
    }
    try {
      this.bindInjectedConfigOwner(configPath, this._process, owner);
    } catch (err) {
      const proc = this._process;
      this._process = null;
      this.ownershipOwner = null;
      if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      void this.cleanupInjectedConfigFile(configPath);
      throw err;
    }
    this._managedProcess = true;

    this._processStdoutHandler = callbacks.onStdout;
    this._processStderrHandler = callbacks.onStderr;
    this._process.once?.('exit', () => {
      if (configPath) void this.cleanupInjectedConfigFile(configPath);
      void this.clearManagedServerOwnership(owner, this.hostOwner);
    });
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

  private bindInjectedConfigOwner(configPath: string | null, proc: ChildProcess, owner: string) {
    if (!configPath) return;
    if (!proc.pid) {
      throw new Error('Failed to bind temporary OpenCode config to the managed child process');
    }
    writeFileSync(
      join(dirname(configPath), INJECTED_CONFIG_OWNER_FILE),
      `${JSON.stringify({ pid: proc.pid, owner, createdAt: Date.now() })}\n`,
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
    const lease = this.ownershipLease;
    this._process = null;
    this._managedProcess = false;
    if (!proc && !lease) {
      await this.cleanupInjectedConfigFile(configPath);
      return;
    }
    this.detachProcessListeners(proc);
    try {
      if (lease) {
        if (!(await this.terminateOwnedLease(lease))) {
          throw new Error(
            `Managed OpenCode ownership lease no longer matches the listener on port ${lease.port}`
          );
        }
      } else if (proc) {
        await this.terminateManagedProcess(proc);
      }
      await this.cleanupInjectedConfigFile(configPath);
    } catch (err) {
      this._managedProcess = !!this.ownershipLease;
      throw err;
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

  private async terminateOwnedLease(lease: ManagedServerOwnershipLease): Promise<boolean> {
    if (!(await this.matchesOwnershipLease(lease))) {
      await this.removeOwnershipLease(lease.owner, lease.host);
      return false;
    }

    if (process.platform === 'win32') {
      await runProcess(
        'taskkill.exe',
        ['/PID', String(lease.pid), '/T', '/F'],
        PROCESS_STOP_TIMEOUT_MS
      );
    } else {
      try {
        process.kill(lease.pid, 'SIGTERM');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') throw err;
      }
    }

    const deadline = Date.now() + PROCESS_STOP_TIMEOUT_MS;
    while (Date.now() < deadline && (await this.matchesOwnershipLease(lease))) {
      await delay(100);
    }
    if (await this.matchesOwnershipLease(lease)) {
      if (process.platform === 'win32') {
        throw new Error(`Port ${lease.port} is still occupied after stopping managed OpenCode`);
      }
      // Revalidate immediately before escalating so a reused PID is never signalled.
      if (await this.matchesOwnershipLease(lease)) {
        try {
          process.kill(lease.pid, 'SIGKILL');
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') throw err;
        }
      }
      if (await this.matchesOwnershipLease(lease)) {
        throw new Error(`Port ${lease.port} is still occupied after stopping managed OpenCode`);
      }
    }

    await this.clearManagedServerOwnership(lease.owner, lease.host);
    return true;
  }

  private async matchesOwnershipLease(lease: ManagedServerOwnershipLease): Promise<boolean> {
    const listeners = await findListeningPids(lease.port);
    if (!listeners.includes(lease.pid)) return false;
    const executable = await readProcessExecutable(lease.pid);
    if (
      !executable ||
      normalizeExecutableIdentity(executable) !== normalizeExecutableIdentity(lease.executable)
    ) {
      return false;
    }
    return (await readProcessBirthIdentity(lease.pid)) === lease.birthIdentity;
  }

  private async matchesInjectedConfigOwner(lease: ManagedServerOwnershipLease): Promise<boolean> {
    if (!lease.configPath) return true;
    if (!(await isSafeInjectedConfigPath(lease.configPath))) return false;
    try {
      const owner = JSON.parse(
        await readFile(join(dirname(lease.configPath), INJECTED_CONFIG_OWNER_FILE), 'utf-8')
      ) as { pid?: unknown; owner?: unknown };
      return owner.pid === lease.pid && owner.owner === lease.owner;
    } catch {
      return false;
    }
  }

  private async readOwnershipLease(): Promise<ManagedServerOwnershipLease | null> {
    let raw: string;
    try {
      raw = await readFile(this.ownershipLeasePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn(
          `Failed to read managed OpenCode ownership: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return null;
    }
    try {
      const lease = parseManagedServerOwnershipLease(JSON.parse(raw));
      if (lease) return lease;
    } catch {}
    await rm(this.ownershipLeasePath, { force: true }).catch(() => {});
    return null;
  }

  private async writeOwnershipLease(lease: ManagedServerOwnershipLease) {
    const temporaryPath = `${this.ownershipLeasePath}.${process.pid}.${lease.owner}.tmp`;
    const serialized = `${JSON.stringify(lease)}\n`;
    try {
      await writeFile(temporaryPath, serialized, { encoding: 'utf-8', mode: 0o600 });
      try {
        await rename(temporaryPath, this.ownershipLeasePath);
      } catch (err) {
        if (!['EEXIST', 'EPERM'].includes((err as NodeJS.ErrnoException)?.code || '')) throw err;
        await writeFile(this.ownershipLeasePath, serialized, { encoding: 'utf-8', mode: 0o600 });
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  private async claimRelinquishedOwnershipLease(
    lease: ManagedServerOwnershipLease
  ): Promise<ManagedServerOwnershipLease | null> {
    const claimPath = `${this.ownershipLeasePath}.claim`;
    let claimHandle: Awaited<ReturnType<typeof openFile>>;
    try {
      claimHandle = await openFile(claimPath, 'wx', 0o600);
    } catch {
      return null;
    }

    try {
      const current = await this.readOwnershipLease();
      if (
        !current ||
        current.owner !== lease.owner ||
        current.host !== lease.host ||
        current.state !== 'relinquished' ||
        current.pid !== lease.pid ||
        current.port !== lease.port ||
        current.executable !== lease.executable ||
        current.birthIdentity !== lease.birthIdentity ||
        current.configPath !== lease.configPath
      ) {
        return null;
      }
      if (!(await this.matchesOwnershipLease(current))) return null;
      const claimed: ManagedServerOwnershipLease = {
        ...current,
        host: this.hostOwner,
        state: 'active',
      };
      await this.writeOwnershipLease(claimed);
      return claimed;
    } finally {
      await claimHandle.close().catch(() => {});
      await rm(claimPath, { force: true }).catch(() => {});
    }
  }

  private async relinquishManagedServerOwnership() {
    const lease = this.ownershipLease;
    if (!lease || lease.host !== this.hostOwner || lease.state !== 'active') return;
    if (!(await this.matchesOwnershipLease(lease))) {
      await this.removeOwnershipLease(lease.owner, lease.host);
      return;
    }
    const current = await this.readOwnershipLease();
    if (
      !current ||
      current.owner !== lease.owner ||
      current.host !== lease.host ||
      current.state !== 'active' ||
      current.birthIdentity !== lease.birthIdentity
    ) {
      return;
    }
    const relinquished: ManagedServerOwnershipLease = {
      ...current,
      state: 'relinquished',
    };
    await this.writeOwnershipLease(relinquished);
    this.ownershipLease = relinquished;
    this._managedProcess = false;
    this.foreignActiveOwnership = false;
  }

  private async removeOwnershipLease(expectedOwner?: string, expectedHost?: string) {
    const ownsLocalLease =
      !expectedOwner ||
      ((this.ownershipOwner === expectedOwner ||
        this.ownershipLease?.owner === expectedOwner ||
        this.ownershipLeaseCandidate?.owner === expectedOwner) &&
        (!expectedHost ||
          this.hostOwner === expectedHost ||
          this.ownershipLease?.host === expectedHost ||
          this.ownershipLeaseCandidate?.host === expectedHost));
    if (expectedOwner) {
      const current = await this.readOwnershipLease();
      if (
        current &&
        (current.owner !== expectedOwner || (expectedHost && current.host !== expectedHost))
      ) {
        if (ownsLocalLease) {
          this.ownershipLease = null;
          this.ownershipLeaseCandidate = null;
          this.ownershipOwner = null;
          this.foreignActiveOwnership = false;
          this._managedProcess = false;
        }
        return;
      }
    }
    await rm(this.ownershipLeasePath, { force: true });
    if (ownsLocalLease) {
      this.ownershipLease = null;
      this.ownershipLeaseCandidate = null;
      this.ownershipOwner = null;
      this.foreignActiveOwnership = false;
      this._managedProcess = false;
    }
  }

  private async clearManagedServerOwnership(expectedOwner: string, expectedHost: string) {
    await this.removeOwnershipLease(expectedOwner, expectedHost);
  }

  async stopServerForRestart() {
    const ports = [...new Set([this._port, this.originalPort])];
    if (this.foreignActiveOwnership) await this.refreshManagedServerOwnership();
    if (this._managedProcess && (this._process || this.ownershipLease)) {
      await this.stopManagedProcessForRestart();
    } else if (this._process) {
      this.detachProcessListeners(this._process);
      this._process = null;
      this._managedProcess = false;
    }

    for (const port of ports) {
      if ((await findListeningPids(port)).length > 0) {
        throw new Error(
          `Port ${port} is occupied by a process Varro does not own; stop it explicitly before restarting`
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
    if (!options.stopProcess) {
      if (this._process) {
        this.detachProcessListeners(this._process);
        this._process = null;
      }
      await this.relinquishManagedServerOwnership();
      this._managedProcess = false;
      if (this.injectedConfigOwnerPid || this.ownershipLease) return;
      await this.cleanupInjectedConfigFile();
      return;
    }
    if (options.stopProcess && this._managedProcess && (this._process || this.ownershipLease)) {
      await this.stopManagedProcessForRestart();
    } else if (options.stopProcess && this._process) {
      this.detachProcessListeners(this._process);
      this._process = null;
      this._managedProcess = false;
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
    this.pendingMaintenanceCheck = null;
  }

  requestMaintenanceCheck(tick: () => void) {
    if (this.maintenanceInFlight) {
      this.pendingMaintenanceCheck = tick;
      return;
    }
    tick();
  }

  async runMaintenanceTick(callbacks: MaintenanceCallbacks) {
    if (this.maintenanceInFlight || callbacks.isDisposing()) return;
    this.maintenanceInFlight = true;
    try {
      if (this.foreignActiveOwnership && !(await this.refreshManagedServerOwnership())) return;
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

      if (!this._managedProcess && this.autoStart) {
        await callbacks.recoverLegacyManagedServerOwnership();
      }

      if (!this._managedProcess) {
        const key = `${serverVersion}->${restartCliVersion}`;
        if (this.lastLoggedUnmanagedRestartKey !== key) {
          this.lastLoggedUnmanagedRestartKey = key;
          logger.info(
            this.autoStart
              ? `OpenCode CLI ${restartCliVersion} is newer than running server ${serverVersion}, but Varro does not own the server; continuing with the existing server`
              : `OpenCode CLI ${restartCliVersion} is newer than running server ${serverVersion}, but Varro server auto-start is disabled; skipping automatic restart`
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
      const pendingMaintenanceCheck = this.pendingMaintenanceCheck;
      this.pendingMaintenanceCheck = null;
      if (pendingMaintenanceCheck && !callbacks.isDisposing()) {
        pendingMaintenanceCheck();
      }
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
      compareVersions(latestCliVersion, maximumTestedOpenCodeVersion) > 0;
    if (exceedsTestedCeiling && !this.shouldSuggestUntestedUpdates) {
      return null;
    }
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
      ? `OpenCode CLI ${latestCliVersion} is available, but Varro has only been tested through ${maximumTestedOpenCodeVersion}. Review compatibility before updating with: ${upgradeCommand}`
      : `OpenCode CLI ${latestCliVersion} is available (installed: ${installedCliVersion}). Update with: ${upgradeCommand}`;
    logger.info(message);
    void vscode.window
      .showInformationMessage(message, OpenCodeProcess.CLI_UPGRADE_ACTION)
      .then(async (action) => {
        if (action === OpenCodeProcess.CLI_UPGRADE_ACTION) {
          if (await callbacks.upgradeRunningServer(latestCliVersion)) {
            callbacks.requestMaintenanceCheck();
            return;
          }
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

  private buildServerEnv(
    configPath = this.injectedConfigPath,
    owner = this.ownershipOwner
  ): NodeJS.ProcessEnv {
    const env = buildServerEnv();
    if (configPath) {
      setEnvironmentValue(env, 'OPENCODE_CONFIG', configPath);
    }
    if (owner) {
      setEnvironmentValue(env, SERVER_OWNER_ENV, owner);
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
