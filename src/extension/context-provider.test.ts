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
    activeTerminal: { name: 'Terminal 1' },
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
    showTextDocument: vi.fn(),
  },
  languages: {
    onDidChangeDiagnostics: vi.fn(() => ({ dispose: vi.fn() })),
    getDiagnostics: vi.fn(() => []),
  },
  workspace: {
    onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    getConfiguration: vi.fn(() => ({ get: vi.fn((_key: string, fallback: boolean) => fallback) })),
    workspaceFolders: [],
    getWorkspaceFolder: vi.fn(),
    fs: {
      stat: vi.fn(),
    },
    openTextDocument: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(() => Promise.resolve(undefined)),
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
    file: vi.fn((fsPath: string) => ({ fsPath })),
  },
  FileType: {
    Directory: 2,
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
    vscodeMock.workspace.getWorkspaceFolder.mockReset();
    vscodeMock.workspace.fs.stat.mockReset();
    vscodeMock.workspace.openTextDocument.mockReset();
    vscodeMock.window.showTextDocument.mockReset();
    vscodeMock.commands.executeCommand.mockResolvedValue(undefined);
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
});
