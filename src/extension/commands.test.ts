/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-module-mocking, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- These tests exercise command import boundaries with malformed VS Code and process results. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configInspectMock, configUpdateMock, registeredCommands, vscodeMock } = vi.hoisted(() => {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const configInspect = vi.fn(() => undefined as { workspaceValue?: boolean } | undefined);
  const configUpdate = vi.fn(() => Promise.resolve());
  const vscode = {
    version: '1.120.0',
    commands: {
      registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
        commands.set(id, handler);
        return { dispose: vi.fn() };
      }),
      executeCommand: vi.fn((_command: string, ..._args: unknown[]) => Promise.resolve()),
    },
    workspace: {
      fs: {
        createDirectory: vi.fn(() => Promise.resolve()),
        stat: vi.fn((_target: { fsPath: string }) => Promise.resolve({ type: 1 })),
        writeFile: vi.fn((_target: { fsPath: string }, _content: Uint8Array) => Promise.resolve()),
      },
      openTextDocument: vi.fn((uri: unknown) => Promise.resolve({ uri })),
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, fallback: unknown) => fallback),
        inspect: configInspect,
        update: configUpdate,
      })),
      getWorkspaceFolder: vi.fn(() => undefined),
      asRelativePath: vi.fn((uri: { fsPath: string } | string) =>
        (typeof uri === 'string' ? uri : uri.fsPath).replace(/^\/repo\//, '')
      ),
      workspaceFolders: undefined as { name: string }[] | undefined,
    },
    window: {
      activeTextEditor: undefined,
      showTextDocument: vi.fn(() => Promise.resolve()),
      showWarningMessage: vi.fn(() => Promise.resolve()),
      showErrorMessage: vi.fn(() => Promise.resolve()),
    },
    Uri: {
      file: vi.fn((fsPath: string) => ({ fsPath })),
      parse: vi.fn((value: string) => ({ value })),
      joinPath: vi.fn((base: { fsPath: string }, ...parts: string[]) => ({
        fsPath: [base.fsPath.replace(/\/$/, ''), ...parts].join('/'),
      })),
    },
    env: {
      openExternal: vi.fn(() => Promise.resolve(true)),
    },
    FileType: { Directory: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
  };
  return {
    configInspectMock: configInspect,
    configUpdateMock: configUpdate,
    registeredCommands: commands,
    vscodeMock: vscode,
  };
});

vi.mock('vscode', () => vscodeMock);
vi.mock('./open-code-process', () => ({
  getOpenCodeConfigDirectory: () => '/config/opencode',
}));
const { errorHubMock, loggerMock } = vi.hoisted(() => ({
  errorHubMock: { report: vi.fn() },
  loggerMock: { error: vi.fn(), info: vi.fn(), show: vi.fn() },
}));

vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('./error-hub', () => ({ errorHub: errorHubMock }));

import { registerCommands } from './commands';
import { RestartBlockedError } from './server';

function register(
  workspacePath: string | null = '/repo',
  server: unknown = {},
  viewContainerCommand: string | (() => Promise<unknown>) = 'workbench.view.extension.varro'
) {
  registeredCommands.clear();
  const sidebar = {
    post: vi.fn(),
    postCommand: vi.fn(),
    openNewEditor: vi.fn(() => Promise.resolve()),
    requestInputFocus: vi.fn(),
    searchSessions: vi.fn(),
    switchSession: vi.fn(),
    hasPendingAttention: vi.fn(() => false),
    openAttentionSessions: vi.fn(),
    postDroppedFiles: vi.fn(),
    postTerminalSelection: vi.fn(),
    generateCommitMessage: vi.fn(() => Promise.resolve()),
    generateUsageReport: vi.fn(() => Promise.resolve()),
    openMarkdownDocument: vi.fn(async (content: string, title: string, _show?: boolean) => {
      await vscodeMock.workspace.openTextDocument({
        language: 'markdown',
        content,
      });
      return { value: `varro-tool-output:/${title}.md` };
    }),
  };
  const contextProvider = {
    context: { workspacePath },
    terminalSelection: null as { text: string; terminalName: string } | null,
    captureTerminalSelection: vi.fn(),
  };
  const context = { subscriptions: [] };
  const revealSidebar =
    typeof viewContainerCommand === 'function'
      ? viewContainerCommand
      : () => vscodeMock.commands.executeCommand(viewContainerCommand);

  (
    registerCommands as unknown as (
      context: unknown,
      sidebar: unknown,
      contextProvider: unknown,
      server: unknown,
      revealSidebar: () => Promise<unknown>
    ) => void
  )(context, sidebar, contextProvider, server, revealSidebar);
  return { contextProvider, sidebar };
}

