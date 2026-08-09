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
| `default` | Allow known read-only permissions; ask for everything else | Show an actionable prompt |
| `auto` | The same rules as `default` | Hide briefly while Varro judges; reply or fall back to a prompt |
| `full` | Allow every permission, including unknown permission names | Reply `always` to any already-pending request and resync |

`Auto approve` is not a broader OpenCode rule set. OpenCode must still emit an ask so Varro has a
specific request ID and complete action context to judge. Giving `auto` allow-all rules would bypass
the judge and silently turn it into `full`.

`Full access` is not automatic judging. It deliberately changes the session rules to allow all and
answers requests that were already queued before the rule update. It must remain an explicit user or
workflow choice.

### Rule Ordering

OpenCode uses the last matching permission rule.

- Default and auto rules start with `* -> ask`, then place known read-only allowances after it.
- Current read-only permissions are `read`, `glob`, `grep`, `list`, `codesearch`, and `lsp`.
- Mutating, executable, delegating, external, and interactive permissions remain `ask` in default and
  auto mode.
- Full rules end with `* -> allow`, so they override earlier agent restrictions and cover permission
  names introduced by OpenCode or an MCP tool.
- Unknown permission names therefore ask in default/auto and allow in full.

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

- A session with an explicit stored mode uses it.
- Otherwise, a child recursively inherits its parent's effective mode.
- A root without a stored mode falls back to `default`.
- A new-chat draft uses the workspace-specific saved draft mode, then the configured default.
- A fork is a new root, so Varro copies the source session's effective non-default mode into local
  session-mode storage. The fork operation itself does not issue a second OpenCode rule update.
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
4. Default reveals it, auto starts a bounded judge attempt, and full starts an automatic `always`
   response.
5. Varro sends `once`, `always`, or `reject` to OpenCode's permission reply route.
6. Local UI is removed only after the reply is acknowledged, an authoritative reply event arrives,
   or a race-safe pending snapshot proves that the request no longer exists.
7. `permission.replied` or `permission.v2.replied` clears host attention and any remaining webview
   state.

Initial webview state includes persisted pending requests so reload does not strand a session.
`GET /permission` reconciles event state after connection, reload, and mode changes. Both snapshot
reconcilers use generations and mutation tracking so an older request cannot overwrite an ask or
reply event that occurred while it was loading.

Support all currently accepted request ID fields (`id`, `permissionID`, and `requestID`) and both
plain and v2 `properties.info` wrappers. Do not update only one event shape.

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

Full mode intentionally does not restore a prompt while the mode remains `full`. A failed full-mode
reply currently surfaces an error and remains pending for a later permission sync to retry. Do not
copy that exception into default or auto mode; changes to full mode should prefer adding bounded
automatic retry rather than exposing a manual approval that contradicts full access.

## Manual Approval

Default mode presents `Reject`, `Once`, and `Always` actions.

- `Once` approves the specific request.
- `Always` asks OpenCode to approve the request and matching future actions under its permission
  semantics.
- `Reject` denies the request.
- A failed response must leave the user with an actionable retry.
- A successful response records a bounded decision reference for later auto-judge context.

Equivalent pending requests may be grouped for display. Group identity includes type, pattern,
session ID, title, and metadata, so requests from different sessions are not grouped together.

- `Once` removes only the answered group member and leaves later members actionable.
- `Reject` explicitly responds to every member represented by the grouped prompt.
- `Always` sends `always` for the displayed group leader, then removes the matching group after
  OpenCode accepts the standing response. It does not explicitly reply to every represented ID.
- Reconciliation and reply events must preserve every underlying request ID, not only the displayed
  leader ID.

## Automatic Judging

Auto mode has two decision stages.

### Local Rules

The extension host first applies narrow deterministic rules. The current local policy allows:

- `webfetch`
- Workspace-contained edits when all canonicalized paths remain inside the workspace and no file is
  being deleted
- A small set of read-only shell commands, including safe Git inspection and basic identity or
  environment checks

Shell parsing deliberately rejects command substitution, pipelines, redirection, unsafe separators,
ambiguous quoting, outside-workspace Git paths, and mutating Git operations. Expand local rules only
with adversarial tests for paths, symlinks, quoting, command composition, and side effects.

### Model Judge

Requests not decided locally may be sent to a temporary hidden OpenCode session. That session denies
all tools except structured output. Permission text, command text, paths, metadata, and prior user
decisions are untrusted input to the judge, never instructions.

The judge model is resolved in this order:

1. `varro.chat.autoApproveModel`
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
- `reject` sends `reject` and is intended for materially matching prior user rejections.
- `ask` reveals the prompt.
- A thrown error or timeout reveals the prompt.

Switching away from auto invalidates the authority of an unfinished judge. A late verdict must
re-check the current effective mode before replying. In default mode it reveals the prompt; in full
mode the full-access flow owns the pending request.

Only allow/reject verdicts are cached. The cache is short-lived and keyed by normalized action
context, workspace, resolved model, and prior decision references. Request and session IDs are
excluded so materially identical actions can reuse a verdict. Do not weaken that key or cache `ask`
without a separate security review.

Hidden judge sessions must remain filtered from normal session, status, permission, and question
views. Their cleanup is best effort and can finish after the caller's timeout.

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
sessions before reconciling host attention. Keep permission and question reconciliation independent.

## Mode Changes

Mode updates patch OpenCode session rules and update Varro's workspace/session preferences. Updates
for one session are serialized, and stale successes or failures must not overwrite the latest user
selection.

- Switching to auto installs default ask rules, invalidates the authority of older mode work, and
  syncs pending requests into the judge flow.
- Switching to default installs default ask rules. Any unfinished auto verdict must not approve after
  the switch.
- Switching to full first installs allow-all rules, then responds to locally known pending requests,
  then fetches the authoritative pending list to catch hidden or missed requests.
- A failed mode update rolls back only state still owned by that update. It must not undo a newer
  selection.

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
| Prompt grouping and snapshot mutation guards | `src/webview/lib/permission-grouping.ts`, `src/webview/lib/state-permissions.ts` |
| Local and model judge policy | `src/extension/auto-approve-judge.ts` |
| Judge model fallback order | `src/extension/helper-model-selection.ts` |
| Host attention, persistence, and recovery | `src/extension/session-state-manager.ts` |
| Workspace and hidden-session snapshot filtering | `src/extension/rest-proxy.ts` |
| Inline and session-tree prompt placement | `src/webview/components/message-list/pending-prompts.ts` |

OpenCode version bumps can change event names, payload wrappers, request IDs, routes, and permission
rule behavior. Follow `docs/opencode-version-bumps.md` and revalidate this contract against the new
server before adapting only the visible symptom.
