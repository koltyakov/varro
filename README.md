# OpenCode VSCode Extension

AI-powered agentic coding assistant for VSCode, powered by [OpenCode](https://opencode.ai).

## Prerequisites

- [Node.js](https://nodejs.org) >= 18
- [VSCode](https://code.visualstudio.com) >= 1.85
- [OpenCode CLI](https://github.com/anomalyco/opencode) installed globally (`npm install -g opencode-ai`)

## Quick Start

```sh
# 1. Install dependencies
npm install

# 2. Build the extension
npm run build
```

Then see below for how to load it into VSCode.

## Installing the Extension in VSCode

There are two ways to load the extension:

### Option A: Install from VSIX (for regular use)

```sh
# Package the extension into a .vsix file
npm run package
```

This produces `opencode-vscode-0.1.0.vsix` in the project root. Install it:

```sh
code --install-extension opencode-vscode-0.1.0.vsix
```

Or via the VSCode UI: open the **Extensions** view (`Cmd+Shift+X`), click the `…` menu, select **"Install from VSIX..."**, and pick the `.vsix` file.

Reload the window after installing (`Cmd+Shift+P` → **"Developer: Reload Window"**).

### Option B: Run in Extension Development Host (for development/debugging)

1. Open this project in VSCode:

   ```sh
   code /path/to/vschat
   ```

2. Press **F5** to launch a new **Extension Development Host** window with the extension loaded. (If prompted, select **"VS Code Extension Development"** as the debug configuration.)

3. The extension is now running in the new window. Look for the **OpenCode** icon in the sidebar, or press `Cmd+Shift+O`.

4. To make changes and see them reflected, run the watchers in a terminal:

   ```sh
   npm run dev
   ```

   Then reload the Extension Development Host window (`Cmd+Shift+P` → **"Developer: Reload Window"** or the restart button in the debug toolbar).

## Debugging

### Debug the extension host (Node.js)

- **Breakpoints**: Set breakpoints in any `src/extension/*.ts` file. The Extension Development Host will pause at them.
- **Debug Console**: Logs from `src/extension/logger.ts` appear in the Debug Console of the parent VSCode window.
- **Attach manually**: Use the **"Attach to Node Process"** command from the command palette.

### Debug the webview (browser)

The webview runs in an iframe inside VSCode. To debug it:

1. In the **Extension Development Host** window, run **"Developer: Open Webview Developer Tools"** from the command palette (`Cmd+Shift+P`)
2. This opens Chrome DevTools for the webview. Inspect elements, view console logs, and set breakpoints.

The webview build produces source maps (`dist/webview/webview.js.map`). Enable source maps in DevTools settings for the best experience.

## Connecting to an Existing OpenCode Server

1. Go to the **Run and Debug** view (`Cmd+Shift+D` / `Ctrl+Shift+D`)
2. If there is no existing launch configuration, create one:
   - Click **"create a launch.json file"**
   - Select **VS Code Extensions** as the environment
   - This will generate `.vscode/launch.json` automatically
3. Set the **launch program** field to `${workspaceFolder}` (the default for extension debugging)
4. Press **F5** (or click **Run > Start Debugging**)

A new VSCode **Extension Development Host** window will open with the extension loaded.

If you don't have a `launch.json`, you can also press F5 directly — VSCode will prompt you to select the extension to debug.

### 5. Verify the extension is running

- Open the sidebar and look for the **OpenCode** icon in the auxiliary bar (right sidebar)
- Or press `Cmd+Shift+O` / `Ctrl+Shift+O` to focus the chat
- Check the **Debug Console** in the original VSCode window for extension logs

### 6. Debug the extension host (Node.js)

- **Breakpoints**: Set breakpoints in any `src/extension/*.ts` file. The Extension Development Host will pause at them.
- **Debug Console**: Logs from `src/extension/logger.ts` appear in the Debug Console of the parent VSCode window.
- **Attach manually**: If you need to attach the debugger to a running Extension Development Host, use the **"Attach to Node Process"** command from the command palette.

### 7. Debug the webview (browser)

The webview runs in an iframe inside VSCode. To debug it:

1. In the **Extension Development Host** window, run the command **"Developer: Open Webview Developer Tools"** from the command palette (`Cmd+Shift+P`)
2. This opens Chrome DevTools for the webview. You can inspect elements, view console logs, and set breakpoints in the webview JavaScript.

For source-mapped debugging of the SolidJS webview (`src/webview/`):

- The webview build produces source maps (`dist/webview/webview.js.map`). Enable source maps in DevTools settings for the best experience.

## Connecting to an Existing OpenCode Server

By default, the extension auto-starts the OpenCode server on port **4096**. You can also connect to an already-running server:

1. Start the server manually:

   ```sh
   opencode serve --port 4096
   ```

2. In VSCode settings, configure:
   - `opencode.server.port` — the port the server is running on (default: `4096`)
   - `opencode.server.autoStart` — set to `false` to prevent the extension from spawning its own server process

3. Reload the VSCode window (`Cmd+Shift+P` → **"Developer: Reload Window"**)

The extension will discover the running server via its health check endpoint (`http://127.0.0.1:<port>/global/health`).

## Project Structure

```
src/
  extension/          # VSCode extension (Node.js, runs in extension host)
    extension.ts      # Entry point — activates the extension
    server.ts         # Spawns/manages the OpenCode CLI server process
    sidebar-provider.ts  # Webview view provider for the sidebar panel
    context-provider.ts # Manages editor context (active file, selection)
    commands.ts       # VSCode command registrations
    file-drop.ts      # File drop handling
    logger.ts         # Extension-side logging
  webview/            # Chat UI (SolidJS, runs in webview iframe)
  shared/             # Shared protocol types between extension and webview
```

## Scripts

| Command                  | Description                                  |
| ------------------------ | -------------------------------------------- |
| `npm run build`          | Build extension and webview                  |
| `npm run build:extension`| Build extension only                         |
| `npm run build:webview`  | Build webview only                           |
| `npm run watch:extension`| Watch and rebuild extension on changes       |
| `npm run watch:webview`  | Watch and rebuild webview on changes         |
| `npm run dev`            | Watch both extension and webview             |
| `npm run lint`           | Type-check extension and webview             |
| `npm run package`        | Build and package as VSIX                    |