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

function createManager(shouldShow: () => boolean = () => true) {
  const workspaceState = {
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
    update: vi.fn(() => Promise.resolve()),
  };
  const listener = {
    onPendingAttentionChange: vi.fn(),
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
});
