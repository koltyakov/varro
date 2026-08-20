/* oxlint-disable anti-slop/no-runtime-typeof -- URI and response values are validated before rendering virtual documents. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Parsed URI JSON is shape-checked before use. */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { FileDiff } from '../shared/opencode-types';
import type { OpenCodeServer } from './server';

const SCHEME = 'varro-session-diff';

export class SessionDiffDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly disposables: vscode.Disposable[];
  private disposed = false;

  constructor(private readonly server: Pick<OpenCodeServer, 'request'>) {
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

  async open(sessionID: string, requestedPath: string): Promise<boolean> {
    if (this.disposed) return false;
    try {
      const value = await this.server.request(
        'GET',
        `/session/${encodeURIComponent(sessionID)}/diff`
      );
      if (this.disposed || !Array.isArray(value)) return false;
      const diff = findFileDiff(value, requestedPath);
      if (!diff || typeof diff.before !== 'string' || typeof diff.after !== 'string') return false;

      const id = randomUUID();
      const filename = basename(requestedPath.replace(/\\/g, '/')) || 'file';
      const beforeUri = vscode.Uri.from({ scheme: SCHEME, path: `/${id}/before/${filename}` });
      const afterUri = vscode.Uri.from({ scheme: SCHEME, path: `/${id}/after/${filename}` });
      this.contents.set(beforeUri.toString(), diff.before);
      this.contents.set(afterUri.toString(), diff.after);
      try {
        await vscode.commands.executeCommand(
          'vscode.diff',
          beforeUri,
          afterUri,
          `${filename} (Varro session)`,
          { preview: true }
        );
        return true;
      } catch {
        this.contents.delete(beforeUri.toString());
        this.contents.delete(afterUri.toString());
        return false;
      }
    } catch {
      return false;
    }
  }

  dispose() {
    this.disposed = true;
    this.contents.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function findFileDiff(value: unknown[], requestedPath: string): FileDiff | null {
  const normalizedRequested = normalizePath(requestedPath);
  const matches = value.filter((item): item is FileDiff => {
    if (!item || typeof item !== 'object') return false;
    const file = (item as FileDiff).file;
    if (typeof file !== 'string') return false;
    const normalizedFile = normalizePath(file);
    return (
      normalizedFile === normalizedRequested ||
      normalizedRequested.endsWith(`/${normalizedFile}`) ||
      normalizedFile.endsWith(`/${normalizedRequested}`)
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

function normalizePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}
