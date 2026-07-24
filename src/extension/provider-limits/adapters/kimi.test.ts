import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderMetadata } from '../../util/provider-limit';
import { createKimiAdapter } from './kimi';

const adapter = createKimiAdapter();

const provider: ProviderMetadata = {
  id: 'kimi-for-coding',
  options: { apiKey: 'kimi_test_key_12345' },
  models: {
    'kimi-for-coding': { api: { url: 'https://api.kimi.com/coding/v1' } },
  },
};

describe('createKimiAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches only the Kimi For Coding provider when auth is available', () => {
    expect(
      adapter.matches(provider, {
        'kimi-for-coding': { type: 'api', key: 'kimi_test_key_12345' },
      })
    ).toBe(true);
    expect(adapter.matches({ ...provider, id: 'kimi' }, {})).toBe(false);
    expect(
      adapter.matches({ ...provider, options: { apiKey: 'opencode-oauth-dummy-key' } }, {})
    ).toBe(false);
  });

  it('parses the rolling 5-hour and weekly request windows', async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      expect(input).toBe('https://api.kimi.com/coding/v1/usages');
      expect(init?.headers).toMatchObject({
        Accept: 'application/json',
        Authorization: 'Bearer kimi_test_key_12345',
        'User-Agent': 'Varro/0.1.0',
      });

      return new Response(
        JSON.stringify({
          usage: {
            limit: '2048',
            used: '214',
            remaining: '1834',
            resetTime: '2026-07-31T03:12:57.965Z',
          },
          limits: [
            {
              window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
              detail: {
                limit: '200',
                used: '139',
                remaining: '61',
                resetTime: '2026-07-24T08:12:57.965Z',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const status = await adapter.fetch({
      provider,
      authStore: {
        'kimi-for-coding': { type: 'api', key: 'kimi_test_key_12345' },
      },
      modelID: 'kimi-for-coding',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'kimi-for-coding',
      modelID: 'kimi-for-coding',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Kimi For Coding usage endpoint',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'requests',
          remaining: 61,
          limit: 200,
          resetAt: Date.parse('2026-07-24T08:12:57.965Z'),
          percent: 69.5,
        },
        {
          id: 'seven_day',
          label: 'Weekly Limit',
          unit: 'requests',
          remaining: 1834,
          limit: 2048,
          resetAt: Date.parse('2026-07-31T03:12:57.965Z'),
          percent: 10.449,
        },
      ],
    });
  });

  it('derives remaining counts from used values and accepts a detailed 7-day window', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          usage: { limit: 100, used: 20, resetAt: '2026-07-30T00:00:00.000Z' },
          limits: [
            {
              window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' },
              detail: { limit: 20, used: 5, reset_at: '2026-07-24T05:00:00.000Z' },
            },
            {
              window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' },
              detail: { limit: 120, used: 30, reset_time: '2026-07-31T00:00:00.000Z' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status.status).toBe('available');
    if (status.status !== 'available') throw new Error('Expected available Kimi status');
    expect(status.windows).toEqual([
      {
        id: 'five_hour',
        label: '5-Hour Limit',
        unit: 'requests',
        remaining: 15,
        limit: 20,
        resetAt: Date.parse('2026-07-24T05:00:00.000Z'),
        percent: 25,
      },
      {
        id: 'seven_day',
        label: 'Weekly Limit',
        unit: 'requests',
        remaining: 90,
        limit: 120,
        resetAt: Date.parse('2026-07-31T00:00:00.000Z'),
        percent: 25,
      },
    ]);
  });

  it('returns unsupported without credentials or bounded quotas', async () => {
    const missingCredentials = await adapter.fetch({
      provider: { ...provider, options: { apiKey: 'opencode-oauth-dummy-key' } },
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(missingCredentials).toMatchObject({
      status: 'unsupported',
      note: 'No Kimi For Coding credentials available',
    });

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ usage: {}, limits: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const missingQuotas = await adapter.fetch({
      provider,
      authStore: {},
      modelID: null,
      checkedAt: 2_000,
    });

    expect(missingQuotas).toMatchObject({
      status: 'unsupported',
      note: 'Kimi For Coding usage endpoint did not expose any bounded quotas',
    });
  });

  it('treats rejected API keys as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 401 }));

    const status = await adapter.fetch({
      provider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toMatchObject({
      status: 'unsupported',
      note: 'Kimi For Coding usage endpoint rejected credentials (401)',
    });
  });

  it('reports HTTP, malformed response, and fetch failures as errors', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
      .mockRejectedValueOnce(new Error('network down'));

    const context = {
      provider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    };

    await expect(adapter.fetch(context)).resolves.toMatchObject({
      status: 'error',
      note: 'Kimi For Coding usage endpoint returned 429',
    });
    await expect(adapter.fetch(context)).resolves.toMatchObject({
      status: 'error',
      note: 'Kimi For Coding usage endpoint returned an invalid response',
    });
    await expect(adapter.fetch(context)).resolves.toMatchObject({
      status: 'error',
      note: 'Failed to poll the Kimi For Coding usage endpoint',
    });
  });
});
