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
  request = vi.fn(async (method: string, path: string, _body?: unknown): Promise<unknown> => {
    if (method === 'POST' && path === '/session') {
      this.sessionCount += 1;
      return { id: `child-${this.sessionCount}` };
    }
    if (method === 'PATCH') return {};
    if (method === 'POST' && path.endsWith('/prompt_async')) {
      const sessionID = decodeURIComponent(path.split('/')[2] || '');
      setTimeout(() => {
        this.emit('event', { type: 'session.idle', properties: { sessionID } });
      }, 0);
      return {};
    }
    if (method === 'POST' && path.endsWith('/abort')) return {};
    if (method === 'GET' && path === '/session/status') {
      return Object.fromEntries(
        Array.from({ length: this.sessionCount }, (_, index) => [
          `child-${index + 1}`,
          { type: 'busy' },
        ])
      );
    }
    if (method === 'GET' && path === '/session') return [];
    if (method === 'GET' && path.endsWith('/message')) {
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
}) {
  const server = new FakeServer();
  const { persistence } = options?.persistence
    ? { persistence: options.persistence }
    : createMemoryPersistence();
  const broadcasts: RalphStatePayload[] = [];
  const ensureServerStarted = vi.fn(async () => {});
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

  it('shuts down active loops, removes listeners, and preserves running state', async () => {
    const { host, server } = createHost();
    const config = createConfig();
    server.request.mockImplementation(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') return { id: 'child-shutdown' };
      if (method === 'POST' && path.endsWith('/prompt_async')) return {};
      if (method === 'POST' && path.endsWith('/abort')) return {};
      if (method === 'GET' && path === '/session') return [];
      if (method === 'GET' && path.endsWith('/message')) return [];
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
    expect(server.request).toHaveBeenCalledWith('POST', '/session/child-shutdown/abort', undefined);
  });

  it('does not hang disposal when prompt and abort requests never settle', async () => {
    const { host, server } = createHost();
    const config = createConfig();
    const never = new Promise<never>(() => {});
    server.request.mockImplementation(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') return { id: 'child-never' };
      if (method === 'POST' && path.endsWith('/prompt_async')) return never;
      if (method === 'POST' && path.endsWith('/abort')) return never;
      if (method === 'GET' && path === '/session/status') {
        return { 'child-never': { type: 'busy' } };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() =>
      expect(server.request).toHaveBeenCalledWith(
        'POST',
        '/session/child-never/prompt_async',
        expect.anything()
      )
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
    expect(server.request).toHaveBeenCalledWith(
      'POST',
      '/session',
      expect.objectContaining({ permission: expect.any(Array) })
    );
    const run = host.getStatePayload().runs[config.managerSessionId];
    expect(run?.iterations[0]).toEqual(
      expect.objectContaining({ status: 'passed', verification: { lint: 'pass', test: 'pass' } })
    );
    // State was broadcast along the way and the loop is no longer active.
    expect(broadcasts.length).toBeGreaterThan(0);
    expect(host.getStatePayload().activeIds).toEqual([]);
  });

  it('treats an omitted status as idle when the child still exists and SSE is lost', async () => {
    const { host, server } = createHost();
    const config = createConfig();
    server.request.mockImplementation(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') return { id: 'child-polled' };
      if (method === 'POST' && path.endsWith('/prompt_async')) return {};
      if (method === 'GET' && path === '/session/status') return {};
      if (method === 'GET' && path === '/session') return [{ id: 'child-polled' }];
      if (method === 'GET' && path.endsWith('/message')) {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'lint: PASS' }] }];
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    host.handleMessage({ type: 'ralph/start', payload: { config } });
    await vi.waitFor(() =>
      expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('done')
    );

    expect(server.request).toHaveBeenCalledWith('GET', '/session/status', undefined);
    expect(server.request).toHaveBeenCalledWith('GET', '/session', undefined);
  });

  it('surfaces terminal status errors with child-session context', async () => {
    const { host, server } = createHost();
    const config = createConfig();
    server.request.mockImplementation(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') return { id: 'child-error' };
      if (method === 'POST' && path.endsWith('/prompt_async')) return {};
      if (method === 'GET' && path === '/session/status') {
        return { 'child-error': { type: 'error', message: 'provider unavailable' } };
      }
      if (method === 'POST' && path.endsWith('/abort')) return {};
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
    server.request.mockImplementation(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') return { id: 'child-status' };
      if (method === 'POST' && path.endsWith('/prompt_async')) return {};
      if (method === 'GET' && path === '/session/status') return statuses;
      if (method === 'GET' && path === '/session') return [];
      if (method === 'POST' && path.endsWith('/abort')) return {};
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
    server.request.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/session/status') {
        return { 'child-persisted': { type: 'idle' } };
      }
      if (method === 'POST' && path.endsWith('/prompt_async')) {
        const sessionID = decodeURIComponent(path.split('/')[2] || '');
        setTimeout(() => {
          server.emit('event', { type: 'session.idle', properties: { sessionID } });
        }, 0);
        return {};
      }
      if (method === 'GET' && path === '/session') return [];
      if (method === 'GET' && path.endsWith('/message')) {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'lint: PASS' }] }];
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    await vi.waitFor(() =>
      expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('done')
    );

    expect(server.request).toHaveBeenCalledWith('GET', '/session/status', undefined);
    expect(server.request).not.toHaveBeenCalledWith('POST', '/session', expect.anything());
    expect(
      host.getStatePayload().runs[config.managerSessionId]?.iterations[0]?.childSessionId
    ).toBe('child-persisted');
  });
});
