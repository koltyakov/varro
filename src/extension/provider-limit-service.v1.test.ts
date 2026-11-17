import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderLimitService } from './provider-limit-service';
import { ProviderQuotaCoordinator } from './provider-quota-coordinator';
import * as v2AuthStore from './provider-v2-auth-store';
import type { OpenCodeServer } from './server';
import {
  getOpenCodeAuthFilePath,
  type ProviderAuthRecord,
  type ProviderMetadata,
} from './util/provider-limit';

describe('ProviderLimitService with only V1 credentials', () => {
  let root: string;
  let service: ProviderLimitService;
  let now: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'varro-v1-provider-limits-'));
    vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
    vi.stubEnv('OPENCODE_DB', join(root, 'absent-v2.db'));
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(v2AuthStore, 'readOpenCodeV2AuthStore').mockRejectedValue(
      new Error('V2 is not installed')
    );
    now = Date.parse('2026-10-11T00:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await fs.mkdir(join(root, 'data', 'opencode'), { recursive: true });
  });

  afterEach(async () => {
    service?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeAuth(auth: Record<string, ProviderAuthRecord>) {
    await fs.writeFile(getOpenCodeAuthFilePath(), JSON.stringify(auth));
  }

  function createService(provider: ProviderMetadata) {
    const server = {
      apiVersion: 1 as const,
      url: 'http://127.0.0.1:4096',
      request: vi.fn(
        async (method: string, path: string, body?: Parameters<OpenCodeServer['request']>[2]) => {
          if (method === 'GET' && path === '/config/providers') return { providers: [provider] };
          if (method === 'PUT' && path === `/auth/${provider.id}`) {
            await fs.writeFile(getOpenCodeAuthFilePath(), JSON.stringify({ [provider.id]: body }));
            return true;
          }
          throw new Error(`Unexpected V1 request: ${method} ${path}`);
        }
      ),
    };
    service = new ProviderLimitService(server, new ProviderQuotaCoordinator(join(root, 'quota')));
    return server;
  }

  async function expectNoV2Store() {
    expect(v2AuthStore.readOpenCodeV2AuthStore).not.toHaveBeenCalled();
    await expect(fs.stat(process.env.OPENCODE_DB!)).rejects.toMatchObject({ code: 'ENOENT' });
  }

  it.each([
    { providerID: 'zai', credentialSource: 'direct' },
    { providerID: 'zai-coding-plan', credentialSource: 'direct' },
    { providerID: 'zai', credentialSource: 'alias' },
    { providerID: 'zai-coding-plan', credentialSource: 'alias' },
    { providerID: 'zai', credentialSource: 'oauth' },
    { providerID: 'zai-coding-plan', credentialSource: 'options' },
  ] as const)(
    'loads $providerID quotas and reset cards with V1 $credentialSource credentials',
    async ({ providerID, credentialSource }) => {
      const credentialID =
        credentialSource === 'alias'
          ? providerID === 'zai'
            ? 'zai-coding-plan'
            : 'zai'
          : providerID;
      await writeAuth(
        credentialSource === 'options'
          ? {}
          : {
              [credentialID]:
                credentialSource === 'oauth'
                  ? { type: 'oauth', access: 'v1-zai-token' }
                  : { type: 'api', key: 'v1-zai-token' },
            }
      );
      createService({
        id: providerID,
        models: { 'glm-4.5': {} },
        options: credentialSource === 'options' ? { apiKey: 'v1-zai-token' } : undefined,
      });
      vi.mocked(fetch)
        .mockResolvedValueOnce(zaiQuotaResponse(now))
        .mockResolvedValueOnce(
          Response.json({
            code: 200,
            success: true,
            data: {
              weekResets: [
                { available: true, expireTime: '2026-11-01T00:00:00Z' },
                { available: false, expireTime: '2026-11-02T00:00:00Z' },
              ],
              fiveHourResets: [{ available: true, expireTime: '2026-10-20T00:00:00Z' }],
            },
          })
        );

      const status = await service.get(providerID, 'glm-4.5', '/v1-workspace');
      expect(status).toMatchObject({
        providerID,
        modelID: 'glm-4.5',
        status: 'available',
        source: 'provider',
        windows: [
          { id: 'five_hour', remaining: 87, limit: 100, percent: 13, resetAt: now + 3600_000 },
          { id: 'weekly', remaining: 98, limit: 100, percent: 2, resetAt: now + 86400_000 },
          { id: 'mcp', remaining: 900, limit: 1000, percent: 10, resetAt: now + 86400_000 },
        ],
        usageLimitResets: {
          availableCount: 2,
          credits: [
            { title: '5-hour quota reset', expiresAt: Date.parse('2026-10-20T00:00:00Z') },
            { title: 'Weekly quota reset', expiresAt: Date.parse('2026-11-01T00:00:00Z') },
          ],
        },
      });
      const requestOptions = expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'v1-zai-token' }),
      });
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        'https://api.z.ai/api/monitor/usage/quota/limit',
        requestOptions
      );
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        'https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL',
        requestOptions
      );
      expect(await service.get(providerID, 'glm-4.5', '/v1-workspace')).toEqual(status);
      expect(fetch).toHaveBeenCalledTimes(2);

      // Once cards are used, the next quota refresh must not keep cached reset credits.
      now += 30_000;
      vi.mocked(fetch)
        .mockResolvedValueOnce(zaiQuotaResponse(now))
        .mockResolvedValueOnce(
          Response.json({ code: 200, success: true, data: { weekResets: [], fiveHourResets: [] } })
        );
      const refreshed = await service.get(providerID, 'glm-4.5', '/v1-workspace');
      expect(refreshed).toMatchObject({ status: 'available', checkedAt: now });
      expect(refreshed).not.toHaveProperty('usageLimitResets');
      expect(fetch).toHaveBeenCalledTimes(4);
      await expectNoV2Store();
    }
  );

  describe.each(['zai', 'zai-coding-plan'])('%s V1 reset-card failures', (providerID) => {
    it('retains reset cards only on failure and clears them on a successful empty response', async () => {
      await writeAuth({ [providerID]: { type: 'api', key: 'v1-zai-token' } });
      createService({ id: providerID, models: {} });
      vi.mocked(fetch)
        .mockResolvedValueOnce(zaiQuotaResponse(now))
        .mockResolvedValueOnce(
          Response.json({
            code: 200,
            success: true,
            data: {
              weekResets: [{ available: true, expireTime: '2026-11-01T00:00:00Z' }],
              fiveHourResets: [],
            },
          })
        );
      const checkedAt = now;
      await expect(service.get(providerID, null)).resolves.toMatchObject({
        usageLimitResets: { availableCount: 1, checkedAt },
      });
      now += 30_000;
      vi.mocked(fetch)
        .mockResolvedValueOnce(zaiQuotaResponse(now))
        .mockResolvedValueOnce(new Response('', { status: 503 }));
      await expect(service.get(providerID, null)).resolves.toMatchObject({
        status: 'available',
        checkedAt: now,
        usageLimitResets: { availableCount: 1, checkedAt, stale: true },
      });
      now += 30_000;
      vi.mocked(fetch)
        .mockResolvedValueOnce(zaiQuotaResponse(now))
        .mockResolvedValueOnce(
          Response.json({ code: 200, success: true, data: { weekResets: [], fiveHourResets: [] } })
        );
      expect(await service.get(providerID, null)).not.toHaveProperty('usageLimitResets');
      await expectNoV2Store();
    });

    it.each([
      { code: 401, transport: 'HTTP' },
      { code: 403, transport: 'HTTP' },
      { code: 401, transport: 'body' },
      { code: 403, transport: 'body' },
    ])(
      'drops retained reset cards after $transport $code without dropping quotas',
      async ({ code, transport }) => {
        await writeAuth({ [providerID]: { type: 'api', key: 'v1-zai-token' } });
        createService({ id: providerID, models: {} });
        vi.mocked(fetch)
          .mockResolvedValueOnce(zaiQuotaResponse(now))
          .mockResolvedValueOnce(
            Response.json({
              code: 200,
              data: {
                weekResets: [{ available: true, expireTime: '2026-11-01T00:00:00Z' }],
                fiveHourResets: [],
              },
            })
          );
        await expect(service.get(providerID, null)).resolves.toMatchObject({
          usageLimitResets: { availableCount: 1 },
        });

        now += 30_000;
        vi.mocked(fetch)
          .mockResolvedValueOnce(zaiQuotaResponse(now))
          .mockResolvedValueOnce(
            transport === 'HTTP'
              ? new Response('', { status: code })
              : Response.json({ code, success: false })
          );
        const denied = await service.get(providerID, null);
        expect(denied).toMatchObject({
          status: 'available',
          checkedAt: now,
          windows: expect.arrayContaining([expect.objectContaining({ id: 'five_hour' })]),
        });
        expect(denied).not.toHaveProperty('usageLimitResets');

        now += 30_000;
        vi.mocked(fetch)
          .mockResolvedValueOnce(zaiQuotaResponse(now))
          .mockResolvedValueOnce(new Response('', { status: 503 }));
        const unavailable = await service.get(providerID, null);
        expect(unavailable).toMatchObject({ usageLimitResetsUnavailable: true });
        expect(unavailable).not.toHaveProperty('usageLimitResets');
      }
    );

    it.each(['unavailable', 'api-error'] as const)(
      'keeps quota windows when reset cards are %s',
      async (failure) => {
        await writeAuth({ [providerID]: { type: 'api', key: 'v1-zai-token' } });
        createService({ id: providerID, models: {} });
        vi.mocked(fetch)
          .mockResolvedValueOnce(zaiQuotaResponse(now))
          .mockResolvedValueOnce(
            failure === 'unavailable'
              ? new Response('', { status: 503 })
              : Response.json({ code: 401, success: false })
          );
        const status = await service.get(providerID, null);
        expect(status).toMatchObject({
          status: 'available',
          windows: [{ id: 'five_hour' }, { id: 'weekly' }, { id: 'mcp' }],
        });
        expect(status).not.toHaveProperty('usageLimitResets');
        await expectNoV2Store();
      }
    );
  });

  it.each(['available', 'unavailable', 'none'] as const)(
    'loads Codex limits and %s reset credits from V1 auth.json',
    async (resetDetails) => {
      await writeAuth({
        openai: { type: 'oauth', access: 'v1-codex-token', accountId: 'v1-account' },
      });
      createService({ id: 'openai', models: { 'gpt-5.4': {} } });
      const availableCount = resetDetails === 'none' ? 0 : 2;
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          Response.json({
            plan_type: 'pro',
            rate_limit: {
              primary_window: { used_percent: 25, reset_at: now / 1000 + 3600 },
              secondary_window: { used_percent: 40, reset_at: now / 1000 + 86400 },
            },
            credits: { balance: 12 },
            rate_limit_reset_credits: { available_count: availableCount },
          })
        )
        .mockResolvedValueOnce(
          resetDetails === 'unavailable'
            ? new Response('', { status: 503 })
            : Response.json({
                available_count: 2,
                credits: [
                  { status: 'available', title: 'Full reset', expires_at: '2026-11-01T00:00:00Z' },
                  { status: 'available', title: 'Full reset', expires_at: null },
                  { status: 'redeemed', title: 'Used reset', expires_at: null },
                ],
              })
        );

      const status = await service.get('openai', 'gpt-5.4', '/v1-workspace');
      expect(status).toMatchObject({
        providerID: 'openai',
        modelID: 'gpt-5.4',
        status: 'available',
        planName: 'Pro 20x',
        creditBalance: 12,
        windows: [
          { id: 'five_hour', remaining: 75, resetAt: now + 3600_000 },
          { id: 'seven_day', remaining: 60, resetAt: now + 86400_000 },
        ],
      });
      if (resetDetails === 'none') {
        expect(status).not.toHaveProperty('usageLimitResets');
      } else {
        expect(status).toHaveProperty('usageLimitResets', {
          availableCount: 2,
          credits:
            resetDetails === 'available'
              ? [
                  { title: 'Full reset', expiresAt: Date.parse('2026-11-01T00:00:00Z') },
                  { title: 'Full reset', expiresAt: null },
                ]
              : null,
        });
      }
      const requestOptions = expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer v1-codex-token',
          'ChatGPT-Account-Id': 'v1-account',
        }),
      });
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        'https://chatgpt.com/backend-api/wham/usage',
        requestOptions
      );
      if (availableCount > 0) {
        expect(fetch).toHaveBeenNthCalledWith(
          2,
          'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
          requestOptions
        );
      }
      // Shared and local caches must retain reset counts and expiration details.
      expect(await service.get('openai', 'gpt-5.4', '/v1-workspace')).toEqual(status);
      if (process.platform !== 'win32') {
        expect(await service.get('openai', 'another-model', '/v1-workspace')).toEqual({
          ...status,
          modelID: 'another-model',
        });
      }
      expect(fetch).toHaveBeenCalledTimes(availableCount > 0 ? 2 : 1);
      await expectNoV2Store();
    }
  );

  it("rechecks V1 credential rotation without reusing another account's resets", async () => {
    await writeAuth({
      openai: { type: 'oauth', access: 'first-token', accountId: 'first-account' },
    });
    createService({ id: 'openai', models: {} });
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          rate_limit: { primary_window: { used_percent: 25 } },
          rate_limit_reset_credits: { available_count: 2 },
        })
      )
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          rate_limit: { primary_window: { used_percent: 60 } },
          rate_limit_reset_credits: { available_count: 0 },
        })
      );
    expect(await service.get('openai', null)).toMatchObject({
      usageLimitResets: { availableCount: 2, credits: null },
    });
    await writeAuth({
      openai: { type: 'oauth', access: 'second-token', accountId: 'second-account' },
    });
    now += 30_000;
    const status = await service.get('openai', null);
    expect(status).toMatchObject({ status: 'available', windows: [{ remaining: 40 }] });
    expect(status).not.toHaveProperty('usageLimitResets');
    expect(fetch).toHaveBeenLastCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer second-token',
          'ChatGPT-Account-Id': 'second-account',
        }),
      })
    );
    await expectNoV2Store();
  });

  it('refreshes SuperGrok V1 auth and loads available reset tokens with the refreshed token', async () => {
    await writeAuth({
      xai: { type: 'oauth', access: 'expired-token', refresh: 'v1-refresh', expires: now - 1 },
    });
    const server = createService({ id: 'xai', models: { grok: {} } });
    const expiresAt = now + 86400_000;
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'fresh-token',
          refresh_token: 'fresh-refresh',
          expires_in: 3600,
        })
      )
      .mockResolvedValueOnce(Response.json({ config: { creditUsagePercent: 11 } }))
      .mockResolvedValueOnce(new Response(resetTokenResponse(expiresAt)));

    expect(await service.get('xai', 'grok')).toMatchObject({
      status: 'available',
      windows: [{ id: 'credits', remaining: 89 }],
      usageLimitResets: {
        availableCount: 1,
        credits: [{ title: 'Weekly quota reset', expiresAt }],
      },
    });
    expect(server.request).toHaveBeenCalledWith(
      'PUT',
      '/auth/xai',
      { type: 'oauth', access: 'fresh-token', refresh: 'fresh-refresh', expires: now + 3600_000 },
      expect.any(Object)
    );
    expect(fetch).toHaveBeenLastCalledWith(
      'https://grok.com/grok_api_v2.GrokBuildBilling/GetRemainingResets',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fresh-token' }),
      })
    );
    expect(JSON.parse(await fs.readFile(getOpenCodeAuthFilePath(), 'utf-8'))).toMatchObject({
      xai: { access: 'fresh-token', refresh: 'fresh-refresh' },
    });
    await expectNoV2Store();
  });
});

