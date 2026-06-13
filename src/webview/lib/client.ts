import { apiCall, onMessage, postMessage } from './bridge';
import { validateFileDiffs } from './validate-diffs';
import type {
  Session,
  Message,
  Part,
  SessionStatus,
  Agent,
  Command,
  OpenCodeModelRouting,
  Provider,
  FileDiff,
  RepoFileStatus,
  QuestionRequest,
  PermissionRule,
  Todo,
} from '../types';
import type {
  AutoApproveJudgeRequest,
  AutoApproveJudgeResponse,
  McpStatus,
  ProviderLimitStatus,
  RecycleBinEntry,
  ServerEvent,
  ServerEventName,
  WorkspaceStatusEventSummary,
} from '../../shared/protocol';
import type {
  ProviderAuthAuthorization,
  ProviderAuthMethodsByProvider,
  WorkspaceStatusEntry,
} from '../../shared/opencode-types';

type RecycleBinSessionRecord = {
  id: string;
  projectID: string;
  directory: string;
  parentID?: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
  title: string;
  version: string;
  time: { created: number; updated: number; compacting?: number };
};

export const client = {
  async health(): Promise<{ healthy: boolean; version: string }> {
    return apiCall('GET', '/global/health');
  },

  session: {
    async list(): Promise<Session[]> {
      return apiCall('GET', '/session');
    },
    async get(id: string): Promise<Session> {
      return apiCall('GET', `/session/${id}`);
    },
    async create(body?: {
      title?: string;
      permission?: PermissionRule[];
      parentID?: string;
    }): Promise<Session> {
      // opencode 1.16 dropped `permission` from the create body (POST /session
      // 400s if it's present). Create with title/parentID only, then apply the
      // permission rules via the update endpoint, which still accepts them.
      const { permission, ...createBody } = body || {};
      const session = await apiCall<Session>('POST', '/session', createBody);
      if (permission && permission.length > 0) {
        return apiCall<Session>('PATCH', `/session/${session.id}`, { permission });
      }
      return session;
    },
    async update(
      id: string,
      body: { title?: string; permission?: PermissionRule[] }
    ): Promise<Session> {
      return apiCall('PATCH', `/session/${id}`, body);
    },
    async delete(id: string): Promise<boolean> {
      return apiCall('DELETE', `/session/${id}`);
    },
    async abort(id: string): Promise<boolean> {
      return apiCall('POST', `/session/${id}/abort`);
    },
    async init(
      id: string,
      body: { messageID?: string; providerID: string; modelID: string }
    ): Promise<boolean> {
      return apiCall('POST', `/session/${id}/init`, body);
    },
    async diff(id: string, messageID?: string): Promise<FileDiff[]> {
      const query = messageID ? `?messageID=${messageID}` : '';
      return apiCall('GET', `/session/${id}/diff${query}`).then(validateFileDiffs);
    },
    async status(): Promise<Record<string, SessionStatus>> {
      return getSharedSessionStatus();
    },
    async messages(id: string): Promise<Array<{ info: Message; parts: Part[] }>> {
      return apiCall('GET', `/session/${id}/message`);
    },
    async todos(id: string): Promise<Todo[]> {
      return apiCall('GET', `/session/${id}/todo`);
    },
    async sendAsync(
      id: string,
      body: {
        parts: Array<{
          type: string;
          text?: string;
          mime?: string;
          filename?: string;
          url?: string;
          [key: string]: unknown;
        }>;
        model?: { providerID: string; modelID: string };
        agent?: string;
        noReply?: boolean;
        delivery?: 'steer' | 'queue';
        variant?: string;
      }
    ): Promise<void> {
      // `delivery` is a client-side timing concern, not a server one. "Steer" means
      // inject this prompt into the turn that is already running: opencode's active
      // loop re-reads session history on every step, so a prompt_async sent mid-turn
      // is picked up on the next step. The v2 /api/session/:id/prompt endpoint admits
      // into a separate SessionInput store that the active (v1) loop never consumes,
      // so routing steer there dropped the message instead of steering. Always send
      // through prompt_async; the queue/steer distinction lives entirely in the UI
      // (queue holds the message until idle, steer sends it immediately).
      const { delivery: _delivery, ...rest } = body;
      await apiCall('POST', `/session/${id}/prompt_async`, rest);
    },
    async respondPermission(
      _sessionId: string,
      permissionId: string,
      response: 'once' | 'always' | 'reject'
    ): Promise<boolean> {
      return apiCall('POST', `/permission/${permissionId}/reply`, {
        reply: response,
      });
    },
    async revert(id: string, messageID: string): Promise<boolean> {
      return apiCall('POST', `/session/${id}/revert`, { messageID });
    },
    async unrevert(id: string): Promise<Session> {
      return apiCall('POST', `/session/${id}/unrevert`);
    },
    async compact(id: string, model: { providerID: string; modelID: string }): Promise<boolean> {
      return apiCall('POST', `/session/${id}/summarize`, model);
    },
    async command(
      id: string,
      body: {
        command: string;
        arguments: string;
        messageID?: string;
        agent?: string;
        model?: string;
      }
    ): Promise<{ info: Message; parts: Part[] }> {
      return apiCall('POST', `/session/${id}/command`, body);
    },
  },

  config: {
    async providers(): Promise<{
      providers: Provider[];
      default: Record<string, string>;
    }> {
      return apiCall('GET', '/config/providers');
    },
    async providerLimit(providerID: string, modelID?: string | null): Promise<ProviderLimitStatus> {
      const params = new URLSearchParams({ providerID });
      if (modelID) params.set('modelID', modelID);
      return apiCall('GET', `/varro/provider-limit?${params.toString()}`);
    },
    async providerAuth(): Promise<ProviderAuthMethodsByProvider> {
      return apiCall('GET', '/provider/auth');
    },
    async authorizeProvider(body: {
      providerID: string;
      method: number;
      inputs?: Record<string, string>;
    }): Promise<ProviderAuthAuthorization> {
      return apiCall('POST', `/provider/${encodeURIComponent(body.providerID)}/oauth/authorize`, {
        method: body.method,
        ...(body.inputs ? { inputs: body.inputs } : {}),
      });
    },
    async workspaceStatus(): Promise<WorkspaceStatusEntry[]> {
      return apiCall('GET', '/experimental/workspace/status');
    },
  },

  varro: {
    session: {
      async deleteImmediately(sessionID: string): Promise<boolean> {
        return apiCall('DELETE', `/varro/session/${encodeURIComponent(sessionID)}/delete`);
      },
    },
    async openPlan(content: string): Promise<{ path: string }> {
      return apiCall('POST', '/varro/plan/open', { content });
    },
    async pickWorkspaceFile(): Promise<string | null> {
      return apiCall('GET', '/varro/workspace-file/pick');
    },
    async readWorkspaceFile(path: string): Promise<string | null> {
      const params = new URLSearchParams({ path });
      return apiCall('GET', `/varro/workspace-file?${params.toString()}`);
    },
    async resolveWorkspacePath(path: string): Promise<{
      path: string;
      relativePath: string;
      type: 'file' | 'directory';
    } | null> {
      const params = new URLSearchParams({ path });
      return apiCall('GET', `/varro/workspace-path/resolve?${params.toString()}`);
    },
    async openCodeConfig(): Promise<OpenCodeModelRouting> {
      return apiCall('GET', '/varro/opencode-config');
    },
    async saveModelRouting(body: {
      target: 'small_model' | 'agent';
      providerID: string;
      modelID: string;
      agentName?: string;
    }): Promise<OpenCodeModelRouting> {
      return apiCall('POST', '/varro/opencode-config/model-routing', body);
    },
    async judgePermission(body: AutoApproveJudgeRequest): Promise<AutoApproveJudgeResponse> {
      return apiCall('POST', '/varro/permission/judge', body);
    },
    recycleBin: {
      async list(): Promise<RecycleBinEntry[]> {
        return normalizeRecycleBinEntries(await apiCall('GET', '/varro/session-trash'));
      },
      async restore(rootID: string): Promise<boolean> {
        return apiCall('POST', `/varro/session-trash/${encodeURIComponent(rootID)}/restore`);
      },
      async delete(rootID: string): Promise<boolean> {
        return apiCall('DELETE', `/varro/session-trash/${encodeURIComponent(rootID)}/delete`);
      },
      async empty(): Promise<boolean> {
        return apiCall('DELETE', '/varro/session-trash');
      },
    },
  },

  mcp: {
    async status(): Promise<Record<string, McpStatus>> {
      return apiCall('GET', '/mcp');
    },
    async connect(name: string): Promise<boolean> {
      return apiCall('POST', `/mcp/${encodeURIComponent(name)}/connect`);
    },
    async disconnect(name: string): Promise<boolean> {
      return apiCall('POST', `/mcp/${encodeURIComponent(name)}/disconnect`);
    },
  },

  file: {
    async status(): Promise<RepoFileStatus[]> {
      return getCachedFileStatus();
    },
  },

  agent: {
    async list(): Promise<Agent[]> {
      return apiCall('GET', '/agent');
    },
  },

  command: {
    async list(): Promise<Command[]> {
      return apiCall('GET', '/command');
    },
  },

  question: {
    async list(): Promise<QuestionRequest[]> {
      return getSharedQuestionList();
    },
    async reply(requestID: string, answers: Array<Array<string>>): Promise<boolean> {
      return apiCall('POST', `/question/${requestID}/reply`, { answers });
    },
    async reject(requestID: string): Promise<boolean> {
      return apiCall('POST', `/question/${requestID}/reject`);
    },
  },

  permission: {
    async list(): Promise<Array<Record<string, unknown>>> {
      return getSharedPermissionList();
    },
  },
};

