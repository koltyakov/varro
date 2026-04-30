import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RalphConfig, RalphIteration } from '../../../shared/ralph';

const STORAGE_KEY = 'varro.ralph.runs';

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

async function loadRalphStore() {
  return import('./ralph-store');
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  window.localStorage.clear();
});

describe('ralph store persistence', () => {
  it('persists a started run and reloads it on boot', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    const { ralphStore } = await loadRalphStore();
    const config = createConfig();
    const expectedRun = {
      config,
      status: 'running' as const,
      currentIteration: 0,
      iterations: [],
      updatedAt: 1_000,
    };

    ralphStore.startRun(config);

    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')).toEqual({
      [config.managerSessionId]: expectedRun,
    });

    vi.resetModules();
    const { ralphStore: reloadedStore } = await loadRalphStore();

    expect(reloadedStore.isRalphSession(config.managerSessionId)).toBe(true);
    expect(reloadedStore.getRun(config.managerSessionId)).toEqual(expectedRun);
  });

  it('round-trips iteration updates and persisted removal', async () => {
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

    const expectedRun = {
      config,
      status: 'paused' as const,
      currentIteration: 2,
      iterations: [firstIteration, secondIteration],
      updatedAt: 4_000,
    };

    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')).toEqual({
      [config.managerSessionId]: expectedRun,
    });

    vi.resetModules();
    const { ralphStore: reloadedStore } = await loadRalphStore();

    expect(reloadedStore.getRun(config.managerSessionId)).toEqual(expectedRun);

    reloadedStore.removeRun(config.managerSessionId);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({}));

    vi.resetModules();
    const { ralphStore: afterRemovalStore } = await loadRalphStore();

    expect(afterRemovalStore.isRalphSession(config.managerSessionId)).toBe(false);
    expect(afterRemovalStore.getAllRuns()).toEqual([]);
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
