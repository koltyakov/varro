# AI streaming tests in VS Code

Use this playbook when the user asks to **Run streaming tests**, case-insensitively. This is a
separate extension of [AI/fuzzy testing](ai-fuzzy-verification.md), not an alias for its live-model
suite. It selects existing OpenCode responses and replays their output through the normal extension
transport in a disposable VS Code Extension Development Host. No model is called and no recorded
tool is executed.

A run passes only after an AI watcher observes the actual editor during playback and reviews the
frame and timing evidence. The runner deliberately reports `NEEDS_AI_REVIEW`, even after successful
delivery and canonical transcript comparison. Missing editor access or incomplete required coverage
makes the overall result `FAIL`, with affected scenarios recorded as `BLOCKED`. Browser-harness tests,
host startup assertions, or a final screenshot cannot substitute for watching the stream.

## Default scope

1. Record the tested commit, existing worktree changes, run seed, controller session ID, and source
   workspace. Do not discard unrelated changes. Read the message-list identity, clipping, and
   scroll-ownership rules in [Message List Virtualization](message-list-virtualization.md).
2. Run the preflight below, then prepare three complementary historical responses from the requested
   workspace. Without an explicit source workspace, use the current project. Inspect coverage and
   selection reasons before launching the editor.
3. Run `STR-01` through `STR-03` with AI observation. Reuse a capture and seed when reproducing a
   failure. Each capture run has a fresh workspace/profile and stops its owned host before the next
   run. Do not start simultaneous hosts merely to parallelize scenarios.
4. Write `artifacts/ai-streaming/<run>/ledger.md` with the overall result at the top, scenario results,
   selection manifest, capture hashes, source IDs/model, observer identity, VS Code version, viewport,
   timing parameters, actions, failed boundaries, metrics, and cleanup evidence.

The default selection is a recommendation, not proof of scenario preconditions. If reasoning, edits,
large output, or enough visible history is missing, increase the selection count or ask for another
source scope. Do not silently claim unavailable content was exercised. Never generate new sessions
as a fallback without asking; that belongs to the live AI suite.

## Preflight

```sh
npm run build
node --test scripts/ai-streaming-selection.test.mjs scripts/ai-streaming-server.test.mjs scripts/ai-streaming.test.mjs scripts/ai-session-playback.test.mjs scripts/vscode-launch-process.test.mjs
npm run test -- src/webview/lib/streaming-pipeline.fuzz.test.ts
npm run test:e2e -- e2e/tests/scroll-streaming.spec.ts e2e/tests/scroll-tool-flicker.spec.ts e2e/tests/performance.spec.ts
```

Run the focused script command and the streaming unit/E2E suites for an unqualified request. Record
any scope reduction. After code changes also run the repository lint and type-check requirements.
Script tests use generated data; normal test discovery never reads the user's session database.

## Select history

```sh
npm run ai:streaming -- prepare \
  --source "$HOME/.local/share/opencode/opencode.db" \
  --directory "$PWD" \
  --controller-session <controller-session-id> \
  --seed <seed> \
  --count 3 \
  --output artifacts/ai-streaming/<run>/selection
```

Use the actual controller ID, not a placeholder inferred from recency. If it cannot be established,
ask before preparing. Directory matching is exact and does not include child or unrelated projects.
The selector opens the source SQLite database read-only and scans at most the latest 500 assistant
messages. It excludes the controller, sessions with incomplete assistant messages, and responses
without a same-session user parent. This is a persisted-history eligibility check, not a live-server
idle check. Do not select a session known to be active even if its latest stored message is complete.

Selection greedily adds weighted coverage for reasoning, text, tools, edits, large output, Markdown,
and baseline history above 50 messages. Seeded hashes break ties. The AI reviews these reasons and
checks that selected content actually exercises the requested UI. Stored message counts alone do not
prove more than 50 rendered rows, because Varro can group or hide rows.

