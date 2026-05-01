import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { ProviderLimitStatus, ProviderLimitWindow } from '../../../shared/protocol';
import { parseRateLimitResetAt, type ProviderAuthRecord } from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';

const GEMINI_QUOTA_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const GEMINI_AUTH_FILE_NAME = 'oauth_creds.json';
const GEMINI_PROVIDER_IDS = ['gemini', 'google'] as const;

const GEMINI_MODEL_SORT_ORDER: Record<string, number> = {
  'gemini-3-pro-preview': 0,
  'gemini-2.5-pro': 1,
  'gemini-3-flash-preview': 2,
  'gemini-2.5-flash': 3,
  'gemini-3.1-flash-lite-preview': 4,
  'gemini-2.5-flash-lite': 5,
};

export function createGeminiAdapter(): ProviderLimitAdapter {
  return {
    id: 'gemini',
    matches(provider) {
      return GEMINI_PROVIDER_IDS.includes(provider.id as (typeof GEMINI_PROVIDER_IDS)[number]);
    },
    async fetch({ provider, authStore, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const token = await resolveGeminiAccessToken(provider.id, authStore);
      if (!token) {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No Gemini OAuth credentials available'
        );
      }

      try {
        const response = await fetch(GEMINI_QUOTA_ENDPOINT, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Varro/0.1.0',
          },
          body: '{}',
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 401 || response.status === 403) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            `Gemini quota endpoint rejected credentials (${response.status})`
          );
        }

        if (!response.ok) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: `Gemini quota endpoint returned ${response.status}`,
          };
        }

        const payload = (await response.json()) as unknown;
        const windows = extractGeminiWindows(payload, checkedAt);
        if (windows.length === 0) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            'Gemini quota endpoint did not expose any known quotas'
          );
        }

        return {
          providerID: provider.id,
          modelID,
          status: 'available',
          source: 'provider',
          checkedAt,
          windows,
          note: 'Polled Gemini quota endpoint',
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the Gemini quota endpoint',
        };
      }
    },
  };
}

function extractGeminiWindows(payload: unknown, checkedAt: number) {
  const buckets = Array.isArray(asRecord(payload)?.buckets)
    ? (asRecord(payload)?.buckets as unknown[])
    : [];
  const windows: ProviderLimitWindow[] = [];

  for (const bucket of buckets) {
    const window = buildGeminiWindow(asRecord(bucket), checkedAt);
    if (window) windows.push(window);
  }

  return windows.toSorted((left, right) => {
    const leftOrder = GEMINI_MODEL_SORT_ORDER[left.id] ?? 100;
    const rightOrder = GEMINI_MODEL_SORT_ORDER[right.id] ?? 100;
    return leftOrder - rightOrder || left.label.localeCompare(right.label);
  });
}

function buildGeminiWindow(bucket: Record<string, unknown> | null, checkedAt: number) {
  if (!bucket) return null;

  const id = getString(bucket.modelId ?? bucket.modelID ?? bucket.name);
  const remainingFraction = clampFraction(
    parseFiniteNumber(bucket.remainingFraction ?? bucket.remaining_fraction)
  );
  if (!id || remainingFraction == null) return null;

  const remaining = roundMetric(remainingFraction * 100);
  const percent = roundMetric((1 - remainingFraction) * 100);

  return {
    id,
    label: toLabel(id),
    unit: 'unknown',
    remaining,
    limit: 100,
    resetAt: parseRateLimitResetAt(bucket.resetTime ?? bucket.reset_at, checkedAt),
    percent,
  } satisfies ProviderLimitWindow;
}

async function resolveGeminiAccessToken(
  providerID: string,
  authStore: Record<string, ProviderAuthRecord>
) {
  for (const candidateID of getGeminiAuthProviderIDs(providerID)) {
    const auth = authStore[candidateID];
    if (auth?.type === 'oauth') return auth.access;
  }

  const fileCredentials = await readGeminiCredentialsFile();
  if (fileCredentials) return fileCredentials.accessToken;

  const envToken = getString(process.env.GEMINI_ACCESS_TOKEN);
  return envToken || null;
}

function getGeminiAuthProviderIDs(providerID: string) {
  return [providerID, ...GEMINI_PROVIDER_IDS].filter(
    (candidate, index, values) => values.indexOf(candidate) === index
  );
}

async function readGeminiCredentialsFile() {
  try {
    const raw = await readFile(getGeminiAuthFilePath(), 'utf-8');
    return parseGeminiCredentials(raw);
  } catch {
    return null;
  }
}

function getGeminiAuthFilePath(env = process.env, home = homedir()) {
  const geminiHome = env.GEMINI_HOME?.trim();
  return join(geminiHome || join(home, '.gemini'), GEMINI_AUTH_FILE_NAME);
}

function parseGeminiCredentials(raw: string) {
  try {
    const record = asRecord(JSON.parse(raw) as unknown);
    const accessToken = getString(record?.access_token ?? record?.accessToken);
    if (!accessToken) return null;

    return { accessToken };
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

function clampFraction(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function roundMetric(value: number) {
  return Math.round(value * 1000) / 1000;
}

function toLabel(value: string) {
  return (
    value
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Limit'
  );
}
