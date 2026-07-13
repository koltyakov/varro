import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
}));

const clipboardState = vi.hoisted(() => ({
  values: [] as string[],
  writes: [] as string[],
}));

const vscodeMock = vi.hoisted(() => ({
  window: {
    activeTerminal: { name: 'Terminal 1' } as { name: string } | undefined,
    activeTextEditor: undefined as unknown,
    tabGroups: {
      activeTabGroup: { activeTab: undefined as unknown },
    },
    onDidChangeActiveTextEditor: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
    onDidChangeTextEditorSelection: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
    showTextDocument: vi.fn(),
  },
  languages: {
    onDidChangeDiagnostics: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
    getDiagnostics: vi.fn(
      () => [] as Array<{ severity: number; message: string; range: { start: { line: number } } }>
    ),
  },
  workspace: {
    asRelativePath: vi.fn(),
    onDidChangeWorkspaceFolders: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
    onDidChangeConfiguration: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
    getConfiguration: vi.fn(() => ({ get: vi.fn((_key: string, fallback: boolean) => fallback) })),
    workspaceFolders: [] as Array<{ name: string; uri: { fsPath: string } }>,
    getWorkspaceFolder: vi.fn(),
    fs: {
      stat: vi.fn(),
    },
    openTextDocument: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(() => Promise.resolve(undefined)),
  },
  extensions: {
    getExtension: vi.fn(),
  },
  env: {
    clipboard: {
      readText: vi.fn(() => Promise.resolve(clipboardState.values.shift() ?? '')),
      writeText: vi.fn((value: string) => {
        clipboardState.writes.push(value);
        return Promise.resolve();
      }),
    },
  },
  Uri: {
    file: vi.fn((fsPath: string) => ({ fsPath: fsPath.replace(/\\/g, '/') })),
  },
  FileType: {
    Directory: 2,
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
  },
  Position: vi.fn(function (line: number, character: number) {
    return { line, character };
  }),
  Selection: vi.fn(function (start: unknown, end: unknown) {
    return { start, end };
  }),
  Range: vi.fn(function (start: unknown, end: unknown) {
    return { start, end };
  }),
  TextEditorRevealType: {
    InCenter: 0,
  },
}));

vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('vscode', () => vscodeMock);

import { ContextProvider } from './context-provider';

