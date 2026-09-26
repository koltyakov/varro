import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import type { Dirent } from 'fs';
import { existsSync } from 'fs';
import { readFile, readdir, readlink, realpath } from 'fs/promises';
import { uptime } from 'os';
import { join } from 'path';
import { logger } from './logger';

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};
interface WindowsManagedListenerInspection {
  pid: number;
  executable: string;
  birthIdentity: string;
  hostBirthIdentity: string;
}

const PROCESS_COMMAND_TIMEOUT_MS = 2000;
const PROCESS_COMMAND_KILL_GRACE_MS = 1000;
const WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS = 10_000;
export const PROCESS_STOP_TIMEOUT_MS = 5000;
const PROCESS_COMMAND_MAX_OUTPUT_CHARS = 1_000_000;

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

export async function inspectWindowsManagedListener(
  port: number,
  ancestorPid: number
): Promise<WindowsManagedListenerInspection | null> {
  const netstat = await runProcess('netstat.exe', ['-ano'], WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS);
  let listenerExpression: string;
  if (netstat.code === 0) {
    const listenerPids = parseWindowsNetstatListeningPids(netstat.stdout, port);
    if (listenerPids.length === 0) return null;
    listenerExpression = `@(${listenerPids.join(',')})`;
  } else {
    logger.warn(
      `Windows listener inspection with netstat failed: ${netstat.stderr.trim() || `exit code ${String(netstat.code)}`}`
    );
    listenerExpression = `@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)`;
  }

  const script = [
    `$listenerIds = ${listenerExpression}`,
    '$processes = @(Get-CimInstance Win32_Process)',
    '$byId = @{}',
    'foreach ($process in $processes) { $byId[[int]$process.ProcessId] = $process }',
    `$ancestorPid = ${ancestorPid}`,
    `$hostPid = ${process.pid}`,
    'foreach ($listenerId in $listenerIds) {',
    '  $listener = $byId[[int]$listenerId]',
    '  $currentPid = [int]$listenerId',
    '  $owned = $false',
    '  for ($depth = 0; $currentPid -gt 0 -and $depth -lt 32; $depth++) {',
    '    if ($currentPid -eq $ancestorPid) { $owned = $true; break }',
    '    $current = $byId[$currentPid]',
    '    if (-not $current) { break }',
    '    $currentPid = [int]$current.ParentProcessId',
    '  }',
    '  if ($owned -and $listener -and $listener.ExecutablePath -and $listener.CreationDate) {',
    '    $hostProcess = $byId[$hostPid]',
    '    [Console]::Out.WriteLine("VARRO_PID=" + $listener.ProcessId)',
    '    [Console]::Out.WriteLine("VARRO_EXECUTABLE=" + $listener.ExecutablePath)',
    '    [Console]::Out.WriteLine("VARRO_BIRTH=" + $listener.CreationDate.ToUniversalTime().Ticks)',
    '    if ($hostProcess -and $hostProcess.CreationDate) { [Console]::Out.WriteLine("VARRO_HOST_BIRTH=" + $hostProcess.CreationDate.ToUniversalTime().Ticks) }',
    '    break',
    '  }',
    '}',
  ].join('; ');
  const result = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS
  );
  if (result.code !== 0) {
    logger.warn(
      `Windows managed process inspection failed: ${result.stderr.trim() || `exit code ${String(result.code)}`}`
    );
    return null;
  }

  const values = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const pid = Number.parseInt(values.get('VARRO_PID') ?? '', 10);
  const executable = values.get('VARRO_EXECUTABLE') ?? '';
  const birth = values.get('VARRO_BIRTH') ?? '';
  if (!Number.isSafeInteger(pid) || pid <= 0 || !executable || !birth) return null;
  const hostBirth = values.get('VARRO_HOST_BIRTH') ?? '';
  return {
    pid,
    executable,
    birthIdentity: `win32:${birth}`,
    hostBirthIdentity: hostBirth ? `win32:${hostBirth}` : '',
  };
}

