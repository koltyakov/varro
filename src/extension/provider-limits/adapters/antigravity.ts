/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Antigravity HTTP and process responses are validated before quota extraction. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: API records are asserted only after required-field checks. */
import { execFile } from 'child_process';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import type { IncomingMessage, OutgoingHttpHeaders } from 'http';
import type { RequestOptions } from 'https';
import type { ProviderLimitWindow } from '../../../shared/protocol';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';
import {
  asRecord,
  getString,
  parseFiniteNumber,
  unsupportedProviderStatus,
} from '../adapter-utils';

const ANTIGRAVITY_GET_UNLEASH_DATA_PATH =
  '/exa.language_server_pb.LanguageServerService/GetUnleashData';
const ANTIGRAVITY_GET_USER_STATUS_PATH =
  '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const ANTIGRAVITY_REQUEST_HEADERS = {
  'Content-Type': 'application/json',
  'Connect-Protocol-Version': '1',
} as const;
const ANTIGRAVITY_UNLEASH_DATA_BODY = JSON.stringify({ wrapper_data: {} });
const ANTIGRAVITY_USER_STATUS_BODY = JSON.stringify({
  metadata: {
    ideName: 'antigravity',
    extensionName: 'antigravity',
    locale: 'en',
  },
});
const ANTIGRAVITY_BASE_URL_ENV = 'ANTIGRAVITY_BASE_URL';
const ANTIGRAVITY_CSRF_TOKEN_ENV = 'ANTIGRAVITY_CSRF_TOKEN';
const ANTIGRAVITY_PROCESS_TIMEOUT_MS = 10_000;
const ANTIGRAVITY_PROCESS_MAX_BUFFER_BYTES = 4 * 1_024 * 1_024;
const WINDOWS_PROCESS_DISCOVERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'antigravity' } | Select-Object ProcessId, CommandLine)",
  'ConvertTo-Json -InputObject $processes -Compress',
].join('; ');

type AntigravityConnection = {
  baseURL: string;
  csrfToken: string;
  port: number;
  protocol: 'http' | 'https';
};

interface AntigravityRequestHeaders extends OutgoingHttpHeaders {
  'Content-Type': string;
  'Connect-Protocol-Version': string;
  'Content-Length': string;
  'X-Codeium-Csrf-Token'?: string;
}

type AntigravityProcessInfo = {
  pid: number;
  commandLine: string;
  csrfToken: string;
  extensionServerPort: number | null;
};

type AntigravityCommandRunner = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

type AntigravityAdapterOptions = {
  platform?: NodeJS.Platform;
  runCommand?: AntigravityCommandRunner;
};

type AntigravityFetchResult =
  | { kind: 'available'; windows: ProviderLimitWindow[] }
  | { kind: 'unsupported'; note: string }
  | { kind: 'error'; note: string };

export function createAntigravityAdapter(
  options: AntigravityAdapterOptions = {}
): ProviderLimitAdapter {
  return {
    id: 'antigravity',
    capabilities: { localIpc: true },
    matches(provider) {
      return provider.id === 'antigravity';
    },
    async fetch({ provider, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const connection = await resolveAntigravityConnection(
        options.platform ?? process.platform,
        options.runCommand ?? execFileAsync
      );
      if (!connection) {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'Antigravity language server is not running or could not be detected'
        );
      }

      try {
        const response = await postAntigravityRequest(
          connection,
          ANTIGRAVITY_GET_USER_STATUS_PATH,
          ANTIGRAVITY_USER_STATUS_BODY,
          10_000
        );

        if (response.status === 401 || response.status === 403) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            `Antigravity language server rejected the local session (${response.status})`
          );
        }

        if (response.status !== 200) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: `Antigravity language server returned ${response.status}`,
          };
        }

        const result = extractAntigravityWindows(
          parseJsonBody(response.bodyText),
          modelID,
          checkedAt
        );
        if (result.kind === 'unsupported') {
          return unsupportedProviderStatus(provider.id, modelID, checkedAt, result.note);
        }
        if (result.kind === 'error') {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: result.note,
          };
        }

        return {
          providerID: provider.id,
          modelID,
          status: 'available',
          source: 'provider',
          checkedAt,
          windows: result.windows,
          note: 'Polled local Antigravity language server',
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the local Antigravity language server',
        };
      }
    },
  };
}

