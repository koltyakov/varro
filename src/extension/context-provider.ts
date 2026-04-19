import * as vscode from 'vscode';
import type { EditorContext } from '../shared/protocol';
import { logger } from './logger';

export class ContextProvider implements vscode.Disposable {
  private static readonly TERMINAL_COPY_DELAY_MS = 40;
  private disposables: vscode.Disposable[] = [];
  private _context: EditorContext = {
    workspacePath: null,
    activeFile: null,
    selection: null,
    diagnostics: [],
  };
  private _terminalSelection: { text: string; terminalName: string } | null = null;
  private onChange: (ctx: EditorContext) => void;

  constructor(onChange: (ctx: EditorContext) => void) {
    this.onChange = onChange;

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeTextEditorSelection(() => this.update()),
      vscode.languages.onDidChangeDiagnostics(() => this.updateDiagnostics()),
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
    | { ok: true; terminalName: string }
    | { ok: false; reason: 'no-terminal' | 'empty-selection' }
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
        await vscode.env.clipboard.writeText(previousClipboard);
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

  private update() {
    const folders = vscode.workspace.workspaceFolders;
    this._context.workspacePath = folders && folders.length > 0 ? folders[0].uri.fsPath : null;

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._context.activeFile = null;
      this._context.selection = null;
      this.onChange(this._context);
      return;
    }

    const doc = editor.document;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const relativePath = workspaceFolder
      ? vscode.workspace.asRelativePath(doc.uri)
      : doc.uri.fsPath;

    this._context.activeFile = {
      path: doc.uri.fsPath,
      relativePath,
      language: doc.languageId,
      content: doc.getText(),
    };

    const selection = editor.selection;
    if (!selection.isEmpty) {
      this._context.selection = {
        text: editor.document.getText(selection),
        startLine: selection.start.line + 1,
        endLine: selection.end.line + 1,
      };
    } else {
      this._context.selection = null;
    }

    this.updateDiagnostics();
    this.onChange(this._context);
  }

  private updateDiagnostics() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._context.diagnostics = [];
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
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const uri = vscode.Uri.file(path);
      const doc = await vscode.workspace.openTextDocument(uri);
      return doc.getText();
    } catch (err) {
      logger.error(`Failed to read file ${path}:`, err);
      return null;
    }
  }

  async openFile(path: string, line?: number) {
    try {
      const uri = vscode.Uri.file(path);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      if (line !== undefined) {
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

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
