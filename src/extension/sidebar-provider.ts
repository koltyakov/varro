import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { mkdtemp, open, readFile, rm } from 'fs/promises';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import type {
  DesktopSessionPaneSide,
  DroppedFile,
  ExtensionMessage,
  InitialWebviewState,
  OpenCodeModelRouting,
  ServerEvent,
  ServerStatus,
  WebviewThemeKind,
  WebviewMessage,
} from '../shared/protocol';
import { parseServerEvent } from '../shared/protocol';
import { areContextFilesEqual, mergeContextFile } from '../shared/context-files';
import type { ContextProvider } from './context-provider';
import type { OpenCodeServer } from './server';
import { errorHub } from './error-hub';
import { logger } from './logger';
import { DroppedFilesService } from './dropped-files-service';
import { ProviderLimitService } from './provider-limit-service';
import { renderWebviewHtml, type WebviewAssetContent } from './webview-html';
import { FileSearchService } from './file-search-service';
import { getRelativePath } from './util/path';
import {
  SessionStateManager,
  type BlockingRequestSnapshot,
  type InterruptedSessionSnapshot,
} from './session-state-manager';
import { SessionTrashManager } from './session-trash-manager';
import {
  isAllowedApiRequest,
  isAllowedExternalUrl,
  parseWebviewMessage,
} from './util/webview-message';
import {
  getOpenCodePlansDirectory,
  getPlanFileName,
  normalizePlanMarkdown,
} from './util/plan-file';
import { resolveServerLaunch } from './util/server-launch';
import { buildServerEnv } from './util/server-path';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'varro.chat';
  private static readonly EXPORT_TIMEOUT_MS = 30_000;
  private static readonly RECYCLE_BIN_CLEANUP_INTERVAL_MS = 60_000;
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
  private readonly sessionTrash: SessionTrashManager;
  private pendingInputFocus = false;
  private pendingOpenAttentionSessions = false;
  private serverStatusHandler: ((status: ServerStatus) => void) | undefined;
  private serverEventHandler: ((event: unknown) => void) | undefined;
  private webviewDisposables: vscode.Disposable[] = [];
  private windowStateDisposable?: vscode.Disposable;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly droppedFilesService: DroppedFilesService;
  private readonly providerLimitService: ProviderLimitService;
  private webviewHasFocus = false;
  private webviewLoadGeneration = 0;
  private webviewReady = false;
  private lastStatusBarStateKey = '';
  private serverStartErrorMessage: string | null = null;
  private webviewAssets: WebviewAssetContent | null = null;
  private interruptedSessionsForWebview: InterruptedSessionSnapshot[] = [];
  private blockingRequestsForWebview: BlockingRequestSnapshot[] = [];
  private recycleBinMaintenanceInFlight = false;
  private lastRecycleBinCleanupAt = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    workspaceState: vscode.Memento,
    contextProvider: ContextProvider,
    server: OpenCodeServer,
    private readonly simulateNoProviders = false
  ) {
    this.contextProvider = contextProvider;
    this.server = server;
    this.droppedFilesService = new DroppedFilesService(contextProvider);
    this.providerLimitService = new ProviderLimitService(server);
    this.sessionTrash = new SessionTrashManager(workspaceState);
    this.sessionState = new SessionStateManager(
      workspaceState,
      {
        onPendingAttentionChange: (sessionIds) => {
          this.post({
            type: 'pending-attention/update',
            payload: {
              sessionIds: sessionIds.filter((sessionId) => !this.sessionTrash.isHidden(sessionId)),
            },
          });
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
    this.statusBarItem.command = 'varro.chat.statusBarClick';
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
      if (this.providerLimitService.shouldClearCache(previousStatus, status)) {
        this.providerLimitService.clearCache();
      }
      this.post({ type: 'server/status', payload: status });
    };
    this.serverEventHandler = (event: unknown) => {
      const evt = parseServerEvent(event);
      if (!evt) return;
      if (this.shouldSuppressServerEvent(evt)) return;
      this.sessionState.handleServerEvent(evt);
      this.post({
        type: 'server/event',
        payload: evt satisfies ServerEvent,
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
    this.interruptedSessionsForWebview = [];
  }

  private getCurrentBlockingRequests(): BlockingRequestSnapshot[] {
    return [...this.sessionState.pending.entries()]
      .map(([id, request]) => ({
        id,
        sessionID: request.sessionID,
        kind: request.kind,
        props: request.props,
      }))
      .filter((item) => !this.sessionTrash.isHidden(item.sessionID));
  }

  private replayBlockingRequests(options?: { clearResolvedEmbedded?: boolean }) {
    const currentRequests = this.getCurrentBlockingRequests();
    const currentRequestIds = new Set(currentRequests.map((item) => item.id));

    if (options?.clearResolvedEmbedded) {
      for (const item of this.blockingRequestsForWebview) {
        if (currentRequestIds.has(item.id)) continue;
        this.post({
          type: 'server/event',
          payload: {
            type: item.kind === 'question' ? 'question.replied' : 'permission.replied',
            properties:
              item.kind === 'question'
                ? { id: item.id, requestID: item.id, sessionID: item.sessionID }
                : {
                    id: item.id,
                    permissionID: item.id,
                    requestID: item.id,
                    sessionID: item.sessionID,
                  },
          },
        });
      }
    }

    for (const item of currentRequests) {
      this.post({
        type: 'server/event',
        payload: {
          type: item.kind === 'question' ? 'question.asked' : 'permission.asked',
          properties: item.props,
        },
      });
    }
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

    const pendingRequests = [...this.sessionState.pending.values()].filter(
      (request) => !this.sessionTrash.isHidden(request.sessionID)
    );
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

    const completedSessions = [...this.sessionState.completed].filter(
      (sessionID) => !this.sessionTrash.isHidden(sessionID)
    );
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
          this.postRecycleBinUpdate();
          this.post({ type: 'server/status', payload: this._status });
          this.replayBlockingRequests();
          this.sessionState.publishPendingAttention();
          this.flushPendingInputFocus();
          this.flushPendingOpenAttentionSessions();
          void this.cleanupExpiredRecycleBin().catch(() => {});
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
          this.postRecycleBinUpdate();
          this.post({ type: 'server/status', payload: this._status });
          this.post({ type: 'theme/update', payload: { theme: this.currentTheme() } });
          this.replayBlockingRequests({ clearResolvedEmbedded: true });
          this.sessionState.publishPendingAttention();
          this.flushPendingInputFocus();
          this.flushPendingOpenAttentionSessions();
          this.showInterruptedSessionNotification();
          void this.cleanupExpiredRecycleBin().catch(() => {});
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
        case 'session/export':
          await this.exportSession(msg.payload.sessionId);
          break;
        case 'vscode/open-settings':
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            msg.payload.query ?? '@ext:koltyakov.varro'
          );
          break;
        case 'files/drop':
          await this.handleDroppedPaths(msg.payload.paths);
          break;
        case 'files/drop-content':
          await this.handleDroppedContent(msg.payload.files);
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
    const requestGeneration = this.webviewLoadGeneration;
    try {
      const method = payload.method.toUpperCase();
      if (!isAllowedApiRequest(method, payload.path)) {
        throw new Error('Unsupported API request');
      }

      const recycleBinRequest = this.parseRecycleBinRequest(method, payload.path);
      if (recycleBinRequest) {
        const data = await this.handleRecycleBinRequest(recycleBinRequest);
        this.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const planOpenRequest = this.parsePlanOpenRequest(method, payload.path, payload.body);
      if (planOpenRequest) {
        const data = await this.openPlanDocument(planOpenRequest.content);
        this.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const openCodeConfigRequest = this.parseOpenCodeConfigRequest(
        method,
        payload.path,
        payload.body
      );
      if (openCodeConfigRequest) {
        const data =
          openCodeConfigRequest.kind === 'get'
            ? await this.readOpenCodeModelRouting()
            : await this.updateOpenCodeModelRouting(openCodeConfigRequest);
        this.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (this._status.state !== 'running') {
        await this.ensureServerStarted();
      }
      await this.cleanupExpiredRecycleBin();

      const providerLimitRequest = this.parseProviderLimitRequest(method, payload.path);
      if (providerLimitRequest) {
        const data = await this.providerLimitService.get(
          providerLimitRequest.providerID,
          providerLimitRequest.modelID
        );
        this.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (this.simulateNoProviders && method === 'GET' && payload.path === '/config/providers') {
        this.postApiResponse(requestGeneration, {
          id: payload.id,
          data: { providers: [], default: {} },
        });
        return;
      }

      const hiddenSessionID = this.getHiddenSessionIdFromPath(payload.path);
      if (hiddenSessionID) {
        throw new Error('404 Session not found');
      }

      const softDeleteSessionID = this.parseSoftDeleteSessionRequest(method, payload.path);
      if (softDeleteSessionID) {
        const data = await this.moveSessionToRecycleBin(softDeleteSessionID);
        this.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const data = await this.server.request(method, payload.path, payload.body);
      this.postApiResponse(requestGeneration, {
        id: payload.id,
        data: this.filterApiResponse(method, payload.path, data),
      });
    } catch (err) {
      this.postApiResponse(requestGeneration, {
        id: payload.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private postApiResponse(
    requestGeneration: number,
    payload: { id: number; data?: unknown; error?: string }
  ) {
    if (!this.view || requestGeneration !== this.webviewLoadGeneration) return;
    this.post({ type: 'api/response', payload });
  }

  private parseRecycleBinRequest(method: string, path: string) {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/varro/session-trash') {
      if (method === 'GET') return { kind: 'list' } as const;
      if (method === 'DELETE') return { kind: 'empty' } as const;
      return null;
    }

    const restoreMatch = url.pathname.match(/^\/varro\/session-trash\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      return { kind: 'restore', rootID: decodeURIComponent(restoreMatch[1]) } as const;
    }

    const deleteMatch = url.pathname.match(/^\/varro\/session-trash\/([^/]+)\/delete$/);
    if (deleteMatch && method === 'DELETE') {
      return { kind: 'delete', rootID: decodeURIComponent(deleteMatch[1]) } as const;
    }

    return null;
  }

  private parseSoftDeleteSessionRequest(method: string, path: string) {
    if (method !== 'DELETE') return null;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/session\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  private getHiddenSessionIdFromPath(path: string) {
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/session\/([^/]+)/);
    if (!match) return null;
    const sessionID = decodeURIComponent(match[1]);
    return this.sessionTrash.isHidden(sessionID) ? sessionID : null;
  }

  private filterApiResponse(method: string, path: string, data: unknown) {
    const url = new URL(path, 'http://localhost');
    if (method === 'GET' && url.pathname === '/session' && Array.isArray(data)) {
      return this.sessionTrash.filterVisibleSessions(data as Array<{ id: string }>);
    }
    if (
      method === 'GET' &&
      url.pathname === '/session/status' &&
      data &&
      typeof data === 'object'
    ) {
      return this.sessionTrash.filterVisibleSessionStatuses(data as Record<string, unknown>);
    }
    if (method === 'GET' && url.pathname === '/question' && Array.isArray(data)) {
      return this.sessionTrash.filterVisibleSessionRequests(data as Array<{ sessionID: string }>);
    }
    return data;
  }

  private async handleRecycleBinRequest(
    request:
      | { kind: 'list' }
      | { kind: 'empty' }
      | { kind: 'restore'; rootID: string }
      | { kind: 'delete'; rootID: string }
  ) {
    switch (request.kind) {
      case 'list':
        return this.sessionTrash.list();
      case 'restore': {
        const restored = await this.sessionTrash.restore(request.rootID);
        this.postRecycleBinUpdate();
        return Boolean(restored);
      }
      case 'delete': {
        const removed = await this.sessionTrash.deletePermanently(request.rootID, (sessionID) =>
          this.server.request('DELETE', `/session/${encodeURIComponent(sessionID)}`)
        );
        if (removed) {
          this.sessionState.removeSessions(removed.sessions.map((session) => session.id));
          this.postRecycleBinUpdate();
        }
        return Boolean(removed);
      }
      case 'empty': {
        const removed = await this.sessionTrash.empty((sessionID) =>
          this.server.request('DELETE', `/session/${encodeURIComponent(sessionID)}`)
        );
        if (removed.length > 0) {
          this.sessionState.removeSessions(
            removed.flatMap((entry) => entry.sessions.map((session) => session.id))
          );
          this.postRecycleBinUpdate();
        }
        return true;
      }
    }
  }

  private async moveSessionToRecycleBin(sessionID: string) {
    const sessions = (await this.server.request('GET', '/session')) as Array<
      Record<string, unknown>
    >;
    const entry = await this.sessionTrash.moveToTrash(sessionID, sessions as never[]);
    if (!entry) {
      throw new Error('404 Session not found');
    }
    this.sessionState.removeSessions(entry.sessions.map((session) => session.id));
    this.postRecycleBinUpdate();
    return true;
  }

  private async cleanupExpiredRecycleBin() {
    if (this.recycleBinMaintenanceInFlight || this._status.state !== 'running') return;
    const now = Date.now();
    if (now - this.lastRecycleBinCleanupAt < SidebarProvider.RECYCLE_BIN_CLEANUP_INTERVAL_MS)
      return;
    this.recycleBinMaintenanceInFlight = true;
    this.lastRecycleBinCleanupAt = now;
    try {
      const removed = await this.sessionTrash.cleanupExpired((sessionID) =>
        this.server.request('DELETE', `/session/${encodeURIComponent(sessionID)}`)
      );
      if (removed.length > 0) {
        this.sessionState.removeSessions(
          removed.flatMap((entry) => entry.sessions.map((session) => session.id))
        );
        this.postRecycleBinUpdate();
      }
    } finally {
      this.recycleBinMaintenanceInFlight = false;
    }
  }

  private postRecycleBinUpdate() {
    this.post({ type: 'recycle-bin/update', payload: { entries: this.sessionTrash.list() } });
  }

  private shouldSuppressServerEvent(event: ServerEvent) {
    return getSessionIdsForEvent(event).some((sessionID) => this.sessionTrash.isHidden(sessionID));
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

  private parsePlanOpenRequest(method: string, path: string, body: unknown) {
    if (method !== 'POST' || path !== '/varro/plan/open') return null;

    const payload = asRecord(body);
    const content = typeof payload?.content === 'string' ? payload.content : '';
    if (!content.trim()) {
      throw new Error('Plan content is empty');
    }
    if (content.length > 1_000_000) {
      throw new Error('Plan content is too large to save');
    }

    return { content };
  }

  private parseOpenCodeConfigRequest(method: string, path: string, body: unknown) {
    if (method === 'GET' && path === '/varro/opencode-config') {
      return { kind: 'get' } as const;
    }

    if (method !== 'POST' || path !== '/varro/opencode-config/model-routing') return null;

    const payload = asRecord(body);
    const target = typeof payload?.target === 'string' ? payload.target : null;
    const providerID = typeof payload?.providerID === 'string' ? payload.providerID.trim() : '';
    const modelID = typeof payload?.modelID === 'string' ? payload.modelID.trim() : '';

    if (!target || !providerID || !modelID) {
      throw new Error('Invalid model routing update');
    }

    if (target === 'small_model') {
      return { kind: 'update', target, providerID, modelID } as const;
    }

    if (target === 'agent') {
      const agentName = typeof payload?.agentName === 'string' ? payload.agentName.trim() : '';
      if (!agentName) {
        throw new Error('Agent name is required');
      }
      return { kind: 'update', target, agentName, providerID, modelID } as const;
    }

    throw new Error('Unsupported model routing target');
  }

  private getOpenCodeConfigUri() {
    const workspacePath =
      this.contextProvider.context.workspacePath || this.server.getWorkspaceCwd();
    if (!workspacePath) {
      throw new Error('Open a workspace folder before editing project opencode.json');
    }
    return vscode.Uri.file(join(workspacePath, 'opencode.json'));
  }

  private async readOpenCodeConfigObject() {
    const uri = this.getOpenCodeConfigUri();

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const raw = new TextDecoder().decode(bytes).trim();
      if (!raw) return { uri, config: {} as Record<string, unknown>, existed: true };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Project opencode.json must contain a JSON object');
      }
      return { uri, config: parsed as Record<string, unknown>, existed: true };
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'FileNotFound') {
        return { uri, config: {} as Record<string, unknown>, existed: false };
      }
      throw err;
    }
  }

  private normalizeOpenCodeModelRouting(config: Record<string, unknown>): OpenCodeModelRouting {
    const smallModel = parseModelRoute(config.small_model);
    const agentModels: Record<string, { providerID: string; modelID: string }> = {};
    const agents = asRecord(config.agent);

    if (agents) {
      for (const [name, value] of Object.entries(agents)) {
        const agentConfig = asRecord(value);
        const route = parseModelRoute(agentConfig?.model);
        if (route) {
          agentModels[name] = route;
        }
      }
    }

    return { smallModel, agentModels };
  }

  private async readOpenCodeModelRouting(): Promise<OpenCodeModelRouting> {
    const { config } = await this.readOpenCodeConfigObject();
    return this.normalizeOpenCodeModelRouting(config);
  }

  private async updateOpenCodeModelRouting(request: {
    kind: 'update';
    target: 'small_model' | 'agent';
    providerID: string;
    modelID: string;
    agentName?: string;
  }): Promise<OpenCodeModelRouting> {
    const { uri, config } = await this.readOpenCodeConfigObject();
    const next = { ...config };
    if (typeof next.$schema !== 'string' || !next.$schema.trim()) {
      next.$schema = 'https://opencode.ai/config.json';
    }

    const modelRef = `${request.providerID}/${request.modelID}`;
    if (request.target === 'small_model') {
      next.small_model = modelRef;
    } else {
      const agentName = request.agentName!;
      const existingAgents = asRecord(next.agent);
      const existingAgentConfig = asRecord(existingAgents?.[agentName]);
      next.agent = {
        ...existingAgents,
        [agentName]: {
          ...existingAgentConfig,
          model: modelRef,
        },
      };
    }

    const encoded = new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`);
    await vscode.workspace.fs.writeFile(uri, encoded);
    return this.normalizeOpenCodeModelRouting(next);
  }

  private async openPlanDocument(content: string) {
    const normalized = normalizePlanMarkdown(content);
    if (!normalized) {
      throw new Error('Plan content is empty');
    }

    const plansDir = getOpenCodePlansDirectory();
    const filename = getPlanFileName(normalized);
    const directoryUri = vscode.Uri.file(plansDir);
    const fileUri = vscode.Uri.file(join(plansDir, filename));

    await vscode.workspace.fs.createDirectory(directoryUri);

    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(`${normalized}\n`));
    }

    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document, { preview: false });
    return { path: fileUri.fsPath };
  }

  post(msg: ExtensionMessage) {
    // oxlint-disable-next-line require-post-message-target-origin
    this.view?.webview.postMessage(msg);
  }

  async handleDroppedContent(files: Array<{ name: string; content: string; size: number }>) {
    const valid = await this.droppedFilesService.fromContent(files);
    if (valid.length > 0) {
      this.postDroppedFiles(valid);
    }
  }

  async handleDroppedPaths(paths: string[]) {
    const normalized = await this.droppedFilesService.fromPaths(paths);
    if (normalized.length > 0) {
      this.postDroppedFiles(normalized);
    }
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

  private async exportSession(sessionId: string) {
    try {
      const content = await this.readExportContentFromTempFile(sessionId);
      assertValidJson(content, 'OpenCode export');
      const document = await vscode.workspace.openTextDocument({
        language: 'json',
        content,
      });
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await vscode.window.showErrorMessage(`Failed to export session: ${message}`);
      throw err;
    }
  }

  private async readExportContentFromTempFile(sessionId: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'varro-opencode-export-'));
    const tempFile = join(tempDir, 'session-export.json');

    try {
      await this.runCliCommandToFile(['export', sessionId], tempFile);
      return normalizeCliOutput(await readFile(tempFile, 'utf-8'));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async runCliCommandToFile(args: string[], outputPath: string): Promise<void> {
    const fileHandle = await open(outputPath, 'w');

    return new Promise((resolveOutput, reject) => {
      let stderr = '';
      let settled = false;
      let proc: ReturnType<typeof spawn> | null = null;
      const timeout = setTimeout(() => {
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGTERM');
        }
        finish(new Error('OpenCode CLI export timed out'));
      }, SidebarProvider.EXPORT_TIMEOUT_MS);

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void fileHandle
          .close()
          .catch(() => undefined)
          .finally(() => {
            if (error) {
              reject(error);
              return;
            }
            resolveOutput();
          });
      };

      try {
        const command = this.server.resolveCommand();
        const launch = resolveServerLaunch(command, args);
        proc = spawn(launch.command, launch.args, {
          stdio: ['ignore', fileHandle.fd, 'pipe'],
          cwd: this.server.getWorkspaceCwd(),
          env: buildServerEnv(),
          windowsHide: true,
          ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        proc.once('error', (err) => finish(err));
        proc.once('close', (code, signal) => {
          if (code === 0) {
            finish();
            return;
          }
          finish(
            new Error(
              stderr.trim() ||
                `OpenCode CLI command failed${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}`
            )
          );
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
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

  postDroppedFiles(files: Array<Pick<DroppedFile, 'path' | 'relativePath' | 'type'>>) {
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

  hasPendingAttention() {
    return this.sessionState.pending.size > 0;
  }

  openAttentionSessions() {
    this.pendingOpenAttentionSessions = true;
    this.flushPendingOpenAttentionSessions();
  }

  private flushPendingInputFocus() {
    if (!this.pendingInputFocus || !this.view?.visible || !this.webviewReady) return;
    this.pendingInputFocus = false;
    this.post({ type: 'command/focus-input' });
  }

  private flushPendingOpenAttentionSessions() {
    if (!this.pendingOpenAttentionSessions || !this.view?.visible || !this.webviewReady) return;
    this.pendingOpenAttentionSessions = false;
    this.post({ type: 'command/open-attention-sessions' });
  }

  private async getHtml(): Promise<string> {
    const webview = this.view?.webview;
    const assets = await this.loadWebviewAssets();
    const [interruptedSessions, blockingRequests] = await Promise.all([
      this.sessionState.consumeInterruptedSessions(),
      this.sessionState.consumeBlockingRequests(),
    ]);
    this.interruptedSessionsForWebview = interruptedSessions;
    this.blockingRequestsForWebview = blockingRequests;
    this.sessionState.restoreBlockingRequests(blockingRequests);
    this.sessionState.publishPendingAttention();
    this.updateStatusBarItem();

    const emptyStateLogoUri = webview?.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'assets', 'icon.png')
    );
    const initialState = {
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
        .filter((item) => !this.sessionTrash.isHidden(item.sessionID))
        .map((item) => item.props),
      pendingQuestions: this.blockingRequestsForWebview
        .filter((item) => item.kind === 'question')
        .filter((item) => !this.sessionTrash.isHidden(item.sessionID))
        .map((item) => item.props),
      recycleBinEntries: this.sessionTrash.list(),
    } satisfies InitialWebviewState;

    return renderWebviewHtml(webview?.cspSource || '', initialState, assets);
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
    await this.droppedFilesService.dispose();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function assertValidJson(value: string, label: string) {
  try {
    JSON.parse(value);
  } catch (err) {
    throw new Error(
      `${label} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

function normalizeCliOutput(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Buffer.isBuffer(value)) return value.toString('utf-8').trim();
  return String(value ?? '').trim();
}

function parseModelRoute(value: unknown) {
  if (typeof value !== 'string') return null;
  const separatorIndex = value.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;
  return {
    providerID: value.slice(0, separatorIndex),
    modelID: value.slice(separatorIndex + 1),
  };
}

function getSessionIdsForEvent(event: ServerEvent) {
  const ids = new Set<string>();
  const properties = asRecord(event.properties);
  const add = (value: unknown) => {
    if (typeof value === 'string' && value) ids.add(value);
  };

  add(properties?.sessionID);
  add(asRecord(properties?.info)?.id);
  add(asRecord(properties?.info)?.sessionID);
  add(asRecord(properties?.part)?.sessionID);

  return [...ids];
}
