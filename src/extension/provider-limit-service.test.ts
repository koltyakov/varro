import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromisesModule from 'fs/promises';
import type * as ProviderLimitConfigModule from './provider-limit-config';
import type * as ProviderLimitsModule from './provider-limits';
import type * as ProviderLimitModule from './util/provider-limit';
import type { ProviderLimitStatus } from '../shared/protocol';

const mocks = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  extractOpenCodeConsoleLimitMock: vi.fn(),
  extractOpenCodeProviderLimitMock: vi.fn(),
  fetchProviderLimitFromAdapterMock: vi.fn(),
  getOpenCodeAuthFilePathMock: vi.fn(() => '/tmp/opencode/auth.json'),
  parseProviderAuthStoreMock: vi.fn(() => ({})),
  readProviderLimitConfigMock: vi.fn(() => ({
    enabledAdapters: new Set(['github-copilot', 'openrouter', 'zai', 'minimax', 'openai']),
    pollIntervalSeconds: 120,
  })),
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

vi.mock('./provider-limit-config', async () => {
  const actual = await vi.importActual<typeof ProviderLimitConfigModule>('./provider-limit-config');
  return {
    ...actual,
    readProviderLimitConfig: mocks.readProviderLimitConfigMock,
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

  it('passes enabled adapter settings to adapter resolution', async () => {
    const server = createServer();
    const service = new ProviderLimitService(server);
    const enabledAdapters = new Set(['openai']);
    mocks.readProviderLimitConfigMock.mockReturnValue({
      enabledAdapters,
      pollIntervalSeconds: 45,
    });

    await service.get('openai', 'gpt-5.4');

    expect(mocks.fetchProviderLimitFromAdapterMock).toHaveBeenCalledWith(
      {
        provider: { id: 'openai', models: { 'gpt-5.4': {} } },
        authStore: {},
        modelID: 'gpt-5.4',
        checkedAt: Date.now(),
      },
      { enabledAdapterIDs: enabledAdapters }
    );
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
});
