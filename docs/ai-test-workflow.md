# Running AI verification without supervising setup

Start here for AI, fuzzy, streaming, and parity requests. The detailed scenario definitions live in
[AI fuzzy verification](ai-fuzzy-verification.md), [streaming verification](ai-streaming-verification.md),
and the [action matrix](ai-action-matrix.md).

The controller owns setup, recovery, evidence, and cleanup. Ask the user only when a missing credential,
denied automation permission, or conflicting user-owned fixture requires their decision. A short tool
call, hidden control, missing capture, or incomplete previous scenario is work for the controller.

To verify the runner itself in one command:

```sh
npm run test:ai-runner
```

This builds Varro, launches an isolated VS Code instance with generated input, verifies checkpointed
delivery against the real webview, saves snapshots, and verifies host shutdown. It needs no provider
credentials or production database. Evidence stays in `artifacts/ai-streaming/runner-smoke-<timestamp>/`.
Use it to diagnose runner setup; it is not a visual or live-model suite verdict.

Verify the controller against each installed v1/v2 executable with:

```sh
VARRO_OPENCODE_TEST_BINARY=/absolute/path/to/opencode node --test scripts/ai-opencode-client.integration.test.mjs
```

Build first and add `VARRO_AI_TEST_EDITOR=1` to also verify the authenticated editor launcher and a
native composer follow-up. This test uses a local fixture provider and separate database; it verifies
runner compatibility without consuming provider credentials. It does not replace GPT-6 Luna Fast/Sol scenarios
run through the OpenAI subscription. Use the OpenAI subscription for all AI test model calls.

## Isolate editor state as well as the backend

Use the existing launchers. They set `VARRO_TEST_STATE_ROOT` to a disposable profile
directory, separating server claims and v2 annotation locks from production editors.
They also isolate home, local app-data, state, and temporary directories used by
older builds. Each independent test profile gets a separate root. Launch metadata
records `varroTestStateRoot` for the AI launcher.

