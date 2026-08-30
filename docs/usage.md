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

If OpenCode does not have any providers configured yet, either connect one from Varro's Models view or log in from a terminal:

```sh
opencode auth login
```

From inside Varro, `/connect` opens the provider connection dialog. The no-provider recovery screen offers the same embedded setup. Use `opencode auth login` when a provider does not expose a supported embedded method.

Varro connects to `http://127.0.0.1:4096` by default. It does not start OpenCode at extension activation time. Instead, it starts or attaches to the server the first time the chat view needs it.

For advanced manual server management, disable `varro.server.autoStart` and start OpenCode yourself. VS Code marks this switch as deprecated and debug-only, but it remains available for this workflow:

```sh
opencode serve --port 4096
```

If the CLI is installed somewhere that is not on `PATH`, set `varro.server.command` to the executable path.

On native Windows, run the install and authentication commands in PowerShell, Command Prompt, or another Windows terminal. Varro runs on the local Windows extension host and looks for the Windows OpenCode CLI. OpenCode stores native Windows data, including credentials, logs, and sessions, under `%USERPROFILE%\.local\share\opencode`.

OpenCode [recommends WSL for the best Windows experience](https://opencode.ai/docs/windows-wsl). Open the project in a VS Code WSL window, then install and authenticate OpenCode inside that distribution. A WSL window runs Varro and OpenCode on the Linux extension host, where data is under `~/.local/share/opencode`. A CLI installed only on Windows is not available to that host, and a CLI installed only in WSL is not available to a native VS Code window.

## Workspace And Remote Environments

Varro requires a trusted, non-virtual workspace because it starts a process with access to workspace files. VS Code does not enable the extension in Restricted Mode or virtual workspaces such as repositories opened without a local or remote filesystem checkout.

Varro is a workspace extension. In Remote SSH, Dev Containers, and similar setups where VS Code runs workspace extensions remotely, Varro and the OpenCode server run on that remote extension host. In those environments:

- `127.0.0.1`, port `4096`, and a manually started OpenCode server refer to the remote host or container, not your desktop.
- The OpenCode CLI, `varro.server.command`, provider credentials, and OpenCode configuration must be available on that host.
- Files dragged from the desktop can use Varro's bounded content-upload fallback when their local paths are unavailable to the remote extension host.

VS Code WSL follows the same rule. Check the lower-left remote indicator before troubleshooting `PATH`, configuration, credentials, or session history. A window with a `WSL` indicator uses the distribution's Linux CLI and files; a normal local window uses the native Windows CLI and files.

## What Varro Sends As Context

Varro can include more than the text in the composer.

- Working directory and, in multi-root workspaces, the open workspace-folder map
- Active file, when live current-document context is enabled for the session
- Current selection, including unsaved selected text, or a bounded window of a dirty editor buffer when there is no selection, when live current-document context is enabled
- Selected terminal text
- Diagnostics from the active file when you explicitly attach current Problems with `/diagnostics`
- Explicitly attached files or folders
- Explicit line ranges attached from the editor selection command
- Pasted image attachments when the selected model supports vision, or path-backed images delegated through a configured `@vision` subagent
- Native PDF attachments when the selected model advertises PDF input support

The current document appears as a chip above the composer. You can click that chip to disable or re-enable live current-document context for the active session.

In a multi-root workspace, session history and search cover every open root. The session-list folder picker filters that workspace-wide catalog without changing where new work runs. A new empty chat follows the active editor's root; use the working-directory picker in the composer toolbar to choose another root. Existing and restored sessions always run in their recorded directory and cannot be moved between roots.

OpenCode still has one working directory per session. Varro tells the agent about sibling workspace roots and can attach or search files from them, but access outside the session's working directory remains subject to OpenCode's `external_directory` permission.

When the active file is also attached explicitly, Varro avoids duplicating overlapping line ranges.

## Add Context Manually

Use any of these flows to add more context.

- Right-click a file or folder in Explorer and choose `Varro: Add to Context`, or run `Varro: Add to Context` from the Command Palette to add the active file.
- With an editor selection, use the editor context menu entry that also appears as `Varro: Add to Context`, or press `Cmd+Shift+K` / `Ctrl+Shift+K`.
- Select terminal text and choose `Varro: Add to Context` from the terminal context menu, or press `Cmd+Shift+K` / `Ctrl+Shift+K`.
- Drag files or folders into the composer.
- Use the attachment button beside the composer.
- Paste an image or PDF into the composer.
- Type `@path/to/file` to search files across all open roots. Multi-root results include their folder label.
- Type `@agent-name` to mention an available agent.
- Type `&` to search recent root sessions and insert a stable `session:<id>` reference. Session references in the composer and rendered responses open the referenced session.

Varro keeps at most five pasted images, with a maximum size of 5 MiB per image. Native PDFs can be picked, dropped, or pasted and are limited to 20 MiB in total. When the selected model does not advertise PDF input support, a picked or dropped PDF with an available file path is sent as a file reference instead of native PDF data. A pasted PDF without an available path remains visible but is not sent. In environments where other dropped items do not expose local paths, content-only drops are limited to 20 files, 10 MiB per file, and 50 MiB in total.

### Add Vision To A Text-Only Model

Varro can delegate pasted images from a tool-capable text-only model, such as GLM, to an OpenCode subagent named `vision`. Add the agent to `opencode.json` and replace the example model with a model available from one of your configured providers:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "vision": {
      "description": "Inspects images for text-only parent agents",
      "mode": "subagent",
      "model": "openai/gpt-5.6-luna",
      "prompt": "Analyze every supplied image carefully. Return a concise textual description, including visible text, UI state, diagrams, errors, and details relevant to the parent agent's request.",
      "permission": {
        "read": "allow",
        "edit": "deny",
        "bash": "deny"
      }
    }
  }
}
```

The `vision` agent must have an explicit model that OpenCode reports as supporting image input. If the saved agent does not appear, follow the server restart guidance under [Models, Agents, Reasoning, And MCPs](#models-agents-reasoning-and-mcps). With a non-vision parent model, pasted images retain the normal disabled appearance and are not sent unless the prompt contains an exact `@vision` mention. Once `@vision` is present, Varro materializes the images as private temporary files and instructs OpenCode to include those files in the vision subagent task. The parent model must support tool calls and be allowed to invoke the `vision` subagent.

## Composer Behavior

- `Enter` sends the message.
- `Shift+Enter` inserts a newline.
- While a session is running, plain `Enter` queues a follow-up message, including any attached files, images, or terminal selection.
- While a session is running, `Ctrl+Enter` or `Cmd+Enter` sends a steering message with `noReply` enabled.
- While a session is running, the send menu also exposes `Add to Queue`, `Steer with Message`, and `Stop and Send`.
- `ArrowUp` and `ArrowDown` can step through previous user prompts when the composer is empty.
- `Cmd+Z` / `Ctrl+Z` undoes the last composer edit, including pasted text and file, image, or PDF attachment changes. `Cmd+Shift+Z`, `Ctrl+Shift+Z`, or `Ctrl+Y` redoes it.
- `Escape` closes any open composer popup or cancels message editing; otherwise, it returns to the session list without stopping a running session.
- `Tab` accepts the highlighted slash-command, mention, or session completion.
- Slash commands are available directly in the composer.

Unsent composer text and explicit file or folder attachments are restored after webview or window reloads. Images, PDFs, terminal selections, and diagnostic attachments are persisted when they are queued, not as part of an ordinary unsent draft.

### Queued Messages

Queued messages belong to the session where they were created and dispatch from top to bottom when that session is connected and idle, even while another chat is active. A pending permission, question, edit, failed dispatch, or steering request prevents automatic dispatch for that session until it is resolved.

- Drag the handle, or focus it and press `ArrowUp` or `ArrowDown`, to reorder messages within the same session.
- Pause or resume an individual message. `Option`/`Alt`-click applies the same action to every queued message for that session.
- Send a queued message immediately as a steering message, retry a failed send, edit it when the composer is clear, or remove it.
- Text, selected agent, files, diagnostics, terminal selections, pasted images, and native PDFs are persisted in VS Code workspace state across window and webview reloads. Binary attachment data stays in extension-host persistence instead of synchronous webview storage.
- Successfully dispatched and explicitly removed messages leave the queue. Failed messages remain available for retry.

Commands offered in slash-command completion include:

- `/skills` browses skill commands loaded from OpenCode
- `/connect` opens the provider connection dialog
- `/settings` opens VS Code Settings filtered to Varro
- `/export` opens a JSON export of the current session in the editor
- `/stats` opens a Markdown token and assistant-duration report for the last 30 days across all OpenCode projects; `/stats all` also includes retained all-time usage
- `/thinking` or `/reasoning` toggles thinking block visibility
- `/compact` or `/summarize` compacts conversation context
- `/fork` forks the current session
- `/init` analyzes the workspace and creates or improves `AGENTS.md`
- `/review` asks the agent to review current workspace changes
- `/ralph` starts a Ralph loop from a plan or spec document

Custom OpenCode commands loaded from your local config also appear in the same completion list. Skill-sourced commands are browsed through `/skills` instead of being mixed into the main slash-command list.

`/stats` scans the last 30 days of retained OpenCode history across projects and opens an untitled Markdown report. It groups token use and total completed assistant duration by provider and model. Use `/stats all` when you need the slower all-time scan. Deleted OpenCode history cannot be included.

Some commands only appear when they apply. `/ralph` appears before a session exists, `/export` appears after one exists, and `/init` appears when the workspace can be initialized.

`/diagnostics`, `/fork`, `/abort`, `/stop`, `/undo`, `/revert`, and `/redo` can be submitted directly when applicable but are intentionally hidden from slash-command completion. `/undo` or `/revert` undoes the last assistant response, and `/redo` reapplies it. These session-level actions are separate from composer undo and redo.

Use `Varro: Open Global AGENTS.md` to edit OpenCode's global instructions. `Varro: Initialize Project AGENTS.md` creates the project file when needed, opens it, and starts a new chat with `/init` ready to send using the current model.

## Sessions

Sessions from every open workspace root appear in one catalog. Use the folder filter above search to narrow the list; it defaults to `All folders`. Folder labels appear only when multiple roots are open. The default list is split into `Recent`, `Archive`, and `Recycle Bin`. `Archive` is a UI grouping for older ordinary sessions; opening it does not alter those sessions in OpenCode. Pinned and active-state sessions remain surfaced, while other sessions are ordered approximately by activity age.

- Start a fresh session with `Varro: New Session` or the new chat button. Right-click the button to choose `New Chat` or `New Chat in Editor`. Crafted composer text is kept for the new session, while file, image, terminal, and message-edit context is cleared.
- Open the session list from the back button in the header.
- Search uses OpenCode's native root-session search across loaded and older history and returns up to 30 results. Matching fields depend on the installed OpenCode version. Run `Varro: Search Sessions` to open and focus search directly.
- Filter or jump to `Running`, `Needs attention`, `Failed`, `Plan ready`, and `Completed` sessions from the header badges.
- Open sub-agent sessions from the parent session row when they exist.
- Top-level sessions can be renamed, pinned, or moved to the recycle bin. Any session can open in the sidebar, an editor tab, or the OpenCode TUI; copy its ID; and be shared or unshared. Opening an editor session in the sidebar closes its matching editor tab. Sharing asks OpenCode to create a share link and copies it to the clipboard.
- Deleted session roots move into a recycle bin section where you can restore them or delete them permanently for 24 hours before they expire.
- Stop the active run with `Varro: Abort Session`.
- Use `/export` to open the current session as JSON in the editor.
- Changed-file rows open the selected session's before/after snapshot in VS Code's native diff editor when OpenCode provides both sides, with the working-tree Git diff as a fallback.
- Use the conversation-turn rail beside the transcript to jump between user prompts. If the target turn is outside the loaded message window, Varro loads older history before navigating to it.

Opening a session fetches the newest 200 messages. Scrolling to the top automatically prepends the next 200-message page while preserving the visible position. If an earlier page fails to load, the history boundary changes into a `Retry` action.

On large layouts, Varro can keep a persistent session pane beside the chat. Use `varro.chat.desktopSessionPaneSide` to choose whether that pane appears on the left or right.

If the sidebar is hidden, Varro can show VS Code notifications when a plan is ready, a top-level session fails, or the agent is blocked on a permission or question. It also exposes a status bar item that summarizes waiting or completed top-level sessions, including ordinary completed sessions that do not produce a notification, and alerts in sibling workspaces. Clicking that item opens pending-attention sessions first, otherwise it focuses Varro.

If VS Code reloads while a session was running, Varro reconnects to those sessions and can continue interrupted work automatically when the session is still resumable.

## Plans, Reviews, And Ralph

- `/review` sends a review prompt for the current workspace changes. From a blank chat, it creates the review session before sending.
- `/ralph` opens a form where you pick a plan or spec document, set an iteration cap (default `10`), optionally choose a model and reasoning variant, and can override the loop prompt template.
- Ralph manager, iteration, and repair sessions run in `Full access`, independently of the permission mode selected in the composer. Review the plan and prompt before starting the loop.
- A Ralph run creates a manager session with a dedicated dashboard plus one child session per iteration.
- After each iteration settles, the Ralph manager sends a separate verification turn and expects lines like `<name>: PASS`, `<name>: FAIL - <cause>`, or `<name>: SKIPPED - <reason>`.
- Each iteration takes the first actionable incomplete plan item and must update plan progress or report a blocker. Verification runs checks relevant to that iteration and avoids repeating a reported check unless matching files changed.
- If verification fails, Ralph can spawn up to two repair sub-agents for that iteration before the loop moves on.
- Ralph can pause, resume, or stop from the dashboard. It stops early when the plan starts with `DONE` and the latest completed iteration has no failed verification; otherwise it runs to the iteration cap. If the cap is reached with unchecked plan items or failed verification, the run is marked `incomplete` and can be continued with a higher limit. Manual stops and iteration errors terminate the run separately.
- Sessions that finished with the `plan` agent surface as `Plan ready` in the session list.
- The latest plan response can be opened as a saved markdown plan document.
- The latest plan response can also be handed off to the build flow so Varro continues with implementation instead of revising the plan.

## Models, Agents, Reasoning, And MCPs

Varro loads agents, models, and MCP tools from your local OpenCode configuration.

Varro watches OpenCode's global configuration and authentication files and refreshes provider and model state when OpenCode is idle. A refresh waits while agents are running or questions or permission requests are pending. Changes made through Varro's Models view follow the same safe refresh flow.

External edits to project-level OpenCode configuration may not be detected. If agents, models, commands, skills, MCP servers, or other settings do not reflect the saved config, open the Command Palette and run `Varro: Restart Server`. Varro checks for active work before restarting a server it manages. If active work blocks the restart, finish or abort that work and run the command again. If you started `opencode serve` yourself, restart that process from its terminal.

- Pick the agent from the composer toolbar.
- Pick the provider/model from the model picker.
- Choose a reasoning variant when the selected model exposes variants.
- Open the MCP picker to connect or disconnect session MCPs.
- MCP servers that require OAuth open an authorization flow with code entry and saved-credential recovery. Servers that require a pre-registered OAuth client show configuration guidance instead of starting an unsupported flow.
- Open the model picker footer to hide or show providers and individual models.
- Pin frequently used models to a dedicated group in the picker, or assign a local display name from the Models view. These preferences do not change the OpenCode provider/model ID.
- Use the add and disconnect actions in the Models view to connect or disconnect provider credentials. Option/Alt-click either action to use OpenCode's terminal manager instead.
- In the Models view, right-click a model to assign it to project `small_model`, an available sub-agent, commit-message generation, or the auto-approve judge. Project and agent assignments update the project OpenCode configuration after checking for unsaved or concurrent changes. Commit-message and auto-approve assignments update their VS Code user settings instead.

The Models view also shows whether a model exposes tools, variants, vision support, and a known context-window size. A lightning marker identifies GPT model names containing `Fast`; its tooltip notes that fast models can be more expensive.

### Configure Primary Agents

Define primary agents in OpenCode configuration. Varro lists them in the agent picker and uses the selected agent for the main conversation.

Alternatively, enable `varro.chat.enableAskAgent` to add Varro's read-only `Ask` primary agent only to the managed OpenCode runtime. The setting does not modify `opencode.json`; if inherited, global, or project OpenCode configuration already defines an agent named `ask` (case-insensitive), Varro uses that definition instead.

Choose the config scope based on where you want the agent to appear:

- Global: `~/.config/opencode/opencode.json`. The agent is available in every workspace that uses this OpenCode installation.
- Project: `<project>/opencode.json`. The agent is available only when OpenCode runs in that project. Commit this file if the team should share the agent.

OpenCode merges global and project configuration. A project agent with the same name overrides the matching global agent fields. Keep provider credentials and other secrets in the global config, not in a committed project file.

This example adds `ask`, a primary agent that can inspect local code and search documentation but cannot edit files, run commands, delegate to subagents, or call unlisted custom and MCP tools:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "ask": {
      "description": "Answers questions and investigates the codebase without modifying anything",
      "mode": "primary",
      "prompt": "Answer questions about the codebase using read-only investigation. Explain findings directly and cite relevant files and lines. Do not modify files, run shell commands, delegate work, or perform external side effects. If the user asks you to edit or implement something, do not make changes. Suggest switching to the Build agent.",
      "permission": {
        "*": "deny",
        "read": "allow",
        "glob": "allow",
        "grep": "allow",
        "list": "allow",
        "lsp": "allow",
        "skill": "allow",
        "webfetch": "allow",
        "websearch": "allow",
        "question": "allow"
      }
    }
  }
}
```

