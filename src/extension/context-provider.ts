import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, sep } from 'path';
import type { EditorContext, EditorTextContext } from '../shared/protocol';
import { asRecord, isNumber, isString } from '../shared/type-utils';
import { isSameWorkspacePath } from '../shared/workspace-path';
import { toEditorDiagnostic } from './workspace-problems';
import { logger } from './logger';
import {
  getRelativePath,
  normalizeRelativeWorkspacePath,
  resolveWorkspaceRelativePath,
} from './util/path';
import { delay } from './server-utils';

export type WorkspaceResolutionOptions = {
  /** Resolve paths that do not exist on disk yet (e.g. a deleted file in a diff). */
  allowMissing?: boolean;
  /**
   * Refuse paths that land outside every workspace folder. Set by callers
   * relaying a path that originated in the webview, so a compromised or buggy
   * renderer cannot read arbitrary files through the extension host.
   */
  restrictToWorkspace?: boolean;
  /** Bind a restricted resolution to this exact open workspace root. */
  workspaceDirectory?: string;
  /** Permit metadata resolution inside sibling open roots after validating the primary root. */
  allowSiblingWorkspaceFolders?: boolean;
};

export class ContextProvider implements vscode.Disposable {
  private static readonly SELECTED_WORKSPACE_KEY = 'varro.selectedWorkspaceFolder';
  private static readonly MAX_SELECTION_CHARACTERS = 32 * 1024;
  private static readonly MAX_DIRTY_BUFFER_CHARACTERS = 16 * 1024;
  private static readonly MAX_DIRTY_BUFFER_LINES = 300;
  private static readonly TERMINAL_COPY_DELAY_MS = 40;
  private static readonly TERMINAL_COPY_MAX_ATTEMPTS = 5;
  private static readonly TERMINAL_COPY_TIMEOUT_MS = 1500;
  private static readonly LATE_CLIPBOARD_WRITE_TIMEOUT_MS = 10_000;
  private static readonly ACTIVE_EDITOR_SETTLE_DELAY_MS = 60;
  private static readonly RECENT_TERMINAL_TEXT_CHARACTERS = 256 * 1024;
  private static readonly RECENT_TERMINAL_COMMANDS = 50;
  private static readonly TERMINAL_HISTORY_KEY = 'varro.recentTerminalOutput';
  private static readonly SAVED_TERMINAL_TEXT_CHARACTERS = 64 * 1024;
  private static readonly SAVED_TERMINALS = 10;
  private static readonly TERMINAL_HISTORY_SAVE_DELAY_MS = 1000;
  private disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private diagnosticsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private activeEditorSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private _context: EditorContext = {
    workspacePath: null,
    workspaceDirectory: null,
    workspaceFolders: [],
    activeWorkspacePath: null,
    activeFile: null,
    selection: null,
    editorText: null,
    diagnostics: [],
    diagnosticsTotal: 0,
    diagnosticCounts: { errors: 0, warnings: 0 },
  };
  private _terminalSelection: { text: string; terminalName: string } | null = null;
  private readonly recentTerminalText = new Map<vscode.Terminal, string>();
  private readonly recentTerminalCommands = new Map<vscode.Terminal, string[]>();
  private readonly terminalProcessIds = new Map<vscode.Terminal, number>();
  private readonly restoredTerminals = new Set<vscode.Terminal>();
  private terminalHistorySaveTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalCaptureQueue: Promise<void> = Promise.resolve();
  private pendingClipboardSettle: Promise<void> = Promise.resolve();
  private _lastContextSnapshot: ContextSnapshot | null = null;
  private _lastEmittedContextSnapshot: EditorContext | null = null;
  private _lastDiagnosticsSourceKey: string | null = null;
  private onChange: (ctx: EditorContext) => void;
  private selectedWorkspacePath: string | null;

