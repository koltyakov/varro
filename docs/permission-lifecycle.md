# Permission Lifecycle And Safety

This document defines the engineering contract for OpenCode permission handling in Varro. Read it
before changing permission modes, permission rules, automatic judging, session ancestry, pending
request snapshots, attention indicators, prompt grouping, or permission responses.

The primary invariant is:

> A permission request that is still pending in OpenCode must never lose both its automatic owner
> with a recovery path and its actionable user fallback.

A tool shown as `running` may be blocked before execution on a permission request. Tool state is not
proof that the command started, and hiding a prompt is not the same as resolving its request.

## Mode Semantics

The protocol values are `default`, `auto`, and `full`. The UI labels them `Default`, `Auto approve`,
and `Full access`.

| Mode | OpenCode session rules | Varro behavior for an ask |
| --- | --- | --- |
| `default` | No Varro session override; use OpenCode configuration and agent rules | Reply once to `todowrite` and `question` asks; show other asks as actionable prompts |
| `auto` | Ask by default with known read-only and subagent-launch allowances | Hide briefly while Varro judges; reply or fall back to a prompt |
| `full` | Allow every permission, including unknown permission names | Reply `once` to any already-pending request and resync |

`Default` is the OpenCode-managed mode. New sessions omit a session-level permission override, and
switching an existing session to default clears Varro's prior mode rules. OpenCode's global, project,
and agent configuration determines whether an action is allowed, denied, or asked. If OpenCode asks
about `todowrite` or `question`, Varro replies once without installing a broader session rule.

Ordinary sends in Default mode preserve existing session rules, including session-scoped `Always`
approvals. Only an explicit mode change resets those rules. Sending an empty rule set is a no-op on
v1's append-style API but clears saved approvals on v2's replacement API.

`Auto` is not a broader OpenCode rule set. OpenCode must still emit an ask so Varro has a
specific request ID and complete action context to judge. Giving `auto` allow-all rules would bypass
the judge and silently turn it into `full`.

`Full access` is not automatic judging. It deliberately changes the session rules to allow all and
answers requests that were already queued before the rule update. It must remain an explicit user or
workflow choice.

### Rule Ordering

OpenCode uses the last matching permission rule.

- Default contributes no Varro session rules; OpenCode configuration and selected-agent rules remain
  in control. Varro handles `todowrite` and `question` asks directly without replacing that policy.
- Auto rules start with `* -> ask`, then place known read-only allowances after it.
- Current direct allowances are read-only permissions (`read`, `glob`, `grep`, `list`, `codesearch`,
  and `lsp`), `todowrite`, which only updates the session task list, `question`, which asks the user
  for input, plus `task`, which only launches a child whose actions remain permission-checked.
- Mutating, executable, and external permissions remain `ask` in auto mode. Interactive `question`
  requests are directly allowed because the question itself still requires user input. These two
  direct allowances also apply in Default mode.
- Full rules end with `* -> allow`, so they override earlier agent restrictions and cover permission
  names introduced by OpenCode or an MCP tool.
- Unknown permission names follow OpenCode configuration in default, ask in auto, and allow in full.

Keep these ordering properties when adding permission names. Do not replace the final wildcard with
an enumeration that can become incomplete after an OpenCode upgrade.

The canonical implementation is `src/shared/permission-rules.ts`; webview code re-exports it rather
than maintaining another rule set.

## Effective Mode And Session Trees

Permission requests belong to the session that emitted them. Keep a child or grandchild request's
own `sessionID` and permission ID in state even when its prompt is displayed in the root session's
transcript. The current OpenCode reply route is addressed by permission ID alone, but session
ownership still controls mode inheritance, grouping, decision history, and UI placement.

Effective mode resolution follows these rules:

- A session with a valid `metadata.varro.permissionMode` uses that explicit mode. Session reads and
  updates restore it in every extension instance, overriding local selections without inferring a mode
  from permission rules. Reading metadata does not patch the session or advance its timestamp.
- Sessions without valid mode metadata retain their legacy local selection, if present.
- Otherwise, a child recursively inherits its parent's effective mode.
- A root without a stored mode falls back to `default`.
- A new-chat draft uses the workspace-specific saved draft mode, then the configured default.
  The configured default is the user-level `varro.permissions.defaultMode`. A workspace or folder
  value applies only when it is stricter (`default` before `auto` before `full`), so a repository
  cannot start new chats in a more permissive mode than the user chose.
- A fork is a new root, so Varro saves the source session's effective non-default mode in the fork's metadata
  and local session-mode storage. This metadata update does not append permission rules.
- Prompts and attention are scoped to the complete session tree, not just the active root ID.

Permission events can arrive before a new sub-session appears in the local session list. In that
case, load the complete ancestry before deciding the mode. Keep the request pending during the load.
If ancestry loading fails, reveal the request instead of guessing `default`, `auto`, or `full` and
hiding it.

Do not reparent a child request to the root in local state. The response client currently ignores its
`sessionId` argument and posts to `/permission/{permissionId}/reply`, but callers should continue to
carry the owning session so surrounding behavior remains correct if the route contract changes.

## Request Lifecycle

The extension host and webview independently track blocking requests. This is intentional: the host
owns persistence, hidden-sidebar notifications, and status-bar attention, while the webview owns
inline prompts and automatic handling.

The normal lifecycle is:

1. OpenCode queues a request and emits `permission.asked`, `permission.v2.asked`, or the legacy
   `permission.updated` event.
2. Both layers normalize the payload and retain the request ID and owning session ID.
3. The webview resolves the effective mode for the request's session tree.
4. Default reveals it, auto starts a bounded judge attempt, and full starts an automatic `once`
   response.
5. Varro sends `once`, `always`, or `reject` to OpenCode's permission reply route.
6. Local UI is removed only after the reply is acknowledged, an authoritative reply event arrives,
   or a race-safe pending snapshot proves that the request no longer exists.