The `"*": "deny"` rule is the read-only boundary. The prompt describes expected behavior, but it does not prevent tool calls by itself. Put the catch-all rule before the specific read-oriented allowances because OpenCode uses the last matching permission rule.

Omit `model` to use the configured global model, or add a provider-qualified model such as `"model": "openai/gpt-5.6-sol"` inside the agent. Add `"default_agent": "ask"` at the top level if new sessions should select it by default.

### Provider Connections

The Models view reads OpenCode's provider catalog and authentication methods. Depending on the provider plugin, the connection dialog can accept an API key, collect provider-specific fields, or open an OAuth authorization page in your browser. Some OAuth flows finish automatically; others ask you to paste an authorization code back into Varro. OpenCode stores the resulting credential.

Disconnect removes the selected saved credential from OpenCode. Providers without a usable embedded method, providers missing from the dialog, and connection problems can use the terminal fallback instead.

When an assistant response fails because a provider credential expired, was revoked, or is otherwise unauthorized, the response offers `Re-authenticate`. The Models view also marks that provider with `Reconnect`. Successful embedded reauthentication refreshes provider data without requiring a server restart when only authentication changed; send a new prompt to continue the failed turn.

The composer can show model and session metadata:

- Provider limit status, when Varro can read quota information from OpenCode metadata or a supported provider endpoint.
- Context usage, based on token totals from assistant messages and the selected model's context window.
- Reported session cost in the context popup, when OpenCode supplies cost data.

