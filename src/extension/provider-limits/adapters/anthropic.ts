import { randomUUID } from 'crypto';
import { readFile, rename, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type {
  ProviderLimitStatus,
  ProviderLimitUnit,
  ProviderLimitWindow,
} from '../../../shared/protocol';
import {
  parseRateLimitResetAt,
  type ProviderAuthRecord,
  type ProviderMetadata,
} from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';

const ANTHROPIC_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_OAUTH_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';
const ANTHROPIC_USER_AGENT = 'claude-code/2.1.69';
const ANTHROPIC_STATUSLINE_STALENESS_MS = 5 * 60_000;
const MERIDIAN_QUOTA_ENDPOINT_PATH = '/v1/usage/quota';
const HIDDEN_MERIDIAN_WINDOW_IDS = new Set(['seven_day_omelette']);

const ANTHROPIC_QUOTA_DEFS = [
  { id: 'five_hour', label: '5-Hour Limit' },
  { id: 'seven_day', label: 'Weekly All-Model' },
  { id: 'seven_day_sonnet', label: 'Weekly Sonnet' },
  { id: 'monthly_limit', label: 'Monthly Limit' },
  { id: 'extra_usage', label: 'Extra Usage' },
] as const;

const MERIDIAN_WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-Hour Limit',
  seven_day: 'Weekly All-Model',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  seven_day_oauth_apps: 'Weekly Apps',
  seven_day_cowork: 'Weekly Cowork',
  seven_day_omelette: 'Weekly Omelette',
};

type AnthropicCredentials = {
  accessToken: string;
  refreshToken: string | null;
  credentialsFilePath: string | null;
};

export function createAnthropicAdapter(): ProviderLimitAdapter {
  return {
    id: 'anthropic',
    capabilities: {
      localFile: true,
      oauthRefresh: true,
    },
    matches(provider) {
      return provider.id === 'anthropic';
    },
    async fetch({ provider, authStore, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const statuslineStatus = await readAnthropicStatuslineStatus(provider.id, modelID, checkedAt);
      if (statuslineStatus) return statuslineStatus;

      const localProxyBaseUrl = getAnthropicLocalProxyBaseUrl(provider);
      const localProxyStatus = localProxyBaseUrl
        ? await readAnthropicLocalProxyStatus(provider.id, modelID, checkedAt, localProxyBaseUrl)
        : null;
      if (localProxyStatus?.status) return localProxyStatus.status;

      const credentials = await resolveAnthropicCredentials(authStore);
      if (!credentials?.accessToken) {
        if (localProxyBaseUrl) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note:
              localProxyStatus?.fallbackNote ||
              'Failed to poll the local Claude proxy quota endpoint',
          };
        }

        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No Anthropic OAuth credentials available'
        );
      }

      try {
        let response = await fetchAnthropicUsage(credentials.accessToken);
        let note = 'Polled Anthropic OAuth usage endpoint';

        if (shouldRefreshAnthropicCredentials(response.status, credentials)) {
          const refreshed = await refreshAnthropicAccessToken(credentials.refreshToken);
          if (refreshed.status === 'unsupported') {
            return unsupportedProviderStatus(provider.id, modelID, checkedAt, refreshed.note);
          }
          if (refreshed.status === 'error') {
            return {
              providerID: provider.id,
              modelID,
              status: 'error',
              source: 'provider',
              checkedAt,
              note: `${refreshed.note} after Anthropic usage endpoint returned ${response.status}`,
            };
          }

          try {
            await writeAnthropicCredentials(
              credentials.credentialsFilePath,
              refreshed.accessToken,
              refreshed.refreshToken,
              refreshed.expiresInSeconds
            );
          } catch {
            return {
              providerID: provider.id,
              modelID,
              status: 'error',
              source: 'provider',
              checkedAt,
              note: `Anthropic usage endpoint returned ${response.status} and refreshed credentials could not be saved`,
            };
          }

          response = await fetchAnthropicUsage(refreshed.accessToken);
          note = 'Polled Anthropic OAuth usage endpoint after refreshing OAuth token';
        }

        if (response.status === 401 || response.status === 403) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            `Anthropic usage endpoint rejected credentials (${response.status})`
          );
        }

        if (!response.ok) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: `Anthropic usage endpoint returned ${response.status}`,
          };
        }

        const payload = (await response.json()) as unknown;
        const windows = extractAnthropicWindows(payload, checkedAt);
        if (windows.length === 0) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            'Anthropic usage endpoint did not expose any known quotas'
          );
        }

        return {
          providerID: provider.id,
          modelID,
          status: 'available',
          source: 'provider',
          checkedAt,
          windows,
          note,
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the Anthropic usage endpoint',
        };
      }
    },
  };
}

