import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock, vscodeMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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
    },
    workspace: {
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, fallback?: unknown) => fallback),
        update: vi.fn(() => Promise.resolve()),
      })),
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
    },
  },
}));

vi.mock('vscode', () => vscodeMock);
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
});
