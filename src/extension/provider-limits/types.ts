import type { ProviderLimitStatus } from '../../shared/protocol';
import type { ProviderAuthRecord, ProviderMetadata } from '../util/provider-limit';

export interface ProviderLimitAdapterContext {
  provider: ProviderMetadata;
  authStore: Record<string, ProviderAuthRecord>;
  modelID: string | null;
  checkedAt: number;
}

export interface ProviderLimitAdapterCapabilities {
  localFile?: boolean;
  oauthRefresh?: boolean;
  localIpc?: boolean;
}

export interface ProviderLimitAdapter {
  id: string;
  matches(provider: ProviderMetadata, authStore: Record<string, ProviderAuthRecord>): boolean;
  fetch(ctx: ProviderLimitAdapterContext): Promise<ProviderLimitStatus>;
  capabilities?: ProviderLimitAdapterCapabilities;
}