describe('About command', () => {
  it('shows OpenCode server diagnostics', async () => {
    const { sidebar } = register('/repo', {
      readServerInfo: vi.fn().mockResolvedValue({
        status: { state: 'running', url: 'http://127.0.0.1:4096' },
        url: 'http://127.0.0.1:4096',
        port: 4096,
        command: 'opencode',
        managedProcess: true,
        cliVersion: '1.18.4',
        cliVersionError: null,
        installMethod: 'bun',
        resolvedCommand: '/home/me/.bun/bin/opencode',
        searchedPaths: ['/home/me/.bun/bin'],
        activeAgentCount: 1,
        activeAgentError: null,
        health: { healthy: true, version: '1.18.4' },
        workspaceCwd: '/repo',
      }),
    });

    await runCommand('varro.about');

    expect(sidebar.openMarkdownDocument).toHaveBeenCalledWith(
      expect.stringContaining('  - **Active agents:** `1`'),
      'Varro About',
      false
    );
    const aboutMarkdown = sidebar.openMarkdownDocument.mock.calls[0]?.[0] ?? '';
    expect(aboutMarkdown).toMatch(/^# Varro\n/);
    expect(aboutMarkdown).not.toContain('# Varro About');
    expect(aboutMarkdown).not.toMatch(
      /SDK version|Minimum supported version|Maximum tested version|CLI command/
    );
    expect(aboutMarkdown).toContain(
      '- **CLI:**\n  - **Version:** `1.18.4`\n  - **Install method:** bun\n  - **Binary:** `/home/me/.bun/bin/opencode`'
    );
    expect(aboutMarkdown).toContain(
      '- **Server:**\n  - **Version:** `1.18.4`\n  - **URL:** [http://127.0.0.1:4096](http://127.0.0.1:4096)\n  - **Ownership:** managed by Varro\n  - **Active agents:** `1`\n- **Auto updates:** enabled'
    );
    expect(aboutMarkdown).toContain(
      '## Diagnostics\n- CLI version: 1.18.4\n- Resolved binary: /home/me/.bun/bin/opencode\n- Server status: running, event stream unknown\n- Server health: healthy\n- Server port: 4096\n- Auto start: disabled\n- Auto updates: enabled\n- Workspace: /repo'
    );
    expect(sidebar.openMarkdownDocument).toHaveBeenCalledWith(
      expect.stringContaining('- [GitHub repository](https://github.com/koltyakov/varro)'),
      'Varro About',
      false
    );
    expect(sidebar.openMarkdownDocument).toHaveBeenCalledWith(
      expect.stringContaining(
        '- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro)'
      ),
      'Varro About',
      false
    );
    expect(sidebar.openMarkdownDocument).toHaveBeenCalledWith(
      expect.stringContaining(
        '- [Open VSX Registry](https://open-vsx.org/extension/koltyakov/varro)'
      ),
      'Varro About',
      false
    );
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'markdown.showPreview',
      expect.objectContaining({ value: 'varro-tool-output:/Varro About.md' })
    );
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('  - **Active agents:** `1`'),
      })
    );
    // The About report is the paste-ready hand-off for update bug reports.
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('  - **Install method:** bun'),
      })
    );
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('  - **Binary:** `/home/me/.bun/bin/opencode`'),
      })
    );
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          '**OpenCode 1.18.21 is available.**\n\nRun this command to install the update:\n\n```sh\nbun add -g opencode-ai@latest\n```'
        ),
      })
    );
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.not.stringContaining('Loaded workspaces') })
    );
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.not.stringContaining('Searched PATH entries') })
    );
  });

  it('does not distinguish which Varro window manages the server', async () => {
    register('/repo', {
      readServerInfo: vi.fn().mockResolvedValue({
        status: { state: 'running', url: 'http://127.0.0.1:4096' },
        url: 'http://127.0.0.1:4096',
        port: 4096,
        command: 'opencode',
        managedProcess: false,
        ownership: 'other-host',
        cliVersion: '1.18.9',
        cliVersionError: null,
        installMethod: 'curl',
        resolvedCommand: '/home/me/.opencode/bin/opencode',
        searchedPaths: [],
        activeAgentCount: 0,
        activeAgentError: null,
        health: { healthy: true, version: '1.18.9' },
        workspaceCwd: '/repo',
      }),
    });

    await runCommand('varro.about');

    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('  - **Ownership:** managed by Varro'),
      })
    );
  });

  it('hides the update notice when OpenCode is at the tested update ceiling', async () => {
    register('/repo', {
      readServerInfo: vi.fn().mockResolvedValue({
        status: { state: 'running', url: 'http://127.0.0.1:4096' },
        url: 'http://127.0.0.1:4096',
        port: 4096,
        command: 'opencode',
        managedProcess: true,
        cliVersion: '1.18.21',
        cliVersionError: null,
        installMethod: 'bun',
        resolvedCommand: '/home/me/.bun/bin/opencode',
        searchedPaths: [],
        activeAgentCount: 0,
        activeAgentError: null,
        health: { healthy: true, version: '1.18.21' },
        workspaceCwd: '/repo',
      }),
    });

    await runCommand('varro.about');

    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.not.stringContaining('is available'),
      })
    );
  });
});

