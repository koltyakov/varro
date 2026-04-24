import * as vscode from 'vscode';
import { readFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { resolve, join, isAbsolute } from 'path';
import type {
  DesktopSessionPaneSide,
  DroppedFile,
  ExtensionMessage,
  InitialWebviewState,
  ProviderLimitStatus,
  ServerEventName,
  ServerStatus,
  WebviewThemeKind,
  WebviewMessage,
} from '../shared/protocol';
import { areContextFilesEqual, mergeContextFile } from '../shared/context-files';
import type { ContextProvider } from './context-provider';
import type { OpenCodeServer } from './server';
import { errorHub } from './error-hub';
import { logger } from './logger';
import { getRelativePath } from './util/path';
import { FileSearchService } from './file-search-service';
import {
  SessionStateManager,
  type BlockingRequestSnapshot,
  type InterruptedSessionSnapshot,
} from './session-state-manager';
import {
  isAllowedApiRequest,
  isAllowedExternalUrl,
  parseWebviewMessage,
} from './util/webview-message';
import {
  buildProviderLimitProbe,
  extractOpenCodeConsoleLimit,
  extractOpenCodeProviderLimit,
  getOpenCodeAuthFilePath,
  parseProviderAuthStore,
  parseProviderLimitHeaders,
  type ProviderAuthRecord,
  type ProviderMetadata,
} from './util/provider-limit';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'varro.chat';
  private static readonly PROVIDER_LIMIT_CACHE_TTL_MS = 60_000;
  private view?: vscode.WebviewView;
  private contextProvider: ContextProvider;
  private server: OpenCodeServer;
  private _status: ServerStatus = { state: 'stopped' };
  private themeDisposable?: vscode.Disposable;
  private configDisposable?: vscode.Disposable;
  private contextFiles: DroppedFile[] = [];
  private onContextFilesChanged?: () => void;
  private readonly fileSearch = new FileSearchService();
  private readonly sessionState: SessionStateManager;
  private pendingInputFocus = false;
  private serverStatusHandler: ((status: ServerStatus) => void) | undefined;
  private serverEventHandler: ((event: unknown) => void) | undefined;
  private webviewDisposables: vscode.Disposable[] = [];
  private windowStateDisposable?: vscode.Disposable;
  private readonly statusBarItem: vscode.StatusBarItem;
  private webviewHasFocus = false;
  private readonly providerLimitCache = new Map<
    string,
    { expiresAt: number; promise: Promise<ProviderLimitStatus> }
  >();
  private providerMetadataPromise: Promise<ProviderMetadata[]> | null = null;
  private providerMetadataFetchedAt = 0;
  private providerAuthStorePromise: Promise<Record<string, ProviderAuthRecord>> | null = null;
  private providerAuthStoreFetchedAt = 0;
  private webviewLoadGeneration = 0;
  private webviewReady = false;
  private lastStatusBarStateKey = '';
  private serverStartErrorMessage: string | null = null;
  private webviewAssets: WebviewAssetContent | null = null;
  private interruptedSessionsForWebview: InterruptedSessionSnapshot[] = [];
  private blockingRequestsForWebview: BlockingRequestSnapshot[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    workspaceState: vscode.Memento,
    contextProvider: ContextProvider,
    server: OpenCodeServer,
    private readonly simulateNoProviders = false
  ) {
    this.contextProvider = contextProvider;
    this.server = server;
    this.sessionState = new SessionStateManager(
      workspaceState,
      {
        onPendingAttentionChange: (sessionIds) => {
          this.post({ type: 'pending-attention/update', payload: { sessionIds } });
        },
        onStatusChange: () => this.updateStatusBarItem(),
      },
      {
        shouldShow: () => this.shouldShowNotification(),
      }
    );
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
    this.configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('varro.chat.expandThinkingByDefault') ||
        event.affectsConfiguration('varro.chat.showStickyUserPrompt') ||
        event.affectsConfiguration('varro.chat.desktopSessionPaneSide')
      ) {
        this.postConfigState();
      }
    });

    this.serverStatusHandler = (status: ServerStatus) => {
      const previousStatus = this._status;
      this._status = status;
      if (shouldClearProviderLimitCache(previousStatus, status)) {
        this.providerLimitCache.clear();
      }
      this.post({ type: 'server/status', payload: status });
    };
    this.serverEventHandler = (event: unknown) => {
      const evt = event as Record<string, unknown>;
      this.sessionState.handleServerEvent(evt);
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

  private shouldShowNotification() {
    // Suppress VS Code in-editor notifications when the chat view is open.
    // Only show notifications when the chat view is not visible.
    return !this.view?.visible;
  }

  private showInterruptedSessionNotification() {
    if (this.interruptedSessionsForWebview.length === 0) return;
    const labels = this.interruptedSessionsForWebview
      .map((item) => item.title?.trim() || item.id)
      .filter(Boolean);
    const preview = labels.slice(0, 3).join(', ');
    const suffix = labels.length > 3 ? ` +${labels.length - 3} more` : '';
    const message = preview
      ? `Varro is reconnecting to previously running sessions: ${preview}${suffix}.`
      : `Varro is reconnecting to ${this.interruptedSessionsForWebview.length} previously running sessions.`;
    this.interruptedSessionsForWebview = [];
    void vscode.window.showInformationMessage(message);
  }

  private updateStatusBarItem() {
    const next = this.getStatusBarState();
    const nextKey = JSON.stringify(next);
    if (nextKey === this.lastStatusBarStateKey) return;
    this.lastStatusBarStateKey = nextKey;

    if (!next.visible) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = next.text;
    this.statusBarItem.backgroundColor = next.backgroundColor;
    this.statusBarItem.tooltip = next.tooltip;
    this.statusBarItem.show();
  }

  private getStatusBarState():
    | {
        visible: false;
      }
    | {
        visible: true;
        text: string;
        tooltip: string;
        backgroundColor?: vscode.ThemeColor;
      } {
    if (this.view?.visible) {
      return { visible: false };
    }

    const pendingRequests = [...this.sessionState.pending.values()];
    if (pendingRequests.length > 0) {
      return {
        visible: true,
        text: `$(bell-dot) Varro: ${pendingRequests.length} waiting`,
        backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
        tooltip: [
          'Varro is waiting for your input.',
          ...pendingRequests.slice(0, 3).map((request) => {
            const title = this.sessionState.titleFor(request.sessionID);
            return title ? `${title}: ${request.label}` : request.label;
          }),
          ...(pendingRequests.length > 3 ? [`+${pendingRequests.length - 3} more`] : []),
          '',
          'Click to open chat.',
        ].join('\n'),
      };
    }

    const completedSessions = [...this.sessionState.completed];
    if (completedSessions.length > 0) {
      return {
        visible: true,
        text: `$(check-all) Varro: ${completedSessions.length} completed`,
        tooltip: [
          'Varro finished background work.',
          ...completedSessions
            .slice(0, 3)
            .map((sessionID) => this.sessionState.titleFor(sessionID) || sessionID),
          ...(completedSessions.length > 3 ? [`+${completedSessions.length - 3} more`] : []),
          '',
          'Click to open chat.',
        ].join('\n'),
      };
    }

    return { visible: false };
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;
    this.webviewReady = false;
    const webviewLoadGeneration = ++this.webviewLoadGeneration;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    for (const d of this.webviewDisposables) d.dispose();
    this.webviewDisposables = [];

    this.webviewDisposables.push(
      webviewView.webview.onDidReceiveMessage((raw: unknown) => {
        const msg = parseWebviewMessage(raw);
        if (!msg) {
          logger.warn('Ignoring invalid webview message');
          return;
        }
        void this.handleMessage(msg);
      })
    );

    this.webviewDisposables.push(
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
          this.webviewReady = false;
          this.webviewHasFocus = false;
          this.updateStatusBarItem();
        }
      })
    );

    void this.getHtml()
      .then((html) => {
        if (this.view !== webviewView || webviewLoadGeneration !== this.webviewLoadGeneration) {
          return;
        }
        webviewView.webview.html = html;
      })
      .catch((err) => {
        if (this.view !== webviewView || webviewLoadGeneration !== this.webviewLoadGeneration) {
          return;
        }
        logger.error(`getHtml failed: ${err instanceof Error ? err.message : String(err)}`);
        webviewView.webview.html = '<p>Failed to load Varro webview. Please reload.</p>';
      });

    this.webviewDisposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.sessionState.clearCompleted();
          this.postContext();
          this.postTerminalSelection(this.contextProvider.terminalSelection);
          this.postConfigState();
          this.post({ type: 'server/status', payload: this._status });
          this.sessionState.publishPendingAttention();
          this.flushPendingInputFocus();
          void this.ensureServerStarted().catch(() => {});
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

  private getExpandThinkingByDefault() {
    const config = vscode.workspace.getConfiguration('varro');
    return config.get<boolean>('chat.expandThinkingByDefault') ?? false;
  }

  private getShowStickyUserPrompt() {
    return vscode.workspace
      .getConfiguration('varro')
      .get<boolean>('chat.showStickyUserPrompt', true);
  }

  private getDesktopSessionPaneSide(): DesktopSessionPaneSide {
    return vscode.workspace
      .getConfiguration('varro')
      .get<DesktopSessionPaneSide>('chat.desktopSessionPaneSide', 'left');
  }

  private postConfigState() {
    this.post({
      type: 'config/update',
      payload: {
        expandThinkingByDefault: this.getExpandThinkingByDefault(),
        showStickyUserPrompt: this.getShowStickyUserPrompt(),
        desktopSessionPaneSide: this.getDesktopSessionPaneSide(),
      },
    });
  }

  private async ensureServerStarted() {
    if (this.server.status.state === 'running') {
      this.serverStartErrorMessage = null;
      return this.server.status.url;
    }

    if (this.server.status.state === 'starting') {
      return this.server.start();
    }

    try {
      const url = await this.server.start();
      this.serverStartErrorMessage = null;
      return url;
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = `Failed to start OpenCode server: ${rawMessage}`;
      if (this.serverStartErrorMessage !== message) {
        this.serverStartErrorMessage = message;
        if (/OpenCode CLI not found/i.test(rawMessage)) {
          errorHub.reportCliMissing(rawMessage);
        } else {
          errorHub.report({ code: 'server-start', message });
        }
      } else {
        logger.error(message);
      }
      throw err;
    }
  }

  async handleMessage(msg: WebviewMessage) {
    try {
      switch (msg.type) {
        case 'ready':
          this.webviewReady = true;
          this.webviewHasFocus = false;
          this.postContext();
          this.postTerminalSelection(this.contextProvider.terminalSelection);
          this.postContextFiles();
          this.postConfigState();
          this.post({ type: 'server/status', payload: this._status });
          this.post({ type: 'theme/update', payload: { theme: this.currentTheme() } });
          this.sessionState.publishPendingAttention();
          this.flushPendingInputFocus();
          this.showInterruptedSessionNotification();
          void this.ensureServerStarted().catch(() => {});
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
          await this.contextProvider.openPath(msg.payload.path, {
            line: msg.payload.line,
            kind: msg.payload.kind,
          });
          break;
        case 'vscode/open-external':
          if (!isAllowedExternalUrl(msg.payload.url)) {
            throw new Error('Unsupported external URL');
          }
          await vscode.env.openExternal(vscode.Uri.parse(msg.payload.url));
          break;
        case 'config/update':
          await vscode.workspace
            .getConfiguration('varro')
            .update(
              'chat.expandThinkingByDefault',
              msg.payload.expandThinkingByDefault,
              vscode.ConfigurationTarget.Global
            );
          await vscode.workspace
            .getConfiguration('varro')
            .update(
              'chat.showStickyUserPrompt',
              msg.payload.showStickyUserPrompt,
              vscode.ConfigurationTarget.Global
            );
          await vscode.workspace
            .getConfiguration('varro')
            .update(
              'chat.desktopSessionPaneSide',
              msg.payload.desktopSessionPaneSide,
              vscode.ConfigurationTarget.Global
            );
          this.postConfigState();
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
    try {
      const method = payload.method.toUpperCase();
      if (!isAllowedApiRequest(method, payload.path)) {
        throw new Error('Unsupported API request');
      }
      if (this._status.state !== 'running') {
        await this.ensureServerStarted();
      }
      const providerLimitRequest = this.parseProviderLimitRequest(method, payload.path);
      if (providerLimitRequest) {
        const data = await this.getProviderLimit(
          providerLimitRequest.providerID,
          providerLimitRequest.modelID
        );
        this.post({ type: 'api/response', payload: { id: payload.id, data } });
        return;
      }

      if (this.simulateNoProviders && method === 'GET' && payload.path === '/config/providers') {
        this.post({
          type: 'api/response',
          payload: { id: payload.id, data: { providers: [], default: {} } },
        });
        return;
      }

      const data = await this.server.request(method, payload.path, payload.body);
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

  private async loadProviderLimit(
    providerID: string,
    modelID: string | null
  ): Promise<ProviderLimitStatus> {
    const checkedAt = Date.now();
    const providers = await this.getProviderMetadata();
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
    const now = Date.now();
    if (
      this.providerAuthStorePromise &&
      now - this.providerAuthStoreFetchedAt < SidebarProvider.PROVIDER_LIMIT_CACHE_TTL_MS
    ) {
      return this.providerAuthStorePromise;
    }

    this.providerAuthStoreFetchedAt = now;
    this.providerAuthStorePromise = (async () => {
      try {
        const raw = await readFile(getOpenCodeAuthFilePath(), 'utf-8');
        return parseProviderAuthStore(raw);
      } catch {
        return {};
      }
    })();

    return this.providerAuthStorePromise;
  }

  private async getProviderMetadata() {
    const now = Date.now();
    if (
      this.providerMetadataPromise &&
      now - this.providerMetadataFetchedAt < SidebarProvider.PROVIDER_LIMIT_CACHE_TTL_MS
    ) {
      return this.providerMetadataPromise;
    }

    this.providerMetadataFetchedAt = now;
    this.providerMetadataPromise = (async () => {
      const rawConfig = (await this.server.request('GET', '/config/providers')) as unknown;
      const config = asRecord(rawConfig);
      return Array.isArray(config?.providers)
        ? config.providers.filter((item): item is ProviderMetadata => Boolean(asRecord(item)))
        : [];
    })();

    return this.providerMetadataPromise;
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
        return vscode.workspace.getWorkspaceFolder(absoluteUri) ? absoluteUri : null;
      } catch {
        return null;
      }
    }

    const relativePath = input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!relativePath) return null;

    const preferredWorkspacePath = this.contextProvider.context.workspacePath;
    const folders = vscode.workspace.workspaceFolders || [];
    const preferredFolder = preferredWorkspacePath
      ? folders.find((folder) => folder.uri.fsPath === preferredWorkspacePath)
      : undefined;
    const resolutionOrder = preferredFolder
      ? [
          preferredFolder,
          ...folders.filter((folder) => folder.uri.fsPath !== preferredWorkspacePath),
        ]
      : folders;

    for (const folder of resolutionOrder) {
      const candidate = vscode.Uri.file(join(folder.uri.fsPath, relativePath));
      try {
        await vscode.workspace.fs.stat(candidate);
        if (vscode.workspace.getWorkspaceFolder(candidate)?.uri.fsPath === folder.uri.fsPath) {
          return candidate;
        }
      } catch {}
    }

    return null;
  }

  setOnContextFilesChanged(fn: () => void) {
    this.onContextFilesChanged = fn;
  }

  removeContextFile(path: string) {
    const nextFiles = this.contextFiles.filter((f) => f.path !== path);
    if (nextFiles.length === this.contextFiles.length) return;
    this.contextFiles = nextFiles;
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
    this.fileSearch.search(requestId, query, limit, (result) => {
      this.post({ type: 'files/search-results', payload: result });
    });
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
      if (areContextFilesEqual(this.contextFiles[index], merged)) {
        continue;
      }
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
    if (!this.pendingInputFocus || !this.view?.visible || !this.webviewReady) return;
    this.pendingInputFocus = false;
    this.post({ type: 'command/focus-input' });
  }

  private async getHtml(): Promise<string> {
    const webview = this.view?.webview;
    const { scriptContent, cssContent } = await this.loadWebviewAssets();
    const [interruptedSessions, blockingRequests] = await Promise.all([
      this.sessionState.consumeInterruptedSessions(),
      this.sessionState.consumeBlockingRequests(),
    ]);
    this.interruptedSessionsForWebview = interruptedSessions;
    this.blockingRequestsForWebview = blockingRequests;
    this.sessionState.restoreBlockingRequests(blockingRequests);
    this.sessionState.publishPendingAttention();
    this.updateStatusBarItem();

    const nonce = randomNonce();
    const emptyStateLogoUri = webview?.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'assets', 'icon.png')
    );
    const initialState = serializeForInlineScript({
      theme: this.currentTheme(),
      serverStatus: this._status,
      editorContext: this.contextProvider.context,
      terminalSelection: this.contextProvider.terminalSelection,
      droppedFiles: this.contextFiles,
      emptyStateLogoUri: emptyStateLogoUri?.toString() || '',
      expandThinkingByDefault: this.getExpandThinkingByDefault(),
      showStickyUserPrompt: this.getShowStickyUserPrompt(),
      desktopSessionPaneSide: this.getDesktopSessionPaneSide(),
      interruptedSessionIds: this.interruptedSessionsForWebview.map((item) => item.id),
      pendingPermissions: this.blockingRequestsForWebview
        .filter((item) => item.kind === 'permission')
        .map((item) => item.props),
      pendingQuestions: this.blockingRequestsForWebview
        .filter((item) => item.kind === 'question')
        .map((item) => item.props),
    } satisfies InitialWebviewState);

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview?.cspSource || ''} data: https:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src data:;" />
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

  private async loadWebviewAssets(): Promise<WebviewAssetContent> {
    if (this.webviewAssets) return this.webviewAssets;

    const distDir = resolve(this.extensionUri.fsPath, 'dist', 'webview');
    const [scriptResult, cssResult] = await Promise.allSettled([
      readFile(join(distDir, 'webview.js'), 'utf-8'),
      readFile(join(distDir, 'webview.css'), 'utf-8'),
    ]);

    const scriptContent = scriptResult.status === 'fulfilled' ? scriptResult.value : '';
    const cssContent = cssResult.status === 'fulfilled' ? cssResult.value : '';

    if (scriptResult.status !== 'fulfilled') {
      logger.warn('webview.js not found — run `npm run build:webview` first');
      return { scriptContent, cssContent };
    }

    this.webviewAssets = { scriptContent, cssContent };
    return this.webviewAssets;
  }

  async dispose() {
    await this.sessionState.persist();
    if (this.serverStatusHandler) this.server.off('status', this.serverStatusHandler);
    if (this.serverEventHandler) this.server.off('event', this.serverEventHandler);
    this.serverStatusHandler = undefined;
    this.serverEventHandler = undefined;
    for (const d of this.webviewDisposables) d.dispose();
    this.webviewDisposables = [];
    this.webviewReady = false;
    this.themeDisposable?.dispose();
    this.configDisposable?.dispose();
    this.windowStateDisposable?.dispose();
    this.statusBarItem.dispose();
    this.fileSearch.dispose();
  }
}

type WebviewAssetContent = {
  scriptContent: string;
  cssContent: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function shouldClearProviderLimitCache(previous: ServerStatus, next: ServerStatus) {
  if (previous.state !== next.state) return true;
  if (previous.state === 'running' && next.state === 'running') {
    return previous.url !== next.url;
  }
  if (previous.state === 'error' && next.state === 'error') {
    return previous.message !== next.message;
  }
  return false;
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
