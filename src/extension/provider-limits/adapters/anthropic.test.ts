import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
}));

const { statMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
}));

const { mkdirMock, writeFileMock, renameMock, rmMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  writeFileMock: vi.fn(),
  renameMock: vi.fn(),
  rmMock: vi.fn(),
}));

import { createAnthropicAdapter } from './anthropic';
import type { ProviderMetadata } from '../../util/provider-limit';

vi.mock('fs/promises', () => ({
  mkdir: mkdirMock,
  readFile: readFileMock,
  rename: renameMock,
  rm: rmMock,
  stat: statMock,
  writeFile: writeFileMock,
  default: {
    mkdir: mkdirMock,
    readFile: readFileMock,
    rename: renameMock,
    rm: rmMock,
    stat: statMock,
    writeFile: writeFileMock,
  },
}));

import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';

const adapter = createAnthropicAdapter();

const provider: ProviderMetadata = {
  id: 'anthropic',
  options: { apiKey: 'opencode-oauth-dummy-key' },
  models: {},
};

const localProxyProvider: ProviderMetadata = {
  id: 'anthropic',
  options: {
    apiKey: 'x',
    baseURL: 'http://127.0.0.1:3456',
  },
  models: {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createAnthropicAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(mkdir).mockReset();
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(readFile).mockReset();
    vi.mocked(rename).mockReset();
    vi.mocked(rm).mockReset();
    vi.mocked(rm).mockResolvedValue(undefined);
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

  it('merges fresh statusline windows with richer OAuth windows', async () => {
    vi.mocked(stat).mockResolvedValue({
      isFile: () => true,
      mtimeMs: Date.now(),
    } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 42.5, resets_at: 1_766_000_000 },
        },
      })
    );
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

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(status).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Read from Anthropic statusline bridge file + Polled Anthropic OAuth usage endpoint',
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
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'unknown',
          remaining: 57.5,
          limit: 100,
          resetAt: 1_766_000_000_000,
          percent: 42.5,
        },
      ],
    });
  });

  it('reads quota windows from a local Claude proxy when Anthropic uses a loopback base URL', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          buckets: [
            {
              type: 'five_hour',
              utilization: 0.42,
              resetsAt: 1_766_000_000_000,
            },
            {
              type: 'seven_day_sonnet',
              utilization: 0.15,
              resetsAt: 1_766_400_000_000,
            },
          ],
          extraUsage: {
            isEnabled: true,
            monthlyLimit: 50,
            usedCredits: 12.5,
            utilization: 0.25,
            currency: 'USD',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider: localProxyProvider,
      authStore: {},
      modelID: 'claude-sonnet-4',
      checkedAt: 1_000,
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:3456/v1/usage/quota');
    expect(init).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          'User-Agent': 'Varro/0.1.0',
        }),
      })
    );
    expect(status).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Read from local Claude proxy quota endpoint',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'unknown',
          remaining: 58,
          limit: 100,
          resetAt: 1_766_000_000_000,
          percent: 42,
        },
        {
          id: 'seven_day_sonnet',
          label: 'Weekly Sonnet',
          unit: 'unknown',
          remaining: 85,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 15,
        },
        {
          id: 'extra_usage',
          label: 'Extra Usage',
          unit: 'credits',
          remaining: 37.5,
          limit: 50,
          resetAt: null,
          percent: 25,
        },
      ],
    });
  });

  it('returns a local proxy error when a loopback Anthropic proxy has no quota data and no OAuth credentials', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 404 }));

    const status = await adapter.fetch({
      provider: localProxyProvider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'anthropic',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Local Claude proxy quota endpoint returned 404',
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

  it('does not refresh or write credentials after a 429 response', async () => {
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
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 429 }));

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
        }),
      })
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(status).toEqual({
      providerID: 'anthropic',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Anthropic usage endpoint returned 429',
    });
  });

  it('does not pair an OpenCode access token with Claude file refresh credentials', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'anthropic-file-token',
          refreshToken: 'anthropic-file-refresh-token',
        },
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 401 }));

    const status = await adapter.fetch({
      provider,
      authStore: { anthropic: { type: 'oauth', access: 'opencode-access-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readFile).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer opencode-access-token' }),
      })
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(status.status).toBe('unsupported');
  });

  it('refreshes file-backed OAuth credentials and retries after a 401 response', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        theme: 'dark',
        claudeAiOauth: {
          accessToken: 'anthropic-file-token',
          refreshToken: 'anthropic-refresh-token',
          scopes: ['openid'],
        },
      })
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'anthropic-refreshed-access-token',
            refresh_token: 'anthropic-refreshed-refresh-token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 12, is_enabled: true },
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

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.claude[\\/]\.credentials\.json\..*\.tmp$/),
      expect.stringContaining('anthropic-refreshed-access-token'),
      { encoding: 'utf-8', mode: 0o600 }
    );
    const written = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]?.[1])) as Record<
      string,
      unknown
    >;
    expect(written).toEqual({
      theme: 'dark',
      claudeAiOauth: {
        accessToken: 'anthropic-refreshed-access-token',
        refreshToken: 'anthropic-refreshed-refresh-token',
        scopes: ['openid'],
      },
    });
    expect(rm).toHaveBeenCalledWith(
      expect.stringMatching(/\.claude[\\/]\.credentials\.json\..*\.tmp$/),
      { force: true }
    );
    expect(status.status).toBe('available');
    expect(status.note).toBe('Polled Anthropic OAuth usage endpoint after refreshing OAuth token');
  });

  it('does not overwrite a refresh token rotated on disk during refresh', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'old-access',
            refreshToken: 'old-refresh',
          },
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          unrelated: true,
          claudeAiOauth: {
            accessToken: 'external-access',
            refreshToken: 'external-refresh',
          },
        })
      );
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'stale-refreshed-access',
            refresh_token: 'stale-refreshed-refresh',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ five_hour: { utilization: 10, is_enabled: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    const status = await adapter.fetch({
      provider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status.status).toBe('available');
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), { force: true });
  });

  it('serializes concurrent credential writes and keeps the first rotated token', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    let disk = JSON.stringify({
      unrelated: { keep: true },
      claudeAiOauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
      },
    });
    const tempWrites = new Map<string, string>();
    const renameRelease = deferred<void>();
    const firstRefresh = deferred<Response>();
    const secondRefresh = deferred<Response>();
    let refreshRequests = 0;
    vi.mocked(readFile).mockImplementation(async () => disk);
    vi.mocked(writeFile).mockImplementation(async (path, data) => {
      tempWrites.set(String(path), String(data));
    });
    vi.mocked(rename).mockImplementation(async (from) => {
      await renameRelease.promise;
      disk = tempWrites.get(String(from)) ?? disk;
    });
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === 'https://console.anthropic.com/v1/oauth/token') {
        refreshRequests += 1;
        return refreshRequests === 1 ? firstRefresh.promise : secondRefresh.promise;
      }
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (authorization === 'Bearer old-access') {
        return Promise.resolve(new Response('{}', { status: 401 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ five_hour: { utilization: 10, is_enabled: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    const first = adapter.fetch({ provider, authStore: {}, modelID: null, checkedAt: 1_000 });
    const second = adapter.fetch({ provider, authStore: {}, modelID: null, checkedAt: 1_000 });
    await vi.waitFor(() => expect(refreshRequests).toBe(2));

    firstRefresh.resolve(
      new Response(JSON.stringify({ access_token: 'access-a', refresh_token: 'refresh-a' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await vi.waitFor(() => expect(rename).toHaveBeenCalledOnce());
    secondRefresh.resolve(
      new Response(JSON.stringify({ access_token: 'access-b', refresh_token: 'refresh-b' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await Promise.resolve();
    expect(writeFile).toHaveBeenCalledTimes(1);

    renameRelease.resolve();
    await Promise.all([first, second]);

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(JSON.parse(disk)).toEqual({
      unrelated: { keep: true },
      claudeAiOauth: {
        accessToken: 'access-a',
        refreshToken: 'refresh-a',
      },
    });
  });

  it('removes the temporary credential file when the atomic update fails', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
        },
      })
    );
    vi.mocked(rename).mockRejectedValue(new Error('rename failed'));
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    const status = await adapter.fetch({
      provider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toMatchObject({
      status: 'error',
      note: 'Anthropic usage endpoint returned 401 and refreshed credentials could not be saved',
    });
    expect(rm).toHaveBeenCalledWith(
      expect.stringMatching(/\.claude[\\/]\.credentials\.json\..*\.tmp$/),
      { force: true }
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries against an external write and preserves its unrelated fields', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing statusline file'));
    let disk = JSON.stringify({
      claudeAiOauth: { accessToken: 'old-access', refreshToken: 'old-refresh' },
      original: true,
    });
    const tempWrites = new Map<string, string>();
    let contentWrites = 0;
    vi.mocked(readFile).mockImplementation(async () => disk);
    vi.mocked(writeFile).mockImplementation(async (path, data) => {
      tempWrites.set(String(path), String(data));
      contentWrites += 1;
      if (contentWrites === 1) {
        disk = JSON.stringify({
          claudeAiOauth: { accessToken: 'external-access', refreshToken: 'old-refresh' },
          external: { keep: true },
        });
      }
    });
    vi.mocked(rename).mockImplementation(async (from) => {
      disk = tempWrites.get(String(from)) ?? disk;
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ five_hour: { utilization: 10, is_enabled: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    const status = await adapter.fetch({
      provider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status.status).toBe('available');
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(JSON.parse(disk)).toEqual({
      claudeAiOauth: { accessToken: 'new-access', refreshToken: 'new-refresh' },
      external: { keep: true },
    });
  });

  it('recovers a stale cross-process credential lock', async () => {
    const lockError = Object.assign(new Error('lock exists'), { code: 'EEXIST' });
    vi.mocked(mkdir).mockRejectedValueOnce(lockError).mockResolvedValueOnce(undefined);
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path).endsWith('.varro.lock')) {
        return { mtimeMs: Date.now() - 60_000 } as Awaited<ReturnType<typeof stat>>;
      }
      throw new Error('missing statusline file');
    });
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'old-access', refreshToken: 'old-refresh' },
      })
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ five_hour: { utilization: 10, is_enabled: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    const status = await adapter.fetch({
      provider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status.status).toBe('available');
    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/\.credentials\.json\.varro\.lock$/), {
      recursive: true,
      force: true,
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
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
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
