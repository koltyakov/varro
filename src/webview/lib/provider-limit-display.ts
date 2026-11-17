import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { PROVIDER_LIMIT_STALE_RETENTION_MS } from '../../shared/provider-limit-config';
import type { ProviderLimitStatus } from '../../shared/protocol';

export function getProviderLimitDisplay(
  limit: ProviderLimitStatus | null | undefined,
  now = Date.now()
): ProviderLimitStatus | null {
  if (
    limit?.status === 'available' &&
    limit.stale &&
    now >= limit.checkedAt + PROVIDER_LIMIT_STALE_RETENTION_MS
  ) {
    return {
      providerID: limit.providerID,
      modelID: limit.modelID,
      status: 'error',
      source: limit.source,
      checkedAt: now,
      retryAt: limit.retryAt,
      note: `Cached quota snapshot expired. ${limit.note ?? 'The latest quota refresh failed.'}`,
    };
  }
  if (
    limit?.status === 'available' &&
    limit.usageLimitResets?.stale &&
    limit.usageLimitResets.checkedAt !== undefined &&
    now >= limit.usageLimitResets.checkedAt + PROVIDER_LIMIT_STALE_RETENTION_MS
  ) {
    const display = { ...limit };
    delete display.usageLimitResets;
    return display;
  }
  return limit ?? null;
}

/** Expire retained quotas even when automatic polling is disabled or the view is hidden. */
export function createProviderLimitDisplay(
  readLimit: Accessor<ProviderLimitStatus | null>
): Accessor<ProviderLimitStatus | null> {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    const limit = readLimit();
    setNow(Date.now());
    if (limit?.status !== 'available') return;
    const deadlines: number[] = [];
    if (limit.stale) deadlines.push(limit.checkedAt + PROVIDER_LIMIT_STALE_RETENTION_MS);
    if (limit.usageLimitResets?.stale && limit.usageLimitResets.checkedAt !== undefined) {
      deadlines.push(limit.usageLimitResets.checkedAt + PROVIDER_LIMIT_STALE_RETENTION_MS);
    }
    const timers = [...new Set(deadlines)]
      .filter((deadline) => deadline > Date.now())
      .map((deadline) => setTimeout(() => setNow(Date.now()), deadline - Date.now()));
    onCleanup(() => {
      for (const timer of timers) clearTimeout(timer);
    });
  });
  return createMemo(() => getProviderLimitDisplay(readLimit(), now()));
}
