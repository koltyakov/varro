/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- Process, filesystem, and JSON boundaries are validated before ownership data is used. */
/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Ownership assertions follow complete PID, port, executable, and birth-identity checks. */
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import crossSpawn from 'cross-spawn';
import type { Dirent } from 'fs';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import {
  access,
  lstat,
  mkdtemp,
  open as openFile,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat as readStat,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, posix, resolve as resolvePath, win32 } from 'path';
import { parse, type ParseError } from 'jsonc-parser';
import * as vscode from 'vscode';
import {
  classifyUpgradeFailure,
  describeUpgradeFailure,
  detectInstallMethod,
  getRecoveryCommand,
  type OpenCodeInstallMethod,
  type OpenCodeUpgradeFailureKind,
} from '../shared/opencode-install';
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

const ASK_AGENT = {
  description: 'Answers questions and investigates the codebase without modifying anything',
  mode: 'primary',
  prompt:
    'Answer questions about the codebase using read-only investigation. Explain findings directly and cite relevant files and lines. Do not modify files, run shell commands, delegate work, or perform external side effects. If the user asks you to edit or implement something, do not make changes. Suggest switching to the Build agent.',
  permission: {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    skill: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
    question: 'allow',
  },
} as const;

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function resolveProjectConfigPaths(directory: string): Promise<string[]> {
  const pathApi = /^[a-z]:[\\/]/i.test(directory) || directory.startsWith('\\\\') ? win32 : posix;
  const files: string[] = [];
  let current = pathApi.resolve(directory);
  while (true) {
    for (const name of ['opencode.jsonc', 'opencode.json']) {
      const candidate = pathApi.join(current, name);
      if (await pathExists(candidate)) files.push(candidate);
    }
    if (await pathExists(pathApi.join(current, '.git'))) break;
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files;
}

function containsAskAgent(raw: string): boolean {
  const errors: ParseError[] = [];
  const value: unknown = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !value || typeof value !== 'object' || Array.isArray(value)) return true;
  const agent = (value as Record<string, unknown>).agent;
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return false;
  return Object.keys(agent).some((name) => name.toLowerCase() === 'ask');
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
  takeOwnershipOfExistingServer: () => Promise<boolean>;
  restartServerForCliUpdate: (serverVersion: string, installedCliVersion: string) => Promise<void>;
}

interface MaybeSuggestCliUpdateCallbacks {
  readLatestCliVersion: () => Promise<string | null>;
  upgradeRunningServer: (targetVersion: string) => Promise<boolean>;
  requestMaintenanceCheck: () => void;
  getWorkspaceCwd: () => string | undefined;
  prepareForWindowsCliUpgrade: (targetVersion?: string) => Promise<void>;
  finishWindowsCliUpgrade?: () => void | Promise<void>;
}

export interface UpgradeFailureReport {
  /** Raw error text, kept for the output channel and the About report. */
  cause: string;
  kind: OpenCodeUpgradeFailureKind;
  installMethod: OpenCodeInstallMethod;
  /** One sentence naming what failed and what to do instead. */
  guidance: string;
  /** Command that repairs this install, or null when none is safe to suggest. */
  suggestedCommand: string | null;
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
  onExit: (proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (proc: ChildProcess, err: Error) => void;
}

interface ProcessListeners {
  stdout: (data: Buffer) => void;
  stderr: (data: Buffer) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  error: (err: Error) => void;
}

interface ProcessLaunch {
  configPath: string | null;
  listenerPid: number | null;
  owner: string;
  ownershipConfirmed: boolean;
  ownershipMarkerWritten: boolean;
  port: number;
  processGroupId: number | null;
}

interface InjectedConfigOwner {
  pid: number;
  owner: string;
  createdAt: number;
  port?: number;
  executable?: string;
  birthIdentity?: string;
  configPath?: string;
}

interface ManagedServerOwnershipClaim {
  version: 1;
  host: string;
  hostPid: number;
  hostBirthIdentity?: string;
  createdAt: number;
}

interface ManagedServerOwnershipClaimHandle {
  path: string;
  handle: Awaited<ReturnType<typeof openFile>>;
  claim: ManagedServerOwnershipClaim;
}

export type OpenCodeServerOwnership = 'current-host' | 'other-host' | 'unmanaged';

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

const PROCESS_COMMAND_TIMEOUT_MS = 2000;
const PROCESS_COMMAND_KILL_GRACE_MS = 1000;
const WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS = 10_000;
const WINDOWS_OWNERSHIP_CONFIRM_ATTEMPTS = 3;
const WINDOWS_OWNERSHIP_CONFIRM_RETRY_MS = 250;
const PROCESS_STOP_TIMEOUT_MS = 5000;
const PROCESS_COMMAND_MAX_OUTPUT_CHARS = 1_000_000;
const INJECTED_CONFIG_DIRECTORY_PREFIX = 'varro-opencode-config-';
const INJECTED_CONFIG_OWNER_FILE = 'owner.json';
const STALE_INJECTED_CONFIG_AGE_MS = 7 * 24 * 60 * 60_000;
const LEGACY_OWNERSHIP_CLAIM_STALE_AGE_MS = 30_000;
const OWNERSHIP_CLAIM_MAX_AGE_MS = 2 * 60_000;
const SERVER_OWNER_ENV = 'VARRO_SERVER_OWNER';
const MAX_SERVER_PORT = 65_535;
const maximumTestedOpenCodeVersion = readMaximumTestedOpenCodeVersion();
let staleConfigSweep: Promise<void> = Promise.resolve();

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateServerPort(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SERVER_PORT
  ) {
    throw new Error(
      `Invalid varro.server.port value (${String(value)}). Set varro.server.port to an integer between 1 and ${MAX_SERVER_PORT}.`
    );
  }
  return value;
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

function parseWindowsNetstatListeningPids(text: string, port: number) {
  const pids = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0]?.toUpperCase() !== 'TCP') continue;
    const remoteAddress = fields[2];
    if (remoteAddress?.slice(remoteAddress.lastIndexOf(':') + 1) !== '0') continue;
    const localAddress = fields[1];
    const localPort = localAddress?.slice(localAddress.lastIndexOf(':') + 1);
    if (localPort !== String(port)) continue;
    const pid = Number.parseInt(fields[4] ?? '', 10);
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

function parseInjectedConfigOwner(value: unknown): InjectedConfigOwner | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return null;
  if (typeof record.owner !== 'string' || !record.owner.trim()) return null;
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return null;
  const identityFields = [record.port, record.executable, record.birthIdentity];
  const hasIdentity = identityFields.some((field) => field !== undefined);
  if (
    hasIdentity &&
    (!Number.isSafeInteger(record.port) ||
      (record.port as number) <= 0 ||
      (record.port as number) > 65_535 ||
      typeof record.executable !== 'string' ||
      !record.executable.trim() ||
      typeof record.birthIdentity !== 'string' ||
      !record.birthIdentity.trim())
  ) {
    return null;
  }
  if (record.configPath !== undefined && typeof record.configPath !== 'string') return null;
  const owner: InjectedConfigOwner = {
    pid: record.pid as number,
    owner: record.owner,
    createdAt: record.createdAt,
  };
  if (hasIdentity) {
    owner.port = record.port as number;
    owner.executable = record.executable as string;
    owner.birthIdentity = record.birthIdentity as string;
  }
  if (record.configPath) owner.configPath = record.configPath as string;
  return owner;
}

function parseManagedServerOwnershipClaim(value: unknown): ManagedServerOwnershipClaim | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (typeof record.host !== 'string' || !record.host.trim()) return null;
  if (!Number.isSafeInteger(record.hostPid) || (record.hostPid as number) <= 0) return null;
  if (
    record.hostBirthIdentity !== undefined &&
    (typeof record.hostBirthIdentity !== 'string' || !record.hostBirthIdentity.trim())
  ) {
    return null;
  }
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return null;
  const claim: ManagedServerOwnershipClaim = {
    version: 1,
    host: record.host,
    hostPid: record.hostPid as number,
    createdAt: record.createdAt,
  };
  if (record.hostBirthIdentity) claim.hostBirthIdentity = record.hostBirthIdentity as string;
  return claim;
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
      const timedOutProcess = proc;
      timedOutProcess?.kill();
      // These are short-lived inspection commands (lsof, ps, powershell). If one
      // ignores SIGTERM it would otherwise outlive the extension host, so
      // escalate. The escalation must outlive `finish`, which only resolves the
      // promise and leaves the child running.
      if (timedOutProcess && timedOutProcess.exitCode === null) {
        const killTimer = setTimeout(() => {
          if (timedOutProcess.exitCode === null) timedOutProcess.kill('SIGKILL');
        }, PROCESS_COMMAND_KILL_GRACE_MS);
        killTimer.unref?.();
      }
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

