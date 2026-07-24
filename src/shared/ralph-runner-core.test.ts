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
  type RalphSessionStatus,
} from './ralph-runner-core';

function createConfig(overrides: Partial<RalphConfig> = {}): RalphConfig {
  return {
    managerSessionId: 'manager-1',
    workspaceDirectory: '/workspace',
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
    setStatus: (id, status, stopReason?: RalphStopReason, note?: string) => {
      const run = runs[id];
      if (!run) return;
      run.status = status;
      run.updatedAt = Date.now();
      if (stopReason !== undefined) run.stopReason = stopReason;
      else if (status === 'running' || status === 'paused') delete run.stopReason;
      if (note !== undefined) run.note = note;
      else if (status === 'running') delete run.note;
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
  getSessionStatus: ReturnType<typeof vi.fn>;
  readWorkspaceFile: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
  emitIdle: (sessionID: string) => void;
  emitStatus: (sessionID: string, status: RalphSessionStatus) => void;
  idleListenerCount: () => number;
};

function createHarness(overrides: Partial<RalphRunnerPorts> = {}): Harness {
  const store = createMemoryStore();
  const idleListeners = new Set<(sessionID: string, status: RalphSessionStatus) => void>();
  const createSession = vi.fn();
  const sendPrompt = vi.fn(async () => {});
  const abortSession = vi.fn(async () => {});
  const listSessions = vi.fn(async () => []);
  const listMessages = vi.fn(async () => [] as RalphMessageEntry[]);
  const getSessionStatus = vi.fn(async () => ({ type: 'active' }) as const);
  const readWorkspaceFile = vi.fn(async () => '# Plan\n- [ ] next chunk');
  const logError = vi.fn();

  const ports: RalphRunnerPorts = {
    store,
    createSession,
    sendPrompt,
    abortSession,
    listSessions,
    listMessages,
    getSessionStatus,
    onSessionStatus: (listener) => {
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
    getSessionStatus,
    readWorkspaceFile,
    logError,
    emitIdle: (sessionID) => {
      for (const listener of idleListeners) listener(sessionID, { type: 'idle' });
    },
    emitStatus: (sessionID, status) => {
      for (const listener of idleListeners) listener(sessionID, status);
    },
    idleListenerCount: () => idleListeners.size,
  };
}

/** Wire sendPrompt so each prompt settles by emitting idle on a later tick. */
function settlePromptsViaIdle(harness: Harness, options?: { immediate?: boolean }) {
  harness.sendPrompt.mockImplementation(async (sid: string, body: { messageID: string }) => {
    harness.emitStatus(sid, { type: 'admitted', messageID: body.messageID });
    harness.emitStatus(sid, { type: 'completed', messageID: body.messageID });
    if (options?.immediate) {
      // Idle fires before sendPrompt resolves - a fast child session.
      harness.emitIdle(sid);
      return;
    }
    setTimeout(() => harness.emitIdle(sid), 0);
  });
}

function admitAndIdle(harness: Harness, sessionID: string, messageID: string): void {
  harness.emitStatus(sessionID, { type: 'admitted', messageID });
  harness.emitStatus(sessionID, { type: 'completed', messageID });
  harness.emitIdle(sessionID);
}

function assistantReport(text: string): RalphMessageEntry[] {
  return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text }] }];
}

