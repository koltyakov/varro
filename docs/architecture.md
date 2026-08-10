# Architecture Guide

This document maps the current Varro codebase to the runtime behavior of the extension.

## High-Level Flow

1. VS Code activates the extension from `src/extension/extension.ts`.
2. Activation constructs `OpenCodeServer`, `ContextProvider`, and the `SidebarProvider` composition root, then registers commands. It does not start OpenCode yet.
3. `WebviewSession` resolves the view, shows a static loading document, restores host recovery state, and asks `SidebarProviderBridge` to render the final HTML with inline initial state and separate CSS/JS asset URIs.
4. `src/webview/index.tsx` mounts `AppRoot`; the runtime installs bridge listeners and sends `ready` to the extension host.
5. The host replays current context, config, status, recovery, and Ralph state, then lazily attaches to a running OpenCode server or spawns `opencode serve`.
6. Once the server is running, the webview loads sessions, agents, providers, MCP status, questions, and session statuses through the request bridge.
7. `RestProxy` handles allowed OpenCode and local `/varro/*` requests, while `ServerEventBridge` forwards workspace-scoped SSE events.
8. The webview stores transport data and derives higher-level running, attention-needed, failed, completed, and plan-ready UI states.
9. Interrupted sessions can resume after reload, while Ralph loops continue independently in the extension host.

Server startup is deferred: activation only constructs `OpenCodeServer`; `SidebarProviderRuntime.ensureServerStarted()` issues the actual start when the UI first needs it.

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
- `varro.chat.statusBarClick`
- `varro.chat.newSession`
- `varro.chat.searchSessions`
- `varro.chat.abort`
- `varro.chat.previousSession`
- `varro.chat.nextSession`
- `varro.server.restart`
- `varro.about`
- `varro.showOutput`
- `varro.openSourceControl`
- `varro.generateCommitMessage`
- `varro.agents.openGlobal`
- `varro.agents.initializeProject`
- `varro.chat.addToContext`
- `varro.chat.addSelectionToContext`
- `varro.chat.addTerminalSelectionToContext`

Chat and context commands route through `SidebarProvider` and `ContextProvider`; server, output, Source Control, About, and `AGENTS.md` actions use their corresponding extension-host services.

#### `src/extension/server.ts`

- Orchestrates OpenCode startup, compatibility policy, restart safety, and workspace selection
- Checks health before auto-starting
- Connects to the OpenCode event stream at `/global/event` and filters events to the active workspace
- Emits `status` and `event` to the rest of the extension

The implementation is split across focused components: `open-code-process.ts` owns CLI discovery, process, port, and update behavior; `open-code-transport.ts` owns REST and SSE transport; and `server-lifecycle.ts` coordinates lifecycle state.

Important behavior:

- Workspace-sensitive non-global requests are scoped through both a `directory` query param and `x-opencode-directory` header. Global paths omit the `directory` query param; health and `/global/event` are explicitly unscoped, while generic global REST calls can still carry the directory header. Session status and most session-child routes are deliberately unscoped; Windows leaves additional session reads unscoped to avoid path casing and separator regressions. Aggregate session lists, statuses, permissions, and questions are filtered locally to the active workspace. Direct session-child routes remain ID-addressed and are normally reached through IDs from filtered session state.
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

- Composes `WebviewSession`, `SidebarProviderBridge`, `MessageRouter`, `RestProxy`, `ServerEventBridge`, and `RalphHost`
- Connects focused services for context files, dropped files, search, provider limits, provider-file observation and revalidation, exports, usage reports, commit messages, diff and tool-output documents, queued messages, title fallback, pins, hidden sessions, and the recycle bin
- Uses `SessionStateManager` to drive plan/failure/permission/question notifications and the status bar
- Keeps routing and lifecycle ownership in the focused components rather than implementing those concerns directly

Supporting host components define the main boundaries:

- `src/extension/webview-session.ts`: webview resolution, recovery snapshots, initial state, ready/visibility handling, and queued commands
- `src/extension/sidebar-provider-bridge.ts` and `webview-html.ts`: resource URIs, CSP, HTML, and extension/webview posting
- `src/extension/message-router.ts` and `sidebar-provider-actions.ts`: validated webview command dispatch
- `src/extension/rest-proxy.ts`: OpenCode REST forwarding and local `/varro/*` endpoints
- `src/extension/hidden-session-manager.ts`: internal helper-session identification, user-visible
  filtering, and stale permission-judge cleanup
