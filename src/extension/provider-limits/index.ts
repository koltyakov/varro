import type { ProviderLimitStatus } from '../../shared/protocol';
import type { ProviderAuthRecord, ProviderMetadata } from '../util/provider-limit';
import { providerLimitAdapters } from './adapters';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from './types';

export function findProviderLimitAdapter(
  provider: ProviderMetadata,
  authStore: Record<string, ProviderAuthRecord>,
  options?: { enabledAdapterIDs?: ReadonlySet<string> }
): ProviderLimitAdapter | null {
  return (
    providerLimitAdapters.find(
      (adapter) =>
        isProviderLimitAdapterEnabled(adapter.id, options?.enabledAdapterIDs) &&
        adapter.matches(provider, authStore)
    ) ?? null
  );
}

export async function fetchProviderLimitFromAdapter(
  ctx: ProviderLimitAdapterContext,
  options?: { enabledAdapterIDs?: ReadonlySet<string> }
): Promise<ProviderLimitStatus | null> {
  const adapter = findProviderLimitAdapter(ctx.provider, ctx.authStore, options);
  if (!adapter) return null;
  return adapter.fetch(ctx);
}

export type { ProviderLimitAdapter, ProviderLimitAdapterContext } from './types';

function isProviderLimitAdapterEnabled(id: string, enabledAdapterIDs?: ReadonlySet<string>) {
  return !enabledAdapterIDs || enabledAdapterIDs.has(id);
}
