# Usage Guide

This guide covers the current Varro workflow inside VS Code.

## Open Varro

- Click the `Varro` icon in the Activity Bar.
- In VS Code and VSCodium, Varro defaults to the `Secondary Side Bar` so you can keep the editor visible while chatting.
- In Cursor, Windsurf, and Devin, Varro attempts a one-time move to the `Primary Side Bar` instead.

VS Code forks have limited support. See [VS Code Fork Compatibility](vscode-forks.md) for details.

## First Run And Connection

Install the OpenCode CLI:

```sh
npm install -g opencode-ai
```

If OpenCode does not have any providers configured yet, log in:

```sh
opencode auth login
```

From inside Varro, `/connect` opens a VS Code terminal and runs `opencode auth login` for you.

Varro connects to `http://127.0.0.1:4096` by default. It does not start OpenCode at extension activation time. Instead, it starts or attaches to the server the first time the chat view needs it.

For advanced manual server management, disable `varro.server.autoStart` and start OpenCode yourself. VS Code marks this switch as deprecated and debug-only, but it remains available for this workflow:

```sh
opencode serve --port 4096
```

If the CLI is installed somewhere that is not on `PATH`, set `varro.server.command` to the executable path.

## Workspace And Remote Environments

Varro requires a trusted, non-virtual workspace because it starts a process with access to workspace files. VS Code does not enable the extension in Restricted Mode or virtual workspaces such as repositories opened without a local or remote filesystem checkout.

Varro is a workspace extension. In Remote SSH, Dev Containers, and similar setups where VS Code runs workspace extensions remotely, Varro and the OpenCode server run on that remote extension host. In those environments:

- `127.0.0.1`, port `4096`, and a manually started OpenCode server refer to the remote host or container, not your desktop.
- The OpenCode CLI, `varro.server.command`, provider credentials, and OpenCode configuration must be available on that host.
- Files dragged from the desktop can use Varro's bounded content-upload fallback when their local paths are unavailable to the remote extension host.

## What Varro Sends As Context

Varro can include more than the text in the composer.

- Workspace path, sent as `[Working directory: ...]`
- Active file
- Current selection
- Unsaved selected text, or a bounded window of a dirty editor buffer when there is no selection
- Selected terminal text
- Diagnostics from the active file when you explicitly attach current Problems with `/diagnostics`
- Explicitly attached files or folders
- Explicit line ranges attached from the editor selection command
- Pasted image attachments when the selected model supports vision

The current document appears as a chip above the composer. You can click that chip to disable or re-enable live current-document context for the active session.

In a multi-root workspace, use the working-directory picker in the composer toolbar to choose which root owns sessions and OpenCode requests. Varro remembers that root for the workspace instead of switching it when editor focus changes.

When the active file is also attached explicitly, Varro avoids duplicating overlapping line ranges.

## Add Context Manually

Use any of these flows to add more context.

- Right-click a file or folder in Explorer and choose `Varro: Add to Context`, or run `Varro: Add to Context` from the Command Palette to add the active file.
- With an editor selection, use the editor context menu entry that also appears as `Varro: Add to Context`, or press `Cmd+Shift+K` / `Ctrl+Shift+K`.
- Select terminal text and choose `Varro: Add to Context` from the terminal context menu, or press `Cmd+Shift+K` / `Ctrl+Shift+K`.
- Drag files or folders into the composer.
- Use the composer attachment flow from `/attach`.
- Paste an image into the composer.
- Type `@path/to/file` to search workspace files.
- Type `@agent-name` to mention an available agent.

Varro keeps at most five pasted images, with a maximum size of 5 MiB per image. In environments where dropped items do not expose local paths, content-only drops are limited to 20 files, 10 MiB per file, and 50 MiB in total.

## Composer Behavior

- `Enter` sends the message.
- `Shift+Enter` inserts a newline.
- While a session is running, plain `Enter` queues a follow-up message, including any attached files, images, or terminal selection.
- While a session is running, `Ctrl+Enter` or `Cmd+Enter` sends a steering message with `noReply` enabled.
- While a session is running, the send menu also exposes `Add to Queue`, `Steer with Message`, and `Stop and Send`.
- `ArrowUp` and `ArrowDown` can step through previous user prompts when the composer is empty.
- `Cmd+Z` / `Ctrl+Z` undoes the last composer edit, including pasted text and attachment changes (context files and pasted images). `Cmd+Shift+Z`, `Ctrl+Shift+Z`, or `Ctrl+Y` redoes it.
- `Escape` closes any open composer popup or cancels message editing; otherwise, it returns to the session list without stopping a running session.
- `Tab` accepts the highlighted slash-command or mention completion.
- Slash commands are available directly in the composer.