function fileUri(fsPath: string) {
  return { fsPath };
}

async function runCommand(id: string, ...args: unknown[]) {
  const handler = registeredCommands.get(id);
  expect(handler).toBeTypeOf('function');
  await handler?.(...args);
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
    expect(sidebar.postCommand).toHaveBeenCalledWith('new-session', { prefill: '/init' });
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

describe('terminal selection command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['no-terminal', 'Varro: Open and focus a terminal first.'],
    ['empty-selection', 'Varro: Select text in the terminal first.'],
  ] as const)('clears the webview after a %s recapture', async (reason, warning) => {
    const { contextProvider, sidebar } = register();
    contextProvider.terminalSelection = { text: 'stale output', terminalName: 'Terminal 1' };
    contextProvider.captureTerminalSelection.mockResolvedValue({ ok: false, reason });

    await runCommand('varro.chat.addTerminalSelectionToContext');

    expect(sidebar.postTerminalSelection).toHaveBeenCalledWith(null);
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(warning);
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalledWith(
      'workbench.view.extension.varro'
    );
  });

  it('clears the webview when terminal recapture throws', async () => {
    const { contextProvider, sidebar } = register();
    contextProvider.terminalSelection = { text: 'stale output', terminalName: 'Terminal 1' };
    contextProvider.captureTerminalSelection.mockRejectedValue(new Error('copy failed'));

    await runCommand('varro.chat.addTerminalSelectionToContext');

    expect(sidebar.postTerminalSelection).toHaveBeenCalledWith(null);
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalledWith(
      'workbench.view.extension.varro'
    );
  });
});

