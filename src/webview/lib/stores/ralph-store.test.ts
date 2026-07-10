import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RalphConfig, RalphIteration, RalphRun } from '../../../shared/ralph';

const LEGACY_STORAGE_KEY = 'varro.ralph.runs';

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }));

vi.mock('../bridge', () => ({ postMessage }));

function createConfig(overrides: Partial<RalphConfig> = {}): RalphConfig {
  return {
    managerSessionId: 'manager-1',
    planDocPath: 'RALPH.md',
    iterations: 10,
    promptTemplate: 'Prompt',
    permissionMode: 'full',
    model: null,
    agent: null,
    createdAt: 500,
    ...overrides,
  };
}

function createIteration(index: number, overrides: Partial<RalphIteration> = {}): RalphIteration {
  return {
    index,
    childSessionId: `child-${index}`,
    status: 'passed',
    startedAt: index * 100,
    endedAt: index * 100 + 50,
    filesChanged: [`src/file-${index}.ts`],
    verification: {
      lint: 'pass',
      typecheck: 'pass',
      test: 'pass',
    },
    note: `Iteration ${index}`,
    ...overrides,
  };
}

function createRun(config: RalphConfig, overrides: Partial<RalphRun> = {}): RalphRun {
  return {
    config,
    status: 'running',
    currentIteration: 0,
    iterations: [],
    updatedAt: 1_000,
    ...overrides,
  };
}

async function loadRalphStore() {
  return import('./ralph-store');
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  window.localStorage.clear();
  postMessage.mockReset();
});