function completedVerificationReport(text: string): RalphMessageEntry[] {
  return [
    {
      info: { role: 'user', time: { created: 200 } },
      parts: [{ type: 'text', text: 'Ralph manager is requesting verification.' }],
    },
    {
      info: { role: 'assistant', time: { created: 300 } },
      parts: [{ type: 'text', text }],
    },
  ];
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
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
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
    expect(harness.readWorkspaceFile).toHaveBeenCalledWith(
      'RALPH.md',
      expect.any(AbortSignal),
      '/workspace'
    );
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
    expect(harness.readWorkspaceFile).toHaveBeenCalledWith(
      'RALPH.md',
      expect.any(AbortSignal),
      '/workspace'
    );
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
  it.each([
    'readWorkspaceFile',
    'createSession',
    'sendPrompt',
    'getSessionStatus',
    'listSessions',
    'listMessages',
    'abortSession',
  ] as const)('does not let a never-settling %s port hang shutdown', async (blockedPort) => {
    const never = new Promise<never>(() => {});
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] done');
    harness.createSession.mockResolvedValue('child-1');
    harness.getSessionStatus.mockResolvedValue({ type: 'active' });
    harness.listMessages.mockResolvedValue(completedVerificationReport('lint: PASS'));

    if (blockedPort === 'readWorkspaceFile') harness.readWorkspaceFile.mockReturnValueOnce(never);
    if (blockedPort === 'createSession') harness.createSession.mockReturnValueOnce(never);
    if (blockedPort === 'sendPrompt') harness.sendPrompt.mockReturnValueOnce(never);
    if (blockedPort === 'getSessionStatus') {
      harness.getSessionStatus.mockReturnValueOnce(never);
    }
    if (blockedPort === 'listSessions') harness.listSessions.mockReturnValueOnce(never);
    if (blockedPort === 'listMessages') harness.listMessages.mockReturnValueOnce(never);
    if (blockedPort === 'abortSession') harness.abortSession.mockReturnValue(never);

    if (blockedPort === 'listSessions' || blockedPort === 'listMessages') {
      settlePromptsViaIdle(harness, { immediate: true });
    }

    const runPromise = harness.runner.start(config);
    const blockedMock = harness[blockedPort];
    if (blockedPort === 'abortSession') {
      await vi.waitFor(() => expect(harness.idleListenerCount()).toBe(1));
    } else {
      await vi.waitFor(() => expect(blockedMock).toHaveBeenCalled());
    }

    await expect(harness.runner.shutdown()).resolves.toBeUndefined();
    await expect(runPromise).resolves.toBeUndefined();
    if (blockedPort === 'abortSession') expect(blockedMock).toHaveBeenCalled();
    expect(harness.runner.activeIds()).toEqual([]);
  });

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
    expect(harness.abortSession).toHaveBeenCalledWith(
      'child-1',
      expect.any(AbortSignal),
      '/workspace'
    );
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
    expect(harness.abortSession).toHaveBeenCalledWith(
      'child-1',
      expect.any(AbortSignal),
      '/workspace'
    );
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
    expect(harness.abortSession).toHaveBeenCalledWith(
      'child-1',
      expect.any(AbortSignal),
      '/workspace'
    );
  });

  it('retries abort after an in-flight prompt settles following cancellation', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    const promptSend = createDeferred();
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.sendPrompt.mockReturnValueOnce(promptSend.promise);
    harness.abortSession
      .mockRejectedValueOnce(new Error('abort transport failed'))
      .mockResolvedValueOnce(undefined);

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(1));

    harness.runner.stop(config.managerSessionId);
    promptSend.resolve();
    await runPromise;

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('stopped');
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]?.status).toBe('aborted');
    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);
    expect(harness.listMessages).not.toHaveBeenCalled();
    expect(harness.abortSession).toHaveBeenCalledTimes(2);
    expect(harness.logError).toHaveBeenCalledWith(
      'session child-1 abort failed',
      expect.objectContaining({ message: 'abort transport failed' })
    );
  });

  it('re-aborts after an in-flight prompt settles following cancellation', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    const promptSend = createDeferred();
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.sendPrompt.mockReturnValueOnce(promptSend.promise);

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(1));

    harness.runner.stop(config.managerSessionId);
    await vi.waitFor(() => expect(harness.abortSession).toHaveBeenCalledTimes(1));
    promptSend.resolve();
    await runPromise;

    expect(harness.abortSession).toHaveBeenCalledTimes(2);
    expect(harness.abortSession.mock.calls.every(([sessionID]) => sessionID === 'child-1')).toBe(
      true
    );
  });

  it('retries a failed child abort during cancellation cleanup', async () => {
    const harness = createHarness({ cleanupTimeoutMs: 5 });
    const config = createConfig({ iterations: 1 });
    const promptSend = createDeferred();
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.sendPrompt.mockReturnValueOnce(promptSend.promise);
    harness.abortSession
      .mockRejectedValueOnce(new Error('abort transport failed'))
      .mockResolvedValueOnce(undefined);

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(1));

    harness.runner.stop(config.managerSessionId);
    await runPromise;

    expect(harness.abortSession).toHaveBeenCalledTimes(2);
    expect(harness.logError).toHaveBeenCalledWith(
      'session child-1 abort failed',
      expect.objectContaining({ message: 'abort transport failed' })
    );
  });

  it('aborts the current child when prompt admission fails ambiguously', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.sendPrompt.mockRejectedValueOnce(new Error('connection closed after request write'));

    await harness.runner.start(config);

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('failed');
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]?.note).toContain(
      'connection closed after request write'
    );
    expect(harness.abortSession).toHaveBeenCalledWith(
      'child-1',
      expect.any(AbortSignal),
      '/workspace'
    );
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
    harness.sendPrompt.mockImplementation(
      async (sessionId: string, body: { messageID: string }) => {
        sendCount += 1;
        if (sendCount === 1) admitAndIdle(harness, sessionId, body.messageID);
      }
    );

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
    harness.sendPrompt.mockImplementation(
      async (sessionId: string, body: { messageID: string }) => {
        if (sessionId === 'repair-1') return repairSend.promise;
        setTimeout(() => admitAndIdle(harness, sessionId, body.messageID), 0);
      }
    );

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(3));

    harness.runner.stop(config.managerSessionId);
    repairSend.resolve();
    await runPromise;

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('stopped');
    expect(harness.sendPrompt).toHaveBeenCalledTimes(3);
    expect(harness.abortSession).toHaveBeenCalledWith(
      'repair-1',
      expect.any(AbortSignal),
      '/workspace'
    );
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
    harness.sendPrompt.mockImplementation(
      async (sessionId: string, body: { messageID: string }) => {
        sendCount += 1;
        if (sendCount < 4) admitAndIdle(harness, sessionId, body.messageID);
      }
    );

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(4));

    harness.runner.stop(config.managerSessionId);
    await runPromise;

    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('stopped');
    expect(harness.sendPrompt).toHaveBeenCalledTimes(4);
    expect(harness.createSession).toHaveBeenCalledTimes(2);
    expect(harness.abortSession).toHaveBeenCalledWith(
      'repair-1',
      expect.any(AbortSignal),
      '/workspace'
    );
  });

  it('fails with session context when the idle event is lost', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ idleTimeoutMs: 25 });
    const config = createConfig({ iterations: 1 });
    harness.createSession.mockResolvedValueOnce('child-1');

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(25);
    await runPromise;

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    expect(run?.stopReason).toBe('iteration_error');
    expect(harness.abortSession).toHaveBeenCalledTimes(1);
    expect(harness.abortSession).toHaveBeenCalledWith(
      'child-1',
      expect.any(AbortSignal),
      '/workspace'
    );
    expect(run?.iterations[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        note: expect.stringContaining(
          'Ralph session child-1 did not provide confirmed prompt completion within 25ms'
        ),
      })
    );
    expect(harness.logError).toHaveBeenCalledWith(
      'iteration 1 failed',
      expect.objectContaining({ message: expect.stringContaining('child-1') })
    );
  });

  it('generates lexically increasing OpenCode message ids for rapid prompts', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] done');
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.listMessages.mockResolvedValue(assistantReport('lint: PASS'));
    settlePromptsViaIdle(harness, { immediate: true });

    await harness.runner.start(config);

    const messageIDs = harness.sendPrompt.mock.calls.map(([, body]) => body.messageID as string);
    expect(messageIDs).toHaveLength(2);
    expect(messageIDs.every((id) => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id))).toBe(true);
    expect(messageIDs[1]! > messageIDs[0]!).toBe(true);
  });

  it('does not accept a completed assistant from an older prompt', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] done');
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.listMessages.mockResolvedValue(assistantReport('lint: PASS'));
    let firstPromptMessageID = '';
    let sendCount = 0;
    harness.sendPrompt.mockImplementation(
      async (sessionID: string, body: { messageID: string }) => {
        sendCount += 1;
        if (sendCount > 1) {
          admitAndIdle(harness, sessionID, body.messageID);
          return;
        }
        firstPromptMessageID = body.messageID;
        harness.emitStatus(sessionID, { type: 'admitted', messageID: body.messageID });
        harness.emitStatus(sessionID, {
          type: 'completed',
          messageID: 'msg_00000000000100000000000000',
        });
        harness.emitIdle(sessionID);
      }
    );

    const runPromise = harness.runner.start(config);
    await vi.waitFor(() => expect(harness.sendPrompt).toHaveBeenCalledTimes(1));
    await flushMicrotasks();
    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);

    harness.emitStatus('child-1', { type: 'completed', messageID: firstPromptMessageID });
    await runPromise;

    expect(harness.sendPrompt).toHaveBeenCalledTimes(2);
    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('done');
  });

  it('fails the iteration when the matching assistant completes with an error', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.sendPrompt.mockImplementation(
      async (sessionID: string, body: { messageID: string }) => {
        harness.emitStatus(sessionID, { type: 'admitted', messageID: body.messageID });
        harness.emitStatus(sessionID, {
          type: 'completed',
          messageID: body.messageID,
          error: 'provider quota exhausted',
        });
      }
    );

    await harness.runner.start(config);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    expect(run?.iterations[0]?.note).toContain(
      'Ralph session child-1 assistant failed for the current prompt: provider quota exhausted'
    );
    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);
    expect(harness.abortSession).toHaveBeenCalledWith(
      'child-1',
      expect.any(AbortSignal),
      '/workspace'
    );
  });

  it('polls authoritative status when idle SSE delivery is lost', async () => {
    vi.useFakeTimers();
    let statusCall = 0;
    const harness = createHarness({ idlePollIntervalMs: 10 });
    const config = createConfig({ iterations: 1 });
    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] done');
    harness.createSession.mockResolvedValueOnce('child-1');
    let currentPromptMessageID = '';
    harness.sendPrompt.mockImplementation(
      async (_sessionID: string, body: { messageID: string }) => {
        currentPromptMessageID = body.messageID;
      }
    );
    harness.listMessages.mockImplementation(async () => [
      {
        info: {
          role: 'assistant',
          parentID: currentPromptMessageID,
          time: { created: 1, completed: 2 },
        },
        parts: [{ type: 'text', text: 'lint: PASS' }],
      },
    ]);
    harness.getSessionStatus.mockImplementation(async () => {
      statusCall += 1;
      return statusCall % 2 === 0 ? { type: 'idle' } : { type: 'active' };
    });

    const runPromise = harness.runner.start(config);
    await vi.advanceTimersByTimeAsync(20);
    await runPromise;

    expect(harness.getSessionStatus).toHaveBeenCalledTimes(4);
    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('done');
    expect(harness.idleListenerCount()).toBe(0);
  });

  it('waits for admission when prompt admission is delayed beyond 250ms', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ idlePollIntervalMs: 10 });
    const config = createConfig({ iterations: 1 });
    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] done');
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.getSessionStatus.mockResolvedValue({ type: 'idle' });
    harness.listMessages.mockResolvedValue(assistantReport('lint: PASS'));
    harness.sendPrompt.mockImplementation(
      async (sessionID: string, body: { messageID: string }) => {
        setTimeout(() => admitAndIdle(harness, sessionID, body.messageID), 300);
      }
    );

    const runPromise = harness.runner.start(config);
    await flushMicrotasks();
    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(299);
    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.sendPrompt).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(300);
    await runPromise;
    expect(harness.store.getRun(config.managerSessionId)?.status).toBe('done');
  });

  it('fails immediately with child context on a terminal status', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.getSessionStatus.mockResolvedValue({
      type: 'error',
      message: 'provider credentials expired',
    });

    await harness.runner.start(config);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    expect(run?.iterations[0]?.note).toContain(
      'Ralph session child-1 failed while waiting for idle: provider credentials expired'
    );
  });
});

