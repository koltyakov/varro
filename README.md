# Varro for VS Code

Varro is a native VS Code sidebar for [OpenCode](https://opencode.ai). It keeps your current workspace, editor context, approvals, and session history inside the IDE so you can use OpenCode without bouncing to another terminal or app.

![Varro in VS Code](https://raw.githubusercontent.com/koltyakov/varro/main/assets/demo.png)

## Highlights

- Native OpenCode chat in a dedicated VS Code sidebar view
- Live context from the active file, selection, diagnostics, terminal selection, Explorer, drag and drop, `@` mentions, and pasted images
- Workspace-scoped sessions with running, attention-needed, failed, completed, and plan-ready states
- Inline permission prompts, follow-up questions, todo tracking, diff summaries, and usage-limit notices
- Agent, model, reasoning variant, and MCP selection from your local OpenCode setup
- Background notifications and a status bar summary when the sidebar is hidden
- Plan handoff actions that can open a saved plan document or continue into implementation

## Requirements

- [VS Code](https://code.visualstudio.com/) 1.91 or newer
- [Node.js](https://nodejs.org/) 20 or newer
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

4. Open `Varro` from the Activity Bar. For the best layout, move it to the `Secondary Side Bar` so you can keep the editor visible while chatting.
5. Varro connects to `http://127.0.0.1:4096` when the chat first needs OpenCode and can auto-start a local OpenCode server for you.
6. Start prompting. Varro automatically includes the active file and current selection by default.
7. Add more context when needed:
   - Right-click a file or folder in Explorer and choose `Varro: Add to Context`
   - Select terminal text and run `Varro: Add Terminal Selection to Context`
   - Drag files or folders into the chat
   - Paste an image into the input box
   - Type `@` to search workspace files or mention an agent
8. Use `/models`, `/mcps`, or `/settings` from the composer when you want to adjust the active session.
9. Approve or reject tool permissions and answer follow-up questions directly in the chat panel. If the sidebar is hidden, Varro can surface waiting or completed work in notifications and the status bar.

## Documentation

- Usage guide: [docs/usage.md](https://github.com/koltyakov/varro/blob/main/docs/usage.md)
- Development guide: [docs/development.md](https://github.com/koltyakov/varro/blob/main/docs/development.md)
- Architecture overview: [docs/architecture.md](https://github.com/koltyakov/varro/blob/main/docs/architecture.md)

## License

MIT License. See [LICENSE](https://github.com/koltyakov/varro/blob/main/LICENSE).
