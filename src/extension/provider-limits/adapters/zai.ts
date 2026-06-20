import type { ProviderLimitWindow } from '../../../shared/protocol';
import {
  parseRateLimitResetAt,
  type ProviderAuthRecord,
  type ProviderMetadata,
} from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';
import {
  asRecord,
  getString,
  parseFiniteNumber,
  clampPercent,
  unsupportedProviderStatus,
} from '../adapter-utils';

const ZAI_QUOTA_ENDPOINT = 'https://api.z.ai/api/monitor/usage/quota/limit';
const OPENCODE_OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';
const ZAI_PROVIDER_IDS = new Set(['zai', 'zai-coding-plan']);
const ZAI_MONTHLY_SEARCH_MODELS = new Set(['search-prime', 'web-reader', 'zread']);

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

  const percent = clampPercent(parseFiniteNumber(limitRecord.percentage));
  const currentValue = parseFiniteNumber(limitRecord.currentValue);
  const explicitRemaining = parseFiniteNumber(limitRecord.remaining);
  const usage = parseFiniteNumber(limitRecord.usage);
  const limit =
    usage ??
    (currentValue != null && explicitRemaining != null ? currentValue + explicitRemaining : null);
  const remaining = explicitRemaining ?? (percent != null ? Math.max(0, 100 - percent) : null);
  if (remaining == null) return null;

  const descriptor = getZaiWindowDescriptor(type, limitRecord);

  return {
    id: descriptor.id,
    label: descriptor.label,
    unit: descriptor.unit,
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

function getZaiWindowDescriptor(type: string, limitRecord: Record<string, unknown>) {
  if (type === 'TOKENS_LIMIT') {
    return {
      id: 'five_hour',
      label: '5 Hours Quota',
      unit: 'unknown' as const,
    };
  }

  if (type === 'TIME_LIMIT' && isZaiMonthlySearchQuota(limitRecord)) {
    return {
      id: 'monthly_web_search_reader_zread',
      label: 'Total Monthly Web Search / Reader / Zread Quota',
      unit: 'unknown' as const,
    };
  }

  if (type === 'TIME_LIMIT') return { id: 'time', label: 'Time', unit: 'unknown' as const };

  return {
    id:
      type
        .toLowerCase()
        .replace(/_limit$/i, '')
        .replace(/[^a-z0-9]+/g, '-') || 'limit',
    label:
      type
        .toLowerCase()
        .replace(/_+/g, ' ')
        .trim()
        .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Limit',
    unit: 'unknown' as const,
  };
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

function isZaiMonthlySearchQuota(limitRecord: Record<string, unknown>) {
  const usageDetails = Array.isArray(limitRecord.usageDetails) ? limitRecord.usageDetails : [];
  if (usageDetails.length === 0) return false;

  return usageDetails.some((detail) => {
    const modelCode = getString(asRecord(detail)?.modelCode).toLowerCase();
    return ZAI_MONTHLY_SEARCH_MODELS.has(modelCode);
  });
}
