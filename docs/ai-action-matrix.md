# AI action coverage matrix

Use this matrix for AI parity and regression runs. Rendering a stream is one part of
the run. A passing run must exercise the actions that create, change, interrupt, and
resume work through the real VS Code UI.

Follow [AI fuzzy verification](ai-fuzzy-verification.md) for database isolation,
native input, model selection, fixture safety, evidence capture, and cleanup. Follow
[Permission lifecycle](permission-lifecycle.md) when judging approvals and child
sessions. Never use production sessions as action targets.

## Coverage dimensions

Record a separate result for each tested backend version. Cross the actions below
with the states and surfaces that affect their behavior:

- Session state: new draft, idle history, streaming text, running tool, pending
  permission or question, interrupted turn, and resumed history.
- Surface: sidebar and chat editor, including a hidden, revealed, reloaded, or closed
  editor when ownership matters.
- Permission mode: Default, Auto, and Full access. Include explicit mode changes
  while a request is pending.
- Session relationship: root, actual model-created child, and root/child navigation.
- Content: text, attachment/context, reasoning, tool output, real fixture edit, diff,
  question, permission prompt, and final response.

Use a recorded seed to choose ordering and variations. Cover every applicable
action row on each backend and every named state transition below. Do not claim the
full Cartesian product. Record the exact combinations tested and any omitted ones.

## Required action rows

| ID | Actions and required transitions | Evidence required for a pass |
| --- | --- | --- |
| ACT-01 | Create a chat, send from an idle composer, append a follow-up | Exact marked users and linked responses occur once, in order; model and route are correct |
| ACT-02 | Queue at least two messages during active work and let them dispatch | Exact queue IDs, ownership, visible counts, FIFO canonical admission, and no duplicate response |
| ACT-03 | Pause, edit, save, resume, and remove queued messages | Paused item does not dispatch; saved content replaces the queued content; removed item never appears in canonical history |
| ACT-04 | Send a manual steer during active work, including a paused queued row | UI acknowledges the steer, the queued row is removed once, and the server receives the intended marked input once |
| ACT-05 | Enter inline editing, cancel, then submit a replacement prompt | Cancel preserves original history; submission replaces the intended branch; no stale or duplicate prompt remains |
| ACT-06 | Attach context or a file, inspect it, remove it, and send retained context | Composer and canonical submitted parts agree; removed attachment is absent; content belongs to the correct session |
| ACT-07 | Run sequential and independent parallel tools, make a bounded fixture edit, run a focused check, open/close its diff | Actual tool inputs/results, file changes, check output, and usable diff UI agree with canonical history and disk |
| ACT-08 | Ask the model to launch a real subagent; inspect child progress; navigate child and parent | Recorded ancestry, exact child model, separate routes, visible completion, and no cross-session content leakage |
| ACT-09 | Trigger a child permission and answer it from the parent conversation | Pending request retains its child session ID; parent fallback remains actionable; acknowledgement resumes the correct child |
| ACT-10 | Default mode: Once, Reject, and session-scoped Always; reopen while pending | No early prompt removal; rejected action does not execute; each approval has its intended scope; reopened pending request remains actionable |
| ACT-11 | Switch Default, Auto, and Full access; resolve an already-pending request through a mode change | Confirmed mode and rules agree; Auto remains ask-based; no stale automatic owner or orphaned request |
| ACT-12 | Answer and skip a real question | Correct answer or rejection reaches the server once; continuation remains usable; no stale prompt returns |
| ACT-13 | Stop active work and send a new turn | Server acknowledges cancellation, busy state clears, and the next marked turn completes normally |
| ACT-14 | Switch sessions, hide/reveal or close an editor while work or a queue is active | Exact queue item IDs and ownership survive handoff; drafts remain session-scoped; wrong-route content never appears |
| ACT-15 | Reload during streaming and while a permission or queue is pending | Recreated view binds by stable viewId; history, pending requests, and queued work recover without duplicates |
| ACT-16 | Change agent/model in idle and busy states where supported | Selection is visibly confirmed; the next admitted request uses the intended configuration; unsupported transitions are explicit |
| ACT-17 | Fork, undo/redo, rename, and archive a disposable session where supported | Correct branch and history are retained; route/title/list state agrees with the server; capability differences are recorded |

Queue editing means changing and saving the text, not merely opening an edit box.
Subagent coverage requires model delegation and actual child work, not an empty
child created by the controller. Permission mode synchronization alone does not
count as a permission lifecycle pass.

## Scenario independence

Give each action group its own verified preconditions. Short disposable histories
are sufficient for composer, queue, steer, question, and permission lifecycle
checks. Long virtualized histories are required for pagination and scroll tests.
Real file/diff checks require a recorded fixture edit.

An incomplete AI-07 scroll-timing check must not prevent independent action rows
from running. AI-08, AI-18, and AI-19 accept a clean baseline or exact latest fixture
exit evidence, including after an AI-07 timing miss. They must establish their own
content and interaction preconditions. An independently prepared action check is
reported under its ACT ID unless it exercises the complete named scenario.

## Execution and reporting

Before sending prompts, put the planned cells in the run ledger. For each cell,
record backend version, starting state, surface/viewId, permission mode, model,
session IDs, action sequence, expected result, and evidence path. Mark cells
`PASS`, `FAIL`, or `BLOCKED`; record unexecuted cells explicitly rather than omitting
them from a summary.

Drive user actions with native input. Server reads verify outcomes; they cannot
substitute for clicking Send, editing a queue row, replying to a permission, or
opening a child. Observe frame-level rendering during the actions, and retain
canonical history plus pending-request and queue evidence. A dispatched input is
not proof of an action's effect.

Reuse deterministic tests for races that cannot be produced reliably with a live
model, including stale permission snapshots, late judge replies, and duplicate
events. Report those separately from live editor results. Do not inject failures
or synthetic state into the live editor to claim a real-backend pass.

The overall action-matrix result passes only when every required applicable row
passes on every requested backend. A capability unavailable by design needs a
verified UI behavior and an explicit capability note. A missing test mechanism or
unreached precondition is a block, not an unsupported capability.
