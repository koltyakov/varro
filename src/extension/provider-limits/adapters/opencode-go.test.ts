import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderMetadata } from '../../util/provider-limit';
import { createOpenCodeGoAdapter } from './opencode-go';

const adapter = createOpenCodeGoAdapter();
const provider: ProviderMetadata = {
  id: 'opencode-go',
  models: {},
};

describe('createOpenCodeGoAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches OpenCode Go providers with auth-store or configured credentials', () => {
    expect(
      adapter.matches(provider, {
        'opencode-go': { type: 'api', key: 'go-api-key' },
      })
    ).toBe(true);
    expect(adapter.matches({ ...provider, options: { apiKey: 'configured-key' } }, {})).toBe(true);
    expect(adapter.matches(provider, {})).toBe(false);
    expect(
      adapter.matches({ ...provider, id: 'opencode' }, { opencode: { type: 'api', key: 'key' } })
    ).toBe(false);
  });

  it('maps Go usage percentages and reset times to quota windows', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        usage: {
          rolling: { status: 'ok', percent: 25.5, resetsAt: '2026-08-26T14:00:00.000Z' },
          weekly: { status: 'ok', percent: 40, resetsAt: '2026-08-31T00:00:00.000Z' },
          monthly: {
            status: 'rate-limited',
            percent: 100,
            resetsAt: '2026-09-01T00:00:00.000Z',
          },
        },
      })
    );

    const status = await adapter.fetch({
      provider,
      authStore: { 'opencode-go': { type: 'api', key: 'go-api-key' } },
      modelID: 'kimi-k3',
      checkedAt: 5_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://opencode.ai/zen/go/v1/usage',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer go-api-key',
          'User-Agent': 'Varro/0.1.0',
        },
      })
    );
    expect(status).toEqual({
      providerID: 'opencode-go',
      modelID: 'kimi-k3',
      status: 'available',
      source: 'provider',
      checkedAt: 5_000,
      planName: 'Go',
      note: 'Polled OpenCode Go usage endpoint',
      windows: [
        {
          id: 'five_hour',
          label: '5 hour',
          unit: 'unknown',
          remaining: 74.5,
          limit: 100,
          resetAt: Date.parse('2026-08-26T14:00:00.000Z'),
          percent: 25.5,
        },
        {
          id: 'weekly',
          label: 'Weekly',
          unit: 'unknown',
          remaining: 60,
          limit: 100,
          resetAt: Date.parse('2026-08-31T00:00:00.000Z'),
          percent: 40,
        },
        {
          id: 'monthly',
          label: 'Monthly',
          unit: 'unknown',
          remaining: 0,
          limit: 100,
          resetAt: Date.parse('2026-09-01T00:00:00.000Z'),
          percent: 100,
        },
      ],
    });
  });

  it('keeps valid windows and clamps out-of-range percentages', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        usage: {
          rolling: { percent: 150, resetsAt: '2026-08-26T14:00:00.000Z' },
          weekly: { percent: 20, resetsAt: 'not-a-date' },
        },
      })
    );

    const status = await adapter.fetch({
      provider,
      authStore: { 'opencode-go': { type: 'api', key: 'go-api-key' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toMatchObject({
      status: 'available',
      windows: [{ id: 'five_hour', remaining: 0, limit: 100, percent: 100 }],
    });
  });

  it('reports missing subscriptions as unsupported without treating them as auth failures', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: { type: 'EntitlementError' } }, { status: 403 })
    );

    const status = await adapter.fetch({
      provider,
      authStore: { 'opencode-go': { type: 'api', key: 'go-api-key' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'opencode-go',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'OpenCode Go usage endpoint requires an active Go subscription',
    });
  });

  it('reports rejected credentials as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: 'unauthorized' }, { status: 401 }));

    const status = await adapter.fetch({
      provider,
      authStore: { 'opencode-go': { type: 'api', key: 'bad-key' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toMatchObject({
      status: 'unsupported',
      note: 'OpenCode Go usage endpoint rejected credentials (401)',
    });
  });

  it('returns unsupported when the response has no valid quota windows', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ usage: { rolling: { percent: '25', resetsAt: null } } })
    );

    const status = await adapter.fetch({
      provider,
      authStore: { 'opencode-go': { type: 'api', key: 'go-api-key' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toMatchObject({
      status: 'unsupported',
      note: 'OpenCode Go usage endpoint did not expose any valid quota windows',
    });
  });

  it('returns an error status when polling fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const status = await adapter.fetch({
      provider,
      authStore: { 'opencode-go': { type: 'api', key: 'go-api-key' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'opencode-go',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Failed to poll the OpenCode Go usage endpoint',
    });
  });
});
