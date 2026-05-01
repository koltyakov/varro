import type { ProviderLimitStatus, ProviderLimitWindow } from '../../../shared/protocol';
import {
  parseRateLimitResetAt,
  type ProviderAuthRecord,
  type ProviderMetadata,
} from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';

const ZAI_QUOTA_ENDPOINT = 'https://api.z.ai/api/monitor/usage/quota/limit';
const OPENCODE_OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';
const ZAI_PROVIDER_IDS = new Set(['zai', 'zai-coding-plan']);

type ZaiPayloadResult =
  | { kind: 'available'; windows: ProviderLimitWindow[] }
  | { kind: 'unsupported'; note: string }
  | { kind: 'error'; note: string };

export function createZaiAdapter(): ProviderLimitAdapter {
  return {
    id: 'zai',
    matches(provider, authStore) {
      return ZAI_PROVIDER_IDS.has(provider.id) && resolveZaiAuthToken(provider, authStore) != null;
    },
    async fetch({ provider, authStore, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const token = resolveZaiAuthToken(provider, authStore);
      if (!token) {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No Z.ai credentials available'
        );
      }

      try {
        const response = await fetch(ZAI_QUOTA_ENDPOINT, {
          headers: {
            Accept: 'application/json',
            Authorization: token,
            'User-Agent': 'Varro/0.1.0',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 401 || response.status === 403) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            `Z.ai quota endpoint rejected credentials (${response.status})`
          );
        }

        if (!response.ok) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: `Z.ai quota endpoint returned ${response.status}`,
          };
        }

        const payload = (await response.json()) as unknown;
        const result = extractZaiPayload(payload, checkedAt);
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
          note: 'Polled Z.ai quota endpoint',
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the Z.ai quota endpoint',
        };
      }
    },
  };
}

function extractZaiPayload(payload: unknown, checkedAt: number): ZaiPayloadResult {
  const record = asRecord(payload);
  if (!record) {
    return { kind: 'error', note: 'Z.ai quota endpoint returned an invalid response' };
  }

  const code = parseFiniteNumber(record.code);
  const success = record.success;
  const message = getString(record.msg);

  if (code === 401 || code === 403) {
    return {
      kind: 'unsupported',
      note: `Z.ai quota endpoint rejected credentials (${formatNumeric(code)})`,
    };
  }

  if (success === false) {
    return {
      kind: 'error',
      note: buildZaiApiErrorNote(code, message),
    };
  }

  const data = asRecord(record.data);
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const windows: ProviderLimitWindow[] = [];
  const seen = new Set<string>();

  for (const entry of limits) {
    const window = buildZaiWindow(asRecord(entry), checkedAt);
    if (!window || seen.has(window.id)) continue;
    seen.add(window.id);
    windows.push(window);
  }

  if (windows.length === 0) {
    return {
      kind: 'unsupported',
      note: 'Z.ai quota endpoint did not expose any bounded quotas',
    };
  }

  return { kind: 'available', windows };
}

function buildZaiWindow(
  limitRecord: Record<string, unknown> | null,
  checkedAt: number
): ProviderLimitWindow | null {
  if (!limitRecord) return null;

  const type = getString(limitRecord.type).toUpperCase();
  if (!type) return null;

  const remaining = parseFiniteNumber(limitRecord.remaining);
  if (remaining == null) return null;

  const currentValue = parseFiniteNumber(limitRecord.currentValue);
  const limit =
    parseFiniteNumber(limitRecord.usage) ??
    (currentValue != null ? Math.max(currentValue + remaining, 0) : null);
  const percent = clampPercent(parseFiniteNumber(limitRecord.percentage));

  return {
    id: getZaiWindowID(type),
    label: getZaiWindowLabel(type),
    unit: type === 'TOKENS_LIMIT' ? 'tokens' : 'unknown',
    remaining,
    limit: limit != null && limit > 0 ? limit : null,
    resetAt: parseRateLimitResetAt(limitRecord.nextResetTime, checkedAt),
    ...(percent == null ? {} : { percent }),
  } satisfies ProviderLimitWindow;
}

function resolveZaiAuthToken(
  provider: ProviderMetadata,
  authStore: Record<string, ProviderAuthRecord>
) {
  const auth = authStore[provider.id] ?? findAliasedZaiAuthRecord(provider.id, authStore);
  if (auth?.type === 'oauth') return auth.access;
  if (auth && 'key' in auth) return auth.key;

  const apiKey = getString(asRecord(provider.options)?.apiKey);
  if (!apiKey || apiKey === OPENCODE_OAUTH_DUMMY_KEY) return null;
  return apiKey;
}

function findAliasedZaiAuthRecord(
  providerID: string,
  authStore: Record<string, ProviderAuthRecord>
) {
  for (const candidateID of ZAI_PROVIDER_IDS) {
    if (candidateID === providerID) continue;
    const auth = authStore[candidateID];
    if (auth) return auth;
  }
  return null;
}

function getZaiWindowID(type: string) {
  if (type === 'TOKENS_LIMIT') return 'tokens';
  if (type === 'TIME_LIMIT') return 'time';
  return (
    type
      .toLowerCase()
      .replace(/_limit$/i, '')
      .replace(/[^a-z0-9]+/g, '-') || 'limit'
  );
}

function getZaiWindowLabel(type: string) {
  if (type === 'TOKENS_LIMIT') return 'Tokens';
  if (type === 'TIME_LIMIT') return 'Time';
  return (
    type
      .toLowerCase()
      .replace(/_+/g, ' ')
      .trim()
      .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Limit'
  );
}

function buildZaiApiErrorNote(code: number | null, message: string) {
  const parts = ['Z.ai quota endpoint returned an API error'];
  if (code != null) parts.push(formatNumeric(code));
  if (message) parts.push(`(${message})`);
  return parts.join(' ');
}

function formatNumeric(value: number) {
  return Number.isInteger(value) ? String(value) : String(value);
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
