import { apiCall, onMessage, postMessage } from './bridge';
import type {
  Session,
  Message,
  Part,
  SessionStatus,
  Agent,
  Provider,
  FileDiff,
  RepoFileStatus,
  QuestionRequest,
  PermissionRule,
} from '../types';
import type { ProviderLimitStatus, ServerEventName } from '../../shared/protocol';

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
    async create(body?: { title?: string; permission?: PermissionRule[] }): Promise<Session> {
      return apiCall('POST', '/session', body || {});
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
    async diff(id: string, messageID?: string): Promise<FileDiff[]> {
      const query = messageID ? `?messageID=${messageID}` : '';
      return apiCall('GET', `/session/${id}/diff${query}`);
    },
    async status(): Promise<Record<string, SessionStatus>> {
      return apiCall('GET', '/session/status');
    },
    async messages(id: string): Promise<Array<{ info: Message; parts: Part[] }>> {
      return apiCall('GET', `/session/${id}/message`);
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
        variant?: string;
      }
    ): Promise<void> {
      await apiCall('POST', `/session/${id}/prompt_async`, body);
    },
    async respondPermission(
      sessionId: string,
      permissionId: string,
      response: 'once' | 'always' | 'reject'
    ): Promise<boolean> {
      return apiCall('POST', `/session/${sessionId}/permissions/${permissionId}`, {
        response,
      });
    },
    async revert(id: string, messageID: string): Promise<boolean> {
      return apiCall('POST', `/session/${id}/revert`, { messageID });
    },
    async compact(id: string, model: { providerID: string; modelID: string }): Promise<boolean> {
      return apiCall('POST', `/session/${id}/summarize`, model);
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

  question: {
    async list(): Promise<QuestionRequest[]> {
      return apiCall('GET', '/question');
    },
    async reply(requestID: string, answers: Array<Array<string>>): Promise<boolean> {
      return apiCall('POST', `/question/${requestID}/reply`, { answers });
    },
    async reject(requestID: string): Promise<boolean> {
      return apiCall('POST', `/question/${requestID}/reject`);
    },
  },
};

let fileStatusCache:
  | {
      expiresAt: number;
      promise: Promise<RepoFileStatus[]>;
    }
  | null = null;

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

type EventHandler = (data: unknown) => void;

const eventListeners = new Map<string, Set<EventHandler>>();

onMessage((msg) => {
  if (msg.type !== 'server/event') return;
  const evt = msg.payload;
  const handlers = eventListeners.get(evt.type) as Set<EventHandler> | undefined;
  if (handlers) {
    for (const h of handlers) {
      try {
        h(evt);
      } catch (err) {
        postMessage({ type: 'log', payload: { msg: 'event handler error', error: String(err), level: 'error' } });
      }
    }
  }
  const wildcard = eventListeners.get('*') as Set<EventHandler> | undefined;
  if (wildcard) {
    for (const h of wildcard) {
      try {
        h(evt);
      } catch (err) {
        postMessage({ type: 'log', payload: { msg: 'wildcard handler error', error: String(err), level: 'error' } });
      }
    }
  }
});

export const serverEvents = {
  on(type: ServerEventName | '*', handler: EventHandler): () => void {
    if (!eventListeners.has(type)) eventListeners.set(type, new Set());
    eventListeners.get(type)!.add(handler);
    return () => eventListeners.get(type)?.delete(handler);
  },
};
