import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RALPH_INCOMPLETE_RESUME_ITERATION_INCREMENT,
  type RalphConfig,
  type RalphIteration,
} from '../../../shared/ralph';

const {
  createSession,
  abortSession,
  sendAsync,
  sessionMessages,
  sessionList,
  readWorkspaceFile,
  serverEventsOn,
  postMessage,
} = vi.hoisted(() => ({
  createSession: vi.fn(),
  abortSession: vi.fn(),
  sendAsync: vi.fn(),
  sessionMessages: vi.fn(),
  sessionList: vi.fn(async () => [] as unknown[]),
  readWorkspaceFile: vi.fn(),
  serverEventsOn: vi.fn(() => () => {}),
  postMessage: vi.fn(),
}));

vi.mock('../../lib/client', () => ({
  client: {
    session: {
      create: createSession,
      abort: abortSession,
      sendAsync,
      messages: sessionMessages,
      list: sessionList,
    },
    varro: {
      readWorkspaceFile,
    },
  },
  serverEvents: {
    on: serverEventsOn,
  },
}));

vi.mock('../../hooks/permission-rules', () => ({
  getSessionPermissionRulesForMode: vi.fn(() => []),
}));

vi.mock('../../lib/bridge', () => ({
  postMessage,
}));

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

async function loadRunnerModules() {
  const [{ ralphRunner }, { ralphStore }] = await Promise.all([
    import('./ralph-runner'),
    import('../../lib/stores/ralph-store'),
  ]);
  return { ralphRunner, ralphStore };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  window.localStorage.clear();
  createSession.mockReset();
  abortSession.mockReset();
  sendAsync.mockReset();
  sessionMessages.mockReset();
  sessionList.mockReset();
  sessionList.mockResolvedValue([]);
  readWorkspaceFile.mockReset();
  readWorkspaceFile.mockResolvedValue('# Plan\n- [ ] next chunk');
  serverEventsOn.mockClear();
  postMessage.mockReset();
});

