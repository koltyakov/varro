import { readFile } from 'fs/promises';
import type { ProviderLimitStatus, ServerStatus } from '../shared/protocol';
import type { OpenCodeServer } from './server';
import {
  buildProviderLimitProbe,
  extractOpenCodeConsoleLimit,
  extractOpenCodeProviderLimit,
  getOpenCodeAuthFilePath,
  parseProviderAuthStore,
  parseProviderLimitHeaders,
  type ProviderAuthRecord,
  type ProviderMetadata,
} from './util/provider-limit';

export class ProviderLimitService {
  private static readonly CACHE_TTL_MS = 60_000;

  private readonly providerLimitCache = new Map<
    string,
    { expiresAt: number; promise: Promise<ProviderLimitStatus> }
  >();
  private providerMetadataPromise: Promise<ProviderMetadata[]> | null = null;
  private providerMetadataFetchedAt = 0;
  private providerAuthStorePromise: Promise<Record<string, ProviderAuthRecord>> | null = null;
  private providerAuthStoreFetchedAt = 0;

  constructor(private readonly server: Pick<OpenCodeServer, 'request'>) {}

  clearCache() {
    this.providerLimitCache.clear();
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
    const cached = this.providerLimitCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.promise;

    const promise = this.load(providerID, modelID).catch((err) => {
      if (this.providerLimitCache.get(cacheKey)?.promise === promise) {
        this.providerLimitCache.delete(cacheKey);
      }
      throw err;
    });

    this.providerLimitCache.set(cacheKey, {
      expiresAt: now + ProviderLimitService.CACHE_TTL_MS,
      promise,
    });
    return promise;
  }

  private async load(providerID: string, modelID: string | null): Promise<ProviderLimitStatus> {
    const checkedAt = Date.now();
    const providers = await this.getProviderMetadata();
    const provider = providers.find((item) => item.id === providerID);

    if (!provider) {
      return {
        providerID,
        modelID,
        status: 'error',
        source: 'opencode',
        checkedAt,
        note: 'Provider not found in OpenCode config',
      };
    }

    const direct = extractOpenCodeProviderLimit(provider, modelID, checkedAt);
    if (direct) return direct;

    try {
      const rawConsole = await this.server.request('GET', '/experimental/console');
      const consoleLimit = extractOpenCodeConsoleLimit(rawConsole, providerID, modelID, checkedAt);
      if (consoleLimit) return consoleLimit;
    } catch {}

    const authStore = await this.readProviderAuthStore();
    const probe = buildProviderLimitProbe(provider, authStore);
    if (!probe) {
      return {
        providerID,
        modelID,
        status: 'unsupported',
        source: 'provider',
        checkedAt,
        note: 'No zero-cost provider quota endpoint is known for this provider',
      };
    }

    try {
      const response = await fetch(probe.url, {
        headers: probe.headers,
        signal: AbortSignal.timeout(10_000),
      });
      const windows = parseProviderLimitHeaders(response.headers, checkedAt);
      if (windows.length > 0) {
        return {
          providerID,
          modelID,
          status: 'available',
          source: 'provider',
          checkedAt,
          windows,
          note: 'Polled provider metadata headers',
        };
      }

      return {
        providerID,
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
        providerID,
        modelID,
        status: 'error',
        source: 'provider',
        checkedAt,
        note: 'Failed to poll the provider metadata endpoint',
      };
    }
  }

  private async readProviderAuthStore() {
    const now = Date.now();
    if (
      this.providerAuthStorePromise &&
      now - this.providerAuthStoreFetchedAt < ProviderLimitService.CACHE_TTL_MS
    ) {
      return this.providerAuthStorePromise;
    }

    this.providerAuthStoreFetchedAt = now;
    this.providerAuthStorePromise = (async () => {
      try {
        const raw = await readFile(getOpenCodeAuthFilePath(), 'utf-8');
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
