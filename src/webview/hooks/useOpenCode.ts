import { onMount, onCleanup } from "solid-js"
import { client, serverEvents } from "../lib/client"
import {
  state,
  setState,
  setSelectedAgent,
  setSelectedModel,
  resolveSelectedModel,
  setTheme,
  setIsLoading,
  setError,
  clearClipboardImages,
  clearMessages,
  upsertMessageInfo,
  upsertPart,
  applyMessagePartDelta,
  removeMessagePart,
  addPermission,
  removePermission,
} from "../lib/state"
import { onMessage, postMessage } from "../lib/bridge"
import type { ExtensionMessage } from "../../shared/protocol"

let initialized = false
let handlersRegistered = false

export function useOpenCode() {
  onMount(() => {
    if (!handlersRegistered) {
      handlersRegistered = true
      registerEventHandlers()
    }

    const disposeBridge = onMessage((msg: ExtensionMessage) => {
      switch (msg.type) {
        case "server/status":
          setState("serverStatus", msg.payload)
          if (msg.payload.state === "running") {
            setError(null)
            if (!initialized) {
              initialized = true
              initConnection()
            }
          } else if (msg.payload.state === "error") {
            setError(msg.payload.message)
          }
          break
        case "theme/update":
          setTheme(msg.payload.theme)
          break
        case "context/update":
          setState("editorContext", msg.payload)
          break
        case "files/dropped":
          for (const file of msg.payload) {
            setState("droppedFiles", (prev) => {
              if (prev.find((f) => f.path === file.path)) return prev
              return [...prev, file]
            })
          }
          break
        case "command/new-session":
          createSession()
          break
        case "command/abort":
          abortSession()
          break
        case "command/share":
          shareSession()
          break
      }
    })

    postMessage({ type: "ready" })

    onCleanup(() => {
      disposeBridge()
    })
  })

  return { client }
}

async function initConnection() {
  try {
    await client.health()
    await Promise.all([loadSessions(), loadAgents(), loadProviders()])
  } catch (err) {
    setError("Failed to connect to OpenCode server")
  }
}

async function loadAgents() {
  try {
    const agents = await client.agent.list()
    const primaries = agents.filter((a) => a.mode !== "subagent" && !(a as any).hidden)
    setState("agents", primaries)
    if (state.selectedAgent && !primaries.some((agent) => agent.name === state.selectedAgent)) {
      setSelectedAgent(null)
    }
    if (!state.selectedAgent) {
      const def = primaries.find((a) => a.name === "build") || primaries[0]
      if (def) setSelectedAgent(def.name)
    }
  } catch {}
}

async function loadProviders() {
  try {
    const res = await client.config.providers()
    setState("providers", res.providers)
    setState("providerDefaults", res.default || {})
    const effectiveModel = resolveSelectedModel(state.selectedModel, res.providers, res.default || {})
    if (state.selectedModel && !effectiveModel) {
      setSelectedModel(null)
    } else if (
      effectiveModel &&
      state.selectedModel &&
      state.selectedModel.variant &&
      !effectiveModel.variant
    ) {
      setSelectedModel({ providerID: effectiveModel.providerID, modelID: effectiveModel.modelID })
    }
    if (!state.selectedModel && res.providers.length > 0) {
      const firstProvider = res.providers[0]
      const defaultModelID = (res.default || {})[firstProvider.id]
      const modelID = defaultModelID || Object.keys(firstProvider.models)[0]
      if (modelID) {
        setSelectedModel({ providerID: firstProvider.id, modelID })
      }
    }
  } catch {}
}

async function loadSessions() {
  try {
    const sessions = await client.session.list()
    setState(
      "sessions",
      sessions.sort((a, b) => b.time.updated - a.time.updated),
    )
  } catch {}
}

export async function selectSession(id: string) {
  setState("activeSessionId", id)
  clearMessages()
  try {
    const msgs = await client.session.messages(id)
    setState("messages", msgs)
    const statuses = await client.session.status().catch(() => ({} as Record<string, import("../types").SessionStatus>))
    setState("sessionStatus", statuses)
    setIsLoading(statuses[id]?.type === "busy")
  } catch (err) {
    setError("Failed to load messages")
  }
}

async function syncSessionMessages(sessionId: string) {
  const msgs = await client.session.messages(sessionId)
  if (sessionId === state.activeSessionId) {
    setState("messages", msgs)
  }
}

export async function createSession(title?: string): Promise<string | null> {
  try {
    const session = await client.session.create(title ? { title } : undefined)
    setState("sessions", [session, ...state.sessions.filter((s) => s.id !== session.id)])
    setState("activeSessionId", session.id)
    clearMessages()
    return session.id
  } catch (err) {
    setError(err instanceof Error ? err.message : "Failed to create session")
    return null
  }
}

export async function deleteSession(id: string) {
  try {
    await client.session.delete(id)
    setState("sessions", state.sessions.filter((s) => s.id !== id))
    if (state.activeSessionId === id) {
      setState("activeSessionId", null)
      clearMessages()
      if (state.sessions.length > 0) {
        await selectSession(state.sessions[0].id)
      }
    }
  } catch {}
}

