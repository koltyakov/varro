/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These state tests deliberately model malformed server events, persisted dictionaries, and controlled private state. */
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

import { AUTO_APPROVE_JUDGE_TIMEOUT_MS } from '../shared/protocol';
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

function markBusy(manager: SessionStateManager, sessionID: string) {
  manager.handleServerEvent({
    type: 'session.status',
    properties: { sessionID, status: { type: 'busy' } },
  });
}

describe('SessionStateManager notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defers a permission warning until the webview reveals it', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'permission.asked',
      properties: {
        id: 'perm-1',
        sessionID: 'session-1',
        title: 'Use Bash',
      },
    });

    expect(manager.pendingForUser.size).toBe(0);
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();

    manager.revealPermission('perm-1');

    expect(manager.pendingForUser.size).toBe(1);
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
      'Varro needs permission approval.',
      'Open Chat'
    );
  });

  it('tracks v2 permission events as blocking attention', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'permission.v2.asked',
      properties: {
        id: 'perm-1',
        sessionID: 'session-1',
        action: 'bash',
        resources: ['*'],
      },
    });

    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    manager.revealPermission('perm-1');

    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
      'Varro needs permission approval.',
      'Open Chat'
    );

    manager.handleServerEvent({
      type: 'permission.v2.replied',
      properties: { sessionID: 'session-1', requestID: 'perm-1', reply: { type: 'once' } },
    });

    const post = vi.fn();
    manager.replayBlockingRequests(post, new Set());
    expect(post).not.toHaveBeenCalled();
  });

  it('suppresses notifications when the gate returns false', () => {
    const manager = createManager(() => false);

    manager.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'perm-1', sessionID: 'session-1', title: 'Use Bash' },
    });

    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('reveals deferred permission attention after the judge timeout', async () => {
    vi.useFakeTimers();
    const manager = createManager();

    try {
      manager.handleServerEvent({
        type: 'permission.asked',
        properties: { id: 'perm-timeout', sessionID: 'session-1', title: 'Use Bash' },
      });

      await vi.advanceTimersByTimeAsync(AUTO_APPROVE_JUDGE_TIMEOUT_MS - 1);
      expect(manager.pendingForUser.size).toBe(0);
      expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(manager.pendingForUser.size).toBe(1);
      expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
        'Varro needs permission approval.',
        'Open Chat'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reveals a permission resolved before the judge timeout', async () => {
    vi.useFakeTimers();
    const manager = createManager();

    try {
      manager.handleServerEvent({
        type: 'permission.asked',
        properties: { id: 'perm-approved', sessionID: 'session-1', title: 'Use Bash' },
      });
      manager.handleServerEvent({
        type: 'permission.replied',
        properties: { id: 'perm-approved', sessionID: 'session-1' },
      });

      await vi.advanceTimersByTimeAsync(AUTO_APPROVE_JUDGE_TIMEOUT_MS);
      expect(manager.pendingForUser.size).toBe(0);
      expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a plan-ready notification for completed terminal plan steps', () => {
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
      type: 'session.next.step.ended',
      properties: { sessionID: 'session-1', finish: 'stop' },
    });

    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(true);
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      'Varro has a plan ready for review for "Auth cleanup".',
      'Open Chat'
    );
  });

  it('clears a busy session on session.status idle', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Auth cleanup' } },
    });
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });
    // The deprecated `session.idle` is published alongside the status and must
    // be harmless once the session already settled (no re-notification).
    manager.handleServerEvent({
      type: 'session.idle',
      properties: { sessionID: 'session-1' },
    });

    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(true);
    // Only plan sessions raise the info notification; this one isn't plan.
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('clears a busy session on the deprecated session.idle event', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    manager.handleServerEvent({
      type: 'session.idle',
      properties: { sessionID: 'session-1' },
    });

    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(true);
  });

  it('markSessionBusy pre-marks a session so a finish without a busy SSE event still settles', () => {
    // Models the ping race: the prompt is forwarded, the turn finishes so fast
    // that the SSE `session.status { busy }` event is missed/late, and the
    // only finish signal that arrives is `session.status { idle }`. Without the
    // optimistic mark, finishBusySession would drop it (`!busySessions.has`)
    // and the session would hang until the reconcile watchdog recovers it.
    const listener = { onStatusChange: vi.fn() };
    const manager = new SessionStateManager(
      {
        get: vi.fn(() => undefined),
        set: vi.fn(() => Promise.resolve()),
        remove: vi.fn(),
      } as never,
      listener,
      { shouldShow: () => true }
    );

    manager.markSessionBusy('session-1');
    expect(manager.busy.has('session-1')).toBe(true);

    // No intervening `busy` event - idle arrives directly.
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });

    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(true);
  });

  it('rolls back a failed optimistic prompt without reporting completion', () => {
    const manager = createManager();
    const attempt = manager.markSessionBusy('session-1');

    expect(attempt).toBeDefined();
    manager.reconcilePromptFailure(attempt!, { type: 'idle' });

    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(false);
  });

  it('does not clear a concurrent prompt attempt when an earlier attempt fails', () => {
    const manager = createManager();
    const firstAttempt = manager.markSessionBusy('session-1');
    const secondAttempt = manager.markSessionBusy('session-1');

    manager.reconcilePromptFailure(firstAttempt!, undefined);
    expect(manager.busy.has('session-1')).toBe(true);

    manager.reconcilePromptFailure(secondAttempt!, undefined);
    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(false);
  });

  it('rolls back a deferred prompt failure on the next authoritative status snapshot', () => {
    const manager = createManager();
    const attempt = manager.markSessionBusy('session-1');

    manager.deferPromptFailure(attempt!);
    const stale = manager.reconcileStaleBusySessions({}, 10_000, 1_000);

    expect(stale).toEqual([]);
    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(false);
  });

  it('preserves a concurrent prompt while reconciling a deferred failed attempt', () => {
    const manager = createManager();
    const failedAttempt = manager.markSessionBusy('session-1');
    const concurrentAttempt = manager.markSessionBusy('session-1');

    manager.deferPromptFailure(failedAttempt!);
    manager.reconcileStaleBusySessions({}, 10_000, 1_000);

    expect(manager.busy.has('session-1')).toBe(true);
    expect(manager.completed.has('session-1')).toBe(false);

    manager.reconcilePromptFailure(concurrentAttempt!, undefined);
    expect(manager.busy.has('session-1')).toBe(false);
  });

  it('bounds deferred rollback when authoritative status entries stay malformed', () => {
    const manager = createManager();
    const attempt = manager.markSessionBusy('session-1');
    manager.deferPromptFailure(attempt!);

    for (let i = 0; i < 3; i += 1) {
      manager.reconcileStaleBusySessions({ 'session-1': { type: 'unknown' } }, 10_000, i);
    }

    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(false);
  });

  it.each([
    ['tool_calls', 'tool-calls'],
    ['function_calls', 'function-calls'],
  ])(
    'does not mark continuation step %s and assistant %s completions complete',
    (stepFinish, messageFinish) => {
      const manager = createManager();

      manager.handleServerEvent({
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'busy' } },
      });
      manager.handleServerEvent({
        type: 'session.next.step.ended',
        properties: { sessionID: 'session-1', finish: stepFinish },
      });
      manager.handleServerEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-1',
            role: 'assistant',
            finish: messageFinish,
            time: { created: 1, completed: 2 },
          },
        },
      });
      manager.handleServerEvent({
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'busy' } },
      });

      expect(manager.busy.has('session-1')).toBe(true);
      expect(manager.completed.has('session-1')).toBe(false);
      expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    }
  );

  it('does not notify for child session completions', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'session.created',
      properties: {
        info: {
          id: 'child-1',
          parentID: 'session-1',
          title: 'Analyze opencode capabilities',
        },
      },
    });
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'child-1', status: { type: 'busy' } },
    });
    manager.handleServerEvent({
      type: 'session.next.step.ended',
      properties: { sessionID: 'child-1', finish: 'stop', timestamp: Date.now() },
    });

    expect(manager.busy.has('child-1')).toBe(false);
    expect(manager.completed.has('child-1')).toBe(false);
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does not notify for subagent assistant completions', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'session.updated',
      properties: {
        info: { id: 'session-1', title: 'Analyze opencode capabilities (@explore subagent)' },
      },
    });
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    manager.handleServerEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          mode: 'subagent',
          time: { created: 1, completed: Date.now() },
        },
      },
    });

    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(false);
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does not notify for historical completions replayed after a busy marker', () => {
    const now = 1_800_000_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const manager = createManager();

      manager.handleServerEvent({
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'busy' } },
      });
      manager.handleServerEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: now - 120_000, completed: now - 60_000 },
          },
        },
      });

      expect(manager.busy.has('session-1')).toBe(true);
      expect(manager.completed.has('session-1')).toBe(false);
      expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
    }
  });

  it('marks a busy session complete from assistant completion without session.idle', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Auth cleanup' } },
    });
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    manager.handleServerEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          agent: 'plan',
          time: { created: 1, completed: 2 },
        },
      },
    });

    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(true);
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      'Varro has a plan ready for review for "Auth cleanup".',
      'Open Chat'
    );
  });

  it.each(['assistant completion', 'terminal step end'])(
    'ignores a trailing stale busy event after %s but accepts a new prompt',
    (completionKind) => {
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
      markBusy(manager, 'session-1');

      manager.handleServerEvent(
        completionKind === 'assistant completion'
          ? {
              type: 'message.updated',
              properties: {
                info: {
                  sessionID: 'session-1',
                  role: 'assistant',
                  agent: 'plan',
                  finish: 'stop',
                  time: { created: 1, completed: 2 },
                },
              },
            }
          : {
              type: 'session.next.step.ended',
              properties: { sessionID: 'session-1', finish: 'stop' },
            }
      );
      manager.handleServerEvent({
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'busy' } },
      });

      expect(manager.busy.has('session-1')).toBe(false);
      expect(manager.completed.has('session-1')).toBe(true);
      expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);

      manager.markSessionBusy('session-1');
      expect(manager.busy.has('session-1')).toBe(true);
      expect(manager.completed.has('session-1')).toBe(false);
      manager.handleServerEvent({
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'idle' } },
      });

      expect(manager.completed.has('session-1')).toBe(true);
      expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(2);
    }
  );

  it('accepts busy for a newly admitted prompt after suppressing a terminal trailing busy', () => {
    const manager = createManager();
    markBusy(manager, 'session-1');
    manager.handleServerEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          finish: 'stop',
          time: { created: 1, completed: 2 },
        },
      },
    });
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });

    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(true);

    manager.handleServerEvent({
      type: 'session.next.prompt.admitted',
      properties: { sessionID: 'session-1', messageID: 'message-2' },
    });
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });

    expect(manager.busy.has('session-1')).toBe(true);
    expect(manager.completed.has('session-1')).toBe(false);
  });

  it('does not show completion notifications for normal background sessions', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Codebase improvement research' } },
    });
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    manager.handleServerEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 1, completed: 2 },
        },
      },
    });

    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(true);
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
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

  it('does not show failure notifications for child sessions', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'session.created',
      properties: {
        info: {
          id: 'child-1',
          parentID: 'session-1',
          title: 'Analyze opencode capabilities',
        },
      },
    });
    manager.handleServerEvent({
      type: 'session.error',
      properties: {
        sessionID: 'child-1',
        error: { name: 'UnknownError', data: { message: 'Command failed' } },
      },
    });

    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('uses session.error events for background failure notifications', () => {
    const manager = createManager();

    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Build release' } },
    });
    manager.handleServerEvent({
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'UnknownError', data: { message: 'Command failed' } },
      },
    });
    manager.handleServerEvent({
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'UnknownError', data: { message: 'Command failed' } },
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

  it('terminally clears busy on an aborted session.error without later reporting success', () => {
    const manager = createManager();
    markBusy(manager, 'session-1');

    manager.handleServerEvent({
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'aborted', data: { message: 'Aborted' } },
      },
    });
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });

    expect(manager.busy.has('session-1')).toBe(false);
    expect(manager.completed.has('session-1')).toBe(false);
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
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

  it('round-trips legacy and v2 permission context with the matching event type', async () => {
    const persisted = new Map<string, unknown>();
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn((key: string) => persisted.get(key)),
      set: vi.fn((key: string, value: unknown) => {
        persisted.set(key, value);
        return Promise.resolve();
      }),
      remove: vi.fn((key: string) => {
        persisted.delete(key);
        return Promise.resolve();
      }),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    manager.handleServerEvent({
      type: 'permission.asked',
      properties: {
        id: 'legacy-1',
        sessionID: 'session-1',
        permission: 'read',
        pattern: 'src/index.ts',
      },
    });
    manager.handleServerEvent({
      type: 'permission.v2.asked',
      properties: {
        id: 'v2-1',
        sessionID: 'session-2',
        action: 'external_directory',
        resources: Array.from({ length: 25 }, (_, index) => `/external/${index}`),
        save: ['approved'],
        source: {
          type: 'tool',
          messageID: 'm'.repeat(600),
          callID: 'c'.repeat(600),
        },
      },
    });
    await manager.persist();

    const snapshots = persisted.get('varro.blockingRequests') as Array<{
      id: string;
      eventType?: string;
      props: Record<string, unknown>;
    }>;
    expect(snapshots.find((item) => item.id === 'legacy-1')).toMatchObject({
      eventType: 'permission.asked',
      props: { pattern: 'src/index.ts' },
    });
    expect(snapshots.find((item) => item.id === 'v2-1')).toMatchObject({
      eventType: 'permission.v2.asked',
      props: {
        action: 'external_directory',
        save: ['approved'],
        source: { type: 'tool' },
      },
    });
    const v2Snapshot = snapshots.find((item) => item.id === 'v2-1');
    expect((v2Snapshot?.props.resources as string[] | undefined)?.length).toBe(20);
    expect(
      ((v2Snapshot?.props.source as { messageID?: string } | undefined)?.messageID ?? '').length
    ).toBe(500);

    const recovered = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );
    await recovered.consumeRecoverySnapshot();
    const post = vi.fn();
    recovered.replayBlockingRequests(post, new Set());

    expect(post).toHaveBeenCalledWith({
      type: 'server/event',
      payload: {
        type: 'permission.v2.asked',
        properties: expect.objectContaining({
          id: 'v2-1',
          action: 'external_directory',
          save: ['approved'],
        }),
      },
    });
  });

  it('serializes snapshots so a delayed older write cannot overwrite newer state', async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const interruptedSnapshots: unknown[] = [];
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn(() => undefined),
      set: vi.fn((key: string, value: unknown) => {
        if (key !== 'varro.interruptedSessions') return Promise.resolve();
        interruptedSnapshots.push(value);
        if (interruptedSnapshots.length > 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        });
      }),
      remove: vi.fn(() => Promise.resolve()),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    markBusy(manager, 'session-1');
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });

    await vi.waitFor(() => expect(interruptedSnapshots).toHaveLength(1));
    expect(interruptedSnapshots[0]).toEqual([{ id: 'session-1', title: undefined }]);
    releaseFirstWrite?.();
    await manager.flush();

    expect(interruptedSnapshots).toEqual([[{ id: 'session-1', title: undefined }], []]);
  });

  it('continues persisting and flushes newer state after a write rejects', async () => {
    const interruptedSnapshots: unknown[] = [];
    let firstInterruptedWrite = true;
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn(() => undefined),
      set: vi.fn((key: string, value: unknown) => {
        if (key !== 'varro.interruptedSessions') return Promise.resolve();
        interruptedSnapshots.push(value);
        if (firstInterruptedWrite) {
          firstInterruptedWrite = false;
          return Promise.reject(new Error('write failed'));
        }
        return Promise.resolve();
      }),
      remove: vi.fn(() => Promise.resolve()),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    markBusy(manager, 'session-1');
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });

    await expect(manager.flush()).resolves.toBeUndefined();
    expect(interruptedSnapshots).toEqual([[{ id: 'session-1', title: undefined }], []]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist session state: write failed')
    );
  });

  it('serializes interrupted-session consume between overlapping writes', async () => {
    const storage = new Map<string, unknown>();
    const events: string[] = [];
    let releaseFirstWrite: (() => void) | undefined;
    let interruptedWriteCount = 0;
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn((key: string) => {
        if (key === 'varro.interruptedSessions') events.push('get');
        return storage.get(key);
      }),
      set: vi.fn((key: string, value: unknown) => {
        if (key !== 'varro.interruptedSessions') {
          storage.set(key, value);
          return Promise.resolve();
        }
        interruptedWriteCount += 1;
        events.push(`set-${interruptedWriteCount}-start`);
        if (interruptedWriteCount > 1) {
          storage.set(key, value);
          events.push(`set-${interruptedWriteCount}-finish`);
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          releaseFirstWrite = () => {
            storage.set(key, value);
            events.push('set-1-finish');
            resolve();
          };
        });
      }),
      remove: vi.fn((key: string) => {
        if (key === 'varro.interruptedSessions') events.push('remove');
        storage.delete(key);
        return Promise.resolve();
      }),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    markBusy(manager, 'session-1');
    const consumed = manager.consumeRecoverySnapshot();
    manager.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });

    await vi.waitFor(() => expect(releaseFirstWrite).toBeDefined());
    expect(events).toEqual(['set-1-start']);
    releaseFirstWrite?.();

    await expect(consumed).resolves.toMatchObject({
      interruptedSessions: [{ id: 'session-1', title: undefined }],
    });
    await manager.flush();
    expect(events).toEqual([
      'set-1-start',
      'set-1-finish',
      'get',
      'remove',
      'set-2-start',
      'set-2-finish',
    ]);
    expect(storage.get('varro.interruptedSessions')).toEqual([]);
  });

  it('serializes blocking recovery and preserves a newer reply', async () => {
    const storage = new Map<string, unknown>();
    const events: string[] = [];
    let releaseFirstWrite: (() => void) | undefined;
    let blockingWriteCount = 0;
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn((key: string) => {
        if (key === 'varro.blockingRequests') events.push('get');
        return storage.get(key);
      }),
      set: vi.fn((key: string, value: unknown) => {
        if (key !== 'varro.blockingRequests') {
          storage.set(key, value);
          return Promise.resolve();
        }
        blockingWriteCount += 1;
        events.push(`set-${blockingWriteCount}-start`);
        if (blockingWriteCount > 1) {
          storage.set(key, value);
          events.push(`set-${blockingWriteCount}-finish`);
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          releaseFirstWrite = () => {
            storage.set(key, value);
            events.push('set-1-finish');
            resolve();
          };
        });
      }),
      remove: vi.fn((key: string) => {
        if (key === 'varro.blockingRequests') events.push('remove');
        storage.delete(key);
        return Promise.resolve();
      }),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    manager.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'permission-1', sessionID: 'session-1', title: 'Use Bash' },
    });
    const consumed = manager.consumeRecoverySnapshot();
    manager.handleServerEvent({
      type: 'permission.replied',
      properties: { id: 'permission-1', sessionID: 'session-1' },
    });

    await vi.waitFor(() => expect(releaseFirstWrite).toBeDefined());
    expect(events).toEqual(['set-1-start']);
    releaseFirstWrite?.();

    await expect(consumed).resolves.toMatchObject({ blockingRequests: [] });
    await manager.flush();
    expect(events).toEqual([
      'set-1-start',
      'set-1-finish',
      'get',
      'remove',
      'set-2-start',
      'set-2-finish',
    ]);
    expect(storage.get('varro.blockingRequests')).toEqual([]);
  });

  it('consumes persisted interrupted sessions and filters invalid snapshots', async () => {
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn((key: string) => {
        if (key === 'varro.interruptedSessions') {
          return [
            { id: 'session-1', title: 'Session 1' },
            { id: 'child-1', title: 'Analyze opencode capabilities (@explore subagent)' },
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

    await expect(manager.consumeRecoverySnapshot()).resolves.toMatchObject({
      interruptedSessions: [{ id: 'session-1', title: 'Session 1' }, { id: 'session-2' }],
    });
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

    await expect(manager.consumeRecoverySnapshot()).resolves.toMatchObject({
      blockingRequests: [
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
      ],
    });
    expect(workspaceState.remove).toHaveBeenCalledWith('varro.blockingRequests');
  });

  it('treats recovery cleanup as best-effort and safely retries stale blocking data', async () => {
    const storage = new Map<string, unknown>([
      ['varro.interruptedSessions', [{ id: 'session-1', title: 'Interrupted' }]],
      [
        'varro.blockingRequests',
        [
          {
            id: 'permission-1',
            sessionID: 'session-1',
            kind: 'permission',
            props: { id: 'permission-1', sessionID: 'session-1', title: 'Use Bash' },
          },
        ],
      ],
    ]);
    let blockingRemoveAttempts = 0;
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn((key: string) => storage.get(key)),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn((key: string) => {
        if (key === 'varro.blockingRequests') {
          blockingRemoveAttempts += 1;
          if (blockingRemoveAttempts === 1) return Promise.reject(new Error('cleanup failed'));
        }
        storage.delete(key);
        return Promise.resolve();
      }),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    await expect(manager.consumeRecoverySnapshot()).resolves.toMatchObject({
      interruptedSessions: [{ id: 'session-1', title: 'Interrupted' }],
      blockingRequests: [{ id: 'permission-1', sessionID: 'session-1' }],
    });
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'));

    manager.handleServerEvent({
      type: 'permission.replied',
      properties: { id: 'permission-1', sessionID: 'session-1' },
    });
    await expect(manager.consumeRecoverySnapshot()).resolves.toMatchObject({
      interruptedSessions: [],
      blockingRequests: [],
    });
    expect(manager.pending.has('permission-1')).toBe(false);
    expect(blockingRemoveAttempts).toBe(2);
  });

  it('does not replay interrupted sessions while failed cleanup is retried', async () => {
    const storage = new Map<string, unknown>([
      ['varro.interruptedSessions', [{ id: 'session-1', title: 'Interrupted' }]],
    ]);
    let interruptedRemoveAttempts = 0;
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn((key: string) => storage.get(key)),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn((key: string) => {
        if (key === 'varro.interruptedSessions') {
          interruptedRemoveAttempts += 1;
          if (interruptedRemoveAttempts === 1) {
            return Promise.reject(new Error('interrupted cleanup failed'));
          }
        }
        storage.delete(key);
        return Promise.resolve();
      }),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    await expect(manager.consumeRecoverySnapshot()).resolves.toMatchObject({
      interruptedSessions: [{ id: 'session-1', title: 'Interrupted' }],
    });
    await expect(manager.consumeRecoverySnapshot()).resolves.toMatchObject({
      interruptedSessions: [],
    });

    expect(interruptedRemoveAttempts).toBe(2);
    expect(storage.has('varro.interruptedSessions')).toBe(false);
    await expect(manager.consumeRecoverySnapshot()).resolves.toMatchObject({
      interruptedSessions: [],
    });
  });

  it('reconciles permission and question snapshots independently', () => {
    const manager = createManager(() => false);
    manager.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'permission-stale', sessionID: 'session-1', title: 'Stale' },
    });
    manager.handleServerEvent({
      type: 'question.asked',
      properties: { id: 'question-live', sessionID: 'session-2', questions: [] },
    });

    manager.reconcilePendingAttention('permission', [
      { id: 'permission-live', sessionID: 'session-3', title: 'Live' },
    ]);

    expect([...manager.pending.keys()]).toEqual(['question-live', 'permission-live']);
    expect(manager.pending.get('permission-live')).toMatchObject({
      kind: 'permission',
      sessionID: 'session-3',
      label: 'Live',
    });

    manager.reconcilePendingAttention('question', []);
    expect([...manager.pending.keys()]).toEqual(['permission-live']);
  });

  it('preserves newer ask and reply events while an older snapshot is in flight', () => {
    const manager = createManager(() => false);
    manager.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'permission-replied', sessionID: 'session-1', title: 'Old ask' },
    });
    const reconciliation = manager.beginPendingAttentionReconciliation('permission');

    manager.handleServerEvent({
      type: 'permission.replied',
      properties: { id: 'permission-replied', sessionID: 'session-1' },
    });
    manager.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'permission-new', sessionID: 'session-2', title: 'New ask' },
    });
    manager.reconcilePendingAttention(
      'permission',
      [{ id: 'permission-replied', sessionID: 'session-1', title: 'Old ask' }],
      reconciliation
    );

    expect([...manager.pending.keys()]).toEqual(['permission-new']);
  });

  it('lets a later concurrent snapshot supersede an earlier snapshot', () => {
    const manager = createManager(() => false);
    const first = manager.beginPendingAttentionReconciliation('permission');
    const second = manager.beginPendingAttentionReconciliation('permission');

    manager.reconcilePendingAttention(
      'permission',
      [{ id: 'permission-old', sessionID: 'session-1', title: 'Old' }],
      first
    );
    manager.reconcilePendingAttention(
      'permission',
      [{ id: 'permission-new', sessionID: 'session-2', title: 'New' }],
      second
    );

    expect([...manager.pending.keys()]).toEqual(['permission-new']);
  });

  it.each(['permission', 'question'] as const)(
    'ignores an older %s snapshot that completes after a newer request',
    (kind) => {
      const manager = createManager(() => false);
      const first = manager.beginPendingAttentionReconciliation(kind);
      const second = manager.beginPendingAttentionReconciliation(kind);
      const request = (id: string, sessionID: string) => ({
        id,
        sessionID,
        ...(kind === 'permission' ? { title: id } : { questions: [] }),
      });

      manager.reconcilePendingAttention(kind, [request(`${kind}-new`, 'session-new')], second);
      manager.reconcilePendingAttention(kind, [request(`${kind}-old`, 'session-old')], first);

      expect([...manager.pending.keys()]).toEqual([`${kind}-new`]);
    }
  );

  it.each(['permission', 'question'] as const)(
    'does not restore a %s snapshot request after its session is deleted',
    (kind) => {
      const manager = createManager(() => false);
      const reconciliation = manager.beginPendingAttentionReconciliation(kind);

      manager.handleServerEvent({
        type: 'session.deleted',
        properties: { info: { id: 'session-deleted' } },
      });
      manager.reconcilePendingAttention(
        kind,
        [
          {
            id: `${kind}-deleted`,
            sessionID: 'session-deleted',
            ...(kind === 'permission' ? { title: 'Deleted' } : { questions: [] }),
          },
        ],
        reconciliation
      );

      expect(manager.pending.has(`${kind}-deleted`)).toBe(false);
    }
  );

  it('prunes event mutation metadata after overlapping reconciliations finish', () => {
    const manager = createManager(() => false);
    const first = manager.beginPendingAttentionReconciliation('permission');
    const second = manager.beginPendingAttentionReconciliation('permission');

    for (let index = 0; index < 250; index += 1) {
      manager.handleServerEvent({
        type: 'permission.replied',
        properties: { id: `permission-${index}`, sessionID: `session-${index}` },
      });
    }
    manager.handleServerEvent({
      type: 'session.deleted',
      properties: { info: { id: 'session-deleted' } },
    });
    manager.reconcilePendingAttention('permission', [], second);
    manager.reconcilePendingAttention('permission', [], first);

    const reconciliationState = manager as unknown as {
      pendingAttentionMutationRevisions: Record<'permission', Map<string, number>>;
      pendingAttentionSessionDeletionRevisions: Record<'permission', Map<string, number>>;
      activePendingAttentionReconciliations: Record<'permission', Map<number, number>>;
    };
    expect(reconciliationState.pendingAttentionMutationRevisions.permission.size).toBe(0);
    expect(reconciliationState.pendingAttentionSessionDeletionRevisions.permission.size).toBe(0);
    expect(reconciliationState.activePendingAttentionReconciliations.permission.size).toBe(0);
  });

  it('treats malformed persisted snapshot containers as empty', async () => {
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn(() => ({ malformed: true })),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    await expect(manager.consumeRecoverySnapshot()).resolves.toEqual({
      interruptedSessions: [],
      blockingRequests: [],
    });
  });

  it('shares an overlapping recovery consume', async () => {
    const releaseRemoves: Array<() => void> = [];
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn(() => undefined),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseRemoves.push(resolve);
          })
      ),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    const first = manager.consumeRecoverySnapshot();
    const second = manager.consumeRecoverySnapshot();

    expect(second).toBe(first);
    await vi.waitFor(() => expect(workspaceState.remove).toHaveBeenCalledTimes(2));
    for (const release of releaseRemoves) release();
    await Promise.all([first, second]);
    expect(workspaceState.get).toHaveBeenCalledTimes(2);
  });

  it('preserves permission and question events that arrive during recovery', async () => {
    let releaseBlockingRemove: (() => void) | undefined;
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn((key: string) =>
        key === 'varro.blockingRequests'
          ? [
              {
                id: 'permission-1',
                sessionID: 'session-1',
                kind: 'permission',
                props: { id: 'permission-1', sessionID: 'session-1', title: 'Use Bash' },
              },
            ]
          : undefined
      ),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn((key: string) => {
        if (key !== 'varro.blockingRequests') return Promise.resolve();
        return new Promise<void>((resolve) => {
          releaseBlockingRemove = resolve;
        });
      }),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    const recovery = manager.consumeRecoverySnapshot();
    await vi.waitFor(() => expect(releaseBlockingRemove).toBeDefined());
    manager.handleServerEvent({
      type: 'question.asked',
      properties: { id: 'question-2', sessionID: 'session-2', questions: [] },
    });
    releaseBlockingRemove?.();

    await expect(recovery).resolves.toMatchObject({
      blockingRequests: [
        { id: 'permission-1', kind: 'permission' },
        { id: 'question-2', kind: 'question' },
      ],
    });
    expect([...manager.pending.keys()]).toEqual(['permission-1', 'question-2']);
  });

  it('does not resurrect a persisted request replied to during recovery', async () => {
    let releaseBlockingRemove: (() => void) | undefined;
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn((key: string) =>
        key === 'varro.blockingRequests'
          ? [
              {
                id: 'permission-1',
                sessionID: 'session-1',
                kind: 'permission',
                props: { id: 'permission-1', sessionID: 'session-1' },
              },
            ]
          : undefined
      ),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn((key: string) => {
        if (key !== 'varro.blockingRequests') return Promise.resolve();
        return new Promise<void>((resolve) => {
          releaseBlockingRemove = resolve;
        });
      }),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    const recovery = manager.consumeRecoverySnapshot();
    await vi.waitFor(() => expect(releaseBlockingRemove).toBeDefined());
    manager.handleServerEvent({
      type: 'permission.replied',
      properties: { id: 'permission-1', sessionID: 'session-1' },
    });
    releaseBlockingRemove?.();

    await expect(recovery).resolves.toMatchObject({ blockingRequests: [] });
    expect(manager.pending.has('permission-1')).toBe(false);
  });

  it('skips recovered requests for a session deleted before merge and prunes the tombstone', async () => {
    const workspaceState: WorkspaceStateMock = {
      get: vi.fn((key: string) =>
        key === 'varro.blockingRequests'
          ? [
              {
                id: 'permission-deleted',
                sessionID: 'session-deleted',
                kind: 'permission',
                props: { id: 'permission-deleted', sessionID: 'session-deleted' },
              },
              {
                id: 'permission-live',
                sessionID: 'session-live',
                kind: 'permission',
                props: { id: 'permission-live', sessionID: 'session-live' },
              },
            ]
          : undefined
      ),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const manager = new SessionStateManager(
      workspaceState as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    const recovery = manager.consumeRecoverySnapshot();
    manager.handleServerEvent({
      type: 'session.deleted',
      properties: { info: { id: 'session-deleted' } },
    });

    await expect(recovery).resolves.toMatchObject({
      blockingRequests: [{ id: 'permission-live', sessionID: 'session-live' }],
    });
    expect(manager.pending.has('permission-deleted')).toBe(false);

    await manager.consumeRecoverySnapshot();
    expect(manager.pending.has('permission-deleted')).toBe(true);
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

  it('refreshes session metadata recency on access and update', () => {
    const manager = createManager(() => false);
    for (let i = 0; i < 200; i += 1) {
      manager.handleServerEvent({
        type: 'session.updated',
        properties: { info: { id: `session-${i}`, title: `Session ${i}` } },
      });
    }

    expect(manager.titleFor('session-0')).toBe('Session 0');
    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Updated session 1' } },
    });
    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-200', title: 'Session 200' } },
    });
    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-201', title: 'Session 201' } },
    });

    expect(manager.titleFor('session-0')).toBe('Session 0');
    expect(manager.titleFor('session-1')).toBe('Updated session 1');
    expect(manager.titleFor('session-2')).toBeUndefined();
    expect(manager.titleFor('session-3')).toBeUndefined();
  });

  it('pins busy and pending session directories during metadata eviction', () => {
    const manager = createManager(() => false);
    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'busy-session', directory: '/repo' } },
    });
    manager.markSessionBusy('busy-session');
    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'pending-session', directory: '/repo' } },
    });
    manager.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'permission-1', sessionID: 'pending-session', title: 'Use Bash' },
    });

    for (let i = 0; i < 250; i += 1) {
      manager.handleServerEvent({
        type: 'session.updated',
        properties: { info: { id: `other-${i}`, directory: `/other-${i}` } },
      });
    }

    expect(manager.isSessionInWorkspace('busy-session', '/repo')).toBe(true);
    expect(manager.isSessionInWorkspace('pending-session', '/repo')).toBe(true);
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

  it('matches UNC workspace identity case-insensitively', () => {
    const manager = createManager(() => false);
    manager.handleServerEvent({
      type: 'session.updated',
      properties: {
        info: {
          id: 'session-unc',
          directory: '\\\\BuildServer\\Projects\\Varro',
        },
      },
    });

    expect(manager.isSessionInWorkspace('session-unc', '//buildserver/PROJECTS/varro/')).toBe(true);
  });

  it('treats nested session directories as out of workspace', () => {
    const manager = createManager(() => false);

    manager.handleServerEvent({
      type: 'session.updated',
      properties: {
        info: { id: 'session-1', title: 'Nested workspace session', directory: '/repo/project-a' },
      },
    });

    expect(manager.isSessionInWorkspace('session-1', '/repo')).toBe(false);
    expect(manager.isSessionInWorkspace('session-1', '/other')).toBe(false);
  });

  it('treats restored blocking requests without a directory as out of workspace', async () => {
    const manager = new SessionStateManager(
      {
        get: vi.fn((key: string) =>
          key === 'varro.blockingRequests'
            ? [
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
              ]
            : undefined
        ),
        set: vi.fn(() => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
      } as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );

    await manager.consumeRecoverySnapshot();

    expect(manager.isSessionInWorkspace('session-1', '/repo')).toBe(false);
    expect(manager.isSessionInWorkspace('session-1', null)).toBe(true);
  });

  it('replays only current-workspace prompts and clears stale embedded foreign prompts', () => {
    const manager = createManager(() => false);
    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'local-session', directory: '/repo' } },
    });
    manager.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'local-permission', sessionID: 'local-session', title: 'Local' },
    });
    manager.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'foreign-session', directory: '/other' } },
    });
    manager.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'foreign-permission', sessionID: 'foreign-session', title: 'Foreign' },
    });
    const post = vi.fn();

    manager.replayBlockingRequests(post, new Set(), {
      workspacePath: '/repo',
      clearResolvedEmbedded: true,
      previousRequests: [
        {
          id: 'local-permission',
          sessionID: 'local-session',
          kind: 'permission',
          props: { id: 'local-permission', sessionID: 'local-session' },
        },
        {
          id: 'foreign-permission',
          sessionID: 'foreign-session',
          kind: 'permission',
          props: { id: 'foreign-permission', sessionID: 'foreign-session' },
        },
      ],
    });

    expect(post).toHaveBeenCalledWith({
      type: 'server/event',
      payload: {
        type: 'permission.asked',
        properties: expect.objectContaining({ id: 'local-permission' }),
      },
    });
    expect(post).toHaveBeenCalledWith({
      type: 'server/event',
      payload: {
        type: 'permission.replied',
        properties: {
          id: 'foreign-permission',
          permissionID: 'foreign-permission',
          requestID: 'foreign-permission',
          sessionID: 'foreign-session',
        },
      },
    });
    expect(post).not.toHaveBeenCalledWith({
      type: 'server/event',
      payload: {
        type: 'permission.asked',
        properties: expect.objectContaining({ id: 'foreign-permission' }),
      },
    });
  });

  it('clears an embedded prompt whose session directory is still unknown', () => {
    const manager = createManager(() => false);
    manager.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'unknown-permission', sessionID: 'unknown-session', title: 'Unknown' },
    });
    const post = vi.fn();

    manager.replayBlockingRequests(post, new Set(), {
      workspacePath: '/repo',
      clearResolvedEmbedded: true,
      previousRequests: [
        {
          id: 'unknown-permission',
          sessionID: 'unknown-session',
          kind: 'permission',
          props: { id: 'unknown-permission', sessionID: 'unknown-session' },
        },
      ],
    });

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({
      type: 'server/event',
      payload: {
        type: 'permission.replied',
        properties: {
          id: 'unknown-permission',
          permissionID: 'unknown-permission',
          requestID: 'unknown-permission',
          sessionID: 'unknown-session',
        },
      },
    });
  });
});

