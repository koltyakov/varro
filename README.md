# Varro for VS Code

Varro is a native VS Code sidebar for [OpenCode](https://opencode.ai). It keeps your current workspace, editor context, approvals, and session history inside the IDE so you can use OpenCode without bouncing to another terminal or app.

![Varro in VS Code](https://raw.githubusercontent.com/koltyakov/varro/main/assets/demo.png)

## Highlights

- Native OpenCode chat in a dedicated VS Code sidebar view
- Live context from the active file, selection, terminal selection, and diagnostics
- Extra context from Explorer, drag and drop, file search, and pasted images
- Session list with background completion and attention notifications
- Inline permission prompts, follow-up questions, todo tracking, and diff summaries
- Model, agent, and reasoning variant selection from your local OpenCode setup

## Requirements

- [VS Code](https://code.visualstudio.com/) 1.91 or newer
- [Node.js](https://nodejs.org/) 18 or newer
- The OpenCode CLI installed

## Quick Start

1. Install the extension.
2. Install the OpenCode CLI:

   ```sh
   npm install -g opencode-ai
   ```

3. If you have not configured a provider yet, run:

   ```sh
   opencode auth login
   ```

4. Open **Varro** from the Activity Bar, or run **Varro: Focus Chat**.
5. Start prompting. Varro automatically includes the active file and current selection by default.
6. Add more context when needed:
   - Right-click a file or folder in Explorer and choose **Varro: Add to Context**
   - Select terminal text and run **Varro: Add Terminal Selection to Context**
   - Drag files or folders into the chat
   - Paste an image into the input box
7. Approve or reject tool permissions and answer follow-up questions directly in the chat panel.

## Commands

- `Varro: Focus Chat` opens the sidebar chat. Shortcut: `Cmd+Shift+O` / `Ctrl+Shift+O`
- `Varro: Add to Context` attaches the current file, or selected Explorer items, as context. Shortcut: `Cmd+Shift+K` / `Ctrl+Shift+K`
- `Varro: Add Terminal Selection to Context` attaches the selected terminal text as context when terminal focus is active
- `Varro: New Session` starts a fresh chat session
- `Varro: Abort Session` stops the current run
- `Varro: Restart Server` restarts the local OpenCode server process

## Settings

- `varro.server.autoStart`: automatically start the local OpenCode server when the extension activates
- `varro.server.port`: port used to connect to OpenCode, default `4096`
- `varro.server.command`: optional full path to the OpenCode CLI executable used to start the server
- `varro.context.autoAttachFile`: automatically include the active file in live editor context
- `varro.context.autoAttachSelection`: automatically include the current selection in live editor context

## Troubleshooting

- If Varro cannot connect, confirm the OpenCode CLI is installed and `opencode` works in a terminal.
- If the CLI is installed somewhere custom, set `varro.server.command` to the executable path.
- If you already run OpenCode yourself, set `varro.server.port` to the right port or disable `varro.server.autoStart`.
- If no models appear, make sure a provider is configured with `opencode auth login` and restart Varro.

## Documentation

- Usage guide: [docs/usage.md](https://github.com/koltyakov/varro/blob/main/docs/usage.md)
- Development guide: [docs/development.md](https://github.com/koltyakov/varro/blob/main/docs/development.md)

## License

MIT License. See [LICENSE](https://github.com/koltyakov/varro/blob/main/LICENSE).
