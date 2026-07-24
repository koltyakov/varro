import { apiCall, onMessage, postMessage } from './bridge';
import { validateFileDiffs } from './validate-diffs';
import type {
  Session,
  MessageEntry,
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
  SessionDiffSummary,
  SessionTitleFallbackResponse,
  WorkspaceStatusEventSummary,
  WorkspaceFilePick,
} from '../../shared/protocol';
import { buildVarroSessionEndpoint, VARRO_API_ENDPOINTS } from '../../shared/protocol';
import { normalizeRecycleBinEntries } from '../../shared/recycle-bin';
import type {
  ProviderAuthAuthorization,
  ProviderAuthMethodsByProvider,
  WorkspaceStatusEntry,
} from '../../shared/opencode-types';

export type SessionMessagePage = MessageEntry[] & { nextCursor?: string };

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
    async create(
      body?: {
        title?: string;
        permission?: PermissionRule[];
        parentID?: string;
      },
      options?: { directory?: string }
    ): Promise<Session> {
      return apiCall<Session>('POST', withDirectory('/session', options?.directory), body || {});
    },
    async update(
      id: string,
      body: { title?: string; permission?: PermissionRule[] }
    ): Promise<Session> {
      return apiCall('PATCH', `/session/${id}`, body);
    },
    async fork(id: string, messageID?: string): Promise<Session> {
      return apiCall('POST', `/session/${id}/fork`, messageID ? { messageID } : undefined);
    },
    async delete(id: string): Promise<boolean> {
      return apiCall('DELETE', `/session/${id}`);
    },
    async abort(id: string): Promise<boolean> {
      return apiCall('POST', `/session/${id}/abort`);
    },
    async init(
      id: string,
      body: { messageID: string; providerID: string; modelID: string }
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
    async messages(
      id: string,
      options?: { limit?: number; before?: string }
    ): Promise<SessionMessagePage> {
      const params = new URLSearchParams();
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.before) params.set('before', options.before);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      const response = await apiCall<
        MessageEntry[] | { items: MessageEntry[]; nextCursor?: string }
      >('GET', `/session/${id}/message${query}`);
      if (Array.isArray(response)) return response;
      const items = response.items as SessionMessagePage;
      if (response.nextCursor) items.nextCursor = response.nextCursor;
      return items;
    },
    async deleteMessage(id: string, messageID: string): Promise<boolean> {
      return apiCall(
        'DELETE',
        `/session/${encodeURIComponent(id)}/message/${encodeURIComponent(messageID)}`
      );
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
      },
      options?: { directory?: string }
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
      await apiCall('POST', withDirectory(`/session/${id}/prompt_async`, options?.directory), rest);
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
    async revert(id: string, messageID: string): Promise<Session> {
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
    ): Promise<MessageEntry> {
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
      return apiCall('GET', `${VARRO_API_ENDPOINTS.providerLimit}?${params.toString()}`);
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
        return apiCall('DELETE', buildVarroSessionEndpoint(sessionID, 'delete'));
      },
      async diffSummary(sessionID: string): Promise<SessionDiffSummary> {
        return apiCall('GET', buildVarroSessionEndpoint(sessionID, 'diff-summary'));
      },
      async setPinned(sessionID: string, pinned: boolean): Promise<string[]> {
        return apiCall('POST', buildVarroSessionEndpoint(sessionID, 'pin'), { pinned });
      },
      async renameIfUntitled(sessionID: string): Promise<SessionTitleFallbackResponse> {
        return apiCall('POST', buildVarroSessionEndpoint(sessionID, 'rename-if-untitled'));
      },
    },
    async openPlan(content: string): Promise<{ path: string }> {
      return apiCall('POST', VARRO_API_ENDPOINTS.planOpen, { content });
    },
    async pickWorkspaceFile(): Promise<WorkspaceFilePick | null> {
      return apiCall('GET', VARRO_API_ENDPOINTS.workspaceFilePick);
    },
    async readWorkspaceFile(path: string): Promise<string | null> {
      const params = new URLSearchParams({ path });
      return apiCall('GET', `${VARRO_API_ENDPOINTS.workspaceFile}?${params.toString()}`);
    },
    async resolveWorkspacePath(path: string): Promise<{
      path: string;
      relativePath: string;
      type: 'file' | 'directory';
    } | null> {
      const params = new URLSearchParams({ path });
      return apiCall('GET', `${VARRO_API_ENDPOINTS.workspacePathResolve}?${params.toString()}`);
    },
    async openCodeConfig(): Promise<OpenCodeModelRouting> {
      return apiCall('GET', VARRO_API_ENDPOINTS.openCodeConfig);
    },
    async saveModelRouting(body: {
      target: 'small_model' | 'agent';
      providerID: string;
      modelID: string;
      agentName?: string;
    }): Promise<OpenCodeModelRouting> {
      return apiCall('POST', VARRO_API_ENDPOINTS.openCodeConfigModelRouting, body);
    },
    async judgePermission(body: AutoApproveJudgeRequest): Promise<AutoApproveJudgeResponse> {
      return apiCall('POST', VARRO_API_ENDPOINTS.permissionJudge, body);
    },
    recycleBin: {
      async list(): Promise<RecycleBinEntry[]> {
        return normalizeRecycleBinEntries(await apiCall('GET', VARRO_API_ENDPOINTS.sessionTrash));
      },
      async restore(rootID: string): Promise<boolean> {
        return apiCall(
          'POST',
          `${VARRO_API_ENDPOINTS.sessionTrash}/${encodeURIComponent(rootID)}/restore`
        );
      },
      async delete(rootID: string): Promise<boolean> {
        return apiCall(
          'DELETE',
          `${VARRO_API_ENDPOINTS.sessionTrash}/${encodeURIComponent(rootID)}/delete`
        );
      },
      async empty(): Promise<boolean> {
        return apiCall('DELETE', VARRO_API_ENDPOINTS.sessionTrash);
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
    async authenticate(name: string): Promise<unknown> {
      return apiCall('POST', `/mcp/${encodeURIComponent(name)}/auth/authenticate`);
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
    async list(): Promise<unknown[]> {
      return getSharedPermissionList();
    },
  },
};

function withDirectory(path: string, directory: string | undefined): string {
  if (!directory) return path;
  const params = new URLSearchParams({ directory });
  return `${path}?${params.toString()}`;
}

let fileStatusCache: {
  expiresAt: number;
  promise: Promise<RepoFileStatus[]>;
} | null = null;
const sessionStatusSlot: { current: Promise<Record<string, SessionStatus>> | null } = {
  current: null,
};
const questionListSlot: { current: Promise<QuestionRequest[]> | null } = { current: null };
const permissionListSlot: { current: Promise<unknown[]> | null } = { current: null };

function sharedRequest<T>(
  slot: { current: Promise<T> | null },
  factory: () => Promise<T>
): Promise<T> {
  if (slot.current) return slot.current;
  const promise = factory().finally(() => {
    if (slot.current === promise) slot.current = null;
  });
  slot.current = promise;
  return promise;
}

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
  return sharedRequest(sessionStatusSlot, () =>
    apiCall<Record<string, SessionStatus>>('GET', '/session/status')
  );
}

function getSharedQuestionList(): Promise<QuestionRequest[]> {
  return sharedRequest(questionListSlot, () => apiCall<QuestionRequest[]>('GET', '/question'));
}

function getSharedPermissionList(): Promise<unknown[]> {
  return sharedRequest(permissionListSlot, () => apiCall<unknown[]>('GET', '/permission'));
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