describe('SessionStateManager.reconcileStaleBusySessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const GRACE_MS = 10_000;

  it('returns an empty list when nothing is busy', () => {
    const manager = createManager();
    const stale = manager.reconcileStaleBusySessions({}, GRACE_MS, 1000);
    expect(stale).toEqual([]);
  });

  it('does not reconcile on the first server-idle observation (starts grace)', () => {
    const manager = createManager();
    markBusy(manager, 's1');
    const stale = manager.reconcileStaleBusySessions({}, GRACE_MS, 1000);
    expect(stale).toEqual([]);
    expect(manager.busy.has('s1')).toBe(true);
  });

  it('reconciles after the grace window elapses with sustained server-idle', () => {
    const manager = createManager();
    markBusy(manager, 's1');
    manager.reconcileStaleBusySessions({}, GRACE_MS, 1000);
    const stale = manager.reconcileStaleBusySessions({}, GRACE_MS, 1000 + GRACE_MS);
    expect(stale).toEqual(['s1']);
    expect(manager.busy.has('s1')).toBe(false);
    expect(manager.completed.has('s1')).toBe(true);
  });

  it('does not reconcile when the server still reports the session busy', () => {
    const manager = createManager();
    markBusy(manager, 's1');
    manager.reconcileStaleBusySessions({ s1: { type: 'busy' } }, GRACE_MS, 1000);
    const stale = manager.reconcileStaleBusySessions(
      { s1: { type: 'busy' } },
      GRACE_MS,
      1000 + GRACE_MS
    );
    expect(stale).toEqual([]);
    expect(manager.busy.has('s1')).toBe(true);
  });

  it('resets the grace timer when the server reports busy again', () => {
    const manager = createManager();
    markBusy(manager, 's1');
    manager.reconcileStaleBusySessions({}, GRACE_MS, 1000);
    manager.reconcileStaleBusySessions({ s1: { type: 'busy' } }, GRACE_MS, 2000);
    const stale = manager.reconcileStaleBusySessions({}, GRACE_MS, 2000 + GRACE_MS - 1);
    expect(stale).toEqual([]);
    expect(manager.busy.has('s1')).toBe(true);
  });

  it('does not reconcile sessions awaiting input', () => {
    const manager = createManager();
    markBusy(manager, 's1');
    manager.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'perm-1', sessionID: 's1', title: 'Use Bash' },
    });
    const stale = manager.reconcileStaleBusySessions({}, GRACE_MS, 1000 + GRACE_MS + 1);
    expect(stale).toEqual([]);
  });

  it('reconciles multiple stale sessions at once', () => {
    const manager = createManager();
    markBusy(manager, 's1');
    markBusy(manager, 's2');
    manager.reconcileStaleBusySessions({}, GRACE_MS, 1000);
    const stale = manager.reconcileStaleBusySessions({}, GRACE_MS, 1000 + GRACE_MS);
    expect(stale.toSorted()).toEqual(['s1', 's2']);
    expect(manager.busy.size).toBe(0);
  });
});
