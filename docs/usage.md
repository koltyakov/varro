# Usage Guide

This guide covers the current Varro workflow inside VS Code.

## Open Varro

- Click the `Varro` icon in the Activity Bar.
- For the best layout, move Varro to the `Secondary Side Bar` so you can keep the editor visible while chatting.

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

If you disable `varro.server.autoStart`, start OpenCode manually:

```sh
opencode serve --port 4096
```

If the CLI is installed somewhere that is not on `PATH`, set `varro.server.command` to the executable path.

## What Varro Sends As Context

Varro can include more than the text in the composer.

- Workspace path, sent as `[Working directory: ...]`
- Active file, when `varro.context.autoAttachFile` is enabled
- Current selection, when `varro.context.autoAttachSelection` is enabled
- Selected terminal text
- Explicitly attached files or folders
- Explicit line ranges attached from the editor selection command
- Pasted image attachments when the selected model supports vision

The current document appears as a chip above the composer. You can click that chip to disable or re-enable live current-document context for the active session.

When the active file is also attached explicitly, Varro avoids duplicating overlapping line ranges.

## Add Context Manually

Use any of these flows to add more context.

- Right-click a file or folder in Explorer and choose `Varro: Add to Context`.
- With an editor selection, use the editor context menu entry that also appears as `Varro: Add to Context`.
- Select terminal text and choose `Varro: Add to Context` from the terminal context menu.
- Drag files or folders into the composer.
- Use the composer attachment flow from `/attach`.
- Paste an image into the composer.
- Type `@path/to/file` to search workspace files.
- Type `@agent-name` to mention an available agent.

## Composer Behavior

- `Enter` sends the message.
- `Shift+Enter` inserts a newline.
- While a session is running, plain `Enter` queues a follow-up message, including any attached files, images, or terminal selection.
- While a session is running, `Ctrl+Enter` or `Cmd+Enter` sends a steering message with `noReply` enabled.
- While a session is running, the send menu also exposes `Add to Queue`, `Steer with Message`, and `Stop and Send`.
- `ArrowUp` and `ArrowDown` can step through previous user prompts when the composer is empty.
- `Cmd+Z` / `Ctrl+Z` undoes the last composer edit, including pasted text and attachment changes (context files and pasted images). `Cmd+Shift+Z`, `Ctrl+Shift+Z`, or `Ctrl+Y` redoes it.
- `Escape` closes any open composer popup; otherwise, while a session is running, it stops the session.
- `Tab` accepts the highlighted slash-command or mention completion.
- Slash commands are available directly in the composer.

Current built-in slash commands include:

- `/new` or `/clear` starts a new chat session
- `/skills` browses skill commands loaded from OpenCode
- `/sessions` or `/resume` opens the session list
- `/models` opens the model picker
- `/mcp` or `/mcps` opens the MCP picker for the current session
- `/connect` opens provider login in a VS Code terminal
- `/attach` or `/files` picks files or folders to attach
- `/settings` opens VS Code Settings filtered to Varro
- `/export` opens a JSON export of the current session in the editor
- `/thinking` or `/reasoning` toggles thinking block visibility
- `/compact` or `/summarize` compacts conversation context
- `/init` analyzes the workspace and creates or improves `AGENTS.md`
- `/review` asks the agent to review current workspace changes
- `/ralph` starts a Ralph loop from a plan or spec document
- `/abort` or `/stop` stops the current run

Custom OpenCode commands loaded from your local config also appear in the same completion list. Skill-sourced commands are browsed through `/skills` instead of being mixed into the main slash-command list.

Some commands only appear when they apply. For example, `/init` only appears in blank sessions and `/abort` only appears while a session is active.

## Sessions

Sessions are filtered to the current workspace directory, then sorted by most recently updated.

- Start a fresh session with `Varro: New Session` or the new chat button.
- Open the session list from the back button in the header.
- Search sessions by title, session ID, or workspace directory.
- Filter or jump to `Running`, `Needs attention`, `Failed`, `Plan ready`, and `Completed` sessions from the header badges.
- Open sub-agent sessions from the parent session row when they exist.
- Archive sessions from the session list.
- Deleted session roots move into a recycle bin section where you can restore them or delete them permanently until they expire.
- Stop the active run with `Varro: Abort Session`.
- Use `/export` to open the current session as JSON in the editor.

On large layouts, Varro can keep a persistent session pane beside the chat. Use `varro.chat.desktopSessionPaneSide` to choose whether that pane appears on the left or right.

If the sidebar is hidden, Varro can show VS Code notifications when a background session finishes or when the agent is blocked on a permission or question. It also exposes a status bar item that summarizes waiting or completed sessions. Clicking that item opens pending-attention sessions first, otherwise it focuses Varro.

If VS Code reloads while a session was running, Varro reconnects to those sessions and can continue interrupted work automatically when the session is still resumable.

## Plans, Reviews, And Ralph