async function readAnthropicLocalProxyStatus(
  providerID: string,
  modelID: string | null,
  checkedAt: number,
  baseUrl: string
): Promise<{ status: ProviderLimitStatus | null; fallbackNote: string | null }> {
  try {
    const response = await fetch(new URL(MERIDIAN_QUOTA_ENDPOINT_PATH, baseUrl), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Varro/0.1.0',
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        status: null,
        fallbackNote: `Local Claude proxy quota endpoint returned ${response.status}`,
      };
    }

    const payload = (await response.json()) as unknown;
    const windows = extractMeridianWindows(payload, checkedAt);
    if (windows.length === 0) {
      return {
        status: null,
        fallbackNote: 'Local Claude proxy quota endpoint did not expose any known quotas',
      };
    }

    return {
      status: {
        providerID,
        modelID,
        status: 'available',
        source: 'provider',
        checkedAt,
        windows,
        note: 'Read from local Claude proxy quota endpoint',
      },
      fallbackNote: null,
    };
  } catch {
    return {
      status: null,
      fallbackNote: 'Failed to poll the local Claude proxy quota endpoint',
    };
  }
}

function shouldRefreshAnthropicCredentials(
  responseStatus: number,
  credentials: AnthropicCredentials
): credentials is AnthropicCredentials & { refreshToken: string; credentialsFilePath: string } {
  return (
    (responseStatus === 401 || responseStatus === 429) &&
    Boolean(credentials.refreshToken) &&
    Boolean(credentials.credentialsFilePath)
  );
}

function extractAnthropicWindows(payload: unknown, checkedAt: number): ProviderLimitWindow[] {
  const record = asRecord(payload);
  if (!record) return [];

  const windows: ProviderLimitWindow[] = [];
  for (const def of ANTHROPIC_QUOTA_DEFS) {
    const window = buildAnthropicWindow(def.id, def.label, asRecord(record[def.id]), checkedAt);
    if (window) windows.push(window);
  }

  return windows;
}

function extractMeridianWindows(payload: unknown, checkedAt: number): ProviderLimitWindow[] {
  const record = asRecord(payload);
  if (!record) return [];

  const windows: ProviderLimitWindow[] = [];
  const buckets = Array.isArray(record.buckets) ? record.buckets : [];
  for (const bucket of buckets) {
    const window = buildMeridianBucketWindow(asRecord(bucket), checkedAt);
    if (window) windows.push(window);
  }

  const extraUsageWindow = buildMeridianExtraUsageWindow(asRecord(record.extraUsage), checkedAt);
  if (extraUsageWindow) windows.push(extraUsageWindow);
  return windows;
}

function buildMeridianBucketWindow(
  bucket: Record<string, unknown> | null,
  checkedAt: number
): ProviderLimitWindow | null {
  if (!bucket) return null;

  const id = getString(bucket.type);
  if (!id || HIDDEN_MERIDIAN_WINDOW_IDS.has(id)) return null;
  const utilization = clampFraction(parseFiniteNumber(bucket.utilization));
  if (utilization == null) return null;

  const percent = clampPercent(utilization * 100);
  if (percent == null) return null;

  return {
    id,
    label: MERIDIAN_WINDOW_LABELS[id] || toTitleLabel(id),
    unit: 'unknown',
    remaining: Math.max(100 - percent, 0),
    limit: 100,
    resetAt: parseRateLimitResetAt(bucket.resetsAt, checkedAt),
    percent,
  } satisfies ProviderLimitWindow;
}

function buildMeridianExtraUsageWindow(
  extraUsage: Record<string, unknown> | null,
  checkedAt: number
): ProviderLimitWindow | null {
  if (!extraUsage) return null;
  if (extraUsage.isEnabled === false) return null;

  const limit = parseFiniteNumber(extraUsage.monthlyLimit);
  const used = parseFiniteNumber(extraUsage.usedCredits);
  if (limit == null || limit <= 0 || used == null) return null;

  const utilization = clampFraction(parseFiniteNumber(extraUsage.utilization));
  const percent = clampPercent((utilization ?? used / limit) * 100);

  return {
    id: 'extra_usage',
    label: 'Extra Usage',
    unit: 'credits',
    remaining: Math.max(limit - used, 0),
    limit,
    resetAt: parseRateLimitResetAt(extraUsage.resetsAt, checkedAt),
    ...(percent == null ? {} : { percent }),
  } satisfies ProviderLimitWindow;
}