describe('ralph runner restart safety', () => {
  it('reattaches an active persisted child without creating duplicate work', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] done');
    harness.listMessages.mockResolvedValue(assistantReport('lint: PASS'));
    settlePromptsViaIdle(harness, { immediate: true });
    harness.store.startRun(config);
    harness.store.upsertIteration(
      config.managerSessionId,
      createIteration(1, { status: 'running', phase: 'primary', endedAt: null })
    );

    harness.runner.reattachAll();
    await vi.waitFor(() => expect(harness.idleListenerCount()).toBe(1));
    expect(harness.createSession).not.toHaveBeenCalled();

    harness.emitIdle('child-1');
    await vi.waitFor(() =>
      expect(harness.store.getRun(config.managerSessionId)?.status).toBe('done')
    );

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.sendPrompt).toHaveBeenCalledWith(
      'child-1',
      expect.objectContaining({
        parts: [
          expect.objectContaining({ text: expect.stringContaining('requesting verification') }),
        ],
      }),
      expect.any(AbortSignal),
      '/workspace'
    );
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]?.status).toBe('passed');
  });

  it('settles an already-idle persisted child without replacing its reference', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] done');
    harness.getSessionStatus.mockResolvedValue({ type: 'idle' });
    harness.listMessages.mockResolvedValue(completedVerificationReport('lint: PASS'));
    harness.store.startRun(config);
    harness.store.upsertIteration(
      config.managerSessionId,
      createIteration(1, { status: 'running', phase: 'verification', endedAt: null })
    );

    harness.runner.reattachAll();
    await vi.waitFor(() =>
      expect(harness.store.getRun(config.managerSessionId)?.status).toBe('done')
    );

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.sendPrompt).not.toHaveBeenCalled();
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]?.childSessionId).toBe(
      'child-1'
    );
  });

  it('fails a recovered iteration when its child is missing', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.getSessionStatus.mockResolvedValue({ type: 'missing' });
    harness.store.startRun(config);
    harness.store.upsertIteration(
      config.managerSessionId,
      createIteration(1, { status: 'running', phase: 'verification', endedAt: null })
    );

    harness.runner.reattachAll();
    await vi.waitFor(() =>
      expect(harness.store.getRun(config.managerSessionId)?.status).toBe('failed')
    );

    expect(harness.listMessages).not.toHaveBeenCalled();
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]?.note).toContain(
      'missing from the authoritative status snapshot'
    );
  });

  it('resumes verification when restart occurred before its prompt was admitted', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    let verificationRequested = false;
    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] done');
    harness.getSessionStatus.mockResolvedValue({ type: 'idle' });
    harness.listMessages.mockImplementation(async () =>
      verificationRequested
        ? assistantReport('lint: PASS')
        : assistantReport('Primary work is complete.')
    );
    harness.sendPrompt.mockImplementation(
      async (sessionId: string, body: { messageID: string }) => {
        verificationRequested = true;
        admitAndIdle(harness, sessionId, body.messageID);
      }
    );
    harness.store.startRun(config);
    harness.store.upsertIteration(
      config.managerSessionId,
      createIteration(1, { status: 'running', phase: 'verification', endedAt: null })
    );

    harness.runner.reattachAll();
    await vi.waitFor(() =>
      expect(harness.store.getRun(config.managerSessionId)?.status).toBe('done')
    );

    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]).toEqual(
      expect.objectContaining({ phase: 'verification', status: 'passed' })
    );
  });

  it('resumes persisted verification when its admitted prompt has no later response', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    let verificationResumed = false;
    const admittedWithoutResponse: RalphMessageEntry[] = [
      {
        info: { role: 'assistant', time: { created: 100 } },
        parts: [{ type: 'text', text: 'Primary output.\nlint: PASS' }],
      },
      {
        info: { role: 'user', time: { created: 200 } },
        parts: [{ type: 'text', text: 'Ralph manager is requesting verification.' }],
      },
      {
        // Array order alone would look newer, but its timestamp predates the prompt.
        info: { role: 'assistant', time: { created: 150 } },
        parts: [{ type: 'text', text: 'Stale output.\nlint: PASS' }],
      },
    ];
    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] done');
    harness.getSessionStatus.mockResolvedValue({ type: 'idle' });
    harness.listMessages.mockImplementation(async () =>
      verificationResumed
        ? [
            ...admittedWithoutResponse,
            {
              info: { role: 'assistant', time: { created: 300 } },
              parts: [{ type: 'text', text: 'lint: PASS' }],
            },
          ]
        : admittedWithoutResponse
    );
    harness.sendPrompt.mockImplementation(
      async (sessionId: string, body: { messageID: string }) => {
        verificationResumed = true;
        admitAndIdle(harness, sessionId, body.messageID);
      }
    );
    harness.store.startRun(config);
    harness.store.upsertIteration(
      config.managerSessionId,
      createIteration(1, { status: 'running', phase: 'verification', endedAt: null })
    );

    harness.runner.reattachAll();
    await vi.waitFor(() =>
      expect(harness.store.getRun(config.managerSessionId)?.status).toBe('done')
    );

    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]).toEqual(
      expect.objectContaining({ status: 'passed', verification: { lint: 'pass' } })
    );
  });

  it('recovers repair work by verifying the persisted repair child', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    let verificationRequested = false;
    harness.readWorkspaceFile.mockResolvedValue('# Plan\n- [x] done');
    harness.getSessionStatus.mockResolvedValue({ type: 'idle' });
    harness.listMessages.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 'repair-1') return assistantReport('typecheck: FAIL');
      return verificationRequested
        ? assistantReport('typecheck: PASS')
        : assistantReport('Repair work is complete.');
    });
    harness.sendPrompt.mockImplementation(
      async (sessionId: string, body: { messageID: string }) => {
        verificationRequested = true;
        admitAndIdle(harness, sessionId, body.messageID);
      }
    );
    harness.store.startRun(config);
    harness.store.upsertIteration(
      config.managerSessionId,
      createIteration(1, {
        status: 'running',
        phase: 'repair',
        endedAt: null,
        verification: { typecheck: 'fail' },
        repairSessionIds: ['repair-1'],
      })
    );

    harness.runner.reattachAll();
    await vi.waitFor(() =>
      expect(harness.store.getRun(config.managerSessionId)?.status).toBe('done')
    );

    expect(harness.sendPrompt.mock.calls[0]?.[0]).toBe('repair-1');
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]).toEqual(
      expect.objectContaining({
        childSessionId: 'child-1',
        repairSessionIds: ['repair-1'],
        status: 'passed',
        verification: { typecheck: 'pass' },
      })
    );
  });

  it('marks a persisted pending iteration before advancing the run', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.store.startRun(config);
    harness.store.upsertIteration(config.managerSessionId, {
      ...createIteration(1),
      childSessionId: null,
      status: 'pending',
      startedAt: null,
      endedAt: null,
    });

    harness.runner.reattachAll();
    await vi.waitFor(() =>
      expect(harness.store.getRun(config.managerSessionId)?.status).toBe('incomplete')
    );

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.store.getRun(config.managerSessionId)?.iterations[0]?.status).toBe('aborted');
  });

  it('rejects a duplicate start before replacing stored state', async () => {
    const harness = createHarness();
    const originalConfig = createConfig({ model: { providerID: 'old', modelID: 'old-model' } });
    harness.store.startRun(originalConfig);
    harness.store.setStatus(originalConfig.managerSessionId, 'paused');

    await harness.runner.start(
      createConfig({ model: { providerID: 'new', modelID: 'new-model' } })
    );

    expect(harness.store.getRun(originalConfig.managerSessionId)?.status).toBe('paused');
    expect(harness.store.getRun(originalConfig.managerSessionId)?.config).toEqual(originalConfig);
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('uses the latest stored model when the next iteration begins', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 2 });
    const nextModel = { providerID: 'anthropic', modelID: 'claude-next', variant: 'high' };
    harness.createSession.mockResolvedValueOnce('child-1').mockResolvedValueOnce('child-2');
    harness.listMessages.mockImplementation(async () => {
      const run = harness.store.getRun(config.managerSessionId);
      if (run && run.currentIteration === 1) run.config = { ...run.config, model: nextModel };
      return assistantReport('lint: PASS');
    });
    settlePromptsViaIdle(harness);

    await harness.runner.start(config);

    const childTwoBodies = harness.sendPrompt.mock.calls
      .filter(([sessionId]) => sessionId === 'child-2')
      .map(([, body]) => body);
    expect(childTwoBodies).toHaveLength(2);
    expect(childTwoBodies).toEqual([
      expect.objectContaining({
        model: { providerID: nextModel.providerID, modelID: nextModel.modelID },
        variant: nextModel.variant,
      }),
      expect.objectContaining({
        model: { providerID: nextModel.providerID, modelID: nextModel.modelID },
        variant: nextModel.variant,
      }),
    ]);
  });
});

