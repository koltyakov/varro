# Varro: The OpenCode Workbench

[![Visual Studio Marketplace](https://badgen.net/vs-marketplace/v/koltyakov.varro?color=0078d4)](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro)
[![Open VSX Version](https://img.shields.io/open-vsx/v/koltyakov/varro?color=a66f00)](https://open-vsx.org/extension/koltyakov/varro)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](https://github.com/koltyakov/varro/blob/main/LICENSE)

**The complete OpenCode experience inside VS Code.**

Varro brings [OpenCode](https://opencode.ai) into a compact, project-aware workbench for daily agentic development. Run agents, manage parallel sidebar and editor sessions, review plans and inline file changes, generate commit messages, control models and permissions, and monitor context, tokens, and provider limits without leaving the editor.

Varro builds on OpenCode instead of replacing it. Your local OpenCode configuration remains the source of truth for agents, providers, models, commands, skills, and MCP servers.

![The Varro OpenCode workbench in VS Code](https://raw.githubusercontent.com/koltyakov/varro/main/assets/demo.png)

## Why Varro

- **Built for the whole agent loop.** Prompts, streaming output, reasoning, tool activity, permissions, questions, todos, plans, inline edits, and changed files stay in one readable flow.
- **Structured chat output.** Active work, failures, approvals, edits, and final responses are shown directly. Routine activity and thinking collapse into compact summaries that can be expanded.
- **A coding-first chat composer.** Work with live editor context, inline file, agent, and session chips, drag-and-drop attachments, pasted images and PDFs, terminal selections, slash-command completion, prompt history, undo and redo, and restored drafts.
- **Image analysis for text-only models.** Configure an `@vision` sub-agent to inspect attached images when the selected model supports tools but not image input.
- **Read-only codebase Q&A.** Configure an `ask` primary agent to investigate code and documentation without editing files, running commands, or delegating work.
- **Parallel work that stays clear.** Session state, notifications, and status-bar updates keep background work visible and actionable.
- **Control work in progress.** Queue follow-ups, steer an active run, or stop and replace the current prompt without waiting for the session to finish.
- **Permission control for each session.** Keep approval requests in the chat and choose between manual control, edit approval, automatic review, or unrestricted access.
- **OpenCode controls at the point of work.** Agents, models, reasoning variants, provider connections, and per-session MCP connections are available inside the workbench.
- **Commit messages where you commit.** Generate a repository-aware message from staged changes in VS Code, without leaving Source Control or handing commit control to the model.
- **Token usage and limits.** Context fill and session token usage remain visible during work, with detailed accounting, provider limits, and cross-project reports.
- **Simple to use, adjustable where it matters.** The polished UI keeps everyday actions easy to find and needs little setup, while optional settings tune chat typography, thinking visibility, inline diffs, the changed-files panel, compaction, and default permissions.
- **Native VS Code theming.** Varro follows light, dark, high-contrast light, and high-contrast dark themes, including theme changes while the workbench is open.
- **Fits your layout.** Keep Varro in the side panel, maximize the sidebar through VS Code when a conversation needs more room, or open chats in editor tabs for side-by-side work. Larger layouts can also keep the session pane visible beside the active chat.

## OpenCode Feature Coverage

`In workbench` means the workflow has dedicated Varro UI. `Integrated` means OpenCode remains responsible for the underlying configuration or operation while Varro exposes it in the workbench. `Handoff` opens the appropriate OpenCode or VS Code surface.

| OpenCode capability | Coverage | Varro support |
| --- | --- | --- |
| Sessions and history | In workbench | Create, search, resume, rename, pin, fork, share, export, recycle, and navigate root and sub-agent sessions. |
| Streaming chat and tool calls | In workbench | Keep active and important output inline while grouping routine completed activity into expandable summaries. |
| Queue and steering | In workbench | Queue follow-ups with attachments, manage their order and state, steer the active run, or stop and send a replacement. |
| Agents and sub-agents | Integrated | Select primary agents, mention agents, follow child sessions, and display delegated work. Agent definitions stay in OpenCode configuration. |
| Providers, models, and reasoning | In workbench | Connect supported provider credentials, choose models and variants, pin or hide models, and assign helper models. |
| Files and multimodal context | In workbench | Attach files, folders, selections, terminal output, diagnostics, images, PDFs, and session references, subject to model capabilities. |
| Permissions and questions | In workbench | Answer inline requests and questions, choose a permission mode per session, and preserve child-session approvals in the parent flow. |
| Commands and skills | Integrated | Run built-in and custom slash commands, browse OpenCode skills, and use session actions such as compact, undo, redo, and export. |
| MCP servers | In workbench | View OpenCode MCP servers and connect or disconnect them per session. |
| Plans and todos | In workbench | Track todos, surface completed plans, open plan documents, continue into implementation, or run Ralph loops. |
| Compaction and recovery | Integrated | Configure automatic compaction, compact manually, reconnect resumable sessions, and recover from transient transport failures. |
| LSP, formatters, and custom tools | Integrated | Show active language-server status and render resulting tool activity; definitions and execution remain with OpenCode. |
| OpenCode configuration and TUI | Handoff | Keep local OpenCode config as the source of truth, open instruction files for editing, or continue any session in the OpenCode TUI. |

## Sessions

Sessions are filtered to the current workspace and grouped into `Recent`, `Archive`, and `Recycle Bin`. Header badges filter or jump to `Running`, `Needs attention`, `Failed`, `Plan ready`, and `Completed` sessions. Pinned and active-state sessions stay surfaced, while ordinary sessions are ordered approximately by activity. Session rows can show queued-message counts, changed files, line additions and removals, token usage, duration, and current state.

OpenCode's native search finds root sessions across loaded and older history. Top-level sessions can be pinned, renamed, or moved to the recycle bin. Any session can be opened in the sidebar, an editor tab, or the OpenCode TUI; shared or unshared; or have its ID copied. New chats can also start directly in editor tabs, with a terminal editor available from the chat-tab toolbar. Sharing asks OpenCode to create a share link and copies it to the clipboard. Sub-agent sessions remain linked to their parent session. On larger layouts, the session list can stay open beside the active chat.

When the sidebar is hidden, Varro can notify you when a plan is ready, a top-level session fails, requests permission, or asks a question. The status bar tracks waiting and completed top-level sessions; selecting it opens work that needs attention first, then completed background work.

![Workspace sessions with status, token, and change summaries](https://raw.githubusercontent.com/koltyakov/varro/main/assets/sessions.png)

## Context And Composer

- The active file and current selection are included automatically while live document context is enabled, which is the default for new sessions.
- A document chip shows the current live editor context and lets you disable or re-enable it for the session.
- Files, folders, line ranges, and terminal output can be added with `Varro: Add to Context` or `Cmd+Shift+K` / `Ctrl+Shift+K`.
- Files and folders can be dragged into the composer, and images can be pasted directly.
- Typing `@` searches workspace files and available agents.
- Typing `&` searches recent root sessions and inserts a navigable session reference.
- While a session is running, you can queue a follow-up, steer the current run, or stop and replace the prompt. Queued messages can be reordered, paused or resumed, edited, retried, removed, or sent immediately as steering.
- The composer shows active language servers and links to their output when VS Code exposes it.
- Composer undo and redo include file, image, and PDF attachment changes.
- Unsent composer text and explicit file or folder attachments are restored after webview or window reloads.

## Chat Output

Varro structures agent output around what needs attention. Running commands stream their output, failures remain visible, permission requests and questions stay actionable, file edits get dedicated summaries or optional inline diffs, and the final response remains separate from tool activity.

Completed routine work and thinking are compacted under summaries such as `Explored` and `Worked` instead of filling the transcript. Expand those summaries or individual tool cards when you need the underlying detail, open long tool input or output in an editor tab, toggle thinking visibility, or enable complete inline file previews.

## Permissions And Questions

Approval requests and follow-up questions stay inside the conversation. Permission prompts provide `Reject`, `Once`, and `Always` actions, while the composer lets each session use one of four modes:

- `Default` follows permission rules from OpenCode configuration and the selected agent, showing requests that require manual approval.
- `Auto-accept edits` approves file edits, known read-only actions, and sub-agent launches while continuing to ask before other actions.
- `Auto` judges eligible requests with local rules and, when needed, a configured model. Anything it cannot decide safely falls back to an actionable prompt.
- `Full access` grants unrestricted access for sessions that can operate without confirmation.

Child sessions inherit the nearest selected permission mode in their session tree. When a child needs manual approval, Varro surfaces its request in the parent conversation without losing child-session ownership.

## Usage And Limits

Token usage is part of the working layout, not only a report. The composer shows context-window fill beside the model controls, session rows show token usage at a glance, and the context popup breaks the active session down into input, output, reasoning, cache reads, cache writes, and sub-agent tokens. It also shows reported session cost when OpenCode supplies it.

Run `/stats` or `Varro: Usage Stats` to open a Markdown report built from retained OpenCode history across all projects. It compares today, the last 7 days, and the last 30 days, with prompt counts and input, output, reasoning, cache, and total tokens grouped by provider and model. `/stats all` adds retained all-time usage.

![Context window and session token breakdown](https://raw.githubusercontent.com/koltyakov/varro/main/assets/context.png)

Provider-limit status is shown when OpenCode metadata or a supported provider endpoint supplies quota data. Available windows include remaining capacity and reset timing. If a provider returns a usage-limit error, Varro provides actions to stop retrying or switch providers.

![Provider quota limits and reset windows](https://raw.githubusercontent.com/koltyakov/varro/main/assets/limits.png)

## Models And MCPs

The model picker loads providers and models from OpenCode. It shows known capabilities such as tool support, reasoning variants, vision and PDF support, and context-window size. Providers and individual models can be hidden from the picker, frequently used models can be pinned, and models can have local display names without changing their OpenCode IDs or configuration.

A tool-capable text-only model can delegate pasted-image analysis to a configured OpenCode sub-agent named `vision`. Give that agent an image-capable model, then include an exact `@vision` mention in the prompt. Varro passes the images to the sub-agent without sending unsupported image input to the parent model. See [Add Vision To A Text-Only Model](https://github.com/koltyakov/varro/blob/main/docs/usage.md#add-vision-to-a-text-only-model) for configuration.

For questions and investigation, configure a primary agent named `ask` with a catch-all deny rule followed by explicit read and search allowances. Varro adds it to the agent picker, where it can use the global model or its own model and can be selected as the default for new sessions. See [Configure Primary Agents](https://github.com/koltyakov/varro/blob/main/docs/usage.md#configure-primary-agents) for a read-only example.

The Models view can connect and disconnect provider credentials through OpenCode using available API-key or OAuth methods. If a provider rejects an expired or revoked credential, Varro offers targeted reauthentication from the failed response and the Models view. Terminal-based OpenCode setup remains available as a fallback.

MCP servers are also loaded from OpenCode and can be connected or disconnected per session.

![Provider and model selection in Varro](https://raw.githubusercontent.com/koltyakov/varro/main/assets/providers.png)

## Auto-Generated Commit Messages

Use the quick wand icon in the Source Control toolbar or run `Varro: Generate Commit Message` from the Command Palette. Varro uses staged changes when present; if nothing is staged, it falls back to the unstaged working tree. It follows recent repository commit style when possible and fills the selected Git repository's commit input for review.

Generation never mixes staged and unstaged scopes, stages files, or commits automatically. Varro preserves an existing draft unless you approve replacement, detects change-scope or input changes while generation is running, and keeps its temporary helper session out of chat history.

## Additional Workflows

- Answer OpenCode questions and permission requests in the chat
- Open changed files or hand the session off to VS Code Source Control
- Generate a commit message from staged changes, or unstaged changes when the index is empty, with the quick Source Control toolbar action or the Command Palette
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

Varro connects to `http://127.0.0.1:4096` by default. `varro.server.port` accepts integers from 1 through 65535. For advanced manual server management, disable the deprecated, debug-only `varro.server.autoStart` setting and run `opencode serve --port 4096`.

The status bar reports the active OpenCode version and compatible updates. On macOS and Linux, `varro.server.autoUpdate` installs updates only through the OpenCode version tested with the current Varro release; Windows uses an upgrade prompt instead.

Varro watches OpenCode's global configuration and refreshes it when OpenCode is idle. External project-configuration edits may require `Varro: Restart Server`. The command checks for active work and only restarts a server managed by Varro. Restart a manually launched server from its terminal.

## Requirements

- [VS Code](https://code.visualstudio.com/) or [VSCodium](https://vscodium.com/) 1.120 or newer
- [Node.js](https://nodejs.org/) 22.22.2+ on Node 22, or Node 24.15.0+
- The [OpenCode CLI](https://opencode.ai/docs) 1.16.0 or newer on your `PATH`, or its executable path set in `varro.server.command`.
- A trusted, non-virtual workspace; remote workspaces run Varro and OpenCode on the remote extension host

## Documentation

- [Usage guide](https://github.com/koltyakov/varro/blob/main/docs/usage.md)
- [Configure primary agents](https://github.com/koltyakov/varro/blob/main/docs/usage.md#configure-primary-agents)
- [VS Code forks compatibility](https://github.com/koltyakov/varro/blob/main/docs/vscode-forks.md)
- [Development guide](https://github.com/koltyakov/varro/blob/main/docs/development.md)
- [Architecture overview](https://github.com/koltyakov/varro/blob/main/docs/architecture.md)
- [Issues and feature requests](https://github.com/koltyakov/varro/issues)

## License

Varro is available under the [MIT License](https://github.com/koltyakov/varro/blob/main/LICENSE).
