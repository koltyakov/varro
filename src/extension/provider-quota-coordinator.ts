/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Private files and filesystem errors require runtime validation. */
import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { ProviderLimitStatus, ProviderLimitWindow } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';
import { ProviderQuotaIdentityChanged } from './provider-limits/types';

const STALE_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const WINDOW_LABELS = new Map(
  Object.entries({
    spend: 'Spend',
    five_hour: '5-Hour Limit',
    seven_day: 'Weekly All-Model',
    seven_day_sonnet: 'Weekly Sonnet',
    seven_day_opus: 'Weekly Opus',
    seven_day_oauth_apps: 'Weekly Apps',
    seven_day_cowork: 'Weekly Cowork',
    monthly_limit: 'Monthly Limit',
    extra_usage: 'Extra Usage',
    spark_five_hour: '5-Hour Limit (Spark)',
    spark_seven_day: 'Weekly Limit (Spark)',
    code_review: 'Review Requests',
  })
);
const PLAN_NAMES = new Set([
  'Free',
  'Plus',
  'Pro',
  'Pro 5x',
  'Pro 20x',
  'Max',
  'Team',
  'Business',
  'Enterprise',
  'Edu',
]);
type Quota = {
  checkedAt: number;
  windows: ProviderLimitWindow[];
  planName?: string;
  resetCount?: number;
  resetExpirations?: Array<number | null>;
};
type Snapshot = {
  version: 2;
  checkedAt: number;
  retryAt: number;
  backoff: number;
  outcome: 'available' | 'error' | 'unsupported';
  good: Quota | null;
};
const localFallbacks = new Map<
  string,
  { promise: Promise<ProviderLimitStatus>; retryAt: number; backoff: number }
>();

// Only opt-in adapters pass resolved request identities. Never persist arbitrary text.
export class ProviderQuotaCoordinator {
  private readonly observations = new Map<
    string,
    {
      owner: symbol;
      directory: string;
      modelID: string | null;
      providerID: string;
      expiresAt: number;
      serialized: string;
      checkedAt: number;
      notify: (status: ProviderLimitStatus, isCurrent: () => boolean) => Promise<boolean>;
    }
  >();
  private observationTimer: ReturnType<typeof setTimeout> | undefined;
  private reconciling = false;

  constructor(private readonly root = join(homedir(), '.varro-provider-quota-v2')) {}

  observe(
    owner: symbol,
    scope: string,
    token: string,
    status: ProviderLimitStatus,
    notify: (status: ProviderLimitStatus, isCurrent: () => boolean) => Promise<boolean>
  ) {
    if (process.platform === 'win32') return;
    const key = createHash('sha256').update(`${status.providerID}\0`).update(token).digest('hex');
    this.observations.delete(scope);
    this.observations.set(scope, {
      owner,
      directory: join(this.root, key),
      modelID: status.modelID ?? null,
      providerID: status.providerID,
      expiresAt: Date.now() + 5 * 60_000,
      serialized: JSON.stringify(status),
      checkedAt: status.checkedAt,
      notify,
    });
    // One timer and a bounded set of recently requested scopes for the entire host.
    if (this.observations.size > 128)
      this.observations.delete(this.observations.keys().next().value!);
    this.scheduleObservation();
  }

  clearObservations(owner: symbol, scopeToClear?: string) {
    for (const [scope, observation] of this.observations) {
      if (observation.owner === owner && (scopeToClear === undefined || scope === scopeToClear))
        this.observations.delete(scope);
    }
    if (!this.observations.size) {
      clearTimeout(this.observationTimer);
      this.observationTimer = undefined;
    }
  }

  private scheduleObservation() {
    if (this.observationTimer || this.reconciling || !this.observations.size) return;
    this.observationTimer = setTimeout(() => {
      this.observationTimer = undefined;
      this.reconciling = true;
      void this.reconcileObservations().finally(() => {
        this.reconciling = false;
        this.scheduleObservation();
      });
    }, 2_000);
    this.observationTimer.unref();
  }

