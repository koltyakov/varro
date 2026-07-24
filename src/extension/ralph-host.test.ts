import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RalphConfig, RalphRun } from '../shared/ralph';
import type { RalphStatePayload } from '../shared/protocol';
import type { Persistence } from '../shared/persistence';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./logger', () => ({ logger: mocks.logger }));

import { HostRalphStore, RalphHost } from './ralph-host';

const RALPH_RUNS_KEY = 'varro.ralph.runs';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestPath(path: string): string {
  return new URL(path, 'http://localhost').pathname;
}

function requestDirectory(path: string): string | null {
  return new URL(path, 'http://localhost').searchParams.get('directory');
}

function expectScopedRequest(
  server: FakeServer,
  method: string,
  path: string,
  workspaceDirectory = '/workspace'
): void {
  expect(
    server.request.mock.calls.some(
      ([requestMethod, requestUrl]) =>
        requestMethod === method &&
        requestPath(requestUrl as string) === path &&
        requestDirectory(requestUrl as string) === workspaceDirectory
    )
  ).toBe(true);
}

function createMemoryPersistence() {
  const storage = new Map<string, unknown>();
  const persistence: Persistence = {
    get: <T>(key: string) => storage.get(key) as T | undefined,
    set: (key, value) => {
      storage.set(key, JSON.parse(JSON.stringify(value)));
    },
    remove: (key) => {
      storage.delete(key);
    },
  };
  return { persistence, storage };
}

function createConfig(overrides: Partial<RalphConfig> = {}): RalphConfig {
  return {
    managerSessionId: 'manager-1',
    workspaceDirectory: '/workspace',
    planDocPath: 'RALPH.md',
    iterations: 1,
    promptTemplate: 'Prompt',
    permissionMode: 'full',
    model: null,
    agent: null,
    createdAt: 100,
    ...overrides,
  };
}

class FakeServer extends EventEmitter {
  request = vi.fn(async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const url = new URL(path, 'http://localhost');
    const pathname = url.pathname;
    const directory = url.searchParams.get('directory') || undefined;
    if (method === 'POST' && pathname === '/session') {
      this.sessionCount += 1;
      return { id: `child-${this.sessionCount}` };
    }
    if (method === 'PATCH') return {};
    if (method === 'POST' && pathname.endsWith('/prompt_async')) {
      const sessionID = decodeURIComponent(pathname.split('/')[2] || '');
      const messageID = (body as { messageID?: unknown } | undefined)?.messageID;
      setTimeout(() => {
        this.emit('event', {
          directory,
          payload: {
            type: 'session.next.prompt.admitted',
            properties: {
              sessionID,
              ...(typeof messageID === 'string' ? { messageID } : {}),
            },
          },
        });
        this.emit('event', {
          directory,
          payload: {
            type: 'message.updated',
            properties: {
              info: {
                id: `assistant-${String(messageID)}`,
                sessionID,
                role: 'assistant',
                parentID: messageID,
                time: { created: 1, completed: 2 },
              },
            },
          },
        });
        this.emit('event', {
          directory,
          payload: { type: 'session.idle', properties: { sessionID } },
        });
      }, 0);
      return {};
    }
    if (method === 'POST' && pathname.endsWith('/abort')) return {};
    if (method === 'GET' && pathname === '/session/status') {
      return Object.fromEntries(
        Array.from({ length: this.sessionCount }, (_, index) => [
          `child-${index + 1}`,
          { type: 'busy' },
        ])
      );
    }
    if (method === 'GET' && pathname === '/session') return [];
    if (method === 'GET' && pathname.endsWith('/message')) {
      return [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'All good.\nlint: PASS\ntest: PASS' }],
        },
      ];
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });

  private sessionCount = 0;
}

