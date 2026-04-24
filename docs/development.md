# Development Guide

This document covers source setup, packaging, and debugging for the Varro VS Code extension.

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer
- [VS Code](https://code.visualstudio.com/) 1.91 or newer
- [OpenCode CLI](https://opencode.ai) installed globally

```sh
npm install -g opencode-ai
```

## Install Dependencies

```sh
npm install
```

## Build

```sh
npm run build
```

This produces:

- `dist/extension/extension.js` for the extension host bundle
- `dist/webview/webview.js` and `dist/webview/webview.css` for the sidebar UI

## Load the Extension

There are two common ways to run the extension locally.

### Option A: Install a VSIX

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

### Option B: Run in an Extension Development Host

1. Open this repository in VS Code.
2. Press `F5`.
3. If prompted, select **VS Code Extension Development**.
4. A new Extension Development Host window opens with the extension loaded.

To rebuild while developing:

```sh
npm run dev
```

Then reload the Extension Development Host window after changes.

## Architecture Overview

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

The OpenCode server itself is not started at activation. `SidebarProvider.ensureServerStarted()` is called lazily the first time the webview issues a request, which either attaches to an already running server or spawns `opencode serve`.

See [architecture.md](architecture.md) for a deeper component-by-component breakdown.

## Extension Host Responsibilities

### `OpenCodeServer`

`src/extension/server.ts` is the bridge to the local OpenCode HTTP server.

- Checks `/global/health` before spawning anything
- Starts `opencode serve --port <port>` when auto-start is enabled
- Adds the current workspace directory to non-global requests
- Opens an SSE connection to `/event`
- Reconnects the event stream with backoff
- Restarts the child process a limited number of times if it exits unexpectedly

### `ContextProvider`

`src/extension/context-provider.ts` tracks live VS Code context.

- Current workspace folder
- Active file path and language
- Active text selection
- Up to 20 diagnostics from the active editor
- Terminal selection captured via the terminal copy command

It debounces editor and diagnostics updates before posting them to the webview.

### `SidebarProvider`

`src/extension/sidebar-provider.ts` owns the webview lifecycle and message bridge.

- Injects the built webview HTML, CSS, and JS into the sidebar
- Sends initial state to the webview inline
- Proxies webview API calls to the OpenCode server
- Handles file search, file picking, dropped files, and VS Code open/diff actions
- Tracks session attention state for notifications and a status bar item
- Resolves provider limit metadata through OpenCode or supported provider APIs

## Webview Responsibilities

### State and connection

`src/webview/lib/state.ts` holds client-side app state, including:

- Sessions and active session
- Messages, tool parts, todos, diffs, permissions, and questions
- Selected model, agent, and reasoning variant
- Dropped files, pasted images, and terminal selection
- Workspace-scoped permission mode preferences and model visibility preferences

`src/webview/hooks/useOpenCode.ts` is the main integration hook.

- Initializes the UI once the server reports `running`
- Loads sessions, agents, providers, and questions
- Subscribes to extension messages and OpenCode server events
- Builds prompt parts before sending messages
- Keeps session state in sync during streaming, compaction, and follow-up actions

### Message transport

- `src/shared/protocol.ts` defines extension-to-webview and webview-to-extension messages.
- `src/webview/lib/bridge.ts` wraps `postMessage` and API request/response correlation.
- `src/webview/lib/client.ts` exposes typed helpers for OpenCode endpoints such as `/session`, `/agent`, `/config/providers`, and `/question`.

## Context Semantics

Explicit context files are represented by `DroppedFile` in `src/shared/protocol.ts`.

- Files can optionally include line ranges.
- Directories never carry line ranges.
- Repeated attachments are merged by `src/shared/context-files.ts`.
- Overlapping line ranges are normalized and compacted.

When sending a prompt, the webview builds message parts in roughly this order:

1. User text
2. `[Working directory: ...]`
3. Active file or active selection reference
4. Terminal selection block
5. Explicitly attached files and folders
6. Clipboard images for vision-capable models

## Session Behavior

The webview filters sessions to the current workspace path. This matters when the same OpenCode instance serves multiple projects.

While a session is running:

- plain text follow-ups are queued instead of being sent immediately
- `Ctrl+Enter` or `Cmd+Enter` sends a steering message with `noReply`
- queued prompts are dispatched automatically once the session becomes idle

## Provider Limits

Varro exposes a custom API path, `/varro/provider-limit`, from the extension side.

The implementation in `src/extension/sidebar-provider.ts` and `src/extension/util/provider-limit.ts` tries these sources in order:

1. Provider or model metadata already returned by OpenCode
2. `/experimental/console` metadata from OpenCode
3. A direct provider metadata probe for supported providers such as OpenAI and GitHub Copilot

Results are cached briefly in the extension host before being shown in the composer toolbar.

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

## Connect to an Existing OpenCode Server

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

## Project Structure

```text
src/
  extension/          VS Code extension host code
    extension.ts      Activation entry point
    server.ts         OpenCode server process management
    sidebar-provider.ts
    context-provider.ts
    commands.ts
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
| `npm run watch:extension` | Watch and rebuild the extension host |
| `npm run watch:webview` | Watch and rebuild the webview |
| `npm run dev` | Run both watch tasks |
| `npm run lint` | Run oxlint with `--fix` on `src/` |
| `npm run lint:check` | Run oxlint without fixing |
| `npm run fmt` | Format `src/` with oxfmt |
| `npm run test` | Run the Vitest suite |
| `npm run test:coverage` | Run tests with coverage output |
| `npm run typecheck` | Run TypeScript checks for extension and webview |
| `npm run package` | Build and create a VSIX package |
