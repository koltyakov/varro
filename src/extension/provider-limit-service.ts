import * as fs from 'fs/promises';
import type { ProviderLimitStatus, ServerStatus } from '../shared/protocol';
import { readProviderLimitConfig } from './provider-limit-config';
import { fetchProviderLimitFromAdapter } from './provider-limits';
import type { OpenCodeServer } from './server';
import {
  extractOpenCodeConsoleLimit,
  extractOpenCodeProviderLimit,
  getOpenCodeAuthFilePath,
  parseProviderAuthStore,
  type ProviderAuthRecord,
  type ProviderMetadata,
} from './util/provider-limit';

export class ProviderLimitService {
  private static readonly PROVIDER_LIMIT_CACHE_TTL_MS = {
    available: 5 * 60_000,
    unsupported: 60_000,
    error: 15_000,
  } as const;
  private static readonly RATE_LIMIT_ERROR_CACHE_TTL_MS = 60_000;
  private static readonly MAX_RATE_LIMIT_ERROR_CACHE_TTL_MS = 60 * 60_000;
  private static readonly CACHE_TTL_MS = 60_000;

  private readonly providerLimitCache = new Map<
    string,
    { expiresAt: number; promise: Promise<ProviderLimitStatus> }
  >();
  private readonly providerAuthFailureCache = new Map<
    string,
    { credentialFingerprint: string; note: string }
  >();
  private readonly providerLastKnownGoodCache = new Map<string, AvailableProviderLimitStatus>();
  private readonly providerRateLimitBackoff = new Map<string, number>();
  private providerMetadataPromise: Promise<ProviderMetadata[]> | null = null;
  private providerMetadataFetchedAt = 0;
  private providerAuthStorePromise: Promise<Record<string, ProviderAuthRecord>> | null = null;
  private providerAuthStoreFetchedAt = 0;

  constructor(private readonly server: Pick<OpenCodeServer, 'request'>) {}

  clearCache() {
    this.providerLimitCache.clear();
    this.providerLastKnownGoodCache.clear();
    this.providerRateLimitBackoff.clear();
  }

  shouldClearCache(previous: ServerStatus, next: ServerStatus) {
    if (previous.state !== next.state) return true;
    if (previous.state === 'running' && next.state === 'running') {
      return previous.url !== next.url;
    }
    if (previous.state === 'error' && next.state === 'error') {
      return previous.message !== next.message;
    }
    return false;
  }

  get(providerID: string, modelID: string | null) {
    const cacheKey = `${providerID}:${modelID || ''}`;
    const now = Date.now();
    this.pruneExpiredProviderLimitCache(now);
    const cached = this.providerLimitCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.promise;

    const loadPromise = this.load(providerID, modelID);
    const promise = loadPromise
      .then((result) => result.status)
      .catch((err) => {
        if (this.providerLimitCache.get(cacheKey)?.promise === promise) {
          this.providerLimitCache.delete(cacheKey);
        }
        throw err;
      });

    this.providerLimitCache.set(cacheKey, {
      expiresAt: Number.POSITIVE_INFINITY,
      promise,
    });

    void loadPromise
      .then((result) => {
        const cachedEntry = this.providerLimitCache.get(cacheKey);
        if (!cachedEntry || cachedEntry.promise !== promise) return;
        cachedEntry.expiresAt =
          Date.now() + this.getProviderLimitCacheTtl(cacheKey, result.ttlStatus);
        if (result.rememberLastKnownGood) {
          this.providerLastKnownGoodCache.set(cacheKey, result.status);
        }
      })
      .catch(() => {});
    return promise;
  }

