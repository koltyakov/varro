import { createSignal, onCleanup } from "solid-js"
import { apiCall } from "./bridge"
import type {
  Session,
  Message,
  Part,
  SessionStatus,
  Agent,
  Model,
  Provider,
  Permission,
  Todo,
  FileDiff,
} from "../types"

export const client = {
  async health(): Promise<{ healthy: boolean; version: string }> {
    return apiCall("GET", "/global/health")
  },

  session: {
    async list(): Promise<Session[]> {
      return apiCall("GET", "/session")
    },
    async get(id: string): Promise<Session> {
      return apiCall("GET", `/session/${id}`)
    },
    async create(body?: { title?: string }): Promise<Session> {
      return apiCall("POST", "/session", body || {})
    },
    async delete(id: string): Promise<boolean> {
      return apiCall("DELETE", `/session/${id}`)
    },
    async abort(id: string): Promise<boolean> {
      return apiCall("POST", `/session/${id}/abort`)
    },
    async share(id: string): Promise<Session> {
      return apiCall("POST", `/session/${id}/share`)
    },
    async unshare(id: string): Promise<Session> {
      return apiCall("DELETE", `/session/${id}/share`)
    },
    async diff(id: string, messageID?: string): Promise<FileDiff[]> {
      const query = messageID ? `?messageID=${messageID}` : ""
      return apiCall("GET", `/session/${id}/diff${query}`)
    },
    async status(): Promise<Record<string, SessionStatus>> {
      return apiCall("GET", "/session/status")
    },
    async messages(id: string): Promise<Array<{ info: Message; parts: Part[] }>> {
      return apiCall("GET", `/session/${id}/message`)
    },
    async send(
      id: string,
      body: {
        parts: Array<{ type: string; text?: string; [key: string]: unknown }>
        model?: { providerID: string; modelID: string }
        agent?: string
      },
    ): Promise<{ info: Message; parts: Part[] }> {
      return apiCall("POST", `/session/${id}/message`, body)
    },
    async sendAsync(
      id: string,
      body: {
        parts: Array<{ type: string; text?: string; [key: string]: unknown }>
        model?: { providerID: string; modelID: string }
        agent?: string
      },
    ): Promise<void> {
      await apiCall("POST", `/session/${id}/prompt_async`, body)
    },
    async respondPermission(
      sessionId: string,
      permissionId: string,
      response: string,
      remember?: boolean,
    ): Promise<boolean> {
      return apiCall("POST", `/session/${sessionId}/permissions/${permissionId}`, {
        response,
        remember,
      })
    },
    async revert(id: string, messageID: string): Promise<boolean> {
      return apiCall("POST", `/session/${id}/revert`, { messageID })
    },
  },

  config: {
    async providers(): Promise<{
      providers: Provider[]
      default: Record<string, string>
    }> {
      return apiCall("GET", "/config/providers")
    },
  },

  agent: {
    async list(): Promise<Agent[]> {
      return apiCall("GET", "/agent")
    },
  },
}

export function createEventSource() {
  const [connected, setConnected] = createSignal(false)
  let source: EventSource | null = null
  const listeners = new Map<string, Set<(data: any) => void>>()

  function start(serverUrl: string) {
    if (source) source.close()

    source = new EventSource(`${serverUrl}/event`)

    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)

    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as { type: string; [key: string]: unknown }
        const handlers = listeners.get(parsed.type)
        if (handlers) {
          for (const handler of handlers) {
            handler(parsed)
          }
        }
        const wildcardHandlers = listeners.get("*")
        if (wildcardHandlers) {
          for (const handler of wildcardHandlers) {
            handler(parsed)
          }
        }
      } catch {}
    }
  }

  function on(type: string, handler: (data: any) => void): () => void {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(handler)
    return () => listeners.get(type)?.delete(handler)
  }

  function stop() {
    source?.close()
    source = null
    setConnected(false)
  }

  onCleanup(() => stop())

  return { start, stop, on, connected }
}