describe('ralph store host-state mirror', () => {
  it('replaces the mirror with the host snapshot and tracks active runner ids', async () => {
    const { ralphStore } = await loadRalphStore();
    const config = createConfig();
    const staleConfig = createConfig({ managerSessionId: 'manager-stale' });

    ralphStore.startRun(staleConfig);
    ralphStore.applyHostState(
      { [config.managerSessionId]: createRun(config, { status: 'paused' }) },
      [config.managerSessionId]
    );

    expect(ralphStore.isRalphSession(config.managerSessionId)).toBe(true);
    expect(ralphStore.isRalphSession(staleConfig.managerSessionId)).toBe(false);
    expect(ralphStore.getRun(config.managerSessionId)?.status).toBe('paused');
    expect(ralphStore.isRunnerActive(config.managerSessionId)).toBe(true);
    expect(ralphStore.isRunnerActive(staleConfig.managerSessionId)).toBe(false);
  });

  it('does not persist mutations to localStorage', async () => {
    const { ralphStore } = await loadRalphStore();
    const config = createConfig();

    ralphStore.startRun(config);
    ralphStore.upsertIteration(config.managerSessionId, createIteration(1));
    ralphStore.setStatus(config.managerSessionId, 'paused');

    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('retains legacy localStorage runs until the host acknowledges persistence', async () => {
    const config = createConfig({ managerSessionId: 'manager-legacy' });
    window.localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ [config.managerSessionId]: createRun(config) })
    );

    const { ralphStore } = await loadRalphStore();
    const legacy = ralphStore.consumeLegacyRuns();

    expect(legacy?.[config.managerSessionId]?.config.managerSessionId).toBe('manager-legacy');
    expect(ralphStore.consumeLegacyRuns()).toEqual(legacy);
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();

    ralphStore.applyHostState(
      {
        [config.managerSessionId]: {
          ...createRun(config),
          legacyMigrationAcknowledged: true,
        },
      },
      []
    );

    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(ralphStore.consumeLegacyRuns()).toBeUndefined();
  });

  it('keeps rejected legacy runs after partial host adoption', async () => {
    const acceptedConfig = createConfig({ managerSessionId: 'manager-accepted' });
    const rejectedConfig = createConfig({ managerSessionId: 'manager-rejected' });
    window.localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        [acceptedConfig.managerSessionId]: createRun(acceptedConfig),
        [rejectedConfig.managerSessionId]: createRun(rejectedConfig),
      })
    );

    const { ralphStore } = await loadRalphStore();
    ralphStore.applyHostState(
      {
        [acceptedConfig.managerSessionId]: {
          ...createRun(acceptedConfig),
          legacyMigrationAcknowledged: true,
        },
      },
      []
    );

    expect(ralphStore.consumeLegacyRuns()).toEqual({
      [rejectedConfig.managerSessionId]: createRun(rejectedConfig),
    });
  });

  it('applies iteration and status mutations optimistically', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);

    const { ralphStore } = await loadRalphStore();
    const config = createConfig({ managerSessionId: 'manager-2' });
    const secondIteration = createIteration(2, {
      status: 'failed',
      verification: {
        lint: 'pass',
        typecheck: 'fail',
        test: 'pass',
      },
      note: 'Second iteration failed verification.',
    });
    const firstIteration = createIteration(1);

    ralphStore.startRun(config);

    now.mockReturnValue(2_000);
    ralphStore.upsertIteration(config.managerSessionId, secondIteration);

    now.mockReturnValue(3_000);
    ralphStore.upsertIteration(config.managerSessionId, firstIteration);

    now.mockReturnValue(4_000);
    ralphStore.setStatus(config.managerSessionId, 'paused');

    expect(ralphStore.getRun(config.managerSessionId)).toEqual({
      config,
      status: 'paused',
      currentIteration: 2,
      iterations: [firstIteration, secondIteration],
      updatedAt: 4_000,
    });

    ralphStore.removeRun(config.managerSessionId);
    expect(ralphStore.isRalphSession(config.managerSessionId)).toBe(false);
    expect(ralphStore.getAllRuns()).toEqual([]);
  });

  it('updates the run model locally and notifies the host', async () => {
    const { ralphStore } = await loadRalphStore();
    const config = createConfig({ managerSessionId: 'manager-3' });
    const model = { providerID: 'openai', modelID: 'gpt-5' };

    ralphStore.startRun(config);
    ralphStore.updateRunModel(config.managerSessionId, model);

    expect(ralphStore.getRun(config.managerSessionId)?.config.model).toEqual(model);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'ralph/update-model',
      payload: { managerSessionId: config.managerSessionId, model },
    });
  });

  it('grows the iteration budget with addIterations', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);

    const { ralphStore } = await loadRalphStore();
    const config = createConfig({ managerSessionId: 'manager-4', iterations: 5 });

    ralphStore.startRun(config);

    now.mockReturnValue(2_000);
    ralphStore.addIterations(config.managerSessionId, 5);

    expect(ralphStore.getRun(config.managerSessionId)).toEqual({
      config: { ...config, iterations: 10 },
      status: 'running',
      currentIteration: 0,
      iterations: [],
      updatedAt: 2_000,
    });

    ralphStore.addIterations(config.managerSessionId, 5_000);
    expect(ralphStore.getRun(config.managerSessionId)?.config.iterations).toBe(1_000);
  });
});

describe('ralph store findManagerSessionIdForChild', () => {
  it('returns the manager session id for a known iteration child session', async () => {
    const { ralphStore } = await loadRalphStore();
    const config = createConfig({ managerSessionId: 'manager-child-1' });
    ralphStore.startRun(config);
    ralphStore.upsertIteration(config.managerSessionId, createIteration(1));
    ralphStore.upsertIteration(config.managerSessionId, createIteration(2));

    expect(ralphStore.findManagerSessionIdForChild('child-2')).toBe('manager-child-1');
  });

  it('returns null when the child id is unknown or falsy', async () => {
    const { ralphStore } = await loadRalphStore();
    const config = createConfig({ managerSessionId: 'manager-child-2' });
    ralphStore.startRun(config);
    ralphStore.upsertIteration(config.managerSessionId, createIteration(1));

    expect(ralphStore.findManagerSessionIdForChild('not-a-child')).toBeNull();
    expect(ralphStore.findManagerSessionIdForChild(null)).toBeNull();
    expect(ralphStore.findManagerSessionIdForChild(undefined)).toBeNull();
  });
});