The output contains `manifest.json`, a local `playback.db`, and `capture-<id>.json` files. The manifest
records selected/rejected IDs, coverage gaps, scan truncation, hashes, provenance, and durations.
Output files are created exclusively and are not overwritten. A shortfall or empty selection needs
explicit resolution before the suite can pass.

Historical imports contain one assistant message plus its user parent and up to 120 preceding
messages. They do not reconstruct an entire multi-message agent turn. Text/reasoning chunks use
synthetic 32 ms spacing; tool transitions use persisted timing. Command output may arrive as a single
terminal snapshot. These captures are labeled `HISTORY`, not exact live SSE recordings. Retained
live capture JSON in the same format can also be passed to `run` when exact delivered-event order
matters. Unsupported events or foreign child-session routing fail before playback.

Captures contain real prompts, outputs, and source snippets. Keep them in ignored local artifacts,
review for secrets before sharing, and do not upload them to an external watcher without permission.
Replay reads use unauthenticated loopback HTTP. Run only on a trusted local machine; artifact
permissions and the control token do not prevent another local process from reading the replay API.

## Launch and watch

Run one selected capture in a long-running terminal task. Build first; `run` does not build for you.
The current runner requires macOS or Linux with `ps` for owned-process cleanup. Windows is rejected
before launch and must be reported as blocked.

```sh
npm run ai:streaming -- run \
  --capture artifacts/ai-streaming/<run>/selection/capture-1.json \
  --output artifacts/ai-streaming/<run>/str-01 \
  --short-gap-ms 250 --max-gap-ms 500
```

The controller creates a disposable workspace and isolated profile, binds a loopback replay server,
and starts the real VS Code launcher. Bootstrap exposes an inert replay provider so onboarding does
not hide the transcript. All model, tool, edit, abort, delete, and other HTTP mutations are rejected.
Source session IDs are remapped; source sessions and source databases are never changed.

The command prints a private `control.json` path immediately and reports `phase: armed` after it has
opened the replay session in the exact Varro sidebar. The run's `run.json` identifies the host,
debugging endpoint, inner frame, session route, workspace, and profile. Use only those targets for
inspection and native input. An absent or ambiguous target is a failure, not permission to use the
production editor or a browser preview.

Attach the AI watcher before issuing `start`. The controlling AI can watch directly. If separate
watchers are available, assign one to streaming correctness and one to performance evidence; share
the exact target and planned actions. Only one controller sends input. The CLI does not spawn a model
or automatically award an AI verdict.

```sh
npm run ai:streaming -- status --control artifacts/ai-streaming/<run>/str-01/control.json
npm run ai:streaming -- start --control artifacts/ai-streaming/<run>/str-01/control.json
```

Start/status/stop requests authenticate with a token in the owner-readable control file. Defaults are
90 seconds for setup, five minutes for watcher attachment, and ten minutes for playback. Override with
`--setup-timeout-ms`, `--start-timeout-ms`, or `--replay-timeout-ms`. Start is single-use. If a watcher
misses a boundary, run a fresh copy rather than resetting state while the stream is active.

Stop only the owned run when needed:

```sh
npm run ai:streaming -- stop --control artifacts/ai-streaming/<run>/str-01/control.json
```

If editor automation is unavailable, attempt the real launcher and inspect diagnostics, then ask
whether the user wants to enable automation, perform the specified native actions while the AI
observes, or stop with `FAIL`. Do not leave a host waiting indefinitely.

## Timing contract

Gaps of 250 ms or less keep their source spacing. Longer gaps are capped at 500 ms, never increased.
Thus 32 ms stays 32 ms, 300 ms stays 300 ms, and a 30-second idle wait becomes 500 ms. Both limits are
configurable, with `0 <= short-gap-ms <= max-gap-ms`. Events retain their order and zero-gap bursts.
Payload timestamps remain historical and are not rewritten into a fabricated model duration.

