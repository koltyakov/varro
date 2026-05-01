import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromisesModule from 'fs/promises';
import type * as ProviderLimitModule from './util/provider-limit';
import type { ProviderLimitStatus } from '../shared/protocol';

const mocks = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  buildProviderLimitProbeMock: vi.fn(),
  extractOpenCodeConsoleLimitMock: vi.fn(),
  extractOpenCodeProviderLimitMock: vi.fn(),
  getOpenCodeAuthFilePathMock: vi.fn(() => '/tmp/opencode/auth.json'),
  parseProviderAuthStoreMock: vi.fn(() => ({})),
  parseProviderLimitHeadersMock: vi.fn(() => []),
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
    buildProviderLimitProbe: mocks.buildProviderLimitProbeMock,
    extractOpenCodeConsoleLimit: mocks.extractOpenCodeConsoleLimitMock,
    extractOpenCodeProviderLimit: mocks.extractOpenCodeProviderLimitMock,
    getOpenCodeAuthFilePath: mocks.getOpenCodeAuthFilePathMock,
    parseProviderAuthStore: mocks.parseProviderAuthStoreMock,
    parseProviderLimitHeaders: mocks.parseProviderLimitHeadersMock,
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
    mocks.buildProviderLimitProbeMock.mockReturnValue(null);
    mocks.parseProviderAuthStoreMock.mockReturnValue({});
    mocks.parseProviderLimitHeadersMock.mockReturnValue([]);
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

    await expect(service.get('openai', 'gpt-5.4')).resolves.toEqual(unsupported);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.buildProviderLimitProbeMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000 - 1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.buildProviderLimitProbeMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await service.get('openai', 'gpt-5.4');
    expect(mocks.buildProviderLimitProbeMock).toHaveBeenCalledTimes(2);
  });

  it('caches error statuses for fifteen seconds', async () => {
    const server = createServer();
    const service = new ProviderLimitService(server);
    const fetchMock = vi.fn().mockRejectedValue(new Error('network failed'));
    vi.stubGlobal('fetch', fetchMock);
    mocks.buildProviderLimitProbeMock.mockReturnValue({
      url: 'https://provider.example.test/models',
      headers: { Authorization: 'Bearer token' },
    });

    await expect(service.get('openai', 'gpt-5.4')).resolves.toEqual(createStatus('error'));
    await service.get('openai', 'gpt-5.4');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000 - 1);
    await service.get('openai', 'gpt-5.4');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await service.get('openai', 'gpt-5.4');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