  constructor(
    onChange: (ctx: EditorContext) => void,
    private readonly workspaceState?: Pick<vscode.Memento, 'get' | 'update'>
  ) {
    this.onChange = onChange;
    this.selectedWorkspacePath =
      workspaceState?.get<string>(ContextProvider.SELECTED_WORKSPACE_KEY) ?? null;

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.update()),
      vscode.window.onDidChangeTextEditorSelection(() => this.debouncedUpdate()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) this.debouncedUpdate();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document === vscode.window.activeTextEditor?.document) this.update();
      }),
      vscode.languages.onDidChangeDiagnostics((event) => {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (!activeUri || event.uris.some((uri) => uri.toString() === activeUri.toString())) {
          this.debouncedDiagnosticsUpdate();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.update()),
      vscode.window.onDidStartTerminalShellExecution((event) => {
        void this.recordTerminalExecution(event);
      }),
      vscode.window.onDidOpenTerminal((terminal) => {
        void this.restoreTerminalHistory(terminal);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        this.recentTerminalText.delete(terminal);
        this.recentTerminalCommands.delete(terminal);
        this.restoredTerminals.delete(terminal);
        const processId = this.terminalProcessIds.get(terminal);
        this.terminalProcessIds.delete(terminal);
        if (processId !== undefined) void this.saveTerminalHistory([processId]);
      })
    );
    for (const terminal of vscode.window.terminals) void this.restoreTerminalHistory(terminal);

    this.update();
  }

  get context(): EditorContext {
    return this._context;
  }

  get terminalSelection() {
    return this._terminalSelection;
  }

  /**
   * Finds an open terminal that recently showed the pasted text. The API
   * cannot read a terminal's screen, so this compares against output captured
   * through shell integration; terminals without it never match. Prompts are
   * not part of that output, so a selected prompt line counts when it ends with
   * a command the terminal ran. A single line must be a whole terminal line,
   * which keeps words that merely occur in the output as plain text.
   */
  findTerminalText(text: string): { text: string; terminalName: string } | null {
    const lines = normalizeTerminalLines(text)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    const active = vscode.window.activeTerminal;
    const terminals = [
      ...(active ? [active] : []),
      ...vscode.window.terminals.filter((terminal) => terminal !== active),
    ];
    for (const terminal of terminals) {
      const recent = this.recentTerminalText.get(terminal);
      if (!recent) continue;
      const output = normalizeTerminalLines(recent);
      const outputLines = new Set(output.split('\n').map((line) => line.trim()));
      const commands = this.recentTerminalCommands.get(terminal) ?? [];
      const isPromptLine = (line: string) => commands.some((command) => line.endsWith(command));
      const matches =
        lines.length === 1
          ? outputLines.has(lines[0]!) || isPromptLine(lines[0]!)
          : lines.every((line) => output.includes(line) || isPromptLine(line));
      if (matches) return { text, terminalName: terminal.name };
    }
    return null;
  }

  private async recordTerminalExecution(event: vscode.TerminalShellExecutionStartEvent) {
    const command = event.execution.commandLine.value.trim();
    if (command) {
      const commands = this.recentTerminalCommands.get(event.terminal) ?? [];
      this.recentTerminalCommands.set(
        event.terminal,
        [...commands, command].slice(-ContextProvider.RECENT_TERMINAL_COMMANDS)
      );
      this.appendTerminalText(event.terminal, `${command}\n`);
    }
    void this.trackTerminalProcess(event.terminal);
    try {
      for await (const data of event.execution.read()) {
        this.appendTerminalText(event.terminal, data);
      }
    } catch {
      // Output capture is best effort; missed output only leaves a paste as text.
    }
  }

  private appendTerminalText(terminal: vscode.Terminal, data: string) {
    const text = `${this.recentTerminalText.get(terminal) ?? ''}${stripTerminalEscapes(data)}`;
    const max = ContextProvider.RECENT_TERMINAL_TEXT_CHARACTERS;
    this.recentTerminalText.set(terminal, text.length > max ? text.slice(-max) : text);
    this.scheduleTerminalHistorySave();
  }

  /**
   * A window reload restarts the extension host but reconnects the same
   * terminal processes, so captured output is saved per process id and
   * restored when the terminal reappears.
   */
  private async restoreTerminalHistory(terminal: vscode.Terminal) {
    if (this.restoredTerminals.has(terminal)) return;
    this.restoredTerminals.add(terminal);
    const processId = await this.trackTerminalProcess(terminal);
    if (processId === undefined) return;
    const saved = this.readTerminalHistory().get(String(processId));
    if (!saved) return;
    // Output captured since activation follows what was saved before the reload.
    this.recentTerminalText.set(
      terminal,
      `${saved.text}${this.recentTerminalText.get(terminal) ?? ''}`.slice(
        -ContextProvider.RECENT_TERMINAL_TEXT_CHARACTERS
      )
    );
    this.recentTerminalCommands.set(
      terminal,
      [...saved.commands, ...(this.recentTerminalCommands.get(terminal) ?? [])].slice(
        -ContextProvider.RECENT_TERMINAL_COMMANDS
      )
    );
  }

  private async trackTerminalProcess(terminal: vscode.Terminal) {
    const known = this.terminalProcessIds.get(terminal);
    if (known !== undefined) return known;
    try {
      const processId = await terminal.processId;
      if (processId !== undefined) this.terminalProcessIds.set(terminal, processId);
      return processId;
    } catch {
      return undefined;
    }
  }

  private readTerminalHistory() {
    const history = new Map<string, SavedTerminalOutput>();
    const stored = asRecord(this.workspaceState?.get(ContextProvider.TERMINAL_HISTORY_KEY));
    for (const [processId, value] of Object.entries(stored ?? {})) {
      const entry = asRecord(value);
      const commands = entry?.commands;
      if (!entry || !isString(entry.text) || !Array.isArray(commands) || !isNumber(entry.savedAt)) {
        continue;
      }
      history.set(processId, {
        text: entry.text,
        commands: commands.filter(isString),
        savedAt: entry.savedAt,
      });
    }
    return history;
  }

  private scheduleTerminalHistorySave() {
    if (!this.workspaceState || this.terminalHistorySaveTimer) return;
    this.terminalHistorySaveTimer = setTimeout(() => {
      this.terminalHistorySaveTimer = null;
      void this.saveTerminalHistory();
    }, ContextProvider.TERMINAL_HISTORY_SAVE_DELAY_MS);
  }

  private async saveTerminalHistory(closedProcessIds: readonly number[] = []) {
    if (!this.workspaceState) return;
    const history = this.readTerminalHistory();
    for (const processId of closedProcessIds) history.delete(String(processId));
    const savedAt = Date.now();
    for (const [terminal, processId] of this.terminalProcessIds) {
      const text = this.recentTerminalText.get(terminal);
      if (!text) continue;
      history.set(String(processId), {
        text: text.slice(-ContextProvider.SAVED_TERMINAL_TEXT_CHARACTERS),
        commands: this.recentTerminalCommands.get(terminal) ?? [],
        savedAt,
      });
    }
    const kept = [...history]
      .toSorted(([, left], [, right]) => right.savedAt - left.savedAt)
      .slice(0, ContextProvider.SAVED_TERMINALS);
    try {
      await this.workspaceState.update(
        ContextProvider.TERMINAL_HISTORY_KEY,
        Object.fromEntries(kept)
      );
    } catch {
      // Losing saved output only means a paste after reload stays plain text.
    }
  }

  isOpenWorkspaceRoot(path: string): boolean {
    return Boolean(this.getOpenWorkspaceFolder(path));
  }

  getOpenWorkspaceRoot(path: string): string | null {
    return this.getOpenWorkspaceFolder(path)?.uri.fsPath ?? null;
  }

  async selectWorkspace(path: string) {
    const folder = this.getOpenWorkspaceFolder(path);
    if (!folder) throw new Error('Selected workspace folder is not open');
    this.selectedWorkspacePath = folder.uri.fsPath;
    await this.workspaceState?.update(
      ContextProvider.SELECTED_WORKSPACE_KEY,
      this.selectedWorkspacePath
    );
    this.update();
  }

  /**
   * Serialized: the capture is a read-modify-restore transaction on the single
   * system clipboard. Overlapping runs would read each other's sentinel as
   * terminal output and interleave their restores, which can strand a sentinel
   * on the user's clipboard.
   */
  captureTerminalSelection(): Promise<
    { ok: true; terminalName: string } | { ok: false; reason: 'no-terminal' | 'empty-selection' }
  > {
    const run = this.terminalCaptureQueue.then(
      () => this.captureTerminalSelectionNow(),
      () => this.captureTerminalSelectionNow()
    );
    // The queue is held until any clipboard write this run abandoned has also
    // settled, so the next capture cannot mistake a late landing for output.
    this.terminalCaptureQueue = run.then(
      () => this.waitForPendingClipboardSettle(),
      () => this.waitForPendingClipboardSettle()
    );
    return run;
  }

  private async waitForPendingClipboardSettle() {
    let pending: Promise<void>;
    do {
      pending = this.pendingClipboardSettle;
      await pending;
    } while (pending !== this.pendingClipboardSettle);
  }

  private async captureTerminalSelectionNow(): Promise<
    { ok: true; terminalName: string } | { ok: false; reason: 'no-terminal' | 'empty-selection' }
  > {
    try {
      return await this.runTerminalSelectionCapture();
    } catch (err) {
      // A clipboard or command failure leaves us with no idea what the terminal
      // holds. Keeping the previous capture would attach stale text to the next
      // prompt, since it is replayed into webview initialization.
      this._terminalSelection = null;
      throw err;
    }
  }

  private async runTerminalSelectionCapture(): Promise<
    { ok: true; terminalName: string } | { ok: false; reason: 'no-terminal' | 'empty-selection' }
  > {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      this._terminalSelection = null;
      return { ok: false, reason: 'no-terminal' };
    }

    const previousClipboard = await withTimeout(
      vscode.env.clipboard.readText(),
      ContextProvider.TERMINAL_COPY_TIMEOUT_MS,
      'Timed out reading clipboard before terminal selection capture'
    );
    // Prime the clipboard with a value the terminal cannot produce. Comparing
    // against the *previous* clipboard instead would report "empty selection"
    // whenever the selected text already happened to be on the clipboard.
    const sentinel = `varro-terminal-selection-${randomUUID()}`;
    let selectionText = '';
    let capturedSelection = false;
    let restoreCompleted = false;

    // Issued outside the timeout wrapper: `withTimeout` abandons the wait but
    // cannot cancel the write, so from here on the clipboard counts as dirtied.
    // Restore only if it still contains a value this capture wrote.
    const primeWrite = Promise.resolve(vscode.env.clipboard.writeText(sentinel));
    this.trackClipboardMutation(
      primeWrite,
      previousClipboard,
      () => restoreCompleted,
      () => sentinel
    );

    try {
      await withTimeout(
        primeWrite,
        ContextProvider.TERMINAL_COPY_TIMEOUT_MS,
        'Timed out priming clipboard before terminal selection capture'
      );
      const copyCommand = Promise.resolve(
        vscode.commands.executeCommand('workbench.action.terminal.copySelection')
      );
      this.trackClipboardMutation(
        copyCommand,
        previousClipboard,
        () => restoreCompleted,
        () => selectionText || undefined
      );
      await withTimeout(
        copyCommand,
        ContextProvider.TERMINAL_COPY_TIMEOUT_MS,
        'Timed out copying terminal selection'
      );
      for (let attempt = 0; attempt < ContextProvider.TERMINAL_COPY_MAX_ATTEMPTS; attempt += 1) {
        await delay(ContextProvider.TERMINAL_COPY_DELAY_MS * (attempt + 1));
        selectionText = await withTimeout(
          vscode.env.clipboard.readText(),
          ContextProvider.TERMINAL_COPY_TIMEOUT_MS,
          'Timed out reading clipboard while capturing terminal selection'
        );
        // Any value other than the sentinel means the copy landed, so a
        // blank result is a genuinely empty selection rather than a slow copy.
        if (selectionText !== sentinel) {
          capturedSelection = selectionText.trim().length > 0;
          break;
        }
      }
    } finally {
      try {
        // Let a slow prime settle first, or it would land on the clipboard
        // after the restore and strand the sentinel there.
        await withTimeout(
          primeWrite.catch(() => undefined),
          ContextProvider.TERMINAL_COPY_TIMEOUT_MS,
          'Timed out waiting for the clipboard prime to settle'
        ).catch(() => undefined);
        await this.restoreClipboard(
          previousClipboard,
          'Failed to restore clipboard after terminal selection capture',
          [sentinel, selectionText]
        );
      } finally {
        restoreCompleted = true;
      }
    }

    if (!capturedSelection || !selectionText.trim()) {
      this._terminalSelection = null;
      return { ok: false, reason: 'empty-selection' };
    }

    this._terminalSelection = {
      text: selectionText,
      terminalName: terminal.name,
    };
    return { ok: true, terminalName: terminal.name };
  }

  private trackClipboardMutation(
    mutation: Promise<unknown>,
    previousClipboard: string,
    isRestoreCompleted: () => boolean,
    expectedValue: () => string | undefined
  ) {
    const settle = withTimeout(
      mutation.catch(() => undefined),
      ContextProvider.LATE_CLIPBOARD_WRITE_TIMEOUT_MS,
      'Timed out waiting for a late clipboard mutation to settle'
    )
      .then(async () => {
        if (!isRestoreCompleted()) return;
        const expected = expectedValue();
        if (!expected) return;
        await this.restoreClipboard(
          previousClipboard,
          'Could not undo a late clipboard mutation from terminal selection capture',
          [expected]
        );
      })
      .catch(() => {
        logger.warn('Could not undo a late clipboard mutation from terminal selection capture');
      });

    this.pendingClipboardSettle = Promise.all([this.pendingClipboardSettle, settle]).then(
      () => undefined
    );
  }

  private async restoreClipboard(
    previousClipboard: string,
    warning: string,
    expectedValues: readonly string[]
  ) {
    try {
      const current = await withTimeout(
        vscode.env.clipboard.readText(),
        ContextProvider.TERMINAL_COPY_TIMEOUT_MS,
        'Timed out checking clipboard before terminal selection restore'
      );
      if (current === previousClipboard || !expectedValues.includes(current)) return;
      const restoreWrite = Promise.resolve(vscode.env.clipboard.writeText(previousClipboard));
      // A restore that outlives its immediate timeout is itself a late clipboard
      // mutation. Wait for it before dequeuing, but never try to restore a restore.
      this.trackClipboardSettle(restoreWrite);
      await withTimeout(
        restoreWrite,
        ContextProvider.TERMINAL_COPY_TIMEOUT_MS,
        'Timed out restoring clipboard after terminal selection capture'
      );
    } catch {
      logger.warn(warning);
    }
  }

  private trackClipboardSettle(operation: Promise<unknown>) {
    const settle = withTimeout(
      operation.catch(() => undefined),
      ContextProvider.LATE_CLIPBOARD_WRITE_TIMEOUT_MS,
      'Timed out waiting for a clipboard restore to settle'
    ).catch(() => {
      logger.warn('Timed out waiting for a clipboard restore to settle');
    });

    this.pendingClipboardSettle = Promise.all([this.pendingClipboardSettle, settle]).then(
      () => undefined
    );
  }

  clearTerminalSelection() {
    this._terminalSelection = null;
  }

  private debouncedUpdate() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.update();
    }, 150);
  }

  private debouncedDiagnosticsUpdate() {
    if (this.diagnosticsDebounceTimer) clearTimeout(this.diagnosticsDebounceTimer);
    this.diagnosticsDebounceTimer = setTimeout(() => {
      this.diagnosticsDebounceTimer = null;
      this.updateDiagnostics();
    }, 150);
  }

  private update() {
    if (this.activeEditorSettleTimer) {
      clearTimeout(this.activeEditorSettleTimer);
      this.activeEditorSettleTimer = null;
    }

    this._context.workspacePath = this.getPreferredWorkspacePath();
    this._context.workspaceDirectory = this.getWorkspaceDirectory();
    this._context.workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath,
    }));

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.activeEditorSettleTimer = setTimeout(() => {
        this.activeEditorSettleTimer = null;
        if (vscode.window.activeTextEditor) {
          this.update();
          return;
        }
        const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        const activeTabFile =
          activeTabInput instanceof vscode.TabInputText
            ? { uri: activeTabInput.uri, language: '' }
            : activeTabInput instanceof vscode.TabInputCustom &&
                activeTabInput.viewType === 'vscode.markdown.preview.editor'
              ? { uri: activeTabInput.uri, language: 'markdown' }
              : null;
        if (activeTabFile) {
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeTabFile.uri);
          this._context.activeWorkspacePath = workspaceFolder?.uri.fsPath ?? null;
          this._context.activeFile = {
            path: activeTabFile.uri.fsPath,
            relativePath: workspaceFolder
              ? getRelativePath(activeTabFile.uri, workspaceFolder)
              : activeTabFile.uri.fsPath,
            language: activeTabFile.language,
          };
          this._context.selection = null;
          this._context.editorText = null;
          if (!this.captureContextSnapshot()) return;
          this.refreshDiagnosticsIfNeeded();
          return;
        }
        this._context.activeWorkspacePath = null;
        this._context.activeFile = null;
        this._context.selection = null;
        this._context.editorText = null;
        if (!this.captureContextSnapshot()) return;
        this.refreshDiagnosticsIfNeeded();
      }, ContextProvider.ACTIVE_EDITOR_SETTLE_DELAY_MS);
      return;
    }

    const doc = editor.document;
    if (doc.isUntitled || doc.uri.scheme === 'untitled') {
      this._context.activeWorkspacePath = null;
      this._context.activeFile = null;
      const selection = editor.selection;
      this._context.selection = !selection.isEmpty
        ? {
            startLine: selection.start.line + 1,
            endLine: selection.end.line + (selection.end.character === 0 ? 0 : 1),
          }
        : null;
      this._context.editorText = this.createEditorTextContext(editor, null, doc.fileName);
      if (!this.captureContextSnapshot()) return;
      this.refreshDiagnosticsIfNeeded();
      return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    this._context.activeWorkspacePath = workspaceFolder?.uri.fsPath ?? null;
    // For files outside any workspace folder we surface the absolute fsPath
    // as `relativePath` so that downstream consumers (e.g. Ralph plan input)
    // receive a path that ContextProvider.readFile can resolve. Display sites
    // already reduce this to a basename via getLeafPathName.
    const relativePath = workspaceFolder
      ? getRelativePath(doc.uri, workspaceFolder)
      : doc.uri.fsPath;

    this._context.activeFile = {
      path: doc.uri.fsPath,
      relativePath,
      language: doc.languageId,
    };

    const selection = editor.selection;
    if (!selection.isEmpty) {
      this._context.selection = {
        startLine: selection.start.line + 1,
        endLine: selection.end.line + (selection.end.character === 0 ? 0 : 1),
      };
    } else {
      this._context.selection = null;
    }
    this._context.editorText = this.createEditorTextContext(editor, doc.uri.fsPath, relativePath);

    if (!this.captureContextSnapshot()) {
      this.refreshDiagnosticsIfNeeded();
      return;
    }

    this.refreshDiagnosticsIfNeeded();
  }

  private getWorkspaceDirectory(): string | null {
    const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const workspaceFile = vscode.workspace.workspaceFile;
    if (!workspaceFile || workspaceFile.scheme === 'untitled') return firstFolder;
    return workspaceFile.fsPath ? dirname(workspaceFile.fsPath) : firstFolder;
  }

  private refreshDiagnosticsIfNeeded() {
    const nextSourceKey = this.getDiagnosticsSourceKey();
    if (nextSourceKey === this._lastDiagnosticsSourceKey) {
      this.emitContextIfChanged();
      return;
    }

    this._lastDiagnosticsSourceKey = nextSourceKey;
    this.updateDiagnostics();
  }

  private updateDiagnostics() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._context.diagnostics = [];
      this._context.diagnosticsTotal = 0;
      this._context.diagnosticCounts = { errors: 0, warnings: 0 };
      this.emitContextIfChanged();
      return;
    }

    const diags = vscode.languages.getDiagnostics(editor.document.uri);
    this._context.diagnosticsTotal = diags.length;
    this._context.diagnosticCounts = {
      errors: diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
      warnings: diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length,
    };
    const intersectsSelection = (d: vscode.Diagnostic) => {
      const selection = editor.selection;
      if (selection.isEmpty) return false;
      const start = d.range.start;
      const end = d.range.end ?? d.range.start;
      return (
        comparePositions(start, selection.end) < 0 &&
        (comparePositions(end, selection.start) > 0 ||
          (comparePositions(start, end) === 0 && comparePositions(start, selection.start) >= 0))
      );
    };
    const ranked = diags.map((diagnostic) => ({
      diagnostic,
      selected: intersectsSelection(diagnostic),
    }));
    ranked.sort(
      (a, b) =>
        Number(a.diagnostic.severity > vscode.DiagnosticSeverity.Warning) -
          Number(b.diagnostic.severity > vscode.DiagnosticSeverity.Warning) ||
        Number(b.selected) - Number(a.selected) ||
        a.diagnostic.severity - b.diagnostic.severity ||
        Math.abs(
          a.diagnostic.range.start.line -
            (editor.selection.active?.line ?? editor.selection.start.line)
        ) -
          Math.abs(
            b.diagnostic.range.start.line -
              (editor.selection.active?.line ?? editor.selection.start.line)
          )
    );
    this._context.diagnostics = ranked
      .slice(0, 20)
      .map(({ diagnostic, selected }) =>
        toEditorDiagnostic(editor.document.uri.fsPath, diagnostic, selected)
      );
    this.emitContextIfChanged();
  }

  private captureContextSnapshot() {
    const nextSnapshot = this.getContextSnapshot();
    if (areContextSnapshotsEqual(nextSnapshot, this._lastContextSnapshot)) {
      return false;
    }

    this._lastContextSnapshot = nextSnapshot;
    return true;
  }

  private getContextSnapshot(): ContextSnapshot {
    const activeFile = this._context.activeFile;
    return {
      workspacePath: this._context.workspacePath,
      workspaceFolders: this._context.workspaceFolders?.map((folder) => ({ ...folder })),
      activeWorkspacePath: this._context.activeWorkspacePath,
      activeFile: activeFile
        ? {
            path: activeFile.path,
            relativePath: activeFile.relativePath,
            language: activeFile.language,
          }
        : null,
      selection: this._context.selection
        ? {
            startLine: this._context.selection.startLine,
            endLine: this._context.selection.endLine,
          }
        : null,
      editorText: this._context.editorText ? { ...this._context.editorText } : null,
    };
  }

  private getDiagnosticsSourceKey() {
    const uri = vscode.window.activeTextEditor?.document.uri.toString();
    const editor = vscode.window.activeTextEditor;
    return uri ? JSON.stringify([this._context.workspacePath, uri, editor?.selection]) : null;
  }

  private emitContextIfChanged() {
    if (areEditorContextsEqual(this._context, this._lastEmittedContextSnapshot)) return;
    this._lastEmittedContextSnapshot = cloneEditorContext(this._context);
    this.onChange(this._context);
  }

  async readFile(path: string, options?: WorkspaceResolutionOptions): Promise<string | null> {
    try {
      const resolved = await this.resolveWorkspaceUri(path, options);
      // Read through the verified canonical path when there is one; `uri` keeps
      // the lexical spelling for display metadata only.
      const uri = resolved?.verifiedUri ?? resolved?.uri;
      if (!uri) return null;
      const doc = await vscode.workspace.openTextDocument(uri);
      return doc.getText();
    } catch (err) {
      logger.error(`Failed to read file ${path}:`, err);
      return null;
    }
  }

  async resolvePath(
    path: string,
    options?: WorkspaceResolutionOptions
  ): Promise<{ path: string; relativePath: string; type: 'file' | 'directory' } | null> {
    try {
      const resolved = await this.resolveWorkspaceUri(path, options);
      const lexicalUri = resolved?.uri;
      const uri = resolved?.verifiedUri ?? lexicalUri;
      if (!uri || !lexicalUri) return null;

      const stat = await vscode.workspace.fs.stat(uri);
      return {
        path: uri.fsPath,
        relativePath: getRelativePath(lexicalUri, resolved?.workspaceFolder),
        type: stat.type & vscode.FileType.Directory ? 'directory' : 'file',
      };
    } catch (err) {
      logger.error(`Failed to resolve file path ${path}:`, err);
      return null;
    }
  }

  async openPath(
    path: string,
    options?: {
      line?: number;
      kind?: 'auto' | 'file' | 'directory';
      view?: 'diff';
      workspaceDirectory?: string;
    }
  ): Promise<'opened' | 'unavailable'> {
    try {
      const input = path.trim();
      if (
        !isAbsolute(input) &&
        options?.workspaceDirectory &&
        !this.getOpenWorkspaceFolder(options.workspaceDirectory)
      ) {
        return 'unavailable';
      }
      let resolved = await this.resolveWorkspaceUri(path, {
        allowMissing: options?.view === 'diff',
        workspaceDirectory: options?.workspaceDirectory,
      });
      if (!resolved && options?.view !== 'diff') {
        const basenameOnly = !isAbsolute(input) && !/[\\/]/.test(input);
        const missingAbsolute = isAbsolute(input);
        const filename = basenameOnly
          ? input
          : missingAbsolute
            ? input.split(/[\\/]/).at(-1) || ''
            : '';
        if (/^[\w.@+-]+$/.test(filename)) {
          const workspaceFolder =
            !isAbsolute(input) && options?.workspaceDirectory
              ? this.getOpenWorkspaceFolder(options.workspaceDirectory)
              : undefined;
          const matches = await vscode.workspace.findFiles(
            workspaceFolder
              ? new vscode.RelativePattern(workspaceFolder, `**/${filename}`)
              : `**/${filename}`,
            null,
            2
          );
          const parentDirectory = missingAbsolute ? dirname(input) : '';
          const searchRoots = workspaceFolder
            ? [workspaceFolder.uri]
            : parentDirectory && parentDirectory !== parse(parentDirectory).root
              ? [vscode.Uri.file(parentDirectory)]
              : undefined;
          let uri =
            matches.length === 1
              ? matches[0]
              : matches.length === 0
                ? await this.findUniqueWorkspaceFile(filename, searchRoots)
                : undefined;
          if (!uri && matches.length === 0 && parentDirectory) {
            const localPath = await this.findUniqueLocalFile(parentDirectory, filename);
            if (localPath) uri = vscode.Uri.file(localPath);
          }
          if (uri) {
            resolved = { uri, workspaceFolder: vscode.workspace.getWorkspaceFolder(uri) };
          }
        }
      }
      const uri = resolved?.uri;
      if (!uri) {
        logger.warn(`Could not resolve file path: ${path}`);
        return 'unavailable';
      }

      if (options?.view === 'diff') {
        if (await hasGitChange(uri)) {
          const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
          await vscode.commands.executeCommand('git.openChange', uri);
          const currentTab = vscode.window.tabGroups.activeTabGroup.activeTab;
          if (
            currentTab !== activeTab ||
            (currentTab?.input instanceof vscode.TabInputTextDiff &&
              isSameWorkspacePath(currentTab.input.modified.fsPath, uri.fsPath))
          ) {
            return 'opened';
          }
        }
      }

      const stat = await vscode.workspace.fs.stat(uri);
      const shouldRevealDirectory =
        options?.kind === 'directory' || Boolean(stat.type & vscode.FileType.Directory);
      if (shouldRevealDirectory) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
        return 'opened';
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      if (options?.line !== undefined && options.line >= 1) {
        const position = new vscode.Position(options.line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter
        );
      }
      return 'opened';
    } catch (err) {
      logger.error(`Failed to open file ${path}:`, err);
      return 'unavailable';
    }
  }

  private async findUniqueWorkspaceFile(
    filename: string,
    searchRoots?: vscode.Uri[]
  ): Promise<vscode.Uri | undefined> {
    const ignoredDirectories = new Set([
      '.git',
      '.next',
      '.turbo',
      'build',
      'coverage',
      'dist',
      'node_modules',
      'out',
    ]);
    const pending =
      searchRoots ?? (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri);
    let match: vscode.Uri | undefined;
    let visitedEntries = 0;

    while (pending.length > 0) {
      const directory = pending.shift()!;
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(directory);
      } catch {
        continue;
      }

      visitedEntries += entries.length;
      if (visitedEntries > 20_000) return undefined;
      for (const [name, type] of entries) {
        const uri = vscode.Uri.joinPath(directory, name);
        if (type & vscode.FileType.Directory) {
          if (!ignoredDirectories.has(name)) pending.push(uri);
          continue;
        }
        if (name !== filename) continue;
        if (match) return undefined;
        match = uri;
      }
    }

    return match;
  }

  private async findUniqueLocalFile(
    rootDirectory: string,
    filename: string
  ): Promise<string | undefined> {
    const ignoredDirectories = new Set([
      '.git',
      '.next',
      '.turbo',
      'build',
      'coverage',
      'dist',
      'node_modules',
      'out',
    ]);
    const pending = [rootDirectory];
    let match: string | undefined;
    let visitedEntries = 0;

    while (pending.length > 0) {
      const directory = pending.shift()!;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }

      visitedEntries += entries.length;
      if (visitedEntries > 20_000) return undefined;
      for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) pending.push(entryPath);
          continue;
        }
        if (entry.name !== filename) continue;
        if (match) return undefined;
        match = entryPath;
      }
    }

    return match;
  }

  private async resolveWorkspaceUri(
    rawPath: string,
    options?: WorkspaceResolutionOptions
  ): Promise<{
    uri: vscode.Uri;
    workspaceFolder?: vscode.WorkspaceFolder;
    /**
     * Canonical path that containment was actually verified against. Restricted
     * reads must open this rather than `uri`, or a symlink swapped between the
     * check and the read would serve a file that was never verified.
     */
    verifiedUri?: vscode.Uri;
  } | null> {
    const allowMissing = options?.allowMissing === true;
    const restrictToWorkspace = options?.restrictToWorkspace === true;
    const allowSiblingWorkspaceFolders = options?.allowSiblingWorkspaceFolders === true;
    const input = rawPath.trim();
    if (!input) return null;
    if (restrictToWorkspace && hasRawParentTraversal(input)) return null;

    const shouldUseRequestedWorkspace = !isAbsolute(input) || restrictToWorkspace;
    const requestedWorkspaceFolder =
      shouldUseRequestedWorkspace && options?.workspaceDirectory
        ? this.getOpenWorkspaceFolder(options.workspaceDirectory)
        : undefined;
    if (shouldUseRequestedWorkspace && options?.workspaceDirectory && !requestedWorkspaceFolder) {
      return null;
    }

    if (isAbsolute(input)) {
      const uri = vscode.Uri.file(input);
      if (allowMissing) {
        const workspaceFolder =
          (restrictToWorkspace && !allowSiblingWorkspaceFolders
            ? requestedWorkspaceFolder
            : undefined) ?? vscode.workspace.getWorkspaceFolder(uri);
        if (!restrictToWorkspace) return workspaceFolder ? { uri, workspaceFolder } : { uri };
        const verifiedUri = await resolveInsideWorkspace(uri, workspaceFolder);
        return verifiedUri ? { uri, workspaceFolder, verifiedUri } : null;
      }
      try {
        await vscode.workspace.fs.stat(uri);
        const workspaceFolder =
          (restrictToWorkspace && !allowSiblingWorkspaceFolders
            ? requestedWorkspaceFolder
            : undefined) ?? vscode.workspace.getWorkspaceFolder(uri);
        if (!restrictToWorkspace) return workspaceFolder ? { uri, workspaceFolder } : { uri };
        const verifiedUri = await resolveInsideWorkspace(uri, workspaceFolder);
        return verifiedUri ? { uri, workspaceFolder, verifiedUri } : null;
      } catch {
        return null;
      }
    }

    const folders = requestedWorkspaceFolder
      ? [
          requestedWorkspaceFolder,
          ...(allowSiblingWorkspaceFolders
            ? this.getWorkspaceFoldersInResolutionOrder().filter(
                (folder) =>
                  !isSameWorkspacePath(folder.uri.fsPath, requestedWorkspaceFolder.uri.fsPath)
              )
            : []),
        ]
      : this.getWorkspaceFoldersInResolutionOrder();
    const resolved = resolveWorkspaceRelativePath(input, folders);
    if (!resolved) return null;

    const relativePath = normalizeRelativeWorkspacePath(resolved.relativePath);
    if (!relativePath) return null;
    const resolutionOrder = resolved.workspaceFolder
      ? [
          resolved.workspaceFolder,
          ...folders.filter((folder) => folder.uri.fsPath !== resolved.workspaceFolder?.uri.fsPath),
        ]
      : folders;

    for (const folder of resolutionOrder) {
      const candidate = vscode.Uri.file(join(folder.uri.fsPath, relativePath));
      try {
        await vscode.workspace.fs.stat(candidate);
        if (
          !isSameWorkspacePath(
            vscode.workspace.getWorkspaceFolder(candidate)?.uri.fsPath,
            folder.uri.fsPath
          )
        ) {
          continue;
        }
        if (!restrictToWorkspace) return { uri: candidate, workspaceFolder: folder };
        const verifiedUri = await resolveInsideWorkspace(candidate, folder);
        if (!verifiedUri) continue;
        return { uri: candidate, workspaceFolder: folder, verifiedUri };
      } catch {}
    }

    if (allowMissing && resolutionOrder[0]) {
      // Nothing to canonicalize for a path that does not exist, so a restricted
      // caller gets no answer rather than an unverified one.
      if (restrictToWorkspace) return null;
      return {
        uri: vscode.Uri.file(join(resolutionOrder[0].uri.fsPath, relativePath)),
        workspaceFolder: resolutionOrder[0],
      };
    }

    return null;
  }

  dispose() {
    if (this.terminalHistorySaveTimer) {
      clearTimeout(this.terminalHistorySaveTimer);
      this.terminalHistorySaveTimer = null;
      void this.saveTerminalHistory();
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.diagnosticsDebounceTimer) clearTimeout(this.diagnosticsDebounceTimer);
    if (this.activeEditorSettleTimer) clearTimeout(this.activeEditorSettleTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  private getWorkspaceFoldersInResolutionOrder(): vscode.WorkspaceFolder[] {
    const folders = Array.from(vscode.workspace.workspaceFolders || []);
    const preferredPath = this.getPreferredWorkspacePath();
    if (!preferredPath) return folders;

    const preferredFolder = folders.find((folder) => folder.uri.fsPath === preferredPath);
    if (!preferredFolder) return folders;
    return [preferredFolder, ...folders.filter((folder) => folder.uri.fsPath !== preferredPath)];
  }

  private getOpenWorkspaceFolder(path: string): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.find((folder) =>
      isSameWorkspacePath(folder.uri.fsPath, path)
    );
  }

  private getPreferredWorkspacePath(): string | null {
    if (this.selectedWorkspacePath) {
      const selectedFolder = this.getOpenWorkspaceFolder(this.selectedWorkspacePath);
      if (selectedFolder) return selectedFolder.uri.fsPath;
      this.selectedWorkspacePath = null;
      void this.workspaceState?.update(ContextProvider.SELECTED_WORKSPACE_KEY, undefined);
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    if (activeFolder) return activeFolder.uri.fsPath;

    const fallbackFolder = vscode.workspace.workspaceFolders?.[0];
    return fallbackFolder?.uri.fsPath || null;
  }

  private createEditorTextContext(
    editor: vscode.TextEditor,
    path: string | null,
    relativePath: string
  ): EditorTextContext | null {
    const { document, selection } = editor;
    if (!selection.isEmpty && (document.isDirty || document.isUntitled)) {
      const text = document.getText(selection);
      const truncated = text.length > ContextProvider.MAX_SELECTION_CHARACTERS;
      return {
        kind: 'selection',
        path,
        relativePath,
        language: document.languageId,
        range: {
          startLine: selection.start.line + 1,
          endLine: selection.end.line + (selection.end.character === 0 ? 0 : 1),
        },
        text: text.slice(0, ContextProvider.MAX_SELECTION_CHARACTERS),
        truncated,
      };
    }
    if (!document.isDirty) return null;

    const halfWindow = Math.floor(ContextProvider.MAX_DIRTY_BUFFER_LINES / 2);
    const startLine = Math.max(0, selection.active.line - halfWindow);
    const endLine = Math.min(
      document.lineCount - 1,
      startLine + ContextProvider.MAX_DIRTY_BUFFER_LINES - 1
    );
    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
    const text = document.getText(range);
    const truncated =
      startLine > 0 ||
      endLine < document.lineCount - 1 ||
      text.length > ContextProvider.MAX_DIRTY_BUFFER_CHARACTERS;
    return {
      kind: 'dirty-buffer',
      path,
      relativePath,
      language: document.languageId,
      range: { startLine: startLine + 1, endLine: endLine + 1 },
      text: text.slice(0, ContextProvider.MAX_DIRTY_BUFFER_CHARACTERS),
      truncated,
    };
  }
}

function hasRawParentTraversal(path: string): boolean {
  return path.replace(/\\/g, '/').split('/').includes('..');
}

function comparePositions(a: vscode.Position, b: vscode.Position): number {
  return a.line - b.line || (a.character ?? 0) - (b.character ?? 0);
}

type GitChange = { uri: vscode.Uri };
type GitRepository = {
  state: {
    workingTreeChanges: GitChange[];
    indexChanges: GitChange[];
    mergeChanges: GitChange[];
  };
};
type GitExtension = {
  getAPI(version: 1): { repositories: GitRepository[] };
};

async function hasGitChange(uri: vscode.Uri): Promise<boolean> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) return false;

  const git = extension.isActive ? extension.exports : await extension.activate();
  return git
    .getAPI(1)
    .repositories.some((repository) =>
      [
        ...repository.state.workingTreeChanges,
        ...repository.state.indexChanges,
        ...repository.state.mergeChanges,
      ].some((change) => change.uri.fsPath === uri.fsPath)
    );
}

