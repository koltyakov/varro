/* oxlint-disable anti-slop/no-unknown-parameters -- OpenRouter API payloads are decoded before quota extraction. */
import type { ProviderLimitStatus, ProviderLimitWindow } from '../../../shared/protocol';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';
import {
  asRecord,
  parseFiniteNumber,
  clampPercent,
  readBoundedResponseJson,
  unsupportedProviderStatus,
  providerErrorStatus,
  resolveProviderAuthToken,
  VARRO_USER_AGENT,
} from '../adapter-utils';

const OPENROUTER_AUTH_KEY_ENDPOINT = 'https://openrouter.ai/api/v1/auth/key';

export function createOpenRouterAdapter(): ProviderLimitAdapter {
  return {
    id: 'openrouter',
    matches(provider, authStore) {
      return provider.id === 'openrouter' && resolveProviderAuthToken(provider, authStore) != null;
    },
    async fetch({
      provider,
      authStore,
      modelID,
      checkedAt,
      coordinate,
    }: ProviderLimitAdapterContext) {
      const token = resolveProviderAuthToken(provider, authStore);
      if (!token) {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No OpenRouter credentials available'
        );
      }

      const poll = async (): Promise<ProviderLimitStatus> => {
        try {
          const response = await fetch(OPENROUTER_AUTH_KEY_ENDPOINT, {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
              'User-Agent': VARRO_USER_AGENT,
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
            return providerErrorStatus(
              provider.id,
              modelID,
              checkedAt,
              `OpenRouter auth key endpoint returned ${response.status}`
            );
          }

          const payload = await readBoundedResponseJson(response);
          const window = extractOpenRouterSpendWindow(payload);
          if (!window) {
            return unsupportedProviderStatus(
              provider.id,
              modelID,
              checkedAt,
              'OpenRouter auth key endpoint did not expose a bounded spend limit'
            );
          }

          const status: ProviderLimitStatus = {
            providerID: provider.id,
            modelID,
            status: 'available',
            source: 'provider',
            checkedAt,
            windows: [window],
            note: 'Polled OpenRouter auth key endpoint',
          };
          if (isOpenRouterFreeTier(payload)) status.planName = 'Free';
          return status;
        } catch {
          return providerErrorStatus(
            provider.id,
            modelID,
            checkedAt,
            'Failed to poll the OpenRouter auth key endpoint'
          );
        }
      };
      return coordinate ? coordinate([OPENROUTER_AUTH_KEY_ENDPOINT, token], poll) : poll();
    },
  };
}

function isOpenRouterFreeTier(payload: unknown) {
  return asRecord(asRecord(payload)?.data)?.is_free_tier === true;
}

function extractOpenRouterSpendWindow(payload: unknown): ProviderLimitWindow | null {
  const data = asRecord(asRecord(payload)?.data);
  if (!data) return null;

  const limit = parseFiniteNumber(data.limit);
  const usage = parseFiniteNumber(data.usage);
  const remaining =
    limit != null && usage != null
      ? Math.max(limit - usage, 0)
      : (parseFiniteNumber(data.limit_remaining) ?? parseFiniteNumber(data.limitRemaining));
  if (remaining == null) return null;

  const percent =
    limit != null && limit > 0 && usage != null ? clampPercent((usage / limit) * 100) : null;

  const window: ProviderLimitWindow = {
    id: 'spend',
    label: 'Spend',
    unit: 'usd',
    remaining,
    limit: limit != null && limit > 0 ? limit : null,
    resetAt: null,
  };
  if (percent != null) window.percent = percent;
  return window;
}
