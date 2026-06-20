import type { ProviderLimitWindow } from '../../../shared/protocol';
import type { ProviderAuthRecord, ProviderMetadata } from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';
import {
  asRecord,
  getString,
  parseFiniteNumber,
  clampPercent,
  unsupportedProviderStatus,
} from '../adapter-utils';

const OPENROUTER_AUTH_KEY_ENDPOINT = 'https://openrouter.ai/api/v1/auth/key';
const OPENCODE_OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';

export function createOpenRouterAdapter(): ProviderLimitAdapter {
  return {
    id: 'openrouter',
    matches(provider, authStore) {
      return (
        provider.id === 'openrouter' && resolveOpenRouterAuthToken(provider, authStore) != null
      );
    },
    async fetch({ provider, authStore, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const token = resolveOpenRouterAuthToken(provider, authStore);
      if (!token) {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No OpenRouter credentials available'
        );
      }

      try {
        const response = await fetch(OPENROUTER_AUTH_KEY_ENDPOINT, {
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
            `OpenRouter auth key endpoint rejected credentials (${response.status})`
          );
        }

        if (!response.ok) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: `OpenRouter auth key endpoint returned ${response.status}`,
          };
        }

        const payload = (await response.json()) as unknown;
        const window = extractOpenRouterSpendWindow(payload);
        if (!window) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            'OpenRouter auth key endpoint did not expose a bounded spend limit'
          );
        }

        return {
          providerID: provider.id,
          modelID,
          status: 'available',
          source: 'provider',
          checkedAt,
          windows: [window],
          note: 'Polled OpenRouter auth key endpoint',
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the OpenRouter auth key endpoint',
        };
      }
    },
  };
}

function extractOpenRouterSpendWindow(payload: unknown): ProviderLimitWindow | null {
  const data = asRecord(asRecord(payload)?.data);
  if (!data) return null;

  const limit = parseFiniteNumber(data.limit);
  const usage = parseFiniteNumber(data.usage);
  const remaining =
    parseFiniteNumber(data.limit_remaining) ??
    parseFiniteNumber(data.limitRemaining) ??
    (limit != null && usage != null ? Math.max(limit - usage, 0) : null);
  if (remaining == null) return null;

  const percent =
    limit != null && limit > 0 && usage != null ? clampPercent((usage / limit) * 100) : null;

  return {
    id: 'spend',
    label: 'Spend',
    unit: 'usd',
    remaining,
    limit: limit != null && limit > 0 ? limit : null,
    resetAt: null,
    ...(percent == null ? {} : { percent }),
  } satisfies ProviderLimitWindow;
}

function resolveOpenRouterAuthToken(
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
