import { flush as flushSolid, createRoot, createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLimitStatus } from '../../shared/protocol';
import { PROVIDER_LIMIT_STALE_RETENTION_MS } from '../../shared/provider-limit-config';
import { createProviderLimitDisplay, getProviderLimitDisplay } from './provider-limit-display';

describe('provider quota display retention', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    flushSolid();
    vi.useRealTimers();
  });
  const snapshot = (): Extract<ProviderLimitStatus, { status: 'available' }> => ({
    providerID: 'zai',
    status: 'available',
    source: 'provider',
    checkedAt: Date.now(),
    stale: true,
    retryAt: Date.now() + 15_000,
    note: 'Quota refresh failed',
    windows: [
      {
        id: 'five_hour',
        label: '5-Hour Limit',
        unit: 'unknown',
        remaining: 75,
        limit: 100,
        resetAt: null,
      },
    ],
  });

  it('expires retained quotas at the exact deadline without another poll', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00Z'));
    flushSolid();
    const stale = snapshot();
    const display = createRoot((cleanup) => {
      dispose = cleanup;
      return createProviderLimitDisplay(() => stale);
    });
    flushSolid();
    expect(display()).toBe(stale);
    await vi.advanceTimersByTimeAsync(PROVIDER_LIMIT_STALE_RETENTION_MS - 1);
    flushSolid();
    expect(display()).toBe(stale);
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(display()).toMatchObject({
      status: 'error',
      retryAt: stale.retryAt,
      note: expect.stringContaining('Cached quota snapshot expired'),
    });
    expect(display()).not.toHaveProperty('windows');
    expect(stale.status).toBe('available');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels expiry when refreshed or switched to another model', async () => {
    vi.useFakeTimers();
    const stale = snapshot();
    const [value, setValue] = createSignal<ProviderLimitStatus | null>(stale);
    const display = createRoot((cleanup) => {
      dispose = cleanup;
      return createProviderLimitDisplay(value);
    });
    flushSolid();
    expect(vi.getTimerCount()).toBe(1);
    const fresh = { ...stale, stale: undefined, retryAt: undefined };
    setValue(fresh);
    flushSolid();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PROVIDER_LIMIT_STALE_RETENTION_MS);
    flushSolid();
    expect(display()).toBe(fresh);
    setValue(null);
    flushSolid();
    expect(display()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops already expired data and cleans up a pending deadline on disposal', () => {
    vi.useFakeTimers();
    const stale = snapshot();
    expect(
      getProviderLimitDisplay(stale, stale.checkedAt + PROVIDER_LIMIT_STALE_RETENTION_MS)
    ).toMatchObject({ status: 'error' });
    createRoot((cleanup) => {
      dispose = cleanup;
      createProviderLimitDisplay(() => stale);
    });
    flushSolid();
    expect(vi.getTimerCount()).toBe(1);
    dispose?.();
    flushSolid();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires retained reset credits independently of fresh quota windows', async () => {
    vi.useFakeTimers();
    const fresh = {
      ...snapshot(),
      stale: undefined,
      usageLimitResets: {
        availableCount: 1,
        credits: [],
        checkedAt: Date.now() - PROVIDER_LIMIT_STALE_RETENTION_MS + 1_000,
        stale: true,
      },
    };
    const display = createRoot((cleanup) => {
      dispose = cleanup;
      return createProviderLimitDisplay(() => fresh);
    });
    flushSolid();
    expect(display()).toBe(fresh);
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(display()).toMatchObject({ status: 'available', windows: fresh.windows });
    expect(display()).not.toHaveProperty('usageLimitResets');
  });

  it('expires earlier reset credits and then the quota snapshot at separate deadlines', async () => {
    vi.useFakeTimers();
    const stale = {
      ...snapshot(),
      usageLimitResets: {
        availableCount: 1,
        credits: [],
        checkedAt: Date.now() - PROVIDER_LIMIT_STALE_RETENTION_MS + 1_000,
        stale: true,
      },
    };
    const display = createRoot((cleanup) => {
      dispose = cleanup;
      return createProviderLimitDisplay(() => stale);
    });
    flushSolid();
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(display()).toMatchObject({ status: 'available' });
    expect(display()).not.toHaveProperty('usageLimitResets');
    await vi.advanceTimersByTimeAsync(PROVIDER_LIMIT_STALE_RETENTION_MS - 1_000);
    flushSolid();
    expect(display()).toMatchObject({ status: 'error' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