describe('varro.chat.addToContext', () => {
  const FILE = 1;
  const DIRECTORY = 2;

  async function addToContext(...args: unknown[]) {
    const handler = registeredCommands.get('varro.chat.addToContext');
    expect(handler).toBeTypeOf('function');
    await handler?.(...args);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.window.activeTextEditor = undefined;
    vscodeMock.workspace.workspaceFolders = undefined;
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: FILE });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
  });

  it('posts an explicit multi-selection and ignores the single-uri argument', async () => {
    const { sidebar } = register();

    await addToContext(fileUri('/repo/ignored.ts'), [fileUri('/repo/a.ts'), fileUri('/repo/b.ts')]);

    expect(sidebar.postDroppedFiles).toHaveBeenCalledWith([
      { path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
      { path: '/repo/b.ts', relativePath: 'b.ts', type: 'file' },
    ]);
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.view.extension.varro'
    );
  });

  it('falls back to the single uri when the multi-selection is empty', async () => {
    const { sidebar } = register();

    await addToContext(fileUri('/repo/a.ts'), []);

    expect(sidebar.postDroppedFiles).toHaveBeenCalledWith([
      { path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
    ]);
  });

  it('falls back to the active editor when invoked with no arguments', async () => {
    const { sidebar } = register();
    vscodeMock.window.activeTextEditor = { document: { uri: fileUri('/repo/open.ts') } } as never;

    await addToContext();

    expect(sidebar.postDroppedFiles).toHaveBeenCalledWith([
      { path: '/repo/open.ts', relativePath: 'open.ts', type: 'file' },
    ]);
  });

  it('does nothing when there is no target and no active editor', async () => {
    const { sidebar } = register();

    await addToContext();

    expect(sidebar.postDroppedFiles).not.toHaveBeenCalled();
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('marks directories so the webview can expand them', async () => {
    const { sidebar } = register();
    vscodeMock.workspace.fs.stat.mockImplementation((target: { fsPath: string }) =>
      Promise.resolve({ type: target.fsPath.endsWith('/src') ? DIRECTORY : FILE })
    );

    await addToContext(undefined, [fileUri('/repo/src'), fileUri('/repo/a.ts')]);

    expect(sidebar.postDroppedFiles).toHaveBeenCalledWith([
      { path: '/repo/src', relativePath: 'src', type: 'directory' },
      { path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
    ]);
  });

  it('treats a symlinked directory as a directory', async () => {
    const { sidebar } = register();
    // FileType is a bitfield: Directory | SymbolicLink === 66.
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: DIRECTORY | 64 });

    await addToContext(fileUri('/repo/src'));

    expect(sidebar.postDroppedFiles).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'directory' }),
    ]);
  });

  it('skips targets that cannot be stat-ed but still posts the rest', async () => {
    const { sidebar } = register();
    vscodeMock.workspace.fs.stat.mockImplementation((target: { fsPath: string }) =>
      target.fsPath.endsWith('/missing.ts')
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve({ type: FILE })
    );

    await addToContext(undefined, [fileUri('/repo/missing.ts'), fileUri('/repo/a.ts')]);

    expect(sidebar.postDroppedFiles).toHaveBeenCalledWith([
      { path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
    ]);
  });

  it('does not reveal the sidebar when every target fails to stat', async () => {
    const { sidebar } = register();
    vscodeMock.workspace.fs.stat.mockRejectedValue(new Error('ENOENT'));

    await addToContext(fileUri('/repo/missing.ts'));

    expect(sidebar.postDroppedFiles).not.toHaveBeenCalled();
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('prefixes the folder name in a multi-root workspace', async () => {
    const { sidebar } = register();
    vscodeMock.workspace.workspaceFolders = [{ name: 'repo' }, { name: 'other' }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ name: 'repo' } as never);

    await addToContext(fileUri('/repo/a.ts'));

    expect(sidebar.postDroppedFiles).toHaveBeenCalledWith([
      expect.objectContaining({ relativePath: 'repo/a.ts' }),
    ]);
  });
});

