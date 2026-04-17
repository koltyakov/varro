import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type {
  Session,
  Message,
  Part,
  Permission,
  Todo,
  SessionStatus,
  FileDiff,
  Agent,
  Provider,
} from "../types"
import type { EditorContext, DroppedFile, ServerStatus } from "../../shared/protocol"

const STORAGE_KEYS = {
  selectedAgent: "opencode.selectedAgent",
  selectedModel: "opencode.selectedModel",
} as const

type SelectedModel = { providerID: string; modelID: string }

function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeStored(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) {
      window.localStorage.removeItem(key)
      return
    }
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

interface AppState {
  serverStatus: ServerStatus
  editorContext: EditorContext
  droppedFiles: DroppedFile[]
  sessions: Session[]
  activeSessionId: string | null
  sessionStatus: Record<string, SessionStatus>
  messages: Array<{ info: Message; parts: Part[] }>
  todos: Todo[]
  permissions: Permission[]
  diffs: FileDiff[]
  streamingPartId: string | null
  streamingText: string
  agents: Agent[]
  providers: Provider[]
  providerDefaults: Record<string, string>
  selectedAgent: string | null
  selectedModel: SelectedModel | null
}

export const [state, setState] = createStore<AppState>({
  serverStatus: { state: "stopped" },
  editorContext: { activeFile: null, selection: null, diagnostics: [] },
  droppedFiles: [],
  sessions: [],
  activeSessionId: null,
  sessionStatus: {},
  messages: [],
  todos: [],
  permissions: [],
  diffs: [],
  streamingPartId: null,
  streamingText: "",
  agents: [],
  providers: [],
  providerDefaults: {},
  selectedAgent: readStored<string>(STORAGE_KEYS.selectedAgent),
  selectedModel: readStored<SelectedModel>(STORAGE_KEYS.selectedModel),
})

export const [inputText, setInputText] = createSignal("")
export const [isLoading, setIsLoading] = createSignal(false)
export const [error, setError] = createSignal<string | null>(null)
export const [showSessionPicker, setShowSessionPicker] = createSignal(false)
export const [showModelPicker, setShowModelPicker] = createSignal(false)
export const [theme, setTheme] = createSignal<"dark" | "light">(
  ((window as any).__initialTheme as "dark" | "light") || "dark",
)

export function addContextFile(file: DroppedFile) {
  setState(
    "droppedFiles",
    produce((files) => {
      if (!files.find((f) => f.path === file.path)) {
        files.push(file)
      }
    }),
  )
}

export function removeContextFile(path: string) {
  setState(
    "droppedFiles",
    produce((files) => {
      const idx = files.findIndex((f) => f.path === path)
      if (idx !== -1) files.splice(idx, 1)
    }),
  )
}

export function clearContextFiles() {
  setState("droppedFiles", [])
}

export function setSelectedAgent(agent: string | null) {
  setState("selectedAgent", agent)
  writeStored(STORAGE_KEYS.selectedAgent, agent)
}

export function setSelectedModel(model: SelectedModel | null) {
  setState("selectedModel", model)
  writeStored(STORAGE_KEYS.selectedModel, model)
}

export function upsertMessage(msg: { info: Message; parts: Part[] }) {
  setState(
    "messages",
    produce((msgs) => {
      const idx = msgs.findIndex((m) => m.info.id === msg.info.id)
      if (idx !== -1) {
        msgs[idx] = msg
      } else {
        msgs.push(msg)
      }
    }),
  )
}

export function upsertMessageInfo(info: Message) {
  setState(
    "messages",
    produce((msgs) => {
      const idx = msgs.findIndex((m) => m.info.id === info.id)
      if (idx !== -1) {
        msgs[idx].info = info
      } else {
        msgs.push({ info, parts: [] })
      }
    }),
  )
}

export function upsertPart(part: Part) {
  setState(
    "messages",
    produce((msgs) => {
      const msgId = (part as any).messageID
      const msg = msgs.find((m) => m.info.id === msgId)
      if (!msg) return
      const idx = msg.parts.findIndex((p) => p.id === part.id)
      if (idx !== -1) msg.parts[idx] = part
      else msg.parts.push(part)
    }),
  )
}

export function updateMessagePart(part: Part) {
  setState(
    "messages",
    produce((msgs) => {
      for (const msg of msgs) {
        const idx = msg.parts.findIndex((p) => p.id === part.id)
        if (idx !== -1) {
          msg.parts[idx] = part
          break
        }
      }
    }),
  )
}

export function applyMessagePartDelta(
  messageId: string,
  partId: string,
  delta: string,
  sessionId?: string,
  field = "text",
) {
  if (field !== "text" || !delta) return

  setState(
    "messages",
    produce((msgs) => {
      const msg = msgs.find((item) => item.info.id === messageId)
      if (!msg) return

      let part = msg.parts.find(
        (item): item is Part & { type: "text"; text: string } => item.id === partId && item.type === "text",
      )

      if (!part) {
        part = {
          id: partId,
          messageID: messageId,
          sessionID: sessionId || msg.info.sessionID,
          type: "text",
          text: "",
        }
        msg.parts.push(part)
      }

      part.text += delta
    }),
  )
}

export function removeMessagePart(sessionId: string, messageId: string, partId: string) {
  setState(
    "messages",
    produce((msgs) => {
      for (const msg of msgs) {
        if (msg.info.sessionID === sessionId && msg.info.id === messageId) {
          const idx = msg.parts.findIndex((p) => p.id === partId)
          if (idx !== -1) msg.parts.splice(idx, 1)
          break
        }
      }
    }),
  )
}

export function addPermission(permission: Permission) {
  setState(
    "permissions",
    produce((perms) => {
      if (!perms.find((p) => p.id === permission.id)) {
        perms.push(permission)
      }
    }),
  )
}

export function removePermission(permissionId: string) {
  setState(
    "permissions",
    produce((perms) => {
      const idx = perms.findIndex((p) => p.id === permissionId)
      if (idx !== -1) perms.splice(idx, 1)
    }),
  )
}

export function clearMessages() {
  setState("messages", [])
  setState("permissions", [])
  setState("todos", [])
  setState("diffs", [])
  setState("streamingPartId", null)
  setState("streamingText", "")
}
