# Varro: The OpenCode Workbench

[![Visual Studio Marketplace](https://badgen.net/vs-marketplace/v/koltyakov.varro?color=0078d4)](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro)
[![Open VSX Version](https://img.shields.io/open-vsx/v/koltyakov/varro?color=a66f00)](https://open-vsx.org/extension/koltyakov/varro)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](https://github.com/koltyakov/varro/blob/main/LICENSE)

**The complete OpenCode experience inside VS Code.**

Varro brings [OpenCode](https://opencode.ai) into a compact, project-aware workbench for daily agentic development. Run agents, manage parallel sessions, review plans and file changes, generate commit messages, control models and permissions, and monitor context, tokens, and provider limits without leaving the editor.

Varro builds on OpenCode instead of replacing it. Your local OpenCode configuration remains the source of truth for agents, providers, models, commands, skills, and MCP servers.

![The Varro OpenCode workbench in VS Code](https://raw.githubusercontent.com/koltyakov/varro/main/assets/demo.png)

## Why Varro

- **Built for the whole agent loop.** Prompts, streaming output, reasoning, tool activity, permissions, questions, todos, plans, and changed files stay in one readable flow.
- **Project context without busywork.** The active file and selection can follow the conversation automatically, while Explorer items, terminal output, files, folders, images, PDFs, `@` mentions, and `&` session references can be added explicitly.
- **Parallel work that stays understandable.** Workspace sessions clearly identify running, attention-needed, failed, completed, and plan-ready work. Notifications and the status bar keep background sessions visible.
- **OpenCode controls at the point of work.** Agents, models, reasoning variants, permission modes, provider connections, and per-session MCP connections are available inside the workbench.
- **Commit messages where you commit.** Generate a repository-aware message from staged changes in VS Code, without leaving Source Control or handing commit control to the model.
- **Usage you can act on.** Provider limits and reset windows appear next to model controls when available, while detailed accounting covers context fill, input, output, reasoning, cache, and sub-agent tokens.
- **Compact by design.** The complete workflow remains readable in a sidebar, with an optional session pane for larger layouts.

## Sessions

Sessions are filtered to the current workspace and grouped into `Recent`, `Archive`, and `Recycle Bin`. Pinned and active-state sessions stay surfaced, while ordinary sessions are ordered approximately by activity. Each session can show changed files, line additions and removals, token usage, duration, and current state.

OpenCode's native search finds root sessions across loaded and older history. Top-level sessions can be pinned, renamed, or moved to the recycle bin. Any session can be resumed, opened in the OpenCode TUI, shared or unshared, or have its ID copied. Sharing asks OpenCode to create a share link and copies it to the clipboard. Sub-agent sessions remain linked to their parent session. On larger layouts, the session list can stay open beside the active chat.

When the sidebar is hidden, Varro can notify you when a plan is ready, a top-level session fails, requests permission, or asks a question. The status bar also tracks top-level sessions that finish in the background.

![Workspace sessions with status, token, and change summaries](https://raw.githubusercontent.com/koltyakov/varro/main/assets/sessions.png)

## Context And Composer

- The active file and current selection are included automatically while live document context is enabled, which is the default for new sessions.
- A document chip shows the current live editor context and lets you disable or re-enable it for the session.
- Files, folders, line ranges, and terminal output can be added with `Varro: Add to Context` or `Cmd+Shift+K` / `Ctrl+Shift+K`.
- Files and folders can be dragged into the composer, and images can be pasted directly.
- Typing `@` searches workspace files and available agents.
- Typing `&` searches recent root sessions and inserts a navigable session reference.
- While a session is running, you can queue a follow-up, steer the current run, or stop and replace the prompt.
- Composer undo and redo include file, image, and PDF attachment changes.
- Unsent composer text and explicit file or folder attachments are restored after webview or window reloads.

## Usage And Limits

The context indicator reports how much of the selected model's known context window is in use. Its popup includes session totals for input, output, reasoning, cache reads, cache writes, and sub-agent tokens, plus the reported session cost when available.

Provider-limit status is shown when OpenCode metadata or a supported provider endpoint supplies quota data. Available windows include remaining capacity and reset timing. If a provider returns a usage-limit error, Varro provides actions to stop retrying or switch providers.

![Context window and session token breakdown](https://raw.githubusercontent.com/koltyakov/varro/main/assets/context.png)

## Models And MCPs

The model picker loads providers and models from OpenCode. It shows known capabilities such as tool support, reasoning variants, vision and PDF support, and context-window size. Providers and individual models can be hidden from the picker, frequently used models can be pinned, and models can have local display names without changing their OpenCode IDs or configuration.

The Models view can connect and disconnect provider credentials through OpenCode using available API-key or OAuth methods. If a provider rejects an expired or revoked credential, Varro offers targeted reauthentication from the failed response and the Models view. Terminal-based OpenCode setup remains available as a fallback.

MCP servers are also loaded from OpenCode and can be connected or disconnected per session.

![Provider and model selection in Varro](https://raw.githubusercontent.com/koltyakov/varro/main/assets/providers.png)

## Auto-Generated Commit Messages

Stage the changes you intend to commit, then use the quick wand icon in the Source Control toolbar or run `Varro: Generate Commit Message` from the Command Palette. Varro uses staged changes as the change input, follows recent repository commit style when possible, and fills the selected Git repository's commit input for review.

Generation never includes unstaged changes, stages files, or commits automatically. Varro preserves an existing draft unless you approve replacement, detects staging or input changes while generation is running, and keeps its temporary helper session out of chat history.

## Additional Workflows

- Answer OpenCode questions and permission requests in the chat
- Open changed files or hand the session off to VS Code Source Control
- Generate a commit message from staged changes with the quick Source Control toolbar action or the Command Palette
- Open a completed plan as a Markdown document or continue it in an implementation session
- Run plan-driven Ralph loops with iteration, verification, repair, pause, and resume controls; Ralph runs use `Full access`
- Use built-in and custom slash commands such as `/review`, `/compact`, `/export`, `/stats`, `/skills`, `/diagnostics`, `/fork`, and `/ralph`
- Navigate conversation turns from the transcript rail and open rendered Mermaid diagrams in an expanded preview
- Reconnect to resumable sessions after a VS Code reload

## Quick Start

1. [Install Varro](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro) from the VS Code Marketplace.
2. Install the OpenCode CLI with `npm install -g opencode-ai`.
3. Run `opencode auth login`, or use `/connect` in Varro, if no provider is configured yet.
4. Open a folder in VS Code and select `Varro` from the Activity Bar.
5. Start a session. Varro starts or connects to OpenCode when the chat first needs it.

VS Code and VSCodium are the target containers for Varro. VS Code forks have limited support; see [VS Code fork compatibility](https://github.com/koltyakov/varro/blob/main/docs/vscode-forks.md) for details.

Varro connects to `http://127.0.0.1:4096` by default. `varro.server.port` accepts integers from 1 through 65535. To manage the server manually, disable `varro.server.autoStart` and run `opencode serve --port 4096`.

## Requirements

- [VS Code](https://code.visualstudio.com/) or [VSCodium](https://vscodium.com/) 1.120 or newer
- [Node.js](https://nodejs.org/) 22.22.2+ on Node 22, or Node 24.15.0+
- The [OpenCode CLI](https://opencode.ai/docs) 1.16.0 or newer on your `PATH`, or its executable path set in `varro.server.command`.
- A trusted, non-virtual workspace; remote workspaces run Varro and OpenCode on the remote extension host

## Documentation

- [Usage guide](https://github.com/koltyakov/varro/blob/main/docs/usage.md)
- [VS Code forks compatibility](https://github.com/koltyakov/varro/blob/main/docs/vscode-forks.md)
- [Development guide](https://github.com/koltyakov/varro/blob/main/docs/development.md)
- [Architecture overview](https://github.com/koltyakov/varro/blob/main/docs/architecture.md)
- [Issues and feature requests](https://github.com/koltyakov/varro/issues)

## License

Varro is available under the [MIT License](https://github.com/koltyakov/varro/blob/main/LICENSE).