Unsent composer text is restored after webview or window reloads. This draft persistence covers text only; file, image, terminal, and diagnostic attachments are persisted when they are queued, not as part of an ordinary unsent draft.

### Queued Messages

Queued messages belong to the session where they were created and dispatch from top to bottom when that session is active, connected, and idle. A pending permission, question, edit, failed dispatch, or steering request prevents automatic dispatch until it is resolved.

- Drag the handle, or focus it and press `ArrowUp` or `ArrowDown`, to reorder messages within the same session.
- Pause or resume an individual message. `Option`/`Alt`-click applies the same action to every queued message for that session.
- Send a queued message immediately as a steering message, retry a failed send, edit it when the composer is clear, or remove it.
- Text, selected agent, files, diagnostics, terminal selections, and pasted images are persisted in VS Code workspace state across window and webview reloads. Image data stays in extension-host persistence instead of synchronous webview storage.
- Successfully dispatched and explicitly removed messages leave the queue. Failed messages remain available for retry.

Current built-in slash commands include:

- `/new` or `/clear` starts a new chat session
- `/skills` browses skill commands loaded from OpenCode
- `/sessions` or `/resume` opens the session list
- `/models` opens the model picker
- `/mcp` or `/mcps` opens the MCP picker for the current session
- `/connect` opens provider login in a VS Code terminal
- `/attach` or `/files` picks files or folders to attach
- `/diagnostics` attaches active-file Problems to the next message
- `/settings` opens VS Code Settings filtered to Varro
- `/export` opens a JSON export of the current session in the editor
- `/stats` opens a Markdown usage report for the last 30 days across all OpenCode projects; `/stats all` also includes retained all-time usage
- `/thinking` or `/reasoning` toggles thinking block visibility
- `/compact` or `/summarize` compacts conversation context
- `/fork` forks the current session
- `/init` analyzes the workspace and creates or improves `AGENTS.md`
- `/review` asks the agent to review current workspace changes
- `/ralph` starts a Ralph loop from a plan or spec document
- `/abort` or `/stop` stops the current run

Custom OpenCode commands loaded from your local config also appear in the same completion list. Skill-sourced commands are browsed through `/skills` instead of being mixed into the main slash-command list.

`/stats` scans the last 30 days of retained OpenCode history across projects and opens an untitled Markdown report. Use `/stats all` when you need the slower all-time scan. Deleted OpenCode history cannot be included.

Some commands only appear when they apply. For example, `/init` only appears in blank sessions and `/abort` only appears while a session is active.

`/undo` or `/revert` undoes the last assistant response, and `/redo` reapplies it. These session-level commands can be submitted directly when applicable but are intentionally hidden from slash-command completion. They are separate from composer undo and redo.

Use `Varro: Open Global AGENTS.md` to edit OpenCode's global instructions. `Varro: Initialize Project AGENTS.md` creates the project file when needed, opens it, and starts a new chat with `/init` ready to send using the current model.

## Sessions

Sessions are filtered to the current workspace directory. The default list is split into `Recent`, `Archive`, and `Recycle Bin`. `Archive` is a UI grouping for older ordinary sessions; opening it does not alter those sessions in OpenCode. Pinned and active-state sessions remain surfaced, while other sessions are ordered approximately by activity age.

- Start a fresh session with `Varro: New Session` or the new chat button. Crafted composer text is kept for the new session, while file, image, terminal, and message-edit context is cleared.
- Open the session list from the back button in the header.
- Search uses OpenCode's native root-session search across loaded and older history and returns up to 30 results. Matching fields depend on the installed OpenCode version. Run `Varro: Search Sessions` to open and focus search directly.
- Filter or jump to `Running`, `Needs attention`, `Failed`, `Plan ready`, and `Completed` sessions from the header badges.
- Open sub-agent sessions from the parent session row when they exist.
- Top-level sessions can be renamed, pinned, or moved to the recycle bin. Any session can copy its ID, open in the OpenCode TUI, and be shared or unshared. Sharing asks OpenCode to create a share link and copies it to the clipboard.
- Deleted session roots move into a recycle bin section where you can restore them or delete them permanently for 24 hours before they expire.
- Stop the active run with `Varro: Abort Session`.
- Use `/export` to open the current session as JSON in the editor.
- Changed-file rows open the selected session's before/after snapshot in VS Code's native diff editor when OpenCode provides both sides, with the working-tree Git diff as a fallback.

Opening a session fetches the newest 200 messages. Scrolling to the top automatically prepends the next 200-message page while preserving the visible position. If an earlier page fails to load, the history boundary changes into a `Retry` action.

