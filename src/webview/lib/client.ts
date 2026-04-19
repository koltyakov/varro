import { apiCall, onMessage } from './bridge';
import type {
  Session,
  Message,
  Part,
  SessionStatus,
  Agent,
  Provider,
  FileDiff,
  QuestionRequest,
} from '../types';

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
    async create(body?: { title?: string }): Promise<Session> {
      return apiCall('POST', '/session', body || {});
    },
    async delete(id: string): Promise<boolean> {
      return apiCall('DELETE', `/session/${id}`);
    },
    async abort(id: string): Promise<boolean> {
      return apiCall('POST', `/session/${id}/abort`);
    },
    async share(id: string): Promise<Session> {
      return apiCall('POST', `/session/${id}/share`);
    },
    async unshare(id: string): Promise<Session> {
      return apiCall('DELETE', `/session/${id}/share`);
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
      response: string,
      remember?: boolean
    ): Promise<boolean> {
      return apiCall('POST', `/session/${sessionId}/permissions/${permissionId}`, {
        response,
        remember,
      });
    },
    async revert(id: string, messageID: string): Promise<boolean> {
      return apiCall('POST', `/session/${id}/revert`, { messageID });
    },
  },

  config: {
    async providers(): Promise<{
      providers: Provider[];
      default: Record<string, string>;
    }> {
      return apiCall('GET', '/config/providers');
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

type EventHandler = (data: unknown) => void;

const eventListeners = new Map<string, Set<EventHandler>>();

onMessage((msg) => {
  if (msg.type !== 'server/event') return;
  const evt = msg.payload;
  const handlers = eventListeners.get(evt.type) as Set<EventHandler> | undefined;
  if (handlers) {
    for (const h of handlers) h(evt);
  }
  const wildcard = eventListeners.get('*') as Set<EventHandler> | undefined;
  if (wildcard) {
    for (const h of wildcard) h(evt);
  }
});

export const serverEvents = {
  on(type: string, handler: EventHandler): () => void {
    if (!eventListeners.has(type)) eventListeners.set(type, new Set());
    eventListeners.get(type)!.add(handler);
    return () => eventListeners.get(type)?.delete(handler);
  },
};
