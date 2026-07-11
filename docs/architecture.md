# Architecture Guide

This document maps the current Varro codebase to the runtime behavior of the extension.

## High-Level Flow

1. VS Code activates the extension from `src/extension/extension.ts`.
2. Activation constructs `OpenCodeServer`, `ContextProvider`, `SidebarProvider`, registers commands, and creates the status bar integration, but it does not start OpenCode yet.
3. `SidebarProvider` creates the webview, injects initial state, and restores pending attention or interrupted-session snapshots from extension state.
4. When the view becomes active or the webview sends its first request, Varro either attaches to a running OpenCode server on the configured port or spawns `opencode serve`.
5. The webview sends `ready`, initializes its bridge listeners, and starts loading sessions, agents, providers, MCP status, questions, and session statuses.
6. The extension host proxies allowed API requests to the OpenCode server and forwards SSE events into the webview.
7. The webview updates local state, renders the structured chat UI, and derives higher-level states such as running, attention-needed, failed, completed, and plan-ready sessions.
8. After reloads, the webview can reconnect to interrupted sessions and continue them when they are still resumable.

Server startup is deferred: activation only constructs the `OpenCodeServer` object, and the actual `start()` call is issued from `SidebarProvider.ensureServerStarted()` when the UI first needs it.

## Main Runtime Pieces

### Extension Host

#### `src/extension/extension.ts`

- Reads extension configuration from `varro.*`
- Instantiates `OpenCodeServer`, `ContextProvider`, and `SidebarProvider`
- Registers the webview view provider and VS Code commands
- Sets the `varro:activated` context key
- Does not start the OpenCode server directly; startup is deferred until the webview first needs it

#### `src/extension/commands.ts`

Registers the VS Code command surface that surrounds the chat UI.

- `varro.chat.focus`
- `varro.chat.newSession`
- `varro.chat.abort`
- `varro.server.restart`
- `varro.chat.addToContext`
- `varro.chat.addSelectionToContext`
- `varro.chat.addTerminalSelectionToContext`

These commands route through `SidebarProvider` and `ContextProvider` rather than talking to OpenCode directly.

#### `src/extension/server.ts`

- Owns the local OpenCode process
- Checks health before auto-starting
- Adds workspace scoping to non-global API calls
- Connects to the OpenCode event stream at `/api/event`
- Emits `status` and `event` to the rest of the extension

Important behavior:

- The current workspace folder is attached to requests through both a `directory` query param and `x-opencode-directory` header.
- If the SSE stream drops while the server is running, Varro retries with exponential backoff.
- If the event stream drops but REST still works, Varro marks the event stream as degraded so the UI can show a reconnecting banner.
- If the child process exits after startup, Varro attempts a limited restart sequence.
- If the configured port is already in use by another process during Varro-managed startup, the server layer can retry on nearby ports.
- A maintenance loop compares installed CLI and server versions, suggests `opencode upgrade` when a newer CLI exists, and can restart a Varro-managed idle server onto the newer version.

#### `src/extension/context-provider.ts`

- Watches editor focus, selection changes, diagnostics, and workspace folder changes
- Maintains the current `EditorContext`
- Captures terminal selection by temporarily invoking the VS Code terminal copy command
- Reads and opens files requested by the webview

Clipboard-sensitive terminal capture is implemented here: Varro reads the terminal selection, then restores the previous clipboard contents when possible.

#### `src/extension/sidebar-provider.ts`

This is the main extension-side coordinator.

- Hosts the webview HTML
- Receives UI messages from the webview
- Proxies HTTP requests to `OpenCodeServer`
- Tracks dropped files, file search cache, and provider limit cache
- Exports sessions by invoking the OpenCode CLI and opening the JSON in VS Code
- Sends notifications and updates a status bar item when background sessions finish or need attention

It also restores pending permission or question prompts across reloads and serializes that state into the initial webview payload.

It also exposes the Varro extension-host API namespace, `/varro/*`.

- `GET /varro/provider-limit`
- `POST /varro/plan/open`
- `GET /varro/opencode-config`
- `POST /varro/opencode-config/model-routing`
- `GET /varro/session-trash`
- `POST /varro/session-trash/:rootID/restore`
- `DELETE /varro/session-trash/:rootID/delete`
- `DELETE /varro/session-trash`

Those paths share the same `api/request` bridge as OpenCode REST calls, but the extension host resolves them locally instead of forwarding them to OpenCode.

Drag and drop has two paths here.

- Path-based drops are normalized and attached directly.
- Content-only drops are written into a temporary `varro-drops` directory before being attached.

#### `src/extension/session-state-manager.ts`

Tracks extension-side session attention and completion state independently from the webview.

- Records pending permissions and questions
- Tracks completed background sessions
- Persists state that needs to survive webview reloads
- Drives the status bar item and notification behavior

### Shared Layer

#### `src/shared/protocol.ts`

