import * as vscode from 'vscode';
import type { ExtensionMessage, ServerEvent, ServerStatus } from '../shared/protocol';
import { parseServerEvent } from '../shared/protocol';
import type { OpenCodeServer } from './server';
import type { HiddenSessionManager } from './hidden-session-manager';
import type { SessionStateManager } from './session-state-manager';
import { getSessionIdsForEvent } from './sidebar-provider-utils';

type PostMessage = (message: ExtensionMessage) => void;

export class ServerEventBridge {
  private readonly statusBarItem: vscode.StatusBarItem;
  private status: ServerStatus = { state: 'stopped' };
  private serverStatusHandler: ((status: ServerStatus) => void) | undefined;
  private serverEventHandler: ((event: unknown) => void) | undefined;

  constructor(
    private readonly server: Pick<OpenCodeServer, 'on' | 'off'>,
    private readonly sessionState: Pick<
      SessionStateManager,
      'handleServerEvent' | 'isSessionInWorkspace' | 'persist'
    >,
    private readonly hiddenSessions: Pick<HiddenSessionManager, 'isHidden' | 'observeEvent'>,
    private readonly providerLimitService: {
      shouldClearCache(previousStatus: ServerStatus, nextStatus: ServerStatus): boolean;
      clearCache(): void;
    },
    private readonly post: PostMessage,
    private readonly updateStatusBarItem: () => void,
    private readonly workspace?: { getPath(): string | null | undefined }
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'varro.session-status',
      vscode.StatusBarAlignment.Left,
      1000
    );
    this.statusBarItem.name = 'Varro Session Status';
    this.statusBarItem.command = 'varro.chat.statusBarClick';
  }

  getStatus() {
    return this.status;
  }

  getStatusBarItem() {
    return this.statusBarItem;
  }

  attach() {
    this.serverStatusHandler = (status: ServerStatus) => {
      const previousStatus = this.status;
      this.status = status;
      if (this.providerLimitService.shouldClearCache(previousStatus, status)) {
        this.providerLimitService.clearCache();
      }
      this.post({ type: 'server/status', payload: status });
      this.updateStatusBarItem();
    };

    this.serverEventHandler = (event: unknown) => {
      const parsed = parseServerEvent(event);
      if (!parsed) return;
      this.hiddenSessions.observeEvent?.(parsed);
      if (this.shouldSuppress(parsed)) return;
      if (this.shouldSuppressWorkspace(parsed)) return;
      this.sessionState.handleServerEvent(parsed);
      this.post({ type: 'server/event', payload: parsed });
    };

    this.server.on('status', this.serverStatusHandler);
    this.server.on('event', this.serverEventHandler);
    this.updateStatusBarItem();
  }

  async dispose() {
    await this.sessionState.persist();
    if (this.serverStatusHandler) this.server.off('status', this.serverStatusHandler);
    if (this.serverEventHandler) this.server.off('event', this.serverEventHandler);
    this.serverStatusHandler = undefined;
    this.serverEventHandler = undefined;
    this.statusBarItem.dispose();
  }

  private shouldSuppress(event: ServerEvent) {
    return getSessionIdsForEvent(event).some((sessionID) =>
      this.hiddenSessions.isHidden(sessionID)
    );
  }

  private shouldSuppressWorkspace(event: ServerEvent) {
    const workspacePath = this.workspace?.getPath();
    if (!normalizeWorkspacePath(workspacePath)) return false;

    const info = asRecord(asRecord(event.properties)?.info);
    const directory = typeof info?.directory === 'string' ? info.directory : undefined;
    if (directory) return !isDirectoryInWorkspace(directory, workspacePath);

    const sessionIDs = getSessionIdsForEvent(event);
    if (sessionIDs.length === 0) return false;
    return sessionIDs.some(
      (sessionID) => !this.sessionState.isSessionInWorkspace(sessionID, workspacePath)
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function isDirectoryInWorkspace(
  directory: string,
  workspacePath: string | null | undefined
): boolean {
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath);
  if (!normalizedWorkspace) return true;
  const normalizedDirectory = normalizeWorkspacePath(directory);
  return normalizedDirectory === normalizedWorkspace;
}

function normalizeWorkspacePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}