  private getProviderLimitCacheTtl(cacheKey: string, status: ProviderLimitStatus) {
    if (status.status !== 'error') {
      this.providerRateLimitBackoff.delete(cacheKey);
      if (isAuthFailureProviderStatus(status)) return 0;
      return ProviderLimitService.PROVIDER_LIMIT_CACHE_TTL_MS[status.status];
    }

    if (!isRateLimitedProviderError(status)) {
      this.providerRateLimitBackoff.delete(cacheKey);
      return ProviderLimitService.PROVIDER_LIMIT_CACHE_TTL_MS.error;
    }

    const previousBackoff = this.providerRateLimitBackoff.get(cacheKey);
    const nextBackoff = previousBackoff
      ? Math.min(previousBackoff * 2, ProviderLimitService.MAX_RATE_LIMIT_ERROR_CACHE_TTL_MS)
      : ProviderLimitService.RATE_LIMIT_ERROR_CACHE_TTL_MS;
    this.providerRateLimitBackoff.set(cacheKey, nextBackoff);
    return nextBackoff;
  }

  private pruneExpiredProviderLimitCache(now: number) {
    for (const [key, entry] of this.providerLimitCache.entries()) {
      if (entry.expiresAt <= now) {
        this.providerLimitCache.delete(key);
      }
    }
  }

  private async load(providerID: string, modelID: string | null): Promise<ProviderLimitLoadResult> {
    const cacheKey = `${providerID}:${modelID || ''}`;
    const checkedAt = Date.now();
    const providers = await this.getProviderMetadata();
    const provider = providers.find((item) => item.id === providerID);

    if (!provider) {
      this.providerRateLimitBackoff.delete(`${providerID}:${modelID || ''}`);
      return createProviderLimitLoadResult({
        providerID,
        modelID,
        status: 'error',
        source: 'opencode',
        checkedAt,
        note: 'Provider not found in OpenCode config',
      });
    }

    const direct = extractOpenCodeProviderLimit(provider, modelID, checkedAt);
    if (direct) return createProviderLimitLoadResult(direct, true);

    try {
      const rawConsole = await this.server.request('GET', '/experimental/console');
      const consoleLimit = extractOpenCodeConsoleLimit(rawConsole, providerID, modelID, checkedAt);
      if (consoleLimit) return createProviderLimitLoadResult(consoleLimit, true);
    } catch {}

    const cachedAuthFailure = this.providerAuthFailureCache.get(provider.id);
    const authStore = await this.readProviderAuthStore(Boolean(cachedAuthFailure));
    const credentialFingerprint = getProviderCredentialFingerprint(provider, authStore);
    if (cachedAuthFailure?.credentialFingerprint === credentialFingerprint) {
      return createProviderLimitLoadResult(
        unsupportedProviderStatus(provider.id, modelID, checkedAt, cachedAuthFailure.note)
      );
    }

    const providerLimitConfig = readProviderLimitConfig();
    const providerLimit = await fetchProviderLimitFromAdapter(
      {
        provider,
        authStore,
        modelID,
        checkedAt,
      },
      { enabledAdapterIDs: providerLimitConfig.enabledAdapters }
    );
    if (providerLimit && isAuthFailureProviderStatus(providerLimit)) {
      this.providerAuthFailureCache.set(provider.id, {
        credentialFingerprint,
        note: providerLimit.note,
      });
    }
    if (!providerLimit) {
      return createProviderLimitLoadResult({
        providerID,
        modelID,
        status: 'unsupported',
        source: 'provider',
        checkedAt,
        note: 'No zero-cost provider quota endpoint is known for this provider',
      });
    }

    return this.withLastKnownGoodFallback(cacheKey, {
      ...providerLimit,
      checkedAt,
    });
  }

  private withLastKnownGoodFallback(
    cacheKey: string,
    status: ProviderLimitStatus
  ): ProviderLimitLoadResult {
    if (status.status === 'available') {
      return createProviderLimitLoadResult(status, true);
    }
    if (status.status !== 'error' || status.source !== 'provider') {
      return createProviderLimitLoadResult(status);
    }

    const lastKnownGood = this.providerLastKnownGoodCache.get(cacheKey);
    if (!lastKnownGood) return createProviderLimitLoadResult(status);

    return {
      status: {
        ...lastKnownGood,
        checkedAt: status.checkedAt,
        note: formatLastKnownGoodNote(lastKnownGood.note, status.note),
      },
      ttlStatus: status,
    };
  }

