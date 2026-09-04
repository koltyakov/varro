import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderMetadata } from '../../util/provider-limit';
import { createOpenCodeClaudeAdapter } from './opencode-claude';

const adapter = createOpenCodeClaudeAdapter();
const provider = createProvider('http://127.0.0.1:43127/provider-limit', 'local-secret');

function createProvider(url: string, token: string): ProviderMetadata {
  return {
    id: 'claude-code',
    models: {},
    options: {
      'claude-code': {
        providerLimits: {
          schemaVersion: 1,
          transport: 'http',
          url,
          token,
        },
      },
    },
  };
}

function availableResponse() {
  return {
    schemaVersion: 1,
    providerLimit: {
      providerID: 'claude-code',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      windows: [
        {
          id: 'five_hour',
          label: '5 hour',
          unit: 'messages',
          remaining: 42,
          limit: 100,
          resetAt: 2_000,
          percent: 58,
        },
      ],
      planName: 'Max',
      note: 'Claude Code account usage',
      usageLimitResets: {
        availableCount: 1,
        credits: [{ title: 'Extra usage', expiresAt: 3_000 }],
      },
    },
  };
}

describe('createOpenCodeClaudeAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches only the exact provider with a safe versioned loopback descriptor', () => {
    expect(adapter.matches(provider, {})).toBe(true);
    expect(adapter.matches(createProvider('http://[::1]:43127/provider-limit', 'secret'), {})).toBe(
      true
    );
    expect(adapter.capabilities).toEqual({ localIpc: true });

    for (const url of [
      'https://127.0.0.1:43127/provider-limit',
      'http://localhost:43127/provider-limit',
      'http://127.0.0.2:43127/provider-limit',
      'http://127.1:43127/provider-limit',
      'http://2130706433:43127/provider-limit',
      'http://token@127.0.0.1:43127/provider-limit',
      'not-a-url',
    ]) {
      expect(adapter.matches(createProvider(url, 'secret'), {})).toBe(false);
    }
    expect(adapter.matches(createProvider('http://127.0.0.1/provider-limit', ''), {})).toBe(false);
    expect(adapter.matches({ ...provider, id: 'claude-code-copy' }, {})).toBe(false);
    expect(
      adapter.matches(
        {
          ...provider,
          options: {
            'claude-code': {
              providerLimits: {
                schemaVersion: 2,
                transport: 'http',
                url: 'http://127.0.0.1/provider-limit',
                token: 'secret',
              },
            },
          },
        },
        {}
      )
    ).toBe(false);
  });

  it('fetches the endpoint without redirects and normalizes account limits to the requested model', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(availableResponse()));

    const status = await adapter.fetch({
      provider,
      authStore: {},
      modelID: 'claude-sonnet-5',
      checkedAt: 5_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:43127/provider-limit',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer local-secret',
        },
        redirect: 'error',
      })
    );
    expect(status).toEqual({
      ...availableResponse().providerLimit,
      providerID: 'claude-code',
      modelID: 'claude-sonnet-5',
      checkedAt: 5_000,
    });
  });

  it('accepts a valid unavailable status and forces its provider and model identity', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        schemaVersion: 1,
        providerLimit: {
          providerID: 'claude-code',
          modelID: null,
          status: 'unsupported',
          source: 'provider',
          checkedAt: 1_000,
          note: 'Usage unavailable for this account',
        },
      })
    );

    await expect(
      adapter.fetch({ provider, authStore: {}, modelID: 'claude-opus-5', checkedAt: 5_000 })
    ).resolves.toEqual({
      providerID: 'claude-code',
      modelID: 'claude-opus-5',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 5_000,
      note: 'Usage unavailable for this account',
    });
  });

  it.each([
    ['response schema', { ...availableResponse(), schemaVersion: 2 }],
    [
      'provider identity',
      {
        ...availableResponse(),
        providerLimit: { ...availableResponse().providerLimit, providerID: 'anthropic' },
      },
    ],
    [
      'account-level model identity',
      {
        ...availableResponse(),
        providerLimit: { ...availableResponse().providerLimit, modelID: 'claude-sonnet-5' },
      },
    ],
    [
      'provider source',
      {
        ...availableResponse(),
        providerLimit: { ...availableResponse().providerLimit, source: 'opencode' },
      },
    ],
    [
      'empty windows',
      {
        ...availableResponse(),
        providerLimit: { ...availableResponse().providerLimit, windows: [] },
      },
    ],
    [
      'window percentage',
      {
        ...availableResponse(),
        providerLimit: {
          ...availableResponse().providerLimit,
          windows: [{ ...availableResponse().providerLimit.windows[0], percent: 101 }],
        },
      },
    ],
    [
      'reset credits',
      {
        ...availableResponse(),
        providerLimit: {
          ...availableResponse().providerLimit,
          usageLimitResets: { availableCount: -1, credits: null },
        },
      },
    ],
  ])('rejects an invalid %s', async (_name, payload) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(payload));

    const status = await adapter.fetch({
      provider,
      authStore: {},
      modelID: null,
      checkedAt: 5_000,
    });

    expect(status).toEqual({
      providerID: 'claude-code',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 5_000,
      note: 'Claude Code provider-limit endpoint returned an invalid response',
    });
  });

  it('returns renderable statuses for rejected credentials, unsafe configuration, and failures', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(
      adapter.fetch({ provider, authStore: {}, modelID: null, checkedAt: 5_000 })
    ).resolves.toMatchObject({
      status: 'unsupported',
      note: 'Claude Code provider-limit endpoint rejected credentials (401)',
    });

    await expect(
      adapter.fetch({
        provider: createProvider('http://localhost:43127/provider-limit', 'secret'),
        authStore: {},
        modelID: null,
        checkedAt: 5_000,
      })
    ).resolves.toMatchObject({
      status: 'unsupported',
      note: 'Claude Code provider-limit endpoint is not configured safely',
    });

    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
    await expect(
      adapter.fetch({ provider, authStore: {}, modelID: null, checkedAt: 5_000 })
    ).resolves.toMatchObject({
      status: 'error',
      note: 'Failed to poll the Claude Code provider-limit endpoint',
    });
  });
});