function buildAnthropicWindow(
  id: string,
  label: string,
  quota: Record<string, unknown> | null,
  checkedAt: number
): ProviderLimitWindow | null {
  if (!quota || quota.is_enabled === false || quota.isEnabled === false) return null;

  const percent = clampPercent(parseFiniteNumber(quota.utilization));
  if (percent == null) return null;

  const creditLimit = parseFiniteNumber(quota.monthly_limit ?? quota.monthlyLimit);
  const usedCredits = parseFiniteNumber(quota.used_credits ?? quota.usedCredits);
  const hasCreditBounds = creditLimit != null && creditLimit > 0 && usedCredits != null;
  const remaining = hasCreditBounds
    ? Math.max(creditLimit - usedCredits, 0)
    : Math.max(100 - percent, 0);
  const limit = hasCreditBounds ? creditLimit : 100;
  const unit: ProviderLimitUnit = hasCreditBounds ? 'credits' : 'unknown';

  return {
    id,
    label,
    unit,
    remaining,
    limit,
    resetAt: parseRateLimitResetAt(quota.resets_at ?? quota.resetsAt, checkedAt),
    percent,
  } satisfies ProviderLimitWindow;
}

async function readAnthropicStatuslineStatus(
  providerID: string,
  modelID: string | null,
  checkedAt: number
): Promise<ProviderLimitStatus | null> {
  try {
    const path = getAnthropicStatuslineFilePath();
    const info = await stat(path);
    if (!info.isFile() || !isAnthropicStatuslineFresh(info.mtimeMs)) return null;

    const raw = await readFile(path, 'utf-8');
    const windows = extractAnthropicStatuslineWindows(JSON.parse(raw) as unknown, checkedAt);
    if (windows.length === 0) return null;

    return {
      providerID,
      modelID,
      status: 'available',
      source: 'provider',
      checkedAt,
      windows,
      note: 'Read from Anthropic statusline bridge file',
    };
  } catch {
    return null;
  }
}

function getAnthropicLocalProxyBaseUrl(provider: ProviderMetadata) {
  const optionBaseUrl = asRecord(provider.options)?.baseURL ?? asRecord(provider.options)?.baseUrl;
  const candidates = [getString(optionBaseUrl)];
  for (const model of Object.values(provider.models)) {
    candidates.push(model.api?.url?.trim() || '');
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (isLoopbackHost(url.hostname)) return url.origin;
    } catch {}
  }

  return null;
}

function isLoopbackHost(hostname: string) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '::'
  );
}

function extractAnthropicStatuslineWindows(
  payload: unknown,
  checkedAt: number
): ProviderLimitWindow[] {
  const rateLimits = asRecord(asRecord(payload)?.rate_limits ?? asRecord(payload)?.rateLimits);
  if (!rateLimits) return [];

  const windows: ProviderLimitWindow[] = [];
  const fiveHour = buildAnthropicStatuslineWindow(
    'five_hour',
    '5-Hour Limit',
    asRecord(rateLimits.five_hour ?? rateLimits.fiveHour),
    checkedAt
  );
  if (fiveHour) windows.push(fiveHour);

  const sevenDay = buildAnthropicStatuslineWindow(
    'seven_day',
    'Weekly All-Model',
    asRecord(rateLimits.seven_day ?? rateLimits.sevenDay),
    checkedAt
  );
  if (sevenDay) windows.push(sevenDay);

  return windows;
}

function buildAnthropicStatuslineWindow(
  id: string,
  label: string,
  window: Record<string, unknown> | null,
  checkedAt: number
): ProviderLimitWindow | null {
  if (!window) return null;

  const percent = parseStatuslinePercent(window.used_percentage ?? window.usedPercentage);
  if (percent == null) return null;

  return {
    id,
    label,
    unit: 'unknown',
    remaining: Math.max(100 - percent, 0),
    limit: 100,
    resetAt: parseStatuslineResetAt(window.resets_at ?? window.resetsAt, checkedAt),
    percent,
  } satisfies ProviderLimitWindow;
}

async function resolveAnthropicCredentials(
  authStore: Record<string, ProviderAuthRecord>
): Promise<AnthropicCredentials | null> {
  const fileCredentials = await readAnthropicCredentialsFromClaudeCredentials();
  const auth = authStore.anthropic;
  if (auth?.type !== 'oauth') return fileCredentials;

  return {
    accessToken: auth.access,
    refreshToken: fileCredentials?.refreshToken ?? null,
    credentialsFilePath: fileCredentials?.credentialsFilePath ?? null,
  };
}