- `/review` sends a review prompt for the current workspace changes.
- `/ralph` opens a form where you pick a plan or spec document, set an iteration cap, optionally choose a model and reasoning variant, and can override the loop prompt template.
- A Ralph run creates a manager session with a dedicated dashboard plus one child session per iteration.
- After each iteration settles, the Ralph manager sends a separate verification turn and expects lines like `<name>: PASS`, `<name>: FAIL - <cause>`, or `<name>: SKIPPED - <reason>`.
- If verification fails, Ralph can spawn up to two repair sub-agents for that iteration before the loop moves on.
- Ralph can pause, resume, or stop from the dashboard. It stops automatically when the plan starts with `DONE`, after consecutive passing iterations against a clean checklist, or when the iteration cap is reached. If the cap is reached with unchecked plan items or failed verification, the run is marked `incomplete` and can be continued with a higher limit.
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

The model settings view also shows whether a model exposes tools, variants, vision support, and a known context-window size.

The composer can show two pieces of model metadata:

- Provider limit status, when Varro can read quota information from OpenCode metadata or a supported provider endpoint.
- Context usage, based on token totals from assistant messages and the selected model's context window.

If a provider or model hits a usage limit, Varro shows a usage-limit banner with actions to stop retrying or switch providers.

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
- Each session can run in `Default` or `Full access` permission mode.
- Use the permission control in the composer toolbar to switch the active session between those modes.

`Default` allows read-style tools by default and asks for tool calls that can modify state. `Full access` updates the session permission rules and auto-approves pending permission prompts for that session.

## Output In The Chat

Varro renders OpenCode output as structured UI instead of plain text only.

- Streaming assistant messages
- Tool call cards with live status
- Inline permission and question prompts
- Todo tracking from `todowrite` or related todo events
- Diff summaries for changed files
- Session summaries with changed-file counts and line additions/deletions
- Context compaction markers when OpenCode summarizes a session
- Usage-limit banners when a run is retrying against provider limits
- A transport banner when the OpenCode event stream is reconnecting and live updates may lag temporarily
- A jump-to-latest button when you scroll away from the bottom of the chat; clicking it returns to the newest message and re-enables auto-follow

## VS Code Commands And Keybindings

- `Varro: New Session`
- `Varro: Abort Session`
- `Varro: Restart Server`
- `Varro: Add to Context` from Explorer, or `Cmd+Shift+K` / `Ctrl+Shift+K` while the editor is focused
- `Varro: Add to Context` from the editor selection context menu
- `Varro: Add to Context` from the terminal context menu, or `Cmd+Shift+K` / `Ctrl+Shift+K` while the terminal is focused

## Settings

Server:

- `varro.server.autoStart` - auto-start `opencode serve` when Varro first needs it
- `varro.server.port` - port used for the local OpenCode server (default `4096`)
- `varro.server.command` - optional path to the OpenCode CLI executable
- `varro.server.autoUpdate` - run OpenCode CLI updates in the background when Varro detects a newer version; failed background updates fall back to the normal upgrade prompt

Context:

- `varro.context.autoAttachFile` - include the active editor file in live context
- `varro.context.autoAttachSelection` - include the current editor selection in live context

Provider limits:

- `varro.providerLimits.enabledAdapters` - allowlist of provider-limit adapters Varro may poll
- Supported IDs: `anthropic` (Anthropic), `github-copilot` (GitHub Copilot), `openrouter` (OpenRouter), `zai` (Z.ai), `minimax` (MiniMax), `openai` (OpenAI), `gemini` (Gemini/Google), `antigravity` (Antigravity)
- Default enabled IDs: `anthropic`, `github-copilot`, `openrouter`, `zai`, `minimax`, `openai`
- `varro.providerLimits.disabled` - disable provider-limit polling and hide provider-limit UI; otherwise polling uses the built-in `120` second interval, with active sessions refreshed every `30` seconds when the default interval is in use
- `varro.providerLimits.thresholdPercent` - show provider-limit UI when any provider-limit window has this remaining percentage less than or equal to the threshold; defaults to `100`

Chat view:

- `varro.chat.expandThinkingByDefault` - expand reasoning/thinking blocks by default
- `varro.chat.showStickyUserPrompt` - show a sticky preview of the latest user prompt while scrolling long assistant responses
- `varro.chat.desktopSessionPaneSide` - on large screens, show the sessions pane on the `left` or `right`
- `varro.chat.autoCompact` - enable automatic OpenCode session compaction when context is full unless project `opencode.json` overrides it
- `varro.chat.autoCompactionReservedTokens` - reserved token headroom before automatic compaction triggers; set to `null` to use OpenCode defaults

There are also deprecated debug-only settings used in development builds:

- `varro.debug.simulateMissingCli`
- `varro.debug.simulateNoProviders`

## Troubleshooting

- OpenCode CLI missing: install it with `npm install -g opencode-ai`.
- CLI not on `PATH`: set `varro.server.command` to the executable path.
- OpenCode already running on another port: update `varro.server.port` and optionally disable `varro.server.autoStart`.
- No models available: run `/connect` or `opencode auth login`, then reopen Varro.
- Provider badge missing: quota metadata is only shown when OpenCode or the provider exposes usable limit information.
- Images do not send: select a model with vision support.
- Live updates are reconnecting: REST requests still work, but session status can lag until the event stream recovers.
- Session export fails: ensure the OpenCode CLI is installed and `varro.server.command` points to it if the executable is outside `PATH`.
- Server needs a clean reconnect: run `Varro: Restart Server`.