/**
 * Containment by canonical path. `vscode.workspace.getWorkspaceFolder` matches
 * lexically, so a symlink inside the workspace that points outside it - say
 * `<workspace>/vendor -> /etc` - is reported as workspace-owned. Resolving both
 * sides first closes that.
 */
async function resolveInsideWorkspace(
  uri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined
): Promise<vscode.Uri | null> {
  if (!workspaceFolder) return null;
  try {
    const [target, root] = await Promise.all([
      realpath(uri.fsPath),
      realpath(workspaceFolder.uri.fsPath),
    ]);
    const relativeToRoot = relative(root, target);
    // `startsWith('..')` alone would also reject a contained `..config` entry.
    const escapesRoot =
      relativeToRoot === '..' ||
      relativeToRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativeToRoot);
    if (relativeToRoot !== '' && escapesRoot) return null;
    return vscode.Uri.file(target);
  } catch (err) {
    logger.warn(
      `Refusing ${uri.fsPath}: could not verify it resolves inside the workspace (${
        err instanceof Error ? err.message : String(err)
      })`
    );
    return null;
  }
}

type ContextSnapshot = Pick<
  EditorContext,
  | 'workspacePath'
  | 'workspaceFolders'
  | 'activeWorkspacePath'
  | 'activeFile'
  | 'selection'
  | 'editorText'
