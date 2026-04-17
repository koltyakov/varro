import { onMount, onCleanup } from "solid-js"
import { client, createEventSource } from "../lib/client"
import {
  state,
  setState,
  setServerUrl,
  serverUrl,
  setTheme,
  setIsLoading,
  setError,
  clearMessages,
  upsertMessage,
  updateMessagePart,
  removeMessagePart,
  addPermission,
  removePermission,
} from "../lib/state"
import { onMessage, postMessage } from "../lib/bridge"
import type { ExtensionMessage } from "../../shared/protocol"

const eventSource = createEventSource()

export function useOpenCode() {
  onMount(() => {
    const initData = (window as any).__initData as {
      serverUrl: string
      eventStreamUrl: string
      theme: string
    } | undefined

    if (initData?.serverUrl) {
      setServerUrl(initData.serverUrl)
      setTheme(initData.theme as "dark" | "light")
      setState("serverStatus", { state: "running", url: initData.serverUrl })
      initConnection(initData.eventStreamUrl)
    }

    const disposeBridge = onMessage((msg: ExtensionMessage) => {
      switch (msg.type) {
        case "context/update":
          setState("editorContext", msg.payload)
          break
        case "files/dropped":
          for (const file of msg.payload) {
            setState(
              "droppedFiles",
              (prev) => {
                if (prev.find((f: { path: string }) => f.path === file.path)) return prev
                return [...prev, file]
              },
            )
          }
          break
      }
    })

    postMessage({ type: "ready" })

    onCleanup(() => {
      disposeBridge()
      eventSource.stop()
    })
  })

  return {
    client,
    state,
    setState,
    setIsLoading,
    setError,
    eventSource,
  }
}

async function initConnection(eventStreamUrl?: string) {
  try {
    await client.health()
    if (eventStreamUrl) {
      eventSource.start(eventStreamUrl)
      registerEventHandlers()
    }
    loadSessions()
  } catch (err) {
    setError("Failed to connect to OpenCode server")
    setState("serverStatus", {
      state: "error",
      message: "Failed to connect to OpenCode server",
    })
  }
}

async function loadSessions() {
  try {
    const sessions = await client.session.list()
    setState(
      "sessions",
      sessions.sort((a, b) => b.time.updated - a.time.updated),
    )
    if (sessions.length > 0 && !state.activeSessionId) {
      selectSession(sessions[0].id)
    }
  } catch {}
}

export async function selectSession(id: string) {
  setState("activeSessionId", id)
  clearMessages()
  setIsLoading(true)
  try {
    const msgs = await client.session.messages(id)
    setState("messages", msgs)
    const statuses = await client.session.status()
    setState("sessionStatus", statuses)
  } catch (err) {
    setError("Failed to load messages")
  } finally {
    setIsLoading(false)
  }
}

export async function createSession(title?: string) {
  try {
    const session = await client.session.create({ title })
    setState(
      "sessions",
      [session, ...state.sessions],
    )
    await selectSession(session.id)
  } catch (err) {
    setError("Failed to create session")
  }
}

export async function deleteSession(id: string) {
  try {
    await client.session.delete(id)
    setState(
      "sessions",
      state.sessions.filter((s) => s.id !== id),
    )
    if (state.activeSessionId === id) {
      clearMessages()
      setState("activeSessionId", null)
      if (state.sessions.length > 0) {
        await selectSession(state.sessions[0].id)
      }
    }
  } catch {}
}

export async function sendMessage(text: string) {
  if (!state.activeSessionId) {
    await createSession()
  }
  if (!state.activeSessionId) return

  const sessionId = state.activeSessionId
  const parts: Array<{ type: string; text: string }> = []

  if (text.trim()) {
    parts.push({ type: "text", text })
  }

  if (state.editorContext.activeFile) {
    parts.push({
      type: "text",
      text: `[Active file: ${state.editorContext.activeFile.relativePath}]`,
    })
  }

  if (state.editorContext.selection) {
    parts.push({
      type: "text",
      text: `[Selected code (${state.editorContext.selection.startLine}-${state.editorContext.selection.endLine}):\n\`\`\`\n${state.editorContext.selection.text}\n\`\`\`]`,
    })
  }

  for (const file of state.droppedFiles) {
    parts.push({
      type: "text",
      text: `[Attached: ${file.relativePath}]`,
    })
  }

  if (parts.length === 0) return

  setIsLoading(true)
  setError(null)

  try {
    await client.session.sendAsync(sessionId, { parts })
  } catch (err) {
    setError("Failed to send message")
  }
}

export async function abortSession() {
  if (!state.activeSessionId) return
  try {
    await client.session.abort(state.activeSessionId)
  } catch {}
}

export async function shareSession() {
  if (!state.activeSessionId) return
  try {
    const session = await client.session.share(state.activeSessionId)
    setState(
      "sessions",
      state.sessions.map((s) => (s.id === session.id ? session : s)),
    )
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
  eventSource.on("session.created", (data: any) => {
    setState(
      "sessions",
      [data.properties.info, ...state.sessions],
    )
  })

  eventSource.on("session.updated", (data: any) => {
    const info = data.properties.info
    setState(
      "sessions",
      state.sessions.map((s) => (s.id === info.id ? info : s)),
    )
  })

  eventSource.on("session.deleted", (data: any) => {
    setState(
      "sessions",
      state.sessions.filter((s) => s.id !== data.properties.info.id),
    )
  })

  eventSource.on("session.status", (data: any) => {
    const { sessionID, status } = data.properties
    setState("sessionStatus", { [sessionID]: status })
    if (status.type === "idle") {
      setIsLoading(false)
    }
  })

  eventSource.on("session.idle", (data: any) => {
    setIsLoading(false)
  })

  eventSource.on("message.updated", (data: any) => {
    if (data.properties.info.sessionID === state.activeSessionId) {
      upsertMessage({
        info: data.properties.info,
        parts: state.messages.find((m) => m.info.id === data.properties.info.id)?.parts || [],
      })
    }
  })

  eventSource.on("message.part.updated", (data: any) => {
    const part: any = data.properties.part
    if (part.sessionID === state.activeSessionId) {
      updateMessagePart(part)
      if (part.type === "text" && part.text) {
        setState("streamingText", part.text)
      }
    }
  })

  eventSource.on("message.part.removed", (data: any) => {
    removeMessagePart(data.properties.sessionID, data.properties.messageID, data.properties.partID)
  })

  eventSource.on("message.removed", (data: any) => {
    if (data.properties.sessionID === state.activeSessionId) {
      setState(
        "messages",
        state.messages.filter((m) => m.info.id !== data.properties.messageID),
      )
    }
  })

  eventSource.on("permission.updated", (data: any) => {
    addPermission(data.properties)
  })

  eventSource.on("permission.replied", (data: any) => {
    removePermission(data.properties.permissionID)
  })

  eventSource.on("todo.updated", (data: any) => {
    if (data.properties.sessionID === state.activeSessionId) {
      setState("todos", data.properties.todos)
    }
  })

  eventSource.on("session.diff", (data: any) => {
    if (data.properties.sessionID === state.activeSessionId) {
      setState("diffs", data.properties.diff)
    }
  })
}
