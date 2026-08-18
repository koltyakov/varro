import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
}));

// Models a real clipboard: reads observe whatever was written last. A queued
// `terminalSelection` is what `terminal.copySelection` puts on the clipboard
// (null = the terminal had nothing to copy, so the clipboard is left alone).
const clipboardState = vi.hoisted(() => ({
  current: '',
  writes: [] as string[],
  terminalSelection: null as string | null,
  // When set, `writeText` returns this promise instead of resolving immediately,
  // so a test can hold a clipboard write open.
  deferWrite: null as {
    promise: Promise<void>;
    resolve: () => void;
    value?: string;
  } | null,
  deferCopy: null as { promise: Promise<void>; resolve: () => void } | null,
}));

// `realpath` resolves through `symlinks` so containment can be tested without
// touching the filesystem; unmapped paths resolve to themselves.
const fsState = vi.hoisted(() => ({
  symlinks: new Map<string, string>(),
  directories: new Map<string, Array<{ name: string; directory: boolean }>>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const realpath = vi.fn(async (target: string) => {
    for (const [linkPath, linkTarget] of fsState.symlinks) {
      if (target === linkPath) return linkTarget;
      if (target.startsWith(`${linkPath}/`)) {
        return `${linkTarget}${target.slice(linkPath.length)}`;
      }
    }
    return target;
  });
  const readdir = vi.fn(async (target: string, options?: { withFileTypes?: boolean }) => {
    const entries = fsState.directories.get(target.replace(/\\/g, '/'));
    if (!entries) return actual.readdir(target, options as never);
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: () => entry.directory,
    }));
  });
  return { ...actual, readdir, realpath, default: { ...actual, readdir, realpath } };
});

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
    onDidChangeTextDocument: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
    onDidSaveTextDocument: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
    onDidChangeConfiguration: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
    getConfiguration: vi.fn(() => ({ get: vi.fn((_key: string, fallback: boolean) => fallback) })),
    workspaceFolders: [] as Array<{ name: string; uri: { fsPath: string } }>,
    getWorkspaceFolder: vi.fn(),
    fs: {
      stat: vi.fn(),
      readDirectory: vi.fn(),
    },
    findFiles: vi.fn(),
    openTextDocument: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn((command: string): Promise<void> => {
      if (
        command === 'workbench.action.terminal.copySelection' &&
        clipboardState.terminalSelection !== null
      ) {
        clipboardState.current = clipboardState.terminalSelection;
      }
      return Promise.resolve();
    }),
  },
  extensions: {
    getExtension: vi.fn(),
  },
  env: {
    clipboard: {
      readText: vi.fn(() => Promise.resolve(clipboardState.current)),
      writeText: vi.fn((value: string) => {
        const deferred = clipboardState.deferWrite;
        if (deferred && (deferred.value === undefined || deferred.value === value)) {
          clipboardState.deferWrite = null;
          return deferred.promise.then(() => {
            clipboardState.current = value;
            clipboardState.writes.push(value);
          });
        }
        clipboardState.current = value;
        clipboardState.writes.push(value);
        return Promise.resolve();
      }),
    },
  },
  Uri: {
    file: vi.fn((fsPath: string) => ({ fsPath: fsPath.replace(/\\/g, '/') })),
    joinPath: vi.fn((uri: { fsPath: string }, name: string) => ({
      fsPath: `${uri.fsPath.replace(/\/$/, '')}/${name}`,
    })),
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

function noop() {}

describe('ContextProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardState.current = '';
    clipboardState.writes = [];
    clipboardState.terminalSelection = null;
    clipboardState.deferWrite = null;
    clipboardState.deferCopy = null;
    fsState.symlinks.clear();
    fsState.directories.clear();
    vscodeMock.window.activeTerminal = { name: 'Terminal 1' };
    vscodeMock.window.activeTextEditor = undefined;
    vscodeMock.window.tabGroups.activeTabGroup.activeTab = undefined;
    vscodeMock.workspace.getWorkspaceFolder.mockReset();
    vscodeMock.workspace.fs.stat.mockReset();
    vscodeMock.workspace.fs.readDirectory.mockReset();
    vscodeMock.workspace.fs.readDirectory.mockResolvedValue([]);
    vscodeMock.workspace.findFiles.mockReset();
    vscodeMock.workspace.findFiles.mockResolvedValue([]);
    vscodeMock.workspace.openTextDocument.mockReset();
    vscodeMock.workspace.asRelativePath.mockReset();
    vscodeMock.window.showTextDocument.mockReset();
    vscodeMock.extensions.getExtension.mockReset();
    vscodeMock.commands.executeCommand.mockImplementation((command: string): Promise<void> => {
      const deferred = clipboardState.deferCopy;
      if (command === 'workbench.action.terminal.copySelection' && deferred) {
        clipboardState.deferCopy = null;
        const selection = clipboardState.terminalSelection;
        return deferred.promise.then(() => {
          if (selection !== null) clipboardState.current = selection;
        });
      }
      if (
        command === 'workbench.action.terminal.copySelection' &&
        clipboardState.terminalSelection !== null
      ) {
        clipboardState.current = clipboardState.terminalSelection;
      }
      return Promise.resolve();
    });
    vscodeMock.languages.getDiagnostics.mockReset();
    vscodeMock.languages.getDiagnostics.mockReturnValue([]);
    vscodeMock.workspace.workspaceFolders = [];
    vscodeMock.workspace.getConfiguration.mockImplementation(() => ({
      get: vi.fn((_key: string, fallback: boolean) => fallback),
    }));
  });

  it('does not reuse stale clipboard text when terminal copy captures nothing', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = null;
    const provider = new ContextProvider(vi.fn());

    try {
      const result = await provider.captureTerminalSelection();

      expect(result).toEqual({ ok: false, reason: 'empty-selection' });
      expect(provider.terminalSelection).toBeNull();
      expect(vscodeMock.env.clipboard.writeText).toHaveBeenCalledWith('existing clipboard');
      expect(clipboardState.current).toBe('existing clipboard');
    } finally {
      provider.dispose();
    }
  });

  it('restores the clipboard after capturing terminal selection', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = 'new terminal output';
    const provider = new ContextProvider(vi.fn());

    try {
      const result = await provider.captureTerminalSelection();

      expect(result).toEqual({ ok: true, terminalName: 'Terminal 1' });
      expect(provider.terminalSelection).toEqual({
        text: 'new terminal output',
        terminalName: 'Terminal 1',
      });
      expect(vscodeMock.env.clipboard.writeText).toHaveBeenCalledWith('existing clipboard');
      expect(clipboardState.current).toBe('existing clipboard');
    } finally {
      provider.dispose();
    }
  });

  it('captures a terminal selection that matches the existing clipboard text', async () => {
    clipboardState.current = 'shared text';
    clipboardState.terminalSelection = 'shared text';
    const provider = new ContextProvider(vi.fn());

    try {
      const result = await provider.captureTerminalSelection();

      expect(result).toEqual({ ok: true, terminalName: 'Terminal 1' });
      expect(provider.terminalSelection).toEqual({
        text: 'shared text',
        terminalName: 'Terminal 1',
      });
      expect(clipboardState.current).toBe('shared text');
    } finally {
      provider.dispose();
    }
  });

  it('never surfaces the priming sentinel as a terminal selection', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = null;
    const provider = new ContextProvider(vi.fn());

    try {
      const result = await provider.captureTerminalSelection();

      expect(result).toEqual({ ok: false, reason: 'empty-selection' });
      expect(provider.terminalSelection).toBeNull();
      expect(
        clipboardState.writes.some((value) => value.includes('varro-terminal-selection-'))
      ).toBe(true);
      expect(clipboardState.current).not.toContain('varro-terminal-selection-');
    } finally {
      provider.dispose();
    }
  });

  it('serializes overlapping captures so neither reads the other sentinel', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = 'terminal output';
    const provider = new ContextProvider(vi.fn());

    try {
      const [first, second] = await Promise.all([
        provider.captureTerminalSelection(),
        provider.captureTerminalSelection(),
      ]);

      expect(first).toEqual({ ok: true, terminalName: 'Terminal 1' });
      expect(second).toEqual({ ok: true, terminalName: 'Terminal 1' });
      expect(provider.terminalSelection).toEqual({
        text: 'terminal output',
        terminalName: 'Terminal 1',
      });
      expect(clipboardState.current).toBe('existing clipboard');
      expect(clipboardState.current).not.toContain('varro-terminal-selection-');
    } finally {
      provider.dispose();
    }
  });

  it('does not strand a sentinel when overlapping captures find no selection', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = null;
    const provider = new ContextProvider(vi.fn());

    try {
      const results = await Promise.all([
        provider.captureTerminalSelection(),
        provider.captureTerminalSelection(),
        provider.captureTerminalSelection(),
      ]);

      for (const result of results) {
        expect(result).toEqual({ ok: false, reason: 'empty-selection' });
      }
      expect(clipboardState.current).toBe('existing clipboard');
    } finally {
      provider.dispose();
    }
  });

  it('does not leave the sentinel behind when the priming write resolves late', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = null;
    let releasePrime: () => void = noop;
    const primePromise = new Promise<void>((resolve) => {
      releasePrime = resolve;
    });
    clipboardState.deferWrite = { promise: primePromise, resolve: releasePrime };
    vi.useFakeTimers();
    const provider = new ContextProvider(vi.fn());

    try {
      const capture = provider.captureTerminalSelection();
      const settled = expect(capture).rejects.toThrow(/Timed out priming clipboard/);
      // Push past the 1500ms prime timeout *and* the bounded settle wait in the
      // restore, so the write really is still outstanding when cleanup runs.
      await vi.advanceTimersByTimeAsync(5_000);
      await settled;
      expect(clipboardState.current).toBe('existing clipboard');
      // A failed capture must not leave a previous selection behind.
      expect(provider.terminalSelection).toBeNull();

      // Now the abandoned write finally lands, clobbering the restore. It must
      // be undone rather than left as the user's clipboard contents.
      releasePrime();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(clipboardState.current).toBe('existing clipboard');
      expect(clipboardState.current).not.toContain('varro-terminal-selection-');
    } finally {
      provider.dispose();
      vi.useRealTimers();
    }
  });

  it('restores a terminal copy that lands after the command times out before dequeuing', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = 'late terminal output';
    let releaseCopy: () => void = noop;
    const copyPromise = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    clipboardState.deferCopy = { promise: copyPromise, resolve: releaseCopy };
    vi.useFakeTimers();
    const provider = new ContextProvider(vi.fn());

    try {
      const firstCapture = provider.captureTerminalSelection();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(firstCapture).rejects.toThrow(/Timed out copying terminal selection/);

      clipboardState.terminalSelection = null;
      const secondCapture = provider.captureTerminalSelection();
      const secondSettled = vi.fn();
      void secondCapture.then(secondSettled, secondSettled);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(secondSettled).not.toHaveBeenCalled();

      releaseCopy();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(secondCapture).resolves.toEqual({ ok: false, reason: 'empty-selection' });
      expect(clipboardState.current).toBe('existing clipboard');
      expect(clipboardState.current).not.toBe('late terminal output');
    } finally {
      provider.dispose();
      vi.useRealTimers();
    }
  });

  it('does not wedge the capture queue when a clipboard restore never settles', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = 'first terminal output';
    const neverSettles = new Promise<void>(() => undefined);
    clipboardState.deferWrite = {
      promise: neverSettles,
      resolve: noop,
      value: 'existing clipboard',
    };
    vi.useFakeTimers();
    const provider = new ContextProvider(vi.fn());

    try {
      const firstCapture = provider.captureTerminalSelection();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(firstCapture).resolves.toEqual({ ok: true, terminalName: 'Terminal 1' });

      clipboardState.terminalSelection = 'second terminal output';
      const secondCapture = provider.captureTerminalSelection();
      const secondSettled = vi.fn();
      void secondCapture.then(secondSettled, secondSettled);
      await vi.advanceTimersByTimeAsync(7_000);
      expect(secondSettled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_000);

      await expect(secondCapture).resolves.toEqual({ ok: true, terminalName: 'Terminal 1' });
      expect(provider.terminalSelection).toEqual({
        text: 'second terminal output',
        terminalName: 'Terminal 1',
      });
    } finally {
      provider.dispose();
      vi.useRealTimers();
    }
  });

  it('waits for a timed-out clipboard restore to settle before starting the next capture', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = 'first terminal output';
    let releaseRestore: () => void = noop;
    const restorePromise = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    clipboardState.deferWrite = {
      promise: restorePromise,
      resolve: releaseRestore,
      value: 'existing clipboard',
    };
    vi.useFakeTimers();
    const provider = new ContextProvider(vi.fn());

    try {
      const firstCapture = provider.captureTerminalSelection();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(firstCapture).resolves.toEqual({ ok: true, terminalName: 'Terminal 1' });

      clipboardState.terminalSelection = 'second terminal output';
      const secondCapture = provider.captureTerminalSelection();
      const secondSettled = vi.fn();
      void secondCapture.then(secondSettled, secondSettled);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(secondSettled).not.toHaveBeenCalled();
      expect(vscodeMock.commands.executeCommand).toHaveBeenCalledTimes(1);

      releaseRestore();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(secondCapture).resolves.toEqual({ ok: true, terminalName: 'Terminal 1' });
      expect(vscodeMock.commands.executeCommand).toHaveBeenCalledTimes(2);
      expect(provider.terminalSelection).toEqual({
        text: 'second terminal output',
        terminalName: 'Terminal 1',
      });
      expect(clipboardState.current).toBe('existing clipboard');
    } finally {
      provider.dispose();
      vi.useRealTimers();
    }
  });

  it('clears a prior selection when a later capture throws', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = 'terminal output';
    const provider = new ContextProvider(vi.fn());

    try {
      await provider.captureTerminalSelection();
      expect(provider.terminalSelection).toEqual({
        text: 'terminal output',
        terminalName: 'Terminal 1',
      });

      // The copy command itself fails; the previous capture must not survive as
      // stale state, since it is replayed into webview initialization.
      vscodeMock.commands.executeCommand.mockRejectedValueOnce(new Error('command failed'));

      await expect(provider.captureTerminalSelection()).rejects.toThrow('command failed');
      expect(provider.terminalSelection).toBeNull();
      expect(clipboardState.current).toBe('existing clipboard');
    } finally {
      provider.dispose();
    }
  });

  it('allows a contained entry whose name begins with dots', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'config' });

    try {
      // `..config` is a real entry inside the workspace, not a climb out of it.
      await expect(
        provider.readFile('/repo/..config/file', { restrictToWorkspace: true })
      ).resolves.toBe('config');
    } finally {
      provider.dispose();
    }
  });

  it('clears stale terminal selection when a later capture fails', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = 'new terminal output';
    const provider = new ContextProvider(vi.fn());

    try {
      await provider.captureTerminalSelection();
      expect(provider.terminalSelection).toEqual({
        text: 'new terminal output',
        terminalName: 'Terminal 1',
      });

      clipboardState.terminalSelection = null;
      const result = await provider.captureTerminalSelection();

      expect(result).toEqual({ ok: false, reason: 'empty-selection' });
      expect(provider.terminalSelection).toBeNull();
    } finally {
      provider.dispose();
    }
  });

  it('returns no-terminal and clears prior terminal selection when no terminal is active', async () => {
    clipboardState.current = 'existing clipboard';
    clipboardState.terminalSelection = 'new terminal output';
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

  it('reads absolute paths outside the workspace when unrestricted', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'secret' });

    try {
      await expect(provider.readFile('/etc/passwd')).resolves.toBe('secret');
    } finally {
      provider.dispose();
    }
  });

  it('refuses absolute paths outside the workspace when restricted', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'secret' });

    try {
      await expect(
        provider.readFile('/etc/passwd', { restrictToWorkspace: true })
      ).resolves.toBeNull();
      await expect(
        provider.resolvePath('/etc/passwd', { restrictToWorkspace: true })
      ).resolves.toBeNull();
      expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('still reads restricted absolute paths inside the workspace', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'source' });

    try {
      await expect(
        provider.readFile('/repo/src/app.ts', { restrictToWorkspace: true })
      ).resolves.toBe('source');
    } finally {
      provider.dispose();
    }
  });

  it('authorizes only exact open workspace roots', () => {
    vscodeMock.workspace.workspaceFolders = [
      { name: 'repo', uri: { fsPath: '/repo' } },
      { name: 'other', uri: { fsPath: 'C:\\Projects\\Other' } },
    ];
    const provider = new ContextProvider(vi.fn());

    try {
      expect(provider.isOpenWorkspaceRoot('/repo/')).toBe(true);
      expect(provider.isOpenWorkspaceRoot('c:/projects/other/')).toBe(true);
      expect(provider.getOpenWorkspaceRoot('c:/projects/other/')).toBe('C:\\Projects\\Other');
      expect(provider.isOpenWorkspaceRoot('/repo/nested')).toBe(false);
      expect(provider.isOpenWorkspaceRoot('/outside')).toBe(false);
    } finally {
      provider.dispose();
    }
  });

  it('binds restricted relative resolution to the requested open workspace root', async () => {
    const first = { name: 'first', uri: { fsPath: '/first' } };
    const second = { name: 'second', uri: { fsPath: '/second' } };
    vscodeMock.workspace.workspaceFolders = [first, second];
    vscodeMock.workspace.fs.stat.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/second/RALPH.md') return { type: 0 };
      throw new Error('File not found');
    });
    vscodeMock.workspace.getWorkspaceFolder.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath.startsWith('/second/') ? second : first
    );
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => '# Plan' });
    const provider = new ContextProvider(vi.fn());

    try {
      await expect(
        provider.readFile('RALPH.md', {
          restrictToWorkspace: true,
          workspaceDirectory: '/second/',
        })
      ).resolves.toBe('# Plan');
      expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
        fsPath: '/second/RALPH.md',
      });
      expect(vscodeMock.workspace.fs.stat).not.toHaveBeenCalledWith({
        fsPath: '/first/RALPH.md',
      });
    } finally {
      provider.dispose();
    }
  });

  it('fails closed when a restricted workspace binding is not open', async () => {
    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    const provider = new ContextProvider(vi.fn());

    try {
      await expect(
        provider.readFile('RALPH.md', {
          restrictToWorkspace: true,
          workspaceDirectory: '/other',
        })
      ).resolves.toBeNull();
      expect(vscodeMock.workspace.fs.stat).not.toHaveBeenCalled();
      expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('rejects an absolute plan in another open root when resolution is root-bound', async () => {
    const first = { name: 'first', uri: { fsPath: '/first' } };
    const second = { name: 'second', uri: { fsPath: '/second' } };
    vscodeMock.workspace.workspaceFolders = [first, second];
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(second);
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => '# Other plan' });
    const provider = new ContextProvider(vi.fn());

    try {
      await expect(
        provider.readFile('/second/RALPH.md', {
          restrictToWorkspace: true,
          workspaceDirectory: '/first',
        })
      ).resolves.toBeNull();
      expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('rejects raw parent traversal before restricted absolute resolution', async () => {
    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    const provider = new ContextProvider(vi.fn());

    try {
      await expect(
        provider.readFile('/repo/src/../secret.txt', {
          restrictToWorkspace: true,
          workspaceDirectory: '/repo',
        })
      ).resolves.toBeNull();
      expect(vscodeMock.workspace.fs.stat).not.toHaveBeenCalled();
      expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('allows trusted unrestricted absolute reads with lexical parent segments', async () => {
    const provider = new ContextProvider(vi.fn());
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'trusted' });

    try {
      await expect(provider.readFile('/repo/src/../trusted.txt')).resolves.toBe('trusted');
      expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
        fsPath: '/repo/src/../trusted.txt',
      });
    } finally {
      provider.dispose();
    }
  });

  it('refuses an absolute path that reaches outside via a workspace symlink', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    // `/repo/vendor` is a symlink to `/etc`, so `/repo/vendor/passwd` is
    // lexically inside the workspace but canonically outside it.
    fsState.symlinks.set('/repo/vendor', '/etc');
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'secret' });

    try {
      await expect(
        provider.readFile('/repo/vendor/passwd', { restrictToWorkspace: true })
      ).resolves.toBeNull();
      await expect(
        provider.resolvePath('/repo/vendor/passwd', { restrictToWorkspace: true })
      ).resolves.toBeNull();
      expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('refuses a relative path that reaches outside via a workspace symlink', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    fsState.symlinks.set('/repo/vendor', '/etc');
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'secret' });

    try {
      await expect(
        provider.readFile('vendor/passwd', { restrictToWorkspace: true })
      ).resolves.toBeNull();
      expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('allows a symlink that stays inside the workspace', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    fsState.symlinks.set('/repo/link', '/repo/real');
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'source' });

    try {
      await expect(
        provider.readFile('/repo/link/app.ts', { restrictToWorkspace: true })
      ).resolves.toBe('source');
    } finally {
      provider.dispose();
    }
  });

  it('opens the verified canonical path, not the unverified symlink path', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    fsState.symlinks.set('/repo/link', '/repo/real');
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'source' });

    try {
      await provider.readFile('/repo/link/app.ts', { restrictToWorkspace: true });

      // Reading the original path would leave a window for the symlink to be
      // repointed between the containment check and the open.
      expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
        fsPath: '/repo/real/app.ts',
      });
    } finally {
      provider.dispose();
    }
  });

  it('opens the requested path unchanged when the caller is unrestricted', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    fsState.symlinks.set('/repo/link', '/repo/real');
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'source' });

    try {
      await provider.readFile('/repo/link/app.ts');

      expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
        fsPath: '/repo/link/app.ts',
      });
    } finally {
      provider.dispose();
    }
  });

  it('returns the verified canonical path with lexical display metadata', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    fsState.symlinks.set('/repo/link', '/repo/real');
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.asRelativePath.mockReturnValue('link/app.ts');

    try {
      await expect(
        provider.resolvePath('/repo/link/app.ts', { restrictToWorkspace: true })
      ).resolves.toEqual({
        path: '/repo/real/app.ts',
        relativePath: 'link/app.ts',
        type: 'file',
      });
      expect(vscodeMock.workspace.fs.stat).toHaveBeenLastCalledWith({
        fsPath: '/repo/real/app.ts',
      });
    } finally {
      provider.dispose();
    }
  });

  it('allows a workspace root that is itself reached through a symlink', async () => {
    const provider = new ContextProvider(vi.fn());

    // The workspace folder path is a symlink; both sides canonicalize together.
    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    fsState.symlinks.set('/repo', '/private/repo');
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'source' });

    try {
      await expect(
        provider.readFile('/repo/src/app.ts', { restrictToWorkspace: true })
      ).resolves.toBe('source');
    } finally {
      provider.dispose();
    }
  });

  it('still follows a workspace symlink when the caller is unrestricted', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    fsState.symlinks.set('/repo/vendor', '/etc');
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'contents' });

    try {
      await expect(provider.readFile('/repo/vendor/passwd')).resolves.toBe('contents');
    } finally {
      provider.dispose();
    }
  });

  it('refuses workspace-relative paths that climb out of the folder', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.fs.stat.mockResolvedValue({ type: 0 });
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ getText: () => 'secret' });

    try {
      await expect(
        provider.readFile('../../etc/passwd', { restrictToWorkspace: true })
      ).resolves.toBeNull();
      expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('does not open a missing diff path that climbs out of the workspace', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscodeMock.workspace.fs.stat.mockRejectedValue(new Error('File not found'));
    vscodeMock.extensions.getExtension.mockReturnValue(undefined);

    try {
      await provider.openPath('../outside/secret.ts', { kind: 'file', view: 'diff' });

      expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
      expect(vscodeMock.window.showTextDocument).not.toHaveBeenCalled();
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

  it('opens a unique workspace file for a missing root-level basename reference', async () => {
    const provider = new ContextProvider(vi.fn());
    const missingUri = { fsPath: '/repo/MarkdownRenderer.tsx' };
    const matchedUri = { fsPath: '/repo/src/webview/components/MarkdownRenderer.tsx' };
    const document = { uri: matchedUri };
    const editor = {
      selection: null,
      revealRange: vi.fn(),
    };

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.fs.stat.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === missingUri.fsPath) throw new Error('File not found');
      return { type: 0 };
    });
    vscodeMock.workspace.findFiles.mockResolvedValue([matchedUri]);
    vscodeMock.workspace.openTextDocument.mockResolvedValue(document);
    vscodeMock.window.showTextDocument.mockResolvedValue(editor);

    try {
      await provider.openPath('/repo/MarkdownRenderer.tsx', { kind: 'file', line: 1447 });

      expect(vscodeMock.workspace.findFiles).toHaveBeenCalledWith(
        '**/MarkdownRenderer.tsx',
        null,
        2
      );
      expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(matchedUri);
      expect(editor.selection).toEqual({
        start: { line: 1446, character: 0 },
        end: { line: 1446, character: 0 },
      });
      expect(editor.revealRange).toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('does not guess between duplicate basename matches', async () => {
    const provider = new ContextProvider(vi.fn());

    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.fs.stat.mockRejectedValue(new Error('File not found'));
    vscodeMock.workspace.findFiles.mockResolvedValue([
      { fsPath: '/repo/src/first/Shared.ts' },
      { fsPath: '/repo/src/second/Shared.ts' },
    ]);

    try {
      await provider.openPath('/repo/Shared.ts', { kind: 'file' });

      expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
      expect(vscodeMock.window.showTextDocument).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('walks the workspace when indexed basename search returns no results', async () => {
    const provider = new ContextProvider(vi.fn());
    const matchedUri = { fsPath: '/repo/src/webview/components/MarkdownRenderer.tsx' };
    const document = { uri: matchedUri };

    vscodeMock.workspace.workspaceFolders = [];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });
    vscodeMock.workspace.fs.stat.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/repo/MarkdownRenderer.tsx') throw new Error('File not found');
      return { type: 0 };
    });
    vscodeMock.workspace.findFiles.mockResolvedValue([]);
    const directories: Record<string, [string, number][]> = {
      '/repo': [
        ['node_modules', vscodeMock.FileType.Directory],
        ['src', vscodeMock.FileType.Directory],
      ],
      '/repo/src': [['webview', vscodeMock.FileType.Directory]],
      '/repo/src/webview': [['components', vscodeMock.FileType.Directory]],
      '/repo/src/webview/components': [['MarkdownRenderer.tsx', 0]],
    };
    vscodeMock.workspace.fs.readDirectory.mockImplementation(
      async (uri: { fsPath: string }) => directories[uri.fsPath] ?? []
    );
    vscodeMock.workspace.openTextDocument.mockResolvedValue(document);
    vscodeMock.window.showTextDocument.mockResolvedValue({});

    try {
      await provider.openPath('/repo/MarkdownRenderer.tsx', { kind: 'file', line: 1447 });

      expect(vscodeMock.workspace.fs.readDirectory).not.toHaveBeenCalledWith({
        fsPath: '/repo/node_modules',
      });
      expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(matchedUri);
    } finally {
      provider.dispose();
    }
  });

  it('walks the local project when VS Code filesystem traversal is unavailable', async () => {
    const provider = new ContextProvider(vi.fn());
    const matchedUri = { fsPath: '/repo/src/webview/components/MarkdownRenderer.tsx' };

    vscodeMock.workspace.workspaceFolders = [];
    vscodeMock.workspace.fs.stat.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/repo/MarkdownRenderer.tsx') throw new Error('File not found');
      return { type: 0 };
    });
    vscodeMock.workspace.findFiles.mockResolvedValue([]);
    vscodeMock.workspace.fs.readDirectory.mockRejectedValue(new Error('Unavailable'));
    fsState.directories.set('/repo', [
      { name: 'node_modules', directory: true },
      { name: 'src', directory: true },
    ]);
    fsState.directories.set('/repo/src', [{ name: 'webview', directory: true }]);
    fsState.directories.set('/repo/src/webview', [{ name: 'components', directory: true }]);
    fsState.directories.set('/repo/src/webview/components', [
      { name: 'MarkdownRenderer.tsx', directory: false },
    ]);
    vscodeMock.workspace.openTextDocument.mockResolvedValue({ uri: matchedUri });
    vscodeMock.window.showTextDocument.mockResolvedValue({});

    try {
      await provider.openPath('/repo/MarkdownRenderer.tsx', { kind: 'file', line: 1447 });

      expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith(matchedUri);
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
        workspaceFolders: [{ name: 'repo', path: '/repo' }],
        activeFile: {
          path: '/repo/src/app.ts',
          relativePath: 'src/app.ts',
          language: 'typescript',
        },
        selection: {
          startLine: 2,
          endLine: 4,
        },
        editorText: null,
        diagnostics: [],
        diagnosticsTotal: 0,
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
        workspaceFolders: [{ name: 'repo', path: '/repo' }],
        activeFile: {
          path: '/repo/src/app.ts',
          relativePath: 'src/app.ts',
          language: 'typescript',
        },
        selection: {
          startLine: 3,
          endLine: 5,
        },
        editorText: null,
        diagnostics: [
          {
            path: '/repo/src/app.ts',
            severity: 'error',
            message: 'bad',
            line: 7,
          },
        ],
        diagnosticsTotal: 1,
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

  it('captures selected text from a dirty editor instead of relying on disk content', () => {
    const onChange = vi.fn();
    const uri = {
      fsPath: '/repo/src/app.ts',
      scheme: 'file',
      toString: () => 'file:///repo/src/app.ts',
    };
    vscodeMock.window.activeTextEditor = {
      document: {
        uri,
        isUntitled: false,
        isDirty: true,
        languageId: 'typescript',
        getText: vi.fn(() => 'const unsaved = true;'),
      },
      selection: {
        isEmpty: false,
        start: { line: 4 },
        end: { line: 4 },
        active: { line: 4 },
      },
    };
    vscodeMock.workspace.workspaceFolders = [{ name: 'repo', uri: { fsPath: '/repo' } }];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(
      vscodeMock.workspace.workspaceFolders[0]
    );
    vscodeMock.workspace.asRelativePath.mockReturnValue('src/app.ts');

    const provider = new ContextProvider(onChange);
    try {
      expect(provider.context.editorText).toEqual({
        kind: 'selection',
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        language: 'typescript',
        range: { startLine: 5, endLine: 5 },
        text: 'const unsaved = true;',
        truncated: false,
      });
    } finally {
      provider.dispose();
    }
  });

  it('persists an explicit workspace root and stops following the active editor root', async () => {
    const workspaceState = { get: vi.fn(), update: vi.fn(() => Promise.resolve()) };
    const first = { name: 'first', uri: { fsPath: '/first' } };
    const second = { name: 'second', uri: { fsPath: '/second' } };
    const uri = {
      fsPath: '/first/app.ts',
      scheme: 'file',
      toString: () => 'file:///first/app.ts',
    };
    vscodeMock.workspace.workspaceFolders = [first, second];
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(first);
    vscodeMock.languages.getDiagnostics.mockReturnValue([
      { severity: 0, message: 'first-root error', range: { start: { line: 1 } } },
    ]);
    vscodeMock.window.activeTextEditor = {
      document: { uri, isUntitled: false, isDirty: false, languageId: 'typescript' },
      selection: {
        isEmpty: true,
        start: { line: 0 },
        end: { line: 0 },
        active: { line: 0 },
      },
    };

    const provider = new ContextProvider(vi.fn(), workspaceState);
    try {
      await provider.selectWorkspace('/second');

      expect(provider.context.workspacePath).toBe('/second');
      expect(provider.context.activeFile).toBeNull();
      expect(provider.context.diagnostics).toEqual([]);
      expect(workspaceState.update).toHaveBeenCalledWith(
        'varro.selectedWorkspaceFolder',
        '/second'
      );
    } finally {
      provider.dispose();
    }
  });
});