let fileStatusCache: {
  expiresAt: number;
  promise: Promise<RepoFileStatus[]>;
} | null = null;
let sessionStatusRequest: Promise<Record<string, SessionStatus>> | null = null;
let questionListRequest: Promise<QuestionRequest[]> | null = null;
let permissionListRequest: Promise<Array<Record<string, unknown>>> | null = null;

function getCachedFileStatus(): Promise<RepoFileStatus[]> {
  const now = Date.now();
  if (fileStatusCache && fileStatusCache.expiresAt > now) return fileStatusCache.promise;
  const promise = apiCall<RepoFileStatus[]>('GET', '/file/status').catch((err) => {
    if (fileStatusCache?.promise === promise) fileStatusCache = null;
    throw err;
  });
  fileStatusCache = { expiresAt: now + 2_000, promise };
  return promise;
}

function getSharedSessionStatus(): Promise<Record<string, SessionStatus>> {
  if (sessionStatusRequest) return sessionStatusRequest;
  const promise = apiCall<Record<string, SessionStatus>>('GET', '/session/status').finally(() => {
    if (sessionStatusRequest === promise) sessionStatusRequest = null;
  });
  sessionStatusRequest = promise;
  return promise;
}

function getSharedQuestionList(): Promise<QuestionRequest[]> {
  if (questionListRequest) return questionListRequest;
  const promise = apiCall<QuestionRequest[]>('GET', '/question').finally(() => {
    if (questionListRequest === promise) questionListRequest = null;
  });
  questionListRequest = promise;
  return promise;
}

