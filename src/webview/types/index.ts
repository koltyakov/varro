export type UserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  summary?: { title?: string; body?: string; diffs: FileDiff[] }
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  system?: string
  tools?: { [key: string]: boolean }
}

export type AssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?: { name: string; data?: { message?: string } }
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent?: string
  path: { cwd: string; root: string }
  summary?: boolean
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  variant?: string
  finish?: string
}

export type Message = UserMessage | AssistantMessage

export type TextPart = {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: number; end?: number }
  metadata?: { [key: string]: unknown }
}

export type ReasoningPart = {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
  metadata?: { [key: string]: unknown }
  time: { start: number; end?: number }
}

export type FilePart = {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: {
    text: { value: string; start: number; end: number }
    type: "file" | "symbol"
    path: string
    range?: { start: { line: number; character: number }; end: { line: number; character: number } }
    name?: string
    kind?: number
  }
}

export type ToolStatePending = {
  status: "pending"
  input: { [key: string]: unknown }
  raw: string
}

export type ToolStateRunning = {
  status: "running"
  input: { [key: string]: unknown }
  title?: string
  metadata?: { [key: string]: unknown }
  time: { start: number }
}

export type ToolStateCompleted = {
  status: "completed"
  input: { [key: string]: unknown }
  output: string
  title: string
  metadata: { [key: string]: unknown }
  time: { start: number; end: number; compacted?: number }
  attachments?: FilePart[]
}

export type ToolStateError = {
  status: "error"
  input: { [key: string]: unknown }
  error: string
  metadata?: { [key: string]: unknown }
  time: { start: number; end: number }
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export type ToolPart = {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: ToolState
  metadata?: { [key: string]: unknown }
}

export type StepStartPart = {
  id: string
  sessionID: string
  messageID: string
  type: "step-start"
  snapshot?: string
}

export type StepFinishPart = {
  id: string
  sessionID: string
  messageID: string
  type: "step-finish"
  reason: string
  snapshot?: string
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export type SnapshotPart = {
  id: string
  sessionID: string
  messageID: string
  type: "snapshot"
  snapshot: string
}

export type PatchPart = {
  id: string
  sessionID: string
  messageID: string
  type: "patch"
  hash: string
  files: string[]
}

export type AgentPart = {
  id: string
  sessionID: string
  messageID: string
  type: "agent"
  name: string
  source?: { value: string; start: number; end: number }
}

export type SubtaskPart = {
  id: string
  sessionID: string
  messageID: string
  type: "subtask"
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string }
  command?: string
}

export type RetryPart = {
  id: string
  sessionID: string
  messageID: string
  type: "retry"
  attempt: number
  error: { name: string; data: { message: string } }
  time: { created: number }
}

export type CompactionPart = {
  id: string
  sessionID: string
  messageID: string
  type: "compaction"
  auto: boolean
  overflow?: boolean
}

export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

export type Session = {
  id: string
  projectID: string
  directory: string
  parentID?: string
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: FileDiff[]
  }
  share?: { url: string }
  title: string
  version: string
  time: { created: number; updated: number; compacting?: number }
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }
}

export type SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy" }

export type FileDiff = {
  file: string
  before: string
  after: string
  additions: number
  deletions: number
}

export type Permission = {
  id: string
  type: string
  pattern?: string | string[]
  sessionID: string
  messageID: string
  callID?: string
  title: string
  metadata: { [key: string]: unknown }
  time: { created: number }
}

export type Todo = {
  content: string
  status: string
  priority: string
  id: string
}

export type Agent = {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  builtIn: boolean
  color?: string
  permission: {
    edit: "ask" | "allow" | "deny"
    bash: { [key: string]: "ask" | "allow" | "deny" }
    webfetch?: "ask" | "allow" | "deny"
  }
  model?: { modelID: string; providerID: string; variant?: string }
  tools: { [key: string]: boolean }
  maxSteps?: number
}

export type Provider = {
  id: string
  name: string
  source: "env" | "config" | "custom" | "api"
  models: {
    [key: string]: {
      id: string
      name: string
      capabilities: {
        reasoning?: boolean
        toolcall: boolean
      }
      cost: {
        input: number
        output: number
        cache?: { read: number; write: number }
      }
      limit?: {
        context: number
        input?: number
        output: number
      }
      variants?: {
        [key: string]: {
          reasoningEffort?: string
          reasoningSummary?: string
          effort?: string
          thinking?: { type?: string; budgetTokens?: number }
          include?: string[]
          [key: string]: unknown
        }
      }
    }
  }
}

export type Model = {
  id: string
  providerID: string
  name: string
}
