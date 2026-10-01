import { asRecord, isNumber, isString } from '../shared/type-utils';
import { readProcessBirthIdentity, runProcess } from './process-inspection';

export type ServerConnectionInfo = {
  startedAt: number | null;
  vscodeClients: number | null;
  otherClients: number | null;
};

type Connection = { pid: number; from: string; to: string };
type ConnectionSnapshot = {
  listeners: Set<number>;
  connections: Connection[];
  commands: Map<number, string>;
  startedAt: number | null;
};

export async function readLocalServerConnectionInfo(
  port: number,
  pid: number | null
): Promise<ServerConnectionInfo> {
  const unknown: ServerConnectionInfo = {
    startedAt: null,
    vscodeClients: null,
    otherClients: null,
  };
  if (
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    port > 65535 ||
    pid === null ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  )
    return unknown;
  try {
    const birth = await readProcessBirthIdentity(pid);
    if (!birth) return unknown;
    const snapshot =
      process.platform === 'win32'
        ? await readWindowsSnapshot(port, pid)
        : await readPosixSnapshot(port, pid);
    if (
      !snapshot ||
      snapshot.listeners.size !== 1 ||
      !snapshot.listeners.has(pid) ||
      (await readProcessBirthIdentity(pid)) !== birth
    )
      return unknown;

    const clients = new Set<number>();
    const accepted = snapshot.connections.filter((connection) => connection.pid === pid);
    for (const connection of accepted) {
      const peers = snapshot.connections.filter(
        (peer) => peer.pid !== pid && peer.from === connection.to && peer.to === connection.from
      );
      // Missing peers include remote clients and processes hidden by OS permissions.
      // Do not turn incomplete inspection into a misleading zero or partial total.
      if (new Set(peers.map((peer) => peer.pid)).size !== 1)
        return { ...unknown, startedAt: snapshot.startedAt };
      for (const peer of peers) clients.add(peer.pid);
    }
    let vscodeClients = 0;
    let otherClients = 0;
    for (const client of clients) {
      const command = snapshot.commands.get(client);
      if (!command) return { ...unknown, startedAt: snapshot.startedAt };
      if (
        /--type[= ]extensionHost\b|\b(?:Code|VSCodium|Cursor|OpenJet|Windsurf)(?: - (?:Insiders|Nightly))? Helper \(Plugin\)/i.test(
          command
        )
      ) {
        vscodeClients += 1;
      } else otherClients += 1;
    }
    return { startedAt: snapshot.startedAt, vscodeClients, otherClients };
  } catch {
    // Diagnostics are best-effort and never grant process lifecycle rights.
    return unknown;
  }
}

async function readPosixSnapshot(port: number, pid: number): Promise<ConnectionSnapshot | null> {
  const sockets = await runProcess('lsof', [
    '-nP',
    '+c',
    '0',
    '-a',
    `-iTCP:${port}`,
    '-sTCP:LISTEN,ESTABLISHED',
    '-FpfcnT',
  ]);
  if (sockets.code !== 0) return null;
  const listeners = new Set<number>();
  const connections: Connection[] = [];
  let currentPid = 0;
  let address = '';
  for (const line of sockets.stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      currentPid = Number(line.slice(1));
      address = '';
    } else if (line.startsWith('f')) address = '';
    else if (line.startsWith('n')) address = line.slice(1);
    else if (line === 'TST=LISTEN') listeners.add(currentPid);
    else if (line === 'TST=ESTABLISHED') {
      const [from, to] = address.split('->');
      if (!from || !to || !Number.isSafeInteger(currentPid) || currentPid <= 0) return null;
      connections.push({ pid: currentPid, from, to });
    }
  }
  const pids = [...new Set([pid, ...connections.map((connection) => connection.pid)])];
  const processes = await runProcess('ps', [
    '-ww',
    '-p',
    pids.join(','),
    '-o',
    'pid=,lstart=,args=',
  ]);
  if (processes.code !== 0) return null;
  const commands = new Map<number, string>();
  let startedAt: number | null = null;
  for (const line of processes.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
      line
    );
    if (!match) continue;
    const processPid = Number(match[1]);
    commands.set(processPid, match[3]!);
    if (processPid === pid) {
      const date = Date.parse(match[2]!);
      if (Number.isFinite(date) && date > 0) startedAt = date;
    }
  }
  return { listeners, connections, commands, startedAt };
}

async function readWindowsSnapshot(port: number, pid: number): Promise<ConnectionSnapshot | null> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$sockets = @(Get-NetTCPConnection -State Listen,Established | Where-Object { $_.LocalPort -eq ${port} -or $_.RemotePort -eq ${port} })`,
    `$listeners = @($sockets | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -eq ${port} } | Select-Object -ExpandProperty OwningProcess -Unique)`,
    "$connections = @($sockets | Where-Object { $_.State -eq 'Established' } | ForEach-Object { @{ pid = $_.OwningProcess; from = ($_.LocalAddress + ':' + $_.LocalPort); to = ($_.RemoteAddress + ':' + $_.RemotePort) } })",
    '$ids = @($connections | ForEach-Object { $_.pid } | Select-Object -Unique)',
    '$commands = @(foreach ($id in $ids) { $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id"; @{ pid = $id; command = $p.CommandLine } })',
    `$started = ([DateTimeOffset](Get-Process -Id ${pid}).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`,
    '@{ listeners = $listeners; connections = $connections; commands = $commands; startedAt = $started } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ');
  const result = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    10_000
  );
  if (result.code !== 0) return null;
  const data = asRecord(JSON.parse(result.stdout));
  if (
    !data ||
    !Array.isArray(data.listeners) ||
    !Array.isArray(data.connections) ||
    !Array.isArray(data.commands)
  )
    return null;
  const listeners = new Set<number>();
  for (const listener of data.listeners) {
    if (!isNumber(listener) || !Number.isSafeInteger(listener) || listener <= 0) return null;
    listeners.add(listener);
  }
  const connections: Connection[] = [];
  for (const value of data.connections) {
    const connection = asRecord(value);
    if (
      !connection ||
      !isNumber(connection.pid) ||
      !Number.isSafeInteger(connection.pid) ||
      connection.pid <= 0 ||
      !isString(connection.from) ||
      !isString(connection.to)
    )
      return null;
    connections.push({ pid: connection.pid, from: connection.from, to: connection.to });
  }
  const commands = new Map<number, string>();
  for (const value of data.commands) {
    const command = asRecord(value);
    if (command && isNumber(command.pid) && isString(command.command))
      commands.set(command.pid, command.command);
  }
  const startedAt =
    isNumber(data.startedAt) && Number.isFinite(data.startedAt) && data.startedAt > 0
      ? data.startedAt
      : null;
  return { listeners, connections, commands, startedAt };
}