function createHost(options?: {
  persistence?: Persistence;
  readFile?: (path: string) => Promise<string | null>;
  ensureServerStarted?: () => Promise<unknown>;
}) {
  const server = new FakeServer();
  const { persistence } = options?.persistence
    ? { persistence: options.persistence }
    : createMemoryPersistence();
  const broadcasts: RalphStatePayload[] = [];
  const ensureServerStarted = vi.fn(options?.ensureServerStarted ?? (async () => {}));
  const host = new RalphHost({
    server,
    contextProvider: {
      readFile: options?.readFile ?? (async () => '# Plan\n- [x] all done'),
    },
    persistence,
    ensureServerStarted,
    broadcastState: (payload) => broadcasts.push(payload),
  });
  return { host, server, persistence, broadcasts, ensureServerStarted };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('HostRalphStore', () => {
  it('persists every mutation and reloads runs from persistence', async () => {
    const { persistence, storage } = createMemoryPersistence();
    const onChange = vi.fn();
    const store = new HostRalphStore(persistence, onChange);
    const config = createConfig();

    store.startRun(config);
    store.setStatus(config.managerSessionId, 'paused');
    await store.flush();

    expect(onChange).toHaveBeenCalledTimes(2);
    const persisted = storage.get(RALPH_RUNS_KEY) as Record<string, RalphRun>;
    expect(persisted[config.managerSessionId]?.status).toBe('paused');

    const reloaded = new HostRalphStore(persistence, vi.fn());
    expect(reloaded.getRun(config.managerSessionId)?.status).toBe('paused');
  });

  it('round-trips every persisted iteration recovery phase', async () => {
    const { persistence } = createMemoryPersistence();
    const store = new HostRalphStore(persistence, vi.fn());
    const phases = ['primary', 'verification', 'repair'] as const;

    for (const [index, phase] of phases.entries()) {
      const config = createConfig({ managerSessionId: `manager-${phase}`, iterations: 3 });
      store.startRun(config);
      store.upsertIteration(config.managerSessionId, {
        index: index + 1,
        childSessionId: `child-${phase}`,
        status: 'running',
        phase,
        startedAt: 100 + index,
        endedAt: null,
        filesChanged: [],
        verification: {},
        ...(phase === 'repair' ? { repairSessionIds: ['repair-1'] } : {}),
      });
    }
    await store.flush();

    const reloaded = new HostRalphStore(persistence, vi.fn());
    expect(
      phases.map((phase) => reloaded.getRun(`manager-${phase}`)?.iterations[0]?.phase)
    ).toEqual(phases);
  });

  it('serializes delayed persistence writes and flushes the latest snapshot', async () => {
    const writes: Array<Record<string, RalphRun>> = [];
    const releases: Array<() => void> = [];
    const persistence: Persistence = {
      get: () => undefined,
      set: (_key, value) =>
        new Promise<void>((resolve) => {
          writes.push(value as Record<string, RalphRun>);
          releases.push(resolve);
        }),
      remove: () => undefined,
    };
    const store = new HostRalphStore(persistence, vi.fn());
    const config = createConfig();

    store.startRun(config);
    store.setStatus(config.managerSessionId, 'paused');

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.[config.managerSessionId]?.status).toBe('running');
    releases.shift()?.();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.[config.managerSessionId]?.status).toBe('paused');
    releases.shift()?.();
    await store.flush();
  });

  it('continues persisting after a queued write rejects', async () => {
    let persisted: Record<string, RalphRun> | undefined;
    const persistence: Persistence = {
      get: () => undefined,
      set: vi
        .fn()
        .mockRejectedValueOnce(new Error('write failed'))
        .mockImplementation((_key, value) => {
          persisted = value as Record<string, RalphRun>;
        }),
      remove: () => undefined,
    };
    const store = new HostRalphStore(persistence, vi.fn());
    const config = createConfig();

    store.startRun(config);
    store.setStatus(config.managerSessionId, 'paused');

    await expect(store.flush()).resolves.toBeUndefined();
    expect(persistence.set).toHaveBeenCalledTimes(2);
    expect(persisted?.[config.managerSessionId]?.status).toBe('paused');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist Ralph runs: write failed')
    );
  });

  it('ignores malformed persisted run containers', () => {
    const persistence: Persistence = {
      get: () => [],
      set: () => undefined,
      remove: () => undefined,
    };

    const store = new HostRalphStore(persistence, vi.fn());

    expect(store.snapshot()).toEqual({});
    expect(store.getAllRuns()).toEqual([]);
  });

  it('filters malformed runs, mismatched IDs, and unsafe persisted keys', () => {
    const config = createConfig();
    const validRun: RalphRun = {
      config,
      status: 'paused',
      currentIteration: 0,
      iterations: [],
      updatedAt: 1,
    };
    const stored = Object.create(null) as Record<string, unknown>;
    stored[config.managerSessionId] = validRun;
    stored.broken = { ...validRun, iterations: null };
    stored.mismatched = validRun;
    stored.constructor = {
      ...validRun,
      config: { ...config, managerSessionId: 'constructor' },
    };
    stored.__proto__ = {
      ...validRun,
      config: { ...config, managerSessionId: '__proto__' },
    };
    stored.toString = {
      ...validRun,
      config: { ...config, managerSessionId: 'toString' },
    };
    const persistence: Persistence = {
      get: () => stored,
      set: () => undefined,
      remove: () => undefined,
    };

    const store = new HostRalphStore(persistence, vi.fn());

    expect(store.snapshot()).toEqual({ [config.managerSessionId]: validRun });
    expect(Object.getPrototypeOf(store.snapshot())).toBe(Object.prototype);
    store.setStatus('toString', 'failed', 'iteration_error');
    expect(Object.prototype.hasOwnProperty.call(store.snapshot(), 'toString')).toBe(false);
  });

  it('normalizes a legacy workspacePath into the persisted workspace identity', async () => {
    const { workspaceDirectory: _workspaceDirectory, ...legacyConfig } = createConfig();
    const { persistence, storage } = createMemoryPersistence();
    await persistence.set(RALPH_RUNS_KEY, {
      'manager-1': {
        config: { ...legacyConfig, workspacePath: '/workspace-a/' },
        status: 'paused',
        currentIteration: 0,
        iterations: [],
        updatedAt: 1,
      },
    });

    const store = new HostRalphStore(persistence, vi.fn());
    await store.flush();

    expect(store.getRun('manager-1')?.config.workspaceDirectory).toBe('/workspace-a');
    expect(
      (storage.get(RALPH_RUNS_KEY) as Record<string, RalphRun>)['manager-1']?.config
        .workspaceDirectory
    ).toBe('/workspace-a');
  });

  it('pauses a running legacy run whose workspace identity cannot be recovered', async () => {
    const { workspaceDirectory: _workspaceDirectory, ...legacyConfig } = createConfig();
    const { persistence, storage } = createMemoryPersistence();
    await persistence.set(RALPH_RUNS_KEY, {
      'manager-1': {
        config: legacyConfig,
        status: 'running',
        currentIteration: 0,
        iterations: [],
        updatedAt: 1,
      },
    });

    const store = new HostRalphStore(persistence, vi.fn());
    await store.flush();
    const run = store.getRun('manager-1');

    expect(run?.status).toBe('paused');
    expect(run?.config.workspaceDirectory).toBeNull();
    expect(run?.note).toContain('cannot be resumed safely');
    expect((storage.get(RALPH_RUNS_KEY) as Record<string, RalphRun>)['manager-1']).toEqual(run);
  });

  it('evicts the oldest terminal run at the run limit without evicting active runs', async () => {
    const { persistence } = createMemoryPersistence();
    const store = new HostRalphStore(persistence, vi.fn());
    const terminalConfig = createConfig({ managerSessionId: 'terminal-oldest' });
    store.adoptRun({
      config: terminalConfig,
      status: 'done',
      currentIteration: 0,
      iterations: [],
      updatedAt: 1,
    });
    for (let index = 0; index < 99; index += 1) {
      const config = createConfig({ managerSessionId: `active-${index}` });
      store.adoptRun({
        config,
        status: 'running',
        currentIteration: 0,
        iterations: [],
        updatedAt: index + 2,
      });
    }

    const newConfig = createConfig({ managerSessionId: 'new-run' });
    store.startRun(newConfig);
    await store.flush();

    expect(store.getAllRuns()).toHaveLength(100);
    expect(store.getRun(terminalConfig.managerSessionId)).toBeNull();
    expect(store.getRun('active-0')?.status).toBe('running');
    expect(store.getRun(newConfig.managerSessionId)?.status).toBe('running');

    const overflowConfig = createConfig({ managerSessionId: 'overflow' });
    store.startRun(overflowConfig);
    expect(store.getAllRuns()).toHaveLength(100);
    expect(store.getRun(overflowConfig.managerSessionId)).toBeNull();
  });

  it('examines persisted entries beyond the cap to preserve a later active run', () => {
    const stored: Record<string, RalphRun> = {};
    for (let index = 0; index < 100; index += 1) {
      const config = createConfig({ managerSessionId: `terminal-${index}` });
      stored[config.managerSessionId] = {
        config,
        status: 'done',
        currentIteration: 0,
        iterations: [],
        updatedAt: index + 1,
      };
    }
    const activeConfig = createConfig({ managerSessionId: 'active-late' });
    stored[activeConfig.managerSessionId] = {
      config: activeConfig,
      status: 'running',
      currentIteration: 0,
      iterations: [],
      updatedAt: 101,
    };
    const persistence: Persistence = {
      get: () => stored,
      set: () => undefined,
      remove: () => undefined,
    };

    const store = new HostRalphStore(persistence, vi.fn());

    expect(store.getAllRuns()).toHaveLength(100);
    expect(store.getRun('terminal-0')).toBeNull();
    expect(store.getRun(activeConfig.managerSessionId)?.status).toBe('running');
  });

  it('caps config growth and rejects iterations outside the persisted limit', () => {
    const { persistence } = createMemoryPersistence();
    const store = new HostRalphStore(persistence, vi.fn());
    const cappedConfig = createConfig({ iterations: 5_000 });
    store.startRun(cappedConfig);

    expect(store.getRun(cappedConfig.managerSessionId)?.config.iterations).toBe(1_000);

    store.upsertIteration(cappedConfig.managerSessionId, {
      index: 1_001,
      childSessionId: 'child-too-far',
      status: 'passed',
      startedAt: 1,
      endedAt: 2,
      filesChanged: [],
      verification: {},
    });
    expect(store.getRun(cappedConfig.managerSessionId)?.iterations).toEqual([]);

    const growingConfig = createConfig({ managerSessionId: 'growing', iterations: 998 });
    store.startRun(growingConfig);
    store.addIterations(growingConfig.managerSessionId, 5);
    expect(store.getRun(growingConfig.managerSessionId)?.config.iterations).toBe(1_000);
  });

  it('adopts legacy runs only when unknown', () => {
    const { persistence } = createMemoryPersistence();
    const store = new HostRalphStore(persistence, vi.fn());
    const config = createConfig();

    store.startRun(config);
    store.adoptRun({
      config,
      status: 'paused',
      currentIteration: 3,
      iterations: [],
      updatedAt: 1,
    });

    expect(store.getRun(config.managerSessionId)?.status).toBe('running');
  });
});

