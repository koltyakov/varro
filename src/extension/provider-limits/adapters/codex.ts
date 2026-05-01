import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { ProviderLimitStatus, ProviderLimitWindow } from '../../../shared/protocol';
import { parseRateLimitResetAt, type ProviderAuthRecord } from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';

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

  const reviewQuota = buildCodexWindow('code_review', reviewWindow, checkedAt);
  if (reviewQuota) windows.push(reviewQuota);

  return windows.toSorted(
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
    case 'code_review':
      return 2;
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

function clampPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value)) * 1000) / 1000;
}

function toLabel(value: string) {
  return (
    value
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Limit'
  );
}
