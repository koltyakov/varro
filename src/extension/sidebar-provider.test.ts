import { writeSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'fs/promises';

const { loggerMock, vscodeMock, spawnMock, mkdtempMock, openMock, readFileMock, rmMock } =
  vi.hoisted(() => ({
    loggerMock: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    spawnMock: vi.fn(),
    mkdtempMock: vi.fn(),
    openMock: vi.fn(),
    readFileMock: vi.fn(),
    rmMock: vi.fn(),
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
        showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
      },
      workspace: {
        onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
        getConfiguration: vi.fn(() => ({
          get: vi.fn((_key: string, fallback?: unknown) => fallback),
          update: vi.fn(() => Promise.resolve()),
        })),
        fs: {
          readFile: vi.fn(),
          writeFile: vi.fn(() => Promise.resolve()),
        },
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
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises');
  return {
    ...actual,
    mkdtemp: mkdtempMock,
    open: openMock,
    readFile: readFileMock,
    rm: rmMock,
  };
});
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises');
  return {
    ...actual,
    mkdtemp: mkdtempMock,
    open: openMock,
    readFile: readFileMock,
    rm: rmMock,
  };
});
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
    mkdtempMock.mockResolvedValue('/tmp/varro-opencode-export-123');
    openMock.mockResolvedValue({ fd: 17, close: vi.fn(() => Promise.resolve()) });
    readFileMock.mockReset();
    rmMock.mockResolvedValue(undefined);
  });

  it('reads model routing from project opencode.json', async () => {
    vscodeMock.workspace.fs.readFile.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          small_model: 'openai/gpt-5-mini',
          agent: {
            build: { model: 'openai/gpt-5' },
            review: { model: 'anthropic/claude-sonnet-4' },
          },
        })
      )
    );

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
      getWorkspaceCwd: vi.fn(() => '/repo'),
    };

    const provider = new SidebarProvider(
      { fsPath: '/extension' } as never,
      workspaceState as never,
      contextProvider as never,
      server as never
    );

    const posted: unknown[] = [];
    const providerState = provider as unknown as { view: unknown };
    providerState.view = {
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

    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 1, method: 'GET', path: '/varro/opencode-config' },
    });

    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 1,
        data: {
          smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
          agentModels: {
            build: { providerID: 'openai', modelID: 'gpt-5' },
            review: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          },
        },
      },
    });
  });

  it('writes small_model routing to project opencode.json', async () => {
    vscodeMock.workspace.fs.readFile.mockRejectedValueOnce({ code: 'FileNotFound' });

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
      getWorkspaceCwd: vi.fn(() => '/repo'),
    };

    const provider = new SidebarProvider(
      { fsPath: '/extension' } as never,
      workspaceState as never,
      contextProvider as never,
      server as never
    );

    const posted: unknown[] = [];
    const providerState = provider as unknown as { view: unknown };
    providerState.view = {
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

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 2,
        method: 'POST',
        path: '/varro/opencode-config/model-routing',
        body: { target: 'small_model', providerID: 'openai', modelID: 'gpt-5-mini' },
      },
    });

    expect(vscodeMock.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    const firstWriteCall = vscodeMock.workspace.fs.writeFile.mock.calls[0];
    expect(firstWriteCall).toBeTruthy();
    const firstWriteArgs = firstWriteCall as unknown[] | undefined;
    expect(firstWriteArgs?.[0]).toEqual(expect.objectContaining({ fsPath: '/repo/opencode.json' }));
    const encoded = firstWriteArgs?.[1];
    expect(encoded).toBeTruthy();
    const written = JSON.parse(new TextDecoder().decode(encoded as Uint8Array<ArrayBuffer>));
    expect(written).toEqual({
      $schema: 'https://opencode.ai/config.json',
      small_model: 'openai/gpt-5-mini',
    });
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 2,
        data: {
          smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
          agentModels: {},
        },
      },
    });
  });

  it('writes agent model routing while preserving existing config keys', async () => {
    vscodeMock.workspace.fs.readFile.mockResolvedValueOnce(
      new TextEncoder().encode(
        JSON.stringify({
          model: 'openai/gpt-5',
          agent: {
            build: { mode: 'primary', model: 'openai/gpt-5' },
          },
        })
      )
    );

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
      getWorkspaceCwd: vi.fn(() => '/repo'),
    };

    const provider = new SidebarProvider(
      { fsPath: '/extension' } as never,
      workspaceState as never,
      contextProvider as never,
      server as never
    );

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 3,
        method: 'POST',
        path: '/varro/opencode-config/model-routing',
        body: {
          target: 'agent',
          agentName: 'review',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4',
        },
      },
    });

    const lastWriteCall = vscodeMock.workspace.fs.writeFile.mock.calls.at(-1);
    expect(lastWriteCall).toBeTruthy();
    const lastWriteArgs = lastWriteCall as unknown[] | undefined;
    const encoded = lastWriteArgs?.[1];
    expect(encoded).toBeTruthy();
    const written = JSON.parse(new TextDecoder().decode(encoded as Uint8Array<ArrayBuffer>));
    expect(written).toEqual({
      $schema: 'https://opencode.ai/config.json',
      model: 'openai/gpt-5',
      agent: {
        build: { mode: 'primary', model: 'openai/gpt-5' },
        review: { model: 'anthropic/claude-sonnet-4' },
      },
    });
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
    const closeHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    spawnMock.mockReturnValue({
      stderr: {
        on: vi.fn(),
      },
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHandlers.push(
            handler as (code: number | null, signal: NodeJS.Signals | null) => void
          );
        }
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

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(closeHandlers).toHaveLength(1);
    });
    const options = spawnMock.mock.calls[0]?.[2] as { stdio?: unknown[] } | undefined;
    const outputFd = Array.isArray(options?.stdio) ? (options.stdio[1] as number) : undefined;
    expect(typeof outputFd).toBe('number');
    writeSync(outputFd!, '{"id":"session-1"}');
    closeHandlers[0]?.(0, null);
    await exportPromise;

    expect(spawnMock).toHaveBeenCalled();
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      language: 'json',
      content: '{"id":"session-1"}',
    });
    expect(vscodeMock.window.showTextDocument).toHaveBeenCalled();
  });

  it('waits for close before opening a large export result', async () => {
    const closeHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    spawnMock.mockReturnValue({
      stderr: {
        on: vi.fn(),
      },
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHandlers.push(
            handler as (code: number | null, signal: NodeJS.Signals | null) => void
          );
        }
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

    expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(closeHandlers).toHaveLength(1);
    });
    const options = spawnMock.mock.calls[0]?.[2] as { stdio?: unknown[] } | undefined;
    const outputFd = Array.isArray(options?.stdio) ? (options.stdio[1] as number) : undefined;
    expect(typeof outputFd).toBe('number');
    const content = '{"items":[{"id":1}]}';
    writeSync(outputFd!, content);
    closeHandlers[0]?.(0, null);
    await exportPromise;

    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      language: 'json',
      content,
    });
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows an error when export output is invalid JSON', async () => {
    const closeHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    spawnMock.mockReturnValue({
      stderr: {
        on: vi.fn(),
      },
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHandlers.push(
            handler as (code: number | null, signal: NodeJS.Signals | null) => void
          );
        }
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

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(closeHandlers).toHaveLength(1);
    });
    const options = spawnMock.mock.calls[0]?.[2] as { stdio?: unknown[] } | undefined;
    const outputFd = Array.isArray(options?.stdio) ? (options.stdio[1] as number) : undefined;
    expect(typeof outputFd).toBe('number');
    writeSync(outputFd!, '{"items":[');
    closeHandlers[0]?.(0, null);
    await exportPromise;

    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export session: OpenCode export returned invalid JSON')
    );
    expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('exports through a temp file to avoid stdout truncation', async () => {
    const closeHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

    spawnMock.mockReturnValue({
      stderr: {
        on: vi.fn(),
      },
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHandlers.push(
            handler as (code: number | null, signal: NodeJS.Signals | null) => void
          );
        }
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

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(closeHandlers).toHaveLength(1);
    });
    const options = spawnMock.mock.calls[0]?.[2] as { stdio?: unknown[] } | undefined;
    expect(Array.isArray(options?.stdio)).toBe(true);
    expect(options?.stdio?.[0]).toBe('ignore');
    expect(typeof options?.stdio?.[1]).toBe('number');
    expect(options?.stdio?.[2]).toBe('pipe');
    const outputFd = options?.stdio?.[1] as number;
    const content = `{"items":[{"id":1,"text":"${'x'.repeat(70_000)}"}]}`;
    writeSync(outputFd, content);
    closeHandlers[0]?.(0, null);
    await exportPromise;

    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      language: 'json',
      content,
    });
  });
});
