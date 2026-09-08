import type { ProviderLimitStatus } from '../../shared/protocol';
import type { ProviderAuthRecord, ProviderMetadata } from '../util/provider-limit';

export class ProviderQuotaIdentityChanged extends Error {
  constructor() {
    super('Provider quota credentials changed; retry with the current identity');
  }
}

export interface ProviderLimitAdapterContext {
  provider: ProviderMetadata;
  authStore: Record<string, ProviderAuthRecord>;
  modelID: string | null;
  checkedAt: number;
  coordinate?(
    identity: string[],
    poll: () => Promise<ProviderLimitStatus>,
    observation?: {
      enabled?: boolean;
      isIdentityCurrent?(authStore: Record<string, ProviderAuthRecord>): Promise<boolean>;
    }
  ): Promise<ProviderLimitStatus>;
  setProviderAuth?(providerID: string, auth: ProviderAuthRecord): Promise<void>;
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