async function readAnthropicCredentialsFromClaudeCredentials(): Promise<AnthropicCredentials | null> {
  const credentialsFilePath = getClaudeCredentialsFilePath();
  try {
    const raw = await readFile(credentialsFilePath, 'utf-8');
    return parseAnthropicCredentials(raw, credentialsFilePath);
  } catch {
    return null;
  }
}

function getClaudeCredentialsFilePath(home = homedir()) {
  return join(home, '.claude', '.credentials.json');
}

function getAnthropicStatuslineFilePath(home = homedir()) {
  return join(home, '.onwatch', 'data', 'anthropic-statusline.json');
}

function parseAnthropicCredentials(
  raw: string,
  credentialsFilePath: string
): AnthropicCredentials | null {
  try {
    const oauth = asRecord(asRecord(JSON.parse(raw) as unknown)?.claudeAiOauth);
    if (!oauth) return null;

    const accessToken = getString(oauth.accessToken);
    const refreshToken = getString(oauth.refreshToken) || null;
    if (!accessToken && !refreshToken) return null;

    return {
      accessToken,
      refreshToken,
      credentialsFilePath,
    };
  } catch {
    return null;
  }
}

async function fetchAnthropicUsage(token: string) {
  return fetch(ANTHROPIC_USAGE_ENDPOINT, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'anthropic-beta': ANTHROPIC_BETA_HEADER,
      'User-Agent': ANTHROPIC_USER_AGENT,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

async function refreshAnthropicAccessToken(refreshToken: string) {
  try {
    const response = await fetch(ANTHROPIC_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': ANTHROPIC_USER_AGENT,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const payload = parseJsonRecord(await response.text());
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      if (getString(payload?.error) === 'invalid_grant') {
        return {
          status: 'unsupported' as const,
          note: 'Anthropic OAuth refresh rejected credentials (invalid_grant)',
        };
      }
    }

    if (!response.ok) {
      return {
        status: 'error' as const,
        note: `Anthropic OAuth refresh endpoint returned ${response.status}`,
      };
    }

    const accessToken = getString(payload?.access_token);
    if (!accessToken) {
      return {
        status: 'error' as const,
        note: 'Anthropic OAuth refresh endpoint returned an empty access token',
      };
    }

    return {
      status: 'success' as const,
      accessToken,
      refreshToken: getString(payload?.refresh_token) || refreshToken,
      expiresInSeconds: parsePositiveInteger(payload?.expires_in),
    };
  } catch {
    return {
      status: 'error' as const,
      note: 'Failed to refresh Anthropic OAuth credentials',
    };
  }
}

async function writeAnthropicCredentials(
  credentialsFilePath: string,
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number | null
) {
  const raw = await readFile(credentialsFilePath, 'utf-8');
  const root = asRecord(JSON.parse(raw) as unknown) ?? {};
  const oauth = asRecord(root.claudeAiOauth) ?? {};

  const updatedOauth: Record<string, unknown> = {
    ...oauth,
    accessToken,
    refreshToken,
  };
  if (expiresInSeconds != null) {
    updatedOauth.expiresAt = Date.now() + expiresInSeconds * 1000;
  }

  const tempPath = `${credentialsFilePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const fileMode = await stat(credentialsFilePath)
    .then((file) => file.mode & 0o777)
    .catch(() => 0o600);
  await writeFile(
    tempPath,
    JSON.stringify({
      ...root,
      claudeAiOauth: updatedOauth,
    }),
    { encoding: 'utf-8', mode: fileMode }
  );
  await rename(tempPath, credentialsFilePath);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInteger(value: unknown) {
  const parsed = parseFiniteNumber(value);
  if (parsed == null || parsed <= 0) return null;
  return Math.round(parsed);
}

function clampFraction(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function parseJsonRecord(raw: string) {
  if (!raw.trim()) return null;
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function clampPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value)) * 1000) / 1000;
}

function parseStatuslinePercent(value: unknown) {
  const percent = parseFiniteNumber(value);
  if (percent == null || percent < 0 || percent > 100) return null;
  return Math.round(percent * 1000) / 1000;
}

function toTitleLabel(value: string) {
  return (
    value
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Limit'
  );
}

function parseStatuslineResetAt(value: unknown, checkedAt: number) {
  const numeric = parseFiniteNumber(value);
  if (numeric == null) return null;
  if (numeric === 0) return null;
  if (numeric < 1_000_000_000) return null;
  return parseRateLimitResetAt(numeric, checkedAt);
}

function isAnthropicStatuslineFresh(mtimeMs: number) {
  return Number.isFinite(mtimeMs) && Date.now() - mtimeMs <= ANTHROPIC_STATUSLINE_STALENESS_MS;
}