>;

function areContextSnapshotsEqual(a: ContextSnapshot | null, b: ContextSnapshot | null) {
  return (
    a?.workspacePath === b?.workspacePath &&
    JSON.stringify(a?.workspaceFolders ?? []) === JSON.stringify(b?.workspaceFolders ?? []) &&
    a?.activeWorkspacePath === b?.activeWorkspacePath &&
    areActiveFilesEqual(a?.activeFile ?? null, b?.activeFile ?? null) &&
    areSelectionsEqual(a?.selection ?? null, b?.selection ?? null) &&
    areEditorTextContextsEqual(a?.editorText ?? null, b?.editorText ?? null)
  );
}

function areEditorContextsEqual(a: EditorContext, b: EditorContext | null) {
  return (
    a.workspacePath === b?.workspacePath &&
    JSON.stringify(a.workspaceFolders ?? []) === JSON.stringify(b?.workspaceFolders ?? []) &&
    a.activeWorkspacePath === b?.activeWorkspacePath &&
    areActiveFilesEqual(a.activeFile, b?.activeFile ?? null) &&
    areSelectionsEqual(a.selection, b?.selection ?? null) &&
    areEditorTextContextsEqual(a.editorText ?? null, b?.editorText ?? null) &&
    a.diagnosticsTotal === b?.diagnosticsTotal &&
    JSON.stringify(a.diagnosticCounts) === JSON.stringify(b?.diagnosticCounts) &&
    areDiagnosticsEqual(a.diagnostics, b?.diagnostics ?? null)
  );
}

