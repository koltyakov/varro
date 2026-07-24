import type { ProviderLimitStatus } from '../../shared/protocol';
import type { ProviderAuthRecord, ProviderMetadata } from '../util/provider-limit';
import { providerLimitAdapters } from './adapters';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from './types';

export function findProviderLimitAdapter(
  provider: ProviderMetadata,
  authStore: Record<string, ProviderAuthRecord>
): ProviderLimitAdapter | null {
  return providerLimitAdapters.find((adapter) => adapter.matches(provider, authStore)) ?? null;
}

export async function fetchProviderLimitFromAdapter(
  ctx: ProviderLimitAdapterContext
): Promise<ProviderLimitStatus | null> {
  const adapter = findProviderLimitAdapter(ctx.provider, ctx.authStore);
  if (!adapter) return null;
  return adapter.fetch(ctx);
}

export type { ProviderLimitAdapter, ProviderLimitAdapterContext } from './types';
