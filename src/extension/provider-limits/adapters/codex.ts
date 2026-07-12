import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { ProviderLimitWindow } from '../../../shared/protocol';
import { parseRateLimitResetAt, type ProviderAuthRecord } from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';
import {
  asRecord,
  getString,
  parseFiniteNumber,
  clampPercent,
  toLabel,
  unsupportedProviderStatus,
} from '../adapter-utils';

const CODEX_USAGE_ENDPOINTS = [
  'https://chatgpt.com/backend-api/wham/usage',
  'https://chatgpt.com/api/codex/usage',
] as const;
const CODEX_AUTH_FILE_NAME = 'auth.json';
const CODEX_USER_AGENT = 'codex-cli/1.0.0';
const OPENCODE_OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';
const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

const CODEX_WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-Hour Limit',
  seven_day: 'Weekly All-Model',
  spark_five_hour: '5-Hour Limit (Spark)',
  spark_seven_day: 'Weekly Limit (Spark)',
  code_review: 'Review Requests',
};

type CodexCredentials = {
  accessToken: string;
  accountID: string | null;
};

export function createCodexAdapter(): ProviderLimitAdapter {
  return {
    id: 'openai',
    matches(provider, authStore) {
      if (provider.id !== 'openai') return false;

      const auth = authStore.openai;
      if (auth?.type === 'oauth') return true;
      return getString(asRecord(provider.options)?.apiKey) === OPENCODE_OAUTH_DUMMY_KEY;
    },
    async fetch({ provider, authStore, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const credentials = await resolveCodexCredentials(authStore);
      if (!credentials) {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No Codex OAuth credentials available'
        );
      }

      const headers = buildCodexHeaders(credentials);
      let lastStatus: number | null = null;

      try {
        for (const endpoint of CODEX_USAGE_ENDPOINTS) {
          const response = await fetch(endpoint, {
            headers,
            signal: AbortSignal.timeout(10_000),
          });

          if (response.status === 404) {
            lastStatus = response.status;
            continue;
          }

          if (response.status === 401 || response.status === 403) {
            return unsupportedProviderStatus(
              provider.id,
              modelID,
              checkedAt,
              `Codex usage endpoint rejected credentials (${response.status})`
            );
          }

          if (!response.ok) {
            return {
              providerID: provider.id,
              modelID,
              status: 'error',
              source: 'provider',
              checkedAt,
              note: `Codex usage endpoint returned ${response.status}`,
            };
          }

          const payload = (await response.json()) as unknown;
          const windows = extractCodexWindows(payload, checkedAt);
          if (windows.length === 0) {
            return unsupportedProviderStatus(
              provider.id,
              modelID,
              checkedAt,
              'Codex usage endpoint did not expose any known quotas'
            );
          }

          return {
            providerID: provider.id,
            modelID,
            status: 'available',
            source: 'provider',
            checkedAt,
            windows,
            note: 'Polled Codex OAuth usage endpoint',
          };
        }
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the Codex usage endpoint',
        };
      }

      return unsupportedProviderStatus(
        provider.id,
        modelID,
        checkedAt,
        lastStatus === 404
          ? 'Codex usage endpoint returned 404'
          : 'Codex usage endpoint did not expose any known quotas'
      );
    },
  };
}