If a provider or model hits a usage limit, Varro shows a usage-limit banner with actions to stop retrying or switch providers.

Provider and configuration changes are revalidated without interrupting running agents. When applying a refresh must wait, the Models view shows a queued configuration update and applies it after active work finishes. Embedded reauthentication can refresh an authentication-only change immediately.

### Provider-Limit Polling And Credentials

Provider-limit polling is enabled. Varro polls every `120` seconds and every `30` seconds while the active session is working. Results are cached briefly in the extension host.

Adapter coverage currently includes Antigravity, Anthropic, OpenAI/Codex, OpenCode Go, GitHub Copilot, Gemini, OpenRouter, Z.AI, MiniMax, Kimi, Ollama Cloud, and xAI SuperGrok, plus metadata-header probes for compatible OpenAI, GitHub Copilot, and xAI API-key configurations. Availability depends on the provider and credential type; unsupported providers simply do not show quota details.

To retrieve quota metadata, the extension host can:

- Read the OpenCode authentication store and provider/model metadata. The default is `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json` on macOS, Linux, and WSL, and `%USERPROFILE%\.local\share\opencode\auth.json` on native Windows.
- Read provider-specific local credentials when available: `~/.claude/.credentials.json`, `${CODEX_HOME:-~/.codex}/auth.json` or `CODEX_TOKEN`, `${GEMINI_HOME:-~/.gemini}/oauth_creds.json` or `GEMINI_ACCESS_TOKEN`, and GitHub CLI `hosts.yml` under its configured or default config directory.
- Contact provider quota or metadata endpoints with those credentials, or inspect supported local metadata and proxy endpoints such as Antigravity and Anthropic status data.
- Refresh an expired Anthropic OAuth token sourced from `~/.claude/.credentials.json` after an authentication failure and atomically write the refreshed credentials back to that file. OpenCode-sourced Anthropic credentials are not rewritten.

