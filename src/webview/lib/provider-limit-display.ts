import { createEffect, createMemo, createSignal, type Accessor } from 'solid-js';

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
  createEffect(
    () => {
      const limit = readLimit();
      const deadlines: number[] = [];
      if (limit?.status !== 'available') return deadlines;
      if (limit.stale) deadlines.push(limit.checkedAt + PROVIDER_LIMIT_STALE_RETENTION_MS);
      if (limit.usageLimitResets?.stale && limit.usageLimitResets.checkedAt !== undefined) {
        deadlines.push(limit.usageLimitResets.checkedAt + PROVIDER_LIMIT_STALE_RETENTION_MS);
      }
      return deadlines;
    },
    (deadlines) => {
      setNow(Date.now());
      const timers = [...new Set(deadlines)]
        .filter((deadline) => deadline > Date.now())
        .map((deadline) => setTimeout(() => setNow(Date.now()), deadline - Date.now()));
      return () => {
        for (const timer of timers) clearTimeout(timer);
      };
    }
  );
  return createMemo(() => getProviderLimitDisplay(readLimit(), now()));
}
