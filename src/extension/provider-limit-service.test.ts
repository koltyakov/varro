import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromisesModule from 'fs/promises';
import type * as ProviderLimitsModule from './provider-limits';
import type * as ProviderLimitModule from './util/provider-limit';
import type { ProviderLimitStatus } from '../shared/protocol';

const mocks = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  extractOpenCodeConsoleLimitMock: vi.fn(),
  extractOpenCodeProviderLimitMock: vi.fn(),
  fetchProviderLimitFromAdapterMock: vi.fn(),
  getOpenCodeAuthFilePathMock: vi.fn(() => '/tmp/opencode/auth.json'),
  parseProviderAuthStoreMock: vi.fn((_raw: string) => ({})),
}));

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromisesModule>('fs/promises');
  return {
    ...actual,
    readFile: mocks.readFileMock,
  };
});

vi.mock('./util/provider-limit', async () => {
  const actual = await vi.importActual<typeof ProviderLimitModule>('./util/provider-limit');
  return {
    ...actual,
    extractOpenCodeConsoleLimit: mocks.extractOpenCodeConsoleLimitMock,
    extractOpenCodeProviderLimit: mocks.extractOpenCodeProviderLimitMock,
    getOpenCodeAuthFilePath: mocks.getOpenCodeAuthFilePathMock,
    parseProviderAuthStore: mocks.parseProviderAuthStoreMock,
  };
});

vi.mock('./provider-limits', async () => {
  const actual = await vi.importActual<typeof ProviderLimitsModule>('./provider-limits');
  return {
    ...actual,
    fetchProviderLimitFromAdapter: mocks.fetchProviderLimitFromAdapterMock,
  };
});

import { ProviderLimitService } from './provider-limit-service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createServer() {
  return {
    request: vi.fn<(method: string, path: string, body?: unknown) => Promise<unknown>>(
      async (_method: string, path: string, _body?: unknown) => {
        if (path === '/config/providers') {
          return { providers: [{ id: 'openai', models: { 'gpt-5.4': {} } }] };
        }
        if (path === '/experimental/console') {
          throw new Error('console unavailable');
        }
        throw new Error(`Unexpected path: ${path}`);
      }
    ),
  };
}

function createProviderServer(providers: Array<{ id: string; models: Record<string, unknown> }>) {
  return {
    request: vi.fn<(method: string, path: string, body?: unknown) => Promise<unknown>>(
      async (_method: string, path: string, _body?: unknown) => {
        if (path === '/config/providers') {
          return { providers };
        }
        if (path === '/experimental/console') {
          throw new Error('console unavailable');
        }
        throw new Error(`Unexpected path: ${path}`);
      }
    ),
  };
}

function createStatus(status: ProviderLimitStatus['status']): ProviderLimitStatus {
  if (status === 'available') {
    return {
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status,
      source: 'opencode',
      checkedAt: 0,
      note: 'cached status',
      windows: [
        {
          id: 'requests',
          label: 'Requests',
          unit: 'requests',
          remaining: 5,
          limit: 10,
          resetAt: null,
        },
      ],
    };
  }

  return {
    providerID: 'openai',
    modelID: 'gpt-5.4',
    status,
    source: 'provider',
    checkedAt: Date.now(),
    note:
      status === 'unsupported'
        ? 'No zero-cost provider quota endpoint is known for this provider'
        : 'Failed to poll the provider metadata endpoint',
  };
}

