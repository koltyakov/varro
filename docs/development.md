# Development Guide

This document covers source setup, packaging, and debugging for the VS Code extension.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer
- [VS Code](https://code.visualstudio.com/) 1.91 or newer
- [OpenCode CLI](https://github.com/anomalyco/opencode) installed globally

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

## Load the Extension

There are two common ways to run the extension locally.

### Option A: Install a VSIX

Package the extension:

```sh
npm run package
```

This produces `vscode-opencode-0.1.0.vsix` in the project root.

Install it with the VS Code CLI:

```sh
code --install-extension vscode-opencode-0.1.0.vsix
```

You can also install it from the VS Code UI through **Extensions** -> `...` -> **Install from VSIX...**.

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

By default, the extension tries to auto-start OpenCode on port `4096`. You can connect to an already running server instead.

Start OpenCode manually:

```sh
opencode serve --port 4096
```

Then configure these VS Code settings as needed:

- `opencode.server.port`
- `opencode.server.autoStart`
- `opencode.server.command`

The extension checks `http://127.0.0.1:<port>/global/health` to verify the server.

## Project Structure

```text
src/
  extension/          VS Code extension host code
    extension.ts      Activation entry point
    server.ts         OpenCode server process management
    sidebar-provider.ts
    context-provider.ts
    commands.ts
    file-drop.ts
    logger.ts
  webview/            Sidebar chat UI
  shared/             Shared protocol types
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
| `npm run fmt` | Format `src/` with oxfmt |
| `npm run typecheck` | Run TypeScript checks for extension and webview |
| `npm run package` | Build and create a VSIX package |
