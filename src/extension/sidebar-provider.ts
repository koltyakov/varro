import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import { resolve, join, basename, isAbsolute } from 'path';
import type {
  DroppedFile,
  EditorContext,
  ExtensionMessage,
  ServerStatus,
  WebviewMessage,
} from '../shared/protocol';
import type { ContextProvider } from './context-provider';
import type { OpenCodeServer } from './server';
import { logger } from './logger';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'opencode.chat';
  private static readonly FILE_SEARCH_CACHE_TTL_MS = 15_000;
  private static readonly FILE_SEARCH_MAX_CANDIDATES = 4_000;
  private view?: vscode.WebviewView;
  private contextProvider: ContextProvider;
  private server: OpenCodeServer;
  private _status: ServerStatus = { state: 'stopped' };
  private themeDisposable?: vscode.Disposable;
  private contextFiles: DroppedFile[] = [];
  private onContextFilesChanged?: () => void;
  private workspaceFileCache: DroppedFile[] = [];
  private workspaceFileCacheAt = 0;
  private pendingInputFocus = false;

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
      void this.handleMessage(msg);
    });

    webviewView.webview.html = this.getHtml();

    webviewView.onDidChangeVisibility(async () => {
      if (webviewView.visible) {
        this.postContext();
        this.postTerminalSelection(this.contextProvider.terminalSelection);
        this.post({ type: 'server/status', payload: this._status });
        this.flushPendingInputFocus();
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

  async handleMessage(msg: WebviewMessage) {
    switch (msg.type) {
      case 'ready':
        this.postContext();
        this.postTerminalSelection(this.contextProvider.terminalSelection);
        this.postContextFiles();
        this.post({ type: 'server/status', payload: this._status });
        this.post({ type: 'theme/update', payload: { theme: this.currentTheme() } });
        this.flushPendingInputFocus();
        break;
      case 'context/request':
        this.postContext();
        this.postTerminalSelection(this.contextProvider.terminalSelection);
        break;
      case 'terminal-selection/clear':
        this.contextProvider.clearTerminalSelection();
        this.postTerminalSelection(this.contextProvider.terminalSelection);
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
      case 'files/search':
        this.searchFiles(msg.payload.requestId, msg.payload.query, msg.payload.limit);
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
              stat.type & vscode.FileType.Directory ? ('directory' as const) : ('file' as const),
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

  postTerminalSelection(selection: { text: string; terminalName: string } | null) {
    this.post({ type: 'terminal-selection/update', payload: selection });
  }

  private postContextFiles() {
    if (this.contextFiles.length === 0) return;
    this.post({ type: 'files/dropped', payload: this.contextFiles });
  }

  private async searchFiles(requestId: number, query: string, limit = 12) {
    const files = await this.getWorkspaceFiles();
    const normalizedQuery = query.trim().toLowerCase();
    const ranked = files
      .map((file) => ({ file, score: getFileSearchScore(file.relativePath, normalizedQuery) }))
      .filter((item) => item.score > Number.NEGATIVE_INFINITY)
      .toSorted(
        (a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath)
      )
      .slice(0, Math.max(1, Math.min(limit, 30)))
      .map((item) => item.file);

    this.post({
      type: 'files/search-results',
      payload: { requestId, query, files: ranked },
    });
  }

  private async getWorkspaceFiles(): Promise<DroppedFile[]> {
    const now = Date.now();
    if (
      this.workspaceFileCache.length > 0 &&
      now - this.workspaceFileCacheAt < SidebarProvider.FILE_SEARCH_CACHE_TTL_MS
    ) {
      return this.workspaceFileCache;
    }

    const files = await vscode.workspace.findFiles(
      '**/*',
      '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/.turbo/**,**/coverage/**}',
      SidebarProvider.FILE_SEARCH_MAX_CANDIDATES
    );

    this.workspaceFileCache = files.map((uri) => {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      return {
        path: uri.fsPath,
        relativePath: getDroppedRelativePath(uri, workspaceFolder),
        type: 'file' as const,
      };
    });
    this.workspaceFileCacheAt = now;
    return this.workspaceFileCache;
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

  requestInputFocus() {
    this.pendingInputFocus = true;
    this.flushPendingInputFocus();
  }

  private flushPendingInputFocus() {
    if (!this.pendingInputFocus || !this.view?.visible) return;
    this.pendingInputFocus = false;
    this.post({ type: 'command/focus-input' });
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
    const initialState = serializeForInlineScript({
      theme: this.currentTheme(),
      serverStatus: this._status,
      editorContext: this.contextProvider.context,
      terminalSelection: this.contextProvider.terminalSelection,
      droppedFiles: this.contextFiles,
    } satisfies InitialWebviewState);

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
    window.__initialWebviewState = ${initialState};
    window.__initialTheme = window.__initialWebviewState.theme;
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

function getFileSearchScore(relativePath: string, query: string) {
  if (!query) {
    return 1 / Math.max(relativePath.length, 1);
  }

  const haystack = relativePath.toLowerCase();
  const leaf = basename(relativePath).toLowerCase();
  if (leaf === query) return 10_000;
  if (haystack === query) return 9_000;
  if (leaf.startsWith(query)) return 8_000 - leaf.length;
  if (haystack.startsWith(query)) return 7_000 - haystack.length;
  if (leaf.includes(query)) return 6_000 - leaf.indexOf(query) * 8 - leaf.length;
  if (haystack.includes(query)) return 5_000 - haystack.indexOf(query) * 4 - haystack.length;

  let score = 0;
  let index = 0;
  for (const char of query) {
    const next = haystack.indexOf(char, index);
    if (next === -1) return Number.NEGATIVE_INFINITY;
    score += 12 - Math.min(next - index, 11);
    index = next + 1;
  }
  return score - haystack.length;
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

type InitialWebviewState = {
  theme: 'dark' | 'light';
  serverStatus: ServerStatus;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  droppedFiles: DroppedFile[];
};

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case '<':
        return '\\u003C';
      case '>':
        return '\\u003E';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        return char;
    }
  });
}