  private async readProviderAuthStore(forceFresh = false) {
    const now = Date.now();
    if (
      !forceFresh &&
      this.providerAuthStorePromise &&
      now - this.providerAuthStoreFetchedAt < ProviderLimitService.CACHE_TTL_MS
    ) {
      return this.providerAuthStorePromise;
    }

    this.providerAuthStoreFetchedAt = now;
    this.providerAuthStorePromise = (async () => {
      try {
        const raw = await fs.readFile(getOpenCodeAuthFilePath(), 'utf-8');
        return parseProviderAuthStore(raw);
      } catch {
        return {};
      }
    })();

    return this.providerAuthStorePromise;
  }

  private async getProviderMetadata() {
    const now = Date.now();
    if (
      this.providerMetadataPromise &&
      now - this.providerMetadataFetchedAt < ProviderLimitService.CACHE_TTL_MS
    ) {
      return this.providerMetadataPromise;
    }

    this.providerMetadataFetchedAt = now;
    this.providerMetadataPromise = (async () => {
      const rawConfig = (await this.server.request('GET', '/config/providers')) as unknown;
      const config = asRecord(rawConfig);
      return Array.isArray(config?.providers)
        ? config.providers.filter((item): item is ProviderMetadata => Boolean(asRecord(item)))
        : [];
    })().catch((err) => {
      if (this.providerMetadataPromise) {
        this.providerMetadataPromise = null;
        this.providerMetadataFetchedAt = 0;
      }
      throw err;
    });

    return this.providerMetadataPromise;
  }
}

type AvailableProviderLimitStatus = Extract<ProviderLimitStatus, { status: 'available' }>;

type ProviderLimitLoadResult = {
  status: ProviderLimitStatus;
  ttlStatus: ProviderLimitStatus;
  rememberLastKnownGood?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function createProviderLimitLoadResult(
  status: ProviderLimitStatus,
  rememberLastKnownGood = false
): ProviderLimitLoadResult {
  return {
    status,
    ttlStatus: status,
    rememberLastKnownGood: rememberLastKnownGood && status.status === 'available',
  };
}

function isRateLimitedProviderError(status: ProviderLimitStatus) {
  return status.status === 'error' && /\b429\b/.test(status.note);
}

function isAuthFailureProviderStatus(
  status: ProviderLimitStatus
): status is ProviderLimitStatus & { status: 'unsupported'; note: string } {
  return status.status === 'unsupported' && /rejected credentials/i.test(status.note);
}

function unsupportedProviderStatus(
  providerID: string,
  modelID: string | null,
  checkedAt: number,
  note: string
): ProviderLimitStatus {
  return {
    providerID,
    modelID,
    status: 'unsupported',
    source: 'provider',
    checkedAt,
    note,
  };
}

function formatLastKnownGoodNote(previousNote: string | undefined, errorNote: string) {
  const fallbackNote = `Showing the last successful quota snapshot because the latest provider poll failed: ${errorNote}`;
  return previousNote ? `${previousNote}. ${fallbackNote}` : fallbackNote;
}

function serializeProviderAuthStore(authStore: Record<string, ProviderAuthRecord>) {
  return JSON.stringify(
    Object.entries(authStore)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([providerID, auth]) =>
        auth.type === 'oauth'
          ? [providerID, auth.type, auth.access]
          : [providerID, auth.type, auth.key]
      )
  );
}

function getProviderCredentialFingerprint(
  provider: ProviderMetadata,
  authStore: Record<string, ProviderAuthRecord>
) {
  return JSON.stringify({
    providerID: provider.id,
    authStore: JSON.parse(serializeProviderAuthStore(authStore)) as unknown,
    apiKey: getProviderApiKey(provider),
  });
}

function getProviderApiKey(provider: ProviderMetadata) {
  const apiKey = asRecord(provider.options)?.apiKey;
  return typeof apiKey === 'string' ? apiKey.trim() : '';
}