On large layouts, Varro can keep a persistent session pane beside the chat. Use `varro.chat.desktopSessionPaneSide` to choose whether that pane appears on the left or right.

If the sidebar is hidden, Varro can show VS Code notifications when a plan is ready, a top-level session fails, or the agent is blocked on a permission or question. It also exposes a status bar item that summarizes waiting or completed top-level sessions, including ordinary completed sessions that do not produce a notification. Clicking that item opens pending-attention sessions first, otherwise it focuses Varro.

If VS Code reloads while a session was running, Varro reconnects to those sessions and can continue interrupted work automatically when the session is still resumable.

## Plans, Reviews, And Ralph

- `/review` sends a review prompt for the current workspace changes.
- `/ralph` opens a form where you pick a plan or spec document, set an iteration cap (default `10`), optionally choose a model and reasoning variant, and can override the loop prompt template.
- Ralph manager, iteration, and repair sessions run in `Full access`, independently of the permission mode selected in the composer. Review the plan and prompt before starting the loop.
- A Ralph run creates a manager session with a dedicated dashboard plus one child session per iteration.
- After each iteration settles, the Ralph manager sends a separate verification turn and expects lines like `<name>: PASS`, `<name>: FAIL - <cause>`, or `<name>: SKIPPED - <reason>`.
- If verification fails, Ralph can spawn up to two repair sub-agents for that iteration before the loop moves on.
- Ralph can pause, resume, or stop from the dashboard. It stops early when the plan starts with `DONE` and the latest completed iteration has no failed verification; otherwise it runs to the iteration cap. If the cap is reached with unchecked plan items or failed verification, the run is marked `incomplete` and can be continued with a higher limit. Manual stops and iteration errors terminate the run separately.
- Sessions that finished with the `plan` agent surface as `Plan ready` in the session list.
- The latest plan response can be opened as a saved markdown plan document.
- The latest plan response can also be handed off to the build flow so Varro continues with implementation instead of revising the plan.

## Models, Agents, Reasoning, And MCPs

Varro loads agents, models, and MCP tools from your local OpenCode configuration.

- Pick the agent from the composer toolbar.
- Pick the provider/model from the model picker.
- Choose a reasoning variant when the selected model exposes variants.
- Open the MCP picker to connect or disconnect session MCPs.
- Open the model picker footer to hide or show providers and individual models.
- In the model settings view, right-click a model to assign it to project `small_model` or to an available sub-agent. Varro updates the project OpenCode configuration after checking for unsaved or concurrent changes.

The model settings view also shows whether a model exposes tools, variants, vision support, and a known context-window size.

The composer can show two pieces of model metadata:

- Provider limit status, when Varro can read quota information from OpenCode metadata or a supported provider endpoint.
- Context usage, based on token totals from assistant messages and the selected model's context window.

If a provider or model hits a usage limit, Varro shows a usage-limit banner with actions to stop retrying or switch providers.

### Provider-Limit Polling And Credentials

Provider-limit polling is enabled. Varro polls every `120` seconds and every `30` seconds while the active session is working. Results are cached briefly in the extension host.

Adapter coverage currently includes Antigravity, Anthropic, OpenAI/Codex, GitHub Copilot, Gemini, OpenRouter, Z.AI, MiniMax, and Kimi, plus metadata-header probes for compatible OpenAI and GitHub Copilot configurations. Availability depends on the provider and credential type; unsupported providers simply do not show quota details.

To retrieve quota metadata, the extension host can:

- Read the OpenCode authentication store at `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json` and provider/model metadata.
- Read provider-specific local credentials when available: `~/.claude/.credentials.json`, `${CODEX_HOME:-~/.codex}/auth.json` or `CODEX_TOKEN`, `${GEMINI_HOME:-~/.gemini}/oauth_creds.json` or `GEMINI_ACCESS_TOKEN`, and GitHub CLI `hosts.yml` under its configured or default config directory.
- Contact provider quota or metadata endpoints with those credentials, or inspect supported local metadata and proxy endpoints such as Antigravity and Anthropic status data.
- Refresh an expired Anthropic OAuth token sourced from `~/.claude/.credentials.json` after an authentication failure and atomically write the refreshed credentials back to that file. OpenCode-sourced Anthropic credentials are not rewritten.

When no valid `small_model` is configured and an OpenAI GPT Luna Fast model is available, commit-message generation can also make a one-off OpenAI quota lookup to determine whether that model is eligible.

### Recommended OpenCode Configuration

Varro loads agents, providers, models, and MCP tools from your local OpenCode configuration. The most reliable setup is to treat model selection as an agent-level concern in OpenCode.