  private async reconcileObservations() {
    for (const [scope, observation] of this.observations) {
      if (observation.expiresAt <= Date.now()) {
        this.observations.delete(scope);
        continue;
      }
      try {
        await validateDirectory(this.root);
        await validateDirectory(observation.directory);
        const snapshot = await readSnapshot(join(observation.directory, 'snapshot.json'));
        if (!snapshot || snapshot.checkedAt < observation.checkedAt) continue;
        const status = render(snapshot, observation.modelID, observation.providerID);
        const serialized = JSON.stringify(status);
        if (this.observations.get(scope) !== observation || serialized === observation.serialized)
          continue;
        if (!(await observation.notify(status, () => this.observations.get(scope) === observation)))
          continue;
        observation.checkedAt = snapshot.checkedAt;
        observation.serialized = serialized;
      } catch {
        // Missing, unsafe, or partially replaced files are retried without polling a provider.
      }
    }
  }

  async get(
    token: string,
    modelID: string | null,
    poll: () => Promise<ProviderLimitStatus | null>,
    providerID = 'openrouter'
  ): Promise<ProviderLimitStatus> {
    const key = createHash('sha256').update(`${providerID}\0`).update(token).digest('hex');
    let pending: Promise<ProviderLimitStatus | null> | undefined;
    const pollOnce = () => (pending ??= Promise.resolve().then(poll));
    const failure = (): ProviderLimitStatus => ({
      providerID,
      modelID,
      source: 'provider',
      status: 'error',
      checkedAt: Date.now(),
      note: 'Shared quota coordination unavailable; provider poll skipped',
    });
    try {
      // POSIX modes cannot establish private Windows ACLs. Fetch without disk sharing.
      if (process.platform === 'win32') return (await pollOnce()) ?? failure();
      await privateDirectory(this.root);
      const directory = join(this.root, key);
      await privateDirectory(directory);
      const snapshotPath = join(directory, 'snapshot.json');
      const lock = join(directory, 'lock');
      const owner = `${process.pid}-${randomUUID()}`;
      const renderSnapshot = (snapshot: Snapshot) => render(snapshot, modelID, providerID);
      const deadline = Date.now() + 32_000;
      while (true) {
        const previous = await readSnapshot(snapshotPath);
        if (previous && previous.retryAt > Date.now()) return renderSnapshot(previous);
        if (Date.now() >= deadline) return previous ? renderSnapshot(previous) : failure();
        let acquired = false;
        const candidate = join(directory, `${owner}.lock`);
        try {
          // Publish a nonempty lock atomically. Empty locks left during release or
          // recovery are safe to replace; a live owner's nonempty lock is not.
          await fs.mkdir(candidate, { mode: 0o700 });
          await fs.writeFile(join(candidate, owner), '', { flag: 'wx', mode: 0o600 });
          await fs.rename(candidate, lock);
          acquired = true;
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(String(asRecord(error)?.code))) throw error;
        } finally {
          await fs.unlink(join(candidate, owner)).catch(() => {});
          await fs.rmdir(candidate).catch(() => {});
        }
        if (!acquired) {
          let owners: string[];
          try {
            await validateDirectory(lock);
            owners = await fs.readdir(lock);
          } catch (error) {
            if (asRecord(error)?.code === 'ENOENT') continue;
            throw error;
          }
          if (owners.length === 1 && /^\d+-[a-f0-9-]{36}$/.test(owners[0]!)) {
            const oldOwner = owners[0]!;
            const pid = Number(oldOwner.split('-')[0]);
            if (Number.isSafeInteger(pid) && pid > 0 && isDead(pid)) {
              // Only the contender that removes this exact owner may remove the
              // directory. Never steal from a live PID, including a reused PID.
              try {
                await fs.unlink(join(lock, oldOwner));
                await fs.rmdir(lock);
              } catch {
                /* Another contender recovered it first. */
              }
              continue;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        const ownerPath = join(lock, owner);
        try {
          // A publisher can finish between the first read and our acquisition.
          const latest = await readSnapshot(snapshotPath);
          if (latest && latest.retryAt > Date.now()) return renderSnapshot(latest);
          let result: ProviderLimitStatus | null = null;
          try {
            // HTTP requests have their own abort deadlines. A Promise.race timeout
            // cannot stop a refresh or credential write, so retain ownership until settled.
            result = await pollOnce();
          } catch (error) {
            if (error instanceof ProviderQuotaIdentityChanged) throw error;
            /* Persist only the classified failure, not raw errors. */
          }
          const now = Date.now();
          const good =
            result?.status === 'available'
              ? sanitizeQuota(
                  {
                    ...result,
                    resetCount: result.usageLimitResets?.availableCount,
                    resetExpirations: result.usageLimitResets?.credits?.map(
                      (credit) => credit.expiresAt
                    ),
                  },
                  now
                )
              : null;
          // A new provider schema must not turn valid live limits into a cached error.
          // Unknown windows stay process-local until their IDs have been reviewed.
          if (result?.status === 'available' && !good) return result;
          const outcome = good
            ? 'available'
            : result?.status === 'unsupported'
              ? 'unsupported'
              : 'error';
          const rateLimited = result?.status === 'error' && /\b429\b/.test(result.note);
          const backoff = rateLimited
            ? Math.min((latest?.backoff || 30_000) * 2, MAX_BACKOFF_MS)
            : 0;
          const snapshot: Snapshot = {
            version: 2,
            checkedAt: now,
            retryAt:
              now + (good ? 30_000 : backoff || (outcome === 'unsupported' ? 60_000 : 15_000)),
            backoff,
            outcome,
            good:
              good ??
              (outcome === 'error' && latest?.good && now - latest.good.checkedAt <= STALE_MS
                ? latest.good
                : null),
          };
          // Publication belongs to this acquisition, never to a late poll promise.
          await fs.lstat(ownerPath);
          const temporary = join(directory, `${owner}.tmp`);
          const serialized = JSON.stringify(snapshot);
          if (Buffer.byteLength(serialized) > 4096) return result ?? failure();
          try {
            await fs.writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, snapshotPath);
          } finally {
            await fs.unlink(temporary).catch(() => {});
          }
          return renderSnapshot(snapshot);
        } finally {
          await fs.unlink(ownerPath);
          await fs.rmdir(lock).catch((error: unknown) => {
            // A contender may already have replaced the now-empty directory.
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(asRecord(error)?.code)))
              throw error;
          });
        }
      }
    } catch (error) {
      if (error instanceof ProviderQuotaIdentityChanged) throw error;
      // Unsafe or unavailable storage disables disk sharing, not quota polling.
      // Keep local single-flight and cooldown without reading or repairing unsafe files.
      const localKey = `${this.root}\0${key}`;
      const previous = localFallbacks.get(localKey);
      if (previous && previous.retryAt > Date.now())
        return { ...(await previous.promise), providerID, modelID };
      for (const [entryKey, entry] of localFallbacks) {
        if (entry.retryAt + MAX_BACKOFF_MS <= Date.now()) localFallbacks.delete(entryKey);
      }
      const entry = {
        promise: pollOnce().then(
          (result) => result ?? failure(),
          (pollError: unknown) => {
            if (pollError instanceof ProviderQuotaIdentityChanged) {
              localFallbacks.delete(localKey);
              throw pollError;
            }
            return failure();
          }
        ),
        retryAt: Infinity,
        backoff: 0,
      };
      localFallbacks.set(localKey, entry);
      const result = await entry.promise;
      entry.backoff =
        result.status === 'error' && /\b429\b/.test(result.note)
          ? Math.min((previous?.backoff || 30_000) * 2, MAX_BACKOFF_MS)
          : 0;
      entry.retryAt =
        Date.now() +
        (entry.backoff ||
          (result.status === 'available'
            ? 30_000
            : result.status === 'unsupported'
              ? 60_000
              : 15_000));
      return { ...result, providerID, modelID };
    }
  }
}

