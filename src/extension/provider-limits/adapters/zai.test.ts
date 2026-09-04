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

    expect(
      adapter.matches(
        {
          ...provider,
          options: { apiKey: 'opencode-oauth-dummy-key' },
        },
        {
          'zai-coding-plan': { type: 'oauth', access: 'oauth-token' },
        }
      )
    ).toBe(true);
  });

  it('returns unsupported without usable Z.ai credentials', async () => {
    const status = await adapter.fetch({
      provider: {
        ...provider,
        options: { apiKey: 'opencode-oauth-dummy-key' },
      },
      authStore: {},
      modelID: 'glm-4.5',
      checkedAt: 1_000,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(status).toEqual({
      providerID: 'zai',
      modelID: 'glm-4.5',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'No Z.ai credentials available',
    });
  });

  it('parses bounded windows from the Z.ai quota endpoint', async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      expect(init?.headers).toMatchObject({
        Accept: 'application/json',
        Authorization: 'zai_test_key_12345',
        'User-Agent': 'Varro/0.1.0',
      });

      if (String(input).includes('/customer-package-reset/list')) {
        return new Response(
          JSON.stringify({
            code: 200,
            msg: 'Operation successful',
            success: true,
            data: {
              fiveHourResets: [
                {
                  recordId: 10,
                  expireTime: '2026-09-12T12:00:00Z',
                  available: true,
                },
              ],
              weekResets: [
                {
                  recordId: 20,
                  expireTime: '2026-09-20T12:00:00Z',
                  available: true,
                },
                {
                  recordId: 21,
                  expireTime: '2026-09-27T12:00:00Z',
                  available: false,
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

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
                currentValue: 0,
                remaining: 1000,
                percentage: 0,
                nextResetTime: 1778754725995,
                usageDetails: [
                  {
                    modelCode: 'search-prime',
                    usage: 0,
                  },
                  {
                    modelCode: 'web-reader',
                    usage: 0,
                  },
                  {
                    modelCode: 'zread',
                    usage: 0,
                  },
                ],
              },
              {
                type: 'TOKENS_LIMIT',
                unit: 3,
                number: 5,
                percentage: 13,
                nextResetTime: 1770398385482,
              },
              {
                type: 'CREDIT_LIMIT',
                unit: 6,
                number: 7,
                percentage: 2,
                nextResetTime: 1771000000000,
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
      usageLimitResets: {
        availableCount: 2,
        credits: [
          {
            title: '5-hour quota reset',
            expiresAt: Date.parse('2026-09-12T12:00:00Z'),
          },
          {
            title: 'Weekly quota reset',
            expiresAt: Date.parse('2026-09-20T12:00:00Z'),
          },
        ],
      },
      windows: [
        {
          id: 'mcp',
          label: 'MCP Quota',
          unit: 'unknown',
          remaining: 1000,
          limit: 1000,
          resetAt: 1778754725995,
          percent: 0,
        },
        {
          id: 'five_hour',
          label: '5 Hours Quota',
          unit: 'unknown',
          remaining: 87,
          limit: 100,
          resetAt: 1770398385482,
          percent: 13,
        },
        {
          id: 'weekly',
          label: 'Weekly Quota',
          unit: 'unknown',
          remaining: 98,
          limit: 100,
          resetAt: 1771000000000,
          percent: 2,
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

  it('treats HTTP auth failures as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 403 }));

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
      note: 'Z.ai quota endpoint rejected credentials (403)',
    });
  });

  it('reports non-auth API failures and invalid payloads as errors', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 500,
            msg: 'quota temporarily unavailable',
            success: false,
            data: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(new Response('{}', { status: 429 }));

    await expect(
      adapter.fetch({
        provider,
        authStore: { zai: { type: 'api', key: 'zai_test_key_12345' } },
        modelID: null,
        checkedAt: 1_000,
      })
    ).resolves.toEqual({
      providerID: 'zai',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Z.ai quota endpoint returned an API error 500 (quota temporarily unavailable)',
    });

    await expect(
      adapter.fetch({
        provider,
        authStore: { zai: { type: 'api', key: 'zai_test_key_12345' } },
        modelID: 'glm-4.5',
        checkedAt: 2_000,
      })
    ).resolves.toEqual({
      providerID: 'zai',
      modelID: 'glm-4.5',
      status: 'error',
      source: 'provider',
      checkedAt: 2_000,
      note: 'Z.ai quota endpoint returned an invalid response',
    });

    await expect(
      adapter.fetch({
        provider,
        authStore: { zai: { type: 'api', key: 'zai_test_key_12345' } },
        modelID: null,
        checkedAt: 3_000,
      })
    ).resolves.toEqual({
      providerID: 'zai',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 3_000,
      note: 'Z.ai quota endpoint returned 429',
    });
  });

  it('reuses aliased auth and normalizes custom bounded windows', async () => {
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'oauth-token',
      });

      return new Response(
        JSON.stringify({
          code: 200,
          msg: 'OK',
          success: true,
          data: {
            limits: [
              null,
              {
                type: 'REQUESTS_LIMIT',
                remaining: '1,500',
                currentValue: '250',
                percentage: 150,
                nextResetTime: '90',
              },
              {
                type: 'REQUESTS_LIMIT',
                remaining: 10,
                currentValue: 1,
              },
              {
                type: 'NEGATIVE_LIMIT',
                remaining: '2',
                currentValue: -5,
                percentage: -5,
              },
              {
                type: 'TOKENS_LIMIT',
                unit: 9,
                number: 1,
                percentage: 10,
              },
              {
                type: 'TOKENS_LIMIT',
                unit: 9,
                number: 2,
                percentage: 20,
              },
              {
                type: '   ',
                remaining: 50,
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const status = await adapter.fetch({
      provider: {
        ...provider,
        options: { apiKey: 'opencode-oauth-dummy-key' },
      },
      authStore: {
        'zai-coding-plan': { type: 'oauth', access: 'oauth-token' },
      },
      modelID: 'glm-4.5',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'zai',
      modelID: 'glm-4.5',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Z.ai quota endpoint',
      windows: [
        {
          id: 'requests',
          label: 'Requests Limit',
          unit: 'unknown',
          remaining: 1500,
          limit: 1750,
          resetAt: 91_000,
          percent: 100,
        },
        {
          id: 'negative',
          label: 'Negative Limit',
          unit: 'unknown',
          remaining: 2,
          limit: null,
          resetAt: null,
          percent: 0,
        },
        {
          id: 'tokens_9_1',
          label: 'Tokens Quota',
          unit: 'unknown',
          remaining: 90,
          limit: 100,
          resetAt: null,
          percent: 10,
        },
        {
          id: 'tokens_9_2',
          label: 'Tokens Quota',
          unit: 'unknown',
          remaining: 80,
          limit: 100,
          resetAt: null,
          percent: 20,
        },
      ],
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
