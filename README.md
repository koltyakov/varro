# OpenCode for VS Code

Use [OpenCode](https://opencode.ai) inside VS Code without leaving the editor. The extension adds a dedicated sidebar chat that connects to your local OpenCode CLI/server and keeps your current workspace context close to the conversation.

## What It Does

- Opens OpenCode in a VS Code sidebar view
- Uses the active file, current selection, and diagnostics as live editor context
- Lets you attach extra files and folders from the Explorer
- Supports pasted image attachments in chat
- Lets you switch available models and thinking levels from your OpenCode setup
- Shows permission prompts, session history, share actions, and generated diffs in the editor workflow

## Prerequisites

Before using the extension, make sure you have:

- [VS Code](https://code.visualstudio.com/) 1.91 or newer
- [Node.js](https://nodejs.org/) 18 or newer
- The OpenCode CLI installed and available on your `PATH`

```sh
npm install -g opencode-ai
```

The extension talks to a local OpenCode server on port `4096` by default and will try to start it automatically. If your CLI lives somewhere custom, set `opencode.server.command` in VS Code settings.

## Getting Started

1. Install the extension.
2. Install the OpenCode CLI:

   ```sh
   npm install -g opencode-ai
   ```

3. Open VS Code and launch the chat:
   - Click the **OpenCode** icon in the Activity Bar, or
   - Run **OpenCode: Focus Chat**
4. Start a prompt. The extension automatically makes the active file and current selection available as context.
5. Add more context when needed:
   - Right-click a file or folder in Explorer and choose **OpenCode: Add to Context**
   - Press `Cmd+Shift+K` / `Ctrl+Shift+K`
   - Drag files or folders into the chat
   - Paste an image into the input box
6. If OpenCode asks for permission to run a tool or action, approve or deny it directly in the chat panel.

## Commands

- `OpenCode: Focus Chat` opens the sidebar chat. Shortcut: `Cmd+Shift+O` / `Ctrl+Shift+O`
- `OpenCode: Add to Context` attaches the current file, or selected Explorer items, as context. Shortcut: `Cmd+Shift+K` / `Ctrl+Shift+K`
- `OpenCode: New Session` starts a fresh chat session
- `OpenCode: Share Session` triggers OpenCode's session sharing flow
- `OpenCode: Abort Session` stops the current run

## Settings

The extension contributes these user-facing settings:

- `opencode.server.autoStart`: automatically start the local OpenCode server when the extension activates
- `opencode.server.port`: port used to connect to OpenCode, default `4096`
- `opencode.server.command`: optional full path to the OpenCode CLI executable
- `opencode.context.autoAttachFile`: context attachment preference exposed in settings
- `opencode.context.autoAttachSelection`: selection attachment preference exposed in settings

## Troubleshooting

- If you see **OpenCode unavailable**, confirm the CLI is installed and that `opencode` works in a terminal.
- If you already run OpenCode yourself, point the extension at the correct port with `opencode.server.port`, or disable `opencode.server.autoStart`.
- If the CLI is not on your `PATH`, set `opencode.server.command` to the full executable path.
- If no models appear, check your OpenCode configuration and available providers in your local OpenCode setup.

## Development

Packaging, source installs, debugging, scripts, and project structure are documented in [docs/development.md](docs/development.md).