function buildCodexHeaders(credentials: CodexCredentials) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${credentials.accessToken}`,
    'User-Agent': CODEX_USER_AGENT,
    ...(credentials.accountID
      ? {
          'ChatClaude-Account-Id': credentials.accountID,
          'X-Account-Id': credentials.accountID,
        }
      : {}),
  };
}

function extractCodexWindows(payload: unknown, checkedAt: number) {
  const record = asRecord(payload);
  if (!record) return [];

  const rateLimit = asRecord(record.rate_limit);
  const primaryWindow = asRecord(rateLimit?.primary_window);
  const secondaryWindow = asRecord(rateLimit?.secondary_window);
  const reviewWindow = asRecord(asRecord(record.code_review_rate_limit)?.primary_window);
  const planType = getString(record.plan_type);

  const windows: ProviderLimitWindow[] = [];
  const primaryID = getCodexPrimaryWindowID(planType, primaryWindow, secondaryWindow);
  const primaryQuota = primaryID ? buildCodexWindow(primaryID, primaryWindow, checkedAt) : null;
  if (primaryQuota) windows.push(primaryQuota);

  const secondaryQuota = buildCodexWindow('seven_day', secondaryWindow, checkedAt);
  if (secondaryQuota) windows.push(secondaryQuota);

  const sparkWindows = extractCodexSparkWindows(record, checkedAt);

  const reviewQuota = buildCodexWindow('code_review', reviewWindow, checkedAt);
  if (reviewQuota) windows.push(reviewQuota);

  return [...windows, ...sparkWindows].toSorted(
    (left, right) => codexWindowSortOrder(left.id) - codexWindowSortOrder(right.id)
  );
}

function buildCodexWindow(
  id: string,
  window: Record<string, unknown> | null,
  checkedAt: number
): ProviderLimitWindow | null {
  if (!window) return null;

  const percent = clampPercent(parseFiniteNumber(window.used_percent ?? window.usedPercent));
  if (percent == null) return null;

  return {
    id,
    label: CODEX_WINDOW_LABELS[id] ?? toLabel(id),
    unit: 'unknown',
    remaining: Math.max(100 - percent, 0),
    limit: 100,
    resetAt: parseRateLimitResetAt(window.reset_at ?? window.resetAt, checkedAt),
    percent,
  } satisfies ProviderLimitWindow;
}

function extractCodexSparkWindows(record: Record<string, unknown>, checkedAt: number) {
  const sparkRecord = findCodexSparkRecord(record);
  const rateLimit = asRecord(
    sparkRecord?.rate_limit ??
      sparkRecord?.rateLimit ??
      sparkRecord?.rate_limits ??
      sparkRecord?.rateLimits ??
      sparkRecord
  );
  const primaryWindow = asRecord(rateLimit?.primary_window ?? rateLimit?.primaryWindow);
  const secondaryWindow = asRecord(rateLimit?.secondary_window ?? rateLimit?.secondaryWindow);
  const explicitWindows = collectCodexSparkWindows(record, checkedAt);
  if (!sparkRecord) return explicitWindows;

  const primaryID = getCodexPrimaryWindowID('', primaryWindow, secondaryWindow);
  return dedupeCodexWindows(
    [
      ...explicitWindows,
      buildCodexWindow(primaryID ? `spark_${primaryID}` : '', primaryWindow, checkedAt),
      buildCodexWindow('spark_seven_day', secondaryWindow, checkedAt),
    ].filter((window): window is ProviderLimitWindow => window != null)
  );
}

function collectCodexSparkWindows(value: unknown, checkedAt: number) {
  const windows: ProviderLimitWindow[] = [];
  collectCodexSparkWindowsDeep(value, checkedAt, false, windows, 0);
  return dedupeCodexWindows(windows);
}

function collectCodexSparkWindowsDeep(
  value: unknown,
  checkedAt: number,
  inSparkContext: boolean,
  windows: ProviderLimitWindow[],
  depth: number
) {
  if (depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCodexSparkWindowsDeep(item, checkedAt, inSparkContext, windows, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;
  const label = getString(
    record.label ?? record.name ?? record.title ?? record.model_id ?? record.modelID ?? record.id
  );
  const nextSparkContext = inSparkContext || isCodexSparkModel(label);
  if (nextSparkContext) {
    const id = getCodexSparkWindowID(label || getString(record.key));
    const window = id ? buildCodexWindow(id, record, checkedAt) : null;
    if (window) windows.push(window);
  }

  for (const [key, child] of Object.entries(record)) {
    collectCodexSparkWindowsDeep(
      child,
      checkedAt,
      nextSparkContext || isCodexSparkModel(key),
      windows,
      depth + 1
    );
  }
}

function getCodexSparkWindowID(value: string) {
  const normalized = value.toLowerCase();
  if (!normalized.includes('spark')) return null;
  if (normalized.includes('week') || normalized.includes('seven_day')) return 'spark_seven_day';
  if (normalized.includes('5') || normalized.includes('five') || normalized.includes('hour')) {
    return 'spark_five_hour';
  }
  return null;
}

function dedupeCodexWindows(windows: ProviderLimitWindow[]) {
  const byID = new Map<string, ProviderLimitWindow>();
  for (const window of windows) {
    if (!byID.has(window.id)) byID.set(window.id, window);
  }
  return [...byID.values()];
}

function findCodexSparkRecord(record: Record<string, unknown>) {
  const direct = asRecord(
    record.spark_rate_limit ??
      record.sparkRateLimit ??
      record.spark_rate_limits ??
      record.sparkRateLimits ??
      record.codex_spark_rate_limit ??
      record.codexSparkRateLimit ??
      record.codex_spark_rate_limits ??
      record.codexSparkRateLimits
  );
  if (direct) return direct;

  return findCodexSparkRecordDeep(record, 0);
}

function findCodexSparkRecordDeep(
  candidate: unknown,
  depth: number
): Record<string, unknown> | null {
  if (depth > 4) return null;

  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const nested = findCodexSparkRecordDeep(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  const record = asRecord(candidate);
  if (!record) return null;

  for (const [name, childValue] of Object.entries(record)) {
    if (isCodexSparkModel(getString(childValue))) return normalizeCodexSparkRecord(record);

    const child = asRecord(childValue);
    if (Array.isArray(childValue)) {
      const nested = findCodexSparkRecordDeep(childValue, depth + 1);
      if (nested) return nested;
    }
    if (!child) continue;
    if (isCodexSparkModel(name)) return normalizeCodexSparkRecord(child);
    const key = getString(child.model ?? child.model_id ?? child.modelID ?? child.slug);
    if (isCodexSparkModel(key)) return normalizeCodexSparkRecord(child);

    const nested = findCodexSparkRecordDeep(child, depth + 1);
    if (nested) return nested;
  }

  return null;
}

function normalizeCodexSparkRecord(record: Record<string, unknown>) {
  return (
    asRecord(record.rate_limit ?? record.rateLimit ?? record.rate_limits ?? record.rateLimits) ??
    record
  );
}

function isCodexSparkModel(modelID: string) {
  const normalized = modelID.toLowerCase();
  return normalized.includes('codex') && normalized.includes('spark');
}

function getCodexPrimaryWindowID(
  planType: string,
  primaryWindow: Record<string, unknown> | null,
  secondaryWindow: Record<string, unknown> | null
) {
  if (!primaryWindow) return null;
  if (secondaryWindow) return 'five_hour';
  if (planType.toLowerCase() === 'free') return 'seven_day';

  const windowSeconds = parseFiniteNumber(
    primaryWindow.limit_window_seconds ?? primaryWindow.limitWindowSeconds
  );
  if (windowSeconds != null && windowSeconds >= SEVEN_DAY_WINDOW_SECONDS) {
    return 'seven_day';
  }
  if (windowSeconds != null && windowSeconds > 0 && windowSeconds <= FIVE_HOUR_WINDOW_SECONDS) {
    return 'five_hour';
  }
  return 'five_hour';
}

function codexWindowSortOrder(id: string) {
  switch (id) {
    case 'five_hour':
      return 0;
    case 'seven_day':
      return 1;
    case 'spark_five_hour':
      return 2;
    case 'spark_seven_day':
      return 3;
    case 'code_review':
      return 4;
    default:
      return 100;
  }
}

async function resolveCodexCredentials(authStore: Record<string, ProviderAuthRecord>) {
  const auth = authStore.openai;
  if (auth?.type === 'oauth') {
    return {
      accessToken: auth.access,
      accountID: null,
    } satisfies CodexCredentials;
  }

  const fileCredentials = await readCodexCredentialsFile();
  if (fileCredentials) return fileCredentials;

  const envToken = getString(process.env.CODEX_TOKEN);
  if (!envToken) return null;

  return {
    accessToken: envToken,
    accountID: null,
  } satisfies CodexCredentials;
}

async function readCodexCredentialsFile() {
  try {
    const raw = await readFile(getCodexAuthFilePath(), 'utf-8');
    return parseCodexCredentials(raw);
  } catch {
    return null;
  }
}

function getCodexAuthFilePath(env = process.env, home = homedir()) {
  const codexHome = env.CODEX_HOME?.trim();
  return join(codexHome || join(home, '.codex'), CODEX_AUTH_FILE_NAME);
}

function parseCodexCredentials(raw: string): CodexCredentials | null {
  try {
    const tokens = asRecord(asRecord(JSON.parse(raw) as unknown)?.tokens);
    const accessToken = getString(tokens?.access_token ?? tokens?.accessToken);
    if (!accessToken) return null;

    return {
      accessToken,
      accountID: getString(tokens?.account_id ?? tokens?.accountId) || null,
    } satisfies CodexCredentials;
  } catch {
    return null;
  }
}
