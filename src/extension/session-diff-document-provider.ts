/* oxlint-disable anti-slop/no-runtime-typeof -- URI and response values are validated before rendering virtual documents. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Parsed URI JSON is shape-checked before use. */
import { randomUUID } from 'node:crypto';
import { basename, posix } from 'node:path';
import * as vscode from 'vscode';
import type { FileDiff } from '../shared/opencode-types';
import {
  getRelativePathWithinWorkspace,
  isAbsoluteWorkspacePath,
  isSameWorkspacePath,
  normalizeWorkspaceIdentity,
} from '../shared/workspace-path';
import type { OpenCodeServer } from './server';
import { assertSessionInCurrentWorkspace } from './session-workspace';

const SCHEME = 'varro-session-diff';
type SessionDiffOpenResult = 'opened' | 'unavailable' | 'forbidden';
type SessionDirectoryAuthorizer = (
  sessionID: string,
  directory: string
) => boolean | Promise<boolean>;

export class SessionDiffDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly disposables: vscode.Disposable[];
  private disposed = false;

  constructor(private readonly server: Pick<OpenCodeServer, 'getWorkspaceCwd' | 'request'>) {
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

  async open(
    sessionID: string,
    requestedPath: string,
    requestedDirectory?: string,
    server: Pick<OpenCodeServer, 'getWorkspaceCwd' | 'request'> = this.server,
    authorizeDirectory?: SessionDirectoryAuthorizer
  ): Promise<SessionDiffOpenResult> {
    if (this.disposed) return 'unavailable';
    const endpointWorkspaceIdentity = normalizeWorkspaceIdentity(server.getWorkspaceCwd());
    const workspacePath = requestedDirectory ?? server.getWorkspaceCwd();
    const workspaceChanged = () =>
      Boolean(
        endpointWorkspaceIdentity &&
        normalizeWorkspaceIdentity(server.getWorkspaceCwd()) !== endpointWorkspaceIdentity
      );
    if (requestedDirectory && !isSameWorkspacePath(requestedDirectory, server.getWorkspaceCwd())) {
      try {
        if (!(await authorizeDirectory?.(sessionID, requestedDirectory)) || workspaceChanged()) {
          return 'forbidden';
        }
      } catch {
        return 'forbidden';
      }
    }
    let sessionDirectory: string | undefined;
    try {
      sessionDirectory = await assertSessionInCurrentWorkspace(
        server,
        sessionID,
        requestedDirectory
      );
    } catch {
      return 'forbidden';
    }
    try {
      const diffPath = `/session/${encodeURIComponent(sessionID)}/diff`;
      let value: unknown;
      if (requestedDirectory) {
        if (!sessionDirectory) return 'forbidden';
        value = await server.request('GET', diffPath, undefined, { directory: sessionDirectory });
      } else {
        value = await server.request('GET', diffPath);
      }
      if (workspaceChanged()) return 'forbidden';
      if (this.disposed || !Array.isArray(value)) return 'unavailable';
      const diff = findFileDiff(value, requestedPath, workspacePath);
      if (!diff || typeof diff.before !== 'string' || typeof diff.after !== 'string') {
        return 'unavailable';
      }

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
        return 'opened';
      } catch {
        this.contents.delete(beforeUri.toString());
        this.contents.delete(afterUri.toString());
        return workspaceChanged() ? 'forbidden' : 'unavailable';
      }
    } catch {
      return workspaceChanged() ? 'forbidden' : 'unavailable';
    }
  }

  dispose() {
    this.disposed = true;
    this.contents.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function findFileDiff(
  value: unknown[],
  requestedPath: string,
  workspacePath: string | undefined
): FileDiff | null {
  const normalizedRequested = normalizeDiffPath(requestedPath, workspacePath);
  if (!normalizedRequested) return null;
  const matches = value.filter((item): item is FileDiff => {
    if (!item || typeof item !== 'object') return false;
    const file = (item as FileDiff).file;
    if (typeof file !== 'string') return false;
    const normalizedFile = normalizeDiffPath(file, workspacePath);
    return normalizedFile === normalizedRequested;
  });
  return matches.length === 1 ? matches[0]! : null;
}

function normalizeDiffPath(value: string, workspacePath: string | undefined) {
  let relativePath = value;
  if (isAbsoluteWorkspacePath(value)) {
    const relative = getRelativePathWithinWorkspace(value, workspacePath);
    if (!relative || relative === '.') return null;
    relativePath = relative;
  }
  const normalized = posix.normalize(relativePath.replace(/\\/g, '/'));
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
    return null;
  }
  return isWindowsWorkspacePath(workspacePath) ? normalized.toLowerCase() : normalized;
}

function isWindowsWorkspacePath(value: string | undefined) {
  return !!value && (/^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)/.test(value));
}