Defines:

- `EditorContext`
- `DroppedFile`
- `ServerStatus`
- extension-to-webview messages
- webview-to-extension messages

The protocol is intentionally small and transport-oriented. OpenCode domain types such as `Session`, `Message`, and `Part` live under `src/webview/types/` because they are consumed mainly by the UI.

Next to the `/varro/*` namespace, the architectural choice is explicit: Varro treats the extension host as a transport boundary, not as a semantic event coordinator for webview state. The extension forwards raw `server/event` payloads and serves local `/varro/*` requests, while the webview derives UI facts like pending attention and recycle-bin views from those transport primitives plus targeted REST reloads.

#### `src/shared/context-files.ts`

Handles attachment semantics.

- Normalizes and merges line ranges
- Avoids duplicate context entries for the same path
- Formats selection references such as `[Selection from path lines 12-20]`
- Lets the composer subtract already-attached ranges from the live editor selection

### Webview

#### Boot

`src/extension/sidebar-provider.ts` serializes an `InitialWebviewState` into the HTML payload.

That initial state includes:

- theme
- server status
- editor context
- terminal selection
- dropped files
- config such as thinking expansion and desktop session pane side
- interrupted session IDs
- pending permission and question snapshots

`src/webview/App.tsx` shows either:

- `Chat` when the server is running and at least one provider is available
- `ServerStatus` otherwise

#### State

`src/webview/lib/state.ts` is the source of truth for UI state.

It stores:

- sessions and session status
- messages and streaming state
- todos, permissions, questions, and diffs
- selected agent/model/variant
- selected MCPs per session
- hidden providers and models
- permission modes
- current-document context toggles
- failed-session and usage-limit state
- skipped plan-session markers
- queued follow-up messages

Several pieces are persisted in `localStorage`, including selected model, hidden models, permission mode preferences, and last active session ID.

Ralph loop state is owned by the extension host (`src/extension/ralph-host.ts`, persisted in the workspace Memento). `src/webview/lib/stores/ralph-store.ts` is a render mirror fed by `ralph/state` broadcasts, with optimistic local updates for immediate dashboard feedback.

#### OpenCode integration

`src/webview/hooks/useOpenCode.ts` is the most important webview file.

Responsibilities:

- react to extension messages such as `server/status` and `context/update`
- subscribe to OpenCode events forwarded from the extension host
- fetch initial data from OpenCode REST endpoints
- send prompts, undo, abort, compact, fork, plan handoff, and permission/question responses
- derive todo state from message tool parts, with `todo.updated` acting only as a resync trigger
- synchronize per-session MCP selections with OpenCode
- recover interrupted sessions after reload when the previous run still looks incomplete

The hook also handles workspace filtering for sessions, stale loading recovery, and model/provider limit refreshes.

#### UI composition

Key components:

- `src/webview/components/Chat.tsx`: session header, session list, and top-level chat layout
- `src/webview/components/ChatInput.tsx`: composer, slash commands, attachments, model/agent/MCP pickers, queueing, send modes, and the `/ralph` launcher
- `src/webview/components/MessageList.tsx`: chat transcript and loading state
- `src/webview/components/Message.tsx` and `MessagePart.tsx`: assistant/user message rendering
- `src/webview/components/PermissionPrompt.tsx`: inline approval UI
- `src/webview/components/QuestionPrompt.tsx`: inline question UI
- `src/webview/components/TodoList.tsx`: task progress surface
- `src/webview/components/DiffView.tsx`: file change summaries
- `src/webview/components/SettingsPanel.tsx`: model visibility settings
- `src/webview/components/ralph/RalphForm.tsx`: Ralph loop setup form for plan path, iteration cap, model selection, and prompt-template overrides
- `src/webview/components/ralph/RalphDashboard.tsx` and `RalphIterationCard.tsx`: manager-session dashboard, controls, stop reasons, and per-iteration summaries

## Ralph Loop Flow

Ralph is a plan-driven orchestration layer that runs on the extension host, so in-flight loops keep executing while the sidebar is hidden and resume after a window reload without waiting for the webview.