describe('sidebar navigation commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configInspectMock.mockReturnValue(undefined);
  });

  it('reveals the view and focuses the composer', async () => {
    const { sidebar } = register();

    await runCommand('varro.chat.focus');

    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.view.extension.varro'
    );
    expect(sidebar.requestInputFocus).toHaveBeenCalledOnce();
  });

  it('reveals the primary container for every direct navigation path in fork hosts', async () => {
    const primaryContainer = 'workbench.view.extension.varro-primary';
    register('/repo', {}, primaryContainer);

    for (const command of [
      'varro.chat.focus',
      'varro.chat.statusBarClick',
      'varro.chat.newSession',
      'varro.chat.searchSessions',
      'varro.chat.abort',
      'varro.chat.previousSession',
      'varro.chat.nextSession',
    ]) {
      await runCommand(command);
    }

    const revealCalls = vscodeMock.commands.executeCommand.mock.calls.filter(([command]) =>
      String(command).startsWith('workbench.view.extension.varro')
    );
    expect(revealCalls).toHaveLength(7);
    expect(revealCalls.every(([command]) => command === primaryContainer)).toBe(true);
  });

  it('reveals the primary container for project and context paths in fork hosts', async () => {
    const primaryContainer = 'workbench.view.extension.varro-primary';
    const { contextProvider } = register('/repo', {}, primaryContainer);
    contextProvider.terminalSelection = { text: 'selected output', terminalName: 'Terminal 1' };
    contextProvider.captureTerminalSelection.mockResolvedValue({ ok: true });
    vscodeMock.window.activeTextEditor = editorWithSelection('/repo/a.ts', 0, 1) as never;

    await runCommand('varro.agents.initializeProject');
    await runCommand('varro.chat.addTerminalSelectionToContext');
    await runCommand('varro.chat.addSelectionToContext');
    await runCommand('varro.chat.addToContext', fileUri('/repo/a.ts'));

    const revealCalls = vscodeMock.commands.executeCommand.mock.calls.filter(([command]) =>
      String(command).startsWith('workbench.view.extension.varro')
    );
    expect(revealCalls).toHaveLength(4);
    expect(revealCalls.every(([command]) => command === primaryContainer)).toBe(true);
  });

  it('swallows a reveal failure so the command never surfaces an error', async () => {
    const { sidebar } = register();
    vscodeMock.commands.executeCommand.mockRejectedValueOnce(new Error('no such view'));

    await expect(runCommand('varro.chat.focus')).resolves.toBeUndefined();

    expect(sidebar.requestInputFocus).not.toHaveBeenCalled();
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('opens attention sessions from the status bar when something needs attention', async () => {
    const { sidebar } = register();
    sidebar.hasPendingAttention.mockReturnValue(true);

    await runCommand('varro.chat.statusBarClick');

    expect(sidebar.openAttentionSessions).toHaveBeenCalledOnce();
    expect(sidebar.requestInputFocus).not.toHaveBeenCalled();
  });

  it('focuses the composer from the status bar when nothing needs attention', async () => {
    const { sidebar } = register();
    sidebar.hasPendingAttention.mockReturnValue(false);

    await runCommand('varro.chat.statusBarClick');

    expect(sidebar.openAttentionSessions).not.toHaveBeenCalled();
    expect(sidebar.requestInputFocus).toHaveBeenCalledOnce();
  });

  it('reveals the view before opening session search', async () => {
    const { sidebar } = register();

    await runCommand('varro.chat.searchSessions');

    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.view.extension.varro'
    );
    expect(sidebar.searchSessions).toHaveBeenCalledOnce();
  });

  it('opens the same Varro settings search as the settings slash command', async () => {
    register();

    await runCommand('varro.chat.openSettings');

    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.openSettings',
      'Varro'
    );
  });

  it('shows inline file changes in the user setting by default', async () => {
    register();

    await runCommand('varro.chat.showInlineFileChanges');

    expect(configUpdateMock).toHaveBeenCalledWith('chat.showInlineFileChanges', true, 1);
  });

  it('hides inline file changes in an existing workspace override', async () => {
    configInspectMock.mockReturnValue({ workspaceValue: true });
    register();

    await runCommand('varro.chat.hideInlineFileChanges');

    expect(configUpdateMock).toHaveBeenCalledWith('chat.showInlineFileChanges', false, 2);
  });

  it('opens the same usage report as the stats slash command', async () => {
    const { sidebar } = register();

    await runCommand('varro.chat.openStats');

    expect(sidebar.generateUsageReport).toHaveBeenCalledOnce();
  });

  it('opens the Varro GitHub repository', async () => {
    register();

    await runCommand('varro.openGitHub');

    expect(vscodeMock.Uri.parse).toHaveBeenCalledWith('https://github.com/koltyakov/varro');
    expect(vscodeMock.env.openExternal).toHaveBeenCalledWith({
      value: 'https://github.com/koltyakov/varro',
    });
  });

  it('does not open session search when the view cannot be revealed', async () => {
    const { sidebar } = register();
    vscodeMock.commands.executeCommand.mockRejectedValueOnce(new Error('no such view'));

    await runCommand('varro.chat.searchSessions');

    expect(sidebar.searchSessions).not.toHaveBeenCalled();
  });

  it('forwards new-session and abort to the webview as commands', async () => {
    const { sidebar } = register();

    await runCommand('varro.chat.newSession');
    await runCommand('varro.chat.abort');

    expect(sidebar.postCommand).toHaveBeenNthCalledWith(1, 'new-session');
    expect(sidebar.postCommand).toHaveBeenNthCalledWith(2, 'abort');
  });

  it('opens a new editor chat from the editor-title action', async () => {
    const { sidebar } = register();

    await runCommand('varro.chat.newEditor');

    expect(sidebar.openNewEditor).toHaveBeenCalledOnce();
  });

  it('switches sessions in both directions', async () => {
    const { sidebar } = register();

    await runCommand('varro.chat.previousSession');
    await runCommand('varro.chat.nextSession');

    expect(sidebar.switchSession).toHaveBeenNthCalledWith(1, 'previous');
    expect(sidebar.switchSession).toHaveBeenNthCalledWith(2, 'next');
  });

  it('opens the source control view', async () => {
    register();

    await runCommand('varro.openSourceControl');

    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith('workbench.view.scm');
  });

  it('forwards the selected source control to commit-message generation', async () => {
    const { sidebar } = register();
    const sourceControl = { id: 'git', rootUri: fileUri('/repo') };

    await runCommand('varro.generateCommitMessage', sourceControl);

    expect(sidebar.generateCommitMessage).toHaveBeenCalledWith(sourceControl);
  });

  it.each([
    [
      'varro.chat.explainSelection',
      'Explain the selected code clearly, including its purpose, control flow, important assumptions, and any non-obvious behavior.',
    ],
    [
      'varro.chat.reviewSelection',
      'Review the selected code for correctness, regressions, security, maintainability, and missing tests. Lead with concrete findings ordered by severity.',
    ],
    [
      'varro.chat.improveSelection',
      'Improve the selected code. Preserve its intended behavior unless a change is needed to fix a concrete problem, and verify the result.',
    ],
  ])('starts a focused session for %s', async (command, prompt) => {
    const { sidebar } = register();
    vscodeMock.workspace.workspaceFolders = undefined;
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscodeMock.window.activeTextEditor = editorWithSelection('/repo/a.ts', 2, 4) as never;

    await runCommand(command);

    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.view.extension.varro'
    );
    expect(sidebar.postCommand).toHaveBeenCalledWith('new-session', { prefill: prompt });
    expect(sidebar.postDroppedFiles).toHaveBeenCalledWith([
      {
        path: '/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        lineRanges: [{ startLine: 3, endLine: 5 }],
      },
    ]);
    expect(sidebar.requestInputFocus).toHaveBeenCalledOnce();
  });

  it('warns instead of opening a selection action without a saved selection', async () => {
    const { sidebar } = register();
    vscodeMock.window.activeTextEditor = undefined;

    await runCommand('varro.chat.explainSelection');

    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
      'Varro: Select text in a saved workspace file first.'
    );
    expect(sidebar.postCommand).not.toHaveBeenCalled();
  });
});