7. `permission.replied` or `permission.v2.replied` clears host attention and any remaining webview
   state.

Questions use the same acknowledgement rule. Submitting an answer or rejection immediately puts the
owning conversation in a non-terminal transition state. A failed request rolls that state back; an
accepted request keeps it until an authoritative busy, idle, or error update arrives.
The gap between removing the question and receiving continuation status must not be classified as a
completed or plan-ready turn. Resolved request IDs remain tombstoned for the current workspace so a
stale pending snapshot cannot restore the prompt; only a new explicit ask event may reuse the ID.

Initial webview state includes persisted pending requests so reload does not strand a session.
`GET /permission` reconciles event state after connection, reload, and mode changes. Both snapshot
reconcilers use generations and mutation tracking so an older request cannot overwrite an ask or
reply event that occurred while it was loading.

Support all currently accepted request ID fields (`id`, `permissionID`, and `requestID`) and both
plain and v2 `properties.info` wrappers. Do not update only one event shape.

### Multi-Webview Ownership

Permission events and snapshots are routed to webviews in the same workspace. Only one ready
webview per workspace may run automatic permission work. The extension host elects those endpoints
and publishes owner flags with a shared generation lease. A ready sidebar is preferred in its
workspace; otherwise, the current ready owner or the next ready editor owns automation there.

A session belongs to the workspace whose directory matches it exactly, or else to the open root
whose session catalog authorizes it: nested folders under `descendants`, project worktrees under
`project`, and conversations moved out of an open folder. Owner lookup, lease validation, pending
snapshots, and host attention (notifications, badge, status bar) must all use that same catalog
root. A path-containment check alone is not enough, because it misses worktrees outside the folder
and ignores the configured history scope. An exact open root wins over a catalog root that also
contains the session, as with nested roots. Moving one conversation must not revoke another moved
conversation's verified transfer. A subagent child inherits its nearest authorized ancestor's catalog
root only while its own recorded location is that ancestor's exact directory and the root is open,
so a moved conversation's subagent prompts reach the same view as the conversation's own. A pending
snapshot that cannot conclusively resolve such a child's ancestry is rejected rather than read as
resolution. A view that receives a question for a session it has not loaded loads every session row
through the root, even when a saved permission mode already settles that session's permission
handling, so the prompt joins the conversation tree. Transcript events
for a non-exact session follow the same catalog root as its attention; a moved root's own events
keep the retained-transfer route to every view that lists the link. A transfer is verified through the open folder it moved out of,
never another open root; concurrent verifications share one canonical lookup, and a confirmed
mismatch is not retried for a minute. After a full catalog invalidation or reload, an attention
event for a visible retained link re-verifies it before routing, and the pending snapshot
re-verifies every unverified visible link for its folder so a request asked before the reload is
not stranded. Automatic re-verification goes only through a folder whose link is still visible.
A verification that fails for an uncertain reason, including malformed data or a missing origin
location, rejects the snapshot rather than letting the omission read as resolution; only a missing
canonical session or a well-formed project or directory mismatch is a confirmed mismatch. A
conversation linked from several open roots is verified through the first one still showing the
link, so exactly one root owns it. A session whose directory is itself an open root belongs to that
root even when a parent root's catalog also contains it. A catalog load or
snapshot whose catalog generation changed while loading publishes no authorization. Overlapping
catalogs resolve a session to the earlier open root, and live attention for a non-exact session
goes only to views of its catalog root. An attention ask whose routing waited on verification is
dropped if the host has already seen its reply. Changing the selected folder keeps host state for
sessions whose catalog root is still open.

- Only the elected owner for a workspace may run the model judge, answer full-mode requests, or
  automatically process that workspace's pending-permission snapshot. This also applies to direct
  `todowrite` and `question` replies in every mode.
- Automatic judge and reply API requests carry the lease they started under. The host rejects a
  request when that endpoint no longer owns the matching lease.
- A rejected automatic reply lease is an ownership handoff, not a chat-wide error. Keep the request
  pending and preserve fallback handling so the current owner can reconcile and answer it. Other
  reply failures still surface errors.
- Manual permission replies do not use the automation lease.
- A non-owner keeps the request visible and posts `permission/reveal`. The host makes attention
  actionable and notifies the current owner so it can reconcile the pending snapshot.
- Losing ownership must not remove the visible fallback. A late automatic decision still needs a
  current lease before its reply can reach OpenCode.
- An owner whose lease rotates without losing ownership reconciles its pending snapshot again, so
  replies rejected under the old lease are retried with the new one.
- A full-access reply that fails while the session stays in full access follows the bounded retry
  described under full mode below. An automatic reply that fails after its hidden judge attempt
  was superseded triggers a fresh snapshot instead of being dropped.
- Interrupted-session recovery is claimed by one elected endpoint, not by every webview that loads.

The lease check belongs in the extension host, not only in webview state. Multiple runtimes can be
alive during editor visibility changes, and a stale runtime cannot be trusted to stop before an
in-flight callback sends its reply.

### Authoritative Resolution

The following can prove a request is resolved:

- The permission reply request completed successfully.
- A matching permission replied event arrived.
- A current pending-permission snapshot omitted the request and no newer local mutation conflicts
  with that snapshot.
- The reply route returned the exact route-specific `404 permission request not found` result, which
  means another actor already resolved it.

The following do not prove resolution:

- A judge returned `allow` or `reject`.
- A response request was started.
- A local attempt was marked `responded` for deduplication.
- A prompt was hidden or removed from a grouped prompt.
- The tool card says `running`, `completed`, or has stale output.
- The session switched modes.

Manual and auto-judge paths must never remove an actionable prompt before awaiting the remote
response. If the response fails or times out, preserve or restore the prompt and surface the error.
If the prompt had already become visible while a judge was running, it stays visible until OpenCode
acknowledges the late automatic decision.

