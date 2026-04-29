import type * as vscode from 'vscode';
import type { ServerEvent, ServerStatus } from '../shared/protocol';
import { errorHub } from './error-hub';
import { logger } from './logger';
import type { OpenCodeServer } from './server';
import type { SessionStateManager } from './session-state-manager';
import type { SessionTrashManager } from './session-trash-manager';
import { getSessionIdsForEvent } from './sidebar-provider-utils';

export class SidebarProviderRuntime {
  private recycleBinMaintenanceInFlight = false;
  private lastRecycleBinCleanupAt = 0;
  private serverStartErrorMessage: string | null = null;

  constructor(
    private readonly server: Pick<OpenCodeServer, 'request' | 'start' | 'status'>,
    private readonly sessionState: Pick<SessionStateManager, 'removeSessions'>,
    private readonly sessionTrash: Pick<
      SessionTrashManager,
      'cleanupExpired' | 'isHidden' | 'list'
    >,
    private readonly recycleBinCleanupIntervalMs: number
  ) {}

  async ensureServerStarted() {
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

  async cleanupExpiredRecycleBin(status: ServerStatus, onUpdate: () => void) {
    if (this.recycleBinMaintenanceInFlight || status.state !== 'running') return;
    const now = Date.now();
    if (now - this.lastRecycleBinCleanupAt < this.recycleBinCleanupIntervalMs) return;
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
        onUpdate();
      }
    } finally {
      this.recycleBinMaintenanceInFlight = false;
    }
  }

  shouldSuppressServerEvent(event: ServerEvent) {
    return getSessionIdsForEvent(event).some((sessionID) => this.sessionTrash.isHidden(sessionID));
  }

  recycleBinEntries() {
    return this.sessionTrash.list();
  }

  postApiResponse(
    view: vscode.WebviewView | undefined,
    requestGeneration: number,
    webviewLoadGeneration: number,
    post: (msg: {
      type: 'api/response';
      payload: { id: number; data?: unknown; error?: string };
    }) => void,
    payload: { id: number; data?: unknown; error?: string }
  ) {
    if (!view || requestGeneration !== webviewLoadGeneration) return;
    post({ type: 'api/response', payload });
  }
}
