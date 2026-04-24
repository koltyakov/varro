import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock, mockStatusBarItem, vscodeMock } = vi.hoisted(() => {
  const statusBarItemMock = {
    text: '',
    backgroundColor: undefined,
    tooltip: '',
    name: '',
    command: undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    loggerMock: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    mockStatusBarItem: statusBarItemMock,
    vscodeMock: {
      window: {
        state: { focused: true },
        createStatusBarItem: vi.fn(() => statusBarItemMock),
        onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
        showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
        showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
        showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
      },
      workspace: {
        onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
        getConfiguration: vi.fn(() => ({ get: vi.fn() })),
      },
      commands: {
        executeCommand: vi.fn(() => Promise.resolve(undefined)),
      },
      StatusBarAlignment: {
        Left: 1,
      },
      ThemeColor: class ThemeColor {
        constructor(public readonly id: string) {}
      },
    },
  };
});

vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('vscode', () => vscodeMock);

import { SidebarProvider } from './sidebar-provider';

function createProvider() {
  const workspaceState = {
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
    update: vi.fn(() => Promise.resolve()),
  };
  const server = {
    status: { state: 'stopped' },
    on: vi.fn(),
  };

  const provider = new SidebarProvider(
    {} as never,
    workspaceState as never,
    {} as never,
    server as never
  );

  (
    provider as unknown as {
      view: { visible: boolean; webview: { postMessage: (message: unknown) => Thenable<boolean> } };
      webviewHasFocus: boolean;
    }
  ).view = {
    visible: true,
    webview: {
      postMessage: vi.fn(() => Promise.resolve(true)),
    },
  };
  (provider as unknown as { webviewHasFocus: boolean }).webviewHasFocus = false;

  return provider as unknown as {
    handleServerEvent: (event: Record<string, unknown>) => void;
  };
}

describe('SidebarProvider notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.window.state.focused = true;
    mockStatusBarItem.text = '';
    mockStatusBarItem.backgroundColor = undefined;
    mockStatusBarItem.tooltip = '';
    mockStatusBarItem.name = '';
    mockStatusBarItem.command = undefined;
  });

  it('shows permission notifications when the chat view is visible but not focused', () => {
    const provider = createProvider();

    provider.handleServerEvent({
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

  it('shows a plan-ready notification for completed plan sessions', () => {
    const provider = createProvider();

    provider.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Auth cleanup' } },
    });
    provider.handleServerEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          agent: 'plan',
        },
      },
    });
    provider.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    provider.handleServerEvent({
      type: 'session.idle',
      properties: { sessionID: 'session-1' },
    });

    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      'Varro has a plan ready for review for "Auth cleanup".',
      'Open Chat'
    );
  });

  it('shows one failure notification when a background session errors', () => {
    const provider = createProvider();

    provider.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Build release' } },
    });
    provider.handleServerEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          agent: 'build',
          error: {
            name: 'BashError',
            data: { message: 'Command failed' },
          },
        },
      },
    });
    provider.handleServerEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          error: {
            name: 'BashError',
            data: { message: 'Command failed' },
          },
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
