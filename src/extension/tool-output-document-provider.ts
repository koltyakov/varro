/* oxlint-disable anti-slop/no-known-value-widening -- The document registry intentionally exposes VS Code's content-provider contract. */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

const SCHEME = 'varro-tool-output';

/**
 * Backs read-only editor tabs for generated text, including tool output and
 * reports. A virtual scheme keeps each tab named and leaves the buffer
 * non-dirty, so closing it never prompts to save.
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

  async open(payload: {
    content: string;
    title: string;
    language?: string;
    preview?: boolean;
    show?: boolean;
  }): Promise<vscode.Uri | undefined> {
    if (this.disposed) return undefined;

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
      if (payload.show ?? true) {
        await vscode.window.showTextDocument(document, { preview: payload.preview ?? true });
      }
      return uri;
    } catch {
      this.contents.delete(uri.toString());
      return undefined;
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
