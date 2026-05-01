import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderMetadata } from '../../util/provider-limit';
import { createZaiAdapter } from './zai';

const adapter = createZaiAdapter();

const provider: ProviderMetadata = {
  id: 'zai',
  options: { apiKey: 'zai_test_key_12345' },
  models: {},
};

describe('createZaiAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches Z.ai provider aliases when auth is available', () => {
    expect(
      adapter.matches(provider, {
        zai: { type: 'api', key: 'zai_test_key_12345' },
      })
    ).toBe(true);

    expect(
      adapter.matches(
        {
          ...provider,
          id: 'zai-coding-plan',
        },
        {
          'zai-coding-plan': { type: 'api', key: 'zai_test_key_12345' },
        }
      )
    ).toBe(true);
  });

  it('parses bounded windows from the Z.ai quota endpoint', async () => {
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        Accept: 'application/json',
        Authorization: 'zai_test_key_12345',
        'User-Agent': 'Varro/0.1.0',
      });

      return new Response(
        JSON.stringify({
          code: 200,
          msg: 'Operation successful',
          success: true,
          data: {
            limits: [
              {
                type: 'TIME_LIMIT',
                unit: 5,
                number: 1,
                usage: 1000,
                currentValue: 19,
                remaining: 981,
                percentage: 1,
              },
              {
                type: 'TOKENS_LIMIT',
                unit: 3,
                number: 5,
                usage: 200000000,
                currentValue: 200112618,
                remaining: 0,
                percentage: 100,
                nextResetTime: 1770398385482,
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const status = await adapter.fetch({
      provider,
      authStore: { zai: { type: 'api', key: 'zai_test_key_12345' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'zai',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Z.ai quota endpoint',
      windows: [
        {
          id: 'time',
          label: 'Time',
          unit: 'unknown',
          remaining: 981,
          limit: 1000,
          resetAt: null,
          percent: 1,
        },
        {
          id: 'tokens',
          label: 'Tokens',
          unit: 'tokens',
          remaining: 0,
          limit: 200000000,
          resetAt: 1770398385482,
          percent: 100,
        },
      ],
    });
  });

  it('treats body-level auth failures as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 401,
          msg: 'Unauthorized',
          success: false,
          data: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { zai: { type: 'api', key: 'zai_test_key_12345' } },
      modelID: 'glm-4.5',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'zai',
      modelID: 'glm-4.5',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Z.ai quota endpoint rejected credentials (401)',
    });
  });

  it('reports unsupported when the endpoint does not expose any windows', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 200,
          msg: 'OK',
          success: true,
          data: { limits: [] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { zai: { type: 'api', key: 'zai_test_key_12345' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'zai',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Z.ai quota endpoint did not expose any bounded quotas',
    });
  });
});