async function resolveAntigravityConnection(
  platform: NodeJS.Platform,
  runCommand: AntigravityCommandRunner
): Promise<AntigravityConnection | null> {
  const envConnection = readAntigravityConnectionFromEnv();
  if (envConnection) return envConnection;

  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return null;
  }

  const processInfo = await detectAntigravityProcess(platform, runCommand);
  if (!processInfo) return null;

  const ports = processInfo.extensionServerPort
    ? [
        processInfo.extensionServerPort,
        ...(await discoverListeningPorts(processInfo.pid, platform, runCommand)),
      ]
    : await discoverListeningPorts(processInfo.pid, platform, runCommand);

  for (const port of dedupeFiniteNumbers(ports)) {
    const connection = await probeAntigravityPort(port, processInfo.csrfToken);
    if (connection) return connection;
  }

  return null;
}

function readAntigravityConnectionFromEnv(): AntigravityConnection | null {
  const baseURL = process.env[ANTIGRAVITY_BASE_URL_ENV]?.trim();
  if (!baseURL) return null;

  try {
    const url = new URL(baseURL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    return {
      baseURL: url.origin,
      csrfToken: process.env[ANTIGRAVITY_CSRF_TOKEN_ENV]?.trim() ?? '',
      port: parsePortNumber(url.port),
      protocol: url.protocol === 'https:' ? 'https' : 'http',
    };
  } catch {
    return null;
  }
}

async function detectAntigravityProcess(
  platform: NodeJS.Platform,
  runCommand: AntigravityCommandRunner
) {
  try {
    if (platform === 'win32') {
      const { stdout } = await runCommand('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        WINDOWS_PROCESS_DISCOVERY_SCRIPT,
      ]);
      return selectBestAntigravityProcess(parseWindowsAntigravityProcesses(stdout));
    }

    const { stdout } = await runCommand('ps', ['ax', '-o', 'pid=,command=']);
    return selectBestAntigravityProcess(
      stdout
        .split(/\r?\n/g)
        .map(parseAntigravityProcessLine)
        .filter((candidate): candidate is AntigravityProcessInfo => candidate != null)
    );
  } catch {
    return null;
  }
}

function selectBestAntigravityProcess(candidates: AntigravityProcessInfo[]) {
  const sorted = candidates.toSorted(
    (left, right) => scoreAntigravityProcess(right) - scoreAntigravityProcess(left)
  );

  return sorted[0] ?? null;
}

function parseAntigravityProcessLine(line: string): AntigravityProcessInfo | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d+)\s+(.*)$/);
  if (!match) return null;

  return parseAntigravityProcess(Number(match[1]), match[2]!.trim());
}

function parseWindowsAntigravityProcesses(output: string) {
  const payload = parseJsonBody(output);
  const entries = Array.isArray(payload) ? payload : payload == null ? [] : [payload];
  return entries
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return null;
      return parseAntigravityProcess(
        parseFiniteNumber(record.ProcessId) ?? NaN,
        getString(record.CommandLine)
      );
    })
    .filter((candidate): candidate is AntigravityProcessInfo => candidate != null);
}

function parseAntigravityProcess(pid: number, commandLine: string): AntigravityProcessInfo | null {
  if (!Number.isInteger(pid) || !commandLine) return null;

  const normalized = commandLine.toLowerCase();
  if (!normalized.includes('antigravity')) return null;
  if (normalized.includes('server installation script')) return null;

  const hasServerSignal =
    normalized.includes('language-server') ||
    normalized.includes('language_server') ||
    normalized.includes('lsp') ||
    normalized.includes('--csrf_token') ||
    normalized.includes('--extension_server_port') ||
    normalized.includes('exa.language_server_pb');
  if (!hasServerSignal) return null;

  const extensionServerPort = parsePortNumber(
    extractCommandArgument(commandLine, '--extension_server_port')
  );

  return {
    pid,
    commandLine,
    csrfToken: extractCommandArgument(commandLine, '--csrf_token'),
    extensionServerPort: extensionServerPort || null,
  } satisfies AntigravityProcessInfo;
}