Initial transcript hydration is the only presentation deferral: while `messagesLoading` is true, keep
permission and question requests in state but do not mount their standalone or inline prompts, even
when a question has no tool link. Both successful and failed session loads must clear that bounded gate
so the prompt appears with the loaded transcript
or returns as the actionable fallback. Permission prompts mount at their final placement without an
entrance animation; do not reintroduce a standalone-to-inline transition during session loading. Defer
the initial bottom scroll through the same gate so prompt height is part of the first settled placement,
not later growth that looks like a newly arrived request.

Permission-linked tools remain visible. Within a contiguous assistant activity run, render completed
activity first, then every permission-linked tool with the pending status and the same static wait icon
used for a subagent blocked on permission; do not present queued tools as actively running. Render only
the front actionable prompt after the owning assistant response's activity, so completed concurrent
parts do not appear below the waiting tools or permission block. Preserve prose and other non-activity
boundaries. A standalone prompt remains the fallback when its owning tool is unavailable, intentionally
hidden, or outside the mounted virtual range.

After a user rejects a permission, OpenCode may complete the assistant message with `finish:
tool-calls` and place `The user rejected permission to use this specific tool call.` on an error-state
tool part. Keep that tool card outside compact activity and label it `rejected`. The rejected tool
does not prove the turn stopped: suppress its terminal summary while the session is working, then
summarize the eventual final response normally. For idle rejection-only histories, retain the
`Permission rejected` terminal summary. Generic command-level `permission denied` errors must not
be classified as user rejection.

Varro-managed servers default `experimental.continue_loop_on_deny` to `true` in their temporary
runtime config. On V1, OpenCode returns the denied tool result to the model and continues its
existing loop. V2 lists that key as an unsupported legacy setting and ignores it; rejection and
continuation follow the V2 server's behavior. In either case, Varro must not approve the tool,
abort/restart the turn, or submit a synthetic user message to resume it. OpenCode also rejects other
pending permissions in the same owning session when one is rejected.

Because the loop continues, session prompt guidance is the only thing that stops the model from
working around a plain rejection on its own. By default it tells the agent never to retry the denied
action or reach the same result through another tool, command, or subagent on its own initiative.
If the rejection feedback or a later user message asks for a different approach, the agent follows
it as a new instruction, and that alternative still needs its own permission. The agent asks when it
is unclear whether an alternative is allowed, keeps doing independent permitted work, and explains
the blocker when the task needs the denied action. Rejection feedback reaches the model as the
rejected tool result (see `Reject with instructions` under Manual Approval), so the guidance
refers to it directly.

`varro.permissions.onReject` selects `default`, `custom` (text from
`varro.permissions.onRejectCustom`), or `off`. Both settings are application-scoped and read only
from user settings, so repository workspace settings cannot inject or remove system prompt text.
Empty custom text falls back to the default. `off` omits only this paragraph: the workspace scope,
citation, and selected-agent guidance stay in place, and empty parts are dropped rather than
leaving blank sections. OpenCode enforces permissions in every mode; with `off`, the model may
try alternatives that each need approval.

Project and inline OpenCode config can override this default. Caller-provided `OPENCODE_CONFIG`
remains untouched and skips Varro's injection; externally managed servers require their own setting.
Existing servers must reload runtime config before the default takes effect. Never restart a server
inside a permission-response transaction.

Skipping a question similarly completes its tool with `QuestionRejectedError` and
`The user dismissed this question`. On V1, the continuation setting also applies to skipped questions.
Label the question tool with a compact `Question skipped` summary instead of generic input/error
JSON. Render the terminal turn summary with `Question skipped` only for idle skip-only histories;
other question failures remain generic failures.

An actionable survey replaces its question tool card. Linked requests render only the inline form;
standalone requests also suppress pending or running question cards in their owning session, without
duplicating the form inline. Completed question summaries and tools from other sessions stay visible.

Full mode keeps a failed reply hidden while the mode remains `full`: it surfaces an error and
retries through fresh pending snapshots after 1, 4, and 15 seconds; a failed snapshot read counts
as an attempt. Only after the last retry fails does the request become a visible prompt, so a
persistent failure never leaves a tool call waiting with nothing to act on. That fallback stays
visible on later snapshots until a reply or an authoritative omission resolves it. Do not copy the
hidden retry phase into default or auto mode.

## Manual Approval

Default mode presents `Reject`, `Once`, and an `Always` scope menu.
The `Allow always` button only opens the menu; it has no default or remembered scope.
On V1, choosing a scope immediately submits that approval. On V2, session, project, and global
choices open a resource-pattern review prefilled from the request's `always` suggestions. V2 WebFetch
reviews instead use the requested URL resources, falling back to the metadata URL when needed, so a
wildcard save suggestion does not default to allowing every URL. Same-ID request refreshes must retain
the review scope, draft, focus, and command expansion; only a different request ID resets them. The user
may edit those patterns, keep them unchanged, or cancel without resolving the request. Saving requires
explicit confirmation. The review replaces the ordinary action row with Cancel and Save & allow;
cancelling restores the original actions without sending a permission reply.
Patterns are bounded to 1-50 nonempty strings of at most 2000 characters each.
The server still verifies the pending request ID, owning session, directory, and action. Only the
patterns may come from manual review; execution input and the displayed command never change.
Dismissing the menu leaves the request pending. V2's native standing approval is durable, not temporary.

Session and project approval routes authorize the permission-owning session's directory before
applying workspace guards. They may target another open root or an authorized catalog directory
without activating that workspace in the chat view. Both routes must verify the pending permission
ID and owning session against the server before changing rules.

- `Allow once` (short form `Once`) approves the specific request.
- `Allow always` > `For this session` adds the request's server-provided `always` patterns to that
  session's permission rules, then replies `once` to the pending request so the approval does not
  enter server-wide memory.
