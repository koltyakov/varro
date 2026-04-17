export interface EditorContext {
  activeFile: {
    path: string
    relativePath: string
    language: string
    content: string
  } | null
  selection: {
    text: string
    startLine: number
    endLine: number
  } | null
  diagnostics: Array<{
    path: string
    severity: "error" | "warning" | "info"
    message: string
    line: number
  }>
}

export interface DroppedFile {
  path: string
  relativePath: string
  type: "file" | "directory"
}

export type ServerStatus =
  | { state: "starting" }
  | { state: "running"; url: string }
  | { state: "stopped" }
  | { state: "error"; message: string }

export type ExtensionMessage =
  | { type: "server/status"; payload: ServerStatus }
  | { type: "context/update"; payload: EditorContext }
  | { type: "files/dropped"; payload: DroppedFile[] }
  | { type: "init"; payload: { serverUrl: string; theme: "dark" | "light" } }
  | { type: "api/response"; payload: { id: number; data?: any; error?: string } }

export type WebviewMessage =
  | { type: "context/request" }
  | { type: "file/read"; payload: { path: string } }
  | { type: "vscode/open"; payload: { path: string; line?: number } }
  | { type: "vscode/diff"; payload: { path: string } }
  | { type: "ready" }
  | { type: "api/request"; payload: { id: number; method: string; path: string; body?: unknown } }
  | { type: "log"; payload: { msg: string; data?: string; error?: string } }