function scoreAntigravityProcess(processInfo: AntigravityProcessInfo) {
  const normalized = processInfo.commandLine.toLowerCase();
  let score = 0;
  if (normalized.includes('antigravity')) score += 1;
  if (normalized.includes('lsp')) score += 5;
  if (processInfo.extensionServerPort) score += 10;
  if (processInfo.csrfToken) score += 20;
  if (
    normalized.includes('language-server') ||
    normalized.includes('language_server') ||
    normalized.includes('exa.language_server_pb')
  ) {
    score += 50;
  }
  return score;
}

async function discoverListeningPorts(
  pid: number,
  platform: NodeJS.Platform,
  runCommand: AntigravityCommandRunner
) {
  if (platform === 'win32') {
    try {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `Get-NetTCPConnection -OwningProcess ${String(pid)} -State Listen | Select-Object -ExpandProperty LocalPort -Unique`,
      ].join('; ');
      const { stdout } = await runCommand('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]);
      const ports = parseWindowsAntigravityPorts(stdout);
      if (ports.length > 0) return ports;
    } catch {}

    try {
      const { stdout } = await runCommand('netstat.exe', ['-ano']);
      return parseWindowsNetstatPorts(stdout, pid);
    } catch {
      return [];
    }
  }

  try {
    const { stdout } = await runCommand('lsof', [
      '-nP',
      '-iTCP',
      '-sTCP:LISTEN',
      '-a',
      '-p',
      String(pid),
    ]);
    return parseAntigravityPorts(stdout);
  } catch {
    return [];
  }
}

function parseWindowsAntigravityPorts(output: string) {
  return output
    .split(/\r?\n/g)
    .map((line) => parsePortNumber(line.trim()))
    .filter((port) => port > 0);
}

function parseWindowsNetstatPorts(output: string, pid: number) {
  const ports: number[] = [];
  for (const line of output.split(/\r?\n/g)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0]?.toUpperCase() !== 'TCP') continue;
    const remoteAddress = fields[2];
    if (remoteAddress?.slice(remoteAddress.lastIndexOf(':') + 1) !== '0') continue;
    if (Number(fields[4]) !== pid) continue;
    const localAddress = fields[1]!;
    const port = Number(localAddress.slice(localAddress.lastIndexOf(':') + 1));
    if (Number.isInteger(port) && port > 0) ports.push(port);
  }
  return ports;
}

function parseAntigravityPorts(output: string) {
  const ports: number[] = [];
  for (const line of output.split(/\r?\n/g)) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)/);
    const port = match ? Number(match[1]) : NaN;
    if (Number.isInteger(port) && port > 0) ports.push(port);
  }
  return ports;
}

async function probeAntigravityPort(port: number, csrfToken: string) {
  for (const protocol of ['https', 'http'] as const) {
    try {
      const response = await postAntigravityRequest(
        {
          baseURL: `${protocol}://127.0.0.1:${port}`,
          csrfToken,
          port,
          protocol,
        },
        ANTIGRAVITY_GET_UNLEASH_DATA_PATH,
        ANTIGRAVITY_UNLEASH_DATA_BODY,
        750
      );
      if (response.status === 200 || response.status === 401) {
        return {
          baseURL: `${protocol}://127.0.0.1:${port}`,
          csrfToken,
          port,
          protocol,
        } satisfies AntigravityConnection;
      }
    } catch {}
  }

  return null;
}

