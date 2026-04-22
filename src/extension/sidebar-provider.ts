import * as vscode from 'vscode';
import { readFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { resolve, join, basename, isAbsolute } from 'path';
import type {
  DroppedFile,
  ExtensionMessage,
  InitialWebviewState,
  ProviderLimitStatus,
  ServerEventName,
  ServerStatus,
  WebviewThemeKind,
  WebviewMessage,
} from '../shared/protocol';
import { mergeContextFile } from '../shared/context-files';
import type { ContextProvider } from './context-provider';
import type { OpenCodeServer } from './server';
import { logger } from './logger';
import { getRelativePath } from './util/path';
import {
  buildProviderLimitProbe,
  extractOpenCodeConsoleLimit,
  extractOpenCodeProviderLimit,
  getOpenCodeAuthFilePath,
  parseProviderAuthStore,
  parseProviderLimitHeaders,
  type ProviderMetadata,
} from './util/provider-limit';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'varro.chat';
  private static readonly FILE_SEARCH_CACHE_TTL_MS = 15_000;
  private static readonly FILE_SEARCH_MAX_CANDIDATES = 4_000;
  private static readonly PROVIDER_LIMIT_CACHE_TTL_MS = 60_000;
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
  private windowStateDisposable?: vscode.Disposable;
  private readonly statusBarItem: vscode.StatusBarItem;
  private webviewHasFocus = false;
  private readonly busySessions = new Set<string>();
  private readonly completedSessions = new Set<string>();
  private readonly pendingAttention = new Map<
    string,
    { sessionID: string; kind: 'permission' | 'question'; label: string }
  >();
  private readonly sessionTitles = new Map<string, string>();
  private readonly providerLimitCache = new Map<
    string,
    { expiresAt: number; promise: Promise<ProviderLimitStatus> }
  >();

  constructor(
    private readonly extensionUri: vscode.Uri,
    contextProvider: ContextProvider,
    server: OpenCodeServer,
    private readonly simulateNoProviders = false
  ) {
    this.contextProvider = contextProvider;
    this.server = server;
    this.statusBarItem = vscode.window.createStatusBarItem(
      'varro.session-status',
      vscode.StatusBarAlignment.Left,
      1000
    );
    this.statusBarItem.name = 'Varro Session Status';
    this.statusBarItem.command = 'varro.chat.focus';
    this.windowStateDisposable = vscode.window.onDidChangeWindowState(() => {
      this.updateStatusBarItem();
    });

    this.serverStatusHandler = (status: ServerStatus) => {
      this._status = status;
      this.providerLimitCache.clear();
      this.post({ type: 'server/status', payload: status });
    };
    this.serverEventHandler = (event: unknown) => {
      const evt = event as Record<string, unknown>;
      this.handleServerEvent(evt);
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
    this.updateStatusBarItem();
  }

  private handleServerEvent(event: Record<string, unknown>) {
    const type = typeof event.type === 'string' ? event.type : undefined;
    const props = asRecord(event.properties);
    if (!type) return;

    switch (type) {
      case 'session.created':
      case 'session.updated': {
        this.rememberSessionTitle(asRecord(props?.info));
        break;
      }
      case 'session.deleted': {
        const sessionID = getString(asRecord(props?.info)?.id);
        if (!sessionID) break;
        this.busySessions.delete(sessionID);
        this.completedSessions.delete(sessionID);
        this.sessionTitles.delete(sessionID);
        for (const [requestID, request] of this.pendingAttention.entries()) {
          if (request.sessionID === sessionID) {
            this.pendingAttention.delete(requestID);
          }
        }
        break;
      }
      case 'session.status': {
        const sessionID = getString(props?.sessionID);
        const statusType = getString(asRecord(props?.status)?.type);
        if (!sessionID || !statusType) break;
        if (statusType === 'busy' || statusType === 'retry') {
          this.busySessions.add(sessionID);
          this.completedSessions.delete(sessionID);
        }
        if (statusType === 'idle') {
          this.busySessions.delete(sessionID);
        }
        break;
      }
      case 'session.idle': {
        const sessionID = getString(props?.sessionID);
        if (!sessionID) break;
        const wasBusy = this.busySessions.delete(sessionID);
        if (wasBusy && !this.hasPendingAttentionForSession(sessionID)) {
          this.completedSessions.add(sessionID);
          this.showCompletionNotification(sessionID);
        }
        break;
      }
      case 'permission.asked': {
        if (props) this.trackBlockingRequest('permission', props);
        break;
      }
      case 'permission.replied': {
        this.clearBlockingRequest(getString(props?.permissionID) || getString(props?.requestID));
        break;
      }
      case 'question.asked': {
        if (props) this.trackBlockingRequest('question', props);
        break;
      }
      case 'question.replied':
      case 'question.rejected': {
        this.clearBlockingRequest(getString(props?.requestID) || getString(props?.id));
        break;
      }
    }

    this.updateStatusBarItem();
  }

  private rememberSessionTitle(info: Record<string, unknown> | undefined) {
    const sessionID = getString(info?.id);
    const title = getString(info?.title)?.trim();
    if (sessionID && title) {
      this.sessionTitles.set(sessionID, title);
    }
  }

  private trackBlockingRequest(kind: 'permission' | 'question', props: Record<string, unknown>) {
    const requestID =
      getString(props.id) || getString(props.permissionID) || getString(props.requestID);
    const sessionID = getString(props.sessionID);
    if (!requestID || !sessionID || this.pendingAttention.has(requestID)) return;

    const label =
      kind === 'question' ? this.describeQuestionRequest(props) : this.describePermissionRequest(props);
    this.pendingAttention.set(requestID, { sessionID, kind, label });
    this.completedSessions.delete(sessionID);
    this.showBlockingNotification(kind, sessionID, label);
  }

  private clearBlockingRequest(requestID: string | undefined) {
    if (!requestID) return;
    this.pendingAttention.delete(requestID);
  }

  private hasPendingAttentionForSession(sessionID: string) {
    for (const request of this.pendingAttention.values()) {
      if (request.sessionID === sessionID) return true;
    }
    return false;
  }

  private describeQuestionRequest(props: Record<string, unknown>) {
    const questions = Array.isArray(props.questions) ? props.questions : [];
    const firstQuestion = asRecord(questions[0]);
    return (
      getString(firstQuestion?.header) ||
      getString(firstQuestion?.question) ||
      'User input required'
    );
  }

  private describePermissionRequest(props: Record<string, unknown>) {
    const title = getString(props.title)?.trim();
    if (title) return title;

    const permission = getString(props.permission);
    const patterns = Array.isArray(props.patterns)
      ? props.patterns.map((item) => getString(item)).filter((item): item is string => Boolean(item))
      : [];
    return [permission, patterns.join(', ')].filter(Boolean).join(' ').trim() || 'Permission required';
  }

  private showBlockingNotification(
    kind: 'permission' | 'question',
    sessionID: string,
    label: string
  ) {
    if (!this.shouldShowNotification()) return;

    const prefix = kind === 'question' ? 'Varro is waiting for your input' : 'Varro needs permission approval';
    const message = `${prefix}${this.describeSessionSuffix(sessionID)}.`;

    void vscode.window.showWarningMessage(message, 'Open Chat').then((action) => {
      if (action === 'Open Chat') {
        void vscode.commands.executeCommand('varro.chat.focus');
      }
    });

    if (label) {
      this.statusBarItem.tooltip = `${message}\n${label}\n\nClick to open chat.`;
    }
  }

  private showCompletionNotification(sessionID: string) {
    if (!this.shouldShowNotification()) return;

    const message = `Varro completed a background session${this.describeSessionSuffix(sessionID)}.`;
    void vscode.window.showInformationMessage(message, 'Open Chat').then((action) => {
      if (action === 'Open Chat') {
        void vscode.commands.executeCommand('varro.chat.focus');
      }
    });
  }

  private shouldShowNotification() {
    return !this.view?.visible || !vscode.window.state.focused || !this.webviewHasFocus;
  }

  private describeSessionSuffix(sessionID: string) {
    const title = this.sessionTitles.get(sessionID)?.trim();
    return title ? ` for "${title}"` : '';
  }

  private updateStatusBarItem() {
    if (this.view?.visible) {
      this.statusBarItem.hide();
      return;
    }

    const pendingRequests = [...this.pendingAttention.values()];
    if (pendingRequests.length > 0) {
      this.statusBarItem.text = `$(bell-dot) Varro: ${pendingRequests.length} waiting`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.tooltip = [
        'Varro is waiting for your input.',
        ...pendingRequests.slice(0, 3).map((request) => {
          const title = this.sessionTitles.get(request.sessionID);
          return title ? `${title}: ${request.label}` : request.label;
        }),
        ...(pendingRequests.length > 3 ? [`+${pendingRequests.length - 3} more`] : []),
        '',
        'Click to open chat.',
      ].join('\n');
      this.statusBarItem.show();
      return;
    }

    const completedSessions = [...this.completedSessions];
    if (completedSessions.length > 0) {
      this.statusBarItem.text = `$(check-all) Varro: ${completedSessions.length} completed`;
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.tooltip = [
        'Varro finished background work.',
        ...completedSessions.slice(0, 3).map((sessionID) => this.sessionTitles.get(sessionID) || sessionID),
        ...(completedSessions.length > 3 ? [`+${completedSessions.length - 3} more`] : []),
        '',
        'Click to open chat.',
      ].join('\n');
      this.statusBarItem.show();
      return;
    }

    this.statusBarItem.hide();
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
          this.completedSessions.clear();
          this.postContext();
          this.postTerminalSelection(this.contextProvider.terminalSelection);
          this.post({ type: 'server/status', payload: this._status });
          this.flushPendingInputFocus();
        } else {
          this.webviewHasFocus = false;
        }
        this.updateStatusBarItem();
      })
    );

    this.themeDisposable?.dispose();
    this.themeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
      this.post({ type: 'theme/update', payload: { theme: this.currentTheme() } });
    });
  }

  private currentTheme(): WebviewThemeKind {
    const k = vscode.window.activeColorTheme.kind;
    switch (k) {
      case vscode.ColorThemeKind.Light:
        return 'light';
      case vscode.ColorThemeKind.Dark:
        return 'dark';
      case vscode.ColorThemeKind.HighContrast:
        return 'high-contrast';
      case vscode.ColorThemeKind.HighContrastLight:
        return 'high-contrast-light';
      default:
        return 'dark';
    }
  }

  async handleMessage(msg: WebviewMessage) {
    try {
      switch (msg.type) {
        case 'ready':
          this.webviewHasFocus = false;
          this.postContext();
          this.postTerminalSelection(this.contextProvider.terminalSelection);
          this.postContextFiles();
          this.post({ type: 'server/status', payload: this._status });
          this.post({ type: 'theme/update', payload: { theme: this.currentTheme() } });
          this.flushPendingInputFocus();
          break;
        case 'webview/focus':
          this.webviewHasFocus = msg.payload.focused;
          this.updateStatusBarItem();
          break;
        case 'context/request':
          this.postContext();
          this.postTerminalSelection(this.contextProvider.terminalSelection);
          break;
        case 'terminal-selection/clear':
          this.contextProvider.clearTerminalSelection();
          this.postTerminalSelection(this.contextProvider.terminalSelection);
          break;
        case 'terminal/run':
          this.runInTerminal(msg.payload.command, msg.payload.title);
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
      const providerLimitRequest = this.parseProviderLimitRequest(payload.method, payload.path);
      if (providerLimitRequest) {
        const data = await this.getProviderLimit(
          providerLimitRequest.providerID,
          providerLimitRequest.modelID
        );
        this.post({ type: 'api/response', payload: { id: payload.id, data } });
        return;
      }

      if (
        this.simulateNoProviders &&
        payload.method === 'GET' &&
        payload.path === '/config/providers'
      ) {
        this.post({
          type: 'api/response',
          payload: { id: payload.id, data: { providers: [], default: {} } },
        });
        return;
      }

      const data = await this.server.request(payload.method, payload.path, payload.body);
      this.post({ type: 'api/response', payload: { id: payload.id, data } });
    } catch (err) {
      this.post({
        type: 'api/response',
        payload: { id: payload.id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private parseProviderLimitRequest(method: string, path: string) {
    if (method !== 'GET') return null;

    const url = new URL(path, 'http://localhost');
    if (url.pathname !== '/varro/provider-limit') return null;

    const providerID = url.searchParams.get('providerID')?.trim();
    if (!providerID) return null;

    return {
      providerID,
      modelID: url.searchParams.get('modelID')?.trim() || null,
    };
  }

  private getProviderLimit(providerID: string, modelID: string | null) {
    const cacheKey = `${providerID}:${modelID || ''}`;
    const now = Date.now();
    const cached = this.providerLimitCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.promise;

    const promise = this.loadProviderLimit(providerID, modelID).catch((err) => {
      if (this.providerLimitCache.get(cacheKey)?.promise === promise) {
        this.providerLimitCache.delete(cacheKey);
      }
      throw err;
    });

    this.providerLimitCache.set(cacheKey, {
      expiresAt: now + SidebarProvider.PROVIDER_LIMIT_CACHE_TTL_MS,
      promise,
    });
    return promise;
  }

  private async loadProviderLimit(providerID: string, modelID: string | null): Promise<ProviderLimitStatus> {
    const checkedAt = Date.now();
    const rawConfig = (await this.server.request('GET', '/config/providers')) as unknown;
    const config = asRecord(rawConfig);
    const providers = Array.isArray(config?.providers)
      ? config.providers.filter((item): item is ProviderMetadata => Boolean(asRecord(item)))
      : [];
    const provider = providers.find((item) => item.id === providerID);

    if (!provider) {
      return {
        providerID,
        modelID,
        status: 'error',
        source: 'opencode',
        checkedAt,
        note: 'Provider not found in OpenCode config',
      };
    }

    const direct = extractOpenCodeProviderLimit(provider, modelID, checkedAt);
    if (direct) return direct;

    try {
      const rawConsole = await this.server.request('GET', '/experimental/console');
      const consoleLimit = extractOpenCodeConsoleLimit(rawConsole, providerID, modelID, checkedAt);
      if (consoleLimit) return consoleLimit;
    } catch {}

    const authStore = await this.readProviderAuthStore();
    const probe = buildProviderLimitProbe(provider, authStore);
    if (!probe) {
      return {
        providerID,
        modelID,
        status: 'unsupported',
        source: 'provider',
        checkedAt,
        note: 'No zero-cost provider quota endpoint is known for this provider',
      };
    }

    try {
      const response = await fetch(probe.url, {
        headers: probe.headers,
        signal: AbortSignal.timeout(10_000),
      });
      const windows = parseProviderLimitHeaders(response.headers, checkedAt);
      if (windows.length > 0) {
        return {
          providerID,
          modelID,
          status: 'available',
          source: 'provider',
          checkedAt,
          windows,
          note: 'Polled provider metadata headers',
        };
      }

      return {
        providerID,
        modelID,
        status: 'unsupported',
        source: 'provider',
        checkedAt,
        note: response.ok
          ? 'Provider metadata endpoint did not expose remaining limits'
          : `Provider metadata endpoint returned ${response.status}`,
      };
    } catch {
      return {
        providerID,
        modelID,
        status: 'error',
        source: 'provider',
        checkedAt,
        note: 'Failed to poll the provider metadata endpoint',
      };
    }
  }

  private async readProviderAuthStore() {
    try {
      const raw = await readFile(getOpenCodeAuthFilePath(), 'utf-8');
      return parseProviderAuthStore(raw);
    } catch {
      return {};
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

  private runInTerminal(command: string, title = 'OpenCode') {
    const text = command.trim();
    if (!text) return;

    const cwd = this.contextProvider.context.workspacePath || undefined;
    const terminal = vscode.window.createTerminal({ name: title, cwd });
    terminal.show(false);
    terminal.sendText(text, true);
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
    const updates: DroppedFile[] = [];
    for (const file of files) {
      const incoming = file as DroppedFile;
      const index = this.contextFiles.findIndex((item) => item.path === incoming.path);
      if (index === -1) {
        this.contextFiles.push(incoming);
        updates.push(incoming);
        continue;
      }

      const merged = mergeContextFile(this.contextFiles[index], incoming);
      this.contextFiles[index] = merged;
      updates.push(merged);
    }
    if (updates.length === 0) return;

    this.post({ type: 'files/dropped', payload: updates });
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
    this.windowStateDisposable?.dispose();
    this.statusBarItem.dispose();
    if (this.fileSearchDebounceTimer) clearTimeout(this.fileSearchDebounceTimer);
    this.fileSearchCts?.dispose();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
