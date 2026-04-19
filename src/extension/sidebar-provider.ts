import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import { resolve, join, basename, isAbsolute } from 'path';
import type {
  DroppedFile,
  ExtensionMessage,
  ServerStatus,
  WebviewMessage,
} from '../shared/protocol';
import type { ContextProvider } from './context-provider';
import type { OpenCodeServer } from './server';
import { logger } from './logger';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'opencode.chat';
  private view?: vscode.WebviewView;
  private contextProvider: ContextProvider;
  private server: OpenCodeServer;
  private _status: ServerStatus = { state: 'stopped' };
  private themeDisposable?: vscode.Disposable;
  private contextFiles: DroppedFile[] = [];
  private onContextFilesChanged?: () => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    contextProvider: ContextProvider,
    server: OpenCodeServer
  ) {
    this.contextProvider = contextProvider;
    this.server = server;

    this.server.on('status', (status: ServerStatus) => {
      this._status = status;
      this.post({ type: 'server/status', payload: status });
    });

    this.server.on('event', (event: unknown) => {
      this.post({
        type: 'server/event',
        payload: { type: 'event', ...(event as Record<string, unknown>) },
      });
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this.handleMessage(msg);
    });

    webviewView.webview.html = this.getHtml();

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postContext();
        this.post({ type: 'server/status', payload: this._status });
      }
    });

    this.themeDisposable?.dispose();
    this.themeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
      this.post({ type: 'theme/update', payload: { theme: this.currentTheme() } });
    });
  }

  private currentTheme(): 'dark' | 'light' {
    const k = vscode.window.activeColorTheme.kind;
    return k === vscode.ColorThemeKind.Dark || k === vscode.ColorThemeKind.HighContrast
      ? 'dark'
      : 'light';
  }

  handleMessage(msg: WebviewMessage) {
    switch (msg.type) {
      case 'ready':
        this.postContext();
        this.post({ type: 'server/status', payload: this._status });
        this.post({ type: 'theme/update', payload: { theme: this.currentTheme() } });
        break;
      case 'context/request':
        this.postContext();
        break;
      case 'files/drop':
        this.handleDroppedPaths(msg.payload.paths);
        break;
      case 'files/remove':
        this.removeContextFile(msg.payload.path);
        break;
      case 'files/clear':
        this.clearContextFiles();
        this.onContextFilesChanged?.();
        break;
      case 'files/pick':
        this.pickFiles();
        break;
      case 'file/read':
        this.contextProvider.readFile(msg.payload.path).then(() => {
          this.postContext();
        });
        break;
      case 'vscode/open':
        this.contextProvider.openFile(msg.payload.path, msg.payload.line);
        break;
      case 'vscode/diff':
        vscode.commands.executeCommand(
          'vscode.diff',
          vscode.Uri.parse(`opencode-diff://${msg.payload.path}/before`),
          vscode.Uri.parse(`opencode-diff://${msg.payload.path}/after`),
          `OpenCode: ${msg.payload.path}`
        );
        break;
      case 'api/request':
        this.handleApiRequest(msg.payload);
        break;
      case 'log':
        {
          const level = msg.payload.level || 'info';
          const line =
            `[webview] ${msg.payload.msg} ${msg.payload.data || ''} ${msg.payload.error || ''}`.trim();
          if (level === 'error') logger.error(line);
          else if (level === 'warn') logger.warn(line);
          else logger.info(line);
        }
        break;
    }
  }

  private async handleApiRequest(payload: {
    id: number;
    method: string;
    path: string;
    body?: unknown;
  }) {
    if (this._status.state !== 'running') {
      this.post({
        type: 'api/response',
        payload: { id: payload.id, error: 'Server is not running' },
      });
      return;
    }
    try {
      const data = await this.server.request(payload.method, payload.path, payload.body);
      this.post({ type: 'api/response', payload: { id: payload.id, data } });
    } catch (err) {
      this.post({
        type: 'api/response',
        payload: { id: payload.id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  post(msg: ExtensionMessage) {
    // oxlint-disable-next-line require-post-message-target-origin
    this.view?.webview.postMessage(msg);
  }

  async handleDroppedPaths(paths: string[]) {
    const dropped = await Promise.all(
      Array.from(new Set(paths)).map(async (path) => {
        try {
          const uri = await this.resolveDroppedUri(path);
          if (!uri) {
            throw new Error('Path is not part of the current workspace or does not exist');
          }
          const stat = await vscode.workspace.fs.stat(uri);
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          const relativePath = getDroppedRelativePath(uri, workspaceFolder);

          return {
            path: uri.fsPath,
            relativePath,
            type:
              stat.type & vscode.FileType.Directory ? ('directory' as const) : ('file' as const),
          };
        } catch (err) {
          logger.warn(
            `Ignoring dropped path ${path}: ${err instanceof Error ? err.message : String(err)}`
          );
          return null;
        }
      })
    );

    const normalized = dropped.filter(
      (item): item is { path: string; relativePath: string; type: 'file' | 'directory' } =>
        Boolean(item)
    );

    if (normalized.length > 0) {
      this.postDroppedFiles(normalized);
    }
  }

  private async resolveDroppedUri(rawPath: string): Promise<vscode.Uri | null> {
    const input = rawPath.trim();
    if (!input) return null;

    const absoluteUri = vscode.Uri.file(input);
    if (isAbsolute(input)) {
      try {
        await vscode.workspace.fs.stat(absoluteUri);
        return absoluteUri;
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

  setOnContextFilesChanged(fn: () => void) {
    this.onContextFilesChanged = fn;
  }

  removeContextFile(path: string) {
    this.contextFiles = this.contextFiles.filter((f) => f.path !== path);
    this.post({ type: 'files/removed', payload: { path } });
    this.onContextFilesChanged?.();
  }

  getContextFiles() {
    return this.contextFiles;
  }

  clearContextFiles() {
    this.contextFiles = [];
  }

  private async pickFiles() {
    const result = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: true,
      title: 'Add files to context',
    });
    if (!result || result.length === 0) return;

    const files = await Promise.all(
      result.map(async (uri) => {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          const relativePath = getDroppedRelativePath(uri, workspaceFolder);
          return {
            path: uri.fsPath,
            relativePath,
            type:
              stat.type & vscode.FileType.Directory
                ? ('directory' as const)
                : ('file' as const),
          };
        } catch {
          return null;
        }
      })
    );

    const valid = files.filter(
      (f): f is { path: string; relativePath: string; type: 'file' | 'directory' } => f !== null
    );
    if (valid.length > 0) {
      this.postDroppedFiles(valid);
    }
  }

  private postContext() {
    this.post({ type: 'context/update', payload: this.contextProvider.context });
  }

  postDroppedFiles(
    files: Array<{ path: string; relativePath: string; type: 'file' | 'directory' }>
  ) {
    const next = files.filter(
      (file) => !this.contextFiles.find((existing) => existing.path === file.path)
    );
    if (next.length === 0) return;

    this.contextFiles.push(...next);
    this.post({ type: 'files/dropped', payload: next });
    this.onContextFilesChanged?.();
  }

  postCommand(cmd: 'new-session' | 'abort' | 'share') {
    this.post({ type: `command/${cmd}` } as ExtensionMessage);
  }

  private getHtml(): string {
    const distDir = resolve(this.extensionUri.fsPath, 'dist', 'webview');
    let scriptContent = '';
    let cssContent = '';

    try {
      scriptContent = readFileSync(join(distDir, 'webview.js'), 'utf-8');
    } catch {
      logger.warn('webview.js not found — run `npm run build:webview` first');
    }
    try {
      cssContent = readFileSync(join(distDir, 'webview.css'), 'utf-8');
    } catch {}

    const nonce = randomNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src data: https:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src data:;" />
  <title>OpenCode</title>
  <style>${cssContent}</style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    window.__initialTheme = ${JSON.stringify(this.currentTheme())};
    window.__sendToExtension = function(msg) { vscode.postMessage(msg); };
  </script>
  <script nonce="${nonce}">${scriptContent}</script>
</body>
</html>`;
  }

  dispose() {
    this.themeDisposable?.dispose();
  }
}

function getDroppedRelativePath(
  uri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined
) {
  if (!workspaceFolder) return basename(uri.fsPath);

  const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  return relativePath || '.';
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