function isDead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return asRecord(error)?.code === 'ESRCH';
  }
}

async function privateDirectory(path: string) {
  try {
    await fs.mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (asRecord(error)?.code !== 'EEXIST') throw error;
  }
  await validateDirectory(path);
}

async function validateDirectory(path: string) {
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('Unsafe quota directory');
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

async function readSnapshot(path: string): Promise<Snapshot | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (asRecord(error)?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 4096
    ) {
      throw new Error('Unsafe quota snapshot');
    }
    // Bound the read even if a file changes after stat().
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    } catch {
      return null;
    }
    const value = asRecord(raw);
    const now = Date.now();
    if (
      !value ||
      value.version !== 2 ||
      !finite(value.checkedAt) ||
      value.checkedAt > now ||
      !finite(value.retryAt) ||
      value.retryAt < value.checkedAt ||
      value.retryAt > value.checkedAt + MAX_BACKOFF_MS ||
      !finite(value.backoff) ||
      value.backoff > MAX_BACKOFF_MS ||
      (value.outcome !== 'available' &&
        value.outcome !== 'error' &&
        value.outcome !== 'unsupported')
    )
      return null;
    const good =
      value.outcome === 'unsupported' ? null : sanitizeQuota(value.good, value.checkedAt);
    if (value.outcome === 'available' && !good) return null;
    return {
      version: 2,
      checkedAt: value.checkedAt,
      retryAt: value.retryAt,
      backoff: value.backoff,
      outcome: value.outcome,
      good,
    };
  } finally {
    await handle.close();
  }
}