- `Until server restart` is available only on V1 and sends OpenCode's `always` response. The resulting
  rules apply to matching requests across sessions in that server instance until OpenCode restarts.
  V2's `always` response instead creates durable project-scoped database approvals, so V2 must not
  offer this temporary scope.
- `For this project` first persists the request's server-provided `always` patterns in
  project OpenCode configuration, then replies `once` on V2. The config is the only standing grant;
  deleting it must not leave a database approval behind. V1 still sends `always` for the current
  runtime. The config write must not call OpenCode's config-update route, dispose an instance, or
   restart the server. Never derive or broaden project rules from webview display metadata.
- V2 manual review may replace the suggested session/project patterns explicitly. Global approval
  writes the reviewed patterns to global OpenCode config and replies `once`, never `always` or a
  saved-permission PATCH. It requires V2 and a locally managed connection. Attach-only connections
  cannot edit host files. Global config edits preserve unrelated settings and comments, serialize by
  canonical file path across windows, and reject dirty documents and concurrent file changes.
  Native permission-array edits preserve existing entry formatting and comments where possible;
  appended entries follow the existing compact or multiline style instead of reserializing the array.
  The Permissions screen edits/removes global config rules independently of project, session, and
  database approvals. Config changes take effect when OpenCode next loads the configuration; saving
  must not restart or dispose the active instance.
- New V2 permission settings use the native `permissions` array with `action`, `resource`, and `effect`
  fields, including writes from the Permissions screen. Preserve existing legacy `permission` settings
  rather than implicitly migrating them. Legacy project config follows OpenCode's `PermissionConfig`
  shape. A top-level scalar action represents
  the `*` permission and `*` pattern and must remain effective when adding a narrower rule.
  `todowrite`, `question`, `webfetch`, `websearch`, and `doom_loop` accept only scalar actions inside
  the permission object; never serialize pattern maps for those names or broaden a non-wildcard
   standing scope to make it fit.
  These scalar-only restrictions apply only to legacy config syntax. Native V2 permission arrays
  support resource patterns for these actions, including URL-specific WebFetch rules.
- Varro's managed server-memory layer contains only entries linked to a successful `always` reply it
   observed. V2 also shows other native saved rows separately as `Other saved approvals`, with origin
   explicitly unknown. Listing them must not adopt them as observed user approvals or enable editing;
   they may include internal or other-client allowances. Explicit removal requires a confirmation in
   that separate section. Native saved IDs preserve the observed link when another client edits the
   action/resource scope. Confirmed native
   IDs are stored in workspace state, scoped by server address, API version, and project, so host reloads
   retain the management link. Capture these IDs after successful approval even when the Permissions
   screen is closed. Reconcile restored IDs against the native list and discard removed entries; a
   new ID with the same scope is not proof of user approval. Legacy process-only observations are not
   persisted. OpenCode's
   saved-permission endpoint can also return internal allowances that the user did not add; those belong
   only in the separate origin-unknown section, not the observed user-managed layer. Legacy OpenCode
   permission replies keep `always` rules in an
  internal instance-local array with no list or removal endpoint. Varro mirrors those replies from
  their authoritative request scopes so the layer remains visible; those entries require an OpenCode
  restart to clear.
- In auto mode, a successful `Always` response rechecks other visible requests in the same
  conversation tree so requests that were already judged can use the new preference.