async function terminateCliProcessTree(proc: ChildProcess): Promise<void> {
  if (process.platform === 'win32' && proc.pid) {
    const taskkill = await runProcess(
      'taskkill.exe',
      ['/PID', String(proc.pid), '/T', '/F'],
      PROCESS_STOP_TIMEOUT_MS
    );
    if (taskkill.code === 0) return;

    const script = [
      `$root = ${String(proc.pid)}`,
      '$ids = @($root)',
      'do { $children = @(Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | Select-Object -ExpandProperty ProcessId); $ids += $children } while ($children.Count -gt 0)',
      'Stop-Process -Id ($ids | Sort-Object -Descending) -Force -ErrorAction Stop',
    ].join('; ');
    const powershell = await runProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      PROCESS_STOP_TIMEOUT_MS
    );
    if (powershell.code === 0) return;

    logger.warn(
      `Failed to terminate timed-out Windows CLI process tree ${proc.pid}: taskkill ${taskkill.stderr.trim() || `exit code ${String(taskkill.code)}`}; PowerShell ${powershell.stderr.trim() || `exit code ${String(powershell.code)}`}`
    );
  }

  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill('SIGKILL');
    } catch {}
  }
}

async function findLinuxListeningPids(port: number, procRoot: string) {
  const socketInodes = new Set<string>();
  await Promise.all(
    [join(procRoot, 'net/tcp'), join(procRoot, 'net/tcp6')].map(async (path) => {
      let table: string;
      try {
        table = await readFile(path, 'utf-8');
      } catch {
        return;
      }
      for (const line of table.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        const localAddress = fields[1];
        const state = fields[3];
        const inode = fields[9];
        const encodedPort = localAddress?.slice(localAddress.lastIndexOf(':') + 1);
        if (
          state === '0A' &&
          encodedPort &&
          Number.parseInt(encodedPort, 16) === port &&
          inode &&
          /^\d+$/.test(inode)
        ) {
          socketInodes.add(inode);
        }
      }
    })
  );
  if (socketInodes.size === 0) return [];

  let processes: Dirent[];
  try {
    processes = await readdir(procRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const pids = new Set<number>();
  const candidates = processes.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name));
  for (let offset = 0; offset < candidates.length; offset += 32) {
    await Promise.all(
      candidates.slice(offset, offset + 32).map(async (entry) => {
        const pid = Number.parseInt(entry.name, 10);
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
        let descriptors: string[];
        try {
          descriptors = await readdir(join(procRoot, String(pid), 'fd'));
        } catch {
          return;
        }
        for (const descriptor of descriptors) {
          try {
            const target = await readlink(join(procRoot, String(pid), 'fd', descriptor));
            const match = /^socket:\[(\d+)\]$/.exec(target);
            if (match?.[1] && socketInodes.has(match[1])) {
              pids.add(pid);
              return;
            }
          } catch {}
        }
      })
    );
  }
  return [...pids];
}

