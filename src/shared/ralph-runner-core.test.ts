import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RALPH_INCOMPLETE_RESUME_ITERATION_INCREMENT,
  type RalphConfig,
  type RalphIteration,
  type RalphRun,
  type RalphStopReason,
} from './ralph';
import {
  createRalphRunner,
  type RalphMessageEntry,
  type RalphRunnerPorts,
  type RalphRunnerStore,
} from './ralph-runner-core';

function createConfig(overrides: Partial<RalphConfig> = {}): RalphConfig {
  return {
    managerSessionId: 'manager-1',
    planDocPath: 'RALPH.md',
    iterations: 10,
    promptTemplate: 'Prompt',
    permissionMode: 'full',
    model: null,
    agent: null,
    createdAt: 100,
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
    filesChanged: [],
    verification: {
      lint: 'pass',
      typecheck: 'pass',
      test: 'pass',
    },
    ...overrides,
  };
}

function createMemoryStore(): RalphRunnerStore & { runs: Record<string, RalphRun> } {
  const runs: Record<string, RalphRun> = {};
  return {
    runs,
    getRun: (id) => runs[id] ?? null,
    getAllRuns: () => Object.values(runs),
    startRun: (config) => {
      runs[config.managerSessionId] = {
        config,
        status: 'running',
        currentIteration: 0,
        iterations: [],
        updatedAt: Date.now(),
      };
    },
    setStatus: (id, status, stopReason?: RalphStopReason) => {
      const run = runs[id];
      if (!run) return;
      run.status = status;
      run.updatedAt = Date.now();
      if (stopReason !== undefined) run.stopReason = stopReason;
      else if (status === 'running' || status === 'paused') delete run.stopReason;
    },
    addIterations: (id, count) => {
      const run = runs[id];
      if (!run || count < 1) return;
      run.config = { ...run.config, iterations: run.config.iterations + Math.floor(count) };
    },
    upsertIteration: (id, iteration) => {
      const run = runs[id];
      if (!run) return;
      const existing = run.iterations.findIndex((entry) => entry.index === iteration.index);
      if (existing >= 0) run.iterations[existing] = iteration;
      else run.iterations.push(iteration);
      run.iterations.sort((a, b) => a.index - b.index);
      run.currentIteration = Math.max(run.currentIteration, iteration.index);
    },
  };
}

type Harness = {
  store: ReturnType<typeof createMemoryStore>;
  ports: RalphRunnerPorts;
  runner: ReturnType<typeof createRalphRunner>;
  createSession: ReturnType<typeof vi.fn>;
  sendPrompt: ReturnType<typeof vi.fn>;
  abortSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
  readWorkspaceFile: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
  emitIdle: (sessionID: string) => void;
  idleListenerCount: () => number;
};

function createHarness(overrides: Partial<RalphRunnerPorts> = {}): Harness {
  const store = createMemoryStore();
  const idleListeners = new Set<(sessionID: string) => void>();
  const createSession = vi.fn();
  const sendPrompt = vi.fn(async () => {});
  const abortSession = vi.fn(async () => {});
  const listSessions = vi.fn(async () => []);
  const listMessages = vi.fn(async () => [] as RalphMessageEntry[]);
  const readWorkspaceFile = vi.fn(async () => '# Plan\n- [ ] next chunk');
  const logError = vi.fn();

  const ports: RalphRunnerPorts = {
    store,
    createSession,
    sendPrompt,
    abortSession,
    listSessions,
    listMessages,
    onSessionIdle: (listener) => {
      idleListeners.add(listener);
      return () => idleListeners.delete(listener);
    },
    readWorkspaceFile,
    normalizeVariant: (_modelID, variant) => variant,
    logError,
    ...overrides,
  };
  return {
    store,
    ports,
    runner: createRalphRunner(ports),
    createSession,
    sendPrompt,
    abortSession,
    listSessions,
    listMessages,
    readWorkspaceFile,
    logError,
    emitIdle: (sessionID) => {
      for (const listener of idleListeners) listener(sessionID);
    },
    idleListenerCount: () => idleListeners.size,
  };
}

