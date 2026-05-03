import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderMetadata } from '../../util/provider-limit';
import { createMiniMaxAdapter } from './minimax';

const adapter = createMiniMaxAdapter();

const provider: ProviderMetadata = {
  id: 'minimax',
  options: { apiKey: 'minimax_test_key_12345' },
  models: {},
};

describe('createMiniMaxAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches MiniMax when auth is available', () => {
    expect(
      adapter.matches(provider, {
        minimax: { type: 'api', key: 'minimax_test_key_12345' },
      })
    ).toBe(true);
  });

  it('returns unsupported without usable MiniMax credentials', async () => {
    const status = await adapter.fetch({
      provider: {
        ...provider,
        options: { apiKey: 'opencode-oauth-dummy-key' },
      },
      authStore: {},
      modelID: 'MiniMax-M2',
      checkedAt: 1_000,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(status).toEqual({
      providerID: 'minimax',
      modelID: 'MiniMax-M2',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'No MiniMax credentials available',
    });
  });

  it('parses current and weekly request windows from the remains endpoint', async () => {
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        Accept: 'application/json',
        Authorization: 'Bearer minimax_test_key_12345',
        'User-Agent': 'Varro/0.1.0',
      });

      return new Response(
        JSON.stringify({
          base_resp: { status_code: 0, status_msg: 'success' },
          model_remains: [
            {
              model_name: 'MiniMax-M2',
              start_time: 1771218000000,
              end_time: 1771236000000,
              remains_time: 60_000,
              current_interval_total_count: 15000,
              current_interval_usage_count: 14000,
              current_weekly_total_count: 50000,
              current_weekly_usage_count: 49000,
              weekly_end_time: 1771832400000,
            },
            {
              model_name: 'MiniMax-M2.5',
              start_time: 1771218000000,
              end_time: 1771236000000,
              remains_time: 60_000,
              current_interval_total_count: 15000,
              current_interval_usage_count: 14000,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const status = await adapter.fetch({
      provider,
      authStore: { minimax: { type: 'api', key: 'minimax_test_key_12345' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'minimax',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled MiniMax coding plan remains endpoint',
      windows: [
        {
          id: 'requests',
          label: 'Requests',
          unit: 'requests',
          remaining: 14000,
          limit: 15000,
          resetAt: 61_000,
          percent: 6.667,
        },
        {
          id: 'requests-weekly',
          label: 'Weekly requests',
          unit: 'requests',
          remaining: 49000,
          limit: 50000,
          resetAt: 1771832400000,
          percent: 2,
        },
      ],
    });
  });

  it('treats body-level auth failures as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 1004, status_msg: 'invalid token' },
          model_remains: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { minimax: { type: 'api', key: 'minimax_test_key_12345' } },
      modelID: 'MiniMax-M2',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'minimax',
      modelID: 'MiniMax-M2',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'MiniMax quota endpoint rejected credentials (1004)',
    });
  });

  it('reports Cloudflare blocks as transient errors', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        '<!DOCTYPE html><html><title>Attention Required!</title><body>Please enable cookies. Sorry, you have been blocked</body></html>',
        {
          status: 403,
          headers: {
            'Content-Type': 'text/html; charset=UTF-8',
            Server: 'cloudflare',
          },
        }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { minimax: { type: 'api', key: 'minimax_test_key_12345' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'minimax',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'MiniMax quota endpoint is blocked by the upstream edge',
    });
  });

  it('reports unsupported when the endpoint exposes no bounded quotas', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0, status_msg: 'success' },
          model_remains: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { minimax: { type: 'api', key: 'minimax_test_key_12345' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'minimax',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'MiniMax quota endpoint did not expose any bounded quotas',
    });
  });

  it('normalizes camelCase payload fields and falls back to absolute reset times', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          baseResp: { statusCode: '0', statusMsg: 'success' },
          modelRemains: [
            {
              currentIntervalUsageCount: null,
              currentWeeklyTotalCount: '10',
              currentWeeklyUsageCount: '-3',
              weeklyEndTime: '2026-05-04T00:00:00.000Z',
            },
            {
              currentIntervalTotalCount: '0',
              currentIntervalUsageCount: '5',
              endTime: '2026-05-03T00:00:00.000Z',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { minimax: { type: 'api', key: 'minimax_test_key_12345' } },
      modelID: 'MiniMax-M2.5',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'minimax',
      modelID: 'MiniMax-M2.5',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled MiniMax coding plan remains endpoint',
      windows: [
        {
          id: 'requests',
          label: 'Requests',
          unit: 'requests',
          remaining: 5,
          limit: null,
          resetAt: Date.parse('2026-05-03T00:00:00.000Z'),
        },
        {
          id: 'requests-weekly',
          label: 'Weekly requests',
          unit: 'requests',
          remaining: 0,
          limit: 10,
          resetAt: Date.parse('2026-05-04T00:00:00.000Z'),
          percent: 100,
        },
      ],
    });
  });

  it('treats HTTP auth failures as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 401 }));

    const status = await adapter.fetch({
      provider,
      authStore: { minimax: { type: 'api', key: 'minimax_test_key_12345' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'minimax',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'MiniMax quota endpoint rejected credentials (401)',
    });
  });

  it('reports API failures, malformed payloads, and non-ok responses as errors', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            base_resp: {
              status_code: 500,
              status_msg: 'quota temporarily unavailable',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(new Response('{invalid-json', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            base_resp: { status_code: 0, status_msg: 'success' },
            model_remains: [
              {
                current_interval_total_count: 10,
                current_interval_usage_count: 4,
                remains_time: 1_000,
              },
            ],
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        )
      );

    await expect(
      adapter.fetch({
        provider,
        authStore: { minimax: { type: 'api', key: 'minimax_test_key_12345' } },
        modelID: null,
        checkedAt: 1_000,
      })
    ).resolves.toEqual({
      providerID: 'minimax',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'MiniMax quota endpoint returned an API error 500 (quota temporarily unavailable)',
    });

    await expect(
      adapter.fetch({
        provider,
        authStore: { minimax: { type: 'api', key: 'minimax_test_key_12345' } },
        modelID: 'MiniMax-M2',
        checkedAt: 2_000,
      })
    ).resolves.toEqual({
      providerID: 'minimax',
      modelID: 'MiniMax-M2',
      status: 'error',
      source: 'provider',
      checkedAt: 2_000,
      note: 'MiniMax quota endpoint returned an invalid response',
    });

    await expect(
      adapter.fetch({
        provider,
        authStore: { minimax: { type: 'api', key: 'minimax_test_key_12345' } },
        modelID: null,
        checkedAt: 3_000,
      })
    ).resolves.toEqual({
      providerID: 'minimax',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 3_000,
      note: 'MiniMax quota endpoint returned 429',
    });
  });

  it('reports fetch failures as transient errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const status = await adapter.fetch({
      provider,
      authStore: { minimax: { type: 'api', key: 'minimax_test_key_12345' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'minimax',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Failed to poll the MiniMax quota endpoint',
    });
  });
});
