import { beforeEach, describe, expect, it, vi } from 'vitest';

type ShowMessageMock = (message: string, ...items: string[]) => Promise<string | undefined>;

const { loggerMock, vscodeMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  vscodeMock: {
    window: {
      showInformationMessage: vi.fn<ShowMessageMock>(() => Promise.resolve(undefined)),
      showWarningMessage: vi.fn<ShowMessageMock>(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn<ShowMessageMock>(() => Promise.resolve(undefined)),
    },
    commands: {
      executeCommand: vi.fn(() => Promise.resolve(undefined)),
    },
  },
}));

vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('vscode', () => vscodeMock);

import { SessionStateManager } from './session-state-manager';

type WorkspaceStateMock = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function createManager(shouldShow: () => boolean = () => true) {
  const workspaceState = {
    get: vi.fn(() => undefined),
    set: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
  };
  const listener = {
    onStatusChange: vi.fn(),
  };
  return new SessionStateManager(workspaceState as never, listener, { shouldShow });
}

describe('SessionStateManager notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a permission warning when allowed', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'permission.asked',
      properties: {
        id: 'perm-1',
        sessionID: 'session-1',
        title: 'Use Bash',
      },
    });

    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
      'Varro needs permission approval.',
      'Open Chat'
    );
  });

  it('suppresses notifications when the gate returns false', () => {
    const manager = createManager(() => false);

    manager.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'perm-1', sessionID: 'session-1', title: 'Use Bash' },
    });

    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('shows a plan-ready notification for completed plan sessions', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Auth cleanup' } },
    });
    manager.handleServerEvent({
      type: 'message.updated',
      properties: {
        info: { sessionID: 'session-1', role: 'assistant', agent: 'plan' },
      },
    });
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    manager.handleServerEvent({
      type: 'session.idle',
      properties: { sessionID: 'session-1' },
    });

    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      'Varro has a plan ready for review for "Auth cleanup".',
      'Open Chat'
    );
  });

  it('remembers sync session metadata when id is only on the event properties', () => {
    const manager = createManager(() => false);

    manager.handleServerEvent({
      type: 'session.updated',
      properties: { sessionID: 'session-1', info: { title: 'Background update' } },
    });

    expect(manager.titleFor('session-1')).toBe('Background update');
  });

  it('shows one failure notification when a background session errors', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Build release' } },
    });
    manager.handleServerEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          agent: 'build',
          error: { name: 'BashError', data: { message: 'Command failed' } },
        },
      },
    });
    manager.handleServerEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          error: { name: 'BashError', data: { message: 'Command failed' } },
        },
      },
    });

    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
      'Varro hit an error for "Build release": Command failed',
      'Open Chat'
    );
  });

  it('does not show a failure notification for aborted assistant messages', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Build release' } },
    });
    manager.handleServerEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          agent: 'build',
          error: { name: 'aborted', data: { message: 'Aborted' } },
        },
      },
    });

    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('persists trimmed interrupted sessions and blocking requests', async () => {
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn(() => undefined),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      {
        onStatusChange: vi.fn(),
      },
      { shouldShow: () => false }
    );

    for (let i = 0; i < 60; i += 1) {
      manager.handleServerEvent({
        type: 'session.updated',
        properties: {
          info: { id: `session-${i}`, title: `Session ${i} ${'x'.repeat(600)}` },
        },
      });
      manager.handleServerEvent({
        type: 'session.status',
        properties: { sessionID: `session-${i}`, status: { type: 'busy' } },
      });
    }

    for (let i = 0; i < 110; i += 1) {
      manager.handleServerEvent({
        type: 'permission.asked',
        properties: {
          id: `perm-${i}`,
          sessionID: `session-${i % 10}`,
          permission: 'bash',
          title: `Use Bash ${'y'.repeat(600)}`,
          patterns: Array.from({ length: 30 }, (_, index) => `pattern-${index}`),
          metadata: {
            short: 'ok',
            long: 'z'.repeat(600),
            nested: { ignored: true },
          },
          tool: { messageID: `message-${i}`, callID: `call-${i}` },
        },
      });
    }

    await manager.persist();

    const interruptedUpdate = [...workspaceState.set.mock.calls]
      .toReversed()
      .find((call) => call[0] === 'varro.interruptedSessions') as [string, unknown] | undefined;
    const blockingUpdate = [...workspaceState.set.mock.calls]
      .toReversed()
      .find((call) => call[0] === 'varro.blockingRequests') as [string, unknown] | undefined;

    const interruptedSnapshots = (interruptedUpdate?.[1] ?? []) as Array<{ title?: string }>;
    const blockingSnapshots = (blockingUpdate?.[1] ?? []) as Array<{
      props: Record<string, unknown>;
    }>;

    expect(interruptedSnapshots).toHaveLength(50);
    expect(interruptedSnapshots[0]?.title?.length).toBeLessThanOrEqual(500);

    expect(blockingSnapshots).toHaveLength(100);
    const firstBlocking = blockingSnapshots[0]?.props;
    expect(firstBlocking).toMatchObject({
      permission: 'bash',
      metadata: {
        short: 'ok',
      },
    });
    expect(((firstBlocking?.title as string | undefined) ?? '').length).toBeLessThanOrEqual(500);
    expect(firstBlocking?.metadata).not.toHaveProperty('nested');
    expect(Array.isArray(firstBlocking?.patterns)).toBe(true);
    expect(((firstBlocking?.patterns as string[] | undefined) ?? []).length).toBeLessThanOrEqual(
      20
    );
  });

  it('consumes persisted interrupted sessions and filters invalid snapshots', async () => {
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn((key: string) => {
        if (key === 'varro.interruptedSessions') {
          return [
            { id: 'session-1', title: 'Session 1' },
            { id: '   ' },
            { id: 42 },
            null,
            { id: 'session-2' },
          ];
        }
        return undefined;
      }),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      {
        onStatusChange: vi.fn(),
      },
      { shouldShow: () => false }
    );

    await expect(manager.consumeInterruptedSessions()).resolves.toEqual([
      { id: 'session-1', title: 'Session 1' },
      { id: 'session-2' },
    ]);
    expect(workspaceState.remove).toHaveBeenCalledWith('varro.interruptedSessions');
  });

  it('consumes persisted blocking requests and filters invalid snapshots', async () => {
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn((key: string) => {
        if (key === 'varro.blockingRequests') {
          return [
            {
              id: 'perm-1',
              sessionID: 'session-1',
              kind: 'permission',
              props: { id: 'perm-1', sessionID: 'session-1', title: 'Use Bash' },
              directory: '/repo',
            },
            {
              id: 'question-1',
              sessionID: 'session-2',
              kind: 'question',
              props: { id: 'question-1', sessionID: 'session-2', questions: [] },
            },
            {
              id: 'invalid-kind',
              sessionID: 'session-3',
              kind: 'approval',
              props: {},
            },
            {
              id: 'missing-props',
              sessionID: 'session-4',
              kind: 'permission',
              props: 'bad',
            },
            {
              id: '   ',
              sessionID: 'session-5',
              kind: 'permission',
              props: {},
            },
            {
              id: 'missing-session',
              sessionID: '',
              kind: 'permission',
              props: {},
            },
          ];
        }
        return undefined;
      }),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      {
        onStatusChange: vi.fn(),
      },
      { shouldShow: () => false }
    );

    await expect(manager.consumeBlockingRequests()).resolves.toEqual([
      {
        id: 'perm-1',
        sessionID: 'session-1',
        kind: 'permission',
        props: { id: 'perm-1', sessionID: 'session-1', title: 'Use Bash' },
        directory: '/repo',
      },
      {
        id: 'question-1',
        sessionID: 'session-2',
        kind: 'question',
        props: { id: 'question-1', sessionID: 'session-2', questions: [] },
      },
    ]);
    expect(workspaceState.remove).toHaveBeenCalledWith('varro.blockingRequests');
  });

  it('evicts old session metadata entries as new sessions arrive', () => {
    const manager = createManager(() => false);

    for (let i = 0; i < 250; i += 1) {
      manager.handleServerEvent({
        type: 'session.updated',
        properties: { info: { id: `session-${i}`, title: `Session ${i}` } },
      });
      manager.handleServerEvent({
        type: 'message.updated',
        properties: {
          info: { sessionID: `session-${i}`, role: 'assistant', agent: 'plan' },
        },
      });
    }

    expect(manager.titleFor('session-0')).toBeUndefined();
    expect(manager.titleFor('session-49')).toBeUndefined();
    expect(manager.titleFor('session-50')).toBe('Session 50');
    expect(manager.titleFor('session-249')).toBe('Session 249');
    expect(manager.isPlanSession('session-0')).toBe(false);
    expect(manager.isPlanSession('session-249')).toBe(true);
  });

  it('scopes pending session state to the current workspace directory', () => {
    const manager = createManager(() => false);

    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Workspace A', directory: '/repo-a' } },
    });
    manager.handleServerEvent({
      type: 'permission.asked',
      properties: {
        id: 'perm-1',
        sessionID: 'session-1',
        title: 'Use Bash',
      },
    });

    expect(manager.isSessionInWorkspace('session-1', '/repo-a///')).toBe(true);
    expect(manager.isSessionInWorkspace('session-1', '/repo-b')).toBe(false);
  });

  it('treats nested session directories as in-workspace', () => {
    const manager = createManager(() => false);

    manager.handleServerEvent({
      type: 'session.updated',
      properties: {
        info: { id: 'session-1', title: 'Nested workspace session', directory: '/repo/project-a' },
      },
    });

    expect(manager.isSessionInWorkspace('session-1', '/repo')).toBe(true);
    expect(manager.isSessionInWorkspace('session-1', '/other')).toBe(false);
  });

  it('treats restored blocking requests without a directory as out of workspace', () => {
    const manager = createManager(() => false);

    manager.restoreBlockingRequests([
      {
        id: 'perm-1',
        sessionID: 'session-1',
        kind: 'permission',
        props: {
          id: 'perm-1',
          sessionID: 'session-1',
          title: 'Use Bash',
        },
      },
    ]);

    expect(manager.isSessionInWorkspace('session-1', '/repo')).toBe(false);
    expect(manager.isSessionInWorkspace('session-1', null)).toBe(true);
  });
});