Recommended approach:

- Use one strong default primary agent for normal build work.
- Create focused subagents for distinct task types such as exploration, planning, review, or documentation.
- Pin each subagent to the provider/model that best fits that task.
- Let the main agent decide which subagent to invoke for a task instead of manually switching models for every step.
- Keep the visible model list in Varro small and practical so the picker stays useful.

This allows a flow where the main agent orchestrates work across different models:

- the primary agent handles the main conversation
- it invokes a fast read-only subagent for search or codebase exploration
- it invokes a stronger analysis model for review or planning
- it invokes a cheaper documentation-oriented model for docs or summaries

In OpenCode, this is configured by assigning `model` per agent or subagent. If a subagent does not define its own model, it inherits the model of the primary agent that invoked it.

Example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-5",
  "small_model": "openai/gpt-5-mini",
  "agent": {
    "build": {
      "mode": "primary",
      "model": "openai/gpt-5"
    },
    "plan": {
      "mode": "primary",
      "model": "openai/gpt-5-mini",
      "temperature": 0.1
    },
    "explore": {
      "mode": "subagent",
      "description": "Fast read-only codebase exploration",
      "model": "openai/gpt-5-mini"
    },
    "review": {
      "mode": "subagent",
      "description": "Read-only code review",
      "model": "anthropic/claude-sonnet-4-20250514",
      "temperature": 0.1
    },
    "general": {
      "mode": "subagent",
      "description": "General multi-step execution",
      "model": "openai/gpt-5"
    }
  }
}
```

A practical default setup is:

- `build`: strongest coding model
- `explore`: cheaper, fast model
- `plan`: cheaper or reasoning-tuned model
- `review`: strong analysis model with low temperature
- `docs`: cheaper general model unless documentation quality is especially important

Additional recommendations:

- Set one strong global default `model`.
- Set `small_model` for cheap background or lightweight tasks.
- Explicitly pin important subagents to their own models.
- Use project `opencode.json` or `.opencode/agents/` if you want team-shared routing.
- Keep provider credentials and secrets in your user-level OpenCode config instead of project config.
- Use `permission.task` if you want to control which subagents a primary agent is allowed to invoke.

## Permissions And Questions

OpenCode approval flows stay inside the chat UI.

- Permission requests appear inline and can be answered with `Reject`, `Once`, or `Always`.
- Follow-up questions appear inline with selectable options and optional custom input.
- Each session can run in `Default`, `Auto approve`, or `Full access` permission mode.
- Use the permission control in the composer toolbar to switch the active session between those modes.

`Default` allows read-style tools and asks before actions that can modify state.

`Auto approve` is the first-run mode. It applies conservative local rules to eligible workspace edits and commands. Requests that cannot be decided locally may be sent, with their command, path, metadata, and recent approval examples, to the configured model in a temporary hidden judge session. Allowed verdicts are cached briefly for identical permission context. Switching away from `Auto approve` prevents an unfinished judge request from granting permission.

`Full access` updates the session permission rules and auto-approves pending permission prompts for that session. Select it only when the session can operate without confirmation.

## Generate Commit Messages

Varro integrates commit-message generation directly into VS Code Source Control.

1. Stage the exact changes you intend to commit.
2. Use the quick wand icon in the Source Control toolbar, or run `Varro: Generate Commit Message` from the Command Palette.
3. Review or edit the generated text in Git's commit input, then commit normally.

Generation is staged-only. Unstaged changes are not sent to the model or described in the result. Varro rejects unresolved merge changes and asks you to stage files when the index is empty.

The model is selected in this order:

1. OpenCode's repository-scoped `small_model`, when configured
2. OpenAI GPT Luna Fast when the connected account is confirmed as a Pro plan
3. A standard GPT Luna model exposed by a connected provider
4. The active Varro chat model, using an available low-reasoning variant instead of the selected high or max variant
5. OpenCode's default model when none of the preceding routes is available

All staged paths, up to the first 100,000 characters of the staged patch, and up to ten recent commit subjects are treated as untrusted input in a temporary tool-disabled session. Split larger staged diffs into smaller commits for the most accurate result. Varro never logs the patch, stages files, or executes the commit. It also rechecks the staged diff and commit input before applying a result, so a slow generation cannot silently overwrite newer work.

## Output In The Chat

Varro renders OpenCode output as structured UI instead of plain text only.

- Streaming assistant messages
- Tool call cards with live status
- Expanded shell tool cards stream command output while running, show failed or aborted output inline, and provide a command copy action
- Long tool input or output can open in a read-only editor tab
- Inline permission and question prompts
- Todo tracking from `todowrite` or related todo events
- Diff summaries for changed files
- Session summaries with changed-file counts and line additions/deletions
- Context compaction markers when OpenCode summarizes a session
- Usage-limit banners when a run is retrying against provider limits
- A transport banner when the OpenCode event stream is reconnecting and live updates may lag temporarily
- A slow-request banner when an OpenCode request has been waiting for more than 15 seconds
- A jump-to-latest button when you scroll away from the bottom of the chat; clicking it returns to the newest message and re-enables auto-follow

## VS Code Commands And Keybindings

- `Varro: New Session`
- `Varro: Search Sessions`
- `Varro: Abort Session`
- `Varro: Previous Session`
- `Varro: Next Session`
- `Varro: Restart Server`
- `Varro: About`
- `Varro: Show Output`
- `Varro: Open Source Control`
- `Varro: Generate Commit Message` generates from staged changes with OpenCode's configured `small_model`; otherwise it prefers GPT Luna Fast for a confirmed OpenAI Pro account, standard GPT Luna, the active chat model at low reasoning, and finally OpenCode's default model. It fills the selected Git repository's commit input without committing
- `Varro: Open Global AGENTS.md`
- `Varro: Initialize Project AGENTS.md`
- `Varro: Add to Context` from Explorer, from the Command Palette (adds the active file), or `Cmd+Shift+K` / `Ctrl+Shift+K` when focus is outside the editor and terminal
- `Varro: Add to Context` from the editor selection context menu, or `Cmd+Shift+K` / `Ctrl+Shift+K` with an editor selection. Without a selection the key keeps its VS Code default (`Delete Line`)
- `Varro: Add to Context` from the terminal context menu, or `Cmd+Shift+K` / `Ctrl+Shift+K` while the terminal is focused

## Settings

Server:

- `varro.server.autoStart` - auto-start `opencode serve` when Varro first needs it; defaults to `true` and is marked deprecated/debug-only in VS Code
- `varro.server.port` - port used for the local OpenCode server (default `4096`); reload the VS Code window after changing it
- `varro.server.command` - optional path to the OpenCode CLI executable
- `varro.server.autoUpdate` - automatically install compatible OpenCode CLI updates in the background on macOS and Linux; Windows, or disabling this setting, uses an upgrade prompt instead. Automatic installation is capped at the OpenCode version declared and tested by Varro, and failed automatic updates show tailored recovery guidance.

Chat view:

- `varro.chat.defaultPermissionMode` - initial permission mode when no saved project or global selection exists; defaults to `auto`
- `varro.chat.showInlineFileChanges` - show line-by-line edits in file-change tool cards; defaults to `true`
- `varro.chat.showChangedFiles` - show the changed-files panel above the composer; defaults to `false`
- `varro.chat.desktopSessionPaneSide` - on large screens, show the sessions pane on the `left` or `right`; defaults to `right`
- `varro.chat.autoRenameUntitledSessions` - generate a fallback title when OpenCode leaves a session untitled; defaults to `false`
- `varro.chat.autoCompact` - enable automatic OpenCode session compaction when context is full unless project `opencode.json` overrides it; defaults to `true`
- `varro.chat.autoCompactionReservedTokens` - reserved token headroom before automatic compaction triggers; defaults to `4096`, or set it to `null` to use OpenCode defaults

There are also deprecated debug-only settings used for development and recovery testing:

- `varro.debug.simulateMissingCli`
- `varro.debug.simulateNoProviders`
- `varro.debug.simulateUpgradeFailure`
- `varro.debug.suggestUntestedOpenCodeUpdates`

## Troubleshooting

- OpenCode CLI missing: install it with `npm install -g opencode-ai`.
- OpenCode CLI incompatible: `1.16.0` is the runtime floor. `1.18.15` is this release's tested and automatic-update ceiling, not a hard runtime maximum. Newer installed servers are allowed to run, but Varro warns about untested versions and does not offer or automatically install above-ceiling updates by default.
- CLI not on `PATH`: set `varro.server.command` to the executable path.
- OpenCode already running on another port: update `varro.server.port` and optionally disable `varro.server.autoStart`.
- No models available: run `/connect` or `opencode auth login`, then reopen Varro.
- Provider badge missing: quota metadata is only shown when OpenCode or the provider exposes usable limit information.
- Images do not send: select a model with vision support.
- Live updates are reconnecting: REST requests still work, but session status can lag until the event stream recovers.
- Session export fails: ensure the OpenCode CLI is installed and `varro.server.command` points to it if the executable is outside `PATH`.
- Server needs a clean reconnect: run `Varro: Restart Server`.
