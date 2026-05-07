import * as vscode from 'vscode';
import type { OpenCodeModelRouting, ServerStatus, WebviewMessage } from '../shared/protocol';
import { isAllowedApiRequest } from './util/webview-message';
import type { ContextProvider } from './context-provider';
import { logger } from './logger';
import type { ProviderLimitService } from './provider-limit-service';
import type { OpenCodeServer } from './server';
import type { SessionStateManager } from './session-state-manager';
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

export function scopeOpenCodeRequest(baseUrl: string, path: string, directory?: string) {
  const url = new URL(path, baseUrl);
  if (!path.startsWith('/') || path.startsWith('//') || url.origin !== baseUrl) {
    throw new Error('Unsupported OpenCode API path');
  }

  const normalizedDirectory = normalizeOpenCodeDirectory(directory);
  const hasExplicitDirectory = url.searchParams.has('directory');
  const explicitDirectory = hasExplicitDirectory
    ? normalizeOpenCodeDirectory(url.searchParams.get('directory') || undefined)
    : undefined;

  if (!url.pathname.startsWith('/global/')) {
    if (explicitDirectory) {
      url.searchParams.set('directory', explicitDirectory);
    } else if (hasExplicitDirectory) {
      url.searchParams.delete('directory');
    } else if (normalizedDirectory) {
      url.searchParams.set('directory', normalizedDirectory);
    }
  }

  const scopedDirectory = !url.pathname.startsWith('/global/')
    ? (explicitDirectory ?? normalizedDirectory)
    : normalizedDirectory;

  return { url: url.toString(), directory: scopedDirectory };
}

export function getOpenCodeDirectoryHeaders(directory?: string): Record<string, string> {
  if (!directory) return {};
  return { 'x-opencode-directory': encodeURIComponent(directory) };
}

function normalizeOpenCodeDirectory(directory: string | undefined) {
  if (!directory) return undefined;
  const trimmed = directory.trim();
  if (!trimmed) return undefined;
  // Preserve the original directory spelling. OpenCode session lookups on
  // Windows have regressed when Varro rewrote drive casing or path separators.
  // We only trim trailing separators so equivalent user input stays stable
  // without changing the underlying path identity.
  const normalized = trimmed.replace(/[\\/]+$/, '');
  return normalized || trimmed;
}

export interface RestProxyCallbacks {
  server: Pick<OpenCodeServer, 'getWorkspaceCwd' | 'request'>;
  contextProvider: Pick<ContextProvider, 'context' | 'readFile'>;
  providerLimitService: Pick<ProviderLimitService, 'get'>;
  sessionState: Pick<SessionStateManager, 'removeSessions'>;
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

      if (this.isWorkspaceFilePickRequest(method, payload.path)) {
        const data = await this.pickWorkspaceFile();
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (this.callbacks.getStatus().state !== 'running') {
        await this.callbacks.ensureServerStarted();
      }
      await this.callbacks.cleanupExpiredRecycleBin();

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

      const data = await this.callbacks.server.request(method, payload.path, payload.body);
      this.callbacks.postApiResponse(requestGeneration, {
        id: payload.id,
        data: this.filterApiResponse(method, payload.path, data),
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
    if (url.pathname === '/varro/session-trash') {
      if (method === 'GET') return { kind: 'list' };
      if (method === 'DELETE') return { kind: 'empty' };
      return null;
    }

    const restoreMatch = url.pathname.match(/^\/varro\/session-trash\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      return { kind: 'restore', rootID: decodeURIComponent(restoreMatch[1]) };
    }

    const deleteMatch = url.pathname.match(/^\/varro\/session-trash\/([^/]+)\/delete$/);
    if (deleteMatch && method === 'DELETE') {
      return { kind: 'delete', rootID: decodeURIComponent(deleteMatch[1]) };
    }

    return null;
  }

  private parseSoftDeleteSessionRequest(method: string, path: string) {
    if (method !== 'DELETE') return null;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/session\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  private parsePermanentDeleteRequest(method: string, path: string): PermanentDeleteRequest | null {
    if (method !== 'DELETE') return null;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/varro\/session\/([^/]+)\/delete$/);
    if (!match) return null;
    return { sessionID: decodeURIComponent(match[1]) };
  }

  private getHiddenSessionIdFromPath(path: string) {
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/session\/([^/]+)/);
    if (!match) return null;
    const sessionID = decodeURIComponent(match[1]);
    return this.callbacks.sessionTrash.isHidden(sessionID) ? sessionID : null;
  }

  private filterApiResponse(method: string, path: string, data: unknown) {
    const url = new URL(path, 'http://localhost');
    if (method === 'GET' && url.pathname === '/session' && Array.isArray(data)) {
      return this.callbacks.sessionTrash.filterVisibleSessions(data as Array<{ id: string }>);
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
        data as Record<string, unknown>
      );
    }
    if (method === 'GET' && url.pathname === '/question' && Array.isArray(data)) {
      return this.callbacks.sessionTrash.filterVisibleSessionRequests(
        data as Array<{ sessionID: string }>
      );
    }
    return data;
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
    const entry = await this.callbacks.sessionTrash.moveToTrash(sessionID, sessions as never[]);
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
    return this.callbacks.server.request('DELETE', path);
  }

  private async lookupSessionDirectory(sessionID: string) {
    const sessions = await this.callbacks.server.request('GET', '/session');
    if (!Array.isArray(sessions)) return undefined;
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
    if (url.pathname !== '/varro/provider-limit') return null;

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
    if (url.pathname !== '/varro/workspace-file') return null;

    const filePath = url.searchParams.get('path')?.trim();
    if (!filePath) {
      throw new Error('Workspace file path is required');
    }

    return { path: filePath };
  }

  private isWorkspaceFilePickRequest(method: string, path: string) {
    return method === 'GET' && path === '/varro/workspace-file/pick';
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

  private parseOpenCodeConfigRequest(
    method: string,
    path: string,
    body: unknown
  ): OpenCodeConfigRequest | null {
    if (method === 'GET' && path === '/varro/opencode-config') {
      return { kind: 'get' };
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

  private getOpenCodeConfigUri() {
    const workspacePath =
      this.callbacks.contextProvider.context.workspacePath ||
      this.callbacks.server.getWorkspaceCwd();
    if (!workspacePath) {
      throw new Error('Open a workspace folder before editing project opencode.json');
    }
    return vscode.Uri.file(`${workspacePath}/opencode.json`);
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

  private async updateOpenCodeModelRouting(
    request: Extract<OpenCodeConfigRequest, { kind: 'update' }>
  ): Promise<OpenCodeModelRouting> {
    const { uri, config } = await this.readOpenCodeConfigObject();
    const initialStat = await this.readConfigStat(uri);
    const next = { ...config };
    if (typeof next.$schema !== 'string' || !next.$schema.trim()) {
      next.$schema = 'https://opencode.ai/config.json';
    }

    const modelRef = `${request.providerID}/${request.modelID}`;
    if (request.target === 'small_model') {
      next.small_model = modelRef;
    } else {
      const agentName = request.agentName;
      if (!agentName) {
        throw new Error('Agent name is required');
      }
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
    const latestStat = await this.readConfigStat(uri);
    if (!this.areConfigStatsEqual(initialStat, latestStat)) {
      throw new Error('Project opencode.json changed while updating model routing; please retry');
    }
    await vscode.workspace.fs.writeFile(uri, encoded);
    return this.normalizeOpenCodeModelRouting(next);
  }

  private async readConfigStat(uri: vscode.Uri) {
    try {
      return await vscode.workspace.fs.stat(uri);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'FileNotFound') {
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
