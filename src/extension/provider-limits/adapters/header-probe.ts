import type { ProviderLimitStatus } from '../../../shared/protocol';
import {
  buildProviderLimitProbe,
  parseProviderLimitHeaders,
  type ProviderAuthRecord,
  type ProviderMetadata,
} from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';

export function createHeaderProbeAdapter(id: string): ProviderLimitAdapter {
  return {
    id,
    matches(provider, authStore) {
      return provider.id === id && buildProviderLimitProbe(provider, authStore) != null;
    },
    async fetch({ provider, authStore, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const probe = buildProviderLimitProbe(provider, authStore);
      if (!probe) {
        return unsupportedProviderStatus(provider.id, modelID, checkedAt);
      }

      try {
        const response = await fetch(probe.url, {
          headers: probe.headers,
          signal: AbortSignal.timeout(10_000),
        });
        const windows = parseProviderLimitHeaders(response.headers, checkedAt);
        if (windows.length > 0) {
          return {
            providerID: provider.id,
            modelID,
            status: 'available',
            source: 'provider',
            checkedAt,
            windows,
            note: 'Polled provider metadata headers',
          };
        }

        return {
          providerID: provider.id,
          modelID,
          status: 'unsupported',
          source: 'provider',
          checkedAt,
          note: response.ok
            ? 'Provider metadata endpoint did not expose remaining limits'
            : `Provider metadata endpoint returned ${response.status}`,
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the provider metadata endpoint',
        };
      }
    },
  };
}

export function supportsHeaderProbeProvider(
  id: string,
  provider: ProviderMetadata,
  authStore: Record<string, ProviderAuthRecord>
) {
  return provider.id === id && buildProviderLimitProbe(provider, authStore) != null;
}

function unsupportedProviderStatus(
  providerID: string,
  modelID: string | null,
  checkedAt: number
): ProviderLimitStatus {
  return {
    providerID,
    modelID,
    status: 'unsupported',
    source: 'provider',
    checkedAt,
    note: 'No zero-cost provider quota endpoint is known for this provider',
  };
}
