/* oxlint-disable anti-slop/no-known-value-widening -- The document registry intentionally exposes VS Code's content-provider contract. */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

const SCHEME = 'varro-tool-output';

/**
 * Backs read-only editor tabs for tool text that the chat view clamps rather
 * than scrolling in place. A virtual scheme (instead of an untitled document)
 * keeps the tab named after the tool and leaves the buffer non-dirty, so
 * closing it never prompts to save.
 */
export class ToolOutputDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly disposables: vscode.Disposable[];
  private disposed = false;

  constructor() {
    this.disposables = [
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme === SCHEME) this.contents.delete(document.uri.toString());
      }),
    ];
  }

  provideTextDocumentContent(uri: vscode.Uri) {
    return this.contents.get(uri.toString()) ?? '';
  }

  async open(payload: { content: string; title: string; language?: string }): Promise<boolean> {
    if (this.disposed) return false;

    // Tool prompts and results are written as Markdown, so that is the default
    // rather than plaintext; callers with something more specific (a bash
    // command, a JSON blob) pass their own language.
    const language = payload.language ?? 'markdown';
    // The last path segment becomes the tab label, so the extension carries the
    // language hint for editors that infer highlighting from the filename.
    const filename = toFilename(payload.title, language);
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${randomUUID()}/${filename}` });
    this.contents.set(uri.toString(), payload.content);

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(document, language);
      await vscode.window.showTextDocument(document, { preview: true });
      return true;
    } catch {
      this.contents.delete(uri.toString());
      return false;
    }
  }

  dispose() {
    this.disposed = true;
    this.contents.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

const EXTENSION_BY_LANGUAGE: Record<string, string> = {
  json: 'json',
  markdown: 'md',
  shellscript: 'sh',
  xml: 'xml',
};

function toFilename(title: string, language?: string) {
  // Path separators and control characters would split the URI path or corrupt
  // the tab label; everything else stays so the tab reads like the tool call.
  const base = title.replace(/[\\/\r\n\t]+/g, ' ').trim() || 'tool output';
  const extension = language ? EXTENSION_BY_LANGUAGE[language] : undefined;
  const suffix = extension ? `.${extension}` : '.txt';
  return `${base.slice(0, 80)}${suffix}`;
}
