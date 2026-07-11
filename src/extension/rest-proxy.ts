import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { posix, win32 } from 'path';
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { VARRO_API_ENDPOINTS } from '../shared/protocol';
import type {
  AutoApproveJudgeReference,
  AutoApproveJudgeRequest,
  OpenCodeModelRouting,
  ServerStatus,
  SessionDiffSummary,
  WebviewMessage,
} from '../shared/protocol';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../shared/workspace-path';
import type { AutoApproveJudge } from './auto-approve-judge';
import type { HiddenSessionManager } from './hidden-session-manager';
import { isAllowedApiRequest } from './util/webview-message';
import type { ContextProvider } from './context-provider';
import { logger } from './logger';
import type { ProviderLimitService } from './provider-limit-service';
import type { PinnedSessionManager } from './pinned-session-manager';
import type { OpenCodeServer } from './server';
import type { OpenCodeResponseMetadata } from './open-code-transport';
import type { SessionBusyAttempt, SessionStateManager } from './session-state-manager';
import type { SessionTitleFallback } from './session-title-fallback';
import type { SessionDeleteTarget, SessionTrashManager } from './session-trash-manager';
import { asRecord, parseModelRoute } from './sidebar-provider-utils';
import {
  getOpenCodePlansDirectory,
  getPlanFileName,
  normalizePlanMarkdown,
} from './util/plan-file';
import { getRelativePath } from './util/path';

type ApiRequestPayload = Extract<WebviewMessage, { type: 'api/request' }>['payload'];
type ApiResponsePayload = { id: number; data?: unknown; error?: string };

type RecycleBinRequest =
  | { kind: 'list' }
  | { kind: 'empty' }
  | { kind: 'restore'; rootID: string }
  | { kind: 'delete'; rootID: string };

type PermanentDeleteRequest = { sessionID: string };

type OpenCodeConfigRequest =
  | { kind: 'get' }
  | {
      kind: 'update';
      target: 'small_model' | 'agent';
      providerID: string;
      modelID: string;
      agentName?: string;
    };

export { scopeOpenCodeRequest, getOpenCodeDirectoryHeaders } from './util/opencode-request';

export interface RestProxyCallbacks {
  server: Pick<OpenCodeServer, 'getWorkspaceCwd' | 'request'>;
  contextProvider: Pick<ContextProvider, 'context' | 'readFile' | 'resolvePath'>;
  providerLimitService: Pick<ProviderLimitService, 'get'>;
  sessionState: Pick<
    SessionStateManager,
    | 'handleServerEvent'
    | 'isSessionInWorkspace'
    | 'markSessionBusy'
    | 'deferPromptFailure'
    | 'reconcilePromptFailure'
    | 'removeSessions'
  >;
  sessionTrash: Pick<
    SessionTrashManager,
    | 'cleanupExpired'
    | 'deletePermanently'
    | 'empty'
    | 'filterVisibleSessionRequests'
    | 'filterVisibleSessions'
    | 'filterVisibleSessionStatuses'
    | 'isHidden'
    | 'list'
    | 'moveToTrash'
    | 'restore'
  >;
  pinnedSessions: Pick<PinnedSessionManager, 'setPinned'>;
  hiddenSessions: Pick<
    HiddenSessionManager,
    | 'filterVisibleSessionRequests'
    | 'filterVisibleSessionStatuses'
    | 'filterVisibleSessions'
    | 'isHidden'
  >;
  autoApproveJudge: Pick<AutoApproveJudge, 'judge'>;
  sessionTitleFallback: Pick<SessionTitleFallback, 'renameIfUntitled'>;
  simulateNoProviders: boolean;
  getRequestGeneration(): number;
  getStatus(): ServerStatus;
  ensureServerStarted(): Promise<string | undefined>;
  cleanupExpiredRecycleBin(): Promise<void>;
  postApiResponse(requestGeneration: number, payload: ApiResponsePayload): void;
}

export class RestProxy {
  constructor(private readonly callbacks: RestProxyCallbacks) {}

