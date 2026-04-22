# Usage Guide

This guide covers the current Varro workflow inside VS Code.

## Open Varro

- Click the `Varro` icon in the Activity Bar.
- For the best layout, move Varro to the `Secondary Side Bar` so you can keep the editor visible while chatting.

## First Run

Install the OpenCode CLI:

```sh
npm install -g opencode-ai
```

If OpenCode does not have any providers configured yet, log in:

```sh
opencode auth login
```

Varro connects to `http://127.0.0.1:4096` by default and can auto-start the local OpenCode server when the extension activates.

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

When the active file is also attached explicitly, Varro avoids duplicating overlapping line ranges.

## Add Context Manually

Use any of these flows to add more context.

- Right-click a file or folder in Explorer and choose `Varro: Add to Context`.
- With an editor selection, use the editor context menu entry that also appears as `Varro: Add to Context`.
- Select terminal text and run `Varro: Add Terminal Selection to Context`.
- Drag files or folders into the composer.
- Use the composer attachment flow from `/attach`.
- Paste an image into the composer.
- Type `@` in the composer to search for files and agents.

## Sessions

Sessions are filtered to the current workspace directory, then sorted by most recently updated.

- Start a fresh session with `Varro: New Session` or the new chat button.
- Open the session list from the back button in the header.
- Switch between running, attention-needed, and recent sessions.
- Archive sessions from the session list.
- Stop the active run with `Varro: Abort Session`.

If the sidebar is hidden or unfocused, Varro can show VS Code notifications when a background session finishes or when the agent is blocked on a permission or question.

## Composer Behavior

- `Enter` sends the message.
- `Shift+Enter` inserts a newline.
- While a session is running, plain `Enter` queues a follow-up message if you only typed text.
- While a session is running, `Ctrl+Enter` or `Cmd+Enter` sends a steering message with `noReply` enabled.
- Slash commands are available directly in the composer.

Current built-in slash commands include:

- `/new`
- `/sessions`
- `/models`
- `/connect`
- `/attach`
- `/settings`
- `/thinking`
- `/compact`
- `/review`
- `/undo`
- `/abort`

Some commands only appear when they apply. For example, `/undo` only appears when there is an assistant response to revert, and `/abort` only appears while a session is active.

## Models, Agents, and Reasoning

Varro loads agents and models from your local OpenCode configuration.

- Pick the agent from the composer toolbar.
- Pick the provider/model from the model picker.
- Choose a reasoning variant when the selected model exposes variants.
- Open `Manage Models` to hide or show providers and individual models.

The composer can also show two pieces of model metadata:

- Provider limit status, when Varro can read quota information from OpenCode metadata or a supported provider endpoint.
- Context usage, based on token totals from assistant messages and the selected model's context window.

## Permissions and Questions

OpenCode approval flows stay inside the chat UI.

- Permission requests appear inline and can be answered with `Reject`, `Once`, or `Always`.
- Follow-up questions appear inline with selectable options and optional custom input.
- Each session can run in `Default` or `Full access` permission mode.

`Default` allows read-style tools by default and asks for tool calls that can modify state. `Full access` updates the session permission rules and auto-approves pending permission prompts for that session.

## Output in the Chat

Varro renders OpenCode output as structured UI instead of plain text only.

- Streaming assistant messages
- Tool call cards with live status
- Inline permission and question prompts
- Todo tracking from `todowrite` or related todo events
- Diff summaries for changed files
- Session summaries with changed-file counts and line additions/deletions
- Context compaction markers when OpenCode summarizes a session

## Settings

Main extension settings:

- `varro.server.autoStart`
- `varro.server.port`
- `varro.server.command`
- `varro.context.autoAttachFile`
- `varro.context.autoAttachSelection`

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
- Server needs a clean reconnect: run `Varro: Restart Server`.
