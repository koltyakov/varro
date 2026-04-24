# Architecture Guide

This document maps the current Varro codebase to the runtime behavior of the extension.

## High-Level Flow

1. VS Code activates the extension from `src/extension/extension.ts`.
2. `SidebarProvider` creates the webview and injects initial state.
3. The first webview interaction triggers the server lifecycle — Varro either attaches to a running OpenCode server on the configured port or spawns `opencode serve`.
4. The webview sends `ready` and starts loading sessions, agents, providers, and questions.
5. The extension host proxies API requests to the OpenCode server and forwards SSE events into the webview.
6. The webview updates local state and renders structured chat UI.

Server startup is deferred: activation only constructs the `OpenCodeServer` object, and the actual `start()` call is issued from `SidebarProvider.ensureServerStarted()` the first time the UI needs it.

## Main Runtime Pieces

### Extension Host

#### `src/extension/extension.ts`

- Reads extension configuration from `varro.*`
- Instantiates `OpenCodeServer`, `ContextProvider`, and `SidebarProvider`
- Registers the webview view provider and VS Code commands
- Sets the `varro:activated` context key
- Does not start the OpenCode server directly — startup is deferred until the webview first needs it

#### `src/extension/server.ts`

- Owns the local OpenCode process
- Checks health before auto-starting
- Adds workspace scoping to non-global API calls
- Connects to the OpenCode event stream at `/event`
- Emits `status` and `event` to the rest of the extension

Important behavior:

- The current workspace folder is attached to requests through both a `directory` query param and `x-opencode-directory` header.
- If the SSE stream drops while the server is running, Varro retries with exponential backoff.
- If the child process exits after startup, Varro attempts a limited restart sequence.

#### `src/extension/context-provider.ts`

- Watches editor focus, selection changes, diagnostics, and workspace folder changes
- Maintains the current `EditorContext`
- Captures terminal selection by temporarily invoking the VS Code terminal copy command
- Reads and opens files requested by the webview

#### `src/extension/sidebar-provider.ts`

This is the main extension-side coordinator.

- Hosts the webview HTML
- Receives UI messages from the webview
- Proxies HTTP requests to `OpenCodeServer`
- Tracks dropped files, file search cache, and provider limit cache
- Sends notifications and updates a status bar item when background sessions finish or need attention

It also exposes a Varro-specific pseudo-endpoint:

- `GET /varro/provider-limit`

That endpoint is resolved locally by the extension host rather than forwarded directly to OpenCode.

### Shared Layer

#### `src/shared/protocol.ts`

Defines:

- `EditorContext`
- `DroppedFile`
- `ServerStatus`
- extension-to-webview messages
- webview-to-extension messages

The protocol is intentionally small and transport-oriented. OpenCode domain types such as `Session`, `Message`, and `Part` live under `src/webview/types/` because they are consumed mainly by the UI.

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
- hidden providers and models
- permission modes
- queued follow-up messages

Several pieces are persisted in `localStorage`, including selected model, hidden models, permission mode preferences, and last active session ID.

#### OpenCode integration

`src/webview/hooks/useOpenCode.ts` is the most important webview file.

Responsibilities:

- react to extension messages such as `server/status` and `context/update`
- subscribe to OpenCode events forwarded from the extension host
- fetch initial data from OpenCode REST endpoints
- send prompts, undo, abort, compact, and permission/question responses
- rebuild todo state either from explicit `todo.updated` events or from tool parts in messages

The hook also handles workspace filtering for sessions, stale loading recovery, and model/provider limit refreshes.

#### UI composition

Key components:

- `src/webview/components/Chat.tsx`: session header, session list, and top-level chat layout
- `src/webview/components/ChatInput.tsx`: composer, slash commands, attachments, model/agent pickers, queueing, and send modes
- `src/webview/components/MessageList.tsx`: chat transcript and loading state
- `src/webview/components/Message.tsx` and `MessagePart.tsx`: assistant/user message rendering
- `src/webview/components/PermissionPrompt.tsx`: inline approval UI
- `src/webview/components/QuestionPrompt.tsx`: inline question UI
- `src/webview/components/TodoList.tsx`: task progress surface
- `src/webview/components/DiffView.tsx`: file change summaries
- `src/webview/components/SettingsPanel.tsx`: model visibility settings

## Request and Event Flow

### Webview to extension

The webview sends:

- `api/request` for OpenCode REST calls
- `files/search`, `files/pick`, `files/drop`, and `files/remove` for context management
- `vscode/open` and `vscode/diff` for editor integration
- `terminal/run` to launch setup commands such as `opencode auth login`

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
3. active file or active selection marker
4. terminal selection block
5. explicit context files and folders
6. pasted image files when the model supports vision

This is where Varro turns live VS Code context into OpenCode-compatible prompt parts.

## Session and attention model

Varro distinguishes three session states in the UI:

- running
- attention needed
- recent or completed

The extension host derives attention from server events such as:

- `permission.asked`
- `question.asked`
- `session.idle`

That information drives both:

- sidebar notifications
- the status bar item shown when the sidebar is hidden

## Notable implementation details

- The webview is bundled and inlined into the HTML payload instead of loaded as separate local resources.
- File search uses `vscode.workspace.findFiles()` with a short-lived cache and ranking heuristic rather than shelling out.
- Session lists are filtered to the active workspace path, which prevents unrelated project sessions from appearing in the sidebar.
- Queued follow-up prompts are stored client-side and auto-dispatched once the active session becomes idle.
- Provider limits are best-effort metadata; they are not guaranteed for every provider or model.