- `src/extension/server-event-bridge.ts`: server status and workspace-scoped event forwarding
- `src/extension/ralph-host.ts`: persisted Ralph execution independent of webview lifetime
- `src/extension/commit-message-service.ts` and `usage-report-service.ts`: repository-aware commit generation and retained-history usage reports
- `src/extension/queued-message-store.ts`: authoritative workspace-state persistence for queued prompts and attachment data
- `src/extension/provider-file-refresh-controller.ts`: OpenCode config and auth file observation, provider invalidation, and server revalidation
- `src/extension/session-diff-document-provider.ts` and `tool-output-document-provider.ts`: read-only editor documents opened from the webview

It also exposes the Varro extension-host API namespace, `/varro/*`.

- `GET /varro/provider-limit`
- `POST /varro/plan/open`
- `GET /varro/opencode-config`
- `POST /varro/opencode-config/model-routing`
- `GET /varro/workspace-file`
- `GET /varro/workspace-file/pick`
- `GET /varro/workspace-path/resolve`
- `POST /varro/permission/judge`
- `GET /varro/session/:sessionID/diff-summary`
- `POST /varro/session/:sessionID/pin`
- `POST /varro/session/:sessionID/rename-if-untitled`
- `DELETE /varro/session/:sessionID/delete`
- `GET /varro/session-trash`
- `POST /varro/session-trash/:rootID/restore`
- `DELETE /varro/session-trash/:rootID/delete`
- `DELETE /varro/session-trash`

Those paths share the same `api/request` bridge as OpenCode REST calls, but the extension host resolves them locally instead of forwarding them to OpenCode.

Commit-message generation is invoked by a VS Code command. Usage reports, opening a session in the OpenCode TUI, and read-only tool-output documents use dedicated webview messages rather than `/varro/*` routes.

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

The protocol is intentionally transport-oriented. Shared OpenCode domain and event types such as `Session`, `Message`, and `Part` live in `src/shared/opencode-types.ts`. `src/webview/types/index.ts` re-exports those contracts for webview consumers.

Next to the `/varro/*` namespace, the architectural choice is explicit: Varro treats the extension host as a transport boundary, not as a semantic event coordinator for webview state. The extension forwards raw `server/event` payloads and serves local `/varro/*` requests, while the webview derives UI facts like pending attention and recycle-bin views from those transport primitives plus targeted REST reloads.

#### `src/shared/context-files.ts`

Handles attachment semantics.

- Normalizes and merges line ranges
- Avoids duplicate context entries for the same path
- Formats selection references such as `[Selection from path lines 12-20]`
- Lets the composer subtract already-attached ranges from the live editor selection

### Webview

#### Boot

`WebviewSession` builds `InitialWebviewState`, and `SidebarProviderBridge` passes it to `webview-html.ts` for safe inline serialization. The document installs a minimal pre-bundle failure fallback before loading `dist/webview/webview.js` and `webview.css` as separate webview resources.

That initial state includes:

- theme
- server status
- editor context
- terminal selection
- dropped files
- config such as desktop session pane side
- whether the extension host is remote
- interrupted session IDs
- pending permission and question snapshots
- recycle-bin entries, pinned session IDs, and queued-message snapshots

`src/webview/index.tsx` mounts `AppRoot` and preserves a generic reload fallback for bootstrap failures. `src/webview/App.tsx` then shows:

- `WorkspaceLoading` while a running connection restores its initial data
- `RestartBlocked` when active work prevents a server restart
- `Chat` when the server is running and providers are available
- `ServerStatus` otherwise

#### State

`src/webview/lib/app-state.ts` owns the central Solid state. `src/webview/lib/state.ts` is its compatibility barrel, and focused facades under `src/webview/lib/stores/` group app, session, composer, routing, permissions, UI, and Ralph operations for the runtime.

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
- the unsent composer text draft

Browser preferences and drafts are persisted through `BrowserPersistence`, which reads VS Code webview state first and mirrors values to `localStorage`. The authoritative queued-message snapshot, including attachment data, is stored separately in extension-host workspace state.