describe('ProviderLimitService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T00:00:00.000Z'));
    mocks.readFileMock.mockResolvedValue('{}');
    mocks.extractOpenCodeProviderLimitMock.mockReturnValue(null);
    mocks.extractOpenCodeConsoleLimitMock.mockReturnValue(null);
    mocks.fetchProviderLimitFromAdapterMock.mockResolvedValue(null);
    mocks.parseProviderAuthStoreMock.mockReturnValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('deduplicates in-flight requests per provider/model key', async () => {
    const server = createServer();
    const configRequest = deferred<{
      providers: Array<{ id: string; models: Record<string, unknown> }>;
    }>();
    server.request.mockImplementation(async (_method: string, path: string, _body?: unknown) => {
      if (path === '/config/providers') return configRequest.promise;
      throw new Error(`Unexpected path: ${path}`);
    });
    const service = new ProviderLimitService(server);
    const available = createStatus('available');
    mocks.extractOpenCodeProviderLimitMock.mockReturnValue(available);

    const first = service.get('openai', 'gpt-5.4');
    const second = service.get('openai', 'gpt-5.4');

    expect(first).toBe(second);
    expect(server.request).toHaveBeenCalledTimes(1);

    configRequest.resolve({ providers: [{ id: 'openai', models: { 'gpt-5.4': {} } }] });

    await expect(first).resolves.toEqual(available);
    expect(mocks.extractOpenCodeProviderLimitMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates metadata snapshots without letting an older failure clear the replacement', async () => {
    const firstConfig = deferred<unknown>();
    let configRequests = 0;
    const server = {
      request: vi.fn(async (_method: string, path: string) => {
        if (path === '/config/providers') {
          configRequests += 1;
          if (configRequests === 1) return firstConfig.promise;
          return { providers: [{ id: 'new-provider', models: {} }] };
        }
        if (path === '/experimental/console') throw new Error('console unavailable');
        throw new Error(`Unexpected path: ${path}`);
      }),
    };
    const service = new ProviderLimitService(server);

    const stale = service.get('old-provider', null);
    service.clearCache();
    await expect(service.get('new-provider', null)).resolves.not.toMatchObject({
      note: 'Provider not found in OpenCode config',
    });

    firstConfig.reject(new Error('stale metadata request failed'));
    await expect(stale).resolves.toMatchObject({
      status: 'error',
      note: 'Failed to load provider metadata: stale metadata request failed',
    });

    await service.get('new-provider', 'another-model');
    expect(configRequests).toBe(2);
  });

  it('invalidates an in-flight auth snapshot and retains the newer replacement', async () => {
    const firstAuth = deferred<string>();
    const secondAuth = deferred<string>();
    mocks.readFileMock.mockReset();
    mocks.readFileMock
      .mockReturnValueOnce(firstAuth.promise)
      .mockReturnValueOnce(secondAuth.promise);
    mocks.parseProviderAuthStoreMock.mockImplementation((raw: string) => ({
      anthropic: { type: 'oauth', access: raw },
    }));
    const server = createProviderServer([{ id: 'anthropic', models: {} }]);
    const service = new ProviderLimitService(server);

    const stale = service.get('anthropic', null);
    await vi.waitFor(() => expect(mocks.readFileMock).toHaveBeenCalledTimes(1));
    service.clearCache();
    const fresh = service.get('anthropic', null);
    await vi.waitFor(() => expect(mocks.readFileMock).toHaveBeenCalledTimes(2));

    secondAuth.resolve('new-token');
    await fresh;
    firstAuth.resolve('old-token');
    await stale;

    await service.get('anthropic', 'another-model');
    expect(mocks.readFileMock).toHaveBeenCalledTimes(2);
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authStore: { anthropic: { type: 'oauth', access: 'new-token' } },
      })
    );
  });

  it('does not restore an auth-failure cache entry from a stale load', async () => {
    const staleAdapter = deferred<ProviderLimitStatus | null>();
    mocks.parseProviderAuthStoreMock.mockReturnValue({
      anthropic: { type: 'oauth', access: 'same-token' },
    });
    mocks.fetchProviderLimitFromAdapterMock
      .mockReturnValueOnce(staleAdapter.promise)
      .mockResolvedValue(null);
    const service = new ProviderLimitService(
      createProviderServer([{ id: 'anthropic', models: {} }])
    );

    const stale = service.get('anthropic', 'model-1');
    await vi.waitFor(() =>
      expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(1)
    );
    service.clearCache();
    await service.get('anthropic', 'model-1');

    staleAdapter.resolve({
      providerID: 'anthropic',
      modelID: 'model-1',
      status: 'unsupported',
      source: 'provider',
      checkedAt: Date.now(),
      note: 'Anthropic usage endpoint rejected credentials (401)',
    });
    await stale;
    await service.get('anthropic', 'model-2');

    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(3);
  });

  it('caches available statuses for five minutes', async () => {
    const server = createServer();
    const service = new ProviderLimitService(server);
    const available = createStatus('available');
    mocks.extractOpenCodeProviderLimitMock.mockReturnValue(available);

    await expect(service.get('openai', 'gpt-5.4')).resolves.toEqual(available);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.extractOpenCodeProviderLimitMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.extractOpenCodeProviderLimitMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.extractOpenCodeProviderLimitMock).toHaveBeenCalledTimes(2);
  });

  it('caches unsupported statuses for one minute', async () => {
    const server = createServer();
    const service = new ProviderLimitService(server);
    const unsupported = createStatus('unsupported');
    mocks.fetchProviderLimitFromAdapterMock.mockResolvedValue(unsupported);

    await expect(service.get('openai', 'gpt-5.4')).resolves.toEqual(unsupported);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000 - 1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(2);
  });

  it('caches error statuses for fifteen seconds', async () => {
    const server = createServer();
    const service = new ProviderLimitService(server);
    mocks.fetchProviderLimitFromAdapterMock.mockResolvedValue(createStatus('error'));

    await expect(service.get('openai', 'gpt-5.4')).resolves.toEqual(createStatus('error'));
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000 - 1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(2);
  });

  it('backs off rate-limited errors exponentially up to one hour', async () => {
    const server = createServer();
    const service = new ProviderLimitService(server);
    mocks.fetchProviderLimitFromAdapterMock.mockResolvedValue({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'error',
      source: 'provider',
      checkedAt: Date.now(),
      note: 'Codex usage endpoint returned 429',
    });

    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000 - 1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2 * 60_000 - 1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(3);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await service.get('openai', 'gpt-5.4');
    }

    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(9);

    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(9);

    await vi.advanceTimersByTimeAsync(1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(10);
  });

  it('resets rate-limit backoff after a non-error result', async () => {
    const server = createServer();
    const service = new ProviderLimitService(server);
    mocks.fetchProviderLimitFromAdapterMock
      .mockResolvedValueOnce({
        providerID: 'openai',
        modelID: 'gpt-5.4',
        status: 'error',
        source: 'provider',
        checkedAt: Date.now(),
        note: 'Codex usage endpoint returned 429',
      })
      .mockResolvedValueOnce(createStatus('available'))
      .mockResolvedValue({
        providerID: 'openai',
        modelID: 'gpt-5.4',
        status: 'error',
        source: 'provider',
        checkedAt: Date.now(),
        note: 'Codex usage endpoint returned 429',
      });

    await service.get('openai', 'gpt-5.4');
    await vi.advanceTimersByTimeAsync(60_000);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(60_000 - 1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(4);
  });

  it('falls back to the last successful provider snapshot on transient provider errors', async () => {
    const server = createProviderServer([{ id: 'openrouter', models: { 'qwen3-coder-30b': {} } }]);
    const service = new ProviderLimitService(server);
    mocks.fetchProviderLimitFromAdapterMock
      .mockResolvedValueOnce({
        providerID: 'openrouter',
        modelID: 'qwen3-coder-30b',
        status: 'available',
        source: 'provider',
        checkedAt: Date.now(),
        note: 'Polled OpenRouter usage endpoint',
        windows: [
          {
            id: 'monthly_spend',
            label: 'Monthly Spend',
            unit: 'usd',
            remaining: 12,
            limit: 20,
            resetAt: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        providerID: 'openrouter',
        modelID: 'qwen3-coder-30b',
        status: 'error',
        source: 'provider',
        checkedAt: Date.now(),
        note: 'OpenRouter usage endpoint returned 502',
      });

    await expect(service.get('openrouter', 'qwen3-coder-30b')).resolves.toEqual({
      providerID: 'openrouter',
      modelID: 'qwen3-coder-30b',
      status: 'available',
      source: 'provider',
      checkedAt: Date.now(),
      note: 'Polled OpenRouter usage endpoint',
      windows: [
        {
          id: 'monthly_spend',
          label: 'Monthly Spend',
          unit: 'usd',
          remaining: 12,
          limit: 20,
          resetAt: null,
        },
      ],
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(service.get('openrouter', 'qwen3-coder-30b')).resolves.toEqual({
      providerID: 'openrouter',
      modelID: 'qwen3-coder-30b',
      status: 'available',
      source: 'provider',
      checkedAt: Date.now(),
      note: 'Polled OpenRouter usage endpoint. Showing the last successful quota snapshot because the latest provider poll failed: OpenRouter usage endpoint returned 502',
      windows: [
        {
          id: 'monthly_spend',
          label: 'Monthly Spend',
          unit: 'usd',
          remaining: 12,
          limit: 20,
          resetAt: null,
        },
      ],
    });
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(2);

    await service.get('openrouter', 'qwen3-coder-30b');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15_000);
    await service.get('openrouter', 'qwen3-coder-30b');
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(3);
  });

  it('does not reuse the last successful provider snapshot for unsupported results', async () => {
    const server = createProviderServer([{ id: 'openrouter', models: { 'qwen3-coder-30b': {} } }]);
    const service = new ProviderLimitService(server);
    mocks.fetchProviderLimitFromAdapterMock
      .mockResolvedValueOnce({
        providerID: 'openrouter',
        modelID: 'qwen3-coder-30b',
        status: 'available',
        source: 'provider',
        checkedAt: Date.now(),
        note: 'Polled OpenRouter usage endpoint',
        windows: [
          {
            id: 'monthly_spend',
            label: 'Monthly Spend',
            unit: 'usd',
            remaining: 12,
            limit: 20,
            resetAt: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        providerID: 'openrouter',
        modelID: 'qwen3-coder-30b',
        status: 'unsupported',
        source: 'provider',
        checkedAt: Date.now(),
        note: 'OpenRouter usage endpoint rejected credentials (401)',
      });

    await service.get('openrouter', 'qwen3-coder-30b');

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(service.get('openrouter', 'qwen3-coder-30b')).resolves.toEqual({
      providerID: 'openrouter',
      modelID: 'qwen3-coder-30b',
      status: 'unsupported',
      source: 'provider',
      checkedAt: Date.now(),
      note: 'OpenRouter usage endpoint rejected credentials (401)',
    });
  });

  it('prefers provider adapter snapshots over OpenCode metadata when available', async () => {
    const server = createProviderServer([{ id: 'zai', models: { 'glm-4.5': {} } }]);
    const service = new ProviderLimitService(server);
    mocks.extractOpenCodeProviderLimitMock.mockReturnValue({
      providerID: 'zai',
      modelID: 'glm-4.5',
      status: 'available',
      source: 'opencode',
      checkedAt: Date.now(),
      note: 'Read from OpenCode metadata',
      windows: [
        {
          id: 'messages',
          label: 'Messages',
          unit: 'messages',
          remaining: 0,
          limit: 1000,
          resetAt: null,
        },
      ],
    });
    mocks.fetchProviderLimitFromAdapterMock.mockResolvedValue({
      providerID: 'zai',
      modelID: 'glm-4.5',
      status: 'available',
      source: 'provider',
      checkedAt: Date.now(),
      note: 'Polled Z.ai quota endpoint',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'unknown',
          remaining: 981,
          limit: 1000,
          resetAt: null,
          percent: 1,
        },
      ],
    });

    await expect(service.get('zai', 'glm-4.5')).resolves.toMatchObject({
      providerID: 'zai',
      modelID: 'glm-4.5',
      status: 'available',
      source: 'provider',
      note: 'Polled Z.ai quota endpoint',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          remaining: 981,
          limit: 1000,
        },
      ],
    });

    expect(mocks.extractOpenCodeProviderLimitMock).not.toHaveBeenCalled();
  });

  it('suppresses repeated credential rejections for the rest of the session', async () => {
    const server = createProviderServer([{ id: 'anthropic', models: {} }]);
    const service = new ProviderLimitService(server);
    mocks.parseProviderAuthStoreMock.mockReturnValue({
      anthropic: { type: 'oauth', access: 'token-1' },
    });
    mocks.fetchProviderLimitFromAdapterMock.mockResolvedValue({
      providerID: 'anthropic',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: Date.now(),
      note: 'Anthropic usage endpoint rejected credentials (401)',
    });

    await expect(service.get('anthropic', null)).resolves.toMatchObject({
      providerID: 'anthropic',
      modelID: null,
      status: 'unsupported',
      note: 'Anthropic usage endpoint rejected credentials (401)',
    });
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(service.get('anthropic', null)).resolves.toEqual({
      providerID: 'anthropic',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: Date.now(),
      note: 'Anthropic usage endpoint rejected credentials (401)',
    });
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(1);
  });

  it('retries a cached auth failure after the auth store snapshot changes', async () => {
    const server = createProviderServer([{ id: 'anthropic', models: {} }]);
    const service = new ProviderLimitService(server);
    mocks.parseProviderAuthStoreMock
      .mockReturnValueOnce({ anthropic: { type: 'oauth', access: 'token-1' } })
      .mockReturnValueOnce({ anthropic: { type: 'oauth', access: 'token-2' } });
    mocks.fetchProviderLimitFromAdapterMock
      .mockResolvedValueOnce({
        providerID: 'anthropic',
        modelID: null,
        status: 'unsupported',
        source: 'provider',
        checkedAt: Date.now(),
        note: 'Anthropic usage endpoint rejected credentials (401)',
      })
      .mockResolvedValueOnce({
        providerID: 'anthropic',
        modelID: null,
        status: 'available',
        source: 'provider',
        checkedAt: Date.now(),
        note: 'Polled Anthropic OAuth usage endpoint',
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'unknown',
            remaining: 80,
            limit: 100,
            resetAt: null,
            percent: 20,
          },
        ],
      });

    await service.get('anthropic', null);
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(service.get('anthropic', null)).resolves.toEqual({
      providerID: 'anthropic',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: Date.now(),
      note: 'Polled Anthropic OAuth usage endpoint',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'unknown',
          remaining: 80,
          limit: 100,
          resetAt: null,
          percent: 20,
        },
      ],
    });
    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledTimes(2);
  });

  it('contains adapter exceptions into an error status instead of rejecting', async () => {
    mocks.fetchProviderLimitFromAdapterMock.mockRejectedValueOnce(
      new Error('adapter blew up on a provider deploy')
    );
    const service = new ProviderLimitService(createServer());

    await expect(service.get('openai', 'gpt-5.4')).resolves.toMatchObject({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'error',
      source: 'provider',
      note: 'Provider limit adapter failed: adapter blew up on a provider deploy',
    });
  });

  it('serves the last successful snapshot when the adapter later throws', async () => {
    vi.useFakeTimers();
    try {
      const available = createStatus('available');
      mocks.fetchProviderLimitFromAdapterMock.mockResolvedValueOnce(available);
      const service = new ProviderLimitService(createServer());

      await expect(service.get('openai', 'gpt-5.4')).resolves.toMatchObject({
        status: 'available',
      });

      vi.advanceTimersByTime(6 * 60_000);
      mocks.fetchProviderLimitFromAdapterMock.mockRejectedValueOnce(new Error('boom'));
      await expect(service.get('openai', 'gpt-5.4')).resolves.toMatchObject({
        status: 'available',
        note: expect.stringContaining('Showing the last successful quota snapshot'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains provider metadata failures into an error status instead of rejecting', async () => {
    const server = {
      request: vi.fn(async () => {
        throw new Error('OpenCode server unreachable');
      }),
    };
    const service = new ProviderLimitService(server);

    await expect(service.get('openai', 'gpt-5.4')).resolves.toMatchObject({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'error',
      source: 'opencode',
      note: 'Failed to load provider metadata: OpenCode server unreachable',
    });
  });
});