function zaiQuotaResponse(checkedAt: number): Response {
  return Response.json({
    code: 200,
    success: true,
    data: {
      limits: [
        {
          type: 'TOKENS_LIMIT',
          unit: 3,
          number: 5,
          percentage: 13,
          nextResetTime: checkedAt + 3600_000,
        },
        {
          type: 'CREDIT_LIMIT',
          unit: 6,
          number: 7,
          percentage: 2,
          nextResetTime: checkedAt + 86400_000,
        },
        {
          type: 'TIME_LIMIT',
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 100,
          remaining: 900,
          percentage: 10,
          nextResetTime: checkedAt + 86400_000,
          usageDetails: [{ modelCode: 'search-prime', usage: 100 }],
        },
      ],
    },
  });
}

function resetTokenResponse(expiresAt: number): Uint8Array<ArrayBuffer> {
  // GetRemainingResets protobuf: repeated token, ID field 1, validity timestamp field 3.
  const seconds: number[] = [];
  let remaining = expiresAt / 1000;
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    seconds.push(byte | (remaining > 0 ? 0x80 : 0));
  } while (remaining > 0);
  const timestamp = [0x08, ...seconds];
  const token = [0x0a, 1, 0x61, 0x1a, timestamp.length, ...timestamp];
  const payload = [0x0a, token.length, ...token];
  const trailers = new TextEncoder().encode('grpc-status: 0\r\n');
  const frame = new Uint8Array(5 + payload.length + 5 + trailers.length);
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  const trailerOffset = 5 + payload.length;
  frame[trailerOffset] = 0x80;
  new DataView(frame.buffer).setUint32(trailerOffset + 1, trailers.length);
  frame.set(trailers, trailerOffset + 5);
  return frame;
}