- `Reject` denies the request.
- `Reject with instructions` sends `reject` with trimmed, nonempty feedback in `message` for every
  represented group member. The form replaces the action row like the standing-approval review;
  Cancel sends no reply. V1 wraps the feedback in its own rejection error. V2 passes `message` to the
  model verbatim, so the adapter prefixes V1's `The user rejected permission to use this specific
  tool call with the following feedback:` wording to keep the tool classified as rejected after
  reload. Automatic replies never carry feedback.

The Permissions screen must preserve these scopes as independent layers. Project edits write only to
the workspace config. Session edits patch only `Session.permission` and serialize with permission-mode
updates; changing mode may replace those rules. Saved server-memory permissions use OpenCode's
saved-permission list and remove endpoints when the server supports them. Removing one must not alter
project or session rules. Servers without those endpoints report the layer as unavailable rather than
blocking the rest of the screen.

V2 labels these database approvals as persistent, not `Until restart`. Host recreation, a changed
connection address, or a failed native-ID capture must not hide approvals returned by a fresh native
list; only their observed/untracked classification may change. The panel refreshes on reconnect and
offers a saved-layer-only Refresh action that preserves unsaved project and session drafts.

All saved-layer mutations require a fresh, validated native list for the selected project and the same
server connection. Cached observations may be displayed with an explicit stale warning, but must not
authorize edits or removals. A removal is confirmed only after the native list proves that exact ID is
absent. A failed or malformed verification keeps the tracking link and reports the uncertainty; an
empty filtered observed layer alone is not proof of removal. No saved-layer operation changes config,
session rules, pending permissions, or server credentials, and none requires a server restart.

On servers advertising saved-permission PATCH support, the same layer can edit
its action/resource patterns. The host validates the owning project and managed
rule ID, waits for the confirmed update, replaces the tracked scope, and refreshes
the list. Saved rules remain allowances, not editable allow/ask/deny effects.
Legacy restart-only entries remain non-editable. Conflicts and request failures
retain the draft and do not replace project/session rules or resolve pending asks.

- A failed response must leave the user with an actionable retry.
- A successful response records a bounded decision reference for later auto-judge context across the
  same root conversation and its child sessions.
- Rejection references apply only within the current root user-message turn. A new root user message
  starts fresh review without the previous turn's rejections; it does not grant permission or clear
  configured deny rules. Once and Always references retain their existing conversation scope. Root
  user-message events from another view must advance this boundary even when the conversation is not
  active locally. Child launch prompts, unrelated conversations, and stale message updates do not
  advance it. Capture the turn before awaiting a manual reply so a delayed acknowledgement cannot
  attach an old rejection to a new turn. A late automatic rejection from an earlier turn reveals the
  pending request for manual approval instead of denying it.

Equivalent pending requests may be grouped for display. Group identity includes type, pattern,
session ID, title, and metadata, so requests from different sessions are not grouped together.

- `Once` removes only the answered group member and leaves later members actionable.
- `Reject` explicitly responds to every member represented by the grouped prompt.
- Server-memory and V1 project scopes send `always` for the displayed group leader, then remove the
  matching group after OpenCode accepts the standing response. They do not explicitly reply to every
  represented ID. V2 project approval replies `once` after persisting config and removes only that
  answered member; other already-pending requests remain actionable until acknowledged.
- Reconciliation and reply events must preserve every underlying request ID, not only the displayed
  leader ID.

## Automatic Judging

Auto mode applies configured V2 shell rules first, then local rules, the one decision reviewer
selected by `varro.permissions.decisionModel`, and the chat-model judge.

On V2, configured native shell rules are checked before local rules. Every concrete resource in
the request must resolve to an explicit configured `allow` to bypass the judge; the request's save
suggestions and command display metadata cannot supply that evidence. Last-match ordering preserves
later `ask` exceptions to configured allowances and configured `deny` rules, which return manual review
or rejection respectively. An unconfigured resource or an ordinary ask-by-default policy continues
through normal Auto review. Configuration reads use the permission-owning workspace,
have a bounded timeout, and are not verdict-cached. Failed reads reveal the request.
JSONC comments are preserved as documentation, not interpreted as permission instructions.

Native project and global standing approvals skip exact or provably narrower patterns already allowed
in the target file, including covered parts of compound requests. A later potentially overlapping ask
or deny prevents deduplication. Existing entries, ordering, and comments remain intact; a fully redundant
save does not rewrite the file. Uncertain wildcard containment is kept rather than silently skipped.

### Local Rules

The extension host first applies narrow deterministic rules. The current local policy allows:

- Known read-only permissions as a defensive fallback if OpenCode emits an ask despite the session
  rules
- Session task-list updates through `todowrite`
- Interactive user prompts through `question`
- OpenCode `task` subagent launches as the same defensive fallback; delegated actions remain subject
  to the child session's inherited permission mode
- `websearch`; URL-targeted `webfetch` requests continue to the model judge or manual approval
- Workspace-contained edits when the permission-owning session directory is inside a Git work tree,
  all canonicalized paths remain inside that workspace, and no file is being deleted
- Strict read-only shell commands, including workspace-contained file inspection, exact tool-version
  probes, safe Git inspection, and basic identity or environment checks
- External-directory access only when every canonicalized requested path is contained by an exact
  external-directory scope that the user previously approved with `Always` in the same conversation
  tree

The workspace used for local rules and verdict caching comes from the permission-owning session, not
the active editor or a webview-supplied path. Git membership is checked with a bounded, shell-free
probe whose inherited `GIT_*` environment is removed. A missing directory, non-work-tree, failed
probe, malformed path, or ambiguous command falls through to model or manual judgment rather than
being locally approved.

Shell parsing deliberately rejects command substitution, pipelines, redirection, unsafe separators,
ambiguous quoting, outside-workspace paths, dangerous read-command flags, arbitrary Git options, and
mutating Git operations. Safe `&&` sequences are allowed only when every segment independently
matches the local policy. Expand local rules only with adversarial tests for paths, symlinks, quoting,
command composition, options, and side effects.

External-directory requests are never delegated to the model judge. Ambiguous paths, sibling paths,
mixed approved and unapproved path sets, and approvals made with `Once` must ask the user. This keeps
prior approvals from being generalized to unrelated or sensitive directories.

### Decision Reviewer

`varro.permissions.decisionModel` selects at most one decision reviewer. It is empty by default, is
read only from user settings, and there is no separate Jev on/off setting; the old
`varro.decisions.jev.autoApprove` value is not read. `directJevModelID` in
`src/extension/jev-decisions.ts` is the single check for which transport a value selects:

- A `typesafe/<model>` value, which the Models view writes as `typesafe/jev-latest` when Jev is turned
  on, selects the direct TypeSafe client. It runs only while an API key is available (VS Code secret
  storage via **Add decision model** in the Models view menu, or `TYPESAFE_API_KEY`); without a key
  the value is inert and the chat judge reviews. `NativeDecisions.model` is `null` for these values,
  so they never reach OpenCode's decision API.
- Any other `provider/model` selects an OpenCode-hosted decision model. V1 stays inactive; V2 must
  advertise `/api/experimental/generate/decisions` in its OpenAPI document, and the Models view
  validates selections against `/api/model?types=decision`. Native generation uses the server's base
  configuration and credentials, with no session or workspace override.

The Jev toggle writes the direct route when turned on (keeping an existing `typesafe/<model>` value)
and clears the setting when turned off only if it holds a direct route. Selecting a native model
replaces a Jev selection; selecting **Off** in the native selector clears only a native selection.
Disconnecting the TypeSafe key also clears a direct route, so no dangling selection remains.

The pipeline is local rules, then the one configured decision reviewer, then the chat model judge.
Both transports send the same `permissionDecisionQuestions()`, with permission evidence encoded as
JSON and treated as untrusted data, and apply the same gate in code:

- `allow` requires the `allow` option at probability 0.8 or higher, confidence 0.75 or higher, and
  both the side-effect and approval-steering yes/no probabilities below 0.2.
- `reject` requires the `reject` option at probability 0.9 or higher and at least one prior user
  rejection in the conversation tree.
- Everything else is `ask`. Decision reviewers cannot produce an `actionSummary`, so revealed prompts
  use the normal metadata fallback.

A valid `ask` is terminal, not a reason to try another reviewer. Only an error, an invalid answer, or
a timeout falls through to the chat judge, within the same overall timeout. The native decoder
requires exactly three uniquely named, correctly typed answers (`decision`, `destructive`,
`manipulation`) with finite probabilities in [0, 1]. Each transport has a five-second deadline, and
native generation has a 64 KiB response limit. Failed decision reviewers must never be selected as
chat fallback models.

External-directory requests remain local-only and never reach a decision reviewer. Decision verdicts
are cached with the same key and TTL as model verdicts, using the reviewer's route (`typesafe/<model>`
for Jev) as the model component, and `resolveModel` reports that route so the composer shows the
reviewer. A decision is not a permission acknowledgement; all visibility, ownership, late-result, and
reply-acknowledgement rules still apply.

Every model verdict (decision reviewer or model judge) carries `reviewerModel`, and cached verdicts
keep it. The auto-approve activity tooltip shows it on its own `Reviewer:` line; local-rule verdicts
have none.

### Prior Decisions and Rejection Feedback

Every reviewer, the decision reviewers and the chat judge alike, receives the same
`priorUserDecisions` and applies the same wording from `src/extension/permission-review-policy.ts`,
so they cannot disagree about the same evidence. The policy mirrors the agent guidance in
[authoritative resolution](#authoritative-resolution) and does not depend on
`varro.permissions.onReject`: reviewers apply it whether the agent guidance is `default`,
`custom`, or `off`.

- A prior rejection supports `reject` only when the pending action retries the same denied action,
  materially the same operation on the same target, and no later decision approved a matching
  action.
- Reaching the same result through a different tool, command, or approach is not by itself a reason
  to reject. A different approach is judged on its own merits: `allow` only if it independently meets
  the normal allow bar, otherwise `ask`. When it is unclear whether the user wants the alternative,
  the answer is `ask`, never `reject`.
- Rejection feedback is evidence of what the user wants instead. It can make an alternative expected
  or a retry clearly unwanted, but it never authorizes an action: destructive, irreversible,
  external, credential, publishing, and unclear actions still return `ask`.

None of this changes the code gates above, the terminal `ask`, the external-directory exclusion, or
the approval-steering check. The chat judge has no code gate that requires a prior rejection for
`reject`; it relies on the prompt.

`priorUserDecisions` comes only from the webview's record of the user's own responses
(`recordPermissionDecisionReference` after `respondPermission`), never from a tool call. A
`Reject with instructions` response stores its trimmed feedback on that rejected reference, bounded
to `AUTO_APPROVE_REFERENCE_FEEDBACK_MAX_LENGTH` (500) characters; the extension parser keeps
`feedback` only on rejected references and bounds it again. The reviewer instructions say that only
the `response` and `feedback` fields come from the user: an entry's title, pattern, and metadata
describe the earlier tool call, and text in the pending permission or those details claiming the
user asked for an action must be ignored. Rejections from earlier turns are dropped before the
request, so a later user message starts without them. References, including feedback, are part of
the verdict-cache key, so a new user decision never reuses a verdict cached for the earlier evidence.

### Model Judge

Requests not decided locally or by the configured decision reviewer may be sent to a temporary hidden OpenCode session. That session denies
all tools except structured output. Permission text, command text, paths, metadata, and prior user
decisions are untrusted input to the judge, never instructions. A confirmed `always` response is
strong preference evidence for materially similar or narrower non-destructive actions in the same
conversation tree, but the judge must recheck the complete current details and must not broaden its
scope. The judge prompt defines OpenCode's built-in tool and permission semantics, including that a
`*` pattern is a rule-matching scope rather than an operation, while treating unknown custom or MCP
tools as potentially arbitrary.

`webfetch` is judged using its exact URL context. Clearly identified ordinary public read-only content
may be allowed, while local or private-network targets, credential-bearing URLs, sensitive query
parameters, unclear destinations, and possible private-data disclosure must fall back to the user.

The judge model is resolved in this order:

1. `varro.permissions.approveModel`
2. Repository-scoped OpenCode `small_model`
3. OpenAI GPT Luna Fast when the account is confirmed as eligible
4. OpenAI GPT Luna
5. GitHub Copilot GPT Luna
6. The selected Varro session model, preferring a low or no-reasoning variant
7. No explicit model, allowing OpenCode to use its default

The runtime first looks for a model stored for the permission-owning session, then falls back to the
globally selected Varro model. That value is only the final fallback after the configured judge,
`small_model`, and Luna routes. Do not replace the owning-session lookup with the active UI session.

Judge outcomes map as follows:

- `allow` sends `once`, not `always`.
- `reject` sends `reject` and is intended for retries of an action the user rejected.
- `ask` reveals the prompt.
- A thrown error or timeout reveals the prompt.

The auto-approve activity strip shows an `ask` outcome as an amber manual-approval request, not a
red failure. A later manual response updates the activity entry for that permission ID; other queued
requests keep their own activity entries.

The model judge also requests an `actionSummary`: a neutral two-to-eight-word description limited to
80 characters, with no approval advice, risk judgment, Markdown, or trailing punctuation. It is
presentation-only and must not affect the verdict or resolution state. When an `ask` verdict or
failed automatic reply reveals a prompt, preserve the summary as its display title while retaining
the original metadata below it. A shell request with command metadata falls back to `Run command`
when no summary is available.

Switching away from auto invalidates the authority of an unfinished judge. A late verdict must
re-check the current effective mode before replying. In default mode it reveals the prompt; in full
mode the full-access flow owns the pending request.

Only allow/reject verdicts are cached. The cache is short-lived and keyed by normalized action
context, workspace, resolved model, and prior decision references. Request and session IDs are
excluded so materially identical actions can reuse a verdict. Do not weaken that key or cache `ask`
without a separate security review.

Hidden judge sessions must remain filtered from normal session, status, permission, and question
views. Their cleanup is best effort and can finish after the caller's timeout.

Model-judge sessions are children of the permission-owning session and carry
`metadata.varroInternal = 'permission-judge'`; the `Varro permission judge: ` title prefix remains a
legacy fallback. Identification must survive extension-host restart and must not depend only on
in-memory hidden IDs or pending titles. Identified judges remain hidden from session, status,
permission, and question results. A session-list observation may delete a judge only when it is not
locally active and its latest known timestamp is at least two minutes old; recent judges are hidden
but retained because another window may own them. Deletion remains best effort.

## Timeouts And Late Results

`AUTO_APPROVE_JUDGE_TIMEOUT_MS` is currently 20 seconds and is shared across three safety paths:

- The webview stops hiding an unresolved auto request and shows its prompt.
- The extension host reveals deferred permission attention for notifications and the status bar.
- The extension-host model judge returns `ask` when it cannot decide in time.

These timers run in different processes and their exact ordering is not guaranteed. The generic
webview API bridge has its own longer timeout. Never depend on one timeout firing first.

A timeout is a visibility transition, not cancellation and not resolution. The underlying model
request or reply may settle late. Late results must be idempotent and must verify all of the
following:

- The attempt is still the current attempt for that permission ID.
- No user response or replied event already won the race.
- The effective mode is still auto before applying a judge verdict.
- A visible fallback remains visible while an automatic reply is in flight.
- An `ask`, error, or failed reply leaves the fallback visible.

Do not clear timeout metadata in a way that causes a late callback to recreate an already-resolved
prompt. Do not discard an active attempt merely because another asynchronous operation completed.

## Snapshot And Visibility Invariants

Pending-permission snapshots are authoritative only with their reconciliation generation and
mutation guards. Preserve these rules:

- Ignore an older snapshot after a newer snapshot has applied.
- Preserve asks and replies received while a snapshot request is in flight.
- Include an auto attempt whose status is `visible` in the reconciled visible permission list.
- Do not start a duplicate judge for an existing attempt.
- Do not hide a restored auto prompt permanently before the first permission sync succeeds.
- Full mode may keep restored prompts hidden, but unresolved requests must remain discoverable for a
  later automatic sync retry.
- If restoration classification or ancestry resolution fails and full mode is not confirmed, prefer
  a visible prompt.
- A replied event is authoritative even if a judge or list request is still running.
- A visible prompt must post `permission/reveal` so host-side deferred attention becomes visible too.

The extension filters pending snapshots to the current workspace and removes hidden or recycled
sessions before reconciling host attention. It must first collect each snapshot from every OpenCode
directory instance that can own a visible session, including verified transfer destinations, and
keep requests from every catalog-authorized session. The webview treats an omission as
resolution, so a snapshot that drops a session whose live events are routed makes its prompt
flash and disappear while the tool call hangs. Host reconciliation removes an omitted request for
a catalog session only when that snapshot queried the session's current directory.

Initial webview state and boot replay use the same catalog-aware visibility. Boot replay may
synthesize a reply only for requests that this view's HTML actually embedded; a pending request
that was filtered out of the HTML is not resolved, and a synthetic `question.replied` would
tombstone it. If any required directory or session catalog fails,
reject the snapshot rather than using partial omissions as proof that a request resolved. Keep
permission and question reconciliation independent.

OpenCode V2 also lists location-owned MCP forms with `sessionID: 'global'`. This sentinel is not a
session and must never enter session-question snapshots, events, or attention state. The V2 adapter
excludes it before workspace session resolution, without answering or cancelling the form. These
forms remain pending for an OpenCode client with location-scoped form UI. Real session forms retain
the complete-resolution requirement above, including failures for unknown owning sessions.

## Mode Changes

Mode updates use the host-owned `/varro/session/{id}/permission-mode` endpoint. The host serializes
updates for each session, patches OpenCode rules and `metadata.varro.permissionMode` together, persists
the confirmed mode locally, and broadcasts the complete confirmed mode snapshot. Stale successes or
failures must not overwrite the latest user
selection. A webview may present the selected mode while its request is pending, but failure rolls
that selection back to the last confirmed snapshot.

Metadata restoration rejects session snapshots older than the last confirmed mode update. A delayed
session-list response must not restore Full access after the user has confirmed Default.

Metadata writes preserve unrelated session metadata. Preconfigured sessions save the explicit mode
without appending rules again. Local fallback recovery still suppresses automation until confirmed;
incoming metadata cannot bypass an active local mode update or recovery.

- Switching to auto installs Varro's ask-based auto rules, invalidates the authority of older mode
  work, and syncs pending requests into the judge flow.
- Switching to default appends the selected agent's resolved OpenCode rules after Varro's prior
  session rules so the configured policy applies under OpenCode's append-only session update API.
  Recovery without agent context appends a conservative ask-by-default fallback. Any unfinished auto
  verdict must not approve after the switch.
- Switching to full first installs allow-all rules, then responds to locally known pending requests,
  then fetches the authoritative pending list to catch hidden or missed requests.
  Those replies use `once`: the session rules already allow subsequent work. Using `always` would
  save approvals outside this session and let them survive a later return to Default.
- A failed mode update rolls back only state still owned by that update. It must not undo a newer
  selection.

Persisted `edits` selections from versions that exposed Auto-accept edits migrate to `default`.
Legacy browser-selection imports update local storage only. Never backfill session metadata or
permission rules while opening a workspace or loading history. Browser storage can contain sessions
from every workspace, and every OpenCode PATCH advances `time.updated`.
Startup fallback recovery is read-only and must not delay the webview ready handshake. A matching
rule suffix can confirm recovery; otherwise retain the pending-recovery flag and actionable prompts
until the user explicitly selects a mode. An earlier matching sequence is insufficient if later
rules override it. Only explicit mode changes may patch those pending rules.

Do not optimistically clear permission prompts as part of a mode selection. Full mode may own them
automatically only after its rule update succeeds, and unresolved requests must remain discoverable
for retry through pending snapshots.

The Ralph form currently creates its manager in full mode, and iteration and repair sessions use the
run's `permissionMode`, which is full in the supported UI flow and independent of the composer
selection. The runner accepts any valid mode in persisted configuration, so keep its mode handling
correct rather than hard-coding full in shared runner logic. Do not make Ralph execution depend on a
webview permission prompt that may not be mounted.

## Stuck-Session Prevention Checklist

Before merging a permission change, verify every item that applies:

- Every path that hides a pending request has an owner, a bounded timeout, and a visible or automatic
  recovery path.
- No UI removal happens before reply acknowledgement or an authoritative resolution signal.
- Judge `ask`, judge error, judge timeout, ancestry failure, and reply failure all reveal or preserve
  an actionable prompt.
- A pending list refresh cannot erase a visible timed-out auto prompt.
- A late judge cannot override a manual response, a replied event, or a newer mode.
- Only the elected webview starts automatic work, and every automatic host request carries its lease.
- A stale lease is rejected before a judge or permission reply reaches OpenCode.
- Child and grandchild requests use inherited mode but retain their own request and session IDs.
- Reloaded requests are either re-judged, answered by full mode, or restored visibly.
- Grouped prompts retain all member IDs and apply `once`, `always`, and `reject` with their intended
  scope.
- Legacy and v2 ask/reply shapes produce the same host and webview attention state.
- Hidden judge sessions and recycled sessions cannot leak requests into user-visible snapshots.
- Errors are surfaced; intentional best-effort cleanup is the only permission failure that may be
  silent.

When debugging, inspect the pending `/permission` snapshot and exported session parts. A tool part
stuck in `running` with no process output often indicates that OpenCode is still waiting for a reply.
If switching to full unblocks a session, that is evidence of an orphaned pending request, not
evidence that the tool process itself was hung.

## Required Regression Coverage

Permission lifecycle changes should cover the narrow behavior they modify and the relevant races.
At minimum, consider tests for:

- Default ask and manual once/always/reject
- Auto local allow, model allow, model reject, model ask, thrown error, and timeout
- Prompt visibility at the judge timeout
- Visible fallback surviving a pending-permission resync
- Late allow keeping the fallback until the response resolves
- Failed auto-judge response preserving an actionable prompt
- User response or replied event winning over a late judge result
- Switching from auto to default or full while judging
- Child and multi-level descendant mode inheritance
- Permission event arrival before child ancestry is loaded
- Reload restoration and failed permission-list loading
- Ask/reply events racing with pending snapshots
- Grouped duplicate requests
- Legacy and v2 event wrappers and alternate request ID fields
- Host notification reveal after timeout and cancellation after reply

Useful focused commands include:

```sh
npm run test -- src/webview/hooks/useOpenCode.permissions.test.ts
npm run test -- src/webview/hooks/session-event-handlers.test.ts
npm run test -- src/webview/lib/stores/permissions-store.test.ts
npm run test -- src/extension/auto-approve-judge.test.ts
npm run test -- src/extension/session-state-manager.test.ts
npm run test -- src/shared/attention-contract.test.ts
npm run test -- src/webview/hooks/permission-rules.test.ts
```

Also run `npm run lint:check` and `npm run typecheck` when implementation or types change.

## Implementation Map

| Concern | Primary files |
| --- | --- |
| Modes, protocol, and shared timeout | `src/shared/protocol.ts` |
| Canonical OpenCode rule arrays | `src/shared/permission-rules.ts` |
| Effective mode inheritance and persistence | `src/webview/lib/state-permission-modes.ts` |
| Ask/reply event handling | `src/webview/hooks/session/session-approval-events.ts` |
| Responses and serialized mode updates | `src/webview/hooks/session/session-approvals.ts` |
| Judge attempts and pending-list reconciliation | `src/webview/hooks/runtime/open-code-runtime-instance.ts` |
| Multi-webview owner election and lease validation | `src/extension/sidebar-provider.ts`, `src/extension/rest-proxy.ts` |
| Prompt grouping and snapshot mutation guards | `src/webview/lib/permission-grouping.ts`, `src/webview/lib/state-permissions.ts` |
| Local and model judge policy | `src/extension/auto-approve-judge.ts` |
| Judge model fallback order | `src/extension/helper-model-selection.ts` |
| Decision gate, direct Jev route, credentials, and decision-model selection | `src/extension/jev-decisions.ts`, `src/extension/decision-providers.ts` |
| Shared prior-rejection policy for every reviewer | `src/extension/permission-review-policy.ts` |
| Native decision discovery, transport, and strict answer decoding | `src/extension/native-decisions.ts` |
| Host attention, persistence, and recovery | `src/extension/session-state-manager.ts` |
| Workspace filtering plus internal helper-session identification, hiding, and stale cleanup | `src/extension/rest-proxy.ts`, `src/extension/hidden-session-manager.ts` |
| Inline and session-tree prompt placement | `src/webview/components/message-list/pending-prompts.ts` |
| Judge-summary propagation and permission prompt presentation | `src/webview/hooks/runtime/open-code-runtime-instance.ts`, `src/webview/lib/state-permissions.ts`, `src/webview/components/PermissionPrompt.tsx` |
| Rejected-permission classification, tool preservation, and stopped-turn summaries | `src/shared/error-classification.ts`, `src/webview/lib/assistant-activity.ts`, `src/webview/components/ToolCall.tsx`, `src/webview/components/message-list/assistant-dialog.ts`, `src/webview/components/MessageList.tsx` |

OpenCode version bumps can change event names, payload wrappers, request IDs, routes, and permission
rule behavior. Follow `docs/opencode-version-bumps.md` and revalidate this contract against the new
server before adapting only the visible symptom.
