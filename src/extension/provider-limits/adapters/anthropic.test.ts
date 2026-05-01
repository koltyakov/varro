import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
}));

const { statMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
}));

const { writeFileMock, renameMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn(),
  renameMock: vi.fn(),
}));

import { createAnthropicAdapter } from './anthropic';
import type { ProviderMetadata } from '../../util/provider-limit';

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
  rename: renameMock,
  stat: statMock,
  writeFile: writeFileMock,
  default: {
    readFile: readFileMock,
    rename: renameMock,
    stat: statMock,
    writeFile: writeFileMock,
  },
}));

import { readFile, rename, stat, writeFile } from 'fs/promises';

const adapter = createAnthropicAdapter();

const provider: ProviderMetadata = {
  id: 'anthropic',
  options: { apiKey: 'opencode-oauth-dummy-key' },
  models: {},
};

describe('createAnthropicAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(readFile).mockReset();
    vi.mocked(rename).mockReset();
    vi.mocked(stat).mockReset();
    vi.mocked(writeFile).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches Anthropic providers so fetch can resolve file-backed OAuth', () => {
    expect(adapter.matches(provider, {})).toBe(true);
  });

  it('advertises local-file and OAuth-refresh capabilities', () => {
    expect(adapter.capabilities).toEqual({
      localFile: true,
      oauthRefresh: true,
    });
  });

  it('prefers a fresh statusline bridge file before polling the API', async () => {
    vi.mocked(stat).mockResolvedValue({
      isFile: () => true,
      mtimeMs: Date.now(),
    } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 42.5, resets_at: 1_766_000_000 },
          seven_day: { used_percentage: 15.2, resets_at: 1_766_400_000 },
        },
      })
    );

    const status = await adapter.fetch({
      provider,
      authStore: {},
      modelID: 'claude-sonnet-4',
      checkedAt: 1_000,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(status).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Read from Anthropic statusline bridge file',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'unknown',
          remaining: 57.5,
          limit: 100,
          resetAt: 1_766_000_000_000,
          percent: 42.5,
        },
        {
          id: 'seven_day',
          label: 'Weekly All-Model',
          unit: 'unknown',
          remaining: 84.8,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 15.2,
        },
      ],
    });
  });

  it('falls back to Claude credentials when OpenCode auth is absent', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'anthropic-file-token' } })
    );
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: {
            utilization: 45.2,
            resets_at: '2026-03-04T10:00:00Z',
            is_enabled: true,
          },
          seven_day: {
            utilization: 12.8,
            resets_at: '2026-03-11T10:00:00Z',
            is_enabled: true,
          },
          extra_usage: {
            utilization: 8,
            is_enabled: false,
          },
          unknown_key: {
            utilization: 99,
            is_enabled: true,
          },
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

    expect(fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer anthropic-file-token',
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1.69',
        }),
      })
    );
    expect(status).toEqual({
      providerID: 'anthropic',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Anthropic OAuth usage endpoint',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'unknown',
          remaining: 54.8,
          limit: 100,
          resetAt: Date.parse('2026-03-04T10:00:00Z'),
          percent: 45.2,
        },
        {
          id: 'seven_day',
          label: 'Weekly All-Model',
          unit: 'unknown',
          remaining: 87.2,
          limit: 100,
          resetAt: Date.parse('2026-03-11T10:00:00Z'),
          percent: 12.8,
        },
      ],
    });
  });

  it('uses direct monthly credit bounds when Anthropic exposes them', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          monthly_limit: {
            utilization: 70,
            monthly_limit: 100,
            used_credits: 70,
            resets_at: '2026-03-31T23:59:59Z',
            is_enabled: true,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { anthropic: { type: 'oauth', access: 'anthropic-auth-store-token' } },
      modelID: 'claude-sonnet-4',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Anthropic OAuth usage endpoint',
      windows: [
        {
          id: 'monthly_limit',
          label: 'Monthly Limit',
          unit: 'credits',
          remaining: 30,
          limit: 100,
          resetAt: Date.parse('2026-03-31T23:59:59Z'),
          percent: 70,
        },
      ],
    });
  });

  it('treats auth failures as unsupported', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 401 }));

    const status = await adapter.fetch({
      provider,
      authStore: { anthropic: { type: 'oauth', access: 'anthropic-auth-store-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'anthropic',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Anthropic usage endpoint rejected credentials (401)',
    });
  });

  it('refreshes file-backed OAuth credentials and retries after a 429 response', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'anthropic-file-token',
          refreshToken: 'anthropic-refresh-token',
          expiresAt: 1_900_000_000_000,
          scopes: ['openid'],
        },
      })
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'anthropic-refreshed-access-token',
            refresh_token: 'anthropic-refreshed-refresh-token',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: {
              utilization: 33,
              resets_at: '2026-03-04T10:00:00Z',
              is_enabled: true,
            },
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

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer anthropic-file-token',
        }),
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://console.anthropic.com/v1/oauth/token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'anthropic-refresh-token',
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        }),
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer anthropic-refreshed-access-token',
        }),
      })
    );
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.claude\/\.credentials\.json\.tmp$/),
      expect.stringContaining('anthropic-refreshed-access-token'),
      'utf-8'
    );
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.claude\/\.credentials\.json\.tmp$/),
      expect.stringContaining('anthropic-refreshed-refresh-token'),
      'utf-8'
    );
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/\.claude\/\.credentials\.json\.tmp$/),
      expect.stringMatching(/\.claude\/\.credentials\.json$/)
    );
    expect(status).toEqual({
      providerID: 'anthropic',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Anthropic OAuth usage endpoint after refreshing OAuth token',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'unknown',
          remaining: 67,
          limit: 100,
          resetAt: Date.parse('2026-03-04T10:00:00Z'),
          percent: 33,
        },
      ],
    });
  });

  it('treats an invalid_grant refresh response as unsupported', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'anthropic-file-token',
          refreshToken: 'anthropic-refresh-token',
        },
      })
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'refresh token expired',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const status = await adapter.fetch({
      provider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(status).toEqual({
      providerID: 'anthropic',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Anthropic OAuth refresh rejected credentials (invalid_grant)',
    });
  });

  it('falls back to the API when the statusline file is stale or invalid', async () => {
    vi.mocked(stat).mockResolvedValue({
      isFile: () => true,
      mtimeMs: Date.now() - 10 * 60_000,
    } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: {
            utilization: 45.2,
            resets_at: '2026-03-04T10:00:00Z',
            is_enabled: true,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { anthropic: { type: 'oauth', access: 'anthropic-auth-store-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(status).toEqual({
      providerID: 'anthropic',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Anthropic OAuth usage endpoint',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'unknown',
          remaining: 54.8,
          limit: 100,
          resetAt: Date.parse('2026-03-04T10:00:00Z'),
          percent: 45.2,
        },
      ],
    });
  });
});