- `src/shared/ralph.ts` defines Ralph run, iteration, model-selection, token-summary, and stop-reason types.
- `src/shared/ralph-runner-core.ts` contains the host-agnostic loop; all environment access (OpenCode requests, idle events, plan reads, run store) goes through injected ports so the same loop runs on the extension host, in the e2e harness, and against fakes in unit tests.
- `src/extension/ralph-host.ts` instantiates the loop over `OpenCodeServer`, persists runs in the workspace Memento, reattaches persisted running loops on activation, and broadcasts `ralph/state` snapshots to the webview.
- `/ralph` opens `RalphForm`, which creates a manager session, sends an anchor message with the loop config, and starts the runner. `src/webview/components/ralph/ralph-runner.ts` is a thin proxy that forwards start/stop/pause/resume to the host via `ralph/*` messages and applies optimistic mirror updates.
- The loop creates one child session per iteration under the manager session, builds the iteration prompt from the plan document plus the previous iteration summary, and waits for the child to go idle.
- Verification is intentionally split into a second turn. After the main work settles, the manager sends a dedicated verification prompt and parses `<name>: PASS|FAIL|SKIPPED` lines back out of the final assistant report.
- If verification fails, the runner can spawn up to two repair child sessions for that iteration. Repair sessions stay under the same manager session so their history does not pollute the original iteration session.
- Stop conditions come from both plan content and run history: `DONE` marker, consecutive passing iterations with a clean checklist, manual stop, iteration error, or iteration limit. Reaching the limit while the plan still has unchecked items or failed verification marks the run as `incomplete` (not `done`, and not the harder `failed` reserved for true iteration errors).
- `Chat.tsx` and `ChatWorkspace.tsx` treat Ralph manager sessions specially: manager sessions render the Ralph dashboard, Ralph roots are tagged in the session list, and navigating back from an iteration child session returns to the owning Ralph dashboard.

## Request And Event Flow

### Webview to extension

The webview sends:

- `api/request` for OpenCode REST calls
- `files/search`, `files/pick`, `files/drop`, `files/drop-content`, and `files/remove` for context management
- `vscode/open` and `vscode/open-settings` for editor integration
- `session/export` to open a JSON export of the current session
- `terminal/run` to launch setup commands such as `opencode auth login`
- `config/update` and `webview/focus` for UI preference and focus synchronization

### Extension to webview

The extension sends:

- `server/status`
- `server/event`
- `context/update`
- `terminal-selection/update`
- `files/dropped` and `files/removed`
- `theme/update`
- `command/new-session`, `command/focus-input`, and `command/abort`

### Prompt construction

When the user sends a message, `sendMessage()` in `src/webview/hooks/useOpenCode.ts` builds prompt parts from current UI state.

Typical part sequence:

1. user text
2. working directory marker
3. active file or active selection marker, if current-document context is enabled for the session
4. terminal selection block
5. explicit context files and folders
6. pasted image files when the model supports vision

This is where Varro turns live VS Code context into OpenCode-compatible prompt parts.

### Varro API namespace

`/varro/*` is a documented extension-host namespace on top of the shared webview `api/request` transport.

- `/varro/provider-limit` returns best-effort provider quota metadata for the current provider and model.
- `/varro/plan/open` normalizes a plan response, saves it into the local OpenCode plans directory, and opens the file in VS Code.
- `/varro/opencode-config` and `/varro/opencode-config/model-routing` read and update Varro-managed OpenCode model routing.
- `/varro/session-trash` and its child paths expose the recycle-bin workflow managed by the extension host.

## Session And Attention Model

Varro distinguishes several session states in the UI:

- running
- attention needed
- failed
- completed
- plan ready

The extension host derives attention from server events such as:

- `permission.asked`
- `question.asked`
- `session.idle`

That information drives both:

- sidebar notifications
- the status bar item shown when the sidebar is hidden

The webview independently derives its attention and recycle-bin UI from transport data.

- `attention needed` is computed from raw `permission.*` and `question.*` events plus the initial pending snapshots embedded into the HTML payload.
- recycle-bin state is loaded through `/varro/session-trash` instead of being mirrored through a second extension push channel.

The webview adds more derived states on top of that data.

- `failed` also includes usage-limit failures surfaced from message or status data.
- `plan ready` is derived from sessions whose selected agent is `plan` and have not been explicitly skipped.
- `completed` uses unread state so old completed sessions do not keep looking new forever.
- Parent sessions can surface sub-agent counts so the session list can branch into child work.

## Notable implementation details

- The webview is bundled and inlined into the HTML payload instead of loaded as separate local resources.
- File search uses `vscode.workspace.findFiles()` with a short-lived cache and ranking heuristic rather than shelling out.
- Session lists are filtered to the active workspace path, which prevents unrelated project sessions from appearing in the sidebar.
- Queued follow-up prompts are stored client-side and auto-dispatched once the active session becomes idle.
- Message loads are windowed: sessions fetch only the most recent messages (`src/webview/lib/message-window.ts`), older loaded entries are stitched back in during resyncs, and a transcript banner offers loading the full history on demand.
- Finder or browser drops that do not expose file paths fall back to temporary file writes in `varro-drops`.
- The event stream can be degraded while REST remains healthy, so the UI treats live updates and request availability separately.
- Provider limits are best-effort metadata; they are not guaranteed for every provider or model.
- Ralph runs persist in the extension host's workspace Memento and reattach on activation, independent of webview lifetime; runs persisted by older builds in webview localStorage are migrated to the host through `ralph/sync`.
- Server startup is lazy and workspace-scoped, which keeps activation lightweight and helps multi-project use against a shared OpenCode instance.
