/* oxlint-disable anti-slop/no-module-mocking -- These tests observe the protocol proxy against a stubbed bridge and mirror store. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RalphConfig, RalphStatus } from '../../../shared/ralph';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
  isRunnerActive: vi.fn(() => false),
  startRun: vi.fn(),
  setStatus: vi.fn(),
  getRun: vi.fn(),
  consumeLegacyRuns: vi.fn(),
}));

vi.mock('../../lib/bridge', () => ({ postMessage: mocks.postMessage }));
vi.mock('../../lib/stores/ralph-store', () => ({
  ralphStore: {
    isRunnerActive: mocks.isRunnerActive,
    startRun: mocks.startRun,
    setStatus: mocks.setStatus,
    getRun: mocks.getRun,
    consumeLegacyRuns: mocks.consumeLegacyRuns,
  },
}));

import { ralphRunner } from './ralph-runner';

const CONFIG: RalphConfig = {
  managerSessionId: 'manager-1',
  workspaceDirectory: '/workspace',
  planDocPath: 'PLAN.md',
  iterations: 3,
  promptTemplate: 'continue',
  permissionMode: 'auto',
  model: null,
  agent: null,
  createdAt: 1_700_000_000_000,
};

afterEach(() => {
  vi.clearAllMocks();
  mocks.isRunnerActive.mockReturnValue(false);
});

describe('ralphRunner', () => {
  it('reads activity from the mirror store', () => {
    mocks.isRunnerActive.mockReturnValue(true);
    expect(ralphRunner.isActive('manager-1')).toBe(true);
    expect(mocks.isRunnerActive).toHaveBeenCalledWith('manager-1');
  });

  it('mirrors a start optimistically before forwarding it to the host', async () => {
    await ralphRunner.start(CONFIG);

    expect(mocks.startRun).toHaveBeenCalledWith(CONFIG);
    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: 'ralph/start',
      payload: { config: CONFIG },
    });
  });

  it('mirrors a manual stop with its stop reason', () => {
    ralphRunner.stop('manager-1');

    expect(mocks.setStatus).toHaveBeenCalledWith('manager-1', 'stopped', 'manual_stop');
    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: 'ralph/stop',
      payload: { managerSessionId: 'manager-1' },
    });
  });

  it('mirrors a pause', () => {
    ralphRunner.pause('manager-1');

    expect(mocks.setStatus).toHaveBeenCalledWith('manager-1', 'paused');
    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: 'ralph/pause',
      payload: { managerSessionId: 'manager-1' },
    });
  });

  it('does nothing when resuming a run the mirror does not know', async () => {
    mocks.getRun.mockReturnValue(null);

    await ralphRunner.resume('manager-1');

    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it.each(['paused', 'failed', 'incomplete'] as const)(
    'resumes a %s run',
    async (status: RalphStatus) => {
      mocks.getRun.mockReturnValue({ status });

      await ralphRunner.resume('manager-1');

      expect(mocks.setStatus).toHaveBeenCalledWith('manager-1', 'running');
      expect(mocks.postMessage).toHaveBeenCalledWith({
        type: 'ralph/resume',
        payload: { managerSessionId: 'manager-1' },
      });
    }
  );

  it.each(['running', 'stopped', 'done'] as const)(
    'refuses to resume a %s run',
    async (status: RalphStatus) => {
      mocks.getRun.mockReturnValue({ status });

      await ralphRunner.resume('manager-1');

      expect(mocks.setStatus).not.toHaveBeenCalled();
      expect(mocks.postMessage).not.toHaveBeenCalled();
    }
  );

  it('hands legacy webview runs to the host during reattach', () => {
    const legacyRuns = { 'manager-1': { config: CONFIG, status: 'paused', iterations: [] } };
    mocks.consumeLegacyRuns.mockReturnValue(legacyRuns);

    ralphRunner.reattachAll();

    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: 'ralph/sync',
      payload: { legacyRuns },
    });
  });

  it('syncs with an empty payload when there is nothing to migrate', () => {
    mocks.consumeLegacyRuns.mockReturnValue(undefined);

    ralphRunner.reattachAll();

    expect(mocks.postMessage).toHaveBeenCalledWith({ type: 'ralph/sync', payload: {} });
  });
});
