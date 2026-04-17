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
} from "../types"
import type { EditorContext, DroppedFile, ServerStatus } from "../../shared/protocol"

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
})

export const [inputText, setInputText] = createSignal("")
export const [isLoading, setIsLoading] = createSignal(false)
export const [error, setError] = createSignal<string | null>(null)
export const [showSessionPicker, setShowSessionPicker] = createSignal(false)
export const [showModelPicker, setShowModelPicker] = createSignal(false)
export const [theme, setTheme] = createSignal<"dark" | "light">("dark")
export const [serverUrl, setServerUrl] = createSignal("")

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
