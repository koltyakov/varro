import * as vscode from 'vscode';
import { readFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { resolve, join, basename, isAbsolute } from 'path';
import type {
  DroppedFile,
  ExtensionMessage,
  InitialWebviewState,
  ServerEventName,
  ServerStatus,
  WebviewMessage,
} from '../shared/protocol';
import type { ContextProvider } from './context-provider';
import type { OpenCodeServer } from './server';
import { logger } from './logger';
import { getRelativePath } from './util/path';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'varro.chat';
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
  private fileSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fileSearchCts: vscode.CancellationTokenSource | null = null;
  private pendingInputFocus = false;
  private serverStatusHandler: ((status: ServerStatus) => void) | undefined;
  private serverEventHandler: ((event: unknown) => void) | undefined;
  private webviewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    contextProvider: ContextProvider,
    server: OpenCodeServer
  ) {
    this.contextProvider = contextProvider;
    this.server = server;

    this.serverStatusHandler = (status: ServerStatus) => {
      this._status = status;
      this.post({ type: 'server/status', payload: status });
    };
    this.serverEventHandler = (event: unknown) => {
      const evt = event as Record<string, unknown>;
      this.post({
        type: 'server/event',
        payload: {
          type: (evt.type ?? 'event') as ServerEventName,
          properties: evt.properties as Record<string, unknown> | undefined,
        },
      });
    };

    this.server.on('status', this.serverStatusHandler);
    this.server.on('event', this.serverEventHandler);
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

    for (const d of this.webviewDisposables) d.dispose();
    this.webviewDisposables = [];

    this.webviewDisposables.push(
      webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
        void this.handleMessage(msg);
      })
    );

    void this.getHtml().then((html) => {
      webviewView.webview.html = html;
    }).catch((err) => {
      logger.error(`getHtml failed: ${err instanceof Error ? err.message : String(err)}`);
      webviewView.webview.html = '<p>Failed to load Varro webview. Please reload.</p>';
    });

    this.webviewDisposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.postContext();
          this.postTerminalSelection(this.contextProvider.terminalSelection);
          this.post({ type: 'server/status', payload: this._status });
          this.flushPendingInputFocus();
        }
      })
    );

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
    try {
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
          await this.handleDroppedPaths(msg.payload.paths);
          break;
        case 'files/remove':
          this.removeContextFile(msg.payload.path);
          break;
        case 'files/clear':
          this.clearContextFiles();
          this.onContextFilesChanged?.();
          break;
        case 'files/pick':
          await this.pickFiles();
          break;
        case 'files/search':
          await this.searchFiles(msg.payload.requestId, msg.payload.query, msg.payload.limit);
          break;
        case 'file/read':
          await this.contextProvider.readFile(msg.payload.path);
          this.postContext();
          break;
        case 'vscode/open':
          await this.contextProvider.openFile(msg.payload.path, msg.payload.line);
          break;
        case 'vscode/diff':
          vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.parse(`varro-diff://${msg.payload.path}/before`),
            vscode.Uri.parse(`varro-diff://${msg.payload.path}/after`),
            `Varro: ${msg.payload.path}`
          );
          break;
        case 'api/request':
          await this.handleApiRequest(msg.payload);
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
    } catch (err) {
      logger.error(
        `handleMessage(${msg.type}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
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
          const relativePath = getRelativePath(uri, workspaceFolder);

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
          const relativePath = getRelativePath(uri, workspaceFolder);
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

  private searchFiles(requestId: number, query: string, limit = 12) {
    if (this.fileSearchDebounceTimer) clearTimeout(this.fileSearchDebounceTimer);
    this.fileSearchCts?.dispose();
    this.fileSearchCts = new vscode.CancellationTokenSource();
    const token = this.fileSearchCts.token;
    this.fileSearchDebounceTimer = setTimeout(
      () => this.executeFileSearch(requestId, query, limit, token),
      200
    );
  }

  private async executeFileSearch(requestId: number, query: string, limit: number, token: vscode.CancellationToken) {
    this.fileSearchDebounceTimer = null;
    try {
      const files = await this.getWorkspaceFiles(token);
      if (token.isCancellationRequested) return;
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
    } catch (err) {
      if (token.isCancellationRequested) return;
      this.post({
        type: 'files/search-results',
        payload: { requestId, query, files: [] },
      });
      logger.warn(`searchFiles failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async getWorkspaceFiles(token?: vscode.CancellationToken): Promise<DroppedFile[]> {
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
      SidebarProvider.FILE_SEARCH_MAX_CANDIDATES,
      token
    );

    this.workspaceFileCache = files.map((uri) => {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      return {
        path: uri.fsPath,
        relativePath: getRelativePath(uri, workspaceFolder),
        type: 'file' as const,
      };
    });
    this.workspaceFileCacheAt = now;
    return this.workspaceFileCache;
  }

  postDroppedFiles(
    files: Array<{ path: string; relativePath: string; type: 'file' | 'directory' }>
  ) {
    const existing = new Set(this.contextFiles.map((f) => f.path));
    const next = files.filter((file) => !existing.has(file.path));
    if (next.length === 0) return;

    this.contextFiles.push(...next);
    this.post({ type: 'files/dropped', payload: next });
    this.onContextFilesChanged?.();
  }

  postCommand(cmd: 'new-session' | 'abort') {
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

  private async getHtml(): Promise<string> {
    const distDir = resolve(this.extensionUri.fsPath, 'dist', 'webview');
    let scriptContent = '';
    let cssContent = '';

    try {
      scriptContent = await readFile(join(distDir, 'webview.js'), 'utf-8');
    } catch {
      logger.warn('webview.js not found — run `npm run build:webview` first');
    }
    try {
      cssContent = await readFile(join(distDir, 'webview.css'), 'utf-8');
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
  <title>Varro</title>
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
    if (this.serverStatusHandler) this.server.off('status', this.serverStatusHandler);
    if (this.serverEventHandler) this.server.off('event', this.serverEventHandler);
    this.serverStatusHandler = undefined;
    this.serverEventHandler = undefined;
    for (const d of this.webviewDisposables) d.dispose();
    this.webviewDisposables = [];
    this.themeDisposable?.dispose();
    if (this.fileSearchDebounceTimer) clearTimeout(this.fileSearchDebounceTimer);
    this.fileSearchCts?.dispose();
  }
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
  const bytes = randomBytes(24);
  return bytes.toString('base64url');
}

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