async function postAntigravityRequest(
  connection: AntigravityConnection,
  path: string,
  body: string,
  timeoutMs: number
) {
  const url = new URL(path, connection.baseURL);
  const headers: AntigravityRequestHeaders = {
    ...ANTIGRAVITY_REQUEST_HEADERS,
    'Content-Length': String(Buffer.byteLength(body)),
  };
  if (connection.csrfToken) headers['X-Codeium-Csrf-Token'] = connection.csrfToken;

  const options: RequestOptions = {
    method: 'POST',
    headers,
  };
  if (url.protocol === 'https:') options.rejectUnauthorized = false;

  return new Promise<{ status: number; bodyText: string }>((resolve, reject) => {
    let activeResponse: IncomingMessage | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      activeResponse?.destroy(error);
      request.destroy(error);
      reject(error);
    };

    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      options,
      (response) => {
        activeResponse = response;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          chunks.push(buffer);
        });
        response.once('error', fail);
        response.once('aborted', () => fail(new Error('response aborted')));
        response.once('close', () => {
          if (!response.complete) fail(new Error('response closed before completion'));
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({
            status: response.statusCode ?? 0,
            bodyText: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );

    timer = setTimeout(() => fail(new Error('request timed out')), timeoutMs);
    request.once('error', fail);
    request.write(body);
    request.end();
  });
}

function extractAntigravityWindows(
  payload: unknown,
  modelID: string | null,
  checkedAt: number
): AntigravityFetchResult {
  const record = asRecord(payload);
  if (!record) {
    return { kind: 'error', note: 'Antigravity language server returned an invalid response' };
  }

  const userStatus = asRecord(record.userStatus);
  if (!userStatus) {
    return {
      kind: 'unsupported',
      note: 'Antigravity language server is not authenticated',
    };
  }

  const clientModelConfigs = Array.isArray(
    asRecord(userStatus.cascadeModelConfigData)?.clientModelConfigs
  )
    ? (asRecord(userStatus.cascadeModelConfigData)?.clientModelConfigs as unknown[])
    : [];

  const targetModelID = normalizeModelIdentifier(modelID);
  const windows = clientModelConfigs
    .map((entry) => buildAntigravityWindow(entry, checkedAt))
    .filter((window): window is ProviderLimitWindow => window != null)
    .filter((window) => !targetModelID || normalizeModelIdentifier(window.id) === targetModelID);

  if (windows.length > 0) {
    return { kind: 'available', windows };
  }

  if (modelID) {
    return {
      kind: 'unsupported',
      note: `Antigravity language server did not report quota for ${modelID}`,
    };
  }

  return {
    kind: 'unsupported',
    note: 'Antigravity language server did not expose any bounded quotas',
  };
}

function buildAntigravityWindow(entry: unknown, checkedAt: number): ProviderLimitWindow | null {
  const record = asRecord(entry);
  const quotaInfo = asRecord(record?.quotaInfo);
  const modelID = getString(asRecord(record?.modelOrAlias)?.model);
  if (!record || !quotaInfo || !modelID) return null;

  const remainingFraction = parseFiniteNumber(quotaInfo.remainingFraction);
  if (remainingFraction == null) return null;

  const clampedRemainingFraction = Math.max(0, Math.min(1, remainingFraction));
  const remaining = Math.round(clampedRemainingFraction * 1000) / 10;
  const percent = Math.round((1 - clampedRemainingFraction) * 100_000) / 1000;
  const label = cleanAntigravityLabel(getString(record.label)) || modelID;

  return {
    id: modelID,
    label,
    unit: 'credits',
    remaining,
    limit: 100,
    resetAt: parseResetAt(quotaInfo.resetTime, checkedAt),
    percent,
  } satisfies ProviderLimitWindow;
}

function cleanAntigravityLabel(label: string) {
  return label.replace(/\s*\(thinking\)\s*$/i, '').trim();
}

function execFileAsync(command: string, args: string[]) {
  if (typeof execFile !== 'function') {
    return Promise.reject(new Error('execFile is unavailable'));
  }

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('LSOF'))
  );
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        env,
        maxBuffer: ANTIGRAVITY_PROCESS_MAX_BUFFER_BYTES,
        timeout: ANTIGRAVITY_PROCESS_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function extractCommandArgument(commandLine: string, argumentName: string) {
  const escapedArgument = escapeRegExp(argumentName);
  const equalsMatch = commandLine.match(
    new RegExp(`${escapedArgument}=([^\\s"']+|"[^"]*"|'[^']*')`)
  );
  if (equalsMatch?.[1]) return equalsMatch[1].replace(/^['"]|['"]$/g, '');

  const spaceMatch = commandLine.match(
    new RegExp(`${escapedArgument}\\s+([^\\s"']+|"[^"]*"|'[^']*')`)
  );
  if (spaceMatch?.[1]) return spaceMatch[1].replace(/^['"]|['"]$/g, '');

  return '';
}

function dedupeFiniteNumbers(values: readonly number[]) {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeModelIdentifier(value: string | null | undefined) {
  return value ? value.toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
}

function parseResetAt(value: unknown, checkedAt: number) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? checkedAt : parsed;
}

function parsePortNumber(value: string) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parseJsonBody(bodyText: string): unknown | null {
  const trimmed = bodyText.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
