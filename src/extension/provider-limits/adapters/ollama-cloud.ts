/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Ollama API payloads are decoded before quota extraction. */
import type { ProviderLimitWindow } from '../../../shared/protocol';
import type { ProviderAuthRecord, ProviderMetadata } from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';
import {
  asRecord,
  getString,
  readBoundedResponseJson,
  unsupportedProviderStatus,
} from '../adapter-utils';

const OLLAMA_CLOUD_USAGE_ENDPOINT = 'https://ollama.com/api/usage';
const OPENCODE_OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';

export function createOllamaCloudAdapter(): ProviderLimitAdapter {
  return {
    id: 'ollama-cloud',
    matches(provider, authStore) {
      return (
        provider.id === 'ollama-cloud' && resolveOllamaCloudApiKey(provider, authStore) != null
      );
    },
    async fetch({ provider, authStore, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const apiKey = resolveOllamaCloudApiKey(provider, authStore);
      if (!apiKey) {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No Ollama Cloud credentials available'
        );
      }

      try {
        const response = await fetch(OLLAMA_CLOUD_USAGE_ENDPOINT, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': 'Varro/0.1.0',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 401 || response.status === 403) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            `Ollama Cloud usage endpoint rejected credentials (${response.status})`
          );
        }

        if (!response.ok) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: `Ollama Cloud usage endpoint returned ${response.status}`,
          };
        }

        const windows = extractOllamaCloudWindows(await readBoundedResponseJson(response));
        if (windows.length === 0) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            'Ollama Cloud usage endpoint did not expose any bounded quotas'
          );
        }

        return {
          providerID: provider.id,
          modelID,
          status: 'available',
          source: 'provider',
          checkedAt,
          windows,
          note: 'Polled Ollama Cloud usage endpoint',
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the Ollama Cloud usage endpoint',
        };
      }
    },
  };
}

function extractOllamaCloudWindows(payload: unknown): ProviderLimitWindow[] {
  const limits = asRecord(asRecord(payload)?.limits);
  if (!limits) return [];

  const windows: ProviderLimitWindow[] = [];
  const session = buildOllamaCloudWindow(limits.session, 'five_hour', 'Session (5h)');
  const weekly = buildOllamaCloudWindow(limits.weekly, 'weekly', 'Weekly (7d)');
  if (session) windows.push(session);
  if (weekly) windows.push(weekly);
  return windows;
}

function buildOllamaCloudWindow(
  value: unknown,
  id: string,
  label: string
): ProviderLimitWindow | null {
  const usage = asRecord(value)?.usage;
  if (typeof usage !== 'number' || !Number.isFinite(usage) || usage < 0 || usage > 1) {
    return null;
  }

  const percent = Math.round(usage * 100_000) / 1000;
  return {
    id,
    label,
    unit: 'unknown',
    remaining: 100 - percent,
    limit: 100,
    resetAt: null,
    percent,
  };
}

function resolveOllamaCloudApiKey(
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