/** Wire sendPrompt so each prompt settles by emitting idle on a later tick. */
function settlePromptsViaIdle(harness: Harness, options?: { immediate?: boolean }) {
  harness.sendPrompt.mockImplementation(async (sid: string) => {
    if (options?.immediate) {
      // Idle fires before sendPrompt resolves - a fast child session.
      harness.emitIdle(sid);
      return;
    }
    setTimeout(() => harness.emitIdle(sid), 0);
  });
}

function assistantReport(text: string): RalphMessageEntry[] {
  return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text }] }];
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ralph runner stop conditions', () => {
  it('stops cleanly when the iteration limit is reached and the plan is complete', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });

    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] all done');
    harness.store.startRun(config);
    harness.store.upsertIteration(config.managerSessionId, createIteration(1));
    harness.store.setStatus(config.managerSessionId, 'paused');

    await harness.runner.resume(config.managerSessionId);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('done');
    expect(run?.stopReason).toBe('iteration_limit');
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('marks the run incomplete when the iteration limit is reached with outstanding plan items', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });

    // Default plan still has `- [ ]` items.
    harness.store.startRun(config);
    harness.store.upsertIteration(config.managerSessionId, createIteration(1));
    harness.store.setStatus(config.managerSessionId, 'paused');

    await harness.runner.resume(config.managerSessionId);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('incomplete');
    expect(run?.stopReason).toBe('iteration_limit_with_gap');
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('does not stop on consecutive passes when the plan still has unchecked items', async () => {
    const harness = createHarness();
    const config = createConfig();

    harness.store.startRun(config);
    harness.store.upsertIteration(config.managerSessionId, createIteration(1));
    harness.store.upsertIteration(config.managerSessionId, createIteration(2));
    harness.store.setStatus(config.managerSessionId, 'paused');

    // Make the next iteration fail-fast by having createSession reject so we
    // don't actually run a child iteration; we just need to observe that the
    // loop did NOT stop with status `done` immediately on resume.
    harness.createSession.mockRejectedValue(new Error('halt for assertion'));

    await harness.runner.resume(config.managerSessionId);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    // We attempted to start iteration 3 (proving consecutive-passes did not stop us).
    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect(harness.readWorkspaceFile).toHaveBeenCalledWith('RALPH.md');
  });

  it('does not stop on consecutive passes when a plan table still has unchecked items', async () => {
    const harness = createHarness();
    const config = createConfig();

    harness.readWorkspaceFile.mockResolvedValue(
      '# Plan\n| Done | Item |\n|---|---|\n| [ ] | settings.spec.ts |'
    );
    harness.store.startRun(config);
    harness.store.upsertIteration(config.managerSessionId, createIteration(1));
    harness.store.upsertIteration(config.managerSessionId, createIteration(2));
    harness.store.setStatus(config.managerSessionId, 'paused');

    harness.createSession.mockRejectedValue(new Error('halt for assertion'));

    await harness.runner.resume(config.managerSessionId);

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('failed');
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('continues after two consecutive passing iterations without a DONE marker', async () => {
    const harness = createHarness();
    const config = createConfig();

    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] all done');
    harness.store.startRun(config);
    harness.store.upsertIteration(config.managerSessionId, createIteration(1));
    harness.store.upsertIteration(config.managerSessionId, createIteration(2));
    harness.store.setStatus(config.managerSessionId, 'paused');

    harness.createSession.mockRejectedValue(new Error('halt for assertion'));

    await harness.runner.resume(config.managerSessionId);

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('failed');
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('marks the run incomplete when the iteration limit is reached with plain list items left', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });

    harness.readWorkspaceFile.mockResolvedValue(
      '# Plan\n- `src/extension/session.ts` - add coverage'
    );
    harness.store.startRun(config);
    harness.store.upsertIteration(config.managerSessionId, createIteration(1));
    harness.store.setStatus(config.managerSessionId, 'paused');

    await harness.runner.resume(config.managerSessionId);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('incomplete');
    expect(run?.stopReason).toBe('iteration_limit_with_gap');
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('adds more iterations before resuming an incomplete run', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });

    harness.store.startRun(config);
    harness.store.upsertIteration(config.managerSessionId, createIteration(1));
    harness.store.setStatus(config.managerSessionId, 'incomplete', 'iteration_limit_with_gap');

    harness.createSession.mockRejectedValue(new Error('halt for assertion'));

    await harness.runner.resume(config.managerSessionId);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.config.iterations).toBe(1 + RALPH_INCOMPLETE_RESUME_ITERATION_INCREMENT);
    expect(run?.status).toBe('failed');
    expect(run?.stopReason).toBe('iteration_error');
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('stops when the plan document starts with the DONE marker', async () => {
    const harness = createHarness();
    const config = createConfig();

    harness.readWorkspaceFile.mockResolvedValue('DONE\n\n# Ralph Loop');
    harness.store.startRun(config);
    harness.store.setStatus(config.managerSessionId, 'paused');

    await harness.runner.resume(config.managerSessionId);

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('done');
    expect(harness.readWorkspaceFile).toHaveBeenCalledWith('RALPH.md');
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('does not stop on DONE marker when last iteration still has a failed verdict', async () => {
    const harness = createHarness();
    const config = createConfig();

    harness.readWorkspaceFile.mockResolvedValue('DONE\n\n# Ralph Loop');
    harness.store.startRun(config);
    harness.store.upsertIteration(
      config.managerSessionId,
      createIteration(1, {
        status: 'failed',
        verification: { lint: 'pass', typecheck: 'fail', test: 'pass' },
      })
    );
    harness.store.setStatus(config.managerSessionId, 'paused');

    // Halt the loop after it tries to spawn the next iteration so we can
    // assert it did NOT stop on the DONE marker.
    harness.createSession.mockRejectedValue(new Error('halt for assertion'));

    await harness.runner.resume(config.managerSessionId);

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('failed');
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('does not stop on consecutive passes when the most recent iteration has a failed verdict', async () => {
    const harness = createHarness();
    const config = createConfig();

    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] all done');
    harness.store.startRun(config);
    harness.store.upsertIteration(config.managerSessionId, createIteration(1));
    harness.store.upsertIteration(
      config.managerSessionId,
      createIteration(2, {
        status: 'failed',
        verification: { lint: 'pass', typecheck: 'fail', test: 'pass' },
      })
    );
    harness.store.setStatus(config.managerSessionId, 'paused');

    harness.createSession.mockRejectedValue(new Error('halt for assertion'));

    await harness.runner.resume(config.managerSessionId);

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('failed');
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });
});

describe('ralph runner cancellation', () => {
  it('shuts down active loops without changing their resumable running state', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.createSession.mockResolvedValueOnce('child-1');

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.idleListenerCount()).toBe(1));

    await harness.runner.shutdown();
    await runPromise;

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('running');
    expect(run?.stopReason).toBeUndefined();
    expect(run?.iterations[0]?.status).toBe('running');
    expect(harness.abortSession).toHaveBeenCalledWith('child-1');
    expect(harness.idleListenerCount()).toBe(0);
    expect(harness.runner.activeIds()).toEqual([]);
  });

  it('stops without sending work when child creation finishes after cancellation', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    const childCreation = createDeferred<string>();
    harness.createSession.mockReturnValueOnce(childCreation.promise);

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.createSession).toHaveBeenCalledTimes(1));

    harness.runner.stop(config.managerSessionId);
    childCreation.resolve('child-1');
    await runPromise;

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('stopped');
    expect(run?.stopReason).toBe('manual_stop');
    expect(run?.iterations[0]?.status).toBe('aborted');
    expect(harness.abortSession).toHaveBeenCalledTimes(1);
    expect(harness.abortSession).toHaveBeenCalledWith('child-1');
    expect(harness.sendPrompt).not.toHaveBeenCalled();
    expect(harness.listMessages).not.toHaveBeenCalled();
    expect(harness.logError).not.toHaveBeenCalled();
  });

  it('stops after a plan read used to build the primary prompt', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    const promptPlanRead = createDeferred<string | null>();
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.readWorkspaceFile
      .mockResolvedValueOnce('# Plan\n- [ ] next chunk')
      .mockReturnValueOnce(promptPlanRead.promise);

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.readWorkspaceFile).toHaveBeenCalledTimes(2));

    harness.runner.stop(config.managerSessionId);
    promptPlanRead.resolve('# Plan\n- [ ] next chunk');
    await runPromise;

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('stopped');
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]?.status).toBe('aborted');
    expect(harness.sendPrompt).not.toHaveBeenCalled();
    expect(harness.abortSession).toHaveBeenCalledTimes(1);
    expect(harness.abortSession).toHaveBeenCalledWith('child-1');
  });

  it('stops after an in-flight primary prompt send without starting verification', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    const promptSend = createDeferred();
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.sendPrompt.mockReturnValueOnce(promptSend.promise);

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(1));

    harness.runner.stop(config.managerSessionId);
    promptSend.resolve();
    await runPromise;

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('stopped');
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]?.status).toBe('aborted');
    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);
    expect(harness.listMessages).not.toHaveBeenCalled();
    expect(harness.abortSession).toHaveBeenCalledWith('child-1');
  });

  it('cancels an idle wait immediately on stop', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.createSession.mockResolvedValueOnce('child-1');

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(1));

    harness.runner.stop(config.managerSessionId);
    await runPromise;

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('stopped');
    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);
    expect(harness.listMessages).not.toHaveBeenCalled();
    expect(harness.runner.isActive(config.managerSessionId)).toBe(false);
  });

  it('stops during verification without summarizing or launching repair work', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.createSession.mockResolvedValueOnce('child-1');
    let sendCount = 0;
    harness.sendPrompt.mockImplementation(async (sessionId: string) => {
      sendCount += 1;
      if (sendCount === 1) harness.emitIdle(sessionId);
    });

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(2));

    harness.runner.stop(config.managerSessionId);
    await runPromise;

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('stopped');
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]?.status).toBe('aborted');
    expect(harness.listMessages).not.toHaveBeenCalled();
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('stops while the primary iteration summary is being read', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    const sessionList = createDeferred<[]>();
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.listSessions.mockReturnValueOnce(sessionList.promise);
    settlePromptsViaIdle(harness);

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.listSessions).toHaveBeenCalledTimes(1));

    harness.runner.stop(config.managerSessionId);
    sessionList.resolve([]);
    await runPromise;

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('stopped');
    expect(harness.listMessages).not.toHaveBeenCalled();
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('stops when repair child creation finishes after cancellation', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    const repairCreation = createDeferred<string>();
    harness.createSession
      .mockResolvedValueOnce('child-1')
      .mockReturnValueOnce(repairCreation.promise);
    harness.listMessages.mockResolvedValue(
      assistantReport('Still broken.\nlint: PASS\ntypecheck: FAIL\ntest: PASS')
    );
    settlePromptsViaIdle(harness);

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.createSession).toHaveBeenCalledTimes(2));

    harness.runner.stop(config.managerSessionId);
    repairCreation.resolve('repair-1');
    await runPromise;

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('stopped');
    expect(harness.sendPrompt).toHaveBeenCalledTimes(2);
    expect(harness.sendPrompt.mock.calls.every(([sessionId]) => sessionId === 'child-1')).toBe(
      true
    );
    expect(harness.abortSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'child-1',
      'repair-1',
    ]);
    expect(harness.logError).not.toHaveBeenCalled();
  });

  it('stops during repair execution without sending repair verification', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    const repairSend = createDeferred();
    harness.createSession.mockResolvedValueOnce('child-1').mockResolvedValueOnce('repair-1');
    harness.listMessages.mockResolvedValue(
      assistantReport('Still broken.\nlint: PASS\ntypecheck: FAIL\ntest: PASS')
    );
    harness.sendPrompt.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'repair-1') return repairSend.promise;
      setTimeout(() => harness.emitIdle(sessionId), 0);
    });

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(3));

    harness.runner.stop(config.managerSessionId);
    repairSend.resolve();
    await runPromise;

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('stopped');
    expect(harness.sendPrompt).toHaveBeenCalledTimes(3);
    expect(harness.abortSession).toHaveBeenCalledWith('repair-1');
    expect(harness.createSession).toHaveBeenCalledTimes(2);
  });

  it('stops during repair verification without starting another repair', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.createSession.mockResolvedValueOnce('child-1').mockResolvedValueOnce('repair-1');
    harness.listMessages.mockResolvedValue(
      assistantReport('Still broken.\nlint: PASS\ntypecheck: FAIL\ntest: PASS')
    );
    let sendCount = 0;
    harness.sendPrompt.mockImplementation(async (sessionId: string) => {
      sendCount += 1;
      if (sendCount < 4) harness.emitIdle(sessionId);
    });

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(4));

    harness.runner.stop(config.managerSessionId);
    await runPromise;

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('stopped');
    expect(harness.sendPrompt).toHaveBeenCalledTimes(4);
    expect(harness.createSession).toHaveBeenCalledTimes(2);
    expect(harness.abortSession).toHaveBeenCalledWith('repair-1');
  });

  it('fails with session context when the idle event is lost', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ idleTimeoutMs: 25 });
    const config = createConfig({ iterations: 1 });
    harness.createSession.mockResolvedValueOnce('child-1');

    const runPromise = harness.runner.start(config);
    await flushMicrotasks();
    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25);
    await runPromise;

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    expect(run?.stopReason).toBe('iteration_error');
    expect(harness.abortSession).toHaveBeenCalledTimes(1);
    expect(harness.abortSession).toHaveBeenCalledWith('child-1');
    expect(run?.iterations[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        note: expect.stringContaining(
          'Ralph session child-1 did not become idle within 25ms after a prompt'
        ),
      })
    );
    expect(harness.logError).toHaveBeenCalledWith(
      'iteration 1 failed',
      expect.objectContaining({ message: expect.stringContaining('child-1') })
    );
  });
});

