import type * as vscode from 'vscode';
import type { ExtensionMessage, ServerEvent, ServerStatus } from '../shared/protocol';
import { parseServerEvent } from '../shared/protocol';
import type { OpenCodeServer } from './server';
import type { SessionStateManager } from './session-state-manager';
import type { SidebarProviderRuntime } from './sidebar-provider-runtime';

export interface SidebarProviderCoordinatorDeps {
  server: Pick<OpenCodeServer, 'on' | 'off'>;
  sessionState: Pick<SessionStateManager, 'handleServerEvent' | 'persist'>;
  runtime: Pick<SidebarProviderRuntime, 'shouldSuppressServerEvent'>;
  providerLimitService: {
    shouldClearCache(previousStatus: ServerStatus, nextStatus: ServerStatus): boolean;
    clearCache(): void;
  };
  getStatus(): ServerStatus;
  setStatus(status: ServerStatus): void;
  post(message: ExtensionMessage): void;
  updateStatusBarItem(): void;
  createStatusBarItem(): vscode.StatusBarItem;
  disposeThemeListener(): void;
  disposeConfigListener(): void;
  disposeWindowStateListener(): void;
  disposeWebviewDisposables(): void;
  disposeSearch(): void;
  disposeDroppedFiles(): Promise<void>;
}

export class SidebarProviderCoordinator {
  private serverStatusHandler: ((status: ServerStatus) => void) | undefined;
  private serverEventHandler: ((event: unknown) => void) | undefined;
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(private readonly deps: SidebarProviderCoordinatorDeps) {
    this.statusBarItem = deps.createStatusBarItem();
  }

  getStatusBarItem() {
    return this.statusBarItem;
  }

  attachServerSubscriptions() {
    this.serverStatusHandler = (status: ServerStatus) => {
      const previousStatus = this.deps.getStatus();
      this.deps.setStatus(status);
      if (this.deps.providerLimitService.shouldClearCache(previousStatus, status)) {
        this.deps.providerLimitService.clearCache();
      }
      this.deps.post({ type: 'server/status', payload: status });
    };

    this.serverEventHandler = (event: unknown) => {
      const evt = parseServerEvent(event);
      if (!evt) return;
      if (this.deps.runtime.shouldSuppressServerEvent(evt as ServerEvent)) return;
      this.deps.sessionState.handleServerEvent(evt);
      this.deps.post({
        type: 'server/event',
        payload: evt as ServerEvent,
      });
    };

    this.deps.server.on('status', this.serverStatusHandler);
    this.deps.server.on('event', this.serverEventHandler);
    this.deps.updateStatusBarItem();
  }

  async dispose() {
    await this.deps.sessionState.persist();
    if (this.serverStatusHandler) this.deps.server.off('status', this.serverStatusHandler);
    if (this.serverEventHandler) this.deps.server.off('event', this.serverEventHandler);
    this.serverStatusHandler = undefined;
    this.serverEventHandler = undefined;
    this.deps.disposeWebviewDisposables();
    this.deps.disposeThemeListener();
    this.deps.disposeConfigListener();
    this.deps.disposeWindowStateListener();
    this.statusBarItem.dispose();
    this.deps.disposeSearch();
    await this.deps.disposeDroppedFiles();
  }
}