describe('context reveal completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.window.activeTextEditor = undefined;
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 1 });
  });

  it.each(['terminal', 'selection', 'explorer'] as const)(
    'awaits the %s reveal before completing the command',
    async (source) => {
      let finishReveal!: () => void;
      const revealSidebar = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishReveal = resolve;
          })
      );
      const { contextProvider } = register('/repo', {}, revealSidebar);
      let command = 'varro.chat.addTerminalSelectionToContext';
      let args: unknown[] = [];
      if (source === 'terminal') {
        contextProvider.terminalSelection = {
          text: 'selected output',
          terminalName: 'Terminal 1',
        };
        contextProvider.captureTerminalSelection.mockResolvedValue({ ok: true });
      } else if (source === 'selection') {
        command = 'varro.chat.addSelectionToContext';
        vscodeMock.window.activeTextEditor = editorWithSelection('/repo/a.ts', 0, 1) as never;
      } else {
        command = 'varro.chat.addToContext';
        args = [fileUri('/repo/a.ts')];
      }
      let settled = false;

      const operation = runCommand(command, ...args).then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(revealSidebar).toHaveBeenCalledOnce());

      expect(settled).toBe(false);
      finishReveal();
      await operation;
      expect(settled).toBe(true);
    }
  );
});

describe('varro.server.restart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes providers after a successful restart', async () => {
    const { sidebar } = register('/repo', {
      restart: vi.fn().mockResolvedValue('http://127.0.0.1:4096'),
      status: { state: 'running' },
    });

    await runCommand('varro.server.restart');

    expect(sidebar.post).toHaveBeenCalledWith({ type: 'providers/refresh' });
  });

  it('opens the sidebar with blocker details when active sessions prevent restart', async () => {
    const blockers = {
      totalSessionCount: 2,
      directories: [{ directory: '/repo', sessionCount: 2 }],
    };
    const { sidebar } = register(
      '/repo',
      {
        restart: vi.fn().mockRejectedValue(new RestartBlockedError(blockers)),
        status: { state: 'running' },
      },
      'workbench.view.extension.varro-primary'
    );

    await runCommand('varro.server.restart');

    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.view.extension.varro-primary'
    );
    expect(sidebar.post).toHaveBeenCalledWith({
      type: 'server/restart-blocked',
      payload: blockers,
    });
    expect(errorHubMock.report).not.toHaveBeenCalled();
  });

  it('passes the force option to the server', async () => {
    const restart = vi.fn().mockResolvedValue('http://127.0.0.1:4096');
    register('/repo', { restart, status: { state: 'running' } });

    await runCommand('varro.server.restart', { force: true });

    expect(restart).toHaveBeenCalledWith({ force: true });
  });

  it('reports a restart failure through the error hub when the server is not already errored', async () => {
    const { sidebar } = register('/repo', {
      restart: vi.fn().mockRejectedValue(new Error('port busy')),
      status: { state: 'running' },
    });

    await runCommand('varro.server.restart');

    expect(errorHubMock.report).toHaveBeenCalledWith({
      code: 'server-start',
      message: 'Failed to restart server: port busy',
    });
    expect(sidebar.post).not.toHaveBeenCalled();
  });

  it('only logs a restart failure when the server already reported an error', async () => {
    register('/repo', {
      restart: vi.fn().mockRejectedValue(new Error('port busy')),
      status: { state: 'error' },
    });

    await runCommand('varro.server.restart');

    expect(errorHubMock.report).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith('Failed to restart server: port busy');
  });
});