function areActiveFilesEqual(a: EditorContext['activeFile'], b: EditorContext['activeFile']) {
  return a?.path === b?.path && a?.relativePath === b?.relativePath && a?.language === b?.language;
}

function areSelectionsEqual(a: EditorContext['selection'], b: EditorContext['selection']) {
  return a?.startLine === b?.startLine && a?.endLine === b?.endLine;
}

function areEditorTextContextsEqual(
  a: EditorContext['editorText'],
  b: EditorContext['editorText']
) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function areDiagnosticsEqual(
  a: EditorContext['diagnostics'],
  b: EditorContext['diagnostics'] | null
) {
  if (!b || a.length !== b.length) return false;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left?.path !== right?.path ||
      left?.severity !== right?.severity ||
      left?.message !== right?.message ||
      JSON.stringify(left) !== JSON.stringify(right)
    ) {
      return false;
    }
  }

  return true;
}

function cloneEditorContext(context: EditorContext): EditorContext {
  return {
    workspacePath: context.workspacePath,
    workspaceFolders: context.workspaceFolders?.map((folder) => ({ ...folder })),
    activeWorkspacePath: context.activeWorkspacePath,
    activeFile: context.activeFile ? { ...context.activeFile } : null,
    selection: context.selection ? { ...context.selection } : null,
    editorText: context.editorText ? { ...context.editorText } : null,
    diagnostics: context.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    diagnosticsTotal: context.diagnosticsTotal,
    diagnosticCounts: context.diagnosticCounts ? { ...context.diagnosticCounts } : undefined,
  };
}

function withTimeout<T>(promise: Thenable<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// CSI, OSC and two-character escape sequences, as written by shells.
const TERMINAL_ESCAPE_PATTERN =
  // oxlint-disable-next-line no-control-regex -- Matching the ESC and BEL control bytes is the point.
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

function stripTerminalEscapes(data: string): string {
  return data.replace(TERMINAL_ESCAPE_PATTERN, '');
}

/** Terminal selections drop trailing spaces and use LF, whatever the output wrote. */
function normalizeTerminalLines(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .join('\n');
}

type SavedTerminalOutput = { text: string; commands: string[]; savedAt: number };