function getSharedPermissionList(): Promise<Array<Record<string, unknown>>> {
  if (permissionListRequest) return permissionListRequest;
  const promise = apiCall<Array<Record<string, unknown>>>('GET', '/permission').finally(() => {
    if (permissionListRequest === promise) permissionListRequest = null;
  });
  permissionListRequest = promise;
  return promise;
}

function normalizeRecycleBinEntries(value: unknown): RecycleBinEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeRecycleBinEntry).filter((entry): entry is RecycleBinEntry => !!entry);
}

function normalizeRecycleBinEntry(value: unknown): RecycleBinEntry | null {
  const record = asRecord(value);
  if (!record) return null;

  const rootID = typeof record.rootID === 'string' ? record.rootID : null;
  const deletedAt = typeof record.deletedAt === 'number' ? record.deletedAt : null;
  const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : null;
  const root = normalizeRecycleBinSession(record.root);
  const sessions = Array.isArray(record.sessions)
    ? record.sessions
        .map(normalizeRecycleBinSession)
        .filter((session): session is RecycleBinSessionRecord => !!session)
    : [];

  if (!rootID || deletedAt === null || expiresAt === null || !root || sessions.length === 0) {
    return null;
  }

  return { rootID, deletedAt, expiresAt, root, sessions };
}

