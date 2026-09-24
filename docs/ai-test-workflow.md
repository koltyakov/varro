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
runner compatibility without consuming provider credentials. It does not replace Luna/Terra scenarios.

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

## AI judgment beyond the script

Scenario steps are minimum coverage, not a prohibition on investigation. When the AI sees an unexpected
layout, stale label, focus loss, or suspicious metric, save the event count and stable identities first.
Add a bounded exploratory branch, record its inputs, and reproduce from the same capture and checkpoint.
Keep the original sequence and result. Useful discoveries should become retained captures or focused
regressions rather than another permanent prerequisite for every future run.

Treat heuristics as leads. For example, a Markdown text-length decrease alone does not establish a painted
disappearance. Review the same element's clipping-aware geometry and rendered frames around that event.
Optional attachment forms that are absent do not block an otherwise complete AI-03 base scenario; report
those variations as untested. Explicitly requested attachment coverage still needs its own prepared case.

Reports must say what ran, what failed, and what could not run. A `BLOCKED` row is incomplete coverage,
not a demonstrated product defect. It cannot become a pass through a different backend or a settled
screenshot. Include the exact recovery attempted and continue all independent rows before finishing.
