import type { ProviderLimitWindow } from '../../../shared/protocol';
import {
  parseRateLimitResetAt,
  type ProviderAuthRecord,
  type ProviderMetadata,
} from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';
import {
  asRecord,
  clampPercent,
  getString,
  parseFiniteNumber,
  unsupportedProviderStatus,
} from '../adapter-utils';

const KIMI_USAGE_ENDPOINT = 'https://api.kimi.com/coding/v1/usages';
const KIMI_PROVIDER_ID = 'kimi-for-coding';
const OPENCODE_OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';

type KimiPayloadResult =
  | { kind: 'available'; windows: ProviderLimitWindow[] }
  | { kind: 'unsupported'; note: string }
  | { kind: 'error'; note: string };

export function createKimiAdapter(): ProviderLimitAdapter {
  return {
    id: 'kimi',
    matches(provider, authStore) {
      return provider.id === KIMI_PROVIDER_ID && resolveKimiAuthToken(provider, authStore) != null;
    },
    async fetch({ provider, authStore, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const token = resolveKimiAuthToken(provider, authStore);
      if (!token) {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No Kimi For Coding credentials available'
        );
      }

      try {
        const response = await fetch(KIMI_USAGE_ENDPOINT, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Varro/0.1.0',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 401 || response.status === 403) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            `Kimi For Coding usage endpoint rejected credentials (${response.status})`
          );
        }

        if (!response.ok) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: `Kimi For Coding usage endpoint returned ${response.status}`,
          };
        }

        const payload = (await response.json()) as unknown;
        const result = extractKimiPayload(payload, checkedAt);
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
          note: 'Polled Kimi For Coding usage endpoint',
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the Kimi For Coding usage endpoint',
        };
      }
    },
  };
}

function extractKimiPayload(payload: unknown, checkedAt: number): KimiPayloadResult {
  const record = asRecord(payload);
  if (!record) {
    return { kind: 'error', note: 'Kimi For Coding usage endpoint returned an invalid response' };
  }

  let fiveHourWindow: ProviderLimitWindow | null = null;
  let weeklyWindow = buildKimiWindow(asRecord(record.usage), checkedAt, 'seven_day');
  const limits = Array.isArray(record.limits) ? record.limits : [];

  for (const entry of limits) {
    const limit = asRecord(entry);
    const period = getKimiWindowPeriod(asRecord(limit?.window));
    if (!period) continue;

    const window = buildKimiWindow(asRecord(limit?.detail), checkedAt, period);
    if (!window) continue;
    if (period === 'five_hour') fiveHourWindow ??= window;
    else weeklyWindow = window;
  }

  const windows = [fiveHourWindow, weeklyWindow].filter(
    (window): window is ProviderLimitWindow => window != null
  );
  if (windows.length === 0) {
    return {
      kind: 'unsupported',
      note: 'Kimi For Coding usage endpoint did not expose any bounded quotas',
    };
  }

  return { kind: 'available', windows };
}

function buildKimiWindow(
  detail: Record<string, unknown> | null,
  checkedAt: number,
  period: 'five_hour' | 'seven_day'
): ProviderLimitWindow | null {
  if (!detail) return null;

  const limit = parseFiniteNumber(detail.limit);
  const explicitRemaining = parseFiniteNumber(detail.remaining);
  const used = parseFiniteNumber(detail.used);
  if (limit == null || limit <= 0 || (explicitRemaining == null && used == null)) return null;

  const remaining = Math.max(0, explicitRemaining ?? limit - (used ?? 0));
  const normalizedUsed = Math.max(0, used ?? limit - remaining);

  return {
    id: period,
    label: period === 'five_hour' ? '5-Hour Limit' : 'Weekly Limit',
    unit: 'requests',
    remaining,
    limit,
    resetAt: parseRateLimitResetAt(
      detail.resetTime ?? detail.resetAt ?? detail.reset_time ?? detail.reset_at,
      checkedAt
    ),
    percent: clampPercent((normalizedUsed / limit) * 100),
  } satisfies ProviderLimitWindow;
}

function getKimiWindowPeriod(
  window: Record<string, unknown> | null
): 'five_hour' | 'seven_day' | null {
  if (!window) return null;

  const duration = parseFiniteNumber(window.duration);
  if (duration == null || duration <= 0) return null;

  const unit = getString(window.timeUnit).toUpperCase();
  const seconds =
    unit === 'TIME_UNIT_SECOND'
      ? duration
      : unit === 'TIME_UNIT_MINUTE'
        ? duration * 60
        : unit === 'TIME_UNIT_HOUR'
          ? duration * 3_600
          : unit === 'TIME_UNIT_DAY'
            ? duration * 86_400
            : null;

  if (seconds === 5 * 3_600) return 'five_hour';
  if (seconds === 7 * 86_400) return 'seven_day';
  return null;
}

function resolveKimiAuthToken(
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
