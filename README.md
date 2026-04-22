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

4. Open `Varro` from the Activity Bar. For the best layout, move it to the `Secondary Side Bar` so you can keep the editor visible while chatting.
5. Start prompting. Varro automatically includes the active file and current selection by default.
6. Add more context when needed:
   - Right-click a file or folder in Explorer and choose `Varro: Add to Context`
   - Select terminal text and run `Varro: Add Terminal Selection to Context`
   - Drag files or folders into the chat
   - Paste an image into the input box
7. Approve or reject tool permissions and answer follow-up questions directly in the chat panel.

## Documentation

- Usage guide: [docs/usage.md](https://github.com/koltyakov/varro/blob/main/docs/usage.md)
- Development guide: [docs/development.md](https://github.com/koltyakov/varro/blob/main/docs/development.md)

## License

MIT License. See [LICENSE](https://github.com/koltyakov/varro/blob/main/LICENSE).