describe('ralph runner iteration repair', () => {
  it('fails instead of passing when the child has no assistant report', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.listMessages.mockResolvedValue([]);
    settlePromptsViaIdle(harness);

    await harness.runner.start(config);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    expect(run?.stopReason).toBe('iteration_error');
    expect(run?.iterations[0]?.status).toBe('failed');
    expect(run?.iterations[0]?.note).toContain('produced no assistant report');
  });

  it('fails actionably when child message retrieval fails', async () => {
    const harness = createHarness();
    const config = createConfig({ iterations: 1 });
    harness.createSession.mockResolvedValueOnce('child-1');
    harness.listMessages.mockRejectedValue(new Error('message endpoint unavailable'));
    settlePromptsViaIdle(harness);

    await harness.runner.start(config);

    const run = harness.store.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    expect(run?.iterations[0]?.status).toBe('failed');
    expect(run?.iterations[0]?.note).toContain('Failed to read Ralph session child-1 messages');
  });

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
    harness.sendPrompt.mockImplementation(async (sid: string, body: { messageID: string }) => {
      activeDuringRun = harness.runner.isActive(config.managerSessionId);
      setTimeout(() => admitAndIdle(harness, sid, body.messageID), 0);
    });

    await harness.runner.start(config);

    expect(activeDuringRun).toBe(true);
    expect(harness.runner.isActive(config.managerSessionId)).toBe(false);
    expect(harness.runner.activeIds()).toEqual([]);
  });
});