describe('ralph runner stop conditions', () => {
  it('stops cleanly when the iteration limit is reached and the plan is complete', async () => {
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig({ iterations: 1 });

    readWorkspaceFile.mockResolvedValue('# Plan\n- [x] all done');
    ralphStore.startRun(config);
    ralphStore.upsertIteration(config.managerSessionId, createIteration(1));
    ralphStore.setStatus(config.managerSessionId, 'paused');

    await ralphRunner.resume(config.managerSessionId);

    const run = ralphStore.getRun(config.managerSessionId);
    expect(run?.status).toBe('done');
    expect(run?.stopReason).toBe('iteration_limit');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('marks the run incomplete when the iteration limit is reached with outstanding plan items', async () => {
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig({ iterations: 1 });

    // Default mock plan still has `- [ ]` items.
    ralphStore.startRun(config);
    ralphStore.upsertIteration(config.managerSessionId, createIteration(1));
    ralphStore.setStatus(config.managerSessionId, 'paused');

    await ralphRunner.resume(config.managerSessionId);

    const run = ralphStore.getRun(config.managerSessionId);
    expect(run?.status).toBe('incomplete');
    expect(run?.stopReason).toBe('iteration_limit_with_gap');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('does not stop on consecutive passes when the plan still has unchecked items', async () => {
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig();

    // Default mock returns a plan with an outstanding `- [ ]` item, so the
    // loop should not bail out on consecutive passes alone.
    ralphStore.startRun(config);
    ralphStore.upsertIteration(config.managerSessionId, createIteration(1));
    ralphStore.upsertIteration(config.managerSessionId, createIteration(2));
    ralphStore.setStatus(config.managerSessionId, 'paused');

    // Make the next iteration fail-fast by having createSession reject so we
    // don't actually run a child iteration; we just need to observe that the
    // loop did NOT stop with status `done` immediately on resume.
    createSession.mockRejectedValue(new Error('halt for assertion'));

    await ralphRunner.resume(config.managerSessionId);

    const run = ralphStore.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    // We attempted to start iteration 3 (proving consecutive-passes did not stop us).
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(readWorkspaceFile).toHaveBeenCalledWith('RALPH.md');
  });

  it('does not stop on consecutive passes when a plan table still has unchecked items', async () => {
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig();

    readWorkspaceFile.mockResolvedValue(
      '# Plan\n| Done | Item |\n|---|---|\n| [ ] | settings.spec.ts |'
    );
    ralphStore.startRun(config);
    ralphStore.upsertIteration(config.managerSessionId, createIteration(1));
    ralphStore.upsertIteration(config.managerSessionId, createIteration(2));
    ralphStore.setStatus(config.managerSessionId, 'paused');

    createSession.mockRejectedValue(new Error('halt for assertion'));

    await ralphRunner.resume(config.managerSessionId);

    const run = ralphStore.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('continues after two consecutive passing iterations without a DONE marker', async () => {
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig();

    readWorkspaceFile.mockResolvedValue('# Plan\n- [x] all done');
    ralphStore.startRun(config);
    ralphStore.upsertIteration(config.managerSessionId, createIteration(1));
    ralphStore.upsertIteration(config.managerSessionId, createIteration(2));
    ralphStore.setStatus(config.managerSessionId, 'paused');

    createSession.mockRejectedValue(new Error('halt for assertion'));

    await ralphRunner.resume(config.managerSessionId);

    const run = ralphStore.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('marks the run incomplete when the iteration limit is reached with plain list items left', async () => {
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig({ iterations: 1 });

    readWorkspaceFile.mockResolvedValue('# Plan\n- `src/extension/session.ts` - add coverage');
    ralphStore.startRun(config);
    ralphStore.upsertIteration(config.managerSessionId, createIteration(1));
    ralphStore.setStatus(config.managerSessionId, 'paused');

    await ralphRunner.resume(config.managerSessionId);

    const run = ralphStore.getRun(config.managerSessionId);
    expect(run?.status).toBe('incomplete');
    expect(run?.stopReason).toBe('iteration_limit_with_gap');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('adds more iterations before resuming an incomplete run', async () => {
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig({ iterations: 1 });

    ralphStore.startRun(config);
    ralphStore.upsertIteration(config.managerSessionId, createIteration(1));
    ralphStore.setStatus(config.managerSessionId, 'incomplete', 'iteration_limit_with_gap');

    createSession.mockRejectedValue(new Error('halt for assertion'));

    await ralphRunner.resume(config.managerSessionId);

    const run = ralphStore.getRun(config.managerSessionId);
    expect(run?.config.iterations).toBe(1 + RALPH_INCOMPLETE_RESUME_ITERATION_INCREMENT);
    expect(run?.status).toBe('failed');
    expect(run?.stopReason).toBe('iteration_error');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('stops when the plan document starts with the DONE marker', async () => {
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig();

    readWorkspaceFile.mockResolvedValue('DONE\n\n# Ralph Loop');
    ralphStore.startRun(config);
    ralphStore.setStatus(config.managerSessionId, 'paused');

    await ralphRunner.resume(config.managerSessionId);

    expect(ralphStore.getRun(config.managerSessionId)?.status).toBe('done');
    expect(readWorkspaceFile).toHaveBeenCalledWith('RALPH.md');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('does not stop on DONE marker when last iteration still has a failed verdict', async () => {
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig();

    readWorkspaceFile.mockResolvedValue('DONE\n\n# Ralph Loop');
    ralphStore.startRun(config);
    ralphStore.upsertIteration(
      config.managerSessionId,
      createIteration(1, {
        status: 'failed',
        verification: { lint: 'pass', typecheck: 'fail', test: 'pass' },
      })
    );
    ralphStore.setStatus(config.managerSessionId, 'paused');

    // Halt the loop after it tries to spawn the next iteration so we can
    // assert it did NOT stop on the DONE marker.
    createSession.mockRejectedValue(new Error('halt for assertion'));

    await ralphRunner.resume(config.managerSessionId);

    const run = ralphStore.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('does not stop on consecutive passes when the most recent iteration has a failed verdict', async () => {
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig();

    readWorkspaceFile.mockResolvedValue('# Plan\n- [x] all done');
    ralphStore.startRun(config);
    ralphStore.upsertIteration(config.managerSessionId, createIteration(1));
    ralphStore.upsertIteration(
      config.managerSessionId,
      createIteration(2, {
        status: 'failed',
        verification: { lint: 'pass', typecheck: 'fail', test: 'pass' },
      })
    );
    ralphStore.setStatus(config.managerSessionId, 'paused');

    createSession.mockRejectedValue(new Error('halt for assertion'));

    await ralphRunner.resume(config.managerSessionId);

    const run = ralphStore.getRun(config.managerSessionId);
    expect(run?.status).toBe('failed');
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});

describe('ralph runner iteration repair', () => {
  it('does not get stuck when the child session becomes idle before sendAsync resolves', async () => {
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig({ iterations: 1 });

    readWorkspaceFile.mockResolvedValue('# Plan\n- [x] all done');
    createSession.mockResolvedValueOnce({ id: 'child-1' });
    sessionMessages.mockResolvedValue([
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'text', text: 'Finished quickly.\nlint: PASS\ntypecheck: PASS\ntest: PASS' },
        ],
      },
    ]);

    const idleListeners: Array<(data: { properties?: { sessionID?: string } }) => void> = [];
    const statusListeners: Array<
      (data: { properties?: { sessionID?: string; status?: { type?: string } } }) => void
    > = [];
    serverEventsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'session.idle') {
        idleListeners.push(handler as (data: { properties?: { sessionID?: string } }) => void);
      }
      if (event === 'session.status') {
        statusListeners.push(
          handler as (data: {
            properties?: { sessionID?: string; status?: { type?: string } };
          }) => void
        );
      }
      return () => {};
    });

    sendAsync.mockImplementation(async (sid: string) => {
      const idleEvent = { properties: { sessionID: sid } };
      const statusEvent = { properties: { sessionID: sid, status: { type: 'idle' } } };
      for (const listener of idleListeners) listener(idleEvent);
      for (const listener of statusListeners) listener(statusEvent);
    });

    await ralphRunner.start(config);

    const run = ralphStore.getRun(config.managerSessionId);
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
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig({ iterations: 1 });

    readWorkspaceFile.mockResolvedValue('# Plan\n- [ ] next chunk');
    createSession.mockResolvedValueOnce({ id: 'child-1' });
    sessionMessages.mockResolvedValue([
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'The usage limit has been reached' }],
      },
    ]);

    const idleListeners: Array<(data: { properties?: { sessionID?: string } }) => void> = [];
    const statusListeners: Array<
      (data: { properties?: { sessionID?: string; status?: { type?: string } } }) => void
    > = [];
    serverEventsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'session.idle') {
        idleListeners.push(handler as (data: { properties?: { sessionID?: string } }) => void);
      }
      if (event === 'session.status') {
        statusListeners.push(
          handler as (data: {
            properties?: { sessionID?: string; status?: { type?: string } };
          }) => void
        );
      }
      return () => {};
    });

    sendAsync.mockImplementation(async (sid: string) => {
      setTimeout(() => {
        const idleEvent = { properties: { sessionID: sid } };
        const statusEvent = { properties: { sessionID: sid, status: { type: 'idle' } } };
        for (const listener of idleListeners) listener(idleEvent);
        for (const listener of statusListeners) listener(statusEvent);
      }, 0);
    });

    await ralphRunner.start(config);

    const run = ralphStore.getRun(config.managerSessionId);
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
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig({ iterations: 1 });

    // Plan is already complete so the iteration_limit exit is clean once the
    // iteration repair settles.
    readWorkspaceFile.mockResolvedValue('# Plan\n- [x] all done');
    createSession
      .mockResolvedValueOnce({ id: 'child-1' })
      .mockResolvedValueOnce({ id: 'repair-1' });

    // Messages snapshot per session - keyed by sessionId so the order of
    // calls (work / verify / repair / verify) doesn't matter.
    const messagesBySession: Record<string, unknown[]> = {
      'child-1': [
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'text',
              text: 'Implemented first chunk.\nlint: PASS\ntypecheck: FAIL\ntest: PASS',
            },
          ],
        },
      ],
      'repair-1': [
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'text',
              text: 'Fixed the typecheck issue.\nlint: PASS\ntypecheck: PASS\ntest: PASS',
            },
          ],
        },
      ],
    };
    sessionMessages.mockImplementation(async (sid: string) => messagesBySession[sid] ?? []);

    const idleListeners: Array<(data: { properties?: { sessionID?: string } }) => void> = [];
    const statusListeners: Array<
      (data: { properties?: { sessionID?: string; status?: { type?: string } } }) => void
    > = [];
    serverEventsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'session.idle') {
        idleListeners.push(handler as (data: { properties?: { sessionID?: string } }) => void);
      }
      if (event === 'session.status') {
        statusListeners.push(
          handler as (data: {
            properties?: { sessionID?: string; status?: { type?: string } };
          }) => void
        );
      }
      return () => {};
    });

    sendAsync.mockImplementation(async (sid: string) => {
      setTimeout(() => {
        const idleEvent = { properties: { sessionID: sid } };
        const statusEvent = { properties: { sessionID: sid, status: { type: 'idle' } } };
        for (const listener of idleListeners) listener(idleEvent);
        for (const listener of statusListeners) listener(statusEvent);
      }, 0);
    });

    await ralphRunner.start(config);

    // 1 iteration session + 1 repair session.
    expect(createSession).toHaveBeenCalledTimes(2);

    // Per session: 1 work prompt + 1 verification follow-up = 2 sends each.
    // Total = 4 sends across both sessions.
    expect(sendAsync).toHaveBeenCalledTimes(4);

    const sendsBySession = new Map<string, string[]>();
    for (const call of sendAsync.mock.calls) {
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

    const run = ralphStore.getRun(config.managerSessionId);
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
    const { ralphRunner, ralphStore } = await loadRunnerModules();
    const config = createConfig({ iterations: 1 });

    createSession
      .mockResolvedValueOnce({ id: 'child-1' })
      .mockResolvedValueOnce({ id: 'repair-1' })
      .mockResolvedValueOnce({ id: 'repair-2' });

    sessionMessages.mockResolvedValue([
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'Still broken.\nlint: PASS\ntypecheck: FAIL\ntest: PASS' }],
      },
    ]);

    const idleListeners: Array<(data: { properties?: { sessionID?: string } }) => void> = [];
    const statusListeners: Array<
      (data: { properties?: { sessionID?: string; status?: { type?: string } } }) => void
    > = [];
    serverEventsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'session.idle') {
        idleListeners.push(handler as (data: { properties?: { sessionID?: string } }) => void);
      }
      if (event === 'session.status') {
        statusListeners.push(
          handler as (data: {
            properties?: { sessionID?: string; status?: { type?: string } };
          }) => void
        );
      }
      return () => {};
    });

    sendAsync.mockImplementation(async (sid: string) => {
      setTimeout(() => {
        const idleEvent = { properties: { sessionID: sid } };
        const statusEvent = { properties: { sessionID: sid, status: { type: 'idle' } } };
        for (const listener of idleListeners) listener(idleEvent);
        for (const listener of statusListeners) listener(statusEvent);
      }, 0);
    });

    await ralphRunner.start(config);

    // 1 iteration session + 2 repair sub-agent attempts.
    expect(createSession).toHaveBeenCalledTimes(3);
    // 2 sends per session (work + verify) × 3 sessions = 6.
    expect(sendAsync).toHaveBeenCalledTimes(6);

    const run = ralphStore.getRun(config.managerSessionId);
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
});
