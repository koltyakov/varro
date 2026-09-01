# Permissions in Varro

Varro uses OpenCode permissions to control what an agent can do in a session. Choose a mode from the shield menu below the composer. The selected mode applies to that session and its child sessions unless a child has its own selection.

Permission checks happen before an action runs. A tool shown as waiting or running may still be waiting for your response.

## Permission modes

| Mode | Behavior | Good fit |
| --- | --- | --- |
| `Default` | Uses your OpenCode global, project, and agent permission rules. Varro shows any request that OpenCode decides to ask about. | You manage permissions in OpenCode configuration. |
| `Auto-accept edits` | Approves file edits, known read-only actions, and subagent launches. Other actions still ask. | You want edits to proceed but prefer to review commands and external access. |
| `Auto approve` | Approves known safe actions with local rules. Varro can ask a model to review other requests and shows a prompt when it cannot make a safe decision. | You want routine work to continue with a manual fallback. |
| `Full access` | Allows every permission without prompting, including commands, unknown tools, and MCP tools. This mode overrides restrictive agent rules for the session. | You trust the task, instructions, tools, and workspace. |

Changing modes affects pending requests as well as later actions. Switching to `Default` removes Varro's session override and returns control to OpenCode configuration. Switching to `Full access` approves requests that are already waiting.

`Full access` removes the permission checkpoint. Review prompts and repository instructions before selecting it, especially when a session can run shell commands or use third-party MCP tools.

## Manual requests

When OpenCode asks for permission, Varro places the request beside the action that needs it. A standalone prompt appears if that action is not currently visible.

- `Once` approves only the current request.
- `Always` approves the request and remembers matching actions in OpenCode server memory until the
  server restarts. Its menu also offers a session-only rule or a persistent project-config rule.
- `Reject` denies the request.

Read the command, path, URL, or tool details before responding. `Always` can cover later matching actions, so use `Once` when the scope is unclear. Child-session requests appear in the parent conversation, but the permission still belongs to the child.

## How automatic review works

`Auto approve` first checks narrow local rules. These rules cover known read-only operations, safe workspace edits, some read-only shell commands, and exact external-directory scopes you previously approved with `Always`.

If local rules cannot decide, Varro may create a temporary hidden OpenCode session to review the request. The reviewer receives the action details and relevant prior permission decisions. It cannot use tools other than structured output. Its result has three possible effects:

- Approve this request once
- Reject a request that materially matches a prior rejection
- Ask you to decide

An error or timeout also falls back to a manual prompt. Automatic approval never creates an `Always` rule.

You can choose the reviewer model with `varro.chat.autoApproveModel` or from the Models view. If you do not choose one, Varro follows its model fallback order, starting with the project's OpenCode `small_model` when configured and then compatible helper or session models.

Commands, paths, URLs, tool metadata, and prior decisions may be sent to the selected reviewer model. Choose a provider that is appropriate for your code and data.

## Default mode and OpenCode rules

`Default` means OpenCode decides. It does not mean every action asks for approval. Without custom rules, OpenCode allows most permissions, asks about `doom_loop` and `external_directory`, and denies reads of `.env` files and related variants while allowing files such as `.env.example`.

OpenCode supports `allow`, `ask`, and `deny` rules at global, project, and agent scopes. Rules can match tools, shell commands, paths, subagents, URLs, and external directories. OpenCode uses the last matching rule.

See [OpenCode permissions](https://opencode.ai/docs/permissions/) for configuration syntax and examples.

## Session behavior

- New chats use the saved workspace selection, then `varro.chat.defaultPermissionMode`.
- Existing sessions keep their selected mode.
- Child sessions inherit the nearest selected mode in their session tree.
- Forked sessions copy the source session's non-default mode.
- Ralph runs use `Full access` independently of the composer selection.

## If a session is waiting

Look for a permission prompt in the transcript or a `Needs attention` session in the session list. Varro also reports waiting sessions in the VS Code status bar and can show a notification when the view is hidden.

If no prompt is visible:

1. Open the affected root session and check its child-session activity.
2. Confirm the permission mode shown below the composer.
3. Wait for an automatic review to finish. A failed or timed-out review should return to a manual prompt.
4. Run `Varro: Restart Server` only after active work has stopped if the OpenCode connection or configuration is stale.

Do not switch to `Full access` only to clear a stuck request unless you accept unrestricted execution for that session. If changing to `Full access` immediately unblocks it, report the missing prompt as a Varro issue with the session export and OpenCode version when possible.
