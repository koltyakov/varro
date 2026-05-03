import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
}));

import { createCodexAdapter } from './codex';
import type { ProviderMetadata } from '../../util/provider-limit';

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
  default: {
    readFile: readFileMock,
  },
}));

import { readFile } from 'fs/promises';

const adapter = createCodexAdapter();

const oauthProvider: ProviderMetadata = {
  id: 'openai',
  options: { apiKey: 'opencode-oauth-dummy-key' },
  models: {},
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createCodexAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(readFile).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('matches OAuth-backed OpenAI providers without shadowing API-key probes', () => {
    expect(adapter.matches({ id: 'anthropic', options: {}, models: {} }, {})).toBe(false);
    expect(adapter.matches(oauthProvider, { openai: { type: 'oauth', access: 'token-1' } })).toBe(
      true
    );
    expect(
      adapter.matches(
        {
          id: 'openai',
          options: { apiKey: 'sk-openai-api-key' },
          models: {},
        },
        { openai: { type: 'api', key: 'sk-openai-api-key' } }
      )
    ).toBe(false);
  });

  it('falls back to the secondary Codex endpoint and parses known quota windows', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        tokens: {
          access_token: 'codex-file-token',
          account_id: 'acct_123',
        },
      })
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          plan_type: 'pro',
          rate_limit: {
            primary_window: {
              used_percent: 22.5,
              reset_at: 1_766_000_000,
              limit_window_seconds: 18_000,
            },
            secondary_window: {
              used_percent: 41,
              reset_at: 1_766_400_000,
              limit_window_seconds: 604_800,
            },
          },
          code_review_rate_limit: {
            primary_window: {
              used_percent: 38,
              reset_at: 1_766_000_000,
              limit_window_seconds: 18_000,
            },
          },
        })
      );

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: {},
      modelID: 'gpt-5.4',
      checkedAt: 1_000,
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer codex-file-token',
          'ChatClaude-Account-Id': 'acct_123',
          'X-Account-Id': 'acct_123',
        }),
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://chatgpt.com/api/codex/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer codex-file-token',
        }),
      })
    );
    expect(status).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Codex OAuth usage endpoint',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'unknown',
          remaining: 77.5,
          limit: 100,
          resetAt: 1_766_000_000_000,
          percent: 22.5,
        },
        {
          id: 'seven_day',
          label: 'Weekly All-Model',
          unit: 'unknown',
          remaining: 59,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 41,
        },
        {
          id: 'code_review',
          label: 'Review Requests',
          unit: 'unknown',
          remaining: 62,
          limit: 100,
          resetAt: 1_766_000_000_000,
          percent: 38,
        },
      ],
    });
  });

  it('maps free-plan primary usage to the weekly quota', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        plan_type: 'free',
        rate_limit: {
          primary_window: {
            used_percent: 14,
            reset_at: 1_766_400_000,
            limit_window_seconds: 604_800,
          },
          secondary_window: null,
        },
        code_review_rate_limit: {
          primary_window: {
            used_percent: 0,
            reset_at: 1_766_400_000,
            limit_window_seconds: 604_800,
          },
        },
      })
    );

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: { openai: { type: 'oauth', access: 'codex-auth-store-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Codex OAuth usage endpoint',
      windows: [
        {
          id: 'seven_day',
          label: 'Weekly All-Model',
          unit: 'unknown',
          remaining: 86,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 14,
        },
        {
          id: 'code_review',
          label: 'Review Requests',
          unit: 'unknown',
          remaining: 100,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 0,
        },
      ],
    });
  });

  it('maps a single long primary window to the weekly quota', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: 22.5,
            reset_at: 1_766_400_000,
            limit_window_seconds: 604_800,
          },
          secondary_window: null,
        },
        code_review_rate_limit: {
          primary_window: {
            used_percent: 38,
            reset_at: 1_766_400_000,
            limit_window_seconds: 604_800,
          },
        },
        credits: {
          balance: 123.4,
        },
      })
    );

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: { openai: { type: 'oauth', access: 'codex-auth-store-token' } },
      modelID: 'gpt-5.4',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Codex OAuth usage endpoint',
      windows: [
        {
          id: 'seven_day',
          label: 'Weekly All-Model',
          unit: 'unknown',
          remaining: 77.5,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 22.5,
        },
        {
          id: 'code_review',
          label: 'Review Requests',
          unit: 'unknown',
          remaining: 62,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 38,
        },
      ],
    });
  });

  it('treats auth failures as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 401 }));

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: { openai: { type: 'oauth', access: 'codex-auth-store-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Codex usage endpoint rejected credentials (401)',
    });
  });

  it('returns unsupported when no Codex credentials can be resolved', async () => {
    vi.mocked(readFile).mockResolvedValue('not-json');

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(status).toEqual({
      providerID: 'openai',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'No Codex OAuth credentials available',
    });
  });

  it('falls back to CODEX_TOKEN and reports non-auth HTTP failures', async () => {
    vi.stubEnv('CODEX_TOKEN', 'codex-env-token');
    vi.mocked(readFile).mockRejectedValue(new Error('missing auth file'));
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 429 }));

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: {},
      modelID: 'gpt-5.4',
      checkedAt: 1_000,
    });

    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer codex-env-token',
        'User-Agent': 'codex-cli/1.0.0',
      },
    });
    expect(status).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Codex usage endpoint returned 429',
    });
  });

  it('reports 404-only endpoint probes as unsupported', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: { openai: { type: 'oauth', access: 'codex-auth-store-token' } },
      modelID: 'gpt-5.4',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Codex usage endpoint returned 404',
    });
  });

  it('treats payloads without usable quota windows as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: 'n/a',
          },
          secondary_window: null,
        },
      })
    );

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: { openai: { type: 'oauth', access: 'codex-auth-store-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Codex usage endpoint did not expose any known quotas',
    });
  });

  it('normalizes camelCase quota payloads and clamps usage percent', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            usedPercent: '120.5555',
            resetAt: '2025-12-01T00:00:00Z',
            limitWindowSeconds: 21_000,
          },
          secondary_window: null,
        },
        code_review_rate_limit: {
          primary_window: {
            usedPercent: '-5',
            resetAt: '3600',
          },
        },
      })
    );

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: { openai: { type: 'oauth', access: 'codex-auth-store-token' } },
      modelID: 'gpt-5.4',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Codex OAuth usage endpoint',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'unknown',
          remaining: 0,
          limit: 100,
          resetAt: Date.parse('2025-12-01T00:00:00Z'),
          percent: 100,
        },
        {
          id: 'code_review',
          label: 'Review Requests',
          unit: 'unknown',
          remaining: 100,
          limit: 100,
          resetAt: 3_601_000,
          percent: 0,
        },
      ],
    });
  });

  it('reports fetch failures as provider errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: { openai: { type: 'oauth', access: 'codex-auth-store-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Failed to poll the Codex usage endpoint',
    });
  });
});
