import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registeredCommands, vscodeMock } = vi.hoisted(() => {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const vscode = {
    version: '1.120.0',
    commands: {
      registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
        commands.set(id, handler);
        return { dispose: vi.fn() };
      }),
      executeCommand: vi.fn(() => Promise.resolve()),
    },
    workspace: {
      fs: {
        createDirectory: vi.fn(() => Promise.resolve()),
        stat: vi.fn(() => Promise.resolve({ type: 1 })),
        writeFile: vi.fn(() => Promise.resolve()),
      },
      openTextDocument: vi.fn((uri: unknown) => Promise.resolve({ uri })),
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, fallback: unknown) => fallback),
      })),
      getWorkspaceFolder: vi.fn(() => undefined),
    },
    window: {
      activeTextEditor: undefined,
      showTextDocument: vi.fn(() => Promise.resolve()),
      showWarningMessage: vi.fn(() => Promise.resolve()),
      showErrorMessage: vi.fn(() => Promise.resolve()),
    },
    Uri: {
      file: vi.fn((fsPath: string) => ({ fsPath })),
      joinPath: vi.fn((base: { fsPath: string }, ...parts: string[]) => ({
        fsPath: [base.fsPath.replace(/\/$/, ''), ...parts].join('/'),
      })),
    },
    FileType: { Directory: 2 },
  };
  return { registeredCommands: commands, vscodeMock: vscode };
});

vi.mock('vscode', () => vscodeMock);
vi.mock('./open-code-process', () => ({
  getOpenCodeConfigDirectory: () => '/config/opencode',
}));
vi.mock('./logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), show: vi.fn() },
}));
vi.mock('./error-hub', () => ({ errorHub: { report: vi.fn() } }));

import { registerCommands } from './commands';

function register(workspacePath: string | null = '/repo', server: unknown = {}) {
  registeredCommands.clear();
  const sidebar = {
    post: vi.fn(),
    postCommand: vi.fn(),
    requestInputFocus: vi.fn(),
    searchSessions: vi.fn(),
    switchSession: vi.fn(),
    hasPendingAttention: vi.fn(() => false),
    openAttentionSessions: vi.fn(),
    postDroppedFiles: vi.fn(),
    postTerminalSelection: vi.fn(),
  };
  const contextProvider = {
    context: { workspacePath },
    terminalSelection: null,
    captureTerminalSelection: vi.fn(),
  };
  const context = { subscriptions: [] };

  registerCommands(context as never, sidebar as never, contextProvider as never, server as never);
  return { sidebar };
}

describe('About command', () => {
  it('shows OpenCode server diagnostics', async () => {
    register('/repo', {
      readServerInfo: vi.fn().mockResolvedValue({
        status: { state: 'running', url: 'http://127.0.0.1:4096' },
        url: 'http://127.0.0.1:4096',
        port: 4096,
        command: 'opencode',
        managedProcess: true,
        cliVersion: '1.18.4',
        cliVersionError: null,
        activeAgentCount: 1,
        activeAgentError: null,
        health: { healthy: true, version: '1.18.4' },
        workspaceCwd: '/repo',
      }),
    });

    await runCommand('varro.about');

    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('- Active agents: 1') })
    );
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.not.stringContaining('- Loaded workspaces:') })
    );
  });
});

async function runCommand(id: string) {
  const handler = registeredCommands.get(id);
  expect(handler).toBeTypeOf('function');
  await handler?.();
}

describe('AGENTS.md commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 1 });
  });

  it('creates and opens the global AGENTS.md when it is absent', async () => {
    vscodeMock.workspace.fs.stat.mockRejectedValueOnce({ code: 'FileNotFound' });
    register();

    await runCommand('varro.agents.openGlobal');

    expect(vscodeMock.workspace.fs.createDirectory).toHaveBeenCalledWith({
      fsPath: '/config/opencode',
    });
    expect(vscodeMock.workspace.fs.writeFile).toHaveBeenCalledWith(
      { fsPath: '/config/opencode/AGENTS.md' },
      expect.any(Uint8Array)
    );
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      fsPath: '/config/opencode/AGENTS.md',
    });
    expect(vscodeMock.window.showTextDocument).toHaveBeenCalledWith(expect.anything(), {
      preview: false,
    });
  });

  it('opens an existing project AGENTS.md without overwriting it and prefills /init', async () => {
    const { sidebar } = register('/repo');

    await runCommand('varro.agents.initializeProject');

    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      fsPath: '/repo/AGENTS.md',
    });
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.view.extension.varro'
    );
    expect(sidebar.post).toHaveBeenCalledWith({
      type: 'command/new-session',
      payload: { prefill: '/init' },
    });
    expect(sidebar.requestInputFocus).toHaveBeenCalledOnce();
  });

  it('creates an empty project AGENTS.md when it is absent', async () => {
    vscodeMock.workspace.fs.stat.mockRejectedValueOnce({ code: 'FileNotFound' });
    register('/repo');

    await runCommand('varro.agents.initializeProject');

    const [, content] = vscodeMock.workspace.fs.writeFile.mock.calls[0] ?? [];
    expect(content).toBeInstanceOf(Uint8Array);
    expect(content).toHaveLength(0);
  });

  it('requires an open project before initializing project AGENTS.md', async () => {
    const { sidebar } = register(null);

    await runCommand('varro.agents.initializeProject');

    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
      'Varro: Open a project before initializing AGENTS.md.'
    );
    expect(vscodeMock.workspace.fs.createDirectory).not.toHaveBeenCalled();
    expect(sidebar.post).not.toHaveBeenCalled();
  });
});
