import * as vscode from 'vscode';
import { isAbsolute, join } from 'path';
import type { EditorContext } from '../shared/protocol';
import { logger } from './logger';

export class ContextProvider implements vscode.Disposable {
  private static readonly TERMINAL_COPY_DELAY_MS = 40;
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
  private onChange: (ctx: EditorContext) => void;

  constructor(onChange: (ctx: EditorContext) => void) {
    this.onChange = onChange;

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeTextEditorSelection(() => this.debouncedUpdate()),
      vscode.languages.onDidChangeDiagnostics(() => this.debouncedDiagnosticsUpdate()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.update())
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

    const previousClipboard = await vscode.env.clipboard.readText();
    let selectionText = '';
    let clipboardChanged = false;

    try {
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      await delay(ContextProvider.TERMINAL_COPY_DELAY_MS);
      selectionText = await vscode.env.clipboard.readText();
      clipboardChanged = selectionText !== previousClipboard;
    } finally {
      if (clipboardChanged) {
        try {
          await vscode.env.clipboard.writeText(previousClipboard);
        } catch {
          logger.warn('Failed to restore clipboard after terminal selection capture');
        }
      }
    }

    if (!clipboardChanged || !selectionText.trim()) {
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

    const folders = vscode.workspace.workspaceFolders;
    this._context.workspacePath = folders && folders.length > 0 ? folders[0].uri.fsPath : null;
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
        this.updateDiagnostics();
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
      this.updateDiagnostics();
      return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const relativePath = workspaceFolder
      ? vscode.workspace.asRelativePath(doc.uri)
      : doc.uri.fsPath;

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

    this.updateDiagnostics();
  }

  private updateDiagnostics() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._context.diagnostics = [];
      this.onChange(this._context);
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
    this.onChange(this._context);
  }

  private getContextKey() {
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
    });
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const uri = await this.resolveWorkspaceUri(path);
      if (!uri) return null;
      const doc = await vscode.workspace.openTextDocument(uri);
      return doc.getText();
    } catch (err) {
      logger.error(`Failed to read file ${path}:`, err);
      return null;
    }
  }

  async openFile(path: string, line?: number) {
    try {
      const uri = await this.resolveWorkspaceUri(path);
      if (!uri) {
        logger.warn(`Could not resolve file path: ${path}`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      if (line !== undefined && line >= 1) {
        const position = new vscode.Position(line - 1, 0);
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

  private async resolveWorkspaceUri(rawPath: string): Promise<vscode.Uri | null> {
    const input = rawPath.trim();
    if (!input) return null;

    if (isAbsolute(input)) {
      const uri = vscode.Uri.file(input);
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        return null;
      }
    }

    const relativePath = input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!relativePath) return null;

    for (const folder of vscode.workspace.workspaceFolders || []) {
      const candidate = vscode.Uri.file(join(folder.uri.fsPath, relativePath));
      try {
        await vscode.workspace.fs.stat(candidate);
        return candidate;
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