When neither the corresponding VS Code model setting nor a valid `small_model` is configured and an OpenAI GPT Luna Fast model is available, commit-message generation and the auto-approve judge can also make a one-off OpenAI quota lookup to determine whether that model is eligible.

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
  "model": "openai/gpt-5.6-sol",
  "small_model": "openai/gpt-5.6-luna",
  "agent": {
    "build": {
      "mode": "primary",
      "model": "openai/gpt-5.6-sol"
    },
    "plan": {
      "mode": "primary",
      "model": "openai/gpt-5.6-terra",
      "temperature": 0.1
    },
    "explore": {
      "mode": "subagent",
      "description": "Fast read-only codebase exploration",
      "model": "openai/gpt-5.6-luna"
    },
    "review": {
      "mode": "subagent",
      "description": "Read-only code review",
      "model": "openai/gpt-5.6-terra",
      "temperature": 0.1
    },
    "general": {
      "mode": "subagent",
      "description": "General multi-step execution",
      "model": "openai/gpt-5.6-terra"
    },
    "vision": {
      "mode": "subagent",
      "description": "Image inspection for text-only parent models",
      "model": "openai/gpt-5.6-luna"
    }
  }
}
```

A practical default setup is:

- `build` and the global default: Sol for primary implementation work
- `general`, `plan`, and `review`: Terra for general-purpose subagent work and analysis
- `vision`, `explore`, `small_model`, and other lightweight helpers: Luna for fast, inexpensive focused tasks

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
- Each session can run in `Default`, `Auto-accept edits`, `Auto`, or `Full access` permission mode.
- Use the permission control in the composer toolbar to switch the active session between those modes.

Permissions from child and deeper sub-agent sessions inherit the nearest explicitly selected mode in
their parent session tree. When manual approval is needed, Varro surfaces the child request in the
parent conversation while keeping the request owned by the child session.

`Default` leaves permission decisions to OpenCode. Rules from your OpenCode configuration and selected
agent determine which actions are allowed, denied, or sent to Varro for manual approval. Varro does
not add session-level permission rules in this mode.

`Auto-accept edits` allows file edits, known read-only permissions, and subagent launches. Commands,
external access, interactive tools, and unknown permissions continue to ask for approval.

`Auto` is the first-run mode. Its deterministic rules allow known read-only permissions,
subagent launches, web searches, non-deleting edits whose canonical paths stay inside the
permission-owning session's Git-backed workspace, and strictly parsed inspection commands. Web fetches
and other requests not decided locally fall through to model or manual review. Actions inside a
subagent remain subject to the inherited permission mode. Ambiguous or out-of-workspace paths and
command composition or options that may mutate state also require further review.

Requests not decided by local rules may be sent, with their command, path, metadata, and recent user
permission decisions, to the configured model in a temporary hidden judge session. The judge may
allow the exact request once, reject it when materially equivalent to a prior rejection, or show the
normal manual prompt. Allow and reject verdicts are cached briefly for identical permission context.
Switching away from `Auto` prevents an unfinished judge request from granting permission.

When automatic review falls back to manual approval, the prompt shows a concise action summary when
available, the full request metadata with copy actions, and the judge's reason under `AI check`.

The judge uses `varro.chat.autoApproveModel` first, then OpenCode's `small_model`, OpenAI GPT Luna, GitHub Copilot GPT Luna, and the selected Varro session model. Right-click a model in the Models view to set the VS Code user setting.

`Full access` updates the session permission rules and auto-approves pending permission prompts for that session. Select it only when the session can operate without confirmation.

## Generate Commit Messages

Varro integrates commit-message generation directly into VS Code Source Control.

1. Stage the exact changes you intend to commit.
2. Use the quick wand icon in the Source Control toolbar, or run `Varro: Generate Commit Message` from the Command Palette.
3. Review or edit the generated text in Git's commit input, then commit normally.

Varro uses staged changes when the index is non-empty. If nothing is staged, it uses tracked unstaged changes and untracked files instead. It never mixes the two scopes. Varro rejects unresolved merge changes and reports when neither scope has usable changes.

The model is selected in this order:

1. The `varro.commitMessage.model` VS Code user setting
2. OpenCode's repository-scoped `small_model`, when configured
3. OpenAI GPT Luna, preferring Luna Fast when the connected account is confirmed as a Pro plan
4. GitHub Copilot GPT Luna
5. The active Varro chat model, using an available low-reasoning variant instead of the selected high or max variant

When no explicit route is available, the helper request omits its model and OpenCode uses its default. Right-click a model in the Models view to update the VS Code user setting.

All paths, up to the first 100,000 characters of the selected patch, and up to ten recent commit subjects are treated as untrusted input in a temporary tool-disabled session. Untracked file content has separate per-file and total size limits. On native Windows, Varro includes each untracked path with a `content unavailable` marker but omits its contents because Windows does not provide the atomic no-follow file read used to prevent path replacement during generation. Tracked unstaged diffs are unaffected. Split larger changes into smaller commits for the most accurate result. Varro never logs the patch, stages files, or executes the commit. It also rechecks the selected changes and commit input before applying a result, so a slow generation cannot silently overwrite newer work.

## Output In The Chat

Varro renders OpenCode output as structured UI instead of plain text only.

- Streaming assistant messages
- Tool call cards with live status
- Expanded shell tool cards stream command output while running, show failed or aborted output inline, and provide a command copy action
- Long tool input or output can open in a read-only editor tab
- Inline permission and question prompts
- Permission-rejected tool calls remain visible with a `rejected` label; when rejection stops the
  turn, its summary says `Permission rejected`
- Todo tracking from `todowrite` or related todo events
- Diff summaries for changed files
- Complete inline file-edit previews when `varro.chat.showFileDiffs` is enabled; filenames in the previews open the corresponding file
- Session summaries with changed-file counts and line additions/deletions
- Context compaction markers when OpenCode summarizes a session
- Mermaid diagrams from completed `mermaid` code fences, with source fallback, copy, and expanded-preview controls
- Navigable `session:<id>` references in assistant output
- Usage-limit banners when a run is retrying against provider limits
- A transport banner when the OpenCode event stream is reconnecting and live updates may lag temporarily
- A slow-request banner when an OpenCode request has been waiting for more than 15 seconds
- A jump-to-latest button when you scroll away from the bottom of the chat; clicking it returns to the newest message and re-enables auto-follow
- Completed turn summaries expose `Copy final response` and `Fork chat from here` actions. Copying uses the final assistant text from that turn.

Hold `Alt` or `Option` while viewing a sufficiently long final answer to reveal its read-mode action. Read mode opens the rendered answer in a focused dialog; close it with `Escape`, the close button, or a click outside the content.

Editable user messages expose an edit action. Sending the replacement removes that user message and the later conversation history before resending, but it does not restore files changed in the workspace. Use session `/undo` or `/revert` when you need OpenCode's revert workflow instead.

## VS Code Commands And Keybindings

- `Varro: New Session`
- `Varro: New Chat Editor`
- `Varro: New Terminal Editor`
- `Varro: Search Sessions`
- `Varro: Open Settings`
- `Varro: Show File Diffs` or `Varro: Hide File Diffs`
- `Varro: Usage Stats`
- `Varro: Abort Session`
- `Varro: Previous Session`
- `Varro: Next Session`
- `Varro: Restart Server`
- `Varro: About`
- `Varro: Open GitHub`
- `Varro: Show Output`
- `Varro: Open Source Control`
- `Varro: Generate Commit Message` generates from staged changes, or from the unstaged working tree when the index is empty, using the configured VS Code commit-message model, OpenCode `small_model`, OpenAI GPT Luna, GitHub Copilot GPT Luna, or the active chat model at low reasoning, in that order. It fills the selected Git repository's commit input without committing
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
- `varro.server.autoUpdate` - automatically install compatible OpenCode CLI updates in the background on macOS and Linux. Native Windows uses an upgrade prompt instead because a running server can lock `opencode.exe`. Before opening a Windows update command, Varro waits for active work and stops its managed server; stop a manually launched server yourself. Automatic installation is capped at the OpenCode version declared and tested by Varro, and failed automatic updates show tailored recovery guidance.

Chat view:

- `varro.chat.defaultPermissionMode` - initial permission mode when no saved project or global selection exists; defaults to `auto`
- `varro.chat.autoApproveModel` - provider/model used by the auto-approve judge; stored in VS Code user settings and selected from Varro's Models view
- `varro.chat.showFileDiffs` - show line-by-line edits in file-change tool cards; defaults to `false`
- `varro.chat.expandThinking` - expand thinking details after two seconds while reasoning is active, collapse finished thinking into rows, and return it to `Explored` when the turn finishes; defaults to `false`
- `varro.chat.fontSize` - chat text size from `6` through `100`; defaults to `null`, which uses VS Code's `chat.fontSize`. Tool and diff editor content follows `chat.editor.fontSize`
- `varro.chat.showChangedFiles` - show the changed-files panel above the composer; defaults to `false`
- `varro.chat.desktopSessionPaneSide` - on large screens, show the sessions pane on the `left` or `right`; defaults to `right`
- Use the scope picker inside the session search field to choose which OpenCode sessions appear. **Folder** shows exact working-directory matches, **Nested** includes folders beneath it in the same OpenCode project, and **Project** shows the entire containing Git project. Varro remembers the choice for each project; non-Git folders offer Folder and Nested independently.
- `varro.chat.autoRenameUntitledSessions` - generate a fallback title when OpenCode leaves a session untitled; defaults to `false`
- `varro.chat.autoCompact` - enable automatic OpenCode session compaction when context is full unless project `opencode.json` overrides it; defaults to `true`
- `varro.chat.autoCompactionReservedTokens` - reserved token headroom before automatic compaction triggers; defaults to `4096`, or set it to `null` to use OpenCode defaults

Commit messages:

- `varro.commitMessage.model` - provider/model used to generate commit messages; stored in VS Code user settings and selected from Varro's Models view

There are also deprecated debug-only settings used for development and recovery testing:

- `varro.debug.simulateMissingCli`
- `varro.debug.simulateNoProviders`
- `varro.debug.simulateUpgradeFailure`
- `varro.debug.suggestUntestedOpenCodeUpdates`

## Troubleshooting

- OpenCode CLI missing: install it with `npm install -g opencode-ai`.
- OpenCode CLI incompatible: `1.16.0` is the runtime floor. `1.18.25` is this release's tested and automatic-update ceiling, not a hard runtime maximum. Newer installed servers are allowed to run, but Varro warns about untested versions and does not offer or automatically install above-ceiling updates by default.
- CLI not on `PATH`: set `varro.server.command` to the executable path.
- Windows host mismatch: install OpenCode in Windows for a native VS Code window, or inside the distribution for a VS Code WSL window. Run `Varro: About` and check `Platform` if the active extension host is unclear.
- Windows update reports a locked file: finish active sessions and close the OpenCode update terminal before retrying. Stop any OpenCode server not managed by Varro yourself.
- OpenCode already running on another port: update `varro.server.port` and optionally disable `varro.server.autoStart`.
- No models available: connect a provider from the Models view, run `/connect`, or run `opencode auth login`, then reload providers or reopen Varro.
- Provider authentication failed: use `Re-authenticate` on the failed response or provider row, complete the API-key or OAuth flow, then send a new prompt. Use terminal setup if the embedded method is unavailable.
- Provider badge missing: quota metadata is only shown when OpenCode or the provider exposes usable limit information.
- Images do not send: select a model with vision support.
- OpenCode configuration changes are not taking effect: wait for any queued refresh to finish. For externally edited project configuration, run `Varro: Restart Server` if Varro manages the server. If you started `opencode serve` yourself, restart it from its terminal.
- Live updates are reconnecting: REST requests still work, but session status can lag until the event stream recovers.
- Session export fails: ensure the OpenCode CLI is installed and `varro.server.command` points to it if the executable is outside `PATH`.
- Server needs a clean reconnect: run `Varro: Restart Server` for a Varro-managed server, or restart a manually managed server from its terminal.
