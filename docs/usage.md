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

Varro connects to `http://127.0.0.1:4096` by default. It does not start OpenCode at extension activation time. Instead, it starts or attaches to the server the first time the chat view needs it.

## What Varro Sends As Context

Varro can include more than the text in the composer.

- Workspace path, sent as `[Working directory: ...]`
- Active file, when `varro.context.autoAttachFile` is enabled
- Current selection, when `varro.context.autoAttachSelection` is enabled
- Diagnostics from the active file
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
- Select terminal text and run `Varro: Add Terminal Selection to Context`.
- Drag files or folders into the composer.
- Use the composer attachment flow from `/attach`.
- Paste an image into the composer.
- Type `@path/to/file` to search workspace files.
- Type `@agent-name` to mention an available agent.

## Composer Behavior

- `Enter` sends the message.
- `Shift+Enter` inserts a newline.
- While a session is running, plain `Enter` queues a follow-up message if you only typed text.
- While a session is running, `Ctrl+Enter` or `Cmd+Enter` sends a steering message with `noReply` enabled.
- While a session is running, the send menu also exposes `Add to Queue`, `Steer with Message`, and `Stop and Send`.
- `ArrowUp` and `ArrowDown` can step through previous user prompts when the composer is empty.
- `Tab` accepts the highlighted slash-command or mention completion.
- Slash commands are available directly in the composer.

Current built-in slash commands include:

- `/new`
- `/sessions`
- `/models`
- `/mcps`
- `/connect`
- `/attach`
- `/settings` opens VS Code Settings filtered to Varro
- `/thinking`
- `/compact`
- `/review`
- `/undo`
- `/abort`

Some commands only appear when they apply. For example, `/undo` only appears when there is an assistant response to revert, and `/abort` only appears while a session is active.

## Sessions

Sessions are filtered to the current workspace directory, then sorted by most recently updated.

- Start a fresh session with `Varro: New Session` or the new chat button.
- Open the session list from the back button in the header.
- Search sessions by title, session ID, or workspace directory.
- Filter or jump to `Running`, `Needs attention`, `Failed`, `Plan ready`, and `Completed` sessions from the header badges.
- Open sub-agent sessions from the parent session row when they exist.
- Archive sessions from the session list.
- Stop the active run with `Varro: Abort Session`.

On large layouts, Varro can keep a persistent session pane beside the chat. Use `varro.chat.desktopSessionPaneSide` to choose whether that pane appears on the left or right.

If the sidebar is hidden, Varro can show VS Code notifications when a background session finishes or when the agent is blocked on a permission or question. It also exposes a status bar item that summarizes waiting or completed sessions.

If VS Code reloads while a session was running, Varro reconnects to those sessions and can continue interrupted work automatically when the session is still resumable.

## Plans And Reviews

- `/review` sends a review prompt for the current workspace changes.
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

## Permissions And Questions

OpenCode approval flows stay inside the chat UI.

- Permission requests appear inline and can be answered with `Reject`, `Once`, or `Always`.
- Follow-up questions appear inline with selectable options and optional custom input.
- Each session can run in `Default` or `Full access` permission mode.

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

## VS Code Commands And Keybindings

- `Varro: New Session`
- `Varro: Abort Session`
- `Varro: Restart Server`
- `Varro: Add to Context` from Explorer, or `Cmd+Shift+K` / `Ctrl+Shift+K` while the editor is focused
- `Varro: Add to Context` from the editor selection context menu
- `Varro: Add Terminal Selection to Context` from the terminal context menu, or `Cmd+Shift+K` / `Ctrl+Shift+K` while the terminal is focused

## Settings

Server:

- `varro.server.autoStart` — auto-start `opencode serve` when Varro first needs it
- `varro.server.port` — port used for the local OpenCode server (default `4096`)
- `varro.server.command` — optional path to the OpenCode CLI executable

Context:

- `varro.context.autoAttachFile` — include the active editor file in live context
- `varro.context.autoAttachSelection` — include the current editor selection in live context

Chat view:

- `varro.chat.expandThinkingByDefault` — expand reasoning/thinking blocks by default
- `varro.chat.showStickyUserPrompt` — show a sticky preview of the latest user prompt while scrolling long assistant responses
- `varro.chat.desktopSessionPaneSide` — on large screens, show the sessions pane on the `left` or `right`

There are also hidden debug settings used in development builds:

- `varro.debug.simulateMissingCli`
- `varro.debug.simulateNoProviders`

## Troubleshooting

- OpenCode CLI missing: install it with `npm install -g opencode-ai`.
- CLI not on `PATH`: set `varro.server.command` to the executable path.
- OpenCode already running on another port: update `varro.server.port` and optionally disable `varro.server.autoStart`.
- No models available: run `opencode auth login` and reopen Varro.
- Provider badge missing: quota metadata is only shown when OpenCode or the provider exposes usable limit information.
- Images do not send: select a model with vision support.
- Live updates are reconnecting: REST requests still work, but session status can lag until the event stream recovers.
- Server needs a clean reconnect: run `Varro: Restart Server`.