describe('ralph runner iteration repair', () => {
  it('does not get stuck when the child session becomes idle before sendPrompt resolves', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });

    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] all done');
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.listMessages.mockResolvedValue(
      assistantReport('Finished quickly.\nlint: PASS\ntypecheck: PASS\ntest: PASS')
    );
    settlePromptsViaIdle(harness, { immediate: true });

    await harness.runner.start(config);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('done');
    expect(run?.stopReason).toBe('iteration_limit');
    expect(run?.iterations).toHaveLength(1);
    expect(run?.iterations[0]).toEqual(
      expect.objectContaining({
        status: 'passed',
        childSessionId: 'child-1',
        verification: {
          lint: 'pass',
          typecheck: 'pass',
          test: 'pass',
        },
      })
    );
  });

  it('marks an iteration failed when the final assistant text is a usage-limit interruption without verdicts', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });

    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [ ] next chunk');
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.listMessages.mockResolvedValue(assistantReport('The usage limit has been reached'));
    settlePromptsViaIdle(harness);

    await harness.runner.start(config);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('incomplete');
    expect(run?.stopReason).toBe('iteration_limit_with_gap');
    expect(run?.iterations[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        note: 'The usage limit has been reached',
        verification: {},
      })
    );
  });

  it('sends parent-driven verification follow-up and spawns a repair sub-agent on failure', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });

    // Plan is already complete so the iteration_limit exit is clean once the
    // iteration repair settles.
    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] all done');
    harness.createSession.mockResolvedValueOnce('child-1').mockResolvedValueOnce('repair-1');

    // Messages snapshot per session - keyed by sessionId so the order of
    // calls (work / verify / repair / verify) doesn't matter.
    const messagesBySession: Record<string, RalphMessageEntry[]> = {
      'child-1': assistantReport(
        'Implemented first chunk.\nlint: PASS\ntypecheck: FAIL\ntest: PASS'
      ),
      'repair-1': assistantReport(
        'Fixed the typecheck issue.\nlint: PASS\ntypecheck: PASS\ntest: PASS'
      ),
    };
    harness.listMessages.mockImplementation(async (sid: string) => messagesBySession[sid] ?? []);
    settlePromptsViaIdle(harness);

    await harness.runner.start(config);

    // 1 iteration session + 1 repair session.
    expect(harness.createSession).toHaveBeenCalledTimes(2);

    // Per session: 1 work prompt + 1 verification follow-up = 2 sends each.
    // Total = 4 sends across both sessions.
    expect(harness.sendPrompt).toHaveBeenCalledTimes(4);

    const sendsBySession = new Map<string, string[]>();
    for (const call of harness.sendPrompt.mock.calls) {
      const [sid, body] = call as [string, { parts: Array<{ type: string; text: string }> }];
      const text = body.parts[0]?.text ?? '';
      const list = sendsBySession.get(sid) ?? [];
      list.push(text);
      sendsBySession.set(sid, list);
    }

    expect(sendsBySession.get('child-1')?.[1]).toContain(
      'Ralph manager is requesting verification'
    );
    expect(sendsBySession.get('repair-1')?.[0]).toContain('Ralph repair sub-agent for iteration');
    expect(sendsBySession.get('repair-1')?.[1]).toContain(
      'Ralph manager is requesting verification'
    );

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('done');
    expect(run?.iterations).toHaveLength(1);
    expect(run?.iterations[0]).toEqual(
      expect.objectContaining({
        index: 1,
        status: 'passed',
        childSessionId: 'child-1',
        verification: {
          lint: 'pass',
          typecheck: 'pass',
          test: 'pass',
        },
        repairSessionIds: ['repair-1'],
      })
    );
  });

  it('keeps the iteration failed after exhausting repair sub-agent attempts', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });

    harness.createSession
      .mockResolvedValueOnce('child-1')
      .mockResolvedValueOnce('repair-1')
      .mockResolvedValueOnce('repair-2');

    harness.listMessages.mockResolvedValue(
      assistantReport('Still broken.\nlint: PASS\ntypecheck: FAIL\ntest: PASS')
    );
    settlePromptsViaIdle(harness);

    await harness.runner.start(config);

    // 1 iteration session + 2 repair sub-agent attempts.
    expect(harness.createSession).toHaveBeenCalledTimes(3);
    // 2 sends per session (work + verify) × 3 sessions = 6.
    expect(harness.sendPrompt).toHaveBeenCalledTimes(6);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('incomplete');
    expect(run?.stopReason).toBe('iteration_limit_with_gap');
    expect(run?.iterations).toHaveLength(1);
    expect(run?.iterations[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        verification: {
          lint: 'pass',
          typecheck: 'fail',
          test: 'pass',
        },
        repairSessionIds: ['repair-1', 'repair-2'],
      })
    );
  });

  it('tracks active runs while the loop is executing', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });

    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] all done');
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.listMessages.mockResolvedValue(assistantReport('lint: PASS'));

    let activeDuringRun = false;
    harness.sendPrompt.mockImplementation(async (sid: string) => {
      activeDuringRun = harness.runner.isActive(config.managerSessionId);
      setTimeout(() => harness.emitIdle(sid), 0);
    });

    await harness.runner.start(config);

    expect(activeDuringRun).toBe(true);
    expect(harness.runner.isActive(config.managerSessionId)).toBe(false);
    expect(harness.runner.activeIds()).toEqual([]);
  });
});
