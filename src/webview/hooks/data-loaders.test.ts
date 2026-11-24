import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLimitStatus, RecycleBinEntry } from '../../shared/protocol';
import type { Agent, Command, Provider, QuestionRequest, Session, SessionStatus } from '../types';
import {
  applyModelPreferencesSnapshot,
  getModelPreferencesSnapshot,
  getPersistedSelectedModel,
  getSelectedModelForSession,
  resetDefaultAppState,
  setPersistentShowSessionPicker,
  setSelectedModel as setStateSelectedModel,
  setState,
  state,
} from '../lib/state';
import { resetSessionStatusSnapshotTracking, sessionStore } from '../lib/stores/session-store';
import { deriveUsageLimitNotice } from '../lib/usage-limit';
import { getClientMocks, provider, session } from './useOpenCode.test-support';
import {
  createDataLoaderOperations,
  createStateBoundDataLoaderOperations,
  hydrateSessionStatusesWithDependencies,
  loadAgentsWithDependencies,
  loadCommandsWithDependencies,
  loadMcpsWithDependencies,
  loadProviderAuthMethodsWithDependencies,
  loadProvidersWithDependencies,
  loadQuestionsWithDependencies,
  loadRecycleBinWithDependencies,
  loadSessionsWithDependencies,
  loadWorkspaceStatusesWithDependencies,
  refreshProviderLimitWithDependencies,
} from './data-loaders';
import { deferred } from '../test-fixtures';

const buildAgent = (name: string): Agent => ({
  name,
  mode: 'primary',
  builtIn: true,
  permission: { edit: 'ask', bash: {} },
  tools: {},
});

type DataLoaderDependencies = Parameters<typeof createDataLoaderOperations>[0];
const clientMocks = getClientMocks();

