import * as vscode from 'vscode';
import { isAbsolute, join } from 'path';
import type { EditorContext } from '../shared/protocol';
import { logger } from './logger';
import {
  getRelativePath,
  normalizeRelativeWorkspacePath,
  resolveWorkspaceRelativePath,
} from './util/path';

export class ContextProvider implements vscode.Disposable {
  private static readonly TERMINAL_COPY_DELAY_MS = 40;
  private static readonly TERMINAL_COPY_MAX_ATTEMPTS = 5;
  private static readonly TERMINAL_COPY_TIMEOUT_MS = 1500;
  private static readonly ACTIVE_EDITOR_SETTLE_DELAY_MS = 60;
  private disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private diagnosticsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private activeEditorSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private _context: EditorContext = {
    workspacePath: null,
    activeFile: null,
    selection: null,
    diagnostics: [],
  };
  private _terminalSelection: { text: string; terminalName: string } | null = null;
  private _lastContextKey: string | null = null;
  private _lastEmittedContextKey: string | null = null;
  private _lastDiagnosticsSourceKey: string | null = null;
  private onChange: (ctx: EditorContext) => void;

  constructor(onChange: (ctx: EditorContext) => void) {
    this.onChange = onChange;

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeTextEditorSelection(() => this.debouncedUpdate()),
      vscode.languages.onDidChangeDiagnostics((event) => {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (!activeUri || event.uris.some((uri) => uri.toString() === activeUri.toString())) {
          this.debouncedDiagnosticsUpdate();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('varro.context')) {
          this.update();
        }
      })
    );

