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
});
