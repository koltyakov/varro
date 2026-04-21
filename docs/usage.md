# Usage Guide

This guide covers the user-facing Varro workflow inside VS Code.

## Open the Chat

- Click the **Varro** icon in the Activity Bar
- Or run **Varro: Focus Chat**

Varro works especially well in VS Code's Secondary Side Bar so you can keep the editor visible while chatting.

## First Run

Install the OpenCode CLI:

```sh
npm install -g opencode-ai
```

If your OpenCode setup does not have a provider configured yet, run:

```sh
opencode auth login
```

Varro connects to `http://127.0.0.1:4096` by default and can auto-start the local OpenCode server for you.

## Context Sources

Varro can send more than just the prompt text.

- Active editor file
- Current editor selection
- Diagnostics from the active file
- Selected terminal text
- Files and folders added from the Explorer
- Files found from the chat file picker/search
- Dragged and dropped files or folders
- Pasted image attachments

By default, the active file and current selection are attached automatically.

## Add Context Manually

Use any of these workflows when you want to add more context:

- Right-click files or folders in Explorer and choose **Varro: Add to Context**
- Run **Varro: Add to Context** with an active editor
- Select text in the integrated terminal and run **Varro: Add Terminal Selection to Context**
- Drag files or folders into the chat
- Paste an image into the composer

## Sessions

Varro keeps a session list for the current workspace.

- Start a fresh chat with **Varro: New Session** or the new chat button
- Switch between existing sessions from the session list
- Archive sessions you no longer need
- Stop the current run with **Varro: Abort Session**

If Varro is hidden while a session is running, it can notify you when the session completes or when it is waiting for approval or user input.

## Models, Agents, and Reasoning

Varro loads agents and models from your local OpenCode configuration.

- Pick the agent for the current prompt
- Switch providers and models from the model picker
- Use available reasoning or thinking variants when the selected model supports them
- Hide or show models from the **Manage Models** panel

If no models appear, the most common cause is that OpenCode has no configured provider yet.

## Permissions and Questions

OpenCode tool usage stays in the VS Code flow.

- Permission requests are shown inline with `Reject`, `Once`, and `Always` actions
- Follow-up questions are shown inline with selectable answers and optional custom input
- The composer also supports session permission modes so you can choose a stricter or looser approval flow for a session

## Results in the Editor

Varro surfaces agent output in ways that fit the editor workflow.

- Message streaming in the sidebar chat
- Diff summaries for changed files
- Open file and VS Code diff actions
- Todo progress when the active agent emits a task list
- Session summaries with changed-file counts and line additions/deletions

## Settings

Varro adds these main settings:

- `varro.server.autoStart`
- `varro.server.port`
- `varro.server.command`
- `varro.context.autoAttachFile`
- `varro.context.autoAttachSelection`

## Troubleshooting

- OpenCode CLI missing: install it with `npm install -g opencode-ai`
- CLI not on `PATH`: set `varro.server.command`
- OpenCode already running elsewhere: set `varro.server.port` and optionally disable `varro.server.autoStart`
- Server needs a clean reconnect: run **Varro: Restart Server**
- No models available: run `opencode auth login`, then restart Varro if needed
