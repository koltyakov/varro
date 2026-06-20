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

const MINIMAX_REMAINS_ENDPOINT = 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains';
const OPENCODE_OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';

type MiniMaxPayloadResult =
  | { kind: 'available'; windows: ProviderLimitWindow[] }
  | { kind: 'unsupported'; note: string }
  | { kind: 'error'; note: string };

export function createMiniMaxAdapter(): ProviderLimitAdapter {
  return {
    id: 'minimax',
    matches(provider, authStore) {
      return provider.id === 'minimax' && resolveMiniMaxAuthToken(provider, authStore) != null;
    },
    async fetch({ provider, authStore, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const token = resolveMiniMaxAuthToken(provider, authStore);
      if (!token) {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No MiniMax credentials available'
        );
      }

      try {
        const response = await fetch(MINIMAX_REMAINS_ENDPOINT, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Varro/0.1.0',
          },
          signal: AbortSignal.timeout(10_000),
        });
        const bodyText = await response.text();

        if (response.status === 401) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            'MiniMax quota endpoint rejected credentials (401)'
          );
        }

        if (response.status === 403 && isMiniMaxAccessBlocked(response, bodyText)) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: 'MiniMax quota endpoint is blocked by the upstream edge',
          };
        }

        const payload = parseJsonBody(bodyText);
        if (payload != null) {
          const result = extractMiniMaxPayload(payload, checkedAt);
          if (result.kind === 'unsupported') {
            return unsupportedProviderStatus(provider.id, modelID, checkedAt, result.note);
          }
          if (result.kind === 'available' && response.ok) {
            return {
              providerID: provider.id,
              modelID,
              status: 'available',
              source: 'provider',
              checkedAt,
              windows: result.windows,
              note: 'Polled MiniMax coding plan remains endpoint',
            };
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
        }

        if (!response.ok) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: `MiniMax quota endpoint returned ${response.status}`,
          };
        }

        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'MiniMax quota endpoint returned an invalid response',
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the MiniMax quota endpoint',
        };
      }
    },
  };
}

function extractMiniMaxPayload(payload: unknown, checkedAt: number): MiniMaxPayloadResult {
  const record = asRecord(payload);
  if (!record) {
    return { kind: 'error', note: 'MiniMax quota endpoint returned an invalid response' };
  }

  const baseResp = asRecord(record.base_resp) ?? asRecord(record.baseResp);
  const statusCode = parseFiniteNumber(baseResp?.status_code ?? baseResp?.statusCode);
  const statusMessage = getString(baseResp?.status_msg ?? baseResp?.statusMsg);

  if (statusCode === 1004) {
    return {
      kind: 'unsupported',
      note: 'MiniMax quota endpoint rejected credentials (1004)',
    };
  }

  if (statusCode != null && statusCode !== 0) {
    return {
      kind: 'error',
      note: buildMiniMaxApiErrorNote(statusCode, statusMessage),
    };
  }

  const modelRemains = Array.isArray(record.model_remains)
    ? record.model_remains
    : Array.isArray(record.modelRemains)
      ? record.modelRemains
      : [];
  const windows = extractMiniMaxWindows(modelRemains, checkedAt);
  if (windows.length === 0) {
    return {
      kind: 'unsupported',
      note: 'MiniMax quota endpoint did not expose any bounded quotas',
    };
  }

  return { kind: 'available', windows };
}

function extractMiniMaxWindows(modelRemains: unknown[], checkedAt: number) {
  let currentWindow: ProviderLimitWindow | null = null;
  let weeklyWindow: ProviderLimitWindow | null = null;

  for (const entry of modelRemains) {
    const record = asRecord(entry);
    if (!record) continue;

    currentWindow ??= buildMiniMaxWindow(record, checkedAt, 'current');
    weeklyWindow ??= buildMiniMaxWindow(record, checkedAt, 'weekly');
    if (currentWindow && weeklyWindow) break;
  }

  return [currentWindow, weeklyWindow].filter(
    (window): window is ProviderLimitWindow => window != null
  );
}

function buildMiniMaxWindow(
  record: Record<string, unknown>,
  checkedAt: number,
  period: 'current' | 'weekly'
): ProviderLimitWindow | null {
  const total = parseFiniteNumber(
    period === 'current'
      ? (record.current_interval_total_count ?? record.currentIntervalTotalCount)
      : (record.current_weekly_total_count ?? record.currentWeeklyTotalCount)
  );
  const remaining = parseFiniteNumber(
    period === 'current'
      ? (record.current_interval_usage_count ?? record.currentIntervalUsageCount)
      : (record.current_weekly_usage_count ?? record.currentWeeklyUsageCount)
  );
  if (remaining == null) return null;

  const normalizedRemaining = Math.max(remaining, 0);
  const limit = total != null && total > 0 ? total : null;
  const used = limit != null ? Math.max(limit - normalizedRemaining, 0) : null;
  const percent = used != null && limit != null ? clampPercent((used / limit) * 100) : null;

  return {
    id: period === 'current' ? 'requests' : 'requests-weekly',
    label: period === 'current' ? 'Requests' : 'Weekly requests',
    unit: 'requests',
    remaining: normalizedRemaining,
    limit,
    resetAt: parseMiniMaxResetAt(
      period === 'current'
        ? (record.remains_time ?? record.remainsTime)
        : (record.weekly_remains_time ?? record.weeklyRemainsTime),
      period === 'current'
        ? (record.end_time ?? record.endTime)
        : (record.weekly_end_time ?? record.weeklyEndTime),
      checkedAt
    ),
    ...(percent == null ? {} : { percent }),
  } satisfies ProviderLimitWindow;
}

function parseMiniMaxResetAt(remainsMs: unknown, absoluteResetAt: unknown, checkedAt: number) {
  const relativeMs = parseFiniteNumber(remainsMs);
  if (relativeMs != null && relativeMs > 0) {
    return checkedAt + Math.round(relativeMs);
  }

  return parseRateLimitResetAt(absoluteResetAt, checkedAt);
}

function resolveMiniMaxAuthToken(
  provider: ProviderMetadata,
  authStore: Record<string, ProviderAuthRecord>
) {
  const auth = authStore[provider.id];
  if (auth?.type === 'oauth') return auth.access;
  if (auth && 'key' in auth) return auth.key;

  const apiKey = getString(asRecord(provider.options)?.apiKey);
  if (!apiKey || apiKey === OPENCODE_OAUTH_DUMMY_KEY) return null;
  return apiKey;
}

function isMiniMaxAccessBlocked(response: Response, bodyText: string) {
  const server = getString(response.headers.get('Server')).toLowerCase();
  const contentType = getString(response.headers.get('Content-Type')).toLowerCase();
  const normalizedBody = bodyText.toLowerCase().replace(/\s+/g, ' ');
  return (
    server.includes('cloudflare') ||
    contentType.includes('text/html') ||
    normalizedBody.includes('attention required') ||
    normalizedBody.includes('please enable cookies') ||
    normalizedBody.includes('you have been blocked')
  );
}

function buildMiniMaxApiErrorNote(code: number, message: string) {
  const parts = ['MiniMax quota endpoint returned an API error', formatNumeric(code)];
  if (message) parts.push(`(${message})`);
  return parts.join(' ');
}

function formatNumeric(value: number) {
  return Number.isInteger(value) ? String(value) : String(value);
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