function sanitizeQuota(value: unknown, checkedAt: number): Quota | null {
  const raw = asRecord(value);
  if (
    !raw ||
    !finite(raw.checkedAt) ||
    raw.checkedAt > checkedAt ||
    Date.now() - raw.checkedAt > STALE_MS ||
    !Array.isArray(raw.windows) ||
    raw.windows.length === 0 ||
    raw.windows.length > 16
  )
    return null;
  const windows: ProviderLimitWindow[] = [];
  for (const item of raw.windows) {
    const window = asRecord(item);
    if (!window || typeof window.id !== 'string' || !WINDOW_LABELS.has(window.id)) return null;
    const unit = window.unit;
    if (
      (unit !== 'usd' &&
        unit !== 'credits' &&
        unit !== 'unknown' &&
        unit !== 'requests' &&
        unit !== 'tokens' &&
        unit !== 'messages') ||
      !finite(window.remaining) ||
      !(window.limit === null || finite(window.limit)) ||
      !(window.resetAt === null || finite(window.resetAt)) ||
      !(window.percent == null || (finite(window.percent) && window.percent <= 100))
    )
      return null;
    windows.push({
      id: window.id,
      label: WINDOW_LABELS.get(window.id)!,
      unit,
      remaining: window.remaining,
      limit: window.limit,
      resetAt: window.resetAt,
      percent: window.percent ?? null,
    });
  }
  if (windows.length === 0) return null;
  const good: Quota = { checkedAt: raw.checkedAt, windows };
  if (typeof raw.planName === 'string' && PLAN_NAMES.has(raw.planName))
    good.planName = raw.planName;
  if (finite(raw.resetCount) && Number.isSafeInteger(raw.resetCount))
    good.resetCount = raw.resetCount;
  if (
    good.resetCount !== undefined &&
    Array.isArray(raw.resetExpirations) &&
    raw.resetExpirations.length <= 32 &&
    raw.resetExpirations.every((expiration) => expiration === null || finite(expiration))
  ) {
    good.resetExpirations = raw.resetExpirations.map((expiration) =>
      expiration === null ? null : Number(expiration)
    );
  }
  return good;
}

function render(
  snapshot: Snapshot,
  modelID: string | null,
  providerID: string
): ProviderLimitStatus {
  const base = { providerID, modelID, source: 'provider' as const };
  if (snapshot.good && Date.now() - snapshot.good.checkedAt <= STALE_MS) {
    const status: ProviderLimitStatus = {
      ...base,
      status: 'available',
      checkedAt: snapshot.good.checkedAt,
      windows: snapshot.good.windows,
      note:
        snapshot.outcome === 'available'
          ? 'Polled provider quota endpoint'
          : 'Showing the last successful quota snapshot because the latest provider poll failed',
    };
    if (snapshot.good.planName) status.planName = snapshot.good.planName;
    if (snapshot.good.resetCount !== undefined)
      status.usageLimitResets = {
        availableCount: snapshot.good.resetCount,
        credits:
          snapshot.good.resetExpirations?.map((expiresAt) => ({
            title: 'Full reset',
            expiresAt,
          })) ?? null,
      };
    return status;
  }
  return {
    ...base,
    status: snapshot.outcome === 'unsupported' ? 'unsupported' : 'error',
    checkedAt: snapshot.checkedAt,
    note:
      snapshot.outcome === 'unsupported'
        ? 'Provider quota unavailable for these credentials'
        : 'Provider quota poll failed; shared retry cooldown applies',
  };
}