    this.update();
  }

  get context(): EditorContext {
    return this._context;
  }

  get terminalSelection() {
    return this._terminalSelection;
  }

  async captureTerminalSelection(): Promise<
    { ok: true; terminalName: string } | { ok: false; reason: 'no-terminal' | 'empty-selection' }
  > {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      return { ok: false, reason: 'no-terminal' };
    }

    const previousClipboard = await withTimeout(
      vscode.env.clipboard.readText(),
      ContextProvider.TERMINAL_COPY_TIMEOUT_MS,
      'Timed out reading clipboard before terminal selection capture'
    );
    let selectionText = '';
    let clipboardChanged = false;

    try {
      await withTimeout(
        vscode.commands.executeCommand('workbench.action.terminal.copySelection'),
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
        if (selectionText.trim().length > 0) {
          clipboardChanged = selectionText !== previousClipboard;
          break;
        }
      }
    } finally {
      if (clipboardChanged) {
        try {
          await vscode.env.clipboard.writeText(previousClipboard);
        } catch {
          logger.warn('Failed to restore clipboard after terminal selection capture');
        }
      }
    }

    if (!selectionText.trim()) {
      return { ok: false, reason: 'empty-selection' };
    }

    this._terminalSelection = {
      text: selectionText,
      terminalName: terminal.name,
    };
    return { ok: true, terminalName: terminal.name };
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
    const config = getContextConfig();

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.activeEditorSettleTimer = setTimeout(() => {
        this.activeEditorSettleTimer = null;
        if (vscode.window.activeTextEditor) {
          this.update();
          return;
        }
        this._context.activeFile = null;
        this._context.selection = null;
        const nextKey = this.getContextKey();
        if (nextKey === this._lastContextKey) return;
        this._lastContextKey = nextKey;
        this.refreshDiagnosticsIfNeeded();
      }, ContextProvider.ACTIVE_EDITOR_SETTLE_DELAY_MS);
      return;
    }

    const doc = editor.document;
    if (doc.isUntitled || doc.uri.scheme === 'untitled') {
      this._context.activeFile = null;
      this._context.selection = null;
      const nextKey = this.getContextKey();
      if (nextKey === this._lastContextKey) return;
      this._lastContextKey = nextKey;
      this.refreshDiagnosticsIfNeeded();
      return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const relativePath = getRelativePath(doc.uri, workspaceFolder);

    this._context.activeFile = config.autoAttachFile
      ? {
          path: doc.uri.fsPath,
          relativePath,
          language: doc.languageId,
        }
      : null;

    const selection = editor.selection;
    if (config.autoAttachSelection && !selection.isEmpty) {
      this._context.selection = {
        startLine: selection.start.line + 1,
        endLine: selection.end.line + 1,
      };
    } else {
      this._context.selection = null;
    }

    const nextKey = this.getContextKey();
    if (nextKey === this._lastContextKey) return;
    this._lastContextKey = nextKey;

    this.emitContextIfChanged();
    this.refreshDiagnosticsIfNeeded();
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
      this.emitContextIfChanged();
      return;
    }

    const diags = vscode.languages.getDiagnostics(editor.document.uri);
    this._context.diagnostics = diags.slice(0, 20).map((d) => ({
      path: editor.document.uri.fsPath,
      severity:
        d.severity === vscode.DiagnosticSeverity.Error
          ? 'error'
          : d.severity === vscode.DiagnosticSeverity.Warning
            ? 'warning'
            : 'info',
      message: d.message,
      line: d.range.start.line + 1,
    }));
    this.emitContextIfChanged();
  }

  private getContextKey() {
    return JSON.stringify({
      workspacePath: this._context.workspacePath,
      activeFile: this._context.activeFile,
      selection: this._context.selection,
    });
  }

  private getEmittedContextKey() {
    const activeFile = this._context.activeFile;
    const selection = this._context.selection;
    return JSON.stringify({
      workspacePath: this._context.workspacePath,
      activeFile: activeFile
        ? {
            path: activeFile.path,
            relativePath: activeFile.relativePath,
            language: activeFile.language,
          }
        : null,
      selection,
      diagnostics: this._context.diagnostics,
    });
  }

  private getDiagnosticsSourceKey() {
    return vscode.window.activeTextEditor?.document.uri.toString() || null;
  }

  private emitContextIfChanged() {
    const nextKey = this.getEmittedContextKey();
    if (nextKey === this._lastEmittedContextKey) return;
    this._lastEmittedContextKey = nextKey;
    this.onChange(this._context);
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const resolved = await this.resolveWorkspaceUri(path);
      const uri = resolved?.uri;
      if (!uri) return null;
      const doc = await vscode.workspace.openTextDocument(uri);
      return doc.getText();
    } catch (err) {
      logger.error(`Failed to read file ${path}:`, err);
      return null;
    }
  }

  async openPath(path: string, options?: { line?: number; kind?: 'auto' | 'file' | 'directory' }) {
    try {
      const resolved = await this.resolveWorkspaceUri(path);
      const uri = resolved?.uri;
      if (!uri) {
        logger.warn(`Could not resolve file path: ${path}`);
        return;
      }

      const stat = await vscode.workspace.fs.stat(uri);
      const shouldRevealDirectory =
        options?.kind === 'directory' || Boolean(stat.type & vscode.FileType.Directory);
      if (shouldRevealDirectory) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
        return;
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
    } catch (err) {
      logger.error(`Failed to open file ${path}:`, err);
    }
  }

  private async resolveWorkspaceUri(
    rawPath: string
  ): Promise<{ uri: vscode.Uri; workspaceFolder?: vscode.WorkspaceFolder } | null> {
    const input = rawPath.trim();
    if (!input) return null;

    if (isAbsolute(input)) {
      const uri = vscode.Uri.file(input);
      try {
        await vscode.workspace.fs.stat(uri);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        return workspaceFolder ? { uri, workspaceFolder } : null;
      } catch {
        return null;
      }
    }

    const folders = this.getWorkspaceFoldersInResolutionOrder();
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
        if (vscode.workspace.getWorkspaceFolder(candidate)?.uri.fsPath === folder.uri.fsPath) {
          return { uri: candidate, workspaceFolder: folder };
        }
      } catch {}
    }

    return null;
  }

  dispose() {
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

  private getPreferredWorkspacePath(): string | null {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    if (activeFolder) return activeFolder.uri.fsPath;

    const fallbackFolder = vscode.workspace.workspaceFolders?.[0];
    return fallbackFolder?.uri.fsPath || null;
  }
}

function getContextConfig() {
  const config = vscode.workspace.getConfiguration('varro.context');
  return {
    autoAttachFile: config.get<boolean>('autoAttachFile', true),
    autoAttachSelection: config.get<boolean>('autoAttachSelection', true),
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