async function findListeningPids(port: number, procRoot = '/proc') {
  if (process.platform === 'win32') {
    const script = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
    const result = await runProcess(
      'powershell.exe',
      ['-NoProfile', '-Command', script],
      WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS
    );
    const pids = parsePids(result.stdout);
    if (pids.length > 0) return pids;
    if (result.code !== 0) {
      logger.warn(
        `Windows listener inspection with PowerShell failed: ${result.stderr.trim() || `exit code ${String(result.code)}`}`
      );
    }
    const fallback = await runProcess(
      'netstat.exe',
      ['-ano'],
      WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS
    );
    if (fallback.code !== 0) {
      logger.warn(
        `Windows listener inspection with netstat failed: ${fallback.stderr.trim() || `exit code ${String(fallback.code)}`}`
      );
    }
    return parseWindowsNetstatListeningPids(fallback.stdout, port);
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
  return fallbackPids.size > 0 ? [...fallbackPids] : findLinuxListeningPids(port, procRoot);
}

function isCommandUnavailable(result: CommandResult) {
  return result.code === null && /(?:ENOENT|not found|not recognized)/i.test(result.stderr);
}

async function readProcessExecutable(pid: number, procRoot = '/proc') {
  if (process.platform === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").ExecutablePath`;
    return (
      await runProcess(
        'powershell.exe',
        ['-NoProfile', '-Command', script],
        WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS
      )
    ).stdout.trim();
  }

  if (process.platform === 'linux') {
    try {
      const executable = (await readlink(join(procRoot, String(pid), 'exe'))).trim();
      if (executable) return executable;
    } catch {}
    const executable = (
      await runProcess('readlink', [join(procRoot, String(pid), 'exe')])
    ).stdout.trim();
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

async function readLinuxProcessStat(pid: number, procRoot: string) {
  try {
    const stat = await readFile(join(procRoot, String(pid), 'stat'), 'utf-8');
    const commandEnd = stat.lastIndexOf(') ');
    if (commandEnd < 0) return null;
    return stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
  } catch {
    return null;
  }
}

async function readProcessBirthIdentity(pid: number, procRoot = '/proc') {
  if (process.platform === 'win32') {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().Ticks }`;
    const value = (
      await runProcess(
        'powershell.exe',
        ['-NoProfile', '-Command', script],
        WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS
      )
    ).stdout.trim();
    return value ? `win32:${value}` : '';
  }

  if (process.platform === 'linux') {
    const startTime = (await readLinuxProcessStat(pid, procRoot))?.[19];
    if (startTime && /^\d+$/.test(startTime)) return `linux:${startTime}`;
  }

  const value = (await runProcess('ps', ['-p', String(pid), '-o', 'lstart='])).stdout
    .trim()
    .replace(/\s+/g, ' ');
  return value ? `${process.platform}:${value}` : '';
}

async function readParentPid(pid: number, procRoot = '/proc') {
  if (process.platform === 'linux') {
    const parentPid = Number.parseInt((await readLinuxProcessStat(pid, procRoot))?.[1] ?? '', 10);
    if (Number.isSafeInteger(parentPid) && parentPid > 0) return parentPid;
  }
  const result =
    process.platform === 'win32'
      ? await runProcess(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").ParentProcessId`,
          ],
          WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS
        )
      : await runProcess('ps', ['-p', String(pid), '-o', 'ppid=']);
  const parentPid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : null;
}

async function readProcessEnvironmentValue(pid: number, name: string, procRoot = '/proc') {
  if (process.platform === 'win32') return '';
  if (process.platform === 'linux') {
    try {
      const environment = await readFile(join(procRoot, String(pid), 'environ'), 'utf-8');
      const entry = environment.split('\0').find((value) => value.startsWith(`${name}=`));
      if (entry) return entry.slice(name.length + 1);
    } catch {}
  }

  const command = (await runProcess('ps', ['eww', '-p', String(pid), '-o', 'command='])).stdout;
  const match = new RegExp(`(?:^|\\s)${name}=([^\\s]+)(?:\\s|$)`).exec(command);
  return match?.[1] ?? '';
}

async function isProcessOrDescendant(pid: number, ancestorPid: number, procRoot = '/proc') {
  let currentPid: number | null = pid;
  for (let depth = 0; currentPid && depth < 32; depth += 1) {
    if (currentPid === ancestorPid) return true;
    currentPid = await readParentPid(currentPid, procRoot);
  }
  return false;
}

async function readProcessGroupId(pid: number) {
  if (process.platform === 'win32') return null;
  const value = (await runProcess('ps', ['-p', String(pid), '-o', 'pgid='])).stdout.trim();
  const processGroupId = Number.parseInt(value, 10);
  return Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : null;
}

function isProcessGroupAlive(processGroupId: number) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals) {
  try {
    process.kill(-processGroupId, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') throw err;
  }
}

function normalizeExecutableIdentity(value: string) {
  const normalized = value.trim();
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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

  /** Unambiguous "the binary is not there": the spawn itself never got started. */
  static isMissingCliFailure(text: string): boolean {
    return (
      text.includes('ENOENT') ||
      text.includes(OpenCodeProcess.MISSING_CLI_MESSAGE) ||
      /command not found: ?opencode/i.test(text)
    );
  }

  /**
   * A shell reporting that it could not find the command it was asked to run.
   * This is how a missing CLI surfaces on Windows, where the fallback is
   * `opencode.cmd` run through `cmd.exe`: the spawn succeeds and the shell
   * reports the missing shim on stderr, so ENOENT never fires. The text alone
   * does not name which command was missing, so callers must only trust it when
   * the CLI was already known to be unresolved.
   */
  static isShellCommandNotFoundFailure(text: string): boolean {
    return (
      /is not recognized as an internal or external command/i.test(text) ||
      /the system cannot find the (path|file) specified/i.test(text)
    );
  }

  private static readonly CLI_UPGRADE_COMMAND = 'opencode upgrade';
  private static readonly CLI_UPGRADE_ACTION = 'Run Upgrade';
  private static readonly CLI_UPGRADE_IN_TERMINAL_ACTION = 'Update in Terminal';
  private static readonly SHOW_LOGS_ACTION = 'Show Logs';
  // Windows resolves through a .cmd shim and is frequently slowed by realtime
  // antivirus scanning, so a 5s budget produces spurious "timed out" errors.
  private static readonly CLI_COMMAND_TIMEOUT_MS = process.platform === 'win32' ? 10_000 : 5000;
  // The OpenCode binary is ~130MB; 2 minutes times out on slow connections and
  // reports a download still in progress as a hard failure.
  private static readonly CLI_BACKGROUND_UPGRADE_TIMEOUT_MS = 5 * 60_000;
  private static readonly VERSION_CHECK_INTERVAL_MS = 5 * 60_000;
  private static readonly CLI_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60_000;
  private static readonly CLI_REGISTRY_TIMEOUT_MS = 10_000;
  private static readonly PORT_FALLBACK_MAX_OFFSET = 10;

  private _process: ChildProcess | null = null;
  private _port: number;
  private readonly originalPort: number;
  private portFallbackAttempts = 0;
  private portInUseDetected = false;
  private autoStart: boolean;
  private command: string;
  private readonly simulateMissingCli: boolean;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceInFlight = false;
  private pendingMaintenanceCheck: (() => void) | null = null;
  private lastMaintenanceCheckAt: number | null = null;
  private _managedProcess = false;
  private lastCliUpdateCheckAt = 0;
  private lastSuggestedCliVersion = '';
  private lastLoggedUnmanagedRestartKey = '';
  private resolvedCommandCache: {
    key: string;
    value: string;
    found: boolean;
  } | null = null;
  private _processStdoutHandler: ((data: Buffer) => void) | null = null;
  private _processStderrHandler: ((data: Buffer) => void) | null = null;
  private _processExitHandler:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | null = null;
  private _processErrorHandler: ((err: Error) => void) | null = null;
  private readonly processListeners = new WeakMap<ChildProcess, ProcessListeners>();
  private readonly processLaunches = new WeakMap<ChildProcess, ProcessLaunch>();
  private readonly processCleanupOperations = new WeakMap<ChildProcess, Promise<void>>();
  private readonly processResourceCleanupOperations = new WeakMap<ChildProcess, Promise<void>>();
  private compactionSettings: OpenCodeCompactionSettings;
  private askAgentEnabled: boolean;
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
  private readonly ownershipMarkerPath: string;

  constructor(
    port: number,
    autoStart: boolean,
    command?: string,
    simulateMissingCli = false,
    compactionSettings?: Partial<OpenCodeCompactionSettings>,
    ownershipLeasePath = getManagedServerOwnershipLeasePath(port),
    private readonly linuxProcRoot = '/proc',
    askAgentEnabled = false
  ) {
    const validatedPort = validateServerPort(port);
    this._port = validatedPort;
    this.originalPort = validatedPort;
    this.autoStart = autoStart;
    this.command = command?.trim() || '';
    this.simulateMissingCli = simulateMissingCli;
    this.compactionSettings = normalizeCompactionSettings(compactionSettings);
    this.askAgentEnabled = askAgentEnabled;
    this.ownershipLeasePath = ownershipLeasePath;
    this.ownershipMarkerPath = `${ownershipLeasePath}.managed`;
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
    this._port = validateServerPort(value);
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  get isAutoStartEnabled(): boolean {
    return this.autoStart;
  }

  updateLaunchSettings(options: { autoStart: boolean; command: string }) {
    const command = options.command.trim();
    if (command !== this.command) {
      this.command = command;
      this.clearResolvedCommandCache();
    }
    this.autoStart = options.autoStart;
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

  get isAdoptedManagedServer(): boolean {
    return (
      this._managedProcess &&
      !this._process &&
      this.ownershipLease?.host === this.hostOwner &&
      this.ownershipLease.state === 'active'
    );
  }

  get serverOwnership(): OpenCodeServerOwnership {
    if (this._managedProcess) return 'current-host';
    if (this.foreignActiveOwnership && this.ownershipLease) return 'other-host';
    return 'unmanaged';
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
    if (await this.takeOwnershipOfExistingServer()) {
      this.portFallbackAttempts = 0;
      this.portInUseDetected = false;
      return;
    }
    this._managedProcess = false;
    this.portFallbackAttempts = 0;
    this.portInUseDetected = false;
    await this.cleanupInjectedConfigFile();
  }

  async revalidateAdoptedManagedServer(): Promise<boolean> {
    const lease = this.isAdoptedManagedServer ? this.ownershipLease : null;
    if (!lease) return false;
    if (await this.matchesOwnershipLease(lease)) return true;
    if (!this.isAdoptedManagedServer || this.ownershipLease !== lease) return false;

    await Promise.all([
      this.clearManagedServerOwnership(lease.owner, lease.host),
      this.cleanupInjectedConfigFile(lease.configPath ?? this.injectedConfigPath),
    ]);
    return false;
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
    if (lease.state === 'active' && (await this.isOwnershipHostAlive(lease))) {
      this.observeForeignManagedServer(lease);
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

  acquireManagedServerRestartOwnership(): (() => Promise<void>) | Promise<() => Promise<void>> {
    if (!this.ownershipLease && !this.foreignActiveOwnership) {
      return () => Promise.resolve();
    }
    return this.runManagedServerRestartOwnershipAcquisition();
  }

  private async runManagedServerRestartOwnershipAcquisition(): Promise<() => Promise<void>> {
    const claim = await this.acquireOwnershipClaim();
    if (!claim) {
      throw new Error('Another Varro window is already restarting the OpenCode server');
    }

    const release = () => this.releaseOwnershipClaim(claim);

    try {
      const lease = await this.readOwnershipLease();
      if (!lease) {
        if (!this.ownershipLease) {
          await this.takeOwnershipOfMarkedListener(await this.readOwnershipHostIdentity());
        }
        return release;
      }
      if (!(await this.matchesOwnershipLease(lease))) {
        await this.removeOwnershipLease(lease.owner, lease.host);
        return release;
      }
      if (lease.configPath && !(await this.matchesInjectedConfigOwner(lease))) {
        throw new Error('Managed OpenCode ownership no longer matches its temporary config');
      }

      const claimed: ManagedServerOwnershipLease = {
        ...lease,
        host: this.hostOwner,
        state: 'active',
      };
      delete claimed.hostPid;
      delete claimed.hostBirthIdentity;
      Object.assign(claimed, await this.readOwnershipHostIdentity());
      await this.writeOwnershipLease(claimed);
      this.adoptManagedServerOwnership(claimed);
      return release;
    } catch (err) {
      await release();
      throw err;
    }
  }

  hasTransferredManagedServerOwnership(proc: ChildProcess): boolean {
    const launch = this.processLaunches.get(proc);
    if (!launch) return false;
    try {
      const lease = parseManagedServerOwnershipLease(
        JSON.parse(readFileSync(this.ownershipLeasePath, 'utf-8'))
      );
      return !!lease && lease.owner === launch.owner && lease.host !== this.hostOwner;
    } catch {
      return false;
    }
  }

  async takeOwnershipOfExistingServer(): Promise<boolean> {
    if (this._managedProcess || this._process) {
      return false;
    }
    if (await this.readOwnershipLease()) {
      await this.refreshManagedServerOwnership();
      if (this._managedProcess || this.foreignActiveOwnership) return this._managedProcess;
      if (await this.readOwnershipLease()) return false;
    }

    const claim = await this.acquireOwnershipClaim();
    if (!claim) return false;

    try {
      if (await this.readOwnershipLease()) return false;
      return await this.takeOwnershipOfMarkedListener(await this.readOwnershipHostIdentity());
    } finally {
      await this.releaseOwnershipClaim(claim);
    }
  }

  private async takeOwnershipOfMarkedListener(
    ownershipHostIdentity: Pick<ManagedServerOwnershipLease, 'hostPid' | 'hostBirthIdentity'>
  ): Promise<boolean> {
    const listeners = await findListeningPids(this._port, this.linuxProcRoot);
    if (listeners.length !== 1) return false;
    const pid = listeners[0]!;
    const [executable, birthIdentity] = await Promise.all([
      readProcessExecutable(pid, this.linuxProcRoot),
      readProcessBirthIdentity(pid, this.linuxProcRoot),
    ]);
    if (!executable || !birthIdentity) return false;
    const processOwner =
      (await this.readMatchingOwnershipMarker(pid, executable, birthIdentity)) ??
      (await this.findInjectedConfigOwner(pid, executable, birthIdentity));
    if (!processOwner) return false;
    const lease: ManagedServerOwnershipLease = {
      version: 1,
      pid,
      port: this._port,
      executable,
      birthIdentity,
      owner: processOwner.owner,
      host: this.hostOwner,
      ...ownershipHostIdentity,
      state: 'active',
      createdAt: processOwner.createdAt,
    };
    if (processOwner.configPath) lease.configPath = processOwner.configPath;
    if (
      !(await this.matchesOwnershipLease(lease)) ||
      !(await this.matchesInjectedConfigOwner(lease))
    ) {
      return false;
    }
    await this.writeOwnershipMarker(lease);
    await this.writeOwnershipLease(lease);
    this.adoptManagedServerOwnership(lease);
    logger.info(`Took ownership of existing OpenCode server PID ${pid}`);
    return true;
  }

  private async runManagedServerOwnershipRefresh(): Promise<boolean> {
    const lease = await this.readOwnershipLease();
    if (!lease) {
      this.foreignActiveOwnership = false;
      if (!this._managedProcess) {
        this.ownershipLease = null;
        this.ownershipOwner = null;
      }
      return false;
    }
    if (!(await this.matchesOwnershipLease(lease))) {
      await this.removeOwnershipLease(lease.owner, lease.host);
      this.foreignActiveOwnership = false;
      return false;
    }
    if (lease.state === 'active' && (await this.isOwnershipHostAlive(lease))) {
      this.observeForeignManagedServer(lease);
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
    const claimedLease = await this.claimAvailableOwnershipLease(lease);
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

  private observeForeignManagedServer(lease: ManagedServerOwnershipLease) {
    this.ownershipLease = lease;
    this.ownershipOwner = lease.owner;
    this._managedProcess = false;
    this._port = lease.port;
  }

  async confirmManagedServerOwnership(proc = this._process): Promise<boolean> {
    const launch = proc ? this.processLaunches.get(proc) : undefined;
    const owner = launch?.owner;
    if (!proc?.pid || !owner || this._process !== proc) {
      this.markOwnershipConfirmationFailed(proc);
      return false;
    }

    let listenerPid: number | undefined;
    let executable = '';
    let birthIdentity = '';
    let ownershipHostIdentity: Pick<ManagedServerOwnershipLease, 'hostPid' | 'hostBirthIdentity'> =
      {};
    const attempts = process.platform === 'win32' ? WINDOWS_OWNERSHIP_CONFIRM_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      listenerPid = undefined;
      executable = '';
      birthIdentity = '';
      const listeners = await findListeningPids(launch.port, this.linuxProcRoot);
      for (const pid of listeners) {
        if (await isProcessOrDescendant(pid, proc.pid, this.linuxProcRoot)) {
          listenerPid = pid;
          break;
        }
      }
      if (listenerPid) {
        [executable, birthIdentity, ownershipHostIdentity] = await Promise.all([
          readProcessExecutable(listenerPid, this.linuxProcRoot),
          readProcessBirthIdentity(listenerPid, this.linuxProcRoot),
          this.readOwnershipHostIdentity(),
        ]);
        if (executable && birthIdentity) break;
      }
      if (attempt + 1 < attempts) await delay(WINDOWS_OWNERSHIP_CONFIRM_RETRY_MS);
    }
    if (this._process !== proc || this.processLaunches.get(proc)?.owner !== owner) {
      return false;
    }
    if (!listenerPid) {
      this.markOwnershipConfirmationFailed(proc);
      logger.warn(`Could not bind managed OpenCode ownership to port ${launch.port}`);
      return false;
    }
    if (!executable) {
      this.markOwnershipConfirmationFailed(proc);
      logger.warn(`Could not read executable identity for managed OpenCode PID ${listenerPid}`);
      return false;
    }
    if (!birthIdentity) {
      this.markOwnershipConfirmationFailed(proc);
      logger.warn(`Could not read process birth identity for managed OpenCode PID ${listenerPid}`);
      return false;
    }
    launch.listenerPid = listenerPid;

    const lease: ManagedServerOwnershipLease = {
      version: 1,
      pid: listenerPid,
      port: launch.port,
      executable,
      birthIdentity,
      owner,
      host: this.hostOwner,
      ...ownershipHostIdentity,
      state: 'active',
      createdAt: Date.now(),
    };
    if (launch.configPath) lease.configPath = launch.configPath;
    try {
      await this.writeOwnershipMarker(lease);
      launch.ownershipMarkerWritten = true;
      if (lease.configPath) {
        if (!(await isSafeInjectedConfigPath(lease.configPath))) {
          this.markOwnershipConfirmationFailed(proc);
          logger.warn(
            `Refusing to persist untrusted temporary OpenCode config path: ${lease.configPath}`
          );
          return false;
        }
        await writeFile(
          join(dirname(lease.configPath), INJECTED_CONFIG_OWNER_FILE),
          `${JSON.stringify({
            pid: lease.pid,
            owner: lease.owner,
            createdAt: lease.createdAt,
            port: lease.port,
            executable: lease.executable,
            birthIdentity: lease.birthIdentity,
          })}\n`,
          'utf-8'
        );
        this.injectedConfigOwnerPid = lease.pid;
      }
      await this.writeOwnershipLease(lease);
    } catch (err) {
      this.markOwnershipConfirmationFailed(proc);
      logger.warn(
        `Failed to persist managed OpenCode ownership: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
    if (this._process !== proc || this.processLaunches.get(proc)?.owner !== owner) {
      await this.removeOwnershipLease(owner, this.hostOwner);
      return false;
    }
    this.ownershipLease = lease;
    this.ownershipOwner = owner;
    launch.ownershipConfirmed = true;
    this._managedProcess = true;
    return true;
  }

  private markOwnershipConfirmationFailed(proc: ChildProcess | null) {
    if (proc && this._process === proc) this._managedProcess = false;
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
    const nextAttempt = this.portFallbackAttempts + 1;
    const nextPort = this.originalPort + nextAttempt;
    if (nextPort > MAX_SERVER_PORT) return false;
    this.portFallbackAttempts = nextAttempt;
    this._port = nextPort;
    return true;
  }

  async syncInjectedConfigFile() {
    await this.runInjectedConfigOperation(async () => {
      await sweepStaleInjectedConfigDirectories();
      if (!this.hasInjectedConfigOverride()) {
        await this.removeInjectedConfigFile(this.injectedConfigPath);
        return;
      }
      if (getEnvironmentValue(process.env, 'OPENCODE_CONFIG')?.trim()) {
        await this.removeInjectedConfigFile(this.injectedConfigPath);
        logger.warn(
          'Preserving caller-provided OPENCODE_CONFIG; Varro runtime settings are not injected for this managed server'
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
    const compaction: Partial<OpenCodeCompactionSettings> = {};
    if (this.compactionSettings.auto !== null) compaction.auto = this.compactionSettings.auto;
    if (this.compactionSettings.reserved !== null) {
      compaction.reserved = this.compactionSettings.reserved;
    }
    const config: Record<string, unknown> = {};
    if (Object.keys(compaction).length > 0) config.compaction = compaction;
    if (this.askAgentEnabled && !(await this.hasConfiguredAskAgent())) {
      config.agent = { ask: ASK_AGENT };
    }
    return `${JSON.stringify(config, null, 2)}\n`;
  }

  private async hasConfiguredAskAgent(): Promise<boolean> {
    const inherited = getEnvironmentValue(process.env, 'OPENCODE_CONFIG_CONTENT');
    if (inherited?.trim() && containsAskAgent(inherited)) return true;

    const workspaceCwd = this.getWorkspaceCwd();
    const paths = [
      ...getOpenCodeConfigPaths(),
      ...(workspaceCwd ? await resolveProjectConfigPaths(workspaceCwd) : []),
    ];
    for (const path of paths) {
      try {
        if (containsAskAgent(await readFile(path, 'utf-8'))) return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        logger.warn(
          `Could not inspect OpenCode config for an existing Ask agent: ${err instanceof Error ? err.message : String(err)}`
        );
        return true;
      }
    }
    return false;
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

  hasInjectedConfigOverride() {
    return this.hasInjectedCompactionOverride() || this.askAgentEnabled;
  }

  async updateAskAgentEnabled(enabled: boolean, callbacks: UpdateCompactionSettingsCallbacks) {
    const changed = this.askAgentEnabled !== enabled;
    this.askAgentEnabled = enabled;
    await this.rewriteInjectedConfigFile();
    if (!changed || callbacks.status.state !== 'running') return;
    if (this.foreignActiveOwnership) await this.refreshManagedServerOwnership();
    if (!this._managedProcess) {
      logger.warn(
        'Varro Ask agent changes can only be reapplied automatically for a Varro-managed OpenCode server'
      );
      return;
    }
    if (!this.injectedConfigPath) {
      if (getEnvironmentValue(process.env, 'OPENCODE_CONFIG')?.trim()) {
        logger.warn(
          'Preserving caller-provided OPENCODE_CONFIG; the Varro Ask agent cannot be injected for this managed server'
        );
        return;
      }
      if (enabled) {
        await callbacks.restartManagedServerForCompactionSettings();
      }
      return;
    }
    try {
      await callbacks.request('POST', '/global/dispose');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `Failed to dispose OpenCode instances after Ask agent setting change: ${message}`
      );
      await callbacks.restartManagedServerForCompactionSettings();
    }
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

  launchServer(callbacks: LaunchCallbacks): ChildProcess {
    const trackedProcess = this._process;
    if (trackedProcess) {
      if (trackedProcess.exitCode === null && trackedProcess.signalCode === null) {
        throw new Error('Cannot launch OpenCode while a managed child is still running');
      }
      throw new Error('Cannot launch OpenCode before the previous managed process tree is cleaned');
    }

    const command = this.resolveCommand();
    const args = ['serve', '--port', String(this._port)];
    logger.info(`Starting OpenCode server with command: ${command}`);

    const configPath = this.injectedConfigPath;
    const owner = randomBytes(16).toString('hex');
    const launchPort = this._port;
    const useProcessGroup = process.platform !== 'win32';
    this.ownershipOwner = owner;
    this.foreignActiveOwnership = false;
    let proc: ChildProcess;
    try {
      const spawnOptions: SpawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Keep POSIX wrappers and descendants in a group that survives the wrapper PID.
        detached: useProcessGroup,
        cwd: callbacks.getWorkspaceCwd(),
        env: this.buildServerEnv(configPath, owner),
        windowsHide: true,
      };
      proc = crossSpawn(command, args, spawnOptions);
    } catch (err) {
      if (this.ownershipOwner === owner) this.ownershipOwner = null;
      void this.cleanupInjectedConfigFile(configPath);
      throw err;
    }

    this._process = proc;
    this.processLaunches.set(proc, {
      configPath,
      listenerPid: null,
      owner,
      ownershipConfirmed: false,
      ownershipMarkerWritten: false,
      port: launchPort,
      processGroupId: useProcessGroup ? (proc.pid ?? null) : null,
    });
    let bindError: Error | null = null;
    try {
      this.bindInjectedConfigOwner(configPath, proc, owner);
    } catch (err) {
      bindError = err instanceof Error ? err : new Error(String(err));
    }
    this._managedProcess = true;

    const listeners: ProcessListeners = {
      stdout: callbacks.onStdout,
      stderr: callbacks.onStderr,
      exit: (code, signal) => callbacks.onExit(proc, code, signal),
      error: (err) => callbacks.onError(proc, err),
    };
    this.processListeners.set(proc, listeners);
    this._processStdoutHandler = listeners.stdout;
    this._processStderrHandler = listeners.stderr;
    this._processExitHandler = listeners.exit;
    this._processErrorHandler = listeners.error;
    proc.once?.('exit', () => {
      void this.releaseExitedProcess(proc).catch((err: unknown) => {
        logger.warn(
          `Failed to clean up exited OpenCode process tree: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    });
    proc.stdout?.on('data', listeners.stdout);
    proc.stderr?.on('data', listeners.stderr);
    proc.on('exit', listeners.exit);
    proc.on('error', listeners.error);
    if (bindError) queueMicrotask(() => listeners.error(bindError));
    return proc;
  }

  private bindInjectedConfigOwner(configPath: string | null, proc: ChildProcess, owner: string) {
    if (!configPath) return;
    // A child without a PID never started, so there is no owner to record. Node still emits the
    // real spawn failure - ENOENT for a bad varro.server.command - on the next tick. Throwing a
    // generic bind error here would be delivered first and would mask that actionable message.
    if (!proc.pid) return;
    writeFileSync(
      join(dirname(configPath), INJECTED_CONFIG_OWNER_FILE),
      `${JSON.stringify({ pid: proc.pid, owner, createdAt: Date.now() })}\n`,
      'utf-8'
    );
    if (this.injectedConfigPath === configPath) this.injectedConfigOwnerPid = proc.pid;
  }

  detachProcessListeners(proc: ChildProcess | null) {
    if (!proc) return;
    const listeners = this.processListeners.get(proc);
    const stdout =
      listeners?.stdout ?? (this._process === proc ? this._processStdoutHandler : null);
    const stderr =
      listeners?.stderr ?? (this._process === proc ? this._processStderrHandler : null);
    const exit = listeners?.exit ?? (this._process === proc ? this._processExitHandler : null);
    const error = listeners?.error ?? (this._process === proc ? this._processErrorHandler : null);
    if (stdout) proc.stdout?.off('data', stdout);
    if (stderr) proc.stderr?.off('data', stderr);
    if (exit) proc.off('exit', exit);
    if (error) proc.off('error', error);
    this.processListeners.delete(proc);
    if (this._process !== proc) return;
    this._processStdoutHandler = null;
    this._processStderrHandler = null;
    this._processExitHandler = null;
    this._processErrorHandler = null;
  }

  releaseExitedProcess(proc: ChildProcess): Promise<void> {
    return this.cleanupLaunchProcess(proc);
  }

  terminateLaunchAttempt(proc: ChildProcess): Promise<void> {
    return this.cleanupLaunchProcess(proc);
  }

  private cleanupLaunchProcess(proc: ChildProcess): Promise<void> {
    const existing = this.processCleanupOperations.get(proc);
    if (existing) return existing;

    this.detachProcessListeners(proc);
    const launch = this.processLaunches.get(proc);
    const operation = (async () => {
      await this.terminateManagedProcess(proc, launch);
      await this.cleanupLaunchResources(proc);
      if (this._process === proc) {
        this._process = null;
        this._managedProcess = false;
      }
    })();
    this.processCleanupOperations.set(proc, operation);
    void operation.catch(() => {
      if (this.processCleanupOperations.get(proc) === operation) {
        this.processCleanupOperations.delete(proc);
      }
    });
    return operation;
  }

  private cleanupLaunchResources(proc: ChildProcess): Promise<void> {
    const existing = this.processResourceCleanupOperations.get(proc);
    if (existing) return existing;
    const launch = this.processLaunches.get(proc);
    if (!launch) return Promise.resolve();

    if (!launch.ownershipConfirmed) {
      this.clearLocalOwnership(launch.owner, this.hostOwner);
    }
    const operation = Promise.all([
      launch.configPath ? this.cleanupInjectedConfigFile(launch.configPath) : Promise.resolve(),
      launch.ownershipConfirmed
        ? this.clearManagedServerOwnership(launch.owner, this.hostOwner)
        : launch.ownershipMarkerWritten
          ? this.removeOwnershipMarker(launch.owner)
          : Promise.resolve(),
    ]).then(() => undefined);
    this.processResourceCleanupOperations.set(proc, operation);
    void operation.catch(() => {
      if (this.processResourceCleanupOperations.get(proc) === operation) {
        this.processResourceCleanupOperations.delete(proc);
      }
    });
    return operation;
  }

  async stopManagedProcessForRestart() {
    const proc = this._process;
    const lease = this.ownershipLease;
    if (!proc && !lease) {
      await this.cleanupInjectedConfigFile();
      return;
    }

    if (proc && this.processLaunches.has(proc)) {
      await this.cleanupLaunchProcess(proc);
      return;
    }
    if (proc && !lease) {
      await this.cleanupLaunchProcess(proc);
      await this.cleanupInjectedConfigFile();
      return;
    }

    this.detachProcessListeners(proc);
    if (lease && !(await this.terminateOwnedLease(lease))) {
      throw new Error(
        `Managed OpenCode ownership lease no longer matches the listener on port ${lease.port}`
      );
    }
    if (proc && this._process === proc) this._process = null;
    this._managedProcess = false;
    await Promise.all([
      this.cleanupInjectedConfigFile(lease?.configPath ?? this.injectedConfigPath),
      ...(proc ? [this.cleanupLaunchResources(proc)] : []),
    ]);
  }

  private async terminateManagedProcess(proc: ChildProcess, launch?: ProcessLaunch) {
    if (!proc.pid) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      return;
    }
    if (process.platform === 'win32') {
      await this.terminateWindowsProcessTree(proc, launch);
      return;
    }
    if (launch?.processGroupId) {
      await this.terminatePosixProcessTree(proc, launch);
      return;
    }

    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    const exited = await waitForProcessExit(proc, PROCESS_STOP_TIMEOUT_MS);
    if (!exited && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    if (!exited && !(await waitForProcessExit(proc, PROCESS_STOP_TIMEOUT_MS))) {
      throw new Error(`Managed OpenCode process ${proc.pid} did not exit after SIGKILL`);
    }
  }

  private async terminatePosixProcessTree(proc: ChildProcess, launch: ProcessLaunch) {
    const processGroupId = launch.processGroupId!;
    const knownListenerPids = new Set<number>();
    if (launch.listenerPid) knownListenerPids.add(launch.listenerPid);
    await this.findManagedListeningPids(proc, launch, knownListenerPids);

    signalProcessGroup(processGroupId, 'SIGTERM');
    if (
      await this.waitForManagedProcessTreeExit(
        proc,
        launch,
        knownListenerPids,
        PROCESS_STOP_TIMEOUT_MS
      )
    ) {
      return;
    }

    signalProcessGroup(processGroupId, 'SIGKILL');
    const remainingListeners = await this.findManagedListeningPids(proc, launch, knownListenerPids);
    for (const pid of remainingListeners) {
      if ((await readProcessGroupId(pid)) === processGroupId) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') throw err;
      }
    }
    if (
      !(await this.waitForManagedProcessTreeExit(
        proc,
        launch,
        knownListenerPids,
        PROCESS_STOP_TIMEOUT_MS
      ))
    ) {
      throw new Error(`Managed OpenCode process tree ${proc.pid} did not exit after SIGKILL`);
    }
  }

  private async terminateWindowsProcessTree(proc: ChildProcess, launch?: ProcessLaunch) {
    const knownListenerPids = new Set<number>();
    if (launch?.listenerPid) knownListenerPids.add(launch.listenerPid);
    const wrapperAlreadyExited = proc.exitCode !== null || proc.signalCode !== null;
    let managedListeners = await this.findManagedListeningPids(proc, launch, knownListenerPids);
    if (!wrapperAlreadyExited) proc.kill('SIGTERM');
    let wrapperExited = await waitForProcessExit(proc, PROCESS_STOP_TIMEOUT_MS);
    managedListeners = await this.findManagedListeningPids(proc, launch, knownListenerPids);

    if (!wrapperAlreadyExited && !wrapperExited) {
      await runProcess(
        'taskkill.exe',
        ['/PID', String(proc.pid), '/T', '/F'],
        PROCESS_STOP_TIMEOUT_MS
      );
      managedListeners = await this.findManagedListeningPids(proc, launch, knownListenerPids);
      wrapperExited = await waitForProcessExit(proc, PROCESS_STOP_TIMEOUT_MS);
    }
    if (managedListeners.length > 0) {
      for (const pid of managedListeners) {
        if (pid === proc.pid) continue;
        await runProcess(
          'taskkill.exe',
          ['/PID', String(pid), '/T', '/F'],
          PROCESS_STOP_TIMEOUT_MS
        );
      }
    }

    if (!wrapperExited) {
      throw new Error(`Managed OpenCode process ${proc.pid} did not exit after taskkill`);
    }
    if (
      !(await this.waitForManagedListenersToExit(
        proc,
        launch,
        knownListenerPids,
        PROCESS_STOP_TIMEOUT_MS
      ))
    ) {
      throw new Error(
        `Managed OpenCode listener on port ${launch?.port ?? this._port} did not exit after taskkill`
      );
    }
  }

  private async waitForManagedProcessTreeExit(
    proc: ChildProcess,
    launch: ProcessLaunch,
    knownListenerPids: Set<number>,
    timeoutMs: number
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const listeners = await this.findManagedListeningPids(proc, launch, knownListenerPids);
      if (!isProcessGroupAlive(launch.processGroupId!) && listeners.length === 0) return true;
      await delay(100);
    }
    const listeners = await this.findManagedListeningPids(proc, launch, knownListenerPids);
    return !isProcessGroupAlive(launch.processGroupId!) && listeners.length === 0;
  }

  private async waitForManagedListenersToExit(
    proc: ChildProcess,
    launch: ProcessLaunch | undefined,
    knownListenerPids: Set<number>,
    timeoutMs: number
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.findManagedListeningPids(proc, launch, knownListenerPids)).length === 0) {
        return true;
      }
      await delay(100);
    }
    return (await this.findManagedListeningPids(proc, launch, knownListenerPids)).length === 0;
  }

  private async findManagedListeningPids(
    proc: ChildProcess,
    launch: ProcessLaunch | undefined,
    knownListenerPids: Set<number>
  ) {
    const listeners = await findListeningPids(launch?.port ?? this._port, this.linuxProcRoot);
    const managedListeners: number[] = [];
    for (const pid of listeners) {
      let managed = knownListenerPids.has(pid) || launch?.listenerPid === pid;
      if (!managed && launch?.processGroupId) {
        managed = (await readProcessGroupId(pid)) === launch.processGroupId;
      }
      if (!managed && proc.pid) {
        managed = await isProcessOrDescendant(pid, proc.pid, this.linuxProcRoot);
      }
      if (!managed) continue;
      knownListenerPids.add(pid);
      managedListeners.push(pid);
    }
    return managedListeners;
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
    const listeners = await findListeningPids(lease.port, this.linuxProcRoot);
    if (!listeners.includes(lease.pid)) return false;
    const executable = await readProcessExecutable(lease.pid, this.linuxProcRoot);
    if (
      !executable ||
      normalizeExecutableIdentity(executable) !== normalizeExecutableIdentity(lease.executable)
    ) {
      return false;
    }
    return (await readProcessBirthIdentity(lease.pid, this.linuxProcRoot)) === lease.birthIdentity;
  }

  private async readOwnershipHostIdentity() {
    const hostBirthIdentity = await readProcessBirthIdentity(process.pid, this.linuxProcRoot);
    return hostBirthIdentity ? { hostPid: process.pid, hostBirthIdentity } : {};
  }

  private async isOwnershipHostAlive(lease: ManagedServerOwnershipLease) {
    if (lease.host === this.hostOwner) return true;
    if (!lease.hostPid || !lease.hostBirthIdentity) return true;
    if (!isProcessAlive(lease.hostPid)) return false;
    const birthIdentity = await readProcessBirthIdentity(lease.hostPid, this.linuxProcRoot);
    return !birthIdentity || birthIdentity === lease.hostBirthIdentity;
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

  private async findInjectedConfigOwner(
    pid: number,
    executable: string,
    birthIdentity: string
  ): Promise<(InjectedConfigOwner & { configPath: string }) | null> {
    let entries: Dirent[];
    try {
      entries = await readdir(tmpdir(), { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(INJECTED_CONFIG_DIRECTORY_PREFIX)) {
        continue;
      }
      const configPath = join(tmpdir(), entry.name, 'opencode.json');
      if (!(await isSafeInjectedConfigPath(configPath))) continue;
      let owner: InjectedConfigOwner | null = null;
      try {
        owner = parseInjectedConfigOwner(
          JSON.parse(await readFile(join(dirname(configPath), INJECTED_CONFIG_OWNER_FILE), 'utf-8'))
        );
      } catch {}
      if (!owner || owner.pid !== pid) continue;
      if (owner.port !== undefined) {
        if (
          owner.port === this._port &&
          normalizeExecutableIdentity(owner.executable!) ===
            normalizeExecutableIdentity(executable) &&
          owner.birthIdentity === birthIdentity
        ) {
          return { ...owner, configPath };
        }
        continue;
      }
      const [processConfigPath, processOwner] = await Promise.all([
        readProcessEnvironmentValue(pid, 'OPENCODE_CONFIG', this.linuxProcRoot),
        readProcessEnvironmentValue(pid, SERVER_OWNER_ENV, this.linuxProcRoot),
      ]);
      if (processConfigPath === configPath && processOwner === owner.owner) {
        return { ...owner, configPath };
      }
    }
    return null;
  }

  private async readMatchingOwnershipMarker(
    pid: number,
    executable: string,
    birthIdentity: string
  ): Promise<InjectedConfigOwner | null> {
    let owner: InjectedConfigOwner | null = null;
    try {
      owner = parseInjectedConfigOwner(
        JSON.parse(await readFile(this.ownershipMarkerPath, 'utf-8'))
      );
    } catch {}
    if (
      !owner ||
      owner.pid !== pid ||
      owner.port !== this._port ||
      normalizeExecutableIdentity(owner.executable!) !== normalizeExecutableIdentity(executable) ||
      owner.birthIdentity !== birthIdentity
    ) {
      return null;
    }
    if (owner.configPath && !(await isSafeInjectedConfigPath(owner.configPath))) return null;
    return owner;
  }

  private async writeOwnershipMarker(lease: ManagedServerOwnershipLease) {
    const marker: InjectedConfigOwner = {
      pid: lease.pid,
      owner: lease.owner,
      createdAt: lease.createdAt,
      port: lease.port,
      executable: lease.executable,
      birthIdentity: lease.birthIdentity,
    };
    if (lease.configPath) marker.configPath = lease.configPath;
    await writeFile(this.ownershipMarkerPath, `${JSON.stringify(marker)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  private async removeOwnershipMarker(expectedOwner: string) {
    let owner: InjectedConfigOwner | null = null;
    try {
      owner = parseInjectedConfigOwner(
        JSON.parse(await readFile(this.ownershipMarkerPath, 'utf-8'))
      );
    } catch {}
    if (owner?.owner !== expectedOwner) return;
    await rm(this.ownershipMarkerPath, { force: true });
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

  private async acquireOwnershipClaim(): Promise<ManagedServerOwnershipClaimHandle | null> {
    const path = `${this.ownershipLeasePath}.claim`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle: Awaited<ReturnType<typeof openFile>>;
      try {
        handle = await openFile(path, 'wx', 0o600);
      } catch (err) {
        if (
          attempt > 0 ||
          (err as NodeJS.ErrnoException)?.code !== 'EEXIST' ||
          !(await this.removeStaleOwnershipClaim(path))
        ) {
          return null;
        }
        continue;
      }

      try {
        const hostIdentity = await this.readOwnershipHostIdentity();
        const claim: ManagedServerOwnershipClaim = {
          version: 1,
          host: this.hostOwner,
          hostPid: hostIdentity.hostPid ?? process.pid,
          createdAt: Date.now(),
        };
        if (hostIdentity.hostBirthIdentity) {
          claim.hostBirthIdentity = hostIdentity.hostBirthIdentity;
        }
        await handle.writeFile(`${JSON.stringify(claim)}\n`, { encoding: 'utf-8' });
        return { path, handle, claim };
      } catch (err) {
        await handle.close().catch(() => {});
        await rm(path, { force: true }).catch(() => {});
        throw err;
      }
    }
    return null;
  }

  private async removeStaleOwnershipClaim(path: string): Promise<boolean> {
    let claim: ManagedServerOwnershipClaim | null = null;
    try {
      claim = parseManagedServerOwnershipClaim(JSON.parse(await readFile(path, 'utf-8')));
    } catch {}

    if (claim) {
      if (claim.host === this.hostOwner) return false;
      if (isProcessAlive(claim.hostPid)) {
        if (claim.hostBirthIdentity) {
          const birthIdentity = await readProcessBirthIdentity(claim.hostPid, this.linuxProcRoot);
          if (!birthIdentity || birthIdentity === claim.hostBirthIdentity) return false;
        } else if (Date.now() - claim.createdAt < OWNERSHIP_CLAIM_MAX_AGE_MS) {
          return false;
        }
      }
    } else {
      try {
        const info = await readStat(path);
        if (Date.now() - info.mtimeMs < LEGACY_OWNERSHIP_CLAIM_STALE_AGE_MS) return false;
      } catch {
        return true;
      }
    }

    try {
      await rm(path);
      logger.info('Removed stale OpenCode server ownership claim');
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    }
  }

  private async releaseOwnershipClaim(claim: ManagedServerOwnershipClaimHandle) {
    await claim.handle.close().catch(() => {});
    try {
      const current = parseManagedServerOwnershipClaim(
        JSON.parse(await readFile(claim.path, 'utf-8'))
      );
      if (
        current?.host === claim.claim.host &&
        current.hostPid === claim.claim.hostPid &&
        current.hostBirthIdentity === claim.claim.hostBirthIdentity &&
        current.createdAt === claim.claim.createdAt
      ) {
        await rm(claim.path, { force: true });
      }
    } catch {}
  }

  private async claimAvailableOwnershipLease(
    lease: ManagedServerOwnershipLease
  ): Promise<ManagedServerOwnershipLease | null> {
    const claim = await this.acquireOwnershipClaim();
    if (!claim) return null;

    try {
      const current = await this.readOwnershipLease();
      const ownershipAvailable =
        current?.state === 'relinquished' ||
        (current?.state === 'active' && !(await this.isOwnershipHostAlive(current)));
      if (
        !current ||
        current.owner !== lease.owner ||
        current.host !== lease.host ||
        !ownershipAvailable ||
        current.pid !== lease.pid ||
        current.port !== lease.port ||
        current.executable !== lease.executable ||
        current.birthIdentity !== lease.birthIdentity ||
        current.hostPid !== lease.hostPid ||
        current.hostBirthIdentity !== lease.hostBirthIdentity ||
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
      delete claimed.hostPid;
      delete claimed.hostBirthIdentity;
      Object.assign(claimed, await this.readOwnershipHostIdentity());
      await this.writeOwnershipLease(claimed);
      return claimed;
    } finally {
      await this.releaseOwnershipClaim(claim);
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
    if (expectedOwner) {
      const current = await this.readOwnershipLease();
      if (
        current &&
        (current.owner !== expectedOwner || (expectedHost && current.host !== expectedHost))
      ) {
        this.clearLocalOwnership(expectedOwner, expectedHost);
        return;
      }
    }
    await rm(this.ownershipLeasePath, { force: true });
    this.clearLocalOwnership(expectedOwner, expectedHost);
  }

  private clearLocalOwnership(expectedOwner?: string, expectedHost?: string) {
    const matches = (lease: ManagedServerOwnershipLease | null) =>
      !!lease &&
      (!expectedOwner || lease.owner === expectedOwner) &&
      (!expectedHost || lease.host === expectedHost);
    const currentLaunchOwner = this._process
      ? this.processLaunches.get(this._process)?.owner
      : undefined;
    let cleared = false;

    if (!expectedOwner || matches(this.ownershipLease)) {
      cleared ||= this.ownershipLease !== null;
      this.ownershipLease = null;
    }
    if (!expectedOwner || matches(this.ownershipLeaseCandidate)) {
      cleared ||= this.ownershipLeaseCandidate !== null;
      this.ownershipLeaseCandidate = null;
    }
    if (!expectedOwner || this.ownershipOwner === expectedOwner) {
      cleared ||= this.ownershipOwner !== null;
      this.ownershipOwner = null;
    }
    if (!expectedOwner || currentLaunchOwner === expectedOwner || (!this._process && cleared)) {
      this._managedProcess = false;
    }
    if (cleared) this.foreignActiveOwnership = false;
  }

  private async clearManagedServerOwnership(expectedOwner: string, expectedHost: string) {
    await Promise.all([
      this.removeOwnershipLease(expectedOwner, expectedHost),
      this.removeOwnershipMarker(expectedOwner),
    ]);
  }

  async stopServerForRestart() {
    const ports = [...new Set([this._port, this.originalPort])];
    if (this.foreignActiveOwnership) await this.refreshManagedServerOwnership();
    if (this._process || (this._managedProcess && this.ownershipLease)) {
      await this.stopManagedProcessForRestart();
    }

    for (const port of ports) {
      if ((await findListeningPids(port, this.linuxProcRoot)).length > 0) {
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
    if (options.stopProcess && (this._process || (this._managedProcess && this.ownershipLease))) {
      await this.stopManagedProcessForRestart();
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

  requestMaintenanceCheck(tick: () => void, force = false) {
    if (this.maintenanceInFlight) {
      if (force) this.pendingMaintenanceCheck = tick;
      return;
    }
    const now = Date.now();
    if (
      !force &&
      this.lastMaintenanceCheckAt !== null &&
      now - this.lastMaintenanceCheckAt < OpenCodeProcess.VERSION_CHECK_INTERVAL_MS
    ) {
      return;
    }
    this.lastMaintenanceCheckAt = now;
    tick();
  }

  async runMaintenanceTick(callbacks: MaintenanceCallbacks) {
    if (this.maintenanceInFlight || callbacks.isDisposing()) return;
    this.lastMaintenanceCheckAt = Date.now();
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
        await callbacks.takeOwnershipOfExistingServer();
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
    let backgroundFailure: UpgradeFailureReport | null = null;
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
        backgroundFailure = this.describeUpgradeError(err);
        logger.warn(`Failed to auto-update OpenCode CLI in background: ${backgroundFailure.cause}`);
      }
    }

    if (this.lastSuggestedCliVersion === latestCliVersion) {
      return null;
    }
    this.lastSuggestedCliVersion = latestCliVersion;

    if (backgroundFailure) {
      // The routine "update is available" phrasing would hide the fact that
      // Varro already tried and failed, and the default action would re-run
      // the command that just failed.
      this.reportFailedBackgroundUpgrade(latestCliVersion, backgroundFailure, callbacks);
      return null;
    }

    const upgradeCommand = OpenCodeProcess.CLI_UPGRADE_COMMAND;
    const message = exceedsTestedCeiling
      ? `OpenCode CLI ${latestCliVersion} is available, but Varro has only been tested through ${maximumTestedOpenCodeVersion}. Review compatibility before updating with: ${upgradeCommand}`
      : `OpenCode CLI ${latestCliVersion} is available (installed: ${installedCliVersion}). Update with: ${upgradeCommand}`;
    logger.info(message);
    void Promise.resolve(
      vscode.window.showInformationMessage(message, OpenCodeProcess.CLI_UPGRADE_ACTION)
    )
      .then(async (action) => {
        if (action === OpenCodeProcess.CLI_UPGRADE_ACTION) {
          if (await callbacks.upgradeRunningServer(latestCliVersion)) {
            callbacks.requestMaintenanceCheck();
            return;
          }
          await this.runTerminalCliUpgrade(latestCliVersion, callbacks);
        }
      })
      .catch((err: unknown) => {
        logger.warn(
          `Failed to handle OpenCode CLI update notification action: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    return null;
  }

  /**
   * Turns a raw upgrade error into the cause plus the one instruction that
   * actually applies to this install.
   */
  describeUpgradeError(err: unknown): UpgradeFailureReport {
    const cause = err instanceof Error ? err.message : String(err);
    const { installMethod } = this.getInstallInfo();
    const kind = classifyUpgradeFailure(cause, process.platform);
    return {
      cause,
      kind,
      installMethod,
      guidance: describeUpgradeFailure(kind, installMethod, process.platform),
      suggestedCommand: getRecoveryCommand(kind, installMethod, process.platform),
    };
  }

  private reportFailedBackgroundUpgrade(
    latestCliVersion: string,
    failure: UpgradeFailureReport,
    callbacks: MaybeSuggestCliUpdateCallbacks
  ) {
    const message = `Varro could not update the OpenCode CLI to ${latestCliVersion} automatically. ${failure.guidance}`;
    logger.warn(message);

    const actions: string[] = [];
    if (failure.suggestedCommand) actions.push(OpenCodeProcess.CLI_UPGRADE_IN_TERMINAL_ACTION);
    actions.push(OpenCodeProcess.SHOW_LOGS_ACTION);

    void Promise.resolve(vscode.window.showWarningMessage(message, ...actions))
      .then(async (action) => {
        if (action === OpenCodeProcess.SHOW_LOGS_ACTION) {
          logger.show();
          return;
        }
        if (action === OpenCodeProcess.CLI_UPGRADE_IN_TERMINAL_ACTION && failure.suggestedCommand) {
          // Same prerequisite as the regular terminal upgrade: on Windows the
          // managed server holds opencode.exe open, and the manual retry would
          // hit the very file lock this guidance is about.
          await callbacks.prepareForWindowsCliUpgrade(latestCliVersion);
          await this.runInTerminal(failure.suggestedCommand, 'OpenCode Update', callbacks);
        }
      })
      .catch((err: unknown) => {
        logger.warn(
          `Failed to handle OpenCode CLI update failure notification action: ${err instanceof Error ? err.message : String(err)}`
        );
      });
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
      if (OpenCodeProcess.isMissingCliFailure(message)) {
        return null;
      }
      // The Windows shim reports itself missing through cmd.exe rather than
      // ENOENT, and only counts when the CLI is the command that went missing.
      if (
        !this.resolveCommandInfo().found &&
        OpenCodeProcess.isShellCommandNotFoundFailure(message)
      ) {
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
    // Update failures are platform- and install-specific and hard to reproduce
    // on purpose, so the recovery guidance is exercised by injecting the stderr
    // instead of breaking a real install.
    const simulatedFailure = vscode.workspace
      .getConfiguration('varro')
      .get<string>('debug.simulateUpgradeFailure', '')
      .trim();
    if (simulatedFailure) {
      throw new Error(simulatedFailure);
    }

    const { stdout, stderr } = await this.runCliCommandWithDiagnostics(
      ['upgrade', targetVersion],
      OpenCodeProcess.CLI_BACKGROUND_UPGRADE_TIMEOUT_MS
    );
    // Everything the command printed, so the caller can classify the real cause
    // rather than inventing one after the fact.
    return [stderr, stdout.trim()].filter(Boolean).join('\n');
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
      await this.verifyUpgradedCli(latestCliVersion, '');
      return;
    }
    const diagnostics = await this.upgradeCli(latestCliVersion);
    await this.verifyUpgradedCli(latestCliVersion, diagnostics);
    logger.info(`Updated OpenCode CLI to ${latestCliVersion} in background`);
  }

  /**
   * A zero exit code is not proof the upgrade happened: `opencode upgrade`
   * handles its own errors and can report failure while exiting successfully.
   * Only the version on disk settles it. Whatever the command printed is what
   * gets thrown, because that text is the only thing that can classify the
   * failure into actionable guidance - a message invented here would always
   * classify as `unknown`.
   */
  private async verifyUpgradedCli(targetVersion: string, diagnostics: string) {
    this.clearResolvedCommandCache();
    const installed = await this.readInstalledCliVersion();
    if (installed && compareVersions(installed, targetVersion) >= 0) return;

    const outcome = `the upgrade reported success but the installed CLI is still ${installed || 'unreadable'}`;
    const reason = diagnostics.trim();
    throw new Error(reason ? `${reason} (${outcome})` : outcome);
  }

  private async runTerminalCliUpgrade(
    targetVersion: string,
    callbacks: MaybeSuggestCliUpdateCallbacks
  ) {
    if (process.platform === 'win32') {
      await callbacks.prepareForWindowsCliUpgrade(targetVersion);
    }
    await this.runInTerminal(OpenCodeProcess.CLI_UPGRADE_COMMAND, 'OpenCode Upgrade', callbacks);
  }

  resolveCommand(): string {
    return this.resolveCommandInfo().command;
  }

  /**
   * Drops the memoized lookup so a CLI installed while this window was open is
   * picked up. The cache key only covers the environment, which does not change
   * when the user installs OpenCode from the panel's own terminal button.
   */
  clearResolvedCommandCache() {
    this.resolvedCommandCache = null;
  }

  /**
   * Resolves the CLI path and reports whether it was actually found on disk.
   * `found` is what separates "OpenCode is not installed" from "the path you
   * configured does not exist" and from "it is installed but not where Varro
   * looked" - three failures that need three different instructions.
   */
  resolveCommandInfo(): { command: string; found: boolean } {
    if (this.command) {
      const looksLikePath = /[\\/]/.test(this.command);
      if (looksLikePath) {
        const pathTools =
          process.platform === 'win32' ? win32 : { isAbsolute, resolve: resolvePath };
        const command = pathTools.isAbsolute(this.command)
          ? this.command
          : pathTools.resolve(this.getWorkspaceCwd() || process.cwd(), this.command);
        return { command, found: existsSync(command) };
      }

      const candidates =
        process.platform === 'win32' && !/\.(?:exe|cmd|bat)$/i.test(this.command)
          ? [this.command, `${this.command}.exe`, `${this.command}.cmd`, `${this.command}.bat`]
          : [this.command];
      for (const dir of this.serverPathEntries()) {
        for (const candidate of candidates) {
          const command = join(dir, candidate);
          if (existsSync(command)) return { command, found: true };
        }
      }
      return { command: this.command, found: false };
    }

    const cacheKey = this.getResolvedCommandCacheKey();
    if (this.resolvedCommandCache?.key === cacheKey) {
      return {
        command: this.resolvedCommandCache.value,
        found: this.resolvedCommandCache.found,
      };
    }

    const candidates =
      process.platform === 'win32'
        ? ['opencode.exe', 'opencode.cmd', 'opencode.bat']
        : ['opencode'];

    for (const dir of this.serverPathEntries()) {
      for (const candidate of candidates) {
        const fullPath = join(dir, candidate);
        if (existsSync(fullPath)) {
          this.resolvedCommandCache = { key: cacheKey, value: fullPath, found: true };
          return { command: fullPath, found: true };
        }
      }
    }

    const fallback = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
    this.resolvedCommandCache = { key: cacheKey, value: fallback, found: false };
    return { command: fallback, found: false };
  }

  getInstallInfo(): {
    resolvedCommand: string;
    configuredCommand: string;
    configuredCommandMissing: boolean;
    found: boolean;
    installMethod: OpenCodeInstallMethod;
    searchedPaths: string[];
  } {
    const { command, found } = this.resolveCommandInfo();
    return {
      resolvedCommand: command,
      configuredCommand: this.command,
      configuredCommandMissing: Boolean(this.command) && !found,
      found,
      installMethod: detectInstallMethod({
        // `/opt/homebrew/bin/opencode` is the same path whether Homebrew or an
        // npm global under Homebrew's Node put it there; only the link target
        // (Cellar vs node_modules) tells them apart, and recommending
        // `brew upgrade` for an npm install fails outright.
        resolvedCommand: found ? this.resolveLinkTarget(command) : command,
        configuredCommand: this.command,
      }),
      searchedPaths: this.command && /[\\/]/.test(this.command) ? [] : this.serverPathEntries(),
    };
  }

  private resolveLinkTarget(command: string): string {
    try {
      return realpathSync(command);
    } catch {
      return command;
    }
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
    return (await this.runCliCommandWithDiagnostics(args, timeoutMs)).stdout;
  }

  /**
   * Same spawn, but keeps stderr on success. `opencode upgrade` handles its own
   * errors and exits 0 after printing the reason, so on that command stderr is
   * the only place the actual cause exists.
   */
  private async runCliCommandWithDiagnostics(
    args: string[],
    timeoutMs = OpenCodeProcess.CLI_COMMAND_TIMEOUT_MS
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
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
        resolve({ stdout: result.output || '', stderr: stderr.trim() });
      };

      try {
        const command = this.resolveCommand();
        const spawnOptions: SpawnOptions = {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: this.getWorkspaceCwd(),
          env: this.buildServerEnv(),
          windowsHide: true,
        };
        proc = crossSpawn(command, args, spawnOptions);

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
          if (timedOut) return;
          finish({
            error: err.message.includes('ENOENT')
              ? new Error(OpenCodeProcess.MISSING_CLI_MESSAGE)
              : err,
          });
        });
        proc.once('exit', (code, signal) => {
          if (timedOut) return;
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
          timedOut = true;
          if (!runningProc) {
            finish({ error: new Error('OpenCode CLI command timed out') });
            return;
          }
          void terminateCliProcessTree(runningProc).then(() => {
            finish({ error: new Error('OpenCode CLI command timed out') });
          });
        }, timeoutMs);
      } catch (err) {
        finish({ error: err instanceof Error ? err : new Error(String(err)) });
      }
    });
  }

  private async runInTerminal(
    command: string,
    title: string,
    callbacks: {
      getWorkspaceCwd: () => string | undefined;
      finishWindowsCliUpgrade?: () => void | Promise<void>;
    }
  ) {
    const text = command.trim();
    if (!text) return;

    try {
      const terminal = vscode.window.createTerminal({
        name: title,
        cwd: callbacks.getWorkspaceCwd(),
      });
      if (process.platform === 'win32' && callbacks.finishWindowsCliUpgrade) {
        const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
          if (closedTerminal !== terminal) return;
          disposable.dispose();
          void Promise.resolve(callbacks.finishWindowsCliUpgrade?.()).catch((err: unknown) => {
            logger.warn(
              `Failed to finish Windows OpenCode CLI update: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        });
      }
      terminal.show(false);
      terminal.sendText(text, true);
    } catch (err) {
      await callbacks.finishWindowsCliUpgrade?.();
      throw err;
    }
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