  async handleRequest(payload: ApiRequestPayload) {
    const requestGeneration = this.callbacks.getRequestGeneration();
    try {
      const method = payload.method.toUpperCase();
      if (!isAllowedApiRequest(method, payload.path)) {
        throw new Error('Unsupported API request');
      }

      const directSessionID = parseDirectSessionID(payload.path);
      if (directSessionID) {
        await this.assertSessionInCurrentWorkspace(directSessionID);
      }

      const recycleBinRequest = this.parseRecycleBinRequest(method, payload.path);
      if (recycleBinRequest) {
        const data = await this.handleRecycleBinRequest(recycleBinRequest);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const permanentDeleteRequest = this.parsePermanentDeleteRequest(method, payload.path);
      if (permanentDeleteRequest) {
        const data = await this.deleteSessionPermanently(permanentDeleteRequest.sessionID);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const pinRequest = this.parsePinRequest(method, payload.path, payload.body);
      if (pinRequest) {
        const data = await this.callbacks.pinnedSessions.setPinned(
          pinRequest.sessionID,
          pinRequest.pinned
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const planOpenRequest = this.parsePlanOpenRequest(method, payload.path, payload.body);
      if (planOpenRequest) {
        const data = await this.openPlanDocument(planOpenRequest.content);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
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
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const workspaceFileRequest = this.parseWorkspaceFileRequest(method, payload.path);
      if (workspaceFileRequest) {
        const data = await this.callbacks.contextProvider.readFile(workspaceFileRequest.path);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const workspaceResolveRequest = this.parseWorkspaceResolveRequest(method, payload.path);
      if (workspaceResolveRequest) {
        const data = await this.callbacks.contextProvider.resolvePath(workspaceResolveRequest.path);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (this.isWorkspaceFilePickRequest(method, payload.path)) {
        const data = await this.pickWorkspaceFile();
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (this.callbacks.getStatus().state !== 'running') {
        await this.callbacks.ensureServerStarted();
      }
      await this.callbacks.cleanupExpiredRecycleBin();

      const diffSummarySessionID = this.parseSessionDiffSummaryRequest(method, payload.path);
      if (diffSummarySessionID) {
        if (this.isHiddenSession(diffSummarySessionID)) {
          throw new Error('404 Session not found');
        }
        const data = await this.readSessionDiffSummary(diffSummarySessionID);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const judgePermissionRequest = this.parseJudgePermissionRequest(
        method,
        payload.path,
        payload.body
      );
      if (judgePermissionRequest) {
        const data = await this.callbacks.autoApproveJudge.judge(judgePermissionRequest);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const renameSessionID = this.parseRenameIfUntitledRequest(method, payload.path);
      if (renameSessionID) {
        const data = await this.callbacks.sessionTitleFallback.renameIfUntitled(renameSessionID);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const providerLimitRequest = this.parseProviderLimitRequest(method, payload.path);
      if (providerLimitRequest) {
        const data = await this.callbacks.providerLimitService.get(
          providerLimitRequest.providerID,
          providerLimitRequest.modelID
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (
        this.callbacks.simulateNoProviders &&
        method === 'GET' &&
        payload.path === '/config/providers'
      ) {
        this.callbacks.postApiResponse(requestGeneration, {
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
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      // Optimistically mark the session busy before the prompt is admitted.
      // opencode emits the SSE `session.status { busy }` event only after
      // admission, and on fast turns the finish can land first; pre-marking
      // here ensures the busy marker exists before any finish event arrives.
      const promptSessionID = this.parsePromptSessionID(method, payload.path);
      const promptAttempt = promptSessionID
        ? this.callbacks.sessionState.markSessionBusy(promptSessionID)
        : undefined;

      const paginatedMessages = this.isPaginatedMessagesRequest(method, payload.path);
      let response: unknown;
      try {
        response = paginatedMessages
          ? await this.callbacks.server.request(method, payload.path, payload.body, {
              captureNextCursor: true,
            })
          : await this.callbacks.server.request(method, payload.path, payload.body);
      } catch (err) {
        if (promptAttempt) await this.reconcileFailedPrompt(promptAttempt, err);
        throw err;
      }
      const data = paginatedMessages
        ? this.formatPaginatedMessagesResponse(
            method,
            payload.path,
            response as OpenCodeResponseMetadata
          )
        : this.filterApiResponse(method, payload.path, response);
      this.callbacks.postApiResponse(requestGeneration, {
        id: payload.id,
        data,
      });
    } catch (err) {
      this.callbacks.postApiResponse(requestGeneration, {
        id: payload.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private parseRecycleBinRequest(method: string, path: string): RecycleBinRequest | null {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === VARRO_API_ENDPOINTS.sessionTrash) {
      if (method === 'GET') return { kind: 'list' };
      if (method === 'DELETE') return { kind: 'empty' };
      return null;
    }

    const restoreMatch = url.pathname.match(/^\/varro\/session-trash\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      return { kind: 'restore', rootID: decodeURIComponent(restoreMatch[1]!) };
    }

    const deleteMatch = url.pathname.match(/^\/varro\/session-trash\/([^/]+)\/delete$/);
    if (deleteMatch && method === 'DELETE') {
      return { kind: 'delete', rootID: decodeURIComponent(deleteMatch[1]!) };
    }

    return null;
  }

  private parseSoftDeleteSessionRequest(method: string, path: string) {
    if (method !== 'DELETE') return null;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/session\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]!) : null;
  }

  private parsePromptSessionID(method: string, path: string): string | undefined {
    if (method.toUpperCase() !== 'POST') return undefined;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/session\/([^/]+)\/prompt(?:_async)?$/);
    return match ? decodeURIComponent(match[1]!) : undefined;
  }

  private async reconcileFailedPrompt(
    attempt: SessionBusyAttempt,
    requestError: unknown
  ): Promise<void> {
    if (isKnownPreAdmissionPromptFailure(requestError)) {
      this.callbacks.sessionState.reconcilePromptFailure(attempt, undefined);
      return;
    }
    try {
      const result = await this.callbacks.server.request('GET', '/session/status');
      const statuses = Array.isArray(result) ? undefined : asRecord(result);
      if (!statuses) {
        this.callbacks.sessionState.deferPromptFailure(attempt);
        return;
      }
      this.callbacks.sessionState.reconcilePromptFailure(attempt, statuses[attempt.sessionID]);
    } catch (err) {
      this.callbacks.sessionState.deferPromptFailure(attempt);
      logger.warn(
        `Failed to reconcile rejected prompt for ${attempt.sessionID}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private isPaginatedMessagesRequest(method: string, path: string) {
    if (method !== 'GET') return false;
    const url = new URL(path, 'http://localhost');
    return /^\/session\/[^/]+\/message$/.test(url.pathname) && url.searchParams.has('limit');
  }

  private formatPaginatedMessagesResponse(
    method: string,
    path: string,
    response: OpenCodeResponseMetadata
  ) {
    return {
      items: this.filterApiResponse(method, path, response.data),
      ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
    };
  }

  private parsePermanentDeleteRequest(method: string, path: string): PermanentDeleteRequest | null {
    if (method !== 'DELETE') return null;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/varro\/session\/([^/]+)\/delete$/);
    if (!match) return null;
    return { sessionID: decodeURIComponent(match[1]!) };
  }

  private parseSessionDiffSummaryRequest(method: string, path: string) {
    if (method !== 'GET') return null;
    const url = new URL(path, 'http://localhost');
    if (url.search) return null;
    const prefix = `${VARRO_API_ENDPOINTS.session}/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const match = url.pathname.slice(prefix.length).match(/^([^/]+)\/diff-summary$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }

  private parsePinRequest(method: string, path: string, body: unknown) {
    if (method !== 'POST') return null;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/varro\/session\/([^/]+)\/pin$/);
    if (!match) return null;
    const record = asRecord(body);
    if (typeof record?.pinned !== 'boolean') throw new Error('Invalid pin request');
    return { sessionID: decodeURIComponent(match[1]!), pinned: record.pinned };
  }

  private async readSessionDiffSummary(sessionID: string): Promise<SessionDiffSummary> {
    const encodedSessionID = encodeURIComponent(sessionID);
    const [diffs, messages] = await Promise.all([
      this.callbacks.server.request('GET', `/session/${encodedSessionID}/diff`),
      this.callbacks.server.request('GET', `/session/${encodedSessionID}/message`),
    ]);
    const diffStats = summarizeSessionDiff(diffs);
    return {
      ...(hasSessionEdits(diffStats) ? diffStats : summarizeSessionMessageEdits(messages)),
      tokens: summarizeSessionTokens(messages),
      ...summarizeSessionDuration(messages),
    };
  }

  private getHiddenSessionIdFromPath(path: string) {
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/session\/([^/]+)/);
    if (!match) return null;
    const sessionID = decodeURIComponent(match[1]!);
    return this.isHiddenSession(sessionID) ? sessionID : null;
  }

  private filterApiResponse(method: string, path: string, data: unknown) {
    const url = new URL(path, 'http://localhost');
    if (method === 'GET' && url.pathname === '/session' && Array.isArray(data)) {
      this.rememberSessionList(data);
      return this.callbacks.sessionTrash.filterVisibleSessions(
        this.callbacks.hiddenSessions.filterVisibleSessions(
          this.filterSessionsForCurrentWorkspace(data as Array<{ id: string; directory?: unknown }>)
        )
      );
    }
    if (
      method === 'GET' &&
      /^\/session\/[^/]+\/message$/.test(url.pathname) &&
      Array.isArray(data)
    ) {
      return this.sanitizeSessionMessages(url.pathname, data);
    }
    if (
      method === 'GET' &&
      url.pathname === '/session/status' &&
      data &&
      typeof data === 'object'
    ) {
      return this.callbacks.sessionTrash.filterVisibleSessionStatuses(
        this.callbacks.hiddenSessions.filterVisibleSessionStatuses(
          this.filterSessionStatusesForCurrentWorkspace(data as Record<string, unknown>)
        )
      );
    }
    if (method === 'GET' && url.pathname === '/question' && Array.isArray(data)) {
      return this.callbacks.sessionTrash.filterVisibleSessionRequests(
        this.callbacks.hiddenSessions.filterVisibleSessionRequests(
          this.filterSessionRequestsForCurrentWorkspace(data as Array<{ sessionID: string }>)
        )
      );
    }
    if (method === 'GET' && url.pathname === '/permission' && Array.isArray(data)) {
      return this.callbacks.sessionTrash.filterVisibleSessionRequests(
        this.callbacks.hiddenSessions.filterVisibleSessionRequests(
          this.filterSessionRequestsForCurrentWorkspace(data as Array<{ sessionID: string }>)
        )
      );
    }
    return data;
  }

  private rememberSessionList(sessions: unknown[]) {
    for (const session of sessions) {
      const info = asRecord(session);
      if (!info) continue;
      this.callbacks.sessionState.handleServerEvent({
        type: 'session.updated',
        properties: { info },
      });
    }
  }

  private filterSessionsForCurrentWorkspace<T extends { directory?: unknown }>(sessions: T[]) {
    const workspacePath = this.getCurrentWorkspacePath();
    if (!normalizeWorkspaceIdentity(workspacePath)) return sessions;
    return sessions.filter((session) => isDirectoryInWorkspace(session.directory, workspacePath));
  }

  private filterSessionStatusesForCurrentWorkspace<T>(statuses: Record<string, T>) {
    const workspacePath = this.getCurrentWorkspacePath();
    if (!normalizeWorkspaceIdentity(workspacePath)) return statuses;
    return Object.fromEntries(
      Object.entries(statuses).filter(([sessionID]) =>
        this.callbacks.sessionState.isSessionInWorkspace(sessionID, workspacePath)
      )
    );
  }

  private filterSessionRequestsForCurrentWorkspace<T extends { sessionID: string }>(requests: T[]) {
    const workspacePath = this.getCurrentWorkspacePath();
    if (!normalizeWorkspaceIdentity(workspacePath)) return requests;
    return requests.filter((request) =>
      this.callbacks.sessionState.isSessionInWorkspace(request.sessionID, workspacePath)
    );
  }

  private getCurrentWorkspacePath() {
    return (
      this.callbacks.contextProvider.context.workspacePath ||
      this.callbacks.server.getWorkspaceCwd()
    );
  }

  private async assertSessionInCurrentWorkspace(sessionID: string) {
    const workspacePath = this.getCurrentWorkspacePath();
    if (!normalizeWorkspaceIdentity(workspacePath)) return;
    if (this.callbacks.sessionState.isSessionInWorkspace(sessionID, workspacePath)) return;

    if (this.callbacks.getStatus().state !== 'running') {
      await this.callbacks.ensureServerStarted();
    }
    const directory = await this.lookupSessionDirectory(sessionID);
    if (!isSameWorkspacePath(directory, workspacePath)) {
      throw new Error('404 Session not found');
    }
  }

  private isHiddenSession(sessionID: string | null | undefined) {
    return (
      this.callbacks.sessionTrash.isHidden(sessionID) ||
      this.callbacks.hiddenSessions.isHidden(sessionID)
    );
  }

  private sanitizeSessionMessages(pathname: string, data: unknown[]) {
    let droppedEntries = 0;
    let droppedParts = 0;
    const normalized: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }> =
      [];

    for (const entry of data) {
      const record = asRecord(entry);
      const info = asRecord(record?.info);
      const time = asRecord(info?.time);
      if (
        !info ||
        typeof info.id !== 'string' ||
        !info.id ||
        typeof info.sessionID !== 'string' ||
        !info.sessionID ||
        (info.role !== 'user' && info.role !== 'assistant') ||
        typeof time?.created !== 'number'
      ) {
        droppedEntries += 1;
        continue;
      }

      const parts: Record<string, unknown>[] = [];
      if (Array.isArray(record?.parts)) {
        for (const part of record.parts) {
          const partRecord = asRecord(part);
          if (
            !partRecord ||
            typeof partRecord.id !== 'string' ||
            !partRecord.id ||
            typeof partRecord.messageID !== 'string' ||
            !partRecord.messageID ||
            typeof partRecord.sessionID !== 'string' ||
            !partRecord.sessionID ||
            typeof partRecord.type !== 'string' ||
            !partRecord.type
          ) {
            droppedParts += 1;
            continue;
          }
          parts.push(partRecord);
        }
      } else if (record?.parts !== undefined) {
        droppedParts += 1;
      }

      normalized.push({ info, parts });
    }

    if (droppedEntries > 0 || droppedParts > 0) {
      logger.warn(
        `Filtered malformed session message payload for ${pathname} (${droppedEntries} entries, ${droppedParts} parts)`
      );
    }

    return normalized;
  }

  private async handleRecycleBinRequest(request: RecycleBinRequest) {
    switch (request.kind) {
      case 'list':
        return this.callbacks.sessionTrash.list();
      case 'restore': {
        const restored = await this.callbacks.sessionTrash.restore(request.rootID);
        return Boolean(restored);
      }
      case 'delete': {
        const removed = await this.callbacks.sessionTrash.deletePermanently(
          request.rootID,
          (session) => this.deleteSessionForDirectory(session)
        );
        if (removed) {
          this.callbacks.sessionState.removeSessions(removed.sessions.map((session) => session.id));
        }
        return Boolean(removed);
      }
      case 'empty': {
        const removed = await this.callbacks.sessionTrash.empty((session) =>
          this.deleteSessionForDirectory(session)
        );
        if (removed.length > 0) {
          this.callbacks.sessionState.removeSessions(
            removed.flatMap((entry) => entry.sessions.map((session) => session.id))
          );
        }
        return true;
      }
    }
  }

  private async moveSessionToRecycleBin(sessionID: string) {
    const sessions = (await this.callbacks.server.request('GET', '/session')) as Array<
      Record<string, unknown>
    >;
    const entry = await this.callbacks.sessionTrash.moveToTrash(sessionID, sessions);
    if (!entry) {
      throw new Error('404 Session not found');
    }
    this.callbacks.sessionState.removeSessions(entry.sessions.map((session) => session.id));
    return true;
  }

  private async deleteSessionPermanently(sessionID: string) {
    const sessionDirectory = await this.lookupSessionDirectory(sessionID);
    await this.deleteSessionForDirectory({ id: sessionID, directory: sessionDirectory });
    this.callbacks.sessionState.removeSessions([sessionID]);
    return true;
  }

  private async deleteSessionForDirectory(session: SessionDeleteTarget) {
    const path = this.buildScopedSessionPath(session.id, session.directory);
    try {
      return await this.callbacks.server.request('DELETE', path);
    } catch (err) {
      // Sessions can predate the server's current ID format (legacy ULIDs get
      // a 500, not a 404), which would leave their trash entries undeletable.
      // Only propagate the failure when the session still exists server-side.
      if (await this.sessionExistsOnServer(session.id)) throw err;
      return true;
    }
  }

  private async sessionExistsOnServer(sessionID: string) {
    try {
      const sessions = await this.callbacks.server.request('GET', '/session');
      return (
        Array.isArray(sessions) && sessions.some((session) => asRecord(session)?.id === sessionID)
      );
    } catch {
      return true;
    }
  }

  private async lookupSessionDirectory(sessionID: string) {
    const sessions = await this.callbacks.server.request('GET', '/session');
    if (!Array.isArray(sessions)) return undefined;
    this.rememberSessionList(sessions);
    const match = sessions.find((session) => asRecord(session)?.id === sessionID);
    const record = asRecord(match);
    return typeof record?.directory === 'string' ? record.directory : undefined;
  }

  private buildScopedSessionPath(sessionID: string, directory?: string) {
    const path = `/session/${encodeURIComponent(sessionID)}`;
    return directory ? `${path}?directory=${encodeURIComponent(directory)}` : path;
  }

  private parseProviderLimitRequest(method: string, path: string) {
    if (method !== 'GET') return null;

    const url = new URL(path, 'http://localhost');
    if (url.pathname !== VARRO_API_ENDPOINTS.providerLimit) return null;

    const providerID = url.searchParams.get('providerID')?.trim();
    if (!providerID) return null;

    return {
      providerID,
      modelID: url.searchParams.get('modelID')?.trim() || null,
    };
  }

  private parseWorkspaceFileRequest(method: string, path: string) {
    if (method !== 'GET') return null;

    const url = new URL(path, 'http://localhost');
    if (url.pathname !== VARRO_API_ENDPOINTS.workspaceFile) return null;

    const filePath = url.searchParams.get('path')?.trim();
    if (!filePath) {
      throw new Error('Workspace file path is required');
    }

    return { path: filePath };
  }

  private isWorkspaceFilePickRequest(method: string, path: string) {
    return method === 'GET' && path === VARRO_API_ENDPOINTS.workspaceFilePick;
  }

  private parseWorkspaceResolveRequest(method: string, path: string) {
    if (method !== 'GET') return null;

    const url = new URL(path, 'http://localhost');
    if (url.pathname !== VARRO_API_ENDPOINTS.workspacePathResolve) return null;

    const filePath = url.searchParams.get('path')?.trim();
    if (!filePath) {
      throw new Error('Workspace path is required');
    }

    return { path: filePath };
  }

  private async pickWorkspaceFile(): Promise<string | null> {
    const result = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      title: 'Select Ralph plan document',
    });
    const selected = result?.[0];
    if (!selected) return null;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(selected);
    return workspaceFolder ? getRelativePath(selected, workspaceFolder) : selected.fsPath;
  }

  private parsePlanOpenRequest(method: string, path: string, body: unknown) {
    if (method !== 'POST' || path !== VARRO_API_ENDPOINTS.planOpen) return null;

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

  private parseOpenCodeConfigRequest(
    method: string,
    path: string,
    body: unknown
  ): OpenCodeConfigRequest | null {
    if (method === 'GET' && path === VARRO_API_ENDPOINTS.openCodeConfig) {
      return { kind: 'get' };
    }

    if (method !== 'POST' || path !== VARRO_API_ENDPOINTS.openCodeConfigModelRouting) return null;

    const payload = asRecord(body);
    const target = typeof payload?.target === 'string' ? payload.target : null;
    const providerID = typeof payload?.providerID === 'string' ? payload.providerID.trim() : '';
    const modelID = typeof payload?.modelID === 'string' ? payload.modelID.trim() : '';

    if (!target || !providerID || !modelID) {
      throw new Error('Invalid model routing update');
    }

    if (target === 'small_model') {
      return { kind: 'update', target, providerID, modelID };
    }

    if (target === 'agent') {
      const agentName = typeof payload?.agentName === 'string' ? payload.agentName.trim() : '';
      if (!agentName) {
        throw new Error('Agent name is required');
      }
      return { kind: 'update', target, agentName, providerID, modelID };
    }

    throw new Error('Unsupported model routing target');
  }

  private parseJudgePermissionRequest(
    method: string,
    path: string,
    body: unknown
  ): AutoApproveJudgeRequest | null {
    if (method !== 'POST' || path !== VARRO_API_ENDPOINTS.permissionJudge) return null;
    const payload = asRecord(body);
    const permission = asRecord(payload?.permission);
    if (!permission) throw new Error('Permission context is required');

    const rawModel = asRecord(payload?.model);
    const providerID = typeof rawModel?.providerID === 'string' ? rawModel.providerID.trim() : '';
    const modelID = typeof rawModel?.modelID === 'string' ? rawModel.modelID.trim() : '';
    const variant = typeof rawModel?.variant === 'string' ? rawModel.variant.trim() : '';
    return {
      permission,
      ...(providerID && modelID
        ? {
            model: {
              providerID,
              modelID,
              ...(variant ? { variant } : {}),
            },
          }
        : {}),
      approvedReferences: parseApprovedPermissionReferences(payload?.approvedReferences),
    };
  }

  private parseRenameIfUntitledRequest(method: string, path: string) {
    if (method !== 'POST') return null;
    const match = path.match(/^\/varro\/session\/([^/?#]+)\/rename-if-untitled$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }

  private getOpenCodeWorkspacePath() {
    const workspacePath =
      this.callbacks.contextProvider.context.workspacePath ||
      this.callbacks.server.getWorkspaceCwd();
    if (!workspacePath) {
      throw new Error('Open a workspace folder before editing project OpenCode config');
    }
    return getOpenCodePathApi(workspacePath).resolve(workspacePath);
  }

  private async readOpenCodeConfigObject() {
    const workspacePath = this.getOpenCodeWorkspacePath();
    const files: Array<{
      path: string;
      uri: vscode.Uri;
      raw: string;
      config: Record<string, unknown>;
    }> = [];
    const pathApi = getOpenCodePathApi(workspacePath);
    const candidates = resolveOpenCodeProjectConfigPaths(workspacePath, (path) =>
      pathApi.basename(path) === '.git' ? existsSync(path) : true
    );
    for (const path of candidates) {
      const uri = vscode.Uri.file(path);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const raw = new TextDecoder().decode(bytes);
        files.push({ path, uri, raw, config: parseOpenCodeConfig(raw, path) });
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err.code === 'FileNotFound' || err.code === 'ENOENT')
        ) {
          continue;
        }
        throw err;
      }
    }

    const config = files.reduce<Record<string, unknown>>(
      (merged, file) => mergeOpenCodeConfig(merged, file.config),
      {}
    );
    const localFiles = files.filter((file) => pathApi.dirname(file.path) === workspacePath);
    const target = localFiles.at(-1) || {
      path: pathApi.join(workspacePath, 'opencode.json'),
      uri: vscode.Uri.file(pathApi.join(workspacePath, 'opencode.json')),
      raw: '{}\n',
      config: {} as Record<string, unknown>,
    };
    return { workspacePath, files, config, target };
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

  private async updateOpenCodeModelRouting(
    request: Extract<OpenCodeConfigRequest, { kind: 'update' }>
  ): Promise<OpenCodeModelRouting> {
    const { files, target } = await this.readOpenCodeConfigObject();
    const { uri } = target;
    const dirtyDocument = vscode.workspace.textDocuments.find(
      (document) =>
        document.isDirty &&
        (document.uri.toString() === uri.toString() ||
          isSameWorkspacePath(document.uri.fsPath, uri.fsPath))
    );
    if (dirtyDocument) {
      throw new Error(
        `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} has unsaved changes; save or revert the document before updating model routing`
      );
    }
    const initialStat = await this.readConfigStat(uri);
    let nextRaw = target.raw.trim() ? target.raw : '{}\n';
    if (typeof target.config.$schema !== 'string' || !target.config.$schema.trim()) {
      nextRaw = applyJsoncChange(nextRaw, ['$schema'], 'https://opencode.ai/config.json');
    }

    const modelRef = `${request.providerID}/${request.modelID}`;
    if (request.target === 'small_model') {
      nextRaw = applyJsoncChange(nextRaw, ['small_model'], modelRef);
    } else {
      const agentName = request.agentName;
      if (!agentName) {
        throw new Error('Agent name is required');
      }
      nextRaw = applyJsoncChange(nextRaw, ['agent', agentName, 'model'], modelRef);
    }

    const nextTargetConfig = parseOpenCodeConfig(nextRaw, target.path);
    const encoded = new TextEncoder().encode(nextRaw.endsWith('\n') ? nextRaw : `${nextRaw}\n`);
    const latestStat = await this.readConfigStat(uri);
    if (!this.areConfigStatsEqual(initialStat, latestStat)) {
      throw new Error(
        `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} changed while updating model routing; please retry`
      );
    }
    await vscode.workspace.fs.writeFile(uri, encoded);
    let effectiveConfig = files.reduce<Record<string, unknown>>(
      (merged, file) =>
        mergeOpenCodeConfig(merged, file.path === target.path ? nextTargetConfig : file.config),
      {}
    );
    if (!files.some((file) => file.path === target.path)) {
      effectiveConfig = mergeOpenCodeConfig(effectiveConfig, nextTargetConfig);
    }
    return this.normalizeOpenCodeModelRouting(effectiveConfig);
  }

  private async readConfigStat(uri: vscode.Uri) {
    try {
      return await vscode.workspace.fs.stat(uri);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err.code === 'FileNotFound' || err.code === 'ENOENT')
      ) {
        return null;
      }
      throw err;
    }
  }

  private areConfigStatsEqual(left: vscode.FileStat | null, right: vscode.FileStat | null) {
    if (left === null || right === null) {
      return left === right;
    }
    return left.mtime === right.mtime && left.size === right.size;
  }

  private async openPlanDocument(content: string) {
    const normalized = normalizePlanMarkdown(content);
    if (!normalized) {
      throw new Error('Plan content is empty');
    }

    const plansDir = getOpenCodePlansDirectory();
    const filename = getPlanFileName(normalized);
    const directoryUri = vscode.Uri.file(plansDir);
    const fileUri = vscode.Uri.file(`${plansDir}/${filename}`);

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
}

export function resolveOpenCodeProjectConfigPaths(
  directory: string,
  pathExists: (path: string) => boolean = existsSync
) {
  const files: string[] = [];
  const pathApi = getOpenCodePathApi(directory);
  let current = pathApi.resolve(directory);
  while (true) {
    for (const name of ['opencode.jsonc', 'opencode.json']) {
      const candidate = pathApi.join(current, name);
      if (pathExists(candidate)) files.push(candidate);
    }
    if (pathExists(pathApi.join(current, '.git'))) break;
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files.toReversed();
}

function getOpenCodePathApi(path: string) {
  // VS Code can expose POSIX paths from remote workspaces even on Windows.
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') ? win32 : posix;
}

function parseOpenCodeConfig(raw: string, path: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Invalid OpenCode config at ${path}: ${printParseErrorCode(errors[0]!.error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`OpenCode config at ${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function mergeOpenCodeConfig(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = asRecord(merged[key]);
    const incoming = asRecord(value);
    merged[key] = current && incoming ? mergeOpenCodeConfig(current, incoming) : value;
  }
  return merged;
}

function applyJsoncChange(raw: string, path: (string | number)[], value: unknown) {
  return applyEdits(
    raw,
    modify(raw, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    })
  );
}

function summarizeSessionDiff(
  value: unknown
): Omit<SessionDiffSummary, 'tokens' | 'durationMs' | 'activeStartedAt'> {
  const record = asRecord(value);
  const candidates = Array.isArray(value)
    ? value
    : record && isDiffRecord(record)
      ? [record]
      : Object.values(record ?? {});
  const files: string[] = [];
  let validDiffs = 0;
  let additions = 0;
  let deletions = 0;

  for (const candidate of candidates) {
    const diff = asRecord(candidate);
    if (!diff || !isDiffRecord(diff)) continue;
    validDiffs += 1;
    if (
      typeof diff.file === 'string' &&
      diff.file &&
      !files.some((file) => isSameSummaryFile(file, diff.file as string))
    ) {
      files.push(diff.file);
    }
    additions += readDiffLineCount(diff.additions, diff.added);
    deletions += readDiffLineCount(diff.deletions, diff.removed);
  }

  return {
    files: files.length || validDiffs,
    additions,
    deletions,
  };
}

function isSameSummaryFile(left: string, right: string) {
  const leftPath = normalizeSummaryFile(left);
  const rightPath = normalizeSummaryFile(right);
  if (leftPath === rightPath) return true;

  if (isAbsoluteSummaryFile(leftPath) === isAbsoluteSummaryFile(rightPath)) return false;
  const [absolute, relative] = isAbsoluteSummaryFile(leftPath)
    ? [leftPath, rightPath]
    : [rightPath, leftPath];
  return absolute.endsWith(`/${relative}`);
}

function normalizeSummaryFile(path: string) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isAbsoluteSummaryFile(path: string) {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function summarizeSessionMessageEdits(
  value: unknown
): Omit<SessionDiffSummary, 'tokens' | 'durationMs' | 'activeStartedAt'> {
  if (!Array.isArray(value)) return { files: 0, additions: 0, deletions: 0 };

  const diffs: Record<string, unknown>[] = [];
  for (const entry of value) {
    const message = asRecord(entry);
    const info = asRecord(message?.info);
    const summary = asRecord(info?.summary);
    if (Array.isArray(summary?.diffs)) diffs.push(...summary.diffs.flatMap(asDiffRecord));

    if (!Array.isArray(message?.parts)) continue;
    for (const partValue of message.parts) {
      const part = asRecord(partValue);
      if (part?.type === 'patch' && Array.isArray(part.files)) {
        for (const file of part.files) {
          if (typeof file === 'string' && file) diffs.push({ file });
        }
        continue;
      }
      if (part?.type !== 'tool' || typeof part.tool !== 'string') continue;

      const state = asRecord(part.state);
      const metadata = asRecord(state?.metadata);
      if (Array.isArray(metadata?.files)) {
        for (const item of metadata.files) {
          const diff = asRecord(item);
          const file = diff && readFirstString(diff, ['relativePath', 'file', 'path', 'filePath']);
          if (!diff || !file) continue;
          diffs.push({ ...diff, file });
        }
        continue;
      }

      const tool = part.tool.trim().toLowerCase().split('.').pop() || '';
      if (!SESSION_FILE_CHANGE_TOOLS.has(tool)) continue;
      const input = asRecord(state?.input);
      const source = { ...metadata, ...input };
      const file = readFirstString(source, [
        'relativePath',
        'file',
        'path',
        'filePath',
        'filepath',
        'filename',
      ]);
      if (!file) continue;
      diffs.push({
        file,
        additions: source.additions ?? source.linesAdded,
        deletions: source.deletions ?? source.linesRemoved,
      });
    }
  }
  return summarizeSessionDiff(diffs);
}

function asDiffRecord(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  return record ? [record] : [];
}

function readFirstString(source: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function hasSessionEdits(
  stats: Omit<SessionDiffSummary, 'tokens' | 'durationMs' | 'activeStartedAt'>
) {
  return stats.files > 0 || stats.additions > 0 || stats.deletions > 0;
}

const SESSION_FILE_CHANGE_TOOLS = new Set([
  'apply_patch',
  'edit',
  'write',
  'create',
  'file_edit',
  'file_write',
  'file_create',
  'update_file',
  'replace',
  'insert',
  'apply_edit',
  'apply_diff',
  'delete',
  'remove',
  'unlink',
  'rm',
  'file_delete',
  'file_remove',
  'move',
  'mv',
  'rename',
  'file_move',
  'file_rename',
]);

function summarizeSessionTokens(value: unknown): number {
  if (!Array.isArray(value)) return 0;

  let total = 0;
  for (const entry of value) {
    const info = asRecord(asRecord(entry)?.info);
    if (info?.role !== 'assistant') continue;
    const tokens = asRecord(info.tokens);
    if (!tokens) continue;

    if (isTokenCount(tokens.total) && tokens.total > 0) {
      total += tokens.total;
      continue;
    }

    const cache = asRecord(tokens.cache);
    total +=
      readTokenCount(tokens.input) +
      readTokenCount(tokens.output) +
      readTokenCount(tokens.reasoning) +
      readTokenCount(cache?.read) +
      readTokenCount(cache?.write);
  }
  return total;
}

function summarizeSessionDuration(
  value: unknown
): Pick<SessionDiffSummary, 'durationMs' | 'activeStartedAt'> {
  if (!Array.isArray(value)) return { durationMs: 0, activeStartedAt: null };

  let total = 0;
  let promptStartedAt: number | null = null;
  let firstAssistantCreatedAt: number | null = null;
  let latestCompletedAt: number | null = null;
  let lastAssistantCompleted = false;

  const flush = () => {
    if (lastAssistantCompleted && latestCompletedAt !== null) {
      const startedAt = promptStartedAt ?? firstAssistantCreatedAt;
      if (startedAt !== null) total += Math.max(0, latestCompletedAt - startedAt);
    }
    promptStartedAt = null;
    firstAssistantCreatedAt = null;
    latestCompletedAt = null;
    lastAssistantCompleted = false;
  };

  for (const entry of value) {
    const info = asRecord(asRecord(entry)?.info);
    if (info?.role !== 'assistant') {
      flush();
      if (info?.role === 'user') promptStartedAt = readTimestamp(asRecord(info.time)?.created);
      continue;
    }
    if (info.mode === 'subagent') continue;

    const time = asRecord(info.time);
    firstAssistantCreatedAt ??= readTimestamp(time?.created);
    const completedAt = readTimestamp(time?.completed);
    lastAssistantCompleted = completedAt !== null;
    if (completedAt !== null) {
      latestCompletedAt = Math.max(latestCompletedAt ?? completedAt, completedAt);
    }
  }

  const activeStartedAt = lastAssistantCompleted
    ? null
    : (promptStartedAt ?? firstAssistantCreatedAt);
  flush();
  return { durationMs: total, activeStartedAt };
}

function readTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readTokenCount(value: unknown): number {
  return isTokenCount(value) ? value : 0;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDiffRecord(value: Record<string, unknown>) {
  return (
    typeof value.file === 'string' ||
    isDiffLineCount(value.additions) ||
    isDiffLineCount(value.deletions) ||
    isDiffLineCount(value.added) ||
    isDiffLineCount(value.removed)
  );
}

function readDiffLineCount(primary: unknown, fallback: unknown) {
  if (isDiffLineCount(primary)) return primary;
  return isDiffLineCount(fallback) ? fallback : 0;
}

function isDiffLineCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseDirectSessionID(path: string): string | null {
  const pathname = new URL(path, 'http://localhost').pathname;
  if (pathname === '/session/status') return null;
  const match = pathname.match(/^\/(?:varro\/)?session\/([^/]+)(?:\/|$)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function parseApprovedPermissionReferences(value: unknown): AutoApproveJudgeReference[] {
  if (!Array.isArray(value)) return [];
  const references: AutoApproveJudgeReference[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const type = typeof record.type === 'string' ? record.type.trim() : '';
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const response =
      record.response === 'always' ? 'always' : record.response === 'once' ? 'once' : null;
    if (!type || !title || !response) continue;
    const patternValue = record.pattern;
    const pattern = Array.isArray(patternValue)
      ? patternValue.filter((entry): entry is string => typeof entry === 'string')
      : typeof patternValue === 'string'
        ? patternValue
        : undefined;
    const metadata = asRecord(record.metadata);
    references.push({
      type,
      title,
      response,
      ...(pattern !== undefined ? { pattern } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }
  return references.slice(-20);
}

function isDirectoryInWorkspace(
  directory: unknown,
  workspacePath: string | null | undefined
): boolean {
  if (!normalizeWorkspaceIdentity(workspacePath)) return true;
  return isSameWorkspacePath(typeof directory === 'string' ? directory : undefined, workspacePath);
}

function isKnownPreAdmissionPromptFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /^4\d{2}(?:\s|$)/.test(message) ||
    message.includes('OpenCode server is not accepting requests while stopping')
  );
}