describe('RalphHost', () => {
  it('does not reattach malformed persisted running runs', () => {
    const persistence: Persistence = {
      get: () => ({
        broken: {
          config: { managerSessionId: 'broken' },
          status: 'running',
          currentIteration: 0,
          iterations: null,
          updatedAt: 1,
        },
      }),
      set: () => undefined,
      remove: () => undefined,
    };

    const { host, ensureServerStarted } = createHost({ persistence });

    expect(host.getStatePayload().runs).toEqual({});
    expect(ensureServerStarted).not.toHaveBeenCalled();
  });

  it('does not reattach a legacy running run without a workspace identity', () => {
    const config = createConfig();
    const { workspaceDirectory: _workspaceDirectory, ...legacyConfig } = config;
    const persistence: Persistence = {
      get: () => ({
        [config.managerSessionId]: {
          config: legacyConfig,
          status: 'running',
          currentIteration: 0,
          iterations: [],
          updatedAt: 1,
        },
      }),
      set: () => undefined,
      remove: () => undefined,
    };

    const { host, ensureServerStarted } = createHost({ persistence });

    expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('paused');
    expect(host.getStatePayload().runs[config.managerSessionId]?.note).toContain(
      'cannot be resumed safely'
    );
    expect(ensureServerStarted).not.toHaveBeenCalled();
  });

  it('does not start a run after a stop overtakes pending server startup', async () => {
    const serverStart = deferred<void>();
    const { host, server, broadcasts, ensureServerStarted } = createHost({
      ensureServerStarted: () => serverStart.promise,
    });
    const config = createConfig();

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() => expect(ensureServerStarted).toHaveBeenCalledTimes(1));
    host.handleMessage({
      type: 'ralph/stop',
      payload: { managerSessionId: config.managerSessionId },
    });
    serverStart.resolve();

    await vi.waitFor(() => expect(broadcasts).toHaveLength(1));
    expect(host.getStatePayload().runs[config.managerSessionId]).toBeUndefined();
    expect(server.request).not.toHaveBeenCalled();
  });

  it('aborts a child that is created after the run was cancelled', async () => {
    const { host, server } = createHost();
    const config = createConfig();
    const childCreation = deferred<{ id: string }>();
    server.request.mockImplementation(async (method: string, path: string) => {
      const pathname = requestPath(path);
      if (method === 'POST' && pathname === '/session') return childCreation.promise;
      if (method === 'POST' && pathname.endsWith('/abort')) return {};
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() => expectScopedRequest(server, 'POST', '/session'));

    host.handleMessage({
      type: 'ralph/stop',
      payload: { managerSessionId: config.managerSessionId },
    });
    childCreation.resolve({ id: 'child-late' });

    await vi.waitFor(() => expectScopedRequest(server, 'POST', '/session/child-late/abort'));
    expect(
      server.request.mock.calls.some(
        ([method, path]) =>
          method === 'POST' && requestPath(path as string).endsWith('/prompt_async')
      )
    ).toBe(false);
    expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('stopped');
  });

  it('re-aborts a child when its prompt request settles after cancellation', async () => {
    const { host, server } = createHost();
    const config = createConfig();
    const promptRequest = deferred<unknown>();
    server.request.mockImplementation(async (method: string, path: string) => {
      const pathname = requestPath(path);
      if (method === 'POST' && pathname === '/session') return { id: 'child-late-prompt' };
      if (method === 'POST' && pathname.endsWith('/prompt_async')) return promptRequest.promise;
      if (method === 'POST' && pathname.endsWith('/abort')) return {};
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const abortRequestCount = () =>
      server.request.mock.calls.filter(
        ([method, path]) => method === 'POST' && requestPath(path as string).endsWith('/abort')
      ).length;

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() =>
      expectScopedRequest(server, 'POST', '/session/child-late-prompt/prompt_async')
    );

    host.handleMessage({
      type: 'ralph/stop',
      payload: { managerSessionId: config.managerSessionId },
    });
    await vi.waitFor(() => expect(abortRequestCount()).toBe(1));
    promptRequest.resolve({});

    await vi.waitFor(() => expect(abortRequestCount()).toBe(2));
    expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('stopped');
  });

  it('does not start a run after disposal overtakes pending server startup', async () => {
    const serverStart = deferred<void>();
    const { host, server, ensureServerStarted } = createHost({
      ensureServerStarted: () => serverStart.promise,
    });

    host.handleMessage({ type: 'ralph/start', payload: { config: createConfig() } });
    await vi.waitFor(() => expect(ensureServerStarted).toHaveBeenCalledTimes(1));
    await host.dispose();
    serverStart.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.getStatePayload().runs).toEqual({});
    expect(server.request).not.toHaveBeenCalled();
  });

  it('does not reattach a persisted run after disposal overtakes server startup', async () => {
    const { persistence } = createMemoryPersistence();
    const config = createConfig();
    await persistence.set(RALPH_RUNS_KEY, {
      [config.managerSessionId]: {
        config,
        status: 'running',
        currentIteration: 0,
        iterations: [],
        updatedAt: 1,
      },
    });
    const serverStart = deferred<void>();
    const { host, server, ensureServerStarted } = createHost({
      persistence,
      ensureServerStarted: () => serverStart.promise,
    });

    await vi.waitFor(() => expect(ensureServerStarted).toHaveBeenCalledTimes(1));
    await host.dispose();
    serverStart.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('running');
    expect(host.getStatePayload().activeIds).toEqual([]);
    expect(server.request).not.toHaveBeenCalled();
  });

  it('shuts down active loops, removes listeners, and preserves running state', async () => {
    const { host, server } = createHost();
    const config = createConfig();
    server.request.mockImplementation(async (method: string, path: string) => {
      const pathname = requestPath(path);
      if (method === 'POST' && pathname === '/session') return { id: 'child-shutdown' };
      if (method === 'POST' && pathname.endsWith('/prompt_async')) return {};
      if (method === 'POST' && pathname.endsWith('/abort')) return {};
      if (method === 'GET' && pathname === '/session') return [];
      if (method === 'GET' && pathname.endsWith('/message')) return [];
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() => expect(server.listenerCount('event')).toBe(1));

    await host.dispose();

    const run = host.getStatePayload().runs[config.managerSessionId];
    expect(run?.status).toBe('running');
    expect(run?.stopReason).toBeUndefined();
    expect(run?.iterations[0]?.status).toBe('running');
    expect(host.getStatePayload().activeIds).toEqual([]);
    expect(server.listenerCount('event')).toBe(0);
    expectScopedRequest(server, 'POST', '/session/child-shutdown/abort');
  });

  it('does not hang disposal when prompt and abort requests never settle', async () => {
    const { host, server } = createHost();
    const config = createConfig();
    const never = new Promise<never>(() => {});
    server.request.mockImplementation(async (method: string, path: string) => {
      const pathname = requestPath(path);
      if (method === 'POST' && pathname === '/session') return { id: 'child-never' };
      if (method === 'POST' && pathname.endsWith('/prompt_async')) return never;
      if (method === 'POST' && pathname.endsWith('/abort')) return never;
      if (method === 'GET' && pathname === '/session/status') {
        return { 'child-never': { type: 'busy' } };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() =>
      expectScopedRequest(server, 'POST', '/session/child-never/prompt_async')
    );

    await expect(host.dispose()).resolves.toBeUndefined();
    expect(host.getStatePayload().activeIds).toEqual([]);
  });

  it('runs a loop to completion from a ralph/start message', async () => {
    const { host, server, broadcasts, ensureServerStarted } = createHost();
    const config = createConfig();

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() => {
      const run = host.getStatePayload().runs[config.managerSessionId];
      expect(run?.status).toBe('done');
    });

    expect(ensureServerStarted).toHaveBeenCalled();
    // Child session created with its permission rules in the create body.
    expectScopedRequest(server, 'POST', '/session');
    expect(
      server.request.mock.calls.find(
        ([method, path]) => method === 'POST' && requestPath(path as string) === '/session'
      )?.[2]
    ).toEqual(expect.objectContaining({ permission: expect.any(Array) }));
    const run = host.getStatePayload().runs[config.managerSessionId];
    expect(run?.iterations[0]).toEqual(
      expect.objectContaining({ status: 'passed', verification: { lint: 'pass', test: 'pass' } })
    );
    // State was broadcast along the way and the loop is no longer active.
    expect(broadcasts.length).toBeGreaterThan(0);
    expect(host.getStatePayload().activeIds).toEqual([]);
  });

  it('keeps every request and plan read bound to the originating workspace', async () => {
    const readFile = vi.fn(async () => '# Plan\n- [x] all done');
    const { host, server } = createHost({ readFile });
    const config = createConfig({ workspaceDirectory: '/workspace-a/' });

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() =>
      expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('done')
    );

    expect(host.getStatePayload().runs[config.managerSessionId]?.config.workspaceDirectory).toBe(
      '/workspace-a'
    );
    expect(readFile).toHaveBeenCalledWith('/workspace-a/RALPH.md');
    expect(server.request.mock.calls.length).toBeGreaterThan(0);
    expect(
      server.request.mock.calls.every(
        ([, path]) => requestDirectory(path as string) === '/workspace-a'
      )
    ).toBe(true);
  });

  it('unwraps global events and ignores envelopes from another workspace', async () => {
    const { host, server } = createHost();
    const config = createConfig({ workspaceDirectory: '/workspace-a' });
    let promptCount = 0;
    let completeFirstPrompt: (() => void) | null = null;
    server.request.mockImplementation(async (method: string, path: string, body?: unknown) => {
      const pathname = requestPath(path);
      if (method === 'POST' && pathname === '/session') return { id: 'child-envelope' };
      if (method === 'POST' && pathname.endsWith('/prompt_async')) {
        promptCount += 1;
        const messageID = (body as { messageID: string }).messageID;
        server.emit('event', {
          directory: '/workspace-b',
          payload: {
            type: 'session.next.prompt.admitted',
            properties: { sessionID: 'child-envelope', messageID },
          },
        });
        server.emit('event', {
          directory: '/workspace-b',
          payload: { type: 'session.idle', properties: { sessionID: 'child-envelope' } },
        });
        const emitMatchingCompletion = () => {
          server.emit('event', {
            directory: '/workspace-a',
            payload: {
              type: 'session.next.prompt.admitted',
              properties: { sessionID: 'child-envelope', messageID },
            },
          });
          server.emit('event', {
            directory: '/workspace-a',
            payload: {
              type: 'message.updated',
              properties: {
                info: {
                  id: `assistant-${messageID}`,
                  sessionID: 'child-envelope',
                  role: 'assistant',
                  parentID: messageID,
                  time: { created: 1, completed: 2 },
                },
              },
            },
          });
          server.emit('event', {
            directory: '/workspace-a',
            payload: { type: 'session.idle', properties: { sessionID: 'child-envelope' } },
          });
        };
        if (promptCount === 1) completeFirstPrompt = emitMatchingCompletion;
        else setTimeout(emitMatchingCompletion, 0);
        return {};
      }
      if (method === 'GET' && pathname === '/session/status') {
        return { 'child-envelope': { type: 'idle' } };
      }
      if (method === 'GET' && pathname === '/session') return [];
      if (method === 'GET' && pathname.endsWith('/message')) {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'lint: PASS' }] }];
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() => expect(promptCount).toBe(1));
    expect(promptCount).toBe(1);
    completeFirstPrompt?.();

    await vi.waitFor(() =>
      expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('done')
    );
    expect(promptCount).toBe(2);
  });

  it('treats an omitted status as idle when the child still exists and SSE is lost', async () => {
    const { host, server } = createHost();
    const config = createConfig();
    let promptMessageID = '';
    server.request.mockImplementation(async (method: string, path: string, body?: unknown) => {
      const pathname = requestPath(path);
      if (method === 'POST' && pathname === '/session') return { id: 'child-polled' };
      if (method === 'POST' && pathname.endsWith('/prompt_async')) {
        promptMessageID = (body as { messageID: string }).messageID;
        return {};
      }
      if (method === 'GET' && pathname === '/session/status') return {};
      if (method === 'GET' && pathname === '/session') return [{ id: 'child-polled' }];
      if (method === 'GET' && pathname.endsWith('/message')) {
        return [
          {
            info: {
              role: 'assistant',
              parentID: promptMessageID,
              time: { created: 1, completed: 2 },
            },
            parts: [{ type: 'text', text: 'lint: PASS' }],
          },
        ];
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() =>
      expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('done')
    );

    expectScopedRequest(server, 'GET', '/session/status');
    expectScopedRequest(server, 'GET', '/session');
  });

  it('surfaces terminal status errors with child-session context', async () => {
    const { host, server } = createHost();
    const config = createConfig();
    server.request.mockImplementation(async (method: string, path: string) => {
      const pathname = requestPath(path);
      if (method === 'POST' && pathname === '/session') return { id: 'child-error' };
      if (method === 'POST' && pathname.endsWith('/prompt_async')) return {};
      if (method === 'GET' && pathname === '/session/status') {
        return { 'child-error': { type: 'error', message: 'provider unavailable' } };
      }
      if (method === 'POST' && pathname.endsWith('/abort')) return {};
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() =>
      expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('failed')
    );

    expect(host.getStatePayload().runs[config.managerSessionId]?.iterations[0]?.note).toContain(
      'Ralph session child-error failed while waiting for idle: provider unavailable'
    );
  });

  it('surfaces an error from the assistant for the exact prompt', async () => {
    const { host, server } = createHost();
    const config = createConfig();
    server.request.mockImplementation(async (method: string, path: string, body?: unknown) => {
      const pathname = requestPath(path);
      if (method === 'POST' && pathname === '/session') return { id: 'child-assistant-error' };
      if (method === 'POST' && pathname.endsWith('/prompt_async')) {
        const messageID = (body as { messageID: string }).messageID;
        server.emit('event', {
          directory: config.workspaceDirectory,
          payload: {
            type: 'session.next.prompt.admitted',
            properties: { sessionID: 'child-assistant-error', messageID },
          },
        });
        server.emit('event', {
          directory: config.workspaceDirectory,
          payload: {
            type: 'message.updated',
            properties: {
              info: {
                id: `assistant-${messageID}`,
                sessionID: 'child-assistant-error',
                role: 'assistant',
                parentID: messageID,
                time: { created: 1, completed: 2 },
                error: { name: 'ProviderError', data: { message: 'provider quota exhausted' } },
              },
            },
          },
        });
        return {};
      }
      if (method === 'POST' && pathname.endsWith('/abort')) return {};
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() =>
      expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('failed')
    );

    expect(host.getStatePayload().runs[config.managerSessionId]?.iterations[0]?.note).toContain(
      'assistant failed for the current prompt: provider quota exhausted'
    );
    expectScopedRequest(server, 'POST', '/session/child-assistant-error/abort');
  });

  it.each([
    {
      label: 'deleted',
      statuses: {},
      expected: 'missing from the authoritative status snapshot',
    },
    {
      label: 'unknown',
      statuses: { 'child-status': { type: 'mystery' } },
      expected: 'OpenCode returned an unknown status "mystery" for child-status',
    },
  ])('does not treat a $label child status as idle', async ({ statuses, expected }) => {
    const { host, server } = createHost();
    const config = createConfig();
    server.request.mockImplementation(async (method: string, path: string, body?: unknown) => {
      const pathname = requestPath(path);
      if (method === 'POST' && pathname === '/session') return { id: 'child-status' };
      if (method === 'POST' && pathname.endsWith('/prompt_async')) {
        const messageID = (body as { messageID: string }).messageID;
        server.emit('event', {
          directory: config.workspaceDirectory,
          payload: {
            type: 'session.next.prompt.admitted',
            properties: { sessionID: 'child-status', messageID },
          },
        });
        return {};
      }
      if (method === 'GET' && pathname === '/session/status') return statuses;
      if (method === 'GET' && pathname === '/session') return [];
      if (method === 'POST' && pathname.endsWith('/abort')) return {};
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() =>
      expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('failed')
    );

    expect(host.getStatePayload().runs[config.managerSessionId]?.iterations[0]?.note).toContain(
      expected
    );
  });

  it('adopts legacy runs from ralph/sync and broadcasts state', async () => {
    const { host, broadcasts } = createHost();
    const config = createConfig({ managerSessionId: 'manager-legacy', iterations: 3 });
    const legacyRun: RalphRun = {
      config,
      status: 'paused',
      currentIteration: 2,
      iterations: [],
      updatedAt: 1,
    };

    host.handleMessage({
      type: 'ralph/sync',
      payload: { legacyRuns: { [config.managerSessionId]: legacyRun } },
    });

    await vi.waitFor(() => {
      expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('paused');
      expect(broadcasts.at(-1)?.runs[config.managerSessionId]).toEqual(
        expect.objectContaining({ legacyMigrationAcknowledged: true })
      );
    });
  });

  it('waits for an in-flight legacy sync before disposal completes', async () => {
    const config = createConfig({ managerSessionId: 'manager-dispose-sync' });
    const write = deferred<void>();
    const persistence: Persistence = {
      get: () => undefined,
      set: vi.fn(() => write.promise),
      remove: () => undefined,
    };
    const { host, ensureServerStarted } = createHost({ persistence });

    host.handleMessage({
      type: 'ralph/sync',
      payload: {
        legacyRuns: {
          [config.managerSessionId]: {
            config,
            status: 'paused',
            currentIteration: 0,
            iterations: [],
            updatedAt: 1,
          },
        },
      },
    });
    await vi.waitFor(() => expect(persistence.set).toHaveBeenCalledTimes(1));

    let disposed = false;
    const disposePromise = host.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    write.resolve();
    await disposePromise;

    expect(persistence.set).toHaveBeenCalledTimes(2);
    expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('paused');
    expect(ensureServerStarted).not.toHaveBeenCalled();
  });

  it('does not acknowledge or retain a legacy run when persistence fails', async () => {
    const config = createConfig({ managerSessionId: 'manager-write-failure' });
    const persistence: Persistence = {
      get: () => undefined,
      set: vi.fn().mockRejectedValue(new Error('disk full')),
      remove: () => undefined,
    };
    const { host, broadcasts } = createHost({ persistence });

    host.handleMessage({
      type: 'ralph/sync',
      payload: {
        legacyRuns: {
          [config.managerSessionId]: {
            config,
            status: 'paused',
            currentIteration: 0,
            iterations: [],
            updatedAt: 1,
          },
        },
      },
    });

    await vi.waitFor(() =>
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to persist Ralph runs: disk full')
      )
    );
    expect(host.getStatePayload().runs[config.managerSessionId]).toBeUndefined();
    expect(
      broadcasts.some(
        (payload) => payload.runs[config.managerSessionId]?.legacyMigrationAcknowledged === true
      )
    ).toBe(false);
  });

  it('acknowledges only legacy runs that fit host capacity', async () => {
    const { persistence } = createMemoryPersistence();
    const existingConfig = createConfig({ managerSessionId: 'existing' });
    const stored: Record<string, RalphRun> = {
      [existingConfig.managerSessionId]: {
        config: existingConfig,
        status: 'paused',
        currentIteration: 0,
        iterations: [],
        updatedAt: 1,
      },
    };
    for (let index = 1; index < 100; index += 1) {
      const config = createConfig({ managerSessionId: `paused-${index}` });
      stored[config.managerSessionId] = {
        config,
        status: 'paused',
        currentIteration: 0,
        iterations: [],
        updatedAt: index + 1,
      };
    }
    await persistence.set(RALPH_RUNS_KEY, stored);
    const rejectedConfig = createConfig({ managerSessionId: 'capacity-rejected' });
    const { host, broadcasts } = createHost({ persistence });

    host.handleMessage({
      type: 'ralph/sync',
      payload: {
        legacyRuns: {
          [existingConfig.managerSessionId]: stored[existingConfig.managerSessionId]!,
          [rejectedConfig.managerSessionId]: {
            config: rejectedConfig,
            status: 'paused',
            currentIteration: 0,
            iterations: [],
            updatedAt: 200,
          },
        },
      },
    });

    await vi.waitFor(() =>
      expect(
        broadcasts.some(
          (payload) =>
            payload.runs[existingConfig.managerSessionId]?.legacyMigrationAcknowledged === true
        )
      ).toBe(true)
    );
    expect(host.getStatePayload().runs[rejectedConfig.managerSessionId]).toBeUndefined();
    expect(
      broadcasts.some(
        (payload) =>
          payload.runs[rejectedConfig.managerSessionId]?.legacyMigrationAcknowledged === true
      )
    ).toBe(false);
  });

  it('stops a run with manual_stop and pauses/updates model on request', async () => {
    const { host } = createHost();
    const config = createConfig({ iterations: 5 });
    // Seed a run without starting the loop.
    host.handleMessage({
      type: 'ralph/sync',
      payload: {
        legacyRuns: {
          [config.managerSessionId]: {
            config,
            status: 'paused',
            currentIteration: 0,
            iterations: [],
            updatedAt: 1,
          },
        },
      },
    });
    await vi.waitFor(() =>
      expect(host.getStatePayload().runs[config.managerSessionId]).toBeDefined()
    );

    host.handleMessage({
      type: 'ralph/update-model',
      payload: {
        managerSessionId: config.managerSessionId,
        model: { providerID: 'openai', modelID: 'gpt-5' },
      },
    });
    expect(host.getStatePayload().runs[config.managerSessionId]?.config.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5',
    });

    host.handleMessage({
      type: 'ralph/stop',
      payload: { managerSessionId: config.managerSessionId },
    });
    const run = host.getStatePayload().runs[config.managerSessionId];
    expect(run?.status).toBe('stopped');
    expect(run?.stopReason).toBe('manual_stop');
  });

  it('reattaches persisted running loops on construction', async () => {
    const { persistence } = createMemoryPersistence();
    const config = createConfig();
    await persistence.set(RALPH_RUNS_KEY, {
      [config.managerSessionId]: {
        config,
        status: 'running',
        currentIteration: 0,
        iterations: [],
        updatedAt: 1,
      },
    });

    const { host, ensureServerStarted } = createHost({ persistence });

    await vi.waitFor(() => {
      expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('done');
    });
    expect(ensureServerStarted).toHaveBeenCalled();
  });

  it('settles a persisted running child instead of creating a replacement', async () => {
    const { persistence } = createMemoryPersistence();
    const config = createConfig();
    await persistence.set(RALPH_RUNS_KEY, {
      [config.managerSessionId]: {
        config,
        status: 'running',
        currentIteration: 1,
        iterations: [
          {
            index: 1,
            childSessionId: 'child-persisted',
            status: 'running',
            startedAt: 100,
            endedAt: null,
            filesChanged: [],
            verification: {},
          },
        ],
        updatedAt: 1,
      },
    });

    const { host, server } = createHost({ persistence });
    server.request.mockImplementation(async (method: string, path: string, body?: unknown) => {
      const pathname = requestPath(path);
      if (method === 'GET' && pathname === '/session/status') {
        return { 'child-persisted': { type: 'idle' } };
      }
      if (method === 'POST' && pathname.endsWith('/prompt_async')) {
        const sessionID = decodeURIComponent(pathname.split('/')[2] || '');
        const messageID = (body as { messageID: string }).messageID;
        setTimeout(() => {
          server.emit('event', {
            directory: config.workspaceDirectory,
            payload: {
              type: 'session.next.prompt.admitted',
              properties: { sessionID, messageID },
            },
          });
          server.emit('event', {
            directory: config.workspaceDirectory,
            payload: {
              type: 'message.updated',
              properties: {
                info: {
                  id: `assistant-${messageID}`,
                  sessionID,
                  role: 'assistant',
                  parentID: messageID,
                  time: { created: 1, completed: 2 },
                },
              },
            },
          });
          server.emit('event', {
            directory: config.workspaceDirectory,
            payload: { type: 'session.idle', properties: { sessionID } },
          });
        }, 0);
        return {};
      }
      if (method === 'GET' && pathname === '/session') return [];
      if (method === 'GET' && pathname.endsWith('/message')) {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'lint: PASS' }] }];
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    await vi.waitFor(() =>
      expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('done')
    );

    expectScopedRequest(server, 'GET', '/session/status');
    expect(
      server.request.mock.calls.some(
        ([method, path]) => method === 'POST' && requestPath(path as string) === '/session'
      )
    ).toBe(false);
    expect(
      host.getStatePayload().runs[config.managerSessionId]?.iterations[0]?.childSessionId
    ).toBe('child-persisted');
  });
});