function normalizeRecycleBinSession(value: unknown): RecycleBinSessionRecord | null {
  const record = asRecord(value);
  const time = asRecord(record?.time);
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.projectID !== 'string' ||
    typeof record.directory !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.version !== 'string' ||
    typeof time?.created !== 'number' ||
    typeof time.updated !== 'number'
  ) {
    return null;
  }

  const summary = asRecord(record.summary);
  return {
    id: record.id,
    projectID: record.projectID,
    directory: record.directory,
    ...(typeof record.parentID === 'string' ? { parentID: record.parentID } : {}),
    ...(summary &&
    typeof summary.additions === 'number' &&
    typeof summary.deletions === 'number' &&
    typeof summary.files === 'number'
      ? {
          summary: {
            additions: summary.additions,
            deletions: summary.deletions,
            files: summary.files,
          },
        }
      : {}),
    title: record.title,
    version: record.version,
    time: {
      created: time.created,
      updated: time.updated,
      ...(typeof time.compacting === 'number' ? { compacting: time.compacting } : {}),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

type EventHandler<TEvent extends ServerEvent = ServerEvent> = (data: TEvent) => void;

type ServerEventsApi = {
  on<TEventName extends ServerEventName>(
    type: TEventName,
    handler: EventHandler<Extract<ServerEvent, { type: TEventName }>>
  ): () => void;
  on(type: '*', handler: EventHandler<ServerEvent>): () => void;
};

const eventListeners = new Map<string, Set<EventHandler>>();
let workspaceStatusSummary: WorkspaceStatusEventSummary = { entries: [] };

onMessage((msg) => {
  if (msg.type !== 'server/event') return;
  const evt = msg.payload;
  if (evt.type === 'workspace.status') {
    const entry = normalizeWorkspaceStatusEntry(evt.properties);
    if (entry) {
      const existing = workspaceStatusSummary.entries.find(
        (item) => item.workspaceID === entry.workspaceID
      );
      if (!existing || existing.status !== entry.status) {
        workspaceStatusSummary = {
          ...workspaceStatusSummary,
          entries: [
            ...workspaceStatusSummary.entries.filter(
              (item) => item.workspaceID !== entry.workspaceID
            ),
            entry,
          ],
        };
      }
    }
  }
  if (evt.type === 'workspace.ready') {
    const message =
      typeof evt.properties?.name === 'string' ? evt.properties.name : 'Workspace connected';
    if (
      workspaceStatusSummary.latest?.type !== 'workspace.ready' ||
      workspaceStatusSummary.latest.message !== message
    ) {
      workspaceStatusSummary = {
        ...workspaceStatusSummary,
        latest: { type: 'workspace.ready', message },
      };
    }
  }
  if (evt.type === 'workspace.failed') {
    const message =
      typeof evt.properties?.message === 'string'
        ? evt.properties.message
        : 'Workspace connection failed';
    if (
      workspaceStatusSummary.latest?.type !== 'workspace.failed' ||
      workspaceStatusSummary.latest.message !== message
    ) {
      workspaceStatusSummary = {
        ...workspaceStatusSummary,
        latest: { type: 'workspace.failed', message },
      };
    }
  }
  const handlers = eventListeners.get(evt.type) as Set<EventHandler> | undefined;
  if (handlers) {
    for (const h of handlers) {
      try {
        h(evt);
      } catch (err) {
        postMessage({
          type: 'log',
          payload: { msg: 'event handler error', error: String(err), level: 'error' },
        });
      }
    }
  }
  const wildcard = eventListeners.get('*') as Set<EventHandler> | undefined;
  if (wildcard) {
    for (const h of wildcard) {
      try {
        h(evt);
      } catch (err) {
        postMessage({
          type: 'log',
          payload: { msg: 'wildcard handler error', error: String(err), level: 'error' },
        });
      }
    }
  }
});

export const serverEvents: ServerEventsApi = {
  on(type: ServerEventName | '*', handler: EventHandler): () => void {
    if (!eventListeners.has(type)) eventListeners.set(type, new Set());
    eventListeners.get(type)!.add(handler);
    return () => eventListeners.get(type)?.delete(handler);
  },
};

export function getWorkspaceStatusEventSummary() {
  return workspaceStatusSummary;
}

function normalizeWorkspaceStatusEntry(value: unknown): WorkspaceStatusEntry | null {
  const record = asRecord(value);
  if (!record || typeof record.workspaceID !== 'string') return null;
  if (
    record.status !== 'connected' &&
    record.status !== 'connecting' &&
    record.status !== 'disconnected' &&
    record.status !== 'error'
  ) {
    return null;
  }
  return { workspaceID: record.workspaceID, status: record.status };
}
