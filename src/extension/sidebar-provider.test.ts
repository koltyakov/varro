import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock, vscodeMock, spawnMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  spawnMock: vi.fn(),
  vscodeMock: {
    window: {
      createStatusBarItem: vi.fn(() => ({
        name: '',
        command: '',
        text: '',
        tooltip: '',
        backgroundColor: undefined,
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
      })),
      onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
      activeColorTheme: { kind: 2 },
      showTextDocument: vi.fn(() => Promise.resolve()),
    },
    workspace: {
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, fallback?: unknown) => fallback),
        update: vi.fn(() => Promise.resolve()),
      })),
      openTextDocument: vi.fn(() => Promise.resolve({})),
    },
    StatusBarAlignment: { Left: 1 },
    ThemeColor: vi.fn((value: string) => ({ value })),
    ColorThemeKind: {
      Light: 1,
      Dark: 2,
      HighContrast: 3,
      HighContrastLight: 4,
    },
    Uri: {
      joinPath: vi.fn(() => ({ toString: () => 'vscode-resource://icon.png' })),
      file: vi.fn((fsPath: string) => ({ fsPath, toString: () => fsPath })),
    },
  },
}));

vi.mock('vscode', () => vscodeMock);
vi.mock('child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));
vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('./error-hub', () => ({
  errorHub: {
    report: vi.fn(),
    reportCliMissing: vi.fn(),
  },
}));

import { SidebarProvider } from './sidebar-provider';

describe('SidebarProvider blocking request replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replays pending permission requests after the webview becomes ready', async () => {
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn(() => Promise.resolve()),
    };

    const contextProvider = {
      context: {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      terminalSelection: null,
    };

    const server = {
      status: { state: 'running', url: 'http://127.0.0.1:4096' },
      on: vi.fn(),
      off: vi.fn(),
      start: vi.fn(() => Promise.resolve('http://127.0.0.1:4096')),
      request: vi.fn(),
    };

    const provider = new SidebarProvider(
      { fsPath: '/extension' } as never,
      workspaceState as never,
      contextProvider as never,
      server as never
    );

    const posted: unknown[] = [];
    const webviewView = {
      visible: true,
      webview: {
        options: {},
        html: '',
        postMessage: vi.fn((msg: unknown) => {
          posted.push(msg);
          return true;
        }),
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
        asWebviewUri: vi.fn((uri: { toString?: () => string }) => uri),
      },
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
    };

    const providerState = provider as unknown as {
      view: unknown;
      blockingRequestsForWebview: Array<{
        id: string;
        sessionID: string;
        kind: 'permission' | 'question';
        props: Record<string, unknown>;
      }>;
      sessionState: { handleServerEvent(event: unknown): void };
    };
    providerState.view = webviewView;
    providerState.blockingRequestsForWebview = [
      {
        id: 'perm-1',
        sessionID: 'session-1',
        kind: 'permission',
        props: {
          id: 'perm-1',
          sessionID: 'session-1',
          permission: 'bash',
          title: 'Run Bash command',
          tool: { messageID: 'msg-1', callID: 'call-1' },
        },
      },
    ];

    providerState.sessionState.handleServerEvent({
      type: 'permission.asked',
      properties: {
        id: 'perm-1',
        sessionID: 'session-1',
        permission: 'bash',
        title: 'Run Bash command',
        tool: { messageID: 'msg-1', callID: 'call-1' },
      },
    });

    await provider.handleMessage({ type: 'ready' });

    expect(posted).toContainEqual({
      type: 'server/event',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm-1',
          sessionID: 'session-1',
          permission: 'bash',
          title: 'Run Bash command',
          tool: { messageID: 'msg-1', callID: 'call-1' },
        },
      },
    });
  });

  it('clears resolved embedded permission requests before replay on ready', async () => {
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn(() => Promise.resolve()),
    };

    const contextProvider = {
      context: {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      terminalSelection: null,
    };

    const server = {
      status: { state: 'running', url: 'http://127.0.0.1:4096' },
      on: vi.fn(),
      off: vi.fn(),
      start: vi.fn(() => Promise.resolve('http://127.0.0.1:4096')),
      request: vi.fn(),
    };

    const provider = new SidebarProvider(
      { fsPath: '/extension' } as never,
      workspaceState as never,
      contextProvider as never,
      server as never
    );

    const posted: unknown[] = [];
    const webviewView = {
      visible: true,
      webview: {
        options: {},
        html: '',
        postMessage: vi.fn((msg: unknown) => {
          posted.push(msg);
          return true;
        }),
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
        asWebviewUri: vi.fn((uri: { toString?: () => string }) => uri),
      },
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
    };

    const providerState = provider as unknown as {
      view: unknown;
      blockingRequestsForWebview: Array<{
        id: string;
        sessionID: string;
        kind: 'permission' | 'question';
        props: Record<string, unknown>;
      }>;
      sessionState: { handleServerEvent(event: unknown): void };
    };
    providerState.view = webviewView;
    providerState.blockingRequestsForWebview = [
      {
        id: 'perm-1',
        sessionID: 'session-1',
        kind: 'permission',
        props: {
          id: 'perm-1',
          sessionID: 'session-1',
          permission: 'bash',
          title: 'Run Bash command',
          tool: { messageID: 'msg-1', callID: 'call-1' },
        },
      },
    ];

    providerState.sessionState.handleServerEvent({
      type: 'permission.replied',
      properties: {
        permissionID: 'perm-1',
        sessionID: 'session-1',
      },
    });

    await provider.handleMessage({ type: 'ready' });

    expect(posted).toContainEqual({
      type: 'server/event',
      payload: {
        type: 'permission.replied',
        properties: {
          id: 'perm-1',
          permissionID: 'perm-1',
          requestID: 'perm-1',
          sessionID: 'session-1',
        },
      },
    });
    expect(posted).not.toContainEqual({
      type: 'server/event',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm-1',
          sessionID: 'session-1',
          permission: 'bash',
          title: 'Run Bash command',
          tool: { messageID: 'msg-1', callID: 'call-1' },
        },
      },
    });
  });

  it('exports a session through the OpenCode CLI and opens the result', async () => {
    const stdoutHandlers: Array<(data: Buffer) => void> = [];
    const stderrHandlers: Array<(data: Buffer) => void> = [];
    const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    spawnMock.mockReturnValue({
      stdout: {
        on: vi.fn((_event: string, handler: (data: Buffer) => void) =>
          stdoutHandlers.push(handler)
        ),
      },
      stderr: {
        on: vi.fn((_event: string, handler: (data: Buffer) => void) =>
          stderrHandlers.push(handler)
        ),
      },
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit')
          exitHandlers.push(
            handler as (code: number | null, signal: NodeJS.Signals | null) => void
          );
      }),
    });

    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn(() => Promise.resolve()),
    };

    const contextProvider = {
      context: {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      terminalSelection: null,
    };

    const server = {
      status: { state: 'running', url: 'http://127.0.0.1:4096' },
      on: vi.fn(),
      off: vi.fn(),
      start: vi.fn(() => Promise.resolve('http://127.0.0.1:4096')),
      request: vi.fn(),
      resolveCommand: vi.fn(() => 'opencode'),
      getWorkspaceCwd: vi.fn(() => '/repo'),
    };

    const provider = new SidebarProvider(
      { fsPath: '/extension' } as never,
      workspaceState as never,
      contextProvider as never,
      server as never
    );

    const exportPromise = provider.handleMessage({
      type: 'session/export',
      payload: { sessionId: 'session-1' },
    });

    stdoutHandlers.forEach((handler) => handler(Buffer.from('{"id":"session-1"}')));
    exitHandlers.forEach((handler) => handler(0, null));
    await exportPromise;

    expect(spawnMock).toHaveBeenCalled();
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      language: 'json',
      content: '{"id":"session-1"}',
    });
    expect(vscodeMock.window.showTextDocument).toHaveBeenCalled();
  });
});