The server schedules against cumulative monotonic deadlines, not one AI/tool call per event. It
records scheduled and actual emission times plus lateness. OS scheduling and the extension's normal
batching can affect observed delivery. A compressed replay tests rendering under that schedule, not
original model latency or exact raw-SSE cadence. Do not equate wall-clock speedup with a UI performance
improvement. Re-run with the same capture hash, timings, host dimensions, and actions for comparison.
Zero-gap bursts yield in bounded batches so cancellation remains responsive. A subscriber with more
than 8 MiB of queued output fails explicitly rather than growing an unbounded buffer.

## Scenarios and oracles

| ID | Required content and actions | Watch for |
| --- | --- | --- |
| `STR-01` | Text/Markdown and reasoning. Start at latest, observe uninterrupted output through settlement. | Missing or duplicate chunks, transient disappearance, incorrect Markdown transitions, bottom-follow oscillation, stale busy/Worked state. |
| `STR-02` | Tool-heavy response with an edit and retained disclosure. Observe pending/running/completed transitions; expand a disclosure and recorded inline diff when available. | Duplicate activity, order swaps, one-frame collapse/reappearance, incomplete command output, tool-to-text transition jumps. |
| `STR-03` | Large output with verified virtualized history. Record a painted marker, detach using native wheel input during playback, resize, then return to latest. | Lost anchor, blank viewport, unbounded row mounts, freezes, input reversal, or follow resuming without user intent. |

Record native actions and their playback-relative offsets before performing them. Never use DOM
mutation, `.click()`, or assigned `scrollTop` as substitutes for input. When stream duration is too
short to reach a required action, select a longer capture or increase the long-gap cap and record it.
Short gaps still retain their timing. Do not complete active-stream actions after settlement and count
them as streaming coverage.

Use consecutive frame observation around reasoning, tool completion, diff expansion, and final-text
boundaries. Follow the clipping-aware painted-element rules in the AI/fuzzy playbook. A stable final
DOM does not excuse an intermediate flash. The built-in observer records mounted-row duplicates,
frame gaps above 50 ms, hidden frames, and long tasks when Chromium supports them. It is not a complete
painted-visibility, anchor, or flicker oracle. Inspect those visually and with read-only geometry.

`server-result.json` compares the in-memory server transcript with the expected capture and records
emission timing. It does not prove the client received or rendered every event. The watcher must
verify the final visible response and activity against the expected content, plus stream settlement.
`observer.json` contains frame evidence. Missing/hidden observation, zero sampled frames, truncated
samples, target loss, or unsupported long-task instrumentation must be reported, not silently ignored.

For performance, record the maximum frame gap, gaps over 50 ms, long-task count/duration, scheduler
lateness, and visible input responsiveness. A gap above 100 ms or a long task above 100 ms requires a
same-capture reproduction and attribution to rendering, host load, or instrumentation before a pass.
Report measured values even when below those investigation thresholds. Do not call a synthetic or
single short-response run a long-session performance pass.

## Evidence and cleanup

The controller records launcher logs, launch metadata, the route, observer output, server result, and
cleanup errors. It handles stop requests, interruptions, setup deadlines, and playback deadlines. It
checks the owned host's process identity before signaling, waits for exit, and verifies the debug
port is closed. `launch-intent.json` records recovery identifiers before launch handoff. If an
interrupted launch cannot be resolved to a host, cleanup is reported as unverified, not successful.
Control endpoints close when the run ends; inspect artifact files afterward.
Workspaces/profiles remain on disk for diagnosis and their paths are recorded. Delete only those
recorded temporary directories if artifact cleanup is requested. Never abort/delete a source or
controller session, and never bulk-kill VS Code processes.

Before the final report, verify every launched host stopped and every run reached a terminal state.
Any cleanup error must be prominent, with exact remaining IDs/paths. Write watcher verdicts separately
from the runner's `NEEDS_AI_REVIEW`. Lead the ledger and report with failures and reproduction steps,
then list passes, blocked coverage, timing provenance, and artifact paths.
