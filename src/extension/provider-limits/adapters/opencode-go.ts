/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- OpenCode Go API payloads are decoded before quota extraction. */
import type { ProviderLimitWindow } from '../../../shared/protocol';
import type { ProviderAuthRecord, ProviderMetadata } from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';
import {
  asRecord,
  clampPercent,
  getString,
  readBoundedResponseJson,
  unsupportedProviderStatus,
} from '../adapter-utils';

const OPENCODE_GO_USAGE_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';
const OPENCODE_OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';

export function createOpenCodeGoAdapter(): ProviderLimitAdapter {
  return {
    id: 'opencode-go',
    matches(provider, authStore) {
      return provider.id === 'opencode-go' && resolveOpenCodeGoApiKey(provider, authStore) != null;
    },
    async fetch({ provider, authStore, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const apiKey = resolveOpenCodeGoApiKey(provider, authStore);
      if (!apiKey) {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No OpenCode Go credentials available'
        );
      }

      try {
        const response = await fetch(OPENCODE_GO_USAGE_ENDPOINT, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': 'Varro/0.1.0',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 401) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            'OpenCode Go usage endpoint rejected credentials (401)'
          );
        }

        if (response.status === 403) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            'OpenCode Go usage endpoint requires an active Go subscription'
          );
        }

        if (!response.ok) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: `OpenCode Go usage endpoint returned ${response.status}`,
          };
        }

        const windows = extractOpenCodeGoWindows(await readBoundedResponseJson(response));
        if (windows.length === 0) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            'OpenCode Go usage endpoint did not expose any valid quota windows'
          );
        }

        return {
          providerID: provider.id,
          modelID,
          status: 'available',
          source: 'provider',
          checkedAt,
          windows,
          planName: 'Go',
          note: 'Polled OpenCode Go usage endpoint',
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the OpenCode Go usage endpoint',
        };
      }
    },
  };
}

function extractOpenCodeGoWindows(payload: unknown): ProviderLimitWindow[] {
  const usage = asRecord(asRecord(payload)?.usage);
  if (!usage) return [];

  const windows: ProviderLimitWindow[] = [];
  const rolling = buildOpenCodeGoWindow(usage.rolling, 'five_hour', '5 hour');
  const weekly = buildOpenCodeGoWindow(usage.weekly, 'weekly', 'Weekly');
  const monthly = buildOpenCodeGoWindow(usage.monthly, 'monthly', 'Monthly');
  if (rolling) windows.push(rolling);
  if (weekly) windows.push(weekly);
  if (monthly) windows.push(monthly);
  return windows;
}

function buildOpenCodeGoWindow(
  value: unknown,
  id: string,
  label: string
): ProviderLimitWindow | null {
  const record = asRecord(value);
  const percent = typeof record?.percent === 'number' ? clampPercent(record.percent) : null;
  const resetValue = getString(record?.resetsAt);
  const resetAt = resetValue ? Date.parse(resetValue) : Number.NaN;
  if (percent == null || !Number.isFinite(resetAt)) return null;

  return {
    id,
    label,
    unit: 'unknown',
    remaining: 100 - percent,
    limit: 100,
    resetAt,
    percent,
  };
}

function resolveOpenCodeGoApiKey(
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