function createLoaderDeps(overrides: Partial<DataLoaderDependencies> = {}): DataLoaderDependencies {
  return {
    listMcpStatus: async () => ({}),
    listMcpDefaults: async () => ({ global: {}, project: {}, effective: {}, editable: true }),
    setMcpDefaults: vi.fn(),
    setMcpStatus: vi.fn(),
    getActiveSessionId: () => null,
    getComposerSessionId: () => null,
    getSelectedMcpsForSession: () => null,
    setSelectedMcpsForSession: vi.fn(),
    listQuestions: async () => [],
    setQuestions: vi.fn(),
    getQuestions: () => [],
    listAgents: async () => [],
    getSelectedAgent: () => null,
    getSelectedAgentForSession: () => null,
    getPersistedSelectedAgent: () => null,
    hydrateSessionSelectedAgents: vi.fn(),
    setAllAgents: vi.fn(),
    setPrimaryAgents: vi.fn(),
    setSelectedAgent: vi.fn(),
    listCommands: async () => [],
    setCommands: vi.fn(),
    listProviders: async () => ({ providers: [], default: {} }),
    setProvidersLoaded: vi.fn(),
    setProviders: vi.fn(),
    setProviderDefaults: vi.fn(),
    getSelectedModel: () => null,
    getSelectedModelForSession: () => null,
    setSelectedModel: vi.fn(),
    loadProviderLimit: async () => ({
      providerID: 'openai',
      modelID: 'gpt-5',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1,
      note: 'Unsupported',
    }),
    setProviderLimit: vi.fn(),
    listProviderAuthMethods: async () => ({}),
    setProviderAuthMethods: vi.fn(),
    listWorkspaceStatuses: async () => [],
    setWorkspaceStatuses: vi.fn(),
    finishWorkspaceCatalogReload: vi.fn(),
    listSessions: async () => [],
    applySessions: vi.fn(),
    listRecycleBin: async () => [],
    setRecycleBinEntries: vi.fn(),
    loadSessionStatuses: async () => ({}),
    setSessionStatuses: vi.fn(),
    getSessions: () => [],
    clearQueuedMessagesForSession: vi.fn(),
    updateUsageLimitState: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

function createStateBoundLoader() {
  return createStateBoundDataLoaderOperations({
    applySessions: vi.fn(),
    updateUsageLimitState: vi.fn(),
    logError: (_context, error) => {
      throw error;
    },
  });
}

describe('data loaders', () => {
  const activationError = () => new Error('503 Location plugins did not finish activating');

  it('waits and retries activation-pending startup providers beyond two attempts', async () => {
    vi.useFakeTimers();
    const onWaitingForPlugins = vi.fn();
    const deps = createLoaderDeps({
      listProviders: vi
        .fn<DataLoaderDependencies['listProviders']>()
        .mockRejectedValueOnce(activationError())
        .mockRejectedValueOnce(activationError())
        .mockResolvedValue({ providers: [], default: {} }),
      listAgents: vi.fn(async () => []),
      listCommands: vi.fn(async () => []),
    });
    const operations = createDataLoaderOperations(deps);
    const startup = operations.loadEssentialSnapshots({ onWaitingForPlugins });
    await vi.advanceTimersByTimeAsync(0);
    flushSolid();
    expect(onWaitingForPlugins).toHaveBeenLastCalledWith(true);
    expect(deps.finishWorkspaceCatalogReload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
    await expect(startup).resolves.toEqual({ state: 'loaded', failed: [] });
    flushSolid();
    expect(deps.listProviders).toHaveBeenCalledTimes(3);
    expect(deps.listAgents).toHaveBeenCalledOnce();
    expect(deps.listCommands).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.listProviders).mock.calls.every(([signal]) => signal?.aborted)).toBe(
      true
    );
    expect(onWaitingForPlugins).toHaveBeenLastCalledWith(false);
    expect(deps.finishWorkspaceCatalogReload).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the activation 503 when the startup budget expires', async () => {
    vi.useFakeTimers();
    const onWaitingForPlugins = vi.fn();
    const deps = createLoaderDeps({ listProviders: vi.fn().mockRejectedValue(activationError()) });
    const operations = createDataLoaderOperations(deps);
    const startup = operations.loadEssentialSnapshots({ onWaitingForPlugins });
    await vi.advanceTimersByTimeAsync(59_999);
    flushSolid();
    expect(onWaitingForPlugins).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    await expect(startup).resolves.toEqual({
      state: 'failed',
      failed: ['routing catalogs'],
      error: '503 Location plugins did not finish activating',
    });
    flushSolid();
    const calls = vi.mocked(deps.listProviders).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    flushSolid();
    expect(deps.listProviders).toHaveBeenCalledTimes(calls);
    expect(deps.finishWorkspaceCatalogReload).not.toHaveBeenCalled();
    expect(onWaitingForPlugins).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels timed-out startup reads and ignores their late provider results', async () => {
    vi.useFakeTimers();
    const pending = deferred<{ providers: Provider[]; default: Record<string, string> }>();
    const signals: Array<AbortSignal | undefined> = [];
    const deps = createLoaderDeps({
      listProviders: vi
        .fn<DataLoaderDependencies['listProviders']>()
        .mockRejectedValueOnce(activationError())
        .mockImplementation((signal) => {
          signals.push(signal);
          return pending.promise;
        }),
    });
    const operations = createDataLoaderOperations(deps);
    const startup = operations.loadEssentialSnapshots();
    await vi.advanceTimersByTimeAsync(60_000);
    flushSolid();
    await expect(startup).resolves.toMatchObject({
      state: 'failed',
      error: '503 Location plugins did not finish activating',
    });
    flushSolid();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    pending.resolve({ providers: [provider('late', {})], default: {} });
    flushSolid();
    await vi.advanceTimersByTimeAsync(0);
    flushSolid();
    expect(deps.setProviders).not.toHaveBeenCalled();
    expect(deps.finishWorkspaceCatalogReload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    '503 Service unavailable',
    '401 Authentication failed',
    '403 Location plugins did not finish activating',
    'listener changed',
  ])('does not extend startup retries for other failures: %s', async (message) => {
    const onWaitingForPlugins = vi.fn();
    const deps = createLoaderDeps({ listProviders: vi.fn().mockRejectedValue(new Error(message)) });
    const operations = createDataLoaderOperations(deps);
    await expect(operations.loadEssentialSnapshots({ onWaitingForPlugins })).resolves.toEqual({
      state: 'failed',
      failed: ['routing catalogs'],
    });
    flushSolid();
    expect(deps.listProviders).toHaveBeenCalledTimes(2);
    expect(onWaitingForPlugins).not.toHaveBeenCalledWith(true);
  });

  it('stops activation retries when the workspace changes without affecting the next startup', async () => {
    vi.useFakeTimers();
    const onWaitingForPlugins = vi.fn();
    const deps = createLoaderDeps({
      listProviders: vi
        .fn<DataLoaderDependencies['listProviders']>()
        .mockRejectedValueOnce(activationError())
        .mockResolvedValue({ providers: [], default: {} }),
    });
    const operations = createDataLoaderOperations(deps);
    const oldStartup = operations.loadEssentialSnapshots({ onWaitingForPlugins });
    await vi.advanceTimersByTimeAsync(0);
    flushSolid();
    expect(onWaitingForPlugins).toHaveBeenLastCalledWith(true);
    operations.invalidateWorkspace();
    const newWaiting = vi.fn();
    const newStartup = operations.loadEssentialSnapshots({ onWaitingForPlugins: newWaiting });
    await vi.advanceTimersByTimeAsync(0);
    flushSolid();
    await expect(oldStartup).resolves.toEqual({ state: 'superseded', failed: [] });
    flushSolid();
    await expect(newStartup).resolves.toEqual({ state: 'loaded', failed: [] });
    flushSolid();
    await vi.advanceTimersByTimeAsync(60_000);
    flushSolid();
    expect(deps.listProviders).toHaveBeenCalledTimes(2);
    expect(onWaitingForPlugins).not.toHaveBeenCalledWith(false);
    expect(deps.finishWorkspaceCatalogReload).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps background activation failures on the ordinary two-attempt bound', async () => {
    const deps = createLoaderDeps({ listProviders: vi.fn().mockRejectedValue(activationError()) });
    const operations = createDataLoaderOperations(deps);
    await expect(operations.reloadWorkspaceCatalogs()).resolves.toBe(false);
    flushSolid();
    expect(deps.listProviders).toHaveBeenCalledTimes(2);
    expect(deps.finishWorkspaceCatalogReload).not.toHaveBeenCalled();
  });

  it('does not read addon diagnostics on the normal startup path', async () => {
    const readStartupDiagnostics = vi.fn(async () => []);
    const operations = createDataLoaderOperations(createLoaderDeps({ readStartupDiagnostics }));
    await expect(operations.loadEssentialSnapshots()).resolves.toMatchObject({ state: 'loaded' });
    flushSolid();
    expect(readStartupDiagnostics).not.toHaveBeenCalled();
  });

  it('reports a bounded named addon failure without blaming it for activation', async () => {
    vi.useFakeTimers();
    const readStartupDiagnostics = vi.fn(async () => [
      { kind: 'mcp' as const, name: 'atlassian', timedOut: true },
    ]);
    const onAddonWarning = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listProviders: vi.fn().mockRejectedValue(activationError()),
        readStartupDiagnostics,
      })
    );
    const startup = operations.loadEssentialSnapshots({ onAddonWarning });
    await vi.advanceTimersByTimeAsync(0);
    flushSolid();
    expect(onAddonWarning).toHaveBeenCalledWith(
      'OpenCode also reports: MCP "atlassian" timed out. These failures may be separate from plugin activation.'
    );
    await vi.advanceTimersByTimeAsync(60_000);
    flushSolid();
    await expect(startup).resolves.toMatchObject({
      state: 'failed',
      error: expect.stringContaining('MCP "atlassian" timed out'),
    });
    flushSolid();
    expect(readStartupDiagnostics).toHaveBeenCalledOnce();
  });

  it('does not let an unavailable addon inventory delay otherwise recoverable startup', async () => {
    vi.useFakeTimers();
    const onAddonWarning = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listProviders: vi
          .fn<DataLoaderDependencies['listProviders']>()
          .mockRejectedValueOnce(activationError())
          .mockResolvedValue({ providers: [], default: {} }),
        readStartupDiagnostics: () => new Promise(() => {}),
      })
    );
    const startup = operations.loadEssentialSnapshots({ onAddonWarning });
    await vi.advanceTimersByTimeAsync(500);
    flushSolid();
    await expect(startup).resolves.toMatchObject({ state: 'loaded' });
    flushSolid();
    expect(onAddonWarning).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops extending retries if activation pending changes to a different error', async () => {
    vi.useFakeTimers();
    const deps = createLoaderDeps({
      listProviders: vi
        .fn<DataLoaderDependencies['listProviders']>()
        .mockRejectedValueOnce(activationError())
        .mockRejectedValueOnce(activationError())
        .mockRejectedValue(new Error('401 Authentication failed')),
    });
    const operations = createDataLoaderOperations(deps);
    const startup = operations.loadEssentialSnapshots();
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
    await expect(startup).resolves.toEqual({ state: 'failed', failed: ['routing catalogs'] });
    flushSolid();
    expect(deps.listProviders).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('inherits an event-driven startup provider success instead of retaining an obsolete 503', async () => {
    vi.useFakeTimers();
    const old = deferred<Awaited<ReturnType<DataLoaderDependencies['listProviders']>>>();
    const deps = createLoaderDeps({
      listProviders: vi
        .fn<DataLoaderDependencies['listProviders']>()
        .mockRejectedValueOnce(activationError())
        .mockReturnValueOnce(old.promise)
        .mockResolvedValue({ providers: [provider('latest', {})], default: {} }),
    });
    const operations = createDataLoaderOperations(deps);
    const startup = operations.loadEssentialSnapshots();
    await vi.advanceTimersByTimeAsync(500);
    flushSolid();
    await operations.refreshRoutingState();
    flushSolid();
    old.resolve({ providers: [provider('stale', {})], default: {} });
    flushSolid();
    await expect(startup).resolves.toEqual({ state: 'loaded', failed: [] });
    flushSolid();
    expect(deps.setProviders).toHaveBeenCalledExactlyOnceWith([provider('latest', {})], {}, []);
    expect(deps.listProviders).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('confirms an empty provider catalog before replacing loaded providers', async () => {
    vi.useFakeTimers();
    const deps = createLoaderDeps({
      listProviders: vi
        .fn<DataLoaderDependencies['listProviders']>()
        .mockResolvedValueOnce({ providers: [provider('openai', {})], default: {} })
        .mockResolvedValueOnce({ providers: [], default: {} })
        .mockResolvedValue({ providers: [provider('openai', {})], default: {} }),
    });
    const operations = createDataLoaderOperations(deps);
    await operations.refreshRoutingState();
    flushSolid();

    const refresh = operations.refreshRoutingState();
    await vi.advanceTimersByTimeAsync(1_500);
    flushSolid();
    await refresh;
    flushSolid();

    expect(deps.listProviders).toHaveBeenCalledTimes(3);
    expect(deps.setProviders).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(deps.setProviders).mock.calls.every(([providers]) => providers.length > 0)
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('confirms an empty first provider catalog when providers were connected before', async () => {
    vi.useFakeTimers();
    const deps = createLoaderDeps({
      hadConnectedProviders: () => true,
      listProviders: vi
        .fn<DataLoaderDependencies['listProviders']>()
        .mockResolvedValueOnce({ providers: [], default: {} })
        .mockResolvedValue({ providers: [provider('openai', {})], default: {} }),
    });
    const operations = createDataLoaderOperations(deps);

    const refresh = operations.refreshRoutingState();
    await vi.advanceTimersByTimeAsync(1_500);
    flushSolid();
    await refresh;
    flushSolid();

    expect(deps.listProviders).toHaveBeenCalledTimes(2);
    expect(deps.setProviders).toHaveBeenCalledExactlyOnceWith([provider('openai', {})], {}, []);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies an empty provider catalog once repeated reads confirm it', async () => {
    vi.useFakeTimers();
    const deps = createLoaderDeps({
      listProviders: vi
        .fn<DataLoaderDependencies['listProviders']>()
        .mockResolvedValueOnce({ providers: [provider('openai', {})], default: {} })
        .mockResolvedValue({ providers: [], default: {} }),
    });
    const operations = createDataLoaderOperations(deps);
    await operations.refreshRoutingState();
    flushSolid();

    const refresh = operations.refreshRoutingState();
    await vi.advanceTimersByTimeAsync(3_000);
    flushSolid();
    await refresh;
    flushSolid();

    expect(deps.listProviders).toHaveBeenCalledTimes(4);
    expect(deps.setProviders).toHaveBeenLastCalledWith([], {}, []);
    expect(deps.setProvidersLoaded).toHaveBeenLastCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares essential in-flight snapshots and reports failed and superseded readiness', async () => {
    const pending = deferred<Session[]>();
    const deps = createLoaderDeps({ listSessions: vi.fn(() => pending.promise) });
    const operations = createDataLoaderOperations(deps);
    const first = operations.loadSessions();
    expect(operations.loadSessions()).toBe(first);
    const essential = operations.loadEssentialSnapshots();
    pending.resolve([session('session-1')]);
    flushSolid();
    await expect(essential).resolves.toEqual({ state: 'loaded', failed: [] });
    flushSolid();
    expect(deps.listSessions).toHaveBeenCalledOnce();

    const failed = createDataLoaderOperations(
      createLoaderDeps({
        listQuestions: async () => {
          throw new Error('question snapshot unavailable');
        },
      })
    );
    await expect(failed.loadEssentialSnapshots()).resolves.toEqual({
      state: 'failed',
      failed: ['pending questions'],
    });
    flushSolid();

    const staleSessions = deferred<Session[]>();
    const stale = createDataLoaderOperations(
      createLoaderDeps({ listSessions: () => staleSessions.promise })
    );
    const load = stale.loadEssentialSnapshots();
    stale.invalidateWorkspace();
    staleSessions.resolve([]);
    flushSolid();
    await expect(load).resolves.toEqual({ state: 'superseded', failed: [] });
    flushSolid();
  });

  it('preserves the selected draft agent when no session is active', async () => {
    const setAllAgents = vi.fn();
    const setPrimaryAgents = vi.fn();
    const setSelectedAgent = vi.fn();
    const logError = vi.fn();

    await loadAgentsWithDependencies(
      {
        listAgents: async () => [buildAgent('plan'), buildAgent('build')],
        getActiveSessionId: () => null,
        getSelectedAgent: () => 'plan',
        getSelectedAgentForSession: () => null,
        getPersistedSelectedAgent: () => 'plan',
        setAllAgents,
        setPrimaryAgents,
        setSelectedAgent,
      },
      logError
    );
    flushSolid();

    expect(setAllAgents).toHaveBeenCalledTimes(1);
    expect(setPrimaryAgents).toHaveBeenCalledTimes(1);
    expect(setSelectedAgent).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'build'],
    ['custom', 'custom'],
    ['missing', 'build'],
  ])('restores the toolbar agent from persisted %s as %s', async (persisted, expected) => {
    const setSelectedAgent = vi.fn();

    await loadAgentsWithDependencies(
      {
        listAgents: async () => [buildAgent('plan'), buildAgent('build'), buildAgent('custom')],
        getActiveSessionId: () => null,
        getSelectedAgent: () => null,
        getSelectedAgentForSession: () => null,
        getPersistedSelectedAgent: () => persisted,
        setAllAgents: vi.fn(),
        setPrimaryAgents: vi.fn(),
        setSelectedAgent,
      },
      vi.fn()
    );
    flushSolid();

    expect(setSelectedAgent).toHaveBeenCalledWith(expected, { persistGlobal: false });
  });

  it('loads configured defaults independently of shared connection status', async () => {
    const setMcpStatus = vi.fn();
    const setMcpDefaults = vi.fn();
    const defaults = {
      global: { alpha: true, gamma: false },
      project: { beta: true },
      effective: { alpha: true, beta: true, gamma: false },
      editable: true,
    };
    const logError = vi.fn();

    await loadMcpsWithDependencies(
      {
        listMcpStatus: async () => ({
          alpha: { status: 'connected' },
          beta: { status: 'disabled' },
          gamma: { status: 'connected' },
        }),
        setMcpStatus,
        listMcpDefaults: async () => defaults,
        setMcpDefaults,
      },
      logError
    );
    flushSolid();

    expect(setMcpStatus).toHaveBeenCalledWith({
      alpha: { status: 'connected' },
      beta: { status: 'disabled' },
      gamma: { status: 'connected' },
    });
    expect(setMcpDefaults).toHaveBeenCalledWith(defaults);
    expect(logError).not.toHaveBeenCalled();
  });

  it('does not apply status when configured defaults cannot be loaded', async () => {
    const setMcpStatus = vi.fn();
    const setMcpDefaults = vi.fn();
    const logError = vi.fn();

    await loadMcpsWithDependencies(
      {
        listMcpStatus: async () => ({
          alpha: { status: 'connected' },
        }),
        setMcpStatus,
        listMcpDefaults: async () => {
          throw new Error('Config unavailable');
        },
        setMcpDefaults,
      },
      logError
    );
    flushSolid();

    expect(setMcpStatus).not.toHaveBeenCalled();
    expect(setMcpDefaults).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith('loadMcps', new Error('Config unavailable'));
  });

  it('applies only the latest overlapping MCP status response', async () => {
    const responseA = deferred<Record<string, { status: 'connected' }>>();
    const responseB = deferred<Record<string, { status: 'connected' }>>();
    const activeSession = { value: 'session-a' };
    const setMcpStatus = vi.fn();
    const listMcpStatus = vi
      .fn<() => Promise<Record<string, { status: 'connected' }>>>()
      .mockReturnValueOnce(responseA.promise)
      .mockReturnValueOnce(responseB.promise);
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listMcpStatus,
        setMcpStatus,
        getActiveSessionId: () => activeSession.value,
        getSelectedMcpsForSession: () => [],
      })
    );

    const loadA = operations.loadMcps();
    activeSession.value = 'session-b';
    const loadB = operations.loadMcps();
    responseB.resolve({ beta: { status: 'connected' } });
    flushSolid();
    await loadB;
    flushSolid();
    responseA.resolve({ alpha: { status: 'connected' } });
    flushSolid();
    await loadA;
    flushSolid();

    expect(setMcpStatus).toHaveBeenCalledTimes(1);
    expect(setMcpStatus).toHaveBeenCalledWith({ beta: { status: 'connected' } });
  });

  it('deduplicates concurrent MCP status loads for the same active session', async () => {
    const response = deferred<Record<string, { status: 'connected' }>>();
    const listMcpStatus = vi.fn(() => response.promise);
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listMcpStatus,
        getActiveSessionId: () => 'session-1',
        getSelectedMcpsForSession: () => [],
      })
    );

    const first = operations.loadMcps();
    const second = operations.loadMcps();
    expect(listMcpStatus).toHaveBeenCalledTimes(1);

    response.resolve({ alpha: { status: 'connected' } });
    flushSolid();
    await Promise.all([first, second]);
    flushSolid();
  });

  it('starts a fresh MCP status load when an in-flight response predates a mutation', async () => {
    const responseA = deferred<Record<string, { status: 'connected' }>>();
    const responseB = deferred<Record<string, { status: 'connected' }>>();
    const setMcpStatus = vi.fn();
    const listMcpStatus = vi
      .fn<() => Promise<Record<string, { status: 'connected' }>>>()
      .mockReturnValueOnce(responseA.promise)
      .mockReturnValueOnce(responseB.promise);
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listMcpStatus,
        setMcpStatus,
        getActiveSessionId: () => 'session-1',
        getSelectedMcpsForSession: () => [],
      })
    );

    const staleLoad = operations.loadMcps();
    const freshLoad = operations.loadMcps({ fresh: true });
    expect(listMcpStatus).toHaveBeenCalledTimes(2);

    responseB.resolve({ beta: { status: 'connected' } });
    flushSolid();
    await freshLoad;
    flushSolid();
    responseA.resolve({ alpha: { status: 'connected' } });
    flushSolid();
    await staleLoad;
    flushSolid();

    expect(setMcpStatus).toHaveBeenCalledOnce();
    expect(setMcpStatus).toHaveBeenCalledWith({ beta: { status: 'connected' } });
  });

  it('does not apply MCP defaults after workspace invalidation', async () => {
    const response = deferred<Record<string, { status: 'connected' }>>();
    let current = true;
    const setMcpDefaults = vi.fn();

    const load = loadMcpsWithDependencies(
      {
        listMcpStatus: () => response.promise,
        setMcpStatus: vi.fn(),
        listMcpDefaults: async () => ({ global: {}, project: {}, effective: {}, editable: true }),
        setMcpDefaults,
      },
      vi.fn(),
      () => current
    );
    current = false;
    response.resolve({ alpha: { status: 'connected' } });
    flushSolid();
    await load;
    flushSolid();

    expect(setMcpDefaults).not.toHaveBeenCalled();
  });

  it('preserves unavailable selected models when providers load', async () => {
    const setProvidersLoaded = vi.fn();
    const setProviders = vi.fn();
    const setProviderDefaults = vi.fn();
    const setSelectedModel = vi.fn();
    const logError = vi.fn();

    await loadProvidersWithDependencies(
      {
        listProviders: async () => ({
          providers: [
            provider('openai', {
              'gpt-5': {
                id: 'gpt-5',
                name: 'GPT-5',
                capabilities: { toolcall: true },
                cost: { input: 0, output: 0 },
              },
            }),
          ],
          default: { openai: 'gpt-5' },
        }),
        setProvidersLoaded,
        setProviders,
        setProviderDefaults,
        getSelectedModel: () => ({ providerID: 'missing', modelID: 'none' }),
        setSelectedModel,
      },
      logError
    );
    flushSolid();

    expect(setProvidersLoaded).toHaveBeenNthCalledWith(1, false);
    expect(setProvidersLoaded).toHaveBeenNthCalledWith(2, true);
    expect(setSelectedModel).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('applies the exact server default instead of provider-scoped defaults', async () => {
    const setSelectedModel = vi.fn();
    const models = {
      'gpt-provider': {
        id: 'gpt-provider',
        name: 'GPT Provider',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
      'gpt-server': {
        id: 'gpt-server',
        name: 'GPT Server',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
    };

    await loadProvidersWithDependencies(
      {
        listProviders: async () => ({
          providers: [provider('openai', models)],
          default: { openai: 'gpt-provider' },
          defaultModel: { providerID: 'openai', modelID: 'gpt-server' },
        }),
        setProvidersLoaded: vi.fn(),
        setProviders: vi.fn(),
        setProviderDefaults: vi.fn(),
        getSelectedModel: () => null,
        setSelectedModel,
      },
      vi.fn()
    );
    flushSolid();

    expect(setSelectedModel).toHaveBeenCalledWith(
      { providerID: 'openai', modelID: 'gpt-server' },
      { rememberLastSelected: false }
    );
  });

  it('keeps a hidden selected model while an existing session is active', async () => {
    const setSelectedModel = vi.fn();
    setState(storePath('hiddenModels', ['openai:gpt-5']));
    flushSolid();

    try {
      await loadProvidersWithDependencies(
        {
          listProviders: async () => ({
            providers: [
              provider('openai', {
                'gpt-5': {
                  id: 'gpt-5',
                  name: 'GPT-5',
                  capabilities: { toolcall: true },
                  cost: { input: 0, output: 0 },
                },
              }),
            ],
            default: { openai: 'gpt-5' },
          }),
          setProvidersLoaded: vi.fn(),
          setProviders: vi.fn(),
          setProviderDefaults: vi.fn(),
          getSelectedModel: () => ({ providerID: 'openai', modelID: 'gpt-5' }),
          getComposerSessionId: () => 'session-1',
          setSelectedModel,
        },
        vi.fn()
      );
      flushSolid();

      expect(setSelectedModel).not.toHaveBeenCalled();
    } finally {
      setState(storePath('hiddenModels', []));
      flushSolid();
    }
  });

  it('preserves a hidden active-session model through provider operation wiring', async () => {
    const setSelectedModel = vi.fn();
    setState(storePath('hiddenModels', ['openai:gpt-5']));
    flushSolid();

    try {
      const operations = createDataLoaderOperations(
        createLoaderDeps({
          getComposerSessionId: () => 'session-1',
          getSelectedModel: () => ({ providerID: 'openai', modelID: 'gpt-5' }),
          listProviders: async () => ({
            providers: [
              provider('openai', {
                'gpt-5': {
                  id: 'gpt-5',
                  name: 'GPT-5',
                  capabilities: { toolcall: true },
                  cost: { input: 0, output: 0 },
                },
              }),
            ],
            default: { openai: 'gpt-5' },
          }),
          setSelectedModel,
        })
      );

      await operations.loadProviders();
      flushSolid();

      expect(setSelectedModel).not.toHaveBeenCalled();
    } finally {
      setState(storePath('hiddenModels', []));
      flushSolid();
    }
  });

  it('does not persist active-session model reconciliation as the global default', async () => {
    const setSelectedModel = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        getComposerSessionId: () => 'session-1',
        getSelectedModel: () => ({ providerID: 'missing', modelID: 'removed' }),
        listProviders: async () => ({
          providers: [provider('openai', {})],
          default: {},
        }),
        setSelectedModel,
      })
    );

    await operations.loadProviders();
    flushSolid();

    expect(setSelectedModel).not.toHaveBeenCalled();
  });

  it('restores a preserved session model after an incomplete provider snapshot is retried', async () => {
    const persistedModel = { providerID: 'openai', modelID: 'gpt-5' };
    let selectedModel: typeof persistedModel | null = persistedModel;
    let providers = [provider('openai', {})];
    const setSelectedModel = vi.fn(
      (
        model: typeof persistedModel | null,
        options?: { sessionId?: string | null; persistGlobal?: boolean }
      ) => {
        selectedModel = model;
        expect(options?.sessionId).toBeUndefined();
      }
    );
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        getComposerSessionId: () => 'session-1',
        getSelectedModel: () => selectedModel,
        getSelectedModelForSession: () => persistedModel,
        listProviders: async () => ({ providers, default: {} }),
        setSelectedModel,
      })
    );

    await operations.loadProviders();
    flushSolid();

    expect(selectedModel).toEqual(persistedModel);
    expect(setSelectedModel).toHaveBeenLastCalledWith(persistedModel, { persistGlobal: false });

    providers = [
      provider('openai', {
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ];
    await operations.loadProviders();
    flushSolid();

    expect(selectedModel).toEqual(persistedModel);
    expect(setSelectedModel).toHaveBeenLastCalledWith(persistedModel, { persistGlobal: false });
  });

  describe('state-bound provider loading', () => {
    const globalModel = { providerID: 'openai', modelID: 'gpt-global' };
    const sessionModel = { providerID: 'openai', modelID: 'gpt-session' };
    const loadedProvider = provider('openai', {
      'gpt-global': {
        id: 'gpt-global',
        name: 'GPT Global',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
      'gpt-session': {
        id: 'gpt-session',
        name: 'GPT Session',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
    });

    beforeEach(() => {
      window.localStorage.clear();
      flushSolid();
      resetDefaultAppState();
      flushSolid();
      clientMocks.providerList.mockResolvedValue({
        providers: [loadedProvider],
        default: { openai: globalModel.modelID },
      });
    });

    afterEach(() => {
      window.localStorage.clear();
      flushSolid();
      resetDefaultAppState();
      flushSolid();
    });

    function selectSessionModel() {
      setStateSelectedModel({ ...globalModel });
      setState(storePath('activeSessionId', 'session-1'));
      setStateSelectedModel({ ...sessionModel }, { sessionId: 'session-1', persistGlobal: false });
    }

    it('inherits the last selected model in a new project without replacing the shared preference', async () => {
      setStateSelectedModel(sessionModel);
      flushSolid();
      setState(storePath('editorContext', 'workspacePath', '/new-project'));
      flushSolid();
      setStateSelectedModel(null, { persistGlobal: false });
      flushSolid();

      await createStateBoundLoader().loadProviders();
      flushSolid();

      expect(state.selectedModel).toEqual(sessionModel);
      expect(getPersistedSelectedModel()).toEqual(sessionModel);
      expect(state.lastSelectedModel).toEqual(sessionModel);
    });

    it('falls back to a visible model without forgetting the last choice for other projects', async () => {
      const unavailable = { providerID: 'other-project-provider', modelID: 'model' };
      setState(storePath('lastSelectedModel', unavailable));
      flushSolid();
      setState(storePath('hiddenModels', ['openai:gpt-global']));
      flushSolid();

      await createStateBoundLoader().loadProviders();
      flushSolid();

      expect(state.selectedModel).toEqual(sessionModel);
      expect(getPersistedSelectedModel()).toEqual(sessionModel);
      expect(state.lastSelectedModel).toEqual(unavailable);
    });

    it.each(['project draft', 'active session'])(
      'keeps an open %s unchanged when another instance selects a model',
      async (composer) => {
        setState(storePath('editorContext', 'workspacePath', '/existing-project'));
        flushSolid();
        if (composer === 'active session') selectSessionModel();
        else setStateSelectedModel(globalModel);
        flushSolid();
        const selected = composer === 'active session' ? sessionModel : globalModel;
        const lastSelectedModel = {
          ...(composer === 'active session' ? globalModel : sessionModel),
          variant: 'high',
        };

        applyModelPreferencesSnapshot({ ...getModelPreferencesSnapshot(), lastSelectedModel });
        flushSolid();

        expect(state.selectedModel).toEqual(selected);
        expect(getPersistedSelectedModel()).toEqual(globalModel);
        const loader = createStateBoundLoader();
        await loader.loadProviders();
        flushSolid();
        await loader.loadProviders();
        flushSolid();

        expect(state.selectedModel).toEqual(selected);
        expect(getPersistedSelectedModel()).toEqual(globalModel);
        expect(state.lastSelectedModel).toEqual(lastSelectedModel);
        if (composer === 'active session') {
          expect(getSelectedModelForSession('session-1')).toEqual(sessionModel);
        }

        setPersistentShowSessionPicker(true);
        flushSolid();
        expect(state.selectedModel).toEqual(globalModel);
        setPersistentShowSessionPicker(false);
        flushSolid();
        expect(state.selectedModel).toEqual(selected);
      }
    );

    it('keeps the global draft model when the session picker retains an active session', async () => {
      selectSessionModel();
      setPersistentShowSessionPicker(true);
      flushSolid();
      expect(state.activeSessionId).toBe('session-1');
      expect(state.selectedModel).toEqual(globalModel);

      await createStateBoundLoader().loadProviders();
      flushSolid();

      expect(state.selectedModel).toEqual(globalModel);
      expect(getSelectedModelForSession('session-1')).toEqual(sessionModel);
      expect(getPersistedSelectedModel()).toEqual(globalModel);
    });

    it.each(['provider', 'model'])(
      'keeps the draft provider when a refresh omits its %s',
      async (omitted) => {
        const selected = { providerID: 'openai', modelID: 'gpt-6.1-sol', variant: 'high' };
        const sharedModels = {
          'gpt-6.1-sol': {
            id: 'gpt-6.1-sol',
            name: 'GPT-6.1 Sol',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            variants: { high: {} },
          },
        };
        const alternatives = [
          provider('openrouter', sharedModels),
          provider('github-copilot', sharedModels),
        ];
        setStateSelectedModel(selected);
        flushSolid();
        clientMocks.providerList.mockResolvedValue({
          providers:
            omitted === 'provider' ? alternatives : [...alternatives, provider('openai', {})],
          default: { openrouter: selected.modelID },
          defaultModel: { providerID: 'openrouter', modelID: selected.modelID },
        });
        const loader = createStateBoundLoader();

        await loader.loadProviders();
        flushSolid();
        await loader.loadProviders();
        flushSolid();

        expect(state.selectedModel).toEqual(selected);
        expect(getPersistedSelectedModel()).toEqual(selected);

        clientMocks.providerList.mockResolvedValue({
          providers: [...alternatives, provider('openai', sharedModels)],
          default: { openrouter: selected.modelID },
        });
        await loader.loadProviders();
        flushSolid();

        expect(state.selectedModel).toEqual(selected);
        expect(getPersistedSelectedModel()).toEqual(selected);
      }
    );

    it('restores the scoped model when the active session owns the composer', async () => {
      selectSessionModel();
      setStateSelectedModel(null, { persistGlobal: false });
      flushSolid();

      await createStateBoundLoader().loadProviders();
      flushSolid();

      expect(state.selectedModel).toEqual(sessionModel);
      expect(getSelectedModelForSession('session-1')).toEqual(sessionModel);
      expect(getPersistedSelectedModel()).toEqual(globalModel);
    });

    it('preserves a hidden model owned by the active composer session', async () => {
      selectSessionModel();
      setState(storePath('hiddenModels', ['openai:gpt-session']));
      flushSolid();

      await createStateBoundLoader().loadProviders();
      flushSolid();

      expect(state.selectedModel).toEqual(sessionModel);
      expect(getSelectedModelForSession('session-1')).toEqual(sessionModel);
      expect(getPersistedSelectedModel()).toEqual(globalModel);
    });
  });

  it('initializes model visibility only for providers connected after the initial load', async () => {
    let providers = [provider('existing', {})];
    const setProviders = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listProviders: async () => ({ providers }),
        setProviders,
      })
    );

    await operations.loadProviders();
    flushSolid();
    expect(setProviders).toHaveBeenLastCalledWith(providers, {}, []);

    providers = [...providers, provider('newly-connected', {})];
    await operations.loadProviders();
    flushSolid();
    expect(setProviders).toHaveBeenLastCalledWith(providers, {}, ['newly-connected']);

    providers = providers.filter((item) => item.id !== 'newly-connected');
    await operations.loadProviders();
    flushSolid();
    providers = [...providers, provider('newly-connected', {})];
    await operations.loadProviders();
    flushSolid();
    expect(setProviders).toHaveBeenLastCalledWith(providers, {}, []);
  });

  it('retries only failed workspace catalogs and retains the send gate after exhaustion', async () => {
    const listAgents = vi
      .fn<DataLoaderDependencies['listAgents']>()
      .mockRejectedValueOnce(new Error('agents unavailable'))
      .mockResolvedValueOnce([]);
    const listCommands = vi.fn<DataLoaderDependencies['listCommands']>().mockResolvedValue([]);
    const listProviders = vi
      .fn<DataLoaderDependencies['listProviders']>()
      .mockRejectedValue(new Error('providers unavailable'));
    const finishWorkspaceCatalogReload = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents,
        listCommands,
        listProviders,
        finishWorkspaceCatalogReload,
      })
    );

    await expect(operations.reloadWorkspaceCatalogs()).resolves.toBe(false);
    flushSolid();

    expect(listAgents).toHaveBeenCalledTimes(2);
    expect(listCommands).toHaveBeenCalledOnce();
    expect(listProviders).toHaveBeenCalledTimes(2);
    expect(finishWorkspaceCatalogReload).not.toHaveBeenCalled();
  });

  it('inherits a newer routing load when catalog events supersede startup catalogs', async () => {
    const startupAgents = deferred<Agent[]>();
    const eventAgents = deferred<Agent[]>();
    const startupProviders =
      deferred<Awaited<ReturnType<DataLoaderDependencies['listProviders']>>>();
    const eventProviders = deferred<Awaited<ReturnType<DataLoaderDependencies['listProviders']>>>();
    const startupCommands = deferred<Command[]>();
    const eventCommands = deferred<Command[]>();
    const listCommands = vi
      .fn<DataLoaderDependencies['listCommands']>()
      .mockReturnValueOnce(startupCommands.promise)
      .mockReturnValueOnce(eventCommands.promise);
    const setCommands = vi.fn();
    const listAgents = vi
      .fn<DataLoaderDependencies['listAgents']>()
      .mockReturnValueOnce(startupAgents.promise)
      .mockReturnValueOnce(eventAgents.promise);
    const listProviders = vi
      .fn<DataLoaderDependencies['listProviders']>()
      .mockReturnValueOnce(startupProviders.promise)
      .mockReturnValueOnce(eventProviders.promise);
    const setAllAgents = vi.fn();
    const finishWorkspaceCatalogReload = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents,
        listCommands,
        setCommands,
        listProviders,
        setAllAgents,
        finishWorkspaceCatalogReload,
      })
    );

    const startup = operations.reloadWorkspaceCatalogs();
    // A fresh server emits catalog events while its first workspace requests run.
    const eventRefresh = operations.refreshRoutingState();
    eventAgents.resolve([buildAgent('latest')]);
    flushSolid();
    eventProviders.resolve({ providers: [provider('latest', {})], default: {} });
    flushSolid();
    eventCommands.resolve([{ name: 'latest-command', template: '', source: 'command' }]);
    flushSolid();
    await eventRefresh;
    flushSolid();
    startupAgents.resolve([buildAgent('stale')]);
    flushSolid();
    startupProviders.resolve({ providers: [provider('stale', {})], default: {} });
    flushSolid();
    startupCommands.resolve([{ name: 'stale-command', template: 'Private template' }]);
    flushSolid();

    await expect(startup).resolves.toBe(true);
    flushSolid();
    expect(listAgents).toHaveBeenCalledTimes(2);
    expect(listProviders).toHaveBeenCalledTimes(2);
    expect(listCommands).toHaveBeenCalledTimes(2);
    expect(setCommands).toHaveBeenCalledExactlyOnceWith([
      { name: 'latest-command', template: '', source: 'command' },
    ]);
    expect(setAllAgents).toHaveBeenCalledExactlyOnceWith([buildAgent('latest')]);
    expect(finishWorkspaceCatalogReload).toHaveBeenCalledOnce();
  });

  it('reports a superseded startup catalog as failed when the newer load fails', async () => {
    const startupAgents = deferred<Agent[]>();
    const listAgents = vi
      .fn<DataLoaderDependencies['listAgents']>()
      .mockReturnValueOnce(startupAgents.promise)
      .mockRejectedValue(new Error('agents unavailable'));
    const finishWorkspaceCatalogReload = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents,
        listCommands: vi.fn<DataLoaderDependencies['listCommands']>().mockResolvedValue([]),
        listProviders: vi
          .fn<DataLoaderDependencies['listProviders']>()
          .mockResolvedValue({ providers: [], default: {} }),
        finishWorkspaceCatalogReload,
      })
    );

    const startup = operations.reloadWorkspaceCatalogs();
    await operations.loadAgents();
    flushSolid();
    startupAgents.resolve([buildAgent('stale')]);
    flushSolid();

    await expect(startup).resolves.toBe(false);
    flushSolid();
    expect(finishWorkspaceCatalogReload).not.toHaveBeenCalled();
  });

  it('bounds workspace catalog reloads that do not settle', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    const listAgents = vi.fn<DataLoaderDependencies['listAgents']>(() => never);
    const listCommands = vi.fn<DataLoaderDependencies['listCommands']>(() => never);
    const listProviders = vi.fn<DataLoaderDependencies['listProviders']>(() => never);
    const finishWorkspaceCatalogReload = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents,
        listCommands,
        listProviders,
        finishWorkspaceCatalogReload,
      })
    );

    try {
      const reload = operations.reloadWorkspaceCatalogs();
      await vi.runAllTimersAsync();
      flushSolid();

      await expect(reload).resolves.toBe(false);
      flushSolid();
      expect(listAgents).toHaveBeenCalledTimes(2);
      expect(listCommands).toHaveBeenCalledTimes(2);
      expect(listProviders).toHaveBeenCalledTimes(2);
      expect(finishWorkspaceCatalogReload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an invalidated catalog reload release the next workspace lock', async () => {
    const agents = deferred<Agent[]>();
    const commands = deferred<Array<{ name: string; template: string }>>();
    const providers = deferred<Awaited<ReturnType<DataLoaderDependencies['listProviders']>>>();
    const finishWorkspaceCatalogReload = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents: () => agents.promise,
        listCommands: () => commands.promise,
        listProviders: () => providers.promise,
        finishWorkspaceCatalogReload,
      })
    );

    const reload = operations.reloadWorkspaceCatalogs();
    operations.invalidateWorkspace();
    agents.resolve([buildAgent('old')]);
    flushSolid();
    commands.resolve([{ name: 'old', template: '/old' }]);
    flushSolid();
    providers.resolve({ providers: [provider('old', {})], default: {} });
    flushSolid();

    await expect(reload).resolves.toBe(false);
    flushSolid();
    expect(finishWorkspaceCatalogReload).not.toHaveBeenCalled();
  });

  it('excludes unavailable models from OpenAI', async () => {
    const openAi = provider('openai', {
      'gpt-5.6-pro': {
        id: 'gpt-5.6-pro',
        name: 'GPT-5.6 Pro',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
      'gpt-5.6': {
        id: 'gpt-5.6',
        name: 'GPT-5.6',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
      'gpt-5.6-fast': {
        id: 'gpt-5.6-fast',
        name: 'GPT-5.6 Fast',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
    });
    const other = provider('other', {
      pro: {
        id: 'pro',
        name: 'Other Pro',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
    });
    const setProviders = vi.fn();
    const setProviderDefaults = vi.fn();
    const setSelectedModel = vi.fn();

    await loadProvidersWithDependencies(
      {
        listProviders: async () => ({
          providers: [openAi, other],
          default: { openai: 'gpt-5.6-fast', other: 'pro' },
        }),
        setProvidersLoaded: vi.fn(),
        setProviders,
        setProviderDefaults,
        getSelectedModel: () => null,
        setSelectedModel,
      },
      vi.fn()
    );
    flushSolid();

    const loadedProviders = setProviders.mock.calls[0]?.[0];
    expect(Object.keys(loadedProviders[0].models)).toEqual(['gpt-5.5']);
    expect(Object.keys(loadedProviders[1].models)).toEqual(['pro']);
    expect(setProviders).toHaveBeenCalledWith(loadedProviders, { other: 'pro' });
    expect(setProviderDefaults).toHaveBeenCalledWith({ other: 'pro' });
    expect(setSelectedModel).toHaveBeenCalledWith(
      { providerID: 'openai', modelID: 'gpt-5.5' },
      { rememberLastSelected: false }
    );
  });

  it('hydrates session statuses and usage-limit state for loaded sessions', async () => {
    const setSessionStatuses = vi.fn((next: Record<string, SessionStatus>) => next);
    const updateUsageLimitState = vi.fn();
    const logError = vi.fn();
    const statuses = {
      'session-1': { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 8 },
      'session-2': { type: 'idle' },
    } satisfies Record<string, SessionStatus>;
    const sessions: Session[] = [session('session-1'), session('session-2')];

    await hydrateSessionStatusesWithDependencies(
      {
        loadSessionStatuses: async () => statuses,
        setSessionStatuses,
        getSessions: () => sessions,
        updateUsageLimitState,
      },
      logError
    );
    flushSolid();

    expect(setSessionStatuses).toHaveBeenCalledWith(statuses, {
      snapshotStartedAt: expect.any(Number),
    });
    expect(updateUsageLimitState).toHaveBeenNthCalledWith(
      1,
      'session-1',
      statuses['session-1'],
      []
    );
    expect(updateUsageLimitState).toHaveBeenNthCalledWith(
      2,
      'session-2',
      statuses['session-2'],
      []
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it('uses reconciled statuses for coordinated runtime snapshot side effects', async () => {
    const retryStatus = {
      type: 'retry',
      attempt: 3,
      message: '429 usage limit reached',
      next: 9_000,
    } satisfies SessionStatus;
    const loadSessionStatuses = vi.fn(async () => ({}));
    const updateUsageLimitState = vi.fn();

    await hydrateSessionStatusesWithDependencies(
      {
        loadSessionStatuses,
        loadSessionStatusSnapshot: async () => ({
          statuses: { 'session-1': { type: 'busy' } },
          startedAt: 1_000,
        }),
        setSessionStatuses: vi.fn(() => ({ 'session-1': retryStatus })),
        getSessions: () => [session('session-1')],
        updateUsageLimitState,
      },
      vi.fn()
    );
    flushSolid();

    expect(loadSessionStatuses).not.toHaveBeenCalled();
    expect(updateUsageLimitState).toHaveBeenCalledWith('session-1', retryStatus, []);
  });

  it('does not clear a newer retry notice when an older status snapshot finishes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    flushSolid();
    resetDefaultAppState();
    flushSolid();
    resetSessionStatusSnapshotTracking();
    flushSolid();
    const pendingStatuses = deferred<Record<string, SessionStatus>>();
    const loadedSession = session('session-1');
    sessionStore.setSessions([loadedSession]);
    flushSolid();

    try {
      const hydration = hydrateSessionStatusesWithDependencies(
        {
          loadSessionStatuses: () => pendingStatuses.promise,
          setSessionStatuses: sessionStore.setSessionStatuses,
          getSessions: () => [loadedSession],
          updateUsageLimitState: (sessionId, status) => {
            sessionStore.setSessionUsageLimit(
              sessionId,
              deriveUsageLimitNotice({ sessionID: sessionId, status, messages: [] })
            );
          },
        },
        vi.fn()
      );
      flushSolid();

      vi.setSystemTime(2_000);
      flushSolid();
      const retryStatus = {
        type: 'retry',
        attempt: 2,
        message: '429 usage limit reached',
        next: 8_000,
      } satisfies SessionStatus;
      sessionStore.setSessionStatusEntry(loadedSession.id, retryStatus);
      flushSolid();
      sessionStore.setSessionUsageLimit(
        loadedSession.id,
        deriveUsageLimitNotice({
          sessionID: loadedSession.id,
          status: retryStatus,
          messages: [],
        })
      );
      flushSolid();

      pendingStatuses.resolve({ [loadedSession.id]: { type: 'busy' } });
      flushSolid();
      await hydration;
      flushSolid();

      expect(state.sessionStatus[loadedSession.id]).toEqual(retryStatus);
      expect(state.sessionUsageLimits[loadedSession.id]).toMatchObject({
        source: 'status',
        statusCode: 429,
        attempt: 2,
      });
    } finally {
      vi.useRealTimers();
      resetDefaultAppState();
      flushSolid();
      resetSessionStatusSnapshotTracking();
      flushSolid();
    }
  });

  it('loads commands, questions, sessions, recycle bin entries, and provider limits', async () => {
    const setCommands = vi.fn();
    const setQuestions = vi.fn();
    const applySessions = vi.fn();
    const setRecycleBinEntries = vi.fn();
    const setProviderLimit = vi.fn();
    const logError = vi.fn();
    const question: QuestionRequest = {
      id: 'question-1',
      sessionID: 'session-1',
      questions: [],
    };
    const limit: ProviderLimitStatus = {
      providerID: 'openai',
      modelID: 'gpt-5',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1,
      note: 'Unsupported',
    };
    const sessions: Session[] = [session('session-1')];
    const recycleBinEntries: RecycleBinEntry[] = [
      {
        rootID: 'session-1',
        deletedAt: 1,
        expiresAt: 2,
        root: {
          id: 'session-1',
          projectID: 'project-1',
          directory: '/repo',
          title: 'Session',
          version: '1',
          time: { created: 0, updated: 0 },
        },
        sessions: [],
      },
    ];

    await loadCommandsWithDependencies(
      {
        listCommands: async () => [{ name: 'review', template: '/review' }],
        setCommands,
      },
      logError
    );
    flushSolid();
    await loadQuestionsWithDependencies(
      {
        listQuestions: async () => [question],
        setQuestions,
      },
      logError
    );
    flushSolid();
    await loadSessionsWithDependencies(
      {
        listSessions: async () => sessions,
        applySessions,
      },
      logError
    );
    flushSolid();
    await loadRecycleBinWithDependencies(
      {
        listRecycleBin: async () => recycleBinEntries,
        setRecycleBinEntries,
      },
      logError
    );
    flushSolid();
    await refreshProviderLimitWithDependencies(
      {
        loadProviderLimit: async () => limit,
        setProviderLimit,
      },
      'openai',
      'gpt-5',
      logError
    );
    flushSolid();

    expect(setCommands).toHaveBeenCalledWith([{ name: 'review', template: '/review' }]);
    expect(setQuestions).toHaveBeenCalledWith([question]);
    expect(applySessions).toHaveBeenCalled();
    expect(setRecycleBinEntries).toHaveBeenCalled();
    expect(setProviderLimit).toHaveBeenCalledWith('openai', 'gpt-5', limit);
    expect(logError).not.toHaveBeenCalled();
  });

  it('loads provider auth methods and workspace statuses', async () => {
    const setProviderAuthMethods = vi.fn();
    const setWorkspaceStatuses = vi.fn();
    const logError = vi.fn();

    await loadProviderAuthMethodsWithDependencies(
      {
        listProviderAuthMethods: async () => ({
          openai: [{ type: 'oauth', label: 'Browser login' }],
        }),
        setProviderAuthMethods,
      },
      logError
    );
    flushSolid();

    await loadWorkspaceStatusesWithDependencies(
      {
        listWorkspaceStatuses: async () => [{ workspaceID: 'ws-1', status: 'connected' }],
        setWorkspaceStatuses,
      },
      logError
    );
    flushSolid();

    expect(setProviderAuthMethods).toHaveBeenCalledWith({
      openai: [{ type: 'oauth', label: 'Browser login' }],
    });
    expect(setWorkspaceStatuses).toHaveBeenCalledWith([
      { workspaceID: 'ws-1', status: 'connected' },
    ]);
    expect(logError).not.toHaveBeenCalled();
  });

  it('preserves a session created while an older session snapshot is in flight', async () => {
    const response = deferred<Session[]>();
    let currentSessions = [session('existing')];
    const applySessions = vi.fn((sessions: Session[]) => {
      currentSessions = sessions;
    });
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: () => response.promise,
        getSessions: () => currentSessions,
        applySessions,
      })
    );

    const load = operations.loadSessions();
    currentSessions = [...currentSessions, session('new-session')];
    response.resolve([session('existing')]);
    flushSolid();
    await load;
    flushSolid();

    expect(applySessions).toHaveBeenCalledWith([session('existing'), session('new-session')], true);
  });

  it('allows a locally removed session to reappear in a later snapshot', async () => {
    const first = deferred<Session[]>();
    const removed = session('removed');
    let currentSessions = [removed];
    const applySessions = vi.fn((sessions: Session[]) => {
      currentSessions = sessions;
    });
    const listSessions = vi
      .fn<() => Promise<Session[]>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([removed]);
    const operations = createDataLoaderOperations(
      createLoaderDeps({ listSessions, getSessions: () => currentSessions, applySessions })
    );

    const staleLoad = operations.loadSessions();
    currentSessions = [];
    first.resolve([removed]);
    flushSolid();
    await staleLoad;
    flushSolid();
    expect(currentSessions).toEqual([]);

    await operations.loadSessions();
    flushSolid();
    expect(currentSessions).toEqual([removed]);
  });

  it('clears queued messages for sessions removed by a confirmed snapshot', async () => {
    const removed = session('removed');
    const retained = session('retained');
    let currentSessions = [removed, retained];
    const clearQueuedMessagesForSession = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => [retained],
        getSessions: () => currentSessions,
        applySessions: (sessions) => {
          currentSessions = sessions;
        },
        clearQueuedMessagesForSession,
      })
    );

    await operations.loadSessions();
    flushSolid();

    expect(currentSessions).toEqual([retained]);
    expect(clearQueuedMessagesForSession).toHaveBeenCalledOnce();
    expect(clearQueuedMessagesForSession).toHaveBeenCalledWith('removed');
  });

  it('reconciles loaded session agent metadata in one bulk operation', async () => {
    const loaded = [
      { ...session('session-1'), agent: 'build' },
      { ...session('session-2'), agent: 'plan' },
      session('session-3'),
    ];
    const hydrateSessionSelectedAgents = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => loaded,
        hydrateSessionSelectedAgents,
      })
    );

    await operations.loadSessions();
    flushSolid();

    expect(hydrateSessionSelectedAgents).toHaveBeenCalledOnce();
    expect(hydrateSessionSelectedAgents).toHaveBeenCalledWith({
      'session-1': 'build',
      'session-2': 'plan',
    });
  });

  it.each([
    { hasMore: true },
    { hasMore: false, incomplete: true, unavailableDirectories: ['/repo'] },
  ])('carries partial catalog completeness through session lifecycle: %j', async (partial) => {
    const stateModule = await import('../lib/state');
    flushSolid();
    const { SessionLifecycleOperations } = await import('./session/session-lifecycle');
    flushSolid();
    stateModule.setSessions([]);
    flushSolid();
    stateModule.setState(storePath('completedSessionResponses', { unloaded: 100 }));
    flushSolid();
    stateModule.setState(storePath('skippedPlanSessions', { unloaded: 100 }));
    flushSolid();
    const lifecycle = new SessionLifecycleOperations({
      getCurrentWorkspacePath: () => '/repo',
      clearPendingAbort: vi.fn(),
      clearPendingAbortTree: vi.fn(),
      resetTodoSync: vi.fn(),
      resetToolCallExpansionState: vi.fn(),
      publishSessionModel: vi.fn(),
    });
    const listSessions = vi
      .fn<DataLoaderDependencies['listSessions']>()
      .mockResolvedValueOnce({ items: [session('recent')], ...partial })
      .mockResolvedValueOnce({ items: [session('recent')], hasMore: false });
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions,
        getSessions: () => stateModule.state.sessions,
        applySessions: lifecycle.applySessions,
      })
    );
    await operations.loadSessions();
    flushSolid();
    expect(stateModule.state.completedSessionResponses.unloaded).toBe(100);
    expect(stateModule.state.skippedPlanSessions.unloaded).toBe(100);
    lifecycle.upsertSession(session('recent'));
    flushSolid();
    expect(stateModule.state.completedSessionResponses.unloaded).toBe(100);
    expect(stateModule.state.skippedPlanSessions.unloaded).toBe(100);
    await operations.loadSessions();
    flushSolid();
    expect(stateModule.state.completedSessionResponses.unloaded).toBeUndefined();
    expect(stateModule.state.skippedPlanSessions.unloaded).toBeUndefined();
  });

  it('preserves queues omitted from a partial refresh until a complete snapshot confirms removal', async () => {
    const stale = session('stale');
    const newest = session('newest');
    const oldest = session('oldest');
    let currentSessions = [stale];
    const clearQueuedMessagesForSession = vi.fn();
    const setSessionsHasMore = vi.fn();
    const setSessionsLoadingMore = vi.fn();
    const listSessions = vi
      .fn<DataLoaderDependencies['listSessions']>()
      .mockResolvedValueOnce({ items: [newest], hasMore: true })
      .mockResolvedValueOnce({ items: [newest, oldest], hasMore: false });
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions,
        getSessions: () => currentSessions,
        applySessions: (sessions) => {
          currentSessions = sessions;
        },
        clearQueuedMessagesForSession,
        setSessionsHasMore,
        setSessionsLoadingMore,
      })
    );

    await operations.loadSessions();
    flushSolid();

    expect(listSessions).toHaveBeenNthCalledWith(1, 100);
    expect(currentSessions).toEqual([newest, stale]);
    expect(setSessionsHasMore).toHaveBeenLastCalledWith(true);
    expect(clearQueuedMessagesForSession).not.toHaveBeenCalled();

    await operations.loadMoreSessions();
    flushSolid();

    expect(listSessions).toHaveBeenNthCalledWith(2, 200);
    expect(currentSessions).toEqual([newest, oldest]);
    expect(setSessionsHasMore).toHaveBeenLastCalledWith(false);
    expect(setSessionsLoadingMore.mock.calls).toEqual([[true], [false]]);
    expect(clearQueuedMessagesForSession).toHaveBeenCalledOnce();
    expect(clearQueuedMessagesForSession).toHaveBeenCalledWith('stale');
  });

  it('retains failed-root sessions without requesting a nonexistent continuation page', async () => {
    const failedRootSession = { ...session('failed-root'), directory: '/repo-b' };
    const staleHealthySession = { ...session('stale-healthy'), directory: '/repo-a' };
    const healthy = { ...session('healthy'), directory: '/repo-a' };
    let currentSessions = [failedRootSession, staleHealthySession];
    const clearQueuedMessagesForSession = vi.fn();
    const setSessionsHasMore = vi.fn();
    const setSessionsLoadError = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => ({
          items: [healthy],
          hasMore: false,
          incomplete: true,
          unavailableDirectories: ['/repo-b'],
        }),
        getSessions: () => currentSessions,
        applySessions: (sessions) => {
          currentSessions = sessions;
        },
        clearQueuedMessagesForSession,
        setSessionsHasMore,
        setSessionsLoadError,
      })
    );

    await operations.loadSessions();
    flushSolid();

    expect(currentSessions).toEqual([healthy, failedRootSession]);
    expect(setSessionsHasMore).toHaveBeenLastCalledWith(false);
    expect(clearQueuedMessagesForSession).toHaveBeenCalledWith('stale-healthy');
    expect(setSessionsLoadError).toHaveBeenLastCalledWith('Could not load sessions from: /repo-b');
  });

  it('retains nested-folder history and queues when its workspace root is missing', async () => {
    const nested = { ...session('nested'), directory: '/repo-b/nested' };
    const healthy = { ...session('healthy'), directory: '/repo-a' };
    let currentSessions = [nested];
    const clearQueuedMessagesForSession = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => ({
          items: [healthy],
          hasMore: false,
          incomplete: true,
          unavailableDirectories: ['/repo-b'],
        }),
        getSessions: () => currentSessions,
        applySessions: (sessions) => {
          currentSessions = sessions;
        },
        clearQueuedMessagesForSession,
      })
    );
    await operations.loadSessions();
    flushSolid();
    expect(currentSessions).toEqual([healthy, nested]);
    expect(clearQueuedMessagesForSession).not.toHaveBeenCalled();
  });

  it('does not prune any cached project history or queues when every folder is missing', async () => {
    const worktree = { ...session('worktree'), directory: '/other-worktree' };
    let currentSessions = [worktree];
    const clearQueuedMessagesForSession = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => ({
          items: [],
          hasMore: false,
          incomplete: true,
          unavailableDirectories: ['/old-repo'],
        }),
        getSessions: () => currentSessions,
        applySessions: (sessions) => {
          currentSessions = sessions;
        },
        clearQueuedMessagesForSession,
      })
    );
    await operations.loadSessions();
    flushSolid();
    expect(currentSessions).toEqual([worktree]);
    expect(clearQueuedMessagesForSession).not.toHaveBeenCalled();
  });

  it('clears pagination loading state when workspace work is invalidated', async () => {
    const response = deferred<{ items: Session[]; hasMore: boolean }>();
    const setSessionsLoadingMore = vi.fn();
    const setSessionsPaginationError = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: () => response.promise,
        setSessionsLoadingMore,
        setSessionsPaginationError,
      })
    );

    const load = operations.loadMoreSessions();
    operations.invalidateWorkspace();

    expect(setSessionsLoadingMore.mock.calls).toEqual([[true], [false]]);
    expect(setSessionsPaginationError).toHaveBeenLastCalledWith(null);

    response.resolve({ items: [], hasMore: false });
    flushSolid();
    await load;
    flushSolid();
  });

  it('clears a stale pagination error after a successful session refresh', async () => {
    const setSessionsPaginationError = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => ({ items: [], hasMore: false }),
        setSessionsPaginationError,
      })
    );

    await operations.loadSessions();
    flushSolid();

    expect(setSessionsPaginationError).toHaveBeenLastCalledWith(null);
  });

  it('retries a failed load-more request without skipping a session window', async () => {
    const listSessions = vi
      .fn<DataLoaderDependencies['listSessions']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [], hasMore: false });
    const operations = createDataLoaderOperations(createLoaderDeps({ listSessions }));

    await operations.loadMoreSessions();
    flushSolid();
    await operations.loadMoreSessions();
    flushSolid();

    expect(listSessions.mock.calls).toEqual([[200], [200]]);
  });

  it('applies only the latest overlapping session snapshot', async () => {
    const first = deferred<Session[]>();
    const second = deferred<Session[]>();
    let currentSessions = [session('existing')];
    const applySessions = vi.fn((sessions: Session[]) => {
      currentSessions = sessions;
    });
    const listSessions = vi
      .fn<() => Promise<Session[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const operations = createDataLoaderOperations(
      createLoaderDeps({ listSessions, getSessions: () => currentSessions, applySessions })
    );

    const staleLoad = operations.loadSessions();
    const latestLoad = operations.loadSessions({ fresh: true });
    second.resolve([session('latest')]);
    flushSolid();
    await latestLoad;
    flushSolid();
    first.resolve([session('stale')]);
    flushSolid();
    await staleLoad;
    flushSolid();

    expect(currentSessions).toEqual([session('latest')]);
    expect(applySessions).toHaveBeenCalledTimes(1);
  });

  it('applies only the latest overlapping routing, compatibility, and recycle loads', async () => {
    const firstAgents = deferred<Agent[]>();
    const latestAgents = deferred<Agent[]>();
    const firstCommands = deferred<Array<{ name: string; template: string }>>();
    const latestCommands = deferred<Array<{ name: string; template: string }>>();
    const firstProviders = deferred<Awaited<ReturnType<DataLoaderDependencies['listProviders']>>>();
    const latestProviders =
      deferred<Awaited<ReturnType<DataLoaderDependencies['listProviders']>>>();
    const firstAuth =
      deferred<Awaited<ReturnType<DataLoaderDependencies['listProviderAuthMethods']>>>();
    const latestAuth =
      deferred<Awaited<ReturnType<DataLoaderDependencies['listProviderAuthMethods']>>>();
    const firstWorkspaces =
      deferred<Awaited<ReturnType<DataLoaderDependencies['listWorkspaceStatuses']>>>();
    const latestWorkspaces =
      deferred<Awaited<ReturnType<DataLoaderDependencies['listWorkspaceStatuses']>>>();
    const firstRecycleBin = deferred<RecycleBinEntry[]>();
    const latestRecycleBin = deferred<RecycleBinEntry[]>();
    const setAllAgents = vi.fn();
    const setCommands = vi.fn();
    const setProviders = vi.fn();
    const setProviderAuthMethods = vi.fn();
    const setWorkspaceStatuses = vi.fn();
    const setRecycleBinEntries = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents: vi
          .fn<DataLoaderDependencies['listAgents']>()
          .mockReturnValueOnce(firstAgents.promise)
          .mockReturnValueOnce(latestAgents.promise),
        setAllAgents,
        listCommands: vi
          .fn<DataLoaderDependencies['listCommands']>()
          .mockReturnValueOnce(firstCommands.promise)
          .mockReturnValueOnce(latestCommands.promise),
        setCommands,
        listProviders: vi
          .fn<DataLoaderDependencies['listProviders']>()
          .mockReturnValueOnce(firstProviders.promise)
          .mockReturnValueOnce(latestProviders.promise),
        setProviders,
        listProviderAuthMethods: vi
          .fn<DataLoaderDependencies['listProviderAuthMethods']>()
          .mockReturnValueOnce(firstAuth.promise)
          .mockReturnValueOnce(latestAuth.promise),
        setProviderAuthMethods,
        listWorkspaceStatuses: vi
          .fn<DataLoaderDependencies['listWorkspaceStatuses']>()
          .mockReturnValueOnce(firstWorkspaces.promise)
          .mockReturnValueOnce(latestWorkspaces.promise),
        setWorkspaceStatuses,
        listRecycleBin: vi
          .fn<DataLoaderDependencies['listRecycleBin']>()
          .mockReturnValueOnce(firstRecycleBin.promise)
          .mockReturnValueOnce(latestRecycleBin.promise),
        setRecycleBinEntries,
      })
    );

    const staleLoads = [
      operations.loadAgents(),
      operations.loadCommands(),
      operations.loadProviders(),
      operations.loadCompatibilityState(),
      operations.loadRecycleBin(),
    ];
    const latestLoads = [
      operations.loadAgents(),
      operations.loadCommands(),
      operations.loadProviders(),
      operations.loadCompatibilityState(),
      operations.loadRecycleBin(),
    ];
    latestAgents.resolve([buildAgent('latest')]);
    flushSolid();
    latestCommands.resolve([{ name: 'latest', template: '/latest' }]);
    flushSolid();
    latestProviders.resolve({ providers: [provider('latest', {})], default: {} });
    flushSolid();
    latestAuth.resolve({ latest: [{ type: 'api', label: 'Latest' }] });
    flushSolid();
    latestWorkspaces.resolve([{ workspaceID: 'latest', status: 'connected' }]);
    flushSolid();
    latestRecycleBin.resolve([]);
    flushSolid();
    await Promise.all(latestLoads);
    flushSolid();

    firstAgents.resolve([buildAgent('stale')]);
    flushSolid();
    firstCommands.resolve([{ name: 'stale', template: '/stale' }]);
    flushSolid();
    firstProviders.resolve({ providers: [provider('stale', {})], default: {} });
    flushSolid();
    firstAuth.resolve({ stale: [{ type: 'api', label: 'Stale' }] });
    flushSolid();
    firstWorkspaces.resolve([{ workspaceID: 'stale', status: 'connected' }]);
    flushSolid();
    firstRecycleBin.resolve([]);
    flushSolid();
    await Promise.all(staleLoads);
    flushSolid();

    expect(setAllAgents).toHaveBeenCalledOnce();
    expect(setAllAgents).toHaveBeenCalledWith([buildAgent('latest')]);
    expect(setCommands).toHaveBeenCalledOnce();
    expect(setCommands).toHaveBeenCalledWith([{ name: 'latest', template: '/latest' }]);
    expect(setProviders).toHaveBeenCalledOnce();
    expect(setProviders).toHaveBeenCalledWith([provider('latest', {})], {}, []);
    expect(setProviderAuthMethods).toHaveBeenCalledOnce();
    expect(setProviderAuthMethods).toHaveBeenCalledWith({
      latest: [{ type: 'api', label: 'Latest' }],
    });
    expect(setWorkspaceStatuses).toHaveBeenCalledOnce();
    expect(setWorkspaceStatuses).toHaveBeenCalledWith([
      { workspaceID: 'latest', status: 'connected' },
    ]);
    expect(setRecycleBinEntries).toHaveBeenCalledOnce();
  });

  it('does not apply workspace-sensitive loads invalidated by a workspace change', async () => {
    const agents = deferred<Agent[]>();
    const recycleBin = deferred<RecycleBinEntry[]>();
    const statuses = deferred<Record<string, SessionStatus>>();
    const sessions = deferred<Session[]>();
    const setAllAgents = vi.fn();
    const setRecycleBinEntries = vi.fn();
    const setSessionStatuses = vi.fn();
    const applySessions = vi.fn();
    const setSessionsLoadError = vi.fn();
    const setRecycleBinLoadError = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents: () => agents.promise,
        setAllAgents,
        listRecycleBin: () => recycleBin.promise,
        setRecycleBinEntries,
        loadSessionStatuses: () => statuses.promise,
        setSessionStatuses,
        listSessions: () => sessions.promise,
        applySessions,
        setSessionsLoadError,
        setRecycleBinLoadError,
      })
    );

    const staleLoads = Promise.all([
      operations.loadAgents(),
      operations.loadRecycleBin(),
      operations.hydrateSessionStatuses(),
      operations.loadSessions(),
    ]);
    flushSolid();
    operations.invalidateWorkspace();
    agents.resolve([buildAgent('build')]);
    flushSolid();
    recycleBin.resolve([]);
    flushSolid();
    statuses.resolve({ 'session-old': { type: 'busy' } });
    flushSolid();
    sessions.resolve([session('session-old')]);
    flushSolid();
    await staleLoads;
    flushSolid();

    expect(setAllAgents).not.toHaveBeenCalled();
    expect(setRecycleBinEntries).not.toHaveBeenCalled();
    expect(setSessionStatuses).not.toHaveBeenCalled();
    expect(applySessions).not.toHaveBeenCalled();
    expect(setSessionsLoadError).not.toHaveBeenCalled();
    expect(setRecycleBinLoadError).not.toHaveBeenCalled();
  });

  it('does not resurrect a question answered while its snapshot is in flight', async () => {
    const response = deferred<QuestionRequest[]>();
    const answered: QuestionRequest = {
      id: 'answered',
      sessionID: 'session-1',
      questions: [],
    };
    const current: QuestionRequest = {
      id: 'current',
      sessionID: 'session-1',
      questions: [],
    };
    let questions: QuestionRequest[] = [answered];
    const setQuestions = vi.fn((next: QuestionRequest[]) => {
      questions = next;
    });
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listQuestions: () => response.promise,
        getQuestions: () => questions,
        setQuestions,
      })
    );

    const load = operations.loadQuestions();
    questions = [];
    response.resolve([answered, current]);
    flushSolid();
    await load;
    flushSolid();

    expect(questions).toEqual([current]);
    expect(setQuestions).toHaveBeenCalledWith([current]);
  });

  it('allows an answered question to reappear in a later snapshot', async () => {
    const first = deferred<QuestionRequest[]>();
    const answered: QuestionRequest = {
      id: 'answered',
      sessionID: 'session-1',
      questions: [],
    };
    let questions: QuestionRequest[] = [answered];
    const setQuestions = vi.fn((next: QuestionRequest[]) => {
      questions = next;
    });
    const listQuestions = vi
      .fn<() => Promise<QuestionRequest[]>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([answered]);
    const operations = createDataLoaderOperations(
      createLoaderDeps({ listQuestions, getQuestions: () => questions, setQuestions })
    );

    const staleLoad = operations.loadQuestions();
    questions = [];
    first.resolve([answered]);
    flushSolid();
    await staleLoad;
    flushSolid();
    expect(questions).toEqual([]);

    await operations.loadQuestions();
    flushSolid();
    expect(questions).toEqual([answered]);
  });

  it('requires confirmation before applying an empty session snapshot over existing sessions', async () => {
    const applySessions = vi.fn();
    const logError = vi.fn();
    const currentSessions = [session('session-1')];

    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => [],
        applySessions,
        getSessions: () => currentSessions,
        logError,
      })
    );

    await operations.loadSessions();
    flushSolid();
    expect(applySessions).not.toHaveBeenCalled();

    await operations.loadSessions();
    flushSolid();
    expect(applySessions).toHaveBeenCalledWith([], true);
    expect(logError).not.toHaveBeenCalled();
  });

  it('resets empty-snapshot confirmation when workspace loads are invalidated', async () => {
    let currentSessions = [session('session-1')];
    const applySessions = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => [],
        getSessions: () => currentSessions,
        applySessions,
      })
    );

    await operations.loadSessions();
    flushSolid();
    operations.invalidateWorkspace();
    await operations.loadSessions();
    flushSolid();
    expect(applySessions).not.toHaveBeenCalled();

    currentSessions = [];
    await operations.loadSessions();
    flushSolid();
    expect(applySessions).toHaveBeenCalledOnce();
    expect(applySessions).toHaveBeenCalledWith([], true);
  });

  it('resets empty session snapshot confirmation after a non-empty snapshot', async () => {
    const applySessions = vi.fn();
    const logError = vi.fn();
    const currentSessions = [session('session-1')];
    const listedSessions = [session('session-1')];
    const listSessions = vi
      .fn<() => Promise<Session[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(listedSessions)
      .mockResolvedValueOnce([]);

    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions,
        applySessions,
        getSessions: () => currentSessions,
        logError,
      })
    );

    await operations.loadSessions();
    flushSolid();
    await operations.loadSessions();
    flushSolid();
    await operations.loadSessions();
    flushSolid();

    expect(applySessions).toHaveBeenCalledTimes(1);
    expect(applySessions).toHaveBeenCalledWith(listedSessions, true);
    expect(logError).not.toHaveBeenCalled();
  });

  it('flags session list load failures and clears the flag on the next success', async () => {
    const setSessionsLoadError = vi.fn();
    let fail = true;
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => {
          if (fail) throw new Error('list failed');
          return [session('session-1')];
        },
        setSessionsLoadError,
      })
    );

    await operations.loadSessions();
    flushSolid();
    expect(setSessionsLoadError).toHaveBeenLastCalledWith('Failed to load sessions');

    fail = false;
    await operations.loadSessions();
    flushSolid();
    expect(setSessionsLoadError).toHaveBeenLastCalledWith(null);
  });

  it('flags recycle bin load failures and clears the flag on the next success', async () => {
    const setRecycleBinLoadError = vi.fn();
    let fail = true;
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listRecycleBin: async () => {
          if (fail) throw new Error('bin failed');
          return [];
        },
        setRecycleBinLoadError,
      })
    );

    await operations.loadRecycleBin();
    flushSolid();
    expect(setRecycleBinLoadError).toHaveBeenLastCalledWith('Failed to load the recycle bin');

    fail = false;
    await operations.loadRecycleBin();
    flushSolid();
    expect(setRecycleBinLoadError).toHaveBeenLastCalledWith(null);
  });
});