Ralph loop state is owned by the extension host (`src/extension/ralph-host.ts`, persisted in the workspace Memento). `src/webview/lib/stores/ralph-store.ts` is a render mirror fed by `ralph/state` broadcasts, with optimistic local updates for immediate dashboard feedback.

#### OpenCode integration

`src/webview/hooks/useOpenCode.ts` is the stable public export surface. Runtime composition lives in `src/webview/hooks/runtime/open-code-runtime-instance.ts`, with focused operations and effects under `src/webview/hooks/session/`.

Responsibilities:

- react to extension messages such as `server/status` and `context/update`
- subscribe to OpenCode events forwarded from the extension host
- fetch initial data from OpenCode REST endpoints
- send prompts, undo, abort, compact, fork, plan handoff, and permission/question responses
- derive todo state from message tool parts, with `todo.updated` acting only as a resync trigger
- synchronize per-session MCP selections with OpenCode
- recover interrupted sessions after reload when the previous run still looks incomplete

The runtime also handles workspace filtering for sessions, stale loading recovery, and model/provider limit refreshes.

#### UI composition

Key components:

- `src/webview/App.tsx`: runtime installation and top-level loading, restart-blocked, server-status, and chat selection
- `src/webview/components/Chat.tsx`: session filtering, navigation, responsive layout state, and transport banners
- `src/webview/components/chat/ChatWorkspace.tsx`: session pane, active-chat shell, composer placement, and Ralph dashboard selection
- `src/webview/components/chat/ChatHeader.tsx` and `SessionListView.tsx`: headers, status filters, search, and session trees
- `src/webview/components/ChatInput.tsx`: composer, slash commands, attachments, model/agent/MCP pickers, queueing, send modes, and the `/ralph` launcher
- `src/webview/components/MessageList.tsx`: chat transcript and loading state
- `src/webview/components/message-list/MessageRows.tsx` and `VirtualizedContent.tsx`: row rendering and virtualization
- `src/webview/components/Message.tsx` and `MessagePart.tsx`: assistant/user message and tool-part rendering
- `src/webview/components/PermissionPrompt.tsx`: inline approval UI
- `src/webview/components/ToolCall.tsx`, `src/webview/lib/assistant-activity.ts`, and
  `src/webview/components/message-list/assistant-dialog.ts`: tool-state presentation, activity
  compaction, and turn summaries, including explicit permission-rejection evidence
- `src/webview/components/QuestionPrompt.tsx`: inline question UI
- `src/webview/components/TodoList.tsx`: task progress surface
- `src/webview/components/DiffView.tsx`: file change summaries
- `src/webview/components/ModelsPanel.tsx`: model visibility and routing settings
- `src/webview/components/ralph/RalphForm.tsx`: Ralph loop setup form for plan path, iteration cap, model selection, and prompt-template overrides
- `src/webview/components/ralph/RalphDashboard.tsx` and `RalphIterationCard.tsx`: manager-session dashboard, controls, stop reasons, and per-iteration summaries

`MessageList` has coupled identity, height, pagination, visible-anchor, and scroll-ownership
requirements. Read [Message List Virtualization](message-list-virtualization.md) before changing that
area.

## Ralph Loop Flow

Ralph is a plan-driven orchestration layer that runs on the extension host, so in-flight loops keep executing while the sidebar is hidden and resume after a window reload without waiting for the webview.

