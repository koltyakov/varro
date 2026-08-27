import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderMetadata } from '../../util/provider-limit';
import { createXaiAdapter } from './xai';

const adapter = createXaiAdapter();
const provider: ProviderMetadata = {
  id: 'xai',
  models: { 'grok-code-fast-1': { api: { url: 'https://api.x.ai/v1' } } },
};
const oauthStore = {
  xai: { type: 'oauth' as const, access: 'supergrok-access-token' },
};

describe('createXaiAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches SuperGrok OAuth credentials but leaves API keys to the header probe', () => {
    expect(adapter.matches(provider, oauthStore)).toBe(true);
    expect(adapter.matches(provider, { xai: { type: 'api', key: 'xai-api-key' } })).toBe(false);
  });

  it('maps SuperGrok weekly and on-demand credit limits', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        config: {
          creditUsagePercent: 37.5,
          currentPeriod: { type: 'WEEKLY', end: '2026-09-01T12:00:00.000Z' },
          billingPeriodEnd: '2026-09-30T12:00:00.000Z',
          onDemandCap: { val: 50 },
          onDemandUsed: { val: 12.5 },
        },
      })
    );

    const status = await adapter.fetch({
      provider,
      authStore: oauthStore,
      modelID: 'grok-code-fast-1',
      checkedAt: 5_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer supergrok-access-token',
          'x-xai-token-auth': 'xai-grok-cli',
          'User-Agent': 'Varro/0.1.0',
        },
      })
    );
    expect(status).toEqual({
      providerID: 'xai',
      modelID: 'grok-code-fast-1',
      status: 'available',
      source: 'provider',
      checkedAt: 5_000,
      planName: 'SuperGrok',
      note: 'Polled SuperGrok billing endpoint',
      windows: [
        {
          id: 'credits',
          label: 'Weekly Credits',
          unit: 'credits',
          remaining: 62.5,
          limit: 100,
          resetAt: Date.parse('2026-09-01T12:00:00.000Z'),
          percent: 37.5,
        },
        {
          id: 'on_demand',
          label: 'On-demand Credits',
          unit: 'credits',
          remaining: 37.5,
          limit: 50,
          resetAt: Date.parse('2026-09-30T12:00:00.000Z'),
          percent: 25,
        },
      ],
    });
  });

  it('falls back to absolute monthly credit accounting', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        config: {
          currentPeriod: { type: 'WEEKLY', end: '2026-09-01T12:00:00.000Z' },
          billingPeriodEnd: '2026-09-30T12:00:00.000Z',
        },
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        config: {
          monthlyLimit: { val: 200 },
          used: { val: 50 },
          billingPeriodEnd: '2026-09-30T12:00:00.000Z',
        },
      })
    );

    const status = await adapter.fetch({
      provider,
      authStore: oauthStore,
      modelID: null,
      checkedAt: 5_000,
    });

    expect(status).toMatchObject({
      status: 'available',
      windows: [
        {
          id: 'monthly_credits',
          remaining: 150,
          limit: 200,
          percent: 25,
          resetAt: Date.parse('2026-09-30T12:00:00.000Z'),
        },
      ],
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://cli-chat-proxy.grok.com/v1/billing',
      expect.any(Object)
    );
  });

  it('falls back to the SuperGrok credits RPC when REST billing is unbounded', async () => {
    const resetAt = Date.parse('2026-09-01T12:00:00.000Z');
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          config: {
            currentPeriod: { type: 'WEEKLY', end: '2026-09-01T12:00:00.000Z' },
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({ config: { monthlyLimit: { val: 0 }, used: { val: 0 } } })
      )
      .mockResolvedValueOnce(new Response(createCreditsResponseFrame(resetAt)));

    const status = await adapter.fetch({
      provider,
      authStore: oauthStore,
      modelID: 'grok-code-fast-1',
      checkedAt: Date.parse('2026-08-26T12:00:00.000Z'),
    });

    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig',
      expect.objectContaining({ method: 'POST', body: new Uint8Array(5) })
    );
    expect(status).toMatchObject({
      status: 'available',
      windows: [
        {
          id: 'credits',
          label: 'Weekly Credits',
          remaining: 100,
          limit: 100,
          percent: 0,
          resetAt,
        },
      ],
    });
  });

  it('reports rejected or unbounded billing responses as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(
      adapter.fetch({ provider, authStore: oauthStore, modelID: null, checkedAt: 5_000 })
    ).resolves.toMatchObject({
      status: 'unsupported',
      note: 'SuperGrok billing endpoint rejected credentials (401)',
    });

    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ config: {} }))
      .mockResolvedValueOnce(Response.json({ config: {} }))
      .mockResolvedValueOnce(new Response(new Uint8Array(5)));
    await expect(
      adapter.fetch({ provider, authStore: oauthStore, modelID: null, checkedAt: 5_000 })
    ).resolves.toMatchObject({
      status: 'unsupported',
      note: 'SuperGrok billing endpoint did not expose a bounded quota',
    });
  });
});

function createCreditsResponseFrame(resetAt: number) {
  const timestamp = encodeVarint(Math.floor(resetAt / 1000));
  const reset = encodeField(1, 0, timestamp);
  const billing = encodeField(5, 2, [...encodeVarint(reset.length), ...reset]);
  const payload = encodeField(1, 2, [...encodeVarint(billing.length), ...billing]);
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}

function encodeField(field: number, wire: number, value: number[]) {
  return [...encodeVarint((field << 3) | wire), ...value];
}

function encodeVarint(value: number) {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}
