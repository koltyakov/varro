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
  it('persists every mutation and reloads runs from persistence', () => {
    const { persistence, storage } = createMemoryPersistence();
    const onChange = vi.fn();
    const store = new HostRalphStore(persistence, onChange);
    const config = createConfig();

    store.startRun(config);
    store.setStatus(config.managerSessionId, 'paused');

    expect(onChange).toHaveBeenCalledTimes(2);
    const persisted = storage.get(RALPH_RUNS_KEY) as Record<string, RalphRun>;
    expect(persisted[config.managerSessionId]?.status).toBe('paused');

    const reloaded = new HostRalphStore(persistence, vi.fn());
    expect(reloaded.getRun(config.managerSessionId)?.status).toBe('paused');
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

  it('adopts legacy runs from ralph/sync and broadcasts state', async () => {
    const { host, broadcasts } = createHost();
    const config = createConfig({ managerSessionId: 'manager-legacy' });
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

    expect(host.getStatePayload().runs[config.managerSessionId]?.status).toBe('paused');
    expect(broadcasts.at(-1)?.runs[config.managerSessionId]).toBeDefined();
  });

  it('stops a run with manual_stop and pauses/updates model on request', () => {
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
});
