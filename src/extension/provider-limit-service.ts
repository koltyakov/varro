/* oxlint-disable anti-slop/no-runtime-typeof -- Provider console responses require runtime validation before quota extraction. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Provider responses are field-validated before quota use. */
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import type { ProviderLimitStatus, ProviderLimitUpdate, ServerStatus } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';
import { fetchProviderLimitFromAdapter } from './provider-limits';
import { ProviderQuotaCoordinator } from './provider-quota-coordinator';
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
    available: 30_000,
    unsupported: 60_000,
    error: 15_000,
  } as const;
  private static readonly RATE_LIMIT_ERROR_CACHE_TTL_MS = 60_000;
  private static readonly MAX_RATE_LIMIT_ERROR_CACHE_TTL_MS = 60 * 60_000;
  private static readonly PROVIDER_LIMIT_ADAPTER_TIMEOUT_MS = 45_000;
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
  private providerSnapshotGeneration = 0;
  private disposed = false;
  private readonly observationOwner = Symbol('provider-limit');

  private readonly workspaceServices = new Map<string, ProviderLimitService>();

  constructor(
    private readonly server: Pick<OpenCodeServer, 'request'>,
    private readonly coordinator = new ProviderQuotaCoordinator(),
    private readonly directory?: string,
    private readonly onUpdate?: (update: ProviderLimitUpdate) => void
  ) {}

  clearCache() {
    this.coordinator.clearObservations(this.observationOwner);
    for (const service of this.workspaceServices.values()) service.dispose();
    this.workspaceServices.clear();
    this.providerSnapshotGeneration += 1;
    this.providerLimitCache.clear();
    this.providerAuthFailureCache.clear();
    this.providerLastKnownGoodCache.clear();
    this.providerRateLimitBackoff.clear();
    this.providerMetadataPromise = null;
    this.providerMetadataFetchedAt = 0;
    this.providerAuthStorePromise = null;
    this.providerAuthStoreFetchedAt = 0;
  }

  dispose() {
    this.disposed = true;
    for (const service of this.workspaceServices.values()) service.dispose();
    this.clearCache();
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

  get(
    providerID: string,
    modelID: string | null,
    directory?: string
  ): Promise<ProviderLimitStatus> {
    if (directory && directory !== this.directory) {
      let service = this.workspaceServices.get(directory);
      if (!service) {
        service = new ProviderLimitService(this.server, this.coordinator, directory, this.onUpdate);
        this.workspaceServices.set(directory, service);
      }
      return service.get(providerID, modelID);
    }
    const cacheKey = `${providerID}:${modelID || ''}`;
    const now = Date.now();
    this.pruneExpiredProviderLimitCache(now);
    const cached = this.providerLimitCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.promise;

    const generation = this.providerSnapshotGeneration;
    const loadPromise = this.load(providerID, modelID, generation);
    const promise = loadPromise
      .then((result) => result.status)
      .catch((err) => {
        if (this.providerLimitCache.get(cacheKey)?.promise === promise) {
          this.providerLimitCache.delete(cacheKey);
        }
        throw err;
      });

    this.providerLimitCache.set(cacheKey, {
      expiresAt: now + ProviderLimitService.PROVIDER_LIMIT_ADAPTER_TIMEOUT_MS,
      promise,
    });

    void loadPromise
      .then((result) => {
        const cachedEntry = this.providerLimitCache.get(cacheKey);
        if (!cachedEntry || cachedEntry.promise !== promise) return;
        cachedEntry.expiresAt =
          Date.now() +
          (result.shared ? 0 : this.getProviderLimitCacheTtl(cacheKey, result.ttlStatus));
        if (result.status.status === 'available' && result.ttlStatus.status === 'error') {
          cachedEntry.expiresAt = Math.min(
            cachedEntry.expiresAt,
            result.status.checkedAt + 15 * 60_000
          );
        }
        if (result.rememberLastKnownGood && result.status.status === 'available') {
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
    for (const [key, status] of this.providerLastKnownGoodCache) {
      if (now - status.checkedAt > 15 * 60_000) this.providerLastKnownGoodCache.delete(key);
    }
    for (const [key, entry] of this.providerLimitCache.entries()) {
      if (entry.expiresAt <= now) {
        this.providerLimitCache.delete(key);
      }
    }
  }

  private async load(
    providerID: string,
    modelID: string | null,
    generation: number
  ): Promise<ProviderLimitLoadResult> {
    const cacheKey = `${providerID}:${modelID || ''}`;
    this.coordinator.clearObservations(
      this.observationOwner,
      JSON.stringify([this.directory ?? null, providerID, modelID])
    );
    const checkedAt = Date.now();
    // Provider limits are best-effort metadata: no failure in this subsystem
    // may surface as a rejected request. Metadata and adapter errors are
    // contained into `error` statuses so callers always get a renderable
    // result and last-known-good fallback still applies.
    let providers: ProviderMetadata[];
    const canCoordinate = ['openrouter', 'openai', 'anthropic', 'claude-code'].includes(providerID);
    try {
      providers = await this.getProviderMetadata(canCoordinate);
    } catch (err) {
      return createProviderLimitLoadResult({
        providerID,
        modelID,
        status: 'error',
        source: 'opencode',
        checkedAt,
        note: `Failed to load provider metadata: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const provider = providers.find((item) => item.id === providerID);

    if (!provider) {
      if (generation === this.providerSnapshotGeneration) {
        this.providerRateLimitBackoff.delete(`${providerID}:${modelID || ''}`);
      }
      return createProviderLimitLoadResult({
        providerID,
        modelID,
        status: 'error',
        source: 'opencode',
        checkedAt,
        note: 'Provider not found in OpenCode config',
      });
    }

    const cachedAuthFailure = this.providerAuthFailureCache.get(provider.id);
    const authStore = await this.readProviderAuthStore(canCoordinate || Boolean(cachedAuthFailure));
    const credentialFingerprint = getProviderCredentialFingerprint(provider, authStore);
    if (!canCoordinate && cachedAuthFailure?.credentialFingerprint === credentialFingerprint) {
      return createProviderLimitLoadResult(
        unsupportedProviderStatus(provider.id, modelID, checkedAt, cachedAuthFailure.note)
      );
    }

    let providerLimit: ProviderLimitStatus | null;
    let shared = false;
    let loading = true;
    try {
      providerLimit = await withTimeout(
        fetchProviderLimitFromAdapter({
          provider,
          authStore,
          modelID,
          checkedAt,
          coordinate: async (identity, poll, observation) => {
            if (process.platform === 'win32') return poll();
            shared = true;
            const token = JSON.stringify(identity);
            const status = await this.coordinator.get(token, modelID, poll, providerID);
            const canObserve =
              this.onUpdate &&
              observation?.enabled !== false &&
              (!observation?.isIdentityCurrent || (await observation.isIdentityCurrent(authStore)));
            if (
              this.onUpdate &&
              canObserve &&
              loading &&
              !this.disposed &&
              generation === this.providerSnapshotGeneration
            ) {
              this.coordinator.observe(
                this.observationOwner,
                JSON.stringify([this.directory ?? null, providerID, modelID]),
                token,
                status,
                async (next, isCurrent) => {
                  const metadataPromise = this.providerMetadataPromise;
                  const currentProviders = await metadataPromise;
                  const currentAuth = await this.readProviderAuthStore(true);
                  const currentProvider = currentProviders?.find((item) => item.id === providerID);
                  const identityCurrent = observation?.isIdentityCurrent
                    ? await observation.isIdentityCurrent(currentAuth)
                    : true;
                  if (
                    !identityCurrent ||
                    !currentProvider ||
                    metadataPromise !== this.providerMetadataPromise ||
                    !isCurrent() ||
                    this.disposed ||
                    generation !== this.providerSnapshotGeneration ||
                    credentialFingerprint !==
                      getProviderCredentialFingerprint(currentProvider, currentAuth)
                  )
                    return false;
                  this.onUpdate?.({ directory: this.directory ?? null, status: next });
                  return true;
                }
              );
            }
            return status;
          },
          setProviderAuth: async (id, auth) => {
            await this.server.request('PUT', `/auth/${encodeURIComponent(id)}`, auth, {
              directory: this.directory,
            });
          },
        }),
        ProviderLimitService.PROVIDER_LIMIT_ADAPTER_TIMEOUT_MS
      );
    } catch (err) {
      providerLimit = {
        providerID,
        modelID,
        status: 'error',
        source: 'provider',
        checkedAt,
        note: `Provider limit adapter failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    loading = false;
    if (shared && providerLimit) {
      // Shared freshness and credential identity must not be hidden by local caches.
      return { ...createProviderLimitLoadResult(providerLimit), shared: true };
    }
    if (
      providerLimit &&
      isAuthFailureProviderStatus(providerLimit) &&
      generation === this.providerSnapshotGeneration
    ) {
      this.providerAuthFailureCache.set(provider.id, {
        credentialFingerprint,
        note: providerLimit.note,
      });
    }
    if (providerLimit) {
      return this.withLastKnownGoodFallback(cacheKey, {
        ...providerLimit,
        checkedAt: providerLimit.status === 'available' ? providerLimit.checkedAt : checkedAt,
      });
    }

    const direct = extractOpenCodeProviderLimit(provider, modelID, checkedAt);
    if (direct) return createProviderLimitLoadResult(direct, true);

    try {
      const rawConsole = await this.server.request('GET', '/experimental/console', undefined, {
        directory: this.directory,
      });
      const consoleLimit = extractOpenCodeConsoleLimit(rawConsole, providerID, modelID, checkedAt);
      if (consoleLimit) return createProviderLimitLoadResult(consoleLimit, true);
    } catch {}

    return createProviderLimitLoadResult({
      providerID,
      modelID,
      status: 'unsupported',
      source: 'provider',
      checkedAt,
      note: 'No zero-cost provider quota endpoint is known for this provider',
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
    if (!lastKnownGood || Date.now() - lastKnownGood.checkedAt > 15 * 60_000)
      return createProviderLimitLoadResult(status);

    return {
      status: {
        ...lastKnownGood,
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

    const generation = this.providerSnapshotGeneration;
    const promise = (async () => {
      try {
        const raw = await fs.readFile(getOpenCodeAuthFilePath(), 'utf-8');
        return parseProviderAuthStore(raw);
      } catch {
        return {};
      }
    })();

    if (generation === this.providerSnapshotGeneration) {
      this.providerAuthStoreFetchedAt = now;
      this.providerAuthStorePromise = promise;
    }
    return promise;
  }

  private async getProviderMetadata(forceFresh = false) {
    const now = Date.now();
    if (
      !forceFresh &&
      this.providerMetadataPromise &&
      now - this.providerMetadataFetchedAt < ProviderLimitService.CACHE_TTL_MS
    ) {
      return this.providerMetadataPromise;
    }

    const generation = this.providerSnapshotGeneration;
    const promise = (async () => {
      const rawConfig = (await this.server.request('GET', '/config/providers', undefined, {
        directory: this.directory,
      })) as unknown;
      const config = asRecord(rawConfig);
      return Array.isArray(config?.providers)
        ? config.providers.filter((item): item is ProviderMetadata => Boolean(asRecord(item)))
        : [];
    })().catch((err) => {
      if (
        generation === this.providerSnapshotGeneration &&
        this.providerMetadataPromise === promise
      ) {
        this.providerMetadataPromise = null;
        this.providerMetadataFetchedAt = 0;
      }
      throw err;
    });

    if (generation === this.providerSnapshotGeneration) {
      this.providerMetadataFetchedAt = now;
      this.providerMetadataPromise = promise;
    }
    return promise;
  }
}

type AvailableProviderLimitStatus = Extract<ProviderLimitStatus, { status: 'available' }>;

type ProviderLimitLoadResult = {
  shared?: boolean;
  status: ProviderLimitStatus;
  ttlStatus: ProviderLimitStatus;
  rememberLastKnownGood?: boolean;
};

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
          ? [
              providerID,
              auth.type,
              fingerprintSecret(auth.access),
              fingerprintSecret(auth.refresh || ''),
              auth.expires || 0,
              fingerprintSecret(auth.accountId || ''),
            ]
          : [providerID, auth.type, fingerprintSecret(auth.key)]
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
    apiKey: fingerprintSecret(getProviderApiKey(provider)),
  });
}

function fingerprintSecret(value: string) {
  if (!value) return '';
  return createHash('sha256').update(value).digest('hex');
}

function getProviderApiKey(provider: ProviderMetadata) {
  const apiKey = asRecord(provider.options)?.apiKey;
  return typeof apiKey === 'string' ? apiKey.trim() : '';
}