A custom test host must supply an absolute `VARRO_TEST_STATE_ROOT` alongside
`VARRO_TEST_SERVER_URL`; otherwise default state access fails closed. Do not copy,
delete, or repair production lock files to unblock a test. Database isolation and
verified endpoint checks are still required. See [server ownership](server-ownership.md#editor-distributions-and-test-isolation)
for mixed-version limitations.

## Choose the input that exercises the behavior

| Behavior | Input in the isolated VS Code host |
| --- | --- |
| Rendering, Markdown, tool transitions, bottom follow, anchor preservation | Retained capture, first with continuous playback, then with checkpoints for interaction or diagnosis |
| Cold pagination and long-history navigation | Verified long history, opened cold in the host |
| Send, queue, steer, cancel, questions, permissions, actual subagents | Real model and isolated backend, using disposable sessions |
| File edits and diff creation | Real model in the clean `tmp/opencode` fixture; retain the resulting stream for future rendering checks |

An unqualified AI request still covers the standard scenarios and action rows. Record the execution mode
for each result. Playback can establish a rendering result, but cannot establish that a real model ran a
tool, acknowledged a permission, or consumed a queued message. Do not spend more live prompts trying to
recreate a rendering boundary already available in a capture.

## Controller loop

1. Record the source revision and existing changes once. Run the required preflight once for that
   revision. Concurrent source changes do not force a restart of the entire suite; state which build
   the editor actually loaded and run focused checks for the later changes.
2. Prepare inputs before starting timed scenarios. Inspect capture boundaries with `ai:streaming inspect`.
   Verify the isolated server, fixture, host identity, and actual model request for live work. Check the
   backend version explicitly. The live and precondition clients detect v1/v2 and use the extension's
   v2 adapter for native v2 requests. Isolation records the exact backend version. V2 requires
   `VARRO_AI_DATA_DIR` because its location endpoint does not expose the database path; native listener
   and database ownership checks still apply. Never substitute a different backend for requested coverage.
3. Start the isolated host using the existing launcher. Use its CDP target for native mouse and keyboard
   events. The controller can use this without asking the user to manipulate the editor. Bind by surface,
   viewId, and session route. Re-read geometry when a target changes; do not keep retrying stale selectors.
   Select and verify the scenario's agent as well as its model. New chats can inherit the preceding
   test's Plan selection; configuring Build read permissions does not make a Plan read ask for approval.
   After widening, wait for the measured content width before asserting settled layout. The root
   deliberately delays expansion by four frames to avoid host-surface clipping; `innerWidth` changes first.
4. Run independent cases even after another case fails. AI-08 establishes its own live gates. AI-18/19
   establish their own action state. None requires an AI-07 scrolling verdict. Dirty fixture reuse still
   requires exact commit, status, paths, and content hash from the latest exit evidence.
5. Recover a missed tool window within the bounded prompt budget. AI-07 now retries a return that reached
   bottom after the tool finished. A viewport that never reaches bottom or violates an invariant is a
   failure to preserve and diagnose, not a reason to retry until green.
6. Use the automatic AI-07/08 capture beside the manifest for rendering reproduction. Inspect it, replay
   continuously, then pause at exact event counts when the AI needs time to inspect a diff, position an
   anchor, or choose an additional action. Resume to observe the transition. No model or recorded tool
   runs during replay.
7. Finish every independent case, capture cleanup evidence, and report product failures separately from
   incomplete coverage. Do not repeatedly ask whether to continue ordinary recovery steps.

## Reproduce a boundary

### Latest-message navigation

Use `goToLatest` from `scripts/ai-fuzzy-navigation.mjs` with the expected session and final rendered
message IDs. It dispatches one native input, then waits for that message to be visible at the bottom
and for geometry to settle across samples, with a 30-second deadline and diagnostic samples on failure.
The disappearing jump button is not proof of arrival. A 110-turn reproduction took about 2.4 seconds
to reach the final marker, so a fixed 400 ms sleep produced false failures.

During a confirmed active text stream, pass `streaming: true`. This checks the same session and visible
latest row, non-reversing follow movement, and a bottom gap of at most 64 CSS pixels throughout the
observation window. It permits smooth-follow lag while new lines arrive. Keep the default stationary
check for settled history and final arrival; streaming arrival does not prove final settlement.

`runAi01` in the same module owns the seeded wheel, native scrollbar, Option-counter, and return-to-latest
sequence. Call it with a bound `CdpController` after selecting an isolated long history; the caller owns
the paint observer and evidence storage. Live fixture setup also uses the shared arrival check.

### Replay checkpoints

```sh
npm run ai:streaming -- inspect --capture <capture.json>
npm run ai:streaming -- run --capture <capture.json> --output artifacts/ai-streaming/<new-run> --checkpoints 12,34
```

Use `afterEvents` values from inspection, not the example numbers. The host arms before delivery. The
controlling AI attaches to the target in `run.json`, starts playback, and manages the remaining commands:

```sh
npm run ai:streaming -- start --control <run>/control.json
npm run ai:streaming -- status --control <run>/control.json
npm run ai:streaming -- snapshot --control <run>/control.json
npm run ai:streaming -- resume --control <run>/control.json
```

At a checkpoint, `playbackState` is `paused`. The editor remains interactive, and the server exposes only
events already delivered. `snapshot` saves the exact route, mounted-row geometry/text, scheduler position,
and a workbench screenshot. Use native input against the recorded target and record its effect, then
resume. `pause` also works during delivery when the AI notices something unexpected. The replay deadline
includes time spent paused, so use `--replay-timeout-ms` for a longer investigation.

Checkpoints preserve event ordering and exclude paused time from the playback clock. They deliberately
change the wall-clock cadence. Keep an uninterrupted run for flicker and performance evidence. A paused
busy indicator does not prove an action occurred during live streaming. Verify the effect through the
next resumed events and label the result `checkpointed replay`.

## Required diff scrolling coverage

Default AI/fuzzy and streaming runs must include the cases below in the isolated real VS Code host.
They are also required for targeted changes to file previews, deferred content, row measurement,
virtualization, or scroll ownership. Use retained playback for rendering cases; live tool execution
remains a separate requirement of AI-07 and ACT-07. The basic `runAi01` sequence alone does not cover
this matrix.

Prepare virtualized, varied-height history containing multiple multi-file diffs and repeated edits to
the same file. Include deferred details and enough history to completely unmount diff rows. Verify
those preconditions rather than substituting text-only history or a short transcript.

| Case | Required actions | Pass evidence |
| --- | --- | --- |
| DIF-01 | At physical bottom, toggle file diffs off/on repeatedly, both settled and during playback. Include details arriving after the initial summary has settled. | Every toggle/hydration frame reaches the new physical bottom without easing or removed-content reserve; bottom gap is at most 1 CSS px. Separate unrelated later stream growth from the toggle boundary. |
| DIF-02 | Repeat off/on while detached with a recorded painted marker. While details are pending, wheel away from bottom. | The same marker stays anchored during the setting change; subsequent hydration does not undo the gesture or restart bottom follow. |
| DIF-03 | With diffs off, then on, wheel up/down using small and large deltas across core, overscan, and full-unmount boundaries. Pause after each sequence. | Visible content follows native input without an additional settling jump, blank viewport, or alternating summary/diff heights. Record native deltas and shared-marker movement. |
| DIF-04 | With diffs off, then on, drag the native scrollbar slowly and quickly in both directions, to the top and back down. Hold the thumb for at least 350 ms before moving, then for 1 second at its destination; observe another second after release. Repeat with diffs on while edits/tools arrive. | Confirm actual thumb movement. No owner fights the held pointer, visibly reverses it, trembles at the destination, or snaps back after release. Record per-frame input responsiveness, including the long drag to top. |
| DIF-05 | Load and measure diffs, move them out of the core and fully out of the mounted range, then return while details reload. | Mounted overscan retains geometry. Unloaded content reserves exactly its previous measured height until hydration; a summary/placeholder never overwrites that exact measurement. Record row IDs, node identity, loaded/reserved heights, and remounts to detect eviction/refetch loops. |
| DIF-06 | Observe successive edits to several files and repeated edits to one file while bottom-following, wheel-detached, and holding the scrollbar. Toggle diffs during the sequence. | Edits remain ordered and appear once; no repeated entrance, collapsed/reappearing diff, stale height, escalating follow lag, or loss of direct-input ownership. Record actual update counts and gaps. |
| DIF-07 | Expand a scrollable diff, wheel inside it, then close it and resume outer scrolling. | Inner wheel movement stays local while it has range; expansion, focus, and closure do not leave a stale outer-scroll owner. |

For DIF-01 and DIF-05, include a deterministic delayed-response regression that outlasts the initial
settle window, at least 350 ms. For DIF-06, also exercise a deterministic burst of at least ten edit
updates within one second, including same-file replacement and multi-file growth. Keep synthetic
timing tests separate from editor playback/live evidence. Do not alter a retained capture's short
gaps or inject synthetic state into a live editor to claim the real-editor case passed.

Observe consecutive frames around each boundary, not just the final position. Pair screenshots with
clipping-aware geometry of the same painted marker. A `scrollTop` correction accompanied by equal
growth above a stationary marker is valid compensation, not input reversal. Height reservations must
match the measured row exactly; any visible drift tolerance must be stated in the ledger, no more
than 2 CSS px, and must not hide repeated oscillation or accumulating drift.

Record frame-gap distributions and maximums during wheel/drag input, gaps above 50 ms, long tasks,
mounted-row counts, and visible anchor motion. Sustained low frame rate or pauses during a drag are
failures even if the final destination is correct. A gap or long task above 100 ms requires a
same-capture reproduction and attribution before a performance pass. Preserve full metrics and mark
capture/export overhead separately; do not silently discard it or use a good average FPS to clear
height oscillation.

For detached diff-toggle attribution, verify mounted previews before Hide File Diffs and their removal
afterward. Include deferred summaries whose patch bodies are unloaded outside the mounted range. Trace
the first toggle as well as warm repeats; a settled snapshot with no mounted previews is not a valid
substitute for the original interaction. Inspect repeated mount/measurement and layout passes, not just
the longest JavaScript stack.

Put each DIF case and its settled/streaming, diffs-off/on, and execution-mode coverage in the ledger.
Missing deferred content, rapid edits, native thumb movement, or frame evidence leaves that case
`BLOCKED`, not passed. Continue the independent cases and use the normal bounded recovery workflow.
Retain a minimal reproduction and a deterministic regression for every confirmed failure.

## AI judgment beyond the script

Scenario steps are minimum coverage, not a prohibition on investigation. When the AI sees an unexpected
layout, stale label, focus loss, or suspicious metric, save the event count and stable identities first.
Add a bounded exploratory branch, record its inputs, and reproduce from the same capture and checkpoint.
Keep the original sequence and result. Useful discoveries should become retained captures or focused
regressions rather than another permanent prerequisite for every future run.

Treat heuristics as leads. For example, a Markdown text-length decrease alone does not establish a painted
disappearance. Review the same element's clipping-aware geometry and rendered frames around that event.
For the known host-level resize clipping reproduction and its plain-HTML control, see
[webview resize clipping](webview-resize-clipping.md).
Optional attachment forms that are absent do not block an otherwise complete AI-03 base scenario; report
those variations as untested. Explicitly requested attachment coverage still needs its own prepared case.

Reports must say what ran, what failed, and what could not run. A `BLOCKED` row is incomplete coverage,
not a demonstrated product defect. It cannot become a pass through a different backend or a settled
screenshot. Include the exact recovery attempted and continue all independent rows before finishing.

## Results and recommendations

Keep findings separate from coverage in every AI, fuzzy, streaming, and parity ledger and final response.
Lead with what the tested behavior showed, not whether every planned case ran:

- `PASS`: the exercised checks found no issues. Say "No issues found in tested cases", not "the full
  suite passed" unless all required applicable cases completed.
- `FAIL`: evidence establishes an issue, such as an observed invariant violation or a confirmed failed
  check. Missing prerequisites, unmet scenario gates, unavailable variations, controller deadlines, and
  unexecuted actions alone are not issues and must not make the overall result `FAIL`.
- `BLOCKED`: no relevant behavior could be verified. Say "Not verified" rather than claiming either a
  failure or that the behavior is OK.

Keep per-case `PASS`, `FAIL`, and `BLOCKED` verdicts. An incomplete case remains `BLOCKED`, even when
the run found no issues in other cases. A failed invariant makes that case `FAIL` even if later steps
could not run. Partial observations can be reported as OK only for the specific checks actually verified.
Suspicions without enough evidence remain investigation leads, not confirmed issues. A known root cause
is not required to report an evidenced failure.

Include a Markdown summary table in both the ledger and the final response, with these columns:

| Scope | Tested behavior | Issues found | All cases complete |
| --- | --- | --- | --- |
| Example: AI scenarios | OK in tested cases | None found | No, 5/8 complete; 3 blocked |
| Example: action checks | Has issues | 1 confirmed queue-order issue | Yes, 17/17 complete |
| Example: streaming | Not verified | Unknown, no checks verified | No, editor access unavailable |

Use actual scopes and counts, not these example values. "All cases complete" means every required
applicable case reached its preconditions and received a verified verdict; a completed failing case
still counts as complete. List omitted optional variations separately. Never count a dispatch, a
canonical-only outcome, or an unrelated automated check as completion of a required visual case.

For each issue, include severity, affected behavior, expected versus observed result, evidence or minimal
reproduction, and a concrete recommendation for what needs fixing and how to verify the fix. Identify
product/backend issues, test-controller problems, automated-check failures, and cleanup issues separately;
do not label a run-infrastructure issue as a Varro regression. If the cause is unknown, recommend the next
diagnostic or regression test instead of inventing a fix. Recommendations for blocked coverage belong
under follow-up verification, not product fixes. When no issues were found, say that no product fixes are
indicated by the tested cases and note any remaining verification. Link the detailed ledger.

## Pruning old evidence

Run output accumulates quickly: isolated databases under `artifacts/ai-test-data/`, streaming runs under
`artifacts/ai-streaming/`, and adapter runs under `artifacts/opencode-adapters/`. To list what can go:

```sh
npm run artifacts:prune
```

This is a dry run. It keeps the newest 10 directories in each location and anything changed in the last
24 hours, and it never selects the directory named by `VARRO_AI_DATA_DIR`. Add `--apply` to delete, and
`--keep <n>` or `--min-age-hours <n>` to adjust. It does not touch `artifacts/ai-fuzzy/` ledgers,
`opencode-adapters/verified.json`, or any `tmp/` fixture.