export async function sendMessage(text: string, options?: { noReply?: boolean }) {
  let sessionId = state.activeSessionId
  if (!sessionId) {
    sessionId = await createSession()
    if (!sessionId) return
  }

  const parts: Array<{ type: string; text?: string; mime?: string; filename?: string; url?: string }> = []
  if (text.trim()) parts.push({ type: "text", text })

  const wp = state.editorContext.workspacePath
  if (wp) {
    parts.push({ type: "text", text: `[Working directory: ${wp}]` })
  }

  const sel = state.editorContext.selection
  const af = state.editorContext.activeFile
  if (sel && af) {
    parts.push({
      type: "text",
      text: `[Selection from ${af.relativePath} lines ${sel.startLine}-${sel.endLine}]\n\`\`\`${af.language}\n${sel.text}\n\`\`\``,
    })
  }

  for (const file of state.droppedFiles) {
    parts.push({ type: "text", text: `@${file.relativePath}` })
  }

  for (const image of state.clipboardImages) {
    parts.push({
      type: "file",
      mime: image.mime,
      filename: image.filename,
      url: image.url,
    })
  }

  if (parts.length === 0) return

  setIsLoading(true)
  setError(null)

  const body: {
    parts: typeof parts
    model?: { providerID: string; modelID: string }
    agent?: string
    noReply?: boolean
    variant?: string
  } = { parts }
  if (state.selectedAgent) body.agent = state.selectedAgent
  const effectiveModel = resolveSelectedModel(state.selectedModel, state.providers, state.providerDefaults)
  if (effectiveModel) body.model = effectiveModel
  if (effectiveModel?.variant) body.variant = effectiveModel.variant
  if (options?.noReply) body.noReply = true

  setState("droppedFiles", [])
  clearClipboardImages()

  try {
    await sendPromptWithFallback(sessionId, body)
    await syncSessionMessages(sessionId).catch(() => {})
  } catch (err) {
    setIsLoading(false)
    setError(err instanceof Error ? err.message : "Failed to send message")
  }
}

async function sendPromptWithFallback(
  sessionId: string,
  body: {
    parts: Array<{ type: string; text?: string; [key: string]: unknown }>
    model?: { providerID: string; modelID: string }
    agent?: string
    noReply?: boolean
    variant?: string
  },
) {
  try {
    await client.session.sendAsync(sessionId, body)
  } catch (err) {
    if (!body.model) throw err

    const retryBody = { ...body }
    delete retryBody.model
    delete retryBody.variant
    setSelectedModel(null)
    await client.session.sendAsync(sessionId, retryBody)
  }
}

export async function abortSession() {
  if (!state.activeSessionId) return
  try {
    await client.session.abort(state.activeSessionId)
    setIsLoading(false)
  } catch {}
}

export async function shareSession() {
  if (!state.activeSessionId) return
  try {
    const session = await client.session.share(state.activeSessionId)
    setState("sessions", state.sessions.map((s) => (s.id === session.id ? session : s)))
    if (session.share?.url) {
      await navigator.clipboard.writeText(session.share.url).catch(() => {})
    }
  } catch {}
}

export async function respondPermission(
  sessionId: string,
  permissionId: string,
  response: string,
  remember?: boolean,
) {
  try {
    await client.session.respondPermission(sessionId, permissionId, response, remember)
    removePermission(permissionId)
  } catch {}
}

function registerEventHandlers() {
  serverEvents.on("session.created", (data: any) => {
    const info = data.properties?.info
    if (info) setState("sessions", [info, ...state.sessions.filter((s) => s.id !== info.id)])
  })

  serverEvents.on("session.updated", (data: any) => {
    const info = data.properties?.info
    if (info) {
      setState("sessions", state.sessions.map((s) => (s.id === info.id ? info : s)))
    }
  })

  serverEvents.on("session.deleted", (data: any) => {
    const id = data.properties?.info?.id
    if (id) setState("sessions", state.sessions.filter((s) => s.id !== id))
  })

  serverEvents.on("session.status", (data: any) => {
    const props = data.properties
    if (!props) return
    const { sessionID, status } = props
    setState("sessionStatus", { ...state.sessionStatus, [sessionID]: status })
    if (sessionID === state.activeSessionId) {
      setIsLoading(status.type === "busy" || status.type === "retry")
    }
  })

  serverEvents.on("session.idle", (data: any) => {
    const sid = data.properties?.sessionID
    if (!sid || sid === state.activeSessionId) setIsLoading(false)
    if (sid && sid === state.activeSessionId) {
      syncSessionMessages(sid).catch(() => {})
    }
  })

  serverEvents.on("message.updated", (data: any) => {
    const info = data.properties?.info
    if (info?.sessionID === state.activeSessionId) upsertMessageInfo(info)
  })

  serverEvents.on("message.part.updated", (data: any) => {
    const part = data.properties?.part
    if (part?.sessionID === state.activeSessionId) upsertPart(part)
  })

  serverEvents.on("message.part.delta", (data: any) => {
    const p = data.properties
    if (p?.sessionID === state.activeSessionId) {
      applyMessagePartDelta(p.messageID, p.partID, p.delta, p.sessionID, p.field)
    }
  })

  serverEvents.on("message.part.removed", (data: any) => {
    const p = data.properties
    if (p) removeMessagePart(p.sessionID, p.messageID, p.partID)
  })

  serverEvents.on("message.removed", (data: any) => {
    const p = data.properties
    if (p?.sessionID === state.activeSessionId) {
      setState("messages", state.messages.filter((m) => m.info.id !== p.messageID))
    }
  })

  serverEvents.on("permission.updated", (data: any) => {
    if (data.properties) addPermission(data.properties)
  })

  serverEvents.on("permission.replied", (data: any) => {
    const pid = data.properties?.permissionID
    if (pid) removePermission(pid)
  })

  serverEvents.on("todo.updated", (data: any) => {
    const p = data.properties
    if (p?.sessionID === state.activeSessionId) setState("todos", p.todos)
  })

  serverEvents.on("session.diff", (data: any) => {
    const p = data.properties
    if (p?.sessionID === state.activeSessionId) setState("diffs", p.diff)
  })
}
