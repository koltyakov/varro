# Varro for VS Code

Varro is a native VS Code sidebar for [OpenCode](https://opencode.ai). It keeps your current workspace, editor context, approvals, and session history inside the IDE so you can use OpenCode without bouncing to another terminal or app.

![Varro in VS Code](https://raw.githubusercontent.com/koltyakov/varro/main/assets/demo.png)

## Highlights

- Native OpenCode chat in a dedicated VS Code sidebar view
- Live context from the active file, selection, terminal selection, Explorer, drag and drop, `@` mentions, and pasted images
- Workspace-scoped sessions with running, attention-needed, failed, completed, and plan-ready states
- Inline permission prompts, follow-up questions, todo tracking, diff summaries, and usage-limit notices
- Agent, model, reasoning variant, and MCP selection from your local OpenCode setup
- Background notifications and a status bar summary when the sidebar is hidden
- Plan handoff actions that can open a saved plan document or continue into implementation
- Ralph loops for plan-driven work, with iterative child sessions, verification passes, repair runs, and pause/resume controls

## Requirements

- [VS Code](https://code.visualstudio.com/) 1.96 or newer
- [Node.js](https://nodejs.org/) 20.19+, 22.12+, or 24+
- The OpenCode CLI installed (if the CLI is not on your `PATH`, set `varro.server.command` to the executable path in VS Code Settings)

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

   You can also open Varro and run `/connect` to launch the same login flow in a VS Code terminal.

4. Open a folder or workspace in VS Code, then open `Varro` from the Activity Bar. For the best layout, move it to the `Secondary Side Bar` so you can keep the editor visible while chatting.
5. Varro connects to `http://127.0.0.1:4096` the first time chat needs OpenCode. If `varro.server.autoStart` is enabled, Varro can auto-start a local OpenCode server for you. If you prefer manual server management, run `opencode serve --port 4096` yourself and disable auto-start.
6. Start prompting. Varro automatically includes the active file and current selection by default.
7. Add more context when needed:
   - Right-click a file or folder in Explorer and choose `Varro: Add to Context`
   - Select terminal text and choose `Varro: Add to Context`
   - Drag files or folders into the chat
   - Paste an image into the input box
   - Type `@` to search workspace files or mention an agent
8. Use slash commands such as `/models`, `/mcp`, `/attach`, `/skills`, `/review`, `/ralph`, `/sessions`, `/export`, and `/settings`. In a blank session, `/init` asks OpenCode to create or improve `AGENTS.md` for the current project.
9. Approve or reject tool permissions and answer follow-up questions directly in the chat panel. If the sidebar is hidden, Varro can surface waiting or completed work in notifications and the status bar.

## Documentation

- Usage guide: [docs/usage.md](https://github.com/koltyakov/varro/blob/main/docs/usage.md)
- Development guide: [docs/development.md](https://github.com/koltyakov/varro/blob/main/docs/development.md)
- Architecture overview: [docs/architecture.md](https://github.com/koltyakov/varro/blob/main/docs/architecture.md)

## License

MIT License. See [LICENSE](https://github.com/koltyakov/varro/blob/main/LICENSE).
