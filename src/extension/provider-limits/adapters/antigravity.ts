import { execFile } from 'child_process';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import type { ProviderLimitStatus, ProviderLimitWindow } from '../../../shared/protocol';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';

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

type AntigravityConnection = {
  baseURL: string;
  csrfToken: string;
  port: number;
  protocol: 'http' | 'https';
};

type AntigravityProcessInfo = {
  pid: number;
  commandLine: string;
  csrfToken: string;
  extensionServerPort: number | null;
};

type AntigravityFetchResult =
  | { kind: 'available'; windows: ProviderLimitWindow[] }
  | { kind: 'unsupported'; note: string }
  | { kind: 'error'; note: string };

export function createAntigravityAdapter(): ProviderLimitAdapter {
  return {
    id: 'antigravity',
    capabilities: { localIpc: true },
    matches(provider) {
      return provider.id === 'antigravity';
    },
    async fetch({ provider, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const connection = await resolveAntigravityConnection();
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

async function resolveAntigravityConnection(): Promise<AntigravityConnection | null> {
  const envConnection = readAntigravityConnectionFromEnv();
  if (envConnection) return envConnection;

  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return null;
  }

  const processInfo = await detectAntigravityProcess();
  if (!processInfo) return null;

  const ports = processInfo.extensionServerPort
    ? [processInfo.extensionServerPort, ...(await discoverListeningPorts(processInfo.pid))]
    : await discoverListeningPorts(processInfo.pid);

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

async function detectAntigravityProcess() {
  try {
    const { stdout } = await execFileAsync('ps', ['ax', '-o', 'pid=,command=']);
    return selectBestAntigravityProcess(stdout);
  } catch {
    return null;
  }
}

function selectBestAntigravityProcess(output: string) {
  const candidates = output
    .split(/\r?\n/g)
    .map(parseAntigravityProcessLine)
    .filter((candidate): candidate is AntigravityProcessInfo => candidate != null)
    .toSorted((left, right) => scoreAntigravityProcess(right) - scoreAntigravityProcess(left));

  return candidates[0] ?? null;
}

function parseAntigravityProcessLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d+)\s+(.*)$/);
  if (!match) return null;

  const pid = Number(match[1]);
  const commandLine = match[2].trim();
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

  return {
    pid,
    commandLine,
    csrfToken: extractCommandArgument(commandLine, '--csrf_token'),
    extensionServerPort: parsePortNumber(
      extractCommandArgument(commandLine, '--extension_server_port')
    ),
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

async function discoverListeningPorts(pid: number) {
  try {
    const { stdout } = await execFileAsync('lsof', [
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
  const headers = {
    ...ANTIGRAVITY_REQUEST_HEADERS,
    'Content-Length': String(Buffer.byteLength(body)),
    ...(connection.csrfToken ? { 'X-Codeium-Csrf-Token': connection.csrfToken } : {}),
  };

  return new Promise<{ status: number; bodyText: string }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'POST',
        headers,
        ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          chunks.push(buffer);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            bodyText: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('timeout'));
    });
    request.once('error', reject);
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

function buildAntigravityWindow(entry: unknown, checkedAt: number) {
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

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
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

function unsupportedProviderStatus(
  providerID: string,
  modelID: string | null,
  checkedAt: number,
  note: string
): ProviderLimitStatus {
  return {
    providerID,
    modelID,
    status: 'unsupported',
    source: 'provider',
    checkedAt,
    note,
  };
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

function parseFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