describe('varro.showOutput', () => {
  it('shows the extension output channel', async () => {
    vi.clearAllMocks();
    register();

    await runCommand('varro.showOutput');

    expect(loggerMock.show).toHaveBeenCalledOnce();
  });
});

describe('varro.about', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces a failure to read server info', async () => {
    register('/repo', {
      readServerInfo: vi.fn().mockRejectedValue(new Error('server unreachable')),
    });

    await runCommand('varro.about');

    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
      'Failed to open Varro about: server unreachable'
    );
    expect(vscodeMock.window.showTextDocument).not.toHaveBeenCalled();
  });
});

function editorWithSelection(
  fsPath: string,
  startLine: number,
  endLine: number,
  overrides: { isUntitled?: boolean; scheme?: string; isEmpty?: boolean } = {}
) {
  return {
    document: {
      uri: { fsPath, scheme: overrides.scheme ?? 'file' },
      isUntitled: overrides.isUntitled ?? false,
    },
    selection: {
      isEmpty: overrides.isEmpty ?? false,
      start: { line: startLine },
      end: { line: endLine },
    },
  };
}

describe('varro.chat.addSelectionToContext', () => {
  const FILE = 1;
  const DIRECTORY = 2;

  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.window.activeTextEditor = undefined;
    vscodeMock.workspace.workspaceFolders = undefined;
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: FILE });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
  });

  it('posts the selected range as a one-based line range', async () => {
    const { sidebar } = register();
    vscodeMock.window.activeTextEditor = editorWithSelection('/repo/a.ts', 11, 19) as never;

    await runCommand('varro.chat.addSelectionToContext');

    expect(sidebar.postDroppedFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        path: '/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        lineRanges: [{ startLine: 12, endLine: 20 }],
      }),
    ]);
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.view.extension.varro'
    );
  });

  it('does nothing without an active editor', async () => {
    const { sidebar } = register();

    await runCommand('varro.chat.addSelectionToContext');

    expect(sidebar.postDroppedFiles).not.toHaveBeenCalled();
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('does nothing when the selection is empty', async () => {
    const { sidebar } = register();
    vscodeMock.window.activeTextEditor = editorWithSelection('/repo/a.ts', 1, 1, {
      isEmpty: true,
    }) as never;

    await runCommand('varro.chat.addSelectionToContext');

    expect(sidebar.postDroppedFiles).not.toHaveBeenCalled();
  });

  it('ignores an untitled document that has no file on disk', async () => {
    const { sidebar } = register();
    vscodeMock.window.activeTextEditor = editorWithSelection('/untitled-1', 0, 2, {
      isUntitled: true,
    }) as never;

    await runCommand('varro.chat.addSelectionToContext');

    expect(sidebar.postDroppedFiles).not.toHaveBeenCalled();
  });

  it('ignores a document served over the untitled scheme', async () => {
    const { sidebar } = register();
    vscodeMock.window.activeTextEditor = editorWithSelection('/untitled-1', 0, 2, {
      scheme: 'untitled',
    }) as never;

    await runCommand('varro.chat.addSelectionToContext');

    expect(sidebar.postDroppedFiles).not.toHaveBeenCalled();
  });

  it('ignores a selection whose target stats as a directory', async () => {
    const { sidebar } = register();
    vscodeMock.window.activeTextEditor = editorWithSelection('/repo/src', 0, 2) as never;
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: DIRECTORY });

    await runCommand('varro.chat.addSelectionToContext');

    expect(sidebar.postDroppedFiles).not.toHaveBeenCalled();
  });

  it('ignores a selection whose target cannot be stat-ed', async () => {
    const { sidebar } = register();
    vscodeMock.window.activeTextEditor = editorWithSelection('/repo/a.ts', 0, 2) as never;
    vscodeMock.workspace.fs.stat.mockRejectedValue(new Error('ENOENT'));

    await runCommand('varro.chat.addSelectionToContext');

    expect(sidebar.postDroppedFiles).not.toHaveBeenCalled();
  });

  it('prefixes the folder name in a multi-root workspace', async () => {
    const { sidebar } = register();
    vscodeMock.window.activeTextEditor = editorWithSelection('/repo/a.ts', 0, 0) as never;
    vscodeMock.workspace.workspaceFolders = [{ name: 'repo' }, { name: 'other' }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ name: 'repo' } as never);

    await runCommand('varro.chat.addSelectionToContext');

    expect(sidebar.postDroppedFiles).toHaveBeenCalledWith([
      expect.objectContaining({ relativePath: 'repo/a.ts' }),
    ]);
  });
});