export function runProcess(
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

export async function terminateCliProcessTree(proc: ChildProcess): Promise<void> {
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
  let readableTables = 0;
  await Promise.all(
    [join(procRoot, 'net/tcp'), join(procRoot, 'net/tcp6')].map(async (path) => {
      let table: string;
      try {
        table = await readFile(path, 'utf-8');
        readableTables += 1;
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
  if (readableTables === 0)
    throw new Error(
      `Cannot inspect the listener on port ${port}: Linux socket tables are unavailable`
    );
  if (socketInodes.size === 0) return [];

  let processes: Dirent[];
  try {
    processes = await readdir(procRoot, { withFileTypes: true });
  } catch (cause) {
    throw new Error(`Cannot inspect processes for the listener on port ${port}`, { cause });
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
  if (pids.size === 0) throw new Error(`Cannot identify the process listening on port ${port}`);
  return [...pids];
}

export async function findListeningPids(port: number, procRoot = '/proc') {
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
      throw new Error(
        `Cannot inspect the listener on port ${port}: Windows netstat failed (${fallback.stderr.trim() || `exit code ${String(fallback.code)}`})`
      );
    }
    return parseWindowsNetstatListeningPids(fallback.stdout, port);
  }

  const result = await runProcess('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN']);
  const pids = parsePids(result.stdout);
  if (
    process.platform !== 'linux' &&
    pids.length === 0 &&
    result.code !== 0 &&
    (result.code !== 1 || result.stderr.trim())
  ) {
    throw new Error(
      `Cannot inspect the listener on port ${port}: ${result.stderr.trim() || 'lsof failed'}`
    );
  }
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

export async function readProcessExecutable(pid: number, procRoot = '/proc') {
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
  if (executable && (process.platform !== 'darwin' || existsSync(executable))) return executable;

  // After a macOS binary replacement, lsof can report a synthetic path such as
  // /opencode for the unlinked executable. ps retains the launch path; resolve
  // its symlink to compare it with the executable recorded before the update.
  const command = (await runProcess('ps', ['-p', String(pid), '-o', 'comm='])).stdout.trim();
  if (process.platform !== 'darwin' || !command) return command;
  return realpath(command).catch(() => command);
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

export async function readProcessBirthIdentity(pid: number, procRoot = '/proc') {
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
    if (startTime && /^\d+$/.test(startTime)) {
      try {
        const bootId = (
          await readFile(join(procRoot, 'sys/kernel/random/boot_id'), 'utf-8')
        ).trim();
        if (/^[a-f0-9-]{36}$/i.test(bootId)) return `linux:${bootId}:${startTime}`;
      } catch {
        // Restricted proc mounts may expose process start ticks without the boot ID.
      }
      return `linux:${startTime}`;
    }
  }

  const value = (await runProcess('ps', ['-p', String(pid), '-o', 'lstart='])).stdout
    .trim()
    .replace(/\s+/g, ' ');
  return value ? `${process.platform}:${value}` : '';
}

export function matchesBirthIdentity(expected: string, actual: string, createdAt: number): boolean {
  if (expected === actual) return true;
  // Older Linux leases only stored boot-relative ticks. Accept them within the
  // current boot while new records also distinguish machine reboots.
  return (
    process.platform === 'linux' &&
    /^linux:\d+$/.test(expected) &&
    /^linux:[a-f0-9-]{36}:\d+$/i.test(actual) &&
    expected === `linux:${actual.split(':').at(-1)}` &&
    createdAt >= Date.now() - uptime() * 1000
  );
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

export async function readProcessEnvironmentValue(pid: number, name: string, procRoot = '/proc') {
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

export async function isProcessOrDescendant(pid: number, ancestorPid: number, procRoot = '/proc') {
  let currentPid: number | null = pid;
  for (let depth = 0; currentPid && depth < 32; depth += 1) {
    if (currentPid === ancestorPid) return true;
    currentPid = await readParentPid(currentPid, procRoot);
  }
  return false;
}

export async function readProcessGroupId(pid: number) {
  if (process.platform === 'win32') return null;
  const value = (await runProcess('ps', ['-p', String(pid), '-o', 'pgid='])).stdout.trim();
  const processGroupId = Number.parseInt(value, 10);
  return Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : null;
}

export function isProcessGroupAlive(processGroupId: number) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (err) {
    // SAFETY: Node.js process errors expose their errno name as an optional code field.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals) {
  try {
    process.kill(-processGroupId, signal);
  } catch (err) {
    // SAFETY: Node.js process errors expose their errno name as an optional code field.
    if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') throw err;
  }
}

export function normalizeExecutableIdentity(value: string) {
  const normalized = value.trim();
  // Linux retains the running inode after an installer replaces the executable.
  if (process.platform === 'linux') return normalized.replace(/ \(deleted\)$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // SAFETY: Node.js process errors expose their errno name as an optional code field.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