- `src/shared/ralph.ts` defines Ralph run, iteration, model-selection, token-summary, and stop-reason types.
- `src/shared/ralph-runner-core.ts` contains the host-agnostic loop; all environment access (OpenCode requests, idle events, plan reads, run store) goes through injected ports so the same loop runs on the extension host, in the e2e harness, and against fakes in unit tests.
- `src/extension/ralph-host.ts` instantiates the loop over `OpenCodeServer`, persists runs in the workspace Memento, reattaches persisted running loops on activation, and broadcasts `ralph/state` snapshots to the webview.
- `/ralph` opens `RalphForm`, which creates a manager session, sends an anchor message with the loop config, and starts the runner. `src/webview/components/ralph/ralph-runner.ts` is a thin proxy that forwards start/stop/pause/resume to the host via `ralph/*` messages and applies optimistic mirror updates.
- The loop creates one child session per iteration under the manager session, builds the iteration prompt from the plan document plus the previous iteration summary, and waits for the child to go idle.
- Verification is intentionally split into a second turn. After the main work settles, the manager sends a dedicated verification prompt and parses `<name>: PASS|FAIL|SKIPPED` lines back out of the final assistant report.
- If verification fails, the runner can spawn up to two repair child sessions for that iteration. Repair sessions stay under the same manager session so their history does not pollute the original iteration session.
- Stop conditions come from plan content and runner state: an explicit `DONE` marker with no failure in the latest completed verification, a manual stop, an iteration error, or the iteration limit. Passing iterations do not stop the loop without `DONE`. Reaching the limit while the plan still has unchecked items or failed verification marks the run as `incomplete` (not `done`, and not the harder `failed` reserved for true iteration errors).
- `Chat.tsx` and `ChatWorkspace.tsx` treat Ralph manager sessions specially: manager sessions render the Ralph dashboard, Ralph roots are tagged in the session list, and navigating back from an iteration child session returns to the owning Ralph dashboard.

## Request And Event Flow

The lists below show representative traffic rather than every protocol variant. The `ExtensionMessage` and `WebviewMessage` unions in `src/shared/protocol.ts` are the canonical inventory.

### Webview to extension

The webview sends:

- `api/request` for OpenCode REST calls
- `workspace/select`, `commands/state`, and `queued-messages/update` for workspace, command, and queue synchronization
- `files/search`, `files/pick`, `files/drop`, `files/drop-content`, `files/remove`, and `files/clear` for context management
- `vscode/open`, `vscode/open-text`, `vscode/open-external`, and `vscode/open-settings` for editor integration
- `session/export` and `session/open-in-opencode` to export or hand a session to the OpenCode TUI
- `usage/report` to open recent or retained all-time usage accounting in a Markdown document
- `terminal/run` to launch setup commands such as `opencode auth login`
- `providers/watch`, `providers/refresh`, `config/update`, and `webview/focus` for provider, preference, and focus synchronization
- `ralph/*` for host-owned Ralph lifecycle and state synchronization

### Extension to webview

The extension sends:

- `server/status`
- `server/restart-blocked`
- `server/event`
- `providers/refresh` and `providers/status` for provider invalidation and pending-refresh state
- `context/update`
- `terminal-selection/update`
- `files/dropped` and `files/removed`
- `config/update` and `api/response`
- `theme/update`
- `command/*` messages for session navigation and actions
- `ralph/state`

### Prompt construction

When the user sends a message, the send operations in `src/webview/hooks/session/session-send.ts` build prompt parts from current UI state.

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
- `/varro/workspace-file`, `/varro/workspace-file/pick`, and `/varro/workspace-path/resolve` provide workspace-scoped file selection and path resolution.
- `/varro/permission/judge` evaluates eligible automatic permission decisions in the extension host.
- `/varro/session/:sessionID/*` handles diff summaries, pinning, conditional renaming, and deletion.
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

- The webview JavaScript and CSS are bundled as separate local webview resources; only initial state and the small host bridge bootstrap are inline under a CSP nonce.
- File search uses `vscode.workspace.findFiles()` with a short-lived cache and ranking heuristic rather than shelling out.
- Session lists are filtered to the active workspace path, which prevents unrelated project sessions from appearing in the sidebar.
- Queued follow-up prompts are persisted in extension-host workspace state and auto-dispatched once their owning session is connected and idle, including background sessions. The browser-side mirror excludes image-bearing entries from synchronous local storage.
- Message loads are windowed: opening a session fetches the newest 200 messages, reaching the top automatically prepends the next 200-message page while preserving the visible anchor, and the boundary banner becomes a `Retry` action only after a page request fails.
- Finder or browser drops that do not expose file paths fall back to temporary file writes in `varro-drops`.
- The event stream can be degraded while REST remains healthy, so the UI treats live updates and request availability separately.
- Provider limits are best-effort metadata; they are not guaranteed for every provider or model.
- Ralph runs persist in the extension host's workspace Memento and reattach on activation, independent of webview lifetime; runs persisted by older builds in webview localStorage are migrated to the host through `ralph/sync`.
- Server startup is lazy and workspace-scoped, which keeps activation lightweight and helps multi-project use against a shared OpenCode instance.