describe('ContextProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardState.values = [];
    clipboardState.writes = [];
    vscodeMock.window.activeTerminal = { name: 'Terminal 1' };
    vscodeMock.window.activeTextEditor = undefined;
    vscodeMock.window.tabGroups.activeTabGroup.activeTab = undefined;
    vscodeMock.workspace.getWorkspaceFolder.mockReset();
    vscodeMock.workspace.fs.stat.mockReset();
    vscodeMock.workspace.openTextDocument.mockReset();
    vscodeMock.workspace.asRelativePath.mockReset();
    vscodeMock.window.showTextDocument.mockReset();
    vscodeMock.extensions.getExtension.mockReset();
    vscodeMock.commands.executeCommand.mockResolvedValue(undefined);
    vscodeMock.languages.getDiagnostics.mockReset();
    vscodeMock.languages.getDiagnostics.mockReturnValue([]);
    vscodeMock.workspace.workspaceFolders = [];
    vscodeMock.workspace.getConfiguration.mockImplementation(() => ({
      get: vi.fn((_key: string, fallback: boolean) => fallback),
    }));
  });

  it('does not reuse stale clipboard text when terminal copy captures nothing', async () => {
    clipboardState.values = ['existing clipboard', 'existing clipboard', 'existing clipboard'];
    const provider = new ContextProvider(vi.fn());

    try {
      const result = await provider.captureTerminalSelection();

      expect(result).toEqual({ ok: false, reason: 'empty-selection' });
      expect(provider.terminalSelection).toBeNull();
      expect(vscodeMock.env.clipboard.writeText).toHaveBeenCalledWith('existing clipboard');
    } finally {
      provider.dispose();
    }
  });

  it('restores the clipboard after capturing terminal selection', async () => {
    clipboardState.values = ['existing clipboard', 'new terminal output'];
    const provider = new ContextProvider(vi.fn());

    try {
      const result = await provider.captureTerminalSelection();

      expect(result).toEqual({ ok: true, terminalName: 'Terminal 1' });
      expect(provider.terminalSelection).toEqual({
        text: 'new terminal output',
        terminalName: 'Terminal 1',
      });
      expect(vscodeMock.env.clipboard.writeText).toHaveBeenCalledWith('existing clipboard');
    } finally {
      provider.dispose();
    }
  });

  it('clears stale terminal selection when a later capture fails', async () => {
    clipboardState.values = [
      'existing clipboard',
      'new terminal output',
      'existing clipboard',
      'existing clipboard',
      'existing clipboard',
    ];
    const provider = new ContextProvider(vi.fn());

    try {
      await provider.captureTerminalSelection();
      expect(provider.terminalSelection).toEqual({
        text: 'new terminal output',
        terminalName: 'Terminal 1',
      });

      const result = await provider.captureTerminalSelection();

      expect(result).toEqual({ ok: false, reason: 'empty-selection' });
      expect(provider.terminalSelection).toBeNull();
    } finally {
      provider.dispose();
    }
  });

  it('returns no-terminal and clears prior terminal selection when no terminal is active', async () => {
    clipboardState.values = ['existing clipboard', 'new terminal output'];
    const provider = new ContextProvider(vi.fn());

    try {
      await provider.captureTerminalSelection();
      expect(provider.terminalSelection).toEqual({
        text: 'new terminal output',
        terminalName: 'Terminal 1',
      });

      vscodeMock.window.activeTerminal = undefined;

      const result = await provider.captureTerminalSelection();

      expect(result).toEqual({ ok: false, reason: 'no-terminal' });
      expect(provider.terminalSelection).toBeNull();
    } finally {
      provider.dispose();
    }
  });

  it('opens absolute paths outside the workspace', async () => {
    const provider = new ContextProvider(vi.fn());
    const uri = { fsPath: '/tmp/varro-drop.txt' };
    const document = { uri, getText: vi.fn(() => 'text') };
    const editor = {
      selection: null,
      revealRange: vi.fn(),
    };

    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscodeMock.workspace.openTextDocument.mockResolvedValue(document);
    vscodeMock.window.showTextDocument = vi.fn(() => Promise.resolve(editor));

    try {
      await provider.openPath('/tmp/varro-drop.txt');

      expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(uri);
      expect(vscodeMock.window.showTextDocument).toHaveBeenCalledWith(document, { preview: false });
    } finally {
      provider.dispose();
    }
  });

  it('reveals directories instead of opening them as files', async () => {
    const provider = new ContextProvider(vi.fn());
    const uri = { fsPath: '/tmp/varro-dir' };

    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: vscodeMock.FileType.Directory });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);

    try {
      await provider.openPath('/tmp/varro-dir');

      expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith('revealInExplorer', uri);
      expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
      expect(vscodeMock.window.showTextDocument).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('opens missing workspace-relative file paths in the Git diff editor', async () => {
    const provider = new ContextProvider(vi.fn());
    const uri = { fsPath: '/repo/src/deleted.ts' };

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscodeMock.workspace.fs.stat.mockRejectedValue(new Error('File not found'));
    vscodeMock.extensions.getExtension.mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [
            {
              state: { workingTreeChanges: [{ uri }], indexChanges: [], mergeChanges: [] },
            },
          ],
        }),
      },
    });

    try {
      await provider.openPath('src/deleted.ts', { kind: 'file', view: 'diff' });

      expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith('git.openChange', uri);
      expect(vscodeMock.workspace.fs.stat).toHaveBeenCalledWith(uri);
      expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
      expect(vscodeMock.window.showTextDocument).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('opens the file when Git has no change to show', async () => {
    const provider = new ContextProvider(vi.fn());
    const uri = { fsPath: '/repo/src/session-only.ts' };
    const document = { uri };

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.openTextDocument.mockResolvedValue(document);
    vscodeMock.window.showTextDocument.mockResolvedValue({});
    vscodeMock.extensions.getExtension.mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => ({ repositories: [] }),
      },
    });

    try {
      await provider.openPath('src/session-only.ts', { kind: 'file', view: 'diff' });

      expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalledWith('git.openChange', uri);
      expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(uri);
      expect(vscodeMock.window.showTextDocument).toHaveBeenCalledWith(document, { preview: false });
    } finally {
      provider.dispose();
    }
  });

  it('opens the file when the Git diff command does not activate a tab', async () => {
    const provider = new ContextProvider(vi.fn());
    const uri = { fsPath: '/repo/src/stale-change.ts' };
    const document = { uri };

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.openTextDocument.mockResolvedValue(document);
    vscodeMock.window.showTextDocument.mockResolvedValue({});
    vscodeMock.extensions.getExtension.mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [
            {
              state: { workingTreeChanges: [{ uri }], indexChanges: [], mergeChanges: [] },
            },
          ],
        }),
      },
    });

    try {
      await provider.openPath('src/stale-change.ts', { kind: 'file', view: 'diff' });

      expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith('git.openChange', uri);
      expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(uri);
      expect(vscodeMock.window.showTextDocument).toHaveBeenCalledWith(document, { preview: false });
    } finally {
      provider.dispose();
    }
  });

  it('captures editor context after the active editor settles back in', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const uri = {
      fsPath: '/repo/src/app.ts',
      scheme: 'file',
      toString: () => 'file:///repo/src/app.ts',
    };
    const editor = {
      document: { uri, isUntitled: false, languageId: 'typescript' },
      selection: {
        isEmpty: false,
        start: { line: 1 },
        end: { line: 3 },
      },
    };
    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(
      vscodeMock.workspace.workspaceFolders[0]
    );
    vscodeMock.workspace.asRelativePath.mockReturnValue('src/app.ts');

    const provider = new ContextProvider(onChange);

    try {
      vscodeMock.window.activeTextEditor = editor;

      await vi.advanceTimersByTimeAsync(60);

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenLastCalledWith({
        workspacePath: '/repo',
        activeFile: {
          path: '/repo/src/app.ts',
          relativePath: 'src/app.ts',
          language: 'typescript',
        },
        selection: {
          startLine: 2,
          endLine: 4,
        },
        diagnostics: [],
      });
    } finally {
      provider.dispose();
      vi.useRealTimers();
    }
  });

  it('does not emit duplicate context updates for unchanged editor state', async () => {
    const onChange = vi.fn();
    const activeTextEditorListener = vi.fn();
    vscodeMock.window.onDidChangeActiveTextEditor.mockImplementation((listener?: () => void) => {
      if (listener) {
        activeTextEditorListener.mockImplementation(listener);
      }
      return { dispose: vi.fn() };
    });
    const uri = {
      fsPath: '/repo/src/app.ts',
      scheme: 'file',
      toString: () => 'file:///repo/src/app.ts',
    };
    const editor = {
      document: { uri, isUntitled: false, languageId: 'typescript' },
      selection: {
        isEmpty: false,
        start: { line: 2 },
        end: { line: 4 },
      },
    };
    vscodeMock.window.activeTextEditor = editor;
    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(
      vscodeMock.workspace.workspaceFolders[0]
    );
    vscodeMock.workspace.asRelativePath = vi.fn(() => 'src/app.ts');
    vscodeMock.languages.getDiagnostics.mockReturnValue([
      {
        severity: 0,
        message: 'bad',
        range: { start: { line: 6 } },
      },
    ]);
    vscodeMock.workspace.asRelativePath.mockImplementation(() => 'src/app.ts');

    const provider = new ContextProvider(onChange);

    try {
      expect(onChange).toHaveBeenCalledTimes(2);

      activeTextEditorListener();

      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith({
        workspacePath: '/repo',
        activeFile: {
          path: '/repo/src/app.ts',
          relativePath: 'src/app.ts',
          language: 'typescript',
        },
        selection: {
          startLine: 3,
          endLine: 5,
        },
        diagnostics: [
          {
            path: '/repo/src/app.ts',
            severity: 'error',
            message: 'bad',
            line: 7,
          },
        ],
      });
    } finally {
      provider.dispose();
    }
  });

  it('surfaces external active files using the absolute fsPath as relativePath', async () => {
    const onChange = vi.fn();
    const uri = {
      fsPath: '/Users/andrew/.config/opencode/plans/plan-031f5812af04fbb6.md',
      scheme: 'file',
      toString: () => 'file:///Users/andrew/.config/opencode/plans/plan-031f5812af04fbb6.md',
    };
    const editor = {
      document: { uri, isUntitled: false, languageId: 'markdown' },
      selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
    };
    vscodeMock.window.activeTextEditor = editor;
    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscodeMock.languages.getDiagnostics.mockReturnValue([]);

    const provider = new ContextProvider(onChange);

    try {
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeFile: {
            path: '/Users/andrew/.config/opencode/plans/plan-031f5812af04fbb6.md',
            relativePath: '/Users/andrew/.config/opencode/plans/plan-031f5812af04fbb6.md',
            language: 'markdown',
          },
        })
      );
    } finally {
      provider.dispose();
    }
  });
});
