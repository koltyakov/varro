# Varro: OpenCode for VS Code

[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version-short/koltyakov.varro.svg)](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro)
[![Installs](https://vsmarketplacebadges.dev/installs-short/koltyakov.varro.svg)](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/koltyakov/varro/blob/main/LICENSE)

**The best OpenCode UI for VS Code.**

Varro turns [OpenCode](https://opencode.ai) into a polished, focused workspace for agentic development. Run several sessions at once, build prompts from real editor context, and keep provider limits and token consumption visible without living in a terminal.

Varro is deliberately simple. It does not recreate an IDE inside your IDE or bury the core workflow under feature clutter. Chat, context, sessions, approvals, and usage are designed as one coherent experience.

[**Install Varro from the VS Code Marketplace**](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro)

![Varro running OpenCode in VS Code](https://raw.githubusercontent.com/koltyakov/varro/main/assets/demo.png)

## Why Varro

- **A chat experience built for coding.** Readable streaming output, compact tool activity, diff summaries, sticky prompt context, message queues, steering, and approvals all stay in one flow.
- **Context without ceremony.** The active file and selection can follow you automatically. Add Explorer files, editor or terminal selections, dragged folders, pasted images, and `@` mentions directly from the composer.
- **Multi-session development without chaos.** Run work in parallel and see which sessions are running, waiting for you, failed, completed, or ready to hand off from planning.
- **Provider limits before they surprise you.** When a provider exposes quota data, available windows, remaining capacity, and reset timing sit next to the model controls. If a limit is reached, Varro lets you stop retries or switch providers.
- **Token usage without guesswork.** Inspect context-window fill and a session breakdown for input, output, reasoning, and cache tokens, including sub-agent usage.
- **Power without clutter.** Agents, models, reasoning variants, skills, commands, and MCPs come from your OpenCode setup. Varro makes them easier to use instead of adding another configuration layer.

## Parallel Work That Stays Clear

Start another session while an agent is working and keep coding. Varro scopes sessions to the current workspace and gives every run a useful status: `Running`, `Needs attention`, `Failed`, `Plan ready`, or `Completed`.

Search, pin, rename, resume, and recycle sessions without losing their history. Sub-agent sessions stay connected to their parent. When Varro is hidden, VS Code notifications and a status bar summary tell you when work finishes or needs input.

![Workspace sessions with status, token, and change summaries](https://raw.githubusercontent.com/koltyakov/varro/main/assets/sessions.png)

## Usage You Can Actually See

Agentic development should not hide the meter. When a provider exposes quota information, Varro shows each available limit window, the capacity left, and when it resets. Warnings remain close to the composer where model decisions happen.

The context indicator shows how full the selected model's window is. Open it for exact session totals across input, output, reasoning, cache reads, cache writes, and sub-agents. You can compact before the context window becomes a problem instead of discovering it after a failed run.

![Context window and session token breakdown](https://raw.githubusercontent.com/koltyakov/varro/main/assets/context.png)

## Context-First Chat

Varro treats context as part of the prompt, not as a separate setup step.

- Follow the active file and current selection automatically, with a visible chip to turn live context on or off.
- Add files, folders, line ranges, or terminal output with `Varro: Add to Context` or `Cmd+Shift+K` / `Ctrl+Shift+K`.
- Drag files and folders into chat, paste images, or type `@` to find workspace files and agents.
- Queue a follow-up while the agent is running, steer the current run, or stop and replace the prompt.
- Undo and redo composer edits together with their attachments, not just the text.

## Your OpenCode Setup, Made Usable

Varro uses the agents, providers, models, commands, skills, and MCP servers from your local OpenCode configuration. The model picker keeps a large setup navigable and exposes useful capabilities such as tools, reasoning variants, vision support, and known context-window sizes.

![Provider and model selection in Varro](https://raw.githubusercontent.com/koltyakov/varro/main/assets/providers.png)

## More When You Need It

- Inline permission prompts and follow-up questions
- Agent todos, changed-file summaries, and source-control handoff
- Plan-ready sessions with one-click document or implementation handoff
- Ralph loops for plan-driven implementation, verification, and repair
- Per-session MCP selection and permission modes
- Built-in and custom slash commands, including `/review`, `/compact`, `/export`, `/skills`, and `/ralph`
- Automatic reconnection to resumable work after a VS Code reload

## Quick Start

1. [Install Varro](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro) from the VS Code Marketplace.
2. Install the OpenCode CLI with `npm install -g opencode-ai`.
3. Run `opencode auth login`, or open Varro and use `/connect`, if you have not configured a provider yet.
4. Open a folder in VS Code and select `Varro` from the Activity Bar. Varro starts or connects to OpenCode when the chat first needs it.
5. Start prompting. The active file and current selection are included automatically by default.

For the best layout, move Varro to the `Secondary Side Bar` so the editor and chat remain visible together.

Varro connects to `http://127.0.0.1:4096` by default. To manage the server yourself, disable `varro.server.autoStart` and run `opencode serve --port 4096`.

## Requirements

- [VS Code](https://code.visualstudio.com/) 1.120 or newer
- [Node.js](https://nodejs.org/) 22.12+ or 24+
- The [OpenCode CLI](https://opencode.ai/docs) on your `PATH`, or its executable path set in `varro.server.command`

## Documentation

- [Usage guide](https://github.com/koltyakov/varro/blob/main/docs/usage.md)
- [Development guide](https://github.com/koltyakov/varro/blob/main/docs/development.md)
- [Architecture overview](https://github.com/koltyakov/varro/blob/main/docs/architecture.md)
- [Issues and feature requests](https://github.com/koltyakov/varro/issues)

## License

Varro is free and open source under the [MIT License](https://github.com/koltyakov/varro/blob/main/LICENSE).
