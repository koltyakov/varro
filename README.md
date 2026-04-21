# Varro for VS Code

Use [OpenCode](https://opencode.ai) inside VS Code without leaving the editor. Varro adds a dedicated sidebar chat that connects to your local OpenCode CLI/server and keeps your current workspace context close to the conversation.

## What It Does

- Opens Varro in a VS Code sidebar view powered by OpenCode
- Uses the active file, current selection, terminal selection, and diagnostics as live editor context
- Lets you attach extra files and folders from the Explorer
- Supports pasted image attachments in chat
- Lets you switch available models and thinking levels from your OpenCode setup
- Shows permission prompts, session history, and generated diffs in the editor workflow

## Prerequisites

Before using Varro, make sure you have:

- [VS Code](https://code.visualstudio.com/) 1.91 or newer
- [Node.js](https://nodejs.org/) 18 or newer
- The OpenCode CLI installed and available on your `PATH`

```sh
npm install -g opencode-ai
```

Varro talks to a local OpenCode server on port `4096` by default and will try to start it automatically. If your CLI lives somewhere custom, set `varro.server.command` in VS Code settings.

## Getting Started

1. Install the extension.
2. Install the OpenCode CLI:

   ```sh
   npm install -g opencode-ai
   ```

3. Open VS Code and launch the chat:
   - Click the **Varro** icon in the Activity Bar, or
   - Run **Varro: Focus Chat**
4. Start a prompt. Varro automatically makes the active file and current selection available as context by default.
5. Add more context when needed:
   - Right-click a file or folder in Explorer and choose **Varro: Add to Context**
   - Select text in the integrated terminal and run **Varro: Add Terminal Selection to Context**
   - Press `Cmd+Shift+K` / `Ctrl+Shift+K`
   - Drag files or folders into the chat
   - Paste an image into the input box
6. If OpenCode asks for permission to run a tool or action, approve or deny it directly in the chat panel.

## Recommended Layout

Varro works well in VS Code's Secondary Sidebar so you can keep your editor visible while chatting on the right.

1. Open **Varro** from the Activity Bar.
2. Right-click the **Varro** view title.
3. Choose **Move View** -> **Secondary Side Bar**.

You can also drag the Varro view to the right edge of the window. VS Code keeps that placement until you move it again.

## Commands

- `Varro: Focus Chat` opens the sidebar chat. Shortcut: `Cmd+Shift+O` / `Ctrl+Shift+O`
- `Varro: Add to Context` attaches the current file, or selected Explorer items, as context. Shortcut: `Cmd+Shift+K` / `Ctrl+Shift+K`
- `Varro: Add Terminal Selection to Context` attaches the selected terminal text as context. Shortcut: `Cmd+Shift+K` / `Ctrl+Shift+K` when terminal focus is active
- `Varro: New Session` starts a fresh chat session
- `Varro: Abort Session` stops the current run

## Settings

Varro contributes these user-facing settings:

- `varro.server.autoStart`: automatically start the local OpenCode server when the extension activates
- `varro.server.port`: port used to connect to OpenCode, default `4096`
- `varro.server.command`: optional full path to the OpenCode CLI executable
- `varro.context.autoAttachFile`: automatically include the active file in live editor context
- `varro.context.autoAttachSelection`: automatically include the current selection in live editor context

## Troubleshooting

- If you see **Varro unavailable**, confirm the OpenCode CLI is installed and that `opencode` works in a terminal.
- If you already run OpenCode yourself, point Varro at the correct port with `varro.server.port`, or disable `varro.server.autoStart`.
- If the CLI is not on your `PATH`, set `varro.server.command` to the full executable path.
- If no models appear, check your OpenCode configuration and available providers in your local OpenCode setup.

## Development

Packaging, source installs, debugging, scripts, and project structure are documented in [docs/development.md](docs/development.md).
