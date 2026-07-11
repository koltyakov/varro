# Development Guide

This document covers source setup, packaging, and debugging for the Varro VS Code extension.

## Prerequisites

- [Node.js](https://nodejs.org/) 22.12+ or 24+
- [VS Code](https://code.visualstudio.com/) 1.120 or newer
- [OpenCode CLI](https://opencode.ai) installed globally

```sh
npm install -g opencode-ai
```

## Install Dependencies

```sh
npm install
```

If you plan to run e2e tests locally for the first time, install the Playwright browser bundle once:

```sh
npx playwright install
```

## Validate The Project

For a quick contributor sanity check:

```sh
npm run lint:check
npm run typecheck
npm run test
```

While iterating, run the narrowest relevant command for the area you changed. Useful targeted commands include:

- `npm run test -- src/webview/components/ChatInput.test.ts`
- `npm run test -- src/webview/components/ralph/ralph-runner.test.ts`
- `npm run test -- src/webview/components/ChatInput.test.ts -t "detects slash commands only at the start of the input"`
- `npm run test:e2e -- e2e/tests/layout.spec.ts`

Before packaging or publishing, a fuller verification sweep is:

```sh
npm run fmt
npm run lint
npm run typecheck
npm run test
npm run test:e2e
```

Use `npm run vscode:install` when you specifically want to package and install the VSIX into your local VS Code.

## Build

```sh
npm run build
```

This produces:

- `dist/extension/extension.js` for the extension host bundle
- `dist/webview/webview.js` and `dist/webview/webview.css` for the sidebar UI

## Load The Extension

There are two common ways to run the extension locally.

### Option A: Install A VSIX

Package the extension:

```sh
npm run package
```

This produces `varro-*.vsix` in the project root.

Install it with the VS Code CLI:

```sh
code --install-extension varro-*.vsix
```

You can also install it from the VS Code UI through **Extensions** -> `...` -> **Install from VSIX...**.

There is also a convenience script for this flow:

```sh
npm run vscode:install
```

After installation, reload the window:

- Command Palette -> **Developer: Reload Window**

### Option B: Run In An Extension Development Host

1. Open this repository in VS Code.
2. Press `F5`.
3. If prompted, select **VS Code Extension Development**.
4. A new Extension Development Host window opens with the extension loaded.

To rebuild while developing and open the webview preview:

```sh
npm run dev
```

This uses `npx concurrently` to start the extension watcher, the webview bundle watcher, and `preview.html` in Vite so you can inspect style changes immediately in the browser. If you prefer not to use `npx concurrently`, start `npm run watch:extension`, `npm run watch:webview`, and `npm run preview:webview` in separate terminals.

Reload the Extension Development Host window after extension changes.

If you only want the standalone browser preview:

```sh
npm run preview:webview
```

This serves the existing `preview.html`, which proxies to your local OpenCode server and hot-reloads the webview source via Vite.

## Runtime Overview

Varro has three layers:

1. VS Code extension host code in `src/extension/`
2. Shared protocol and context helpers in `src/shared/`
3. Solid-based webview UI in `src/webview/`

At activation time, `src/extension/extension.ts`:

- Reads `varro.*` configuration
- Creates `OpenCodeServer`
- Creates `ContextProvider`
- Creates and registers `SidebarProvider`
- Registers commands

The OpenCode server itself is not started at activation. `SidebarProvider.ensureServerStarted()` is called lazily when the view becomes active or the webview issues a request, which either attaches to an already running server or spawns `opencode serve`.

See [architecture.md](architecture.md) for a deeper component-by-component breakdown.

## Extension Host Responsibilities

### `OpenCodeServer`

`src/extension/server.ts` is the bridge to the local OpenCode HTTP server.

- Checks `/global/health` before spawning anything
- Starts `opencode serve --port <port>` only when Varro first needs the server and auto-start is enabled
- Adds the current workspace directory to non-global requests
- Opens an SSE connection to `/api/event`
- Reconnects the event stream with backoff
- Restarts the child process a limited number of times if it exits unexpectedly

Important behavior:

- The current workspace folder is attached to requests through both a `directory` query param and `x-opencode-directory` header.
- If the spawned server reports that the configured port is already in use, Varro can retry on nearby ports.
- If the SSE stream drops while REST is still available, Varro keeps the chat usable and reports the event stream as degraded.
- A background maintenance loop checks the installed OpenCode CLI version, can suggest `opencode upgrade`, and can restart a Varro-managed server when the CLI is newer and no sessions are active.

### `ContextProvider`

`src/extension/context-provider.ts` tracks live VS Code context.

- Current workspace folder
- Active file path and language
- Active text selection
- Up to 20 diagnostics from the active editor
- Terminal selection captured via the terminal copy command

Terminal selection capture preserves the clipboard by restoring the previous clipboard contents after reading the terminal selection.

It debounces editor and diagnostics updates before posting them to the webview.

### `SidebarProvider`

`src/extension/sidebar-provider.ts` owns the webview lifecycle and message bridge.

- Injects the built webview HTML, CSS, and JS into the sidebar
- Sends initial state to the webview inline
- Proxies webview API calls to the OpenCode server
- Handles file search, file picking, dropped files, and VS Code open actions
- Tracks session attention state for notifications and a status bar item
- Resolves provider limit metadata through OpenCode or supported provider APIs

It also exposes the Varro extension-host API namespace, `/varro/*`:

- `GET /varro/provider-limit`
- `POST /varro/plan/open`
- `GET /varro/opencode-config`
- `POST /varro/opencode-config/model-routing`
- `GET /varro/session-trash`
- `POST /varro/session-trash/:rootID/restore`
- `DELETE /varro/session-trash/:rootID/delete`
- `DELETE /varro/session-trash`

Those paths share the same `api/request` bridge as OpenCode REST calls, but the extension host resolves them locally instead of forwarding them to OpenCode.

This is also the architecture boundary: the extension host acts as transport plus local `/varro/*` services, while the webview computes higher-level UI state from raw `server/event` traffic and follow-up `/varro/*` reads when needed.

Drag and drop also has a fallback path for environments that do not expose local file paths. In that case, the webview sends file bytes and the extension writes them to a temporary `varro-drops` directory before attaching them as context.

### `commands.ts`

`src/extension/commands.ts` registers the VS Code command surface.

- Focus the Varro view and composer
- Start a new session
- Abort the active session
- Restart the OpenCode server
- Add Explorer files, editor selections, or terminal selections to context

## Webview Responsibilities

### State And Connection

`src/webview/lib/state.ts` holds client-side app state, including:

- Sessions and active session
- Messages, tool parts, todos, diffs, permissions, and questions
- Selected model, agent, reasoning variant, and MCP set
- Dropped files, pasted images, and terminal selection
- Workspace-scoped permission mode preferences and model visibility preferences
- Current-document context toggles and skipped plan-session markers
- Pending attention session IDs and interrupted session IDs from the extension host

`src/webview/hooks/useOpenCode.ts` is the main integration hook.

- Initializes the UI once the server reports `running`
- Loads sessions, agents, providers, MCP status, and questions
- Subscribes to extension messages and OpenCode server events
- Builds prompt parts before sending messages
- Keeps session state in sync during streaming, compaction, follow-up actions, usage-limit retries, and permission mode changes
- Recovers interrupted sessions after extension reload when they are safe to continue
- Synchronizes per-session MCP selection with OpenCode connect and disconnect calls
- Opens saved plan documents and supports plan-to-build handoff flows

### Message Transport

- `src/shared/protocol.ts` defines extension-to-webview and webview-to-extension messages.
- `src/webview/lib/bridge.ts` wraps `postMessage` and API request/response correlation.
- `src/webview/lib/client.ts` exposes typed helpers for OpenCode endpoints such as `/session`, `/agent`, `/config/providers`, `/question`, `/mcp`, and Varro pseudo-endpoints.

## Context Semantics

Explicit context files are represented by `DroppedFile` in `src/shared/protocol.ts`.

- Files can optionally include line ranges.
- Directories never carry line ranges.
- Repeated attachments are merged by `src/shared/context-files.ts`.
- Overlapping line ranges are normalized and compacted.

When sending a prompt, the webview builds message parts in roughly this order:

1. User text
2. `[Working directory: ...]`
3. Active file or active selection reference, when current-document context is enabled for the session
4. Terminal selection block
5. Explicitly attached files and folders
6. Clipboard images for vision-capable models

## Session Behavior

The webview filters sessions to the current workspace path. This matters when the same OpenCode instance serves multiple projects.

While a session is running:

- follow-ups are queued instead of being sent immediately, including any files, images, or terminal selection attached to the queued message
- `Ctrl+Enter` or `Cmd+Enter` sends a steering message with `noReply`
- queued prompts are dispatched automatically once the active session becomes idle

The session UI also distinguishes running, attention-needed, failed, completed, and plan-ready states. On larger layouts, the session list can stay pinned beside the main chat pane.

## Provider Limits

Varro exposes `/varro/provider-limit` under the `/varro/*` extension-host API namespace.

The implementation in `src/extension/provider-limit-service.ts` and `src/extension/provider-limits/` tries these sources in order:

1. Enabled provider-limit adapters, including direct provider or local metadata probes for supported providers
2. Provider or model metadata already returned by OpenCode
3. `/experimental/console` metadata from OpenCode

Results are cached briefly in the extension host before being shown in the composer toolbar.

## MCP And Plan Flows

Varro can manage MCP connectivity per session.

- The webview loads MCP status from OpenCode on startup.
- The MCP picker stores the desired MCP set per session.
- `useOpenCode.ts` connects newly selected MCPs and disconnects removed ones, then refreshes status.

Plan responses have two extra flows in the UI.

- `Open plan` normalizes the markdown and writes it to the OpenCode plans directory before opening it in VS Code.
- `Implement the plan` switches into the build-oriented flow and continues from the plan instead of asking the plan agent to revise it.

## Debugging

### Extension Host

- Set breakpoints in `src/extension/*.ts`
- Extension-side logs are written to the parent VS Code window's Debug Console
- You can also use **Attach to Node Process** from the Command Palette if needed

### Webview

The chat UI runs inside a VS Code webview.

1. In the Extension Development Host window, open the Command Palette.
2. Run **Developer: Open Webview Developer Tools**.
3. Use DevTools to inspect the UI, view console logs, and debug the webview code.

The webview build outputs source maps in `dist/webview/webview.js.map`.

## Connect To An Existing OpenCode Server

By default, Varro tries to auto-start OpenCode on port `4096`. You can connect to an already running server instead.

Start OpenCode manually:

```sh
opencode serve --port 4096
```

Then configure these VS Code settings as needed:

- `varro.server.port`
- `varro.server.autoStart`
- `varro.server.command`

Varro checks `http://127.0.0.1:<port>/global/health` to verify the server.

If Varro launched the server itself and the configured port is already occupied by a different process, it can retry on a nearby port. Set `varro.server.port` explicitly if you want a fixed server address.

## Project Structure

```text
src/
  extension/          VS Code extension host code
    extension.ts      Activation entry point
    server.ts         OpenCode server process management
    sidebar-provider.ts
    context-provider.ts
    commands.ts
    file-search-service.ts
    session-state-manager.ts
    logger.ts
    util/
  webview/            Sidebar chat UI
    components/       Solid UI components
    hooks/            OpenCode integration hook
    lib/              State, bridge, formatting, helpers
  shared/             Shared protocol types
docs/
  usage.md            End-user workflow guide
  development.md      Build, debug, and contributor guide
  architecture.md     Runtime architecture reference
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run build` | Build extension and webview |
| `npm run build:extension` | Build the extension host bundle |
| `npm run build:webview` | Build the webview bundle |
| `npm run preview:webview` | Serve `preview.html` for standalone webview preview |
| `npm run watch:extension` | Watch and rebuild the extension host |
| `npm run watch:webview` | Watch and rebuild the webview |
| `npm run dev` | Run both watch tasks and open `preview.html` |
| `npm run lint` | Run oxlint with `--fix` on `src/` |
| `npm run lint:check` | Run oxlint without fixing |
| `npm run fmt` | Format `src/` with oxfmt |
| `npm run test` | Run the Vitest suite |
| `npm run test:coverage` | Run tests with coverage output |
| `npm run typecheck` | Run TypeScript checks for extension, webview, and e2e code |
| `npm run package` | Build and create a VSIX package |
| `npm run vscode:install` | Package and install the VSIX into local VS Code |
