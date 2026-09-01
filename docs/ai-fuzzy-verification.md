# AI Fuzzy Verification In VS Code

> [!IMPORTANT]
> An AI test run passes only when the requested scenarios run in a real, interactable VS Code
> Extension Development Host. If VS Code cannot be launched or controlled, GPT Luna or Terra cannot be
> used, required sessions cannot be prepared, or any real-editor scenario cannot reach its precondition,
> the **overall AI test result is `FAIL`**. Automated preflight results may still be reported as supporting
> evidence, but they cannot make the AI test pass. Put this overall result at the top of the run ledger
> and final report.

This playbook verifies Varro in a real VS Code Extension Development Host using AI-generated
transcripts and replayable, seed-driven interaction sequences. It targets timing, layout, and visual
failures that deterministic browser fixtures or Extension Host API tests can miss.

Use this playbook when the user asks to **Run AI tests** or **Run fuzzy tests**. The phrases are
aliases. Unless the user narrows the scope, run the standard suite defined below and report every
scenario as `PASS`, `FAIL`, or `BLOCKED`.

This is exploratory verification, not a replacement for deterministic tests. Any failure found here
must be reduced to the smallest repeatable action sequence and, when practical, preserved as a unit or
Playwright regression.

## Test Boundaries

Varro has three relevant verification environments:

| Environment | What it proves | What it does not prove |
| --- | --- | --- |
| Vitest | State, protocol, and geometry logic under controlled timing | Real Chromium painting, VS Code webview sizing, or native input ordering |
| Playwright harness | Webview DOM, animation frames, fixtures, and measurable geometry | Extension Host lifecycle or the exact VS Code container |
| VS Code sandbox or Extension Development Host | Real editor chrome, webview container, desktop mouse/wheel/keyboard event ordering, focus, reload, and live OpenCode streaming | Deterministic internal geometry unless separately instrumented |

`npm run test:vscode-sandbox` currently covers disposable host startup and recovery. It does not
inspect the webview DOM. Do not report it as a real-editor virtualization pass.

Read [Message List Virtualization](message-list-virtualization.md) before running or interpreting
message-list scenarios. Visible row position is the user-facing truth; a changed `scrollTop` alone is
not a defect.

## Trigger Contract

For an unqualified **Run AI tests** or **Run fuzzy tests** request:

1. Check the worktree and record the tested commit plus existing uncommitted changes. Do not discard
   or modify unrelated changes.
2. Run the automated preflight and the standard real-editor scenarios `AI-01` through `AI-08`.
3. Use `openai/gpt-5.6-luna` for repeatable synthetic height streams and GPT-5.6 Luna or GPT-5.6 Terra
   for realistic reasoning, tool, and edit workflows. Terra is explicitly allowed and preferred when
   it produces more representative multi-step repository work. Record the exact provider/model for
   every scenario and do not silently change models during a reproduction because output length,
   reasoning cadence, tool concurrency, and timing are test inputs.
4. Use a fresh run seed and record it before taking any actions. Reuse the same seed when reproducing
   a failure.
5. Save a run ledger under `artifacts/ai-fuzzy/<timestamp>-<seed>.md`. `artifacts/` is intentionally
   ignored by Git.
6. Roll back and verify every run-created change in `tmp/opencode` using the fixture cleanup contract.
7. Delete every temporary session created by the run, following the cleanup contract below.
8. Report failed invariants and reproduction steps first, followed by passes, blocked checks, model,
   VS Code version, viewport/layout, seed, and artifact paths.
9. A standard run is incomplete if it streams only synthetic prose or Markdown. It must include a
   realistic repository task in `tmp/opencode` that produces reasoning, separate tool calls, file edits,
   test output, diffs, and final response text while the UI is observed for frame-level flicker.

### Controller Session Safety

The Varro session handling the **Run AI tests** request is the controller session, not a disposable
test fixture. Never call OpenCode's session abort or delete endpoints for the controller session,
including through `curl`, scripts, or another tool. Do not abort the controller to recover an
unresponsive test host or to stop a command launched by the controller; doing so immediately aborts
the AI test run itself and can leave its child processes orphaned.

Use the dedicated host process recorded in its launch metadata to recover a failed Extension
Development Host. A raw session abort is allowed only after all of these checks succeed:

1. Fetch the target session and verify that its title starts with the current run's exact `VFZ <seed>`
   prefix.
2. Verify that the target session belongs to the dedicated test host and is not the controller
   session receiving the user's request.
3. Record the target session ID and the reason for aborting it in the run ledger before sending the
   abort.

If any check cannot be completed, leave the session running, mark the affected scenario `BLOCKED`,
and continue with cleanup that targets only the recorded dedicated host PID. Never infer an abort
target from the currently active session, a recent transcript, or a session ID copied from the
controller UI.

### Temporary Session Cleanup

Track the exact ID of every root or child session created while preparing or running the test. Before
writing the final ledger or report, delete every session created by the run, including failed setup,
reproduction, recovery, and generated child sessions. Perform this cleanup for `PASS`, `FAIL`, and
`BLOCKED` runs, and verify that the recorded IDs no longer appear in the active session list.

Apply the controller-session identity checks above before every deletion. Delete only IDs recorded as
created by the current run whose root title starts with the current run's exact `VFZ <seed>` prefix.
Never delete the controller session, a reused prepared session, or any unrecorded session. Do not use a
bulk delete or empty-trash operation because the trash may contain unrelated user sessions. If session
deletion is soft, permanently delete only the individually identified run-created roots from the
trash. Record deleted IDs, verification, and any cleanup failure in the ledger. A cleanup failure does
not change scenario evidence, but it must be reported prominently with the remaining session IDs.

### Repository Fixture Safety

Realistic tool and edit scenarios run against the OpenCode fixture at `<varro-root>/tmp/opencode`,
never against the Varro source worktree. The model may inspect, edit, and test OpenCode so Varro renders
real reasoning, tools, patches, changed-file summaries, and command output without risking the code
under test.

1. From the Varro root, prepare the fixture before launching the host:

   ```sh
   test -d tmp/opencode/.git || git clone https://github.com/anomalyco/opencode.git tmp/opencode
   git -C tmp/opencode status --short
   git -C tmp/opencode rev-parse HEAD
   ```

2. Require a clean fixture before a model is allowed to edit. If `tmp/opencode` has pre-existing tracked,
   staged, or untracked changes, do not reset, clean, stash, overwrite, or include them in the test. Ask
   the user to preserve them or provide a clean fixture, then mark realistic edit scenarios `BLOCKED`
   if a clean baseline cannot be obtained.
3. Record the baseline commit and every path created, modified, renamed, or deleted by the run. Prompts
   must forbid commits, branch changes, dependency upgrades, generated dependency trees, and edits
   outside the fixture.
   After any live prompt that could edit the fixture, the controller must atomically record the current
   fixture commit, short status, and exact changed-path list before every exit. This includes CDP,
   webview, server, action, and result-oracle failures. Evidence capture never resets, restores, cleans,
   or otherwise changes the fixture.
4. Launch the Extension Development Host with the fixture as its workspace while loading Varro from
   the Varro source tree:

   ```sh
   VARRO_AI_WORKSPACE="$PWD/tmp/opencode" npm run ai:vscode
   ```

   The printed launch metadata must show `tmp/opencode` as `workspace`. Opening Varro itself as the
   editable workspace does not satisfy realistic edit scenarios.
5. After the last scenario and before final session/host cleanup, roll back only paths recorded as
   changed by the run. Restore tracked paths from the recorded baseline and remove only run-created
   untracked paths. Never use `git reset --hard`, `git clean`, bulk deletion, or a broad restore that
   could erase unrelated work.
   A path-scoped cleanup may use `git restore --source=<baseline> --staged --worktree -- <recorded-paths>`
   for tracked paths, followed by individual removal of exact run-created untracked paths.
6. Verify `HEAD` still equals the recorded baseline and `git status --short` is empty. A model commit,
   an unknown changed path, or any residual change is a cleanup failure and must be reported prominently;
   do not guess at recovery. Also verify that the AI run created no changes in the Varro source worktree;
   never revert unrelated Varro changes made by the user or another agent.

If credentials, a GUI, or Luna/Terra are unavailable, continue with every feasible automated check and
mark the affected real-editor scenarios `BLOCKED`, but report the overall AI test as `FAIL`. Never turn
a blocked visual check into a pass or describe an automated-only run as a successful AI test.

## Automated Preflight

Build first, then verify the deterministic contracts nearest to the fuzzy scenarios:

```sh
npm run build
npm run test -- src/webview/components/MessageList
npm run test -- src/webview/components/message-list/virtualization.test.ts
npm run test:e2e -- e2e/tests/scroll-auto-scroll.spec.ts
npm run test:e2e -- e2e/tests/scroll-streaming.spec.ts
npm run test:e2e -- e2e/tests/scroll-viewport-coverage.spec.ts
npm run test:e2e -- e2e/tests/layout.spec.ts
npm run test:e2e -- e2e/tests/settings.spec.ts
npm run test:e2e -- e2e/tests/performance.spec.ts
npm run test:vscode-sandbox -- healthy-first-run
```

Run `npm run lint:check` and `npm run typecheck` when the request follows code changes in the affected
area. A narrower requested scope may use only the directly relevant suites, but the ledger must state
what was omitted.

## Real Editor Setup

1. Prepare the clean `tmp/opencode` fixture under Repository Fixture Safety, then run
   `VARRO_AI_WORKSPACE="$PWD/tmp/opencode" npm run ai:vscode` to build Varro and launch a persistent,
   isolated Extension Development Host. Use the printed profile and workspace paths in the ledger. This
   avoids reusing a normal VS Code singleton and uses a short temporary profile path that stays below
   the macOS IPC socket-path limit. On macOS the host starts hidden in the background so launch and setup
   do not steal focus; reveal it only when the real-editor interactions are ready to begin. A manually
   launched **VS Code Extension Development** window is acceptable only when its editable workspace is
   the clean `tmp/opencode` fixture and the current environment can reliably control it. Opening Varro
   itself in the test host does not satisfy AI-07 or AI-08.
   Reuse this host for the complete run. After rebuilding Varro, reload the same Extension Development
   Host instead of running `npm run ai:vscode` again. Launch another isolated host only when a scenario
   explicitly requires a fresh cold profile. Close the previous test host first unless simultaneous
   hosts are strictly required by the scenario.
2. Use a dedicated Extension Development Host window. Do not use a production Varro window that has
   unrelated sessions or settings.
3. Open the Varro view and explicitly select GPT Luna or GPT Terra. Use Luna for controlled text-height
   streams and Luna or Terra for realistic repository work; record the exact provider/model per scenario.
   Apply and verify this selection before every live scenario, not only duplicate-delivery checks.
4. Start with the secondary sidebar between 430 and 500 CSS pixels wide and the window at least 800
   CSS pixels high. Record window size, zoom, sidebar side, panel visibility, theme, and font scaling.
5. Use a new Varro session titled `VFZ <seed>` unless the scenario requires reopening a prepared long
   session.
6. Observe the complete run directly in the tracked Extension Development Host. Record the scenario,
   step, marker, and preceding actions immediately when a suspected failure occurs and again after
   settling. Screenshots are optional supporting evidence, not pass preconditions.
   A marker is an exact painted DOM element whose bounding rectangle, after intersection with every
   clipping ancestor and the transcript scrollport, intersects the viewport. A raw descendant rectangle
   outside an `overflow: clip` entrance wrapper is not painted evidence. Capture and reuse that element's
   stable message ID plus render key or a uniquely identifying descendant. If Varro preserves a
   different visible render item during reflow, record both identities and do not infer a jump from movement of the
   containing row or an adjacent card.
7. Keep DevTools closed for the first pass because docking changes webview dimensions. Use it only for
   diagnosis or metric capture, and record that the run became instrumented.
8. Record every test host PID, profile path, workspace path, and debugging endpoint when it is launched.
   Verify that the workspace shown by launch metadata is `tmp/opencode`. Before writing the ledger or
   final report, terminate every Extension Development Host launched by the run and verify that its
   process and debugging endpoint have stopped. Delete run-created temporary sessions before terminating
   the final host. Never leave persistent test hosts open.
9. When more than one Varro iframe exists, enumerate all matching CDP targets and inspect
   `__initialWebviewState.webviewContext`. Select the requested `surface`, stable `viewId`, and session
   route. An absent or ambiguous match is a failure. Never choose the first matching iframe. After an
   editor hides, reveals, or reloads, bind its recreated iframe by the same `viewId`.

The existing F5 host can preserve extension state. For cold-load checks, close the Extension
Development Host, start it again, and do not warm the target session by opening or scrolling it first.
For onboarding isolation, use `npm run test:vscode-sandbox`; that runner exits after host assertions and
is not the interactive geometry environment.

### When VS Code Is Blocked

Do not stop after noticing that no Extension Development Host is already running. Attempt recovery in
this order:

1. Run `VARRO_AI_WORKSPACE="$PWD/tmp/opencode" npm run ai:vscode` and verify that a window titled
   `[Extension Development Host]` appears.
2. If launch fails, inspect the command output and running processes. On macOS, an IPC socket error such
   as `longer than 103 chars` means the user-data path is too long; use the launcher rather than a long
   hand-written `--user-data-dir`. A regular VS Code window without the development-host title usually
   means the existing VS Code singleton consumed the request; use the launcher's isolated profile.
3. Verify that the available automation mechanism identifies the exact isolated VS Code process and
   Varro webview, then can issue desktop mouse clicks, wheel events, keyboard events, scrollbar drags,
   and resize events to that target. These are desktop input events, not touch gestures. They may be
   delivered through OS desktop automation or Chromium/Electron input dispatch bound to the exact
   tracked VS Code webview. Browser access to an unrelated preview page is not VS Code access.
4. If the host launches but desktop mouse/keyboard event automation cannot control it, ask the user
   before ending the run:
   **"The Extension Development Host is running, but I cannot control its VS Code window. Would you
   like to enable/approve editor automation, perform the listed native actions while I record results,
   or stop and record the AI test as failed?"**
5. If credentials, GPT Luna/Terra, a clean `tmp/opencode` fixture, required prepared history, or another
   precondition needs user action, ask one concrete question describing the missing prerequisite and
   the available choices.
6. If the user stops, declines, or the problem remains unresolved, mark affected scenarios `BLOCKED`
   and the overall AI test `FAIL`. Preserve diagnostics and the recovery attempts in the ledger.

`npm run test:vscode-sandbox -- healthy-first-run` is not a fallback for these steps. It launches a
real disposable Extension Host, performs host-side assertions through `--extensionTestsPath`, and exits
by design. A passing sandbox proves startup and recovery only; it does not provide the persistent,
interactable window needed by AI scenarios.

## Reproducible Fuzzing

Fuzzy means varied, not unrecorded. Generate choices with a deterministic PRNG seeded by the run seed.
If no helper is available, derive each choice from successive hexadecimal pairs in a SHA-256 hash of
`<seed>:<scenario>:<step>` and take the value modulo the option count.

Record every chosen action before performing it. Use these action sets:

| Dimension | Options |
| --- | --- |
| Wheel delta | `-32`, `-96`, `-180`, `96`, `180`, `420` |
| Pause after action | `0`, `1`, `2`, `4`, or `12` animation-equivalent frames |
| Width | `360`, `430`, `486`, `720` CSS pixels |
| Transcript key | `ArrowUp`, `ArrowDown`, `PageUp`, `PageDown`, `Space`, `Shift+Space`, `Home`, `End` |
| Content mutation | stream reasoning/text, start/complete tool, update todo, edit file, expand/collapse disclosure, toggle Thinking, open/close diff |
| Focus owner | transcript, composer, inline editor, diff, nested tool scroller, session list |

Throughout this playbook, `native` means an actual desktop-style browser/Electron input event delivered
to the exact tracked VS Code webview: mouse click, mouse wheel, key event, pointer drag, or workbench
resize. It does **not** mean literal hardware input, trackpad-only input, touch input, or a requirement to
move the visible macOS/Windows cursor. CDP `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` are
valid when they target the isolated Extension Development Host or its Varro iframe and produce the same
event path as desktop mouse/keyboard control.

Do not replace a wheel, keyboard, click, resize, or scrollbar input event with a DevTools evaluation
that assigns `scrollTop`, calls `scrollTo()`, invokes `.click()`, or directly mutates layout/state. The
ownership transition and browser event ordering are part of the test. DOM and CDP evaluation remain
valid for inspection and geometry sampling.

### Frame-Level Flicker Observation

Flicker is a regression, not cosmetic tolerance. Observe the complete streaming lifecycle, with special
attention to boundaries where Varro changes the projection of the same underlying content:

- Thinking starts, receives deltas, collapses, expands, moves into Explored, or becomes hidden
- parallel tools enter, complete out of order, become retained/exiting, group into Explored, or yield
  space to streamed text
- todo rows update or disappear while another tool or response is streaming
- file edits first appear, merge into a file stack, open as a diff, receive focus, and settle
- command output grows into or out of a nested scroller
- final prose begins after tools, the active tray disappears, and Worked replaces the trailing state

Sample consecutive animation frames before, during, and after each boundary. Track stable part/message
identities and bounding rectangles where possible, while also directly observing opacity, visibility,
order, duplicate mounts, and transient text. A one-frame disappearance and reappearance, stale label,
double render, order swap, collapsed gap, or surrounding-content shift fails the scenario even if the
same final DOM eventually returns. A final screenshot, settled geometry assertion, or successful model
response cannot by itself prove that flicker did not occur.

## Transcript Recipes

Prefix every generated prompt with a unique marker such as `[VFZ:<seed>:T07]`. Markers make visual
anchors and failed turns searchable after reload.

Synthetic payloads remain useful for deterministic height coverage, but they do not replace realistic
agent streaming. During the standard run, observe both a controlled text stream and an OpenCode task
that interleaves reasoning, tool starts/completions, file edits, test commands, diff rendering, and final
text. Sample every animation frame around each projection change; a transient wrong frame is a failure
even when the settled layout is correct.

### Varied Height Turn

Send this template, replacing the marker and rotating the requested form by seed:

```text
[VFZ:<seed>:T<number>] Respond with only the requested test payload. Use one of these forms:
1. one sentence;
2. 12 short numbered lines;
3. a 5-column markdown table with 14 rows;
4. two fenced code blocks of different languages plus a short explanation;
5. eight paragraphs whose lengths alternate between 8 and 90 words.
Do not summarize or omit rows. End with END-<number>.
```

### Controlled Text Stream

```text
[VFZ:<seed>:STREAM] Produce 80 numbered sections. Alternate a one-line section with a paragraph of
90-130 words, insert a 20-row markdown table after section 20, and insert fenced TypeScript and shell
blocks after section 40. Emit every section in order and end with VFZ-STREAM-END. Do not use tools.
```

### Tool And Activity Stream

```text
[VFZ:<seed>:TOOLS] Work only in the current OpenCode repository. Investigate one real, bounded code
quality or test-coverage issue, explain the approach in reasoning, inspect the relevant implementation
with three to five separate read/search operations, make the smallest justified edit to one to three
existing source or test files, and run a focused test plus any broader check warranted by the change.
Use parallel tool calls only for genuinely independent work. Do not pad activity with sleeps, no-op
commands, duplicate status calls, or deliberately slow work. Keep a todo list and continue producing
brief progress text between tool groups.
Open and review the resulting diff, fix any issue found by the checks, and finish with a concise report
containing VFZ-TOOLS-END. Do not commit, change branches, install or upgrade dependencies, generate
dependency trees, touch files outside this repository, or undo changes you did not make.
```

Choose a task that naturally exercises several content forms instead of instructing the model to emit
decorative Markdown. The timed observation must include all of these if the model supports them:

- visible Thinking/reasoning updates before and between tool groups
- parallel and sequential reads/searches with overlapping active items
- at least one real file edit followed by an inline file card or diff
- command output or concurrent activity when it occurs naturally
- a failed or corrective intermediate check when it occurs naturally; do not manufacture failures
- completion transitions from active tools into Explored/Worked plus final response text

Do not rely on one general prompt and then mark the scenario blocked. Use the bounded live controller
after opening the run fork in the dedicated host:

```sh
npm run ai:live -- run --manifest <manifest-path> --launch <launch.json> --scenario AI-07
npm run ai:live -- run --manifest <manifest-path> --launch <launch.json> --scenario AI-08
```

The controller allows three prompts by default and at most four when explicitly requested. Every prompt
is a new turn and must request the complete minimum gate set: a virtualized active stream, sticky marked
prompt, file edit and expandable diff when required, and retained disclosure. Retry prompts emphasize
gates that the previous turn missed, but never assume a gate from an
earlier turn carries into the new turn. It polls the real Varro DOM while the model is busy, begins native interaction as soon as
the gate is simultaneously true, verifies the nested-to-outer wheel handoff if a scrollable activity tray
occurs naturally, and executes AI-08's
recorded 50-action plan. It waits for bounded stream settlement and records the resulting fixture status
in the manifest so cleanup has exact changed-path evidence. Stop prompting as soon as the gate is reached.

Bounded AI-07 and AI-08 prompts must forbid subagents and delegation. The controller inventories the
root session's descendants before and after each scenario, records every new descendant, and fails the
scenario if one appears. Do not delete an unrecorded descendant or infer that it is disposable from its
recency.

After the retry budget, report the per-attempt missing gates and the first unavailable native action.
Do not use the generic explanation that actions "were not executed." `BLOCKED` is valid only when the
recorded recovery attempts exhausted their budget, the tracked host or session disappeared, a required
control truly was unavailable, or continuing would violate fixture safety. Never replace the realistic
task with injected DOM state or edits to Varro.

### Long Session Preparation

Virtualization starts above 50 message rows. Create at least 32 user/assistant turns with the varied
height recipe for ordinary virtualization. A real cold pagination run needs more than the production
200-message initial window. Prepare at least 110 completed turns in one session, preferably 210 turns
to cross two full boundaries. Compact outputs are acceptable except every tenth turn, which must use
a tall form.

Preparation may be performed before the timed run. Record the session ID or exact title, turn count,
model, and whether the history has ever been opened. Do not describe a 32-turn transcript as a
pagination test.

#### Reusable Golden History

Use the precondition helper instead of regenerating long history for every run:

```sh
npm run ai:preconditions -- prepare-run --seed <seed>
```

The helper validates a workspace-scoped `VFZ GOLDEN` session, forks it without opening it in the
webview, records the fork and a deterministic 50-action plan in an ignored manifest, and reports the
static gate for every scenario. If no valid golden exists, it creates one once with
`openai/gpt-5.6-luna` by default. Use `--golden <session-id>` to adopt and validate an older prepared
history. The source golden is never a run-created session and must not be deleted during run cleanup.

Static history can establish AI-01 through AI-06 cheaply. It cannot satisfy AI-07 or AI-08 by itself.
The manifest keeps those gates pending until the live stream proves the required edit, disclosure, and
virtualized state. Treat a failed static gate as setup work to repair or
regenerate before launching the timed scenario, not as a late scenario surprise.

After launching or restarting the dedicated host, verify that the fork survived into the exact server
instance before opening it in Varro:

```sh
npm run ai:preconditions -- verify-run --manifest <manifest-path>
```

This check reads the fork through the workspace-scoped REST API, validates its title and complete
history, checks the clean fixture commit, and leaves the webview cold for AI-05. A missing fork is a
setup failure to repair before timed interaction, not a scenario that should consume model budget.

After deleting any additional run-created sessions, clean the recorded fork with the exact manifest
path printed during preparation:

```sh
npm run ai:preconditions -- cleanup --manifest <manifest-path>
```

Cleanup fetches each recorded session, verifies the exact run title prefix, deletes only those IDs,
and verifies that they no longer appear in the scoped root-session list.

#### Scenario Recovery Budget

Preparation and execution are separate states. A scenario whose static gate passes is not allowed to
remain incomplete merely because the next native action was not attempted.

1. Re-establish cheap deterministic state, such as latest position, detached midpoint, sticky prompt,
   or prompt-number visibility, with the recorded seed.
2. Retry a failed native targeting action once after refreshing read-only geometry. Do not retry a
   correctly targeted action that exposed a product invariant failure.
3. If an active stream settles too early, start at most two fresh bounded streams with the same seed.
   AI-07 and AI-08 use the targeted live controller above instead of repeating the full general prompt.
4. End as `BLOCKED` only with a concrete terminal condition and the attempts made. Examples are a
   missing control after reload, a model that settled after all prompt attempts without the required
   content, or a nested tray that never gained real scroll range.

This budget is intentionally small. It removes avoidable setup misses without turning fuzzy verification
into an unbounded model loop or hiding genuine failures.

## Standard Scenarios

Run `AI-01` through `AI-08` for the default trigger. Start each scenario from its stated precondition,
record every fuzzy choice, and preserve the first failing sequence without improvising around it.

### AI-01 Virtual Range And Height Bootstrap

Precondition: a completed 32-turn varied-height session, opened at the latest message.

1. Confirm the latest response and its `END-<number>` marker are painted.
2. Slowly wheel upward for 20 seeded steps, pause, then wheel downward for 20 seeded steps.
3. Drag the native scrollbar to approximately 25%, 75%, and 50% in that order.
4. Hold `Alt` or `Option` to expose prompt numbers and verify their ordering at each location.
5. Return to the bottom with the visible jump-to-latest control when available.

Pass invariants:

- The viewport is never blank and the scrollbar thumb does not collapse or grow discontinuously.
- Rows do not overlap, duplicate, reorder, or leave persistent empty gaps.
- A marker under observation moves only with the requested gesture; it does not jump again while
  settling.
- Prompt numbers increase toward the latest turn and do not change for the same marker.
- The latest marker is reachable and fully painted.

### AI-02 Height Reflow And Invalidations

Precondition: the same session, detached near the middle with a marker at a recorded viewport offset.

1. Resize the sidebar through the seeded width sequence, including `360` and `720` CSS pixels.
2. Toggle the VS Code bottom panel and primary sidebar twice.
3. Change VS Code zoom out one step, back to the original zoom, then in one step and back.
4. Toggle `/thinking`, expand a Thinking or Explored disclosure, and toggle inline file previews if
   those controls are present.
5. Scroll one viewport down using `PageDown`, then resize once more while settling.

Pass invariants:

- The recorded marker remains visually fixed during reflow until direct movement requests a new
  destination.
- The recorded marker must be the same painted element before and after reflow. Movement of a row box
  is not a failure when wrapping above the actual visible anchor changes that row's geometry while the
  observed anchor element remains fixed.
- Wrapped text, code, tables, diffs, and tool cards are neither clipped nor overlapped.
- No stale blank row appears after changing a setting that alters offscreen heights.
- Native `PageDown` reaches a new destination and a later resize does not undo it.
- Mounted content remains responsive; no multi-second freeze or full transcript flash is visible.

### AI-03 Sticky Prompt Selection And Navigation

Precondition: at least three marked prompts followed by tall answers. Include one normal text prompt
and, when available, prompts containing an image, editor context, and terminal selection.

1. Place the source prompt just above the viewport and confirm its sticky preview appears.
2. Slowly approach the next prompt with small seeded upward and downward wheel deltas.
3. Verify the sticky yields before touching or covering the next real prompt.
4. Click the sticky preview and observe the entire settling period.
5. Click the aligned real card to enter inline editing, then use a nested attachment or tool scroller.
6. Repeat for each available attachment kind.

Pass invariants:

- Sticky text and attachment metadata belong to the same marked source prompt.
- The overlay never covers the next prompt and does not flicker between prompt identities.
- Clicking aligns the real user card to the sticky gap, not an attachment summary or estimated row.
- The target remains fixed after settling; clicking it transfers ownership to editing without a second
  navigation jump.
- Wheel input in a nested destination scroller cancels sticky settling without stealing outer scroll
  when the nested scroller can consume it.

### AI-04 Navigate By Prompt Number

Precondition: the long session has complete prompt-number history.

1. Hold `Alt` or `Option` until absolute prompt badges appear.
2. Record three target numbers selected by seed: one near the beginning, one near the middle, and one
   in the newest window.
3. If the conversation-turn navigation controls are hidden at the baseline narrow width, widen the same
   tracked sidebar until they appear (currently at least `1100` CSS pixels). Keep the same surface,
   `viewId`, and session route, and record both widths.
4. Use the visible prompt-number navigation behavior to visit each target, including an unloaded old
   target when the UI offers it.
5. During one settle, click or wheel at the destination to cancel programmatic ownership.
6. Navigate back to the newest selected prompt, then restore the baseline narrow width.

Pass invariants:

- Every target resolves to the prompt with the matching stable marker and badge.
- Loading remains visibly associated with the requested target and cannot be cleared by an obsolete
  request.
- Final alignment is to the real prompt card and remains stable for two seconds.
- User input cancels settling immediately and is not reversed by a later frame.

If the current UI exposes prompt numbers but no direct numbered navigation action at any supported
width, mark the direct navigation step `BLOCKED`, verify badge stability and sticky click navigation,
and record the missing interaction rather than inventing one. Do not mark the step blocked only because
responsive layout hides the controls at the baseline narrow width.

### AI-05 Cold Scroll To Real Top

Precondition: a prepared session with more than 200 messages. The target Extension Development Host
has just started, and this session has not been opened in that host run.

1. Open the session and wait at the latest message without scrolling upward.
2. Begin direct observation, then use only desktop pixel-wheel events between 32 and 96 pixels upward.
   OS mouse automation or CDP mouse-wheel dispatch to the exact Varro webview is valid; touch events and
   direct scroll-position mutation are not.
3. At each history boundary, keep one marked row under observation through loading and insertion.
4. Continue through every boundary until the real first prompt and history-start state are visible.
5. Scroll down one viewport, close the session, and reopen it to verify the loaded history remains
   coherent. To repeat the first cold boundary, use a second fresh host or an untouched prepared fork
   with the same action seed; the same webview runtime intentionally caches loaded history.

Pass invariants:

- The observed marker preserves its viewport position while older pages prepend. A scrollbar
  coordinate change by itself is allowed.
- Every request boundary makes progress without requiring a scroll away and back.
- No blank viewport, stale placeholder, full-list flash, repeated page, or skipped marker appears.
- The first prompt is reachable and the history banner disappears at the true beginning.
- The replay follows the same marker order, even if response latency differs.

### AI-06 Controlled Streaming And Bottom Follow

Precondition: the 32-turn session is at the bottom.

1. Send the controlled text stream recipe with Luna or Terra and make no input for the first 20 visible
   sections.
2. Wheel upward beyond one viewport while the model is still streaming and record a visible marker
   offset.
3. Wait for 10 more sections, then scroll slowly farther upward.
4. Return near the bottom with downward wheel input, then use jump-to-latest if shown.
5. While pinned, send one small downward wheel tick and let the stream complete.

Pass invariants:

- Before detachment, the latest streamed content remains visible without oscillation.
- After upward input, streaming below the viewport does not move the recorded marker.
- Programmatic follow never reverses an upward user gesture on a later frame.
- Genuine downward movement near the bottom re-engages follow; zero-delta or layout-only movement does
  not.
- The final `VFZ-STREAM-END` marker is reachable and the trailing Thinking/Worked area does not double
  mount or leave a permanent gap.
- No streamed paragraph, code block, table, Thinking block, status label, or trailing summary disappears,
  reappears, swaps order, or flashes in a different projection for even one sampled frame.

### AI-07 Activity, Tools, And Sticky Streaming

Precondition: the Extension Development Host workspace is the clean `tmp/opencode` fixture, the session
is virtualized, and the latest user prompt can become sticky. The live turn must produce real reasoning,
tool activity, a file edit, and a retained disclosure. A scrollable active tray is optional because Luna
and Terra may serialize otherwise independent tool calls. AI-16 owns required live nested-scroller
stress. The deterministic layout suite always verifies native-style nested-to-outer wheel ownership.

1. Send the realistic tool and activity recipe using Luna or Terra. Record the clean fixture baseline
   and every changed path before timed interaction continues.
2. Keep the source prompt just above the viewport while reasoning text and tool cards appear.
3. Expand an activity disclosure when available and wheel the outer transcript. If the active tray has
   real scroll range, also verify nested-to-outer wheel ownership before continuing.
4. Let at least two tool operations complete while detached from the bottom.
5. Return to the bottom before the final tool completes and observe the transition into Explored or
   Worked.

Pass invariants:

- The sticky prompt remains the same marked prompt throughout unrelated activity height changes.
- Active items do not duplicate, disappear before completion, or replay entrance animation after a
  virtual remount.
- When a scrollable active tray occurs, nested wheel movement stays local while possible and outer
  movement immediately takes ownership when requested.
- A detached visible marker remains fixed through completion and grouping.
- At the bottom, disappearing activity space is replaced without a one-frame jump and releases after
  streamed content consumes it.
- Thinking, active items, completed items, file cards, diffs, Explored, Worked, and final text never
  disappear and reappear, render twice, swap order, or flash through a stale intermediate projection.
- Every run-created OpenCode edit appears in the expected file/diff UI and remains stable while tool
  completion and response text stream around it.

### AI-08 Seeded Mixed-Ownership Fuzz

Precondition: an active Luna or Terra realistic repository stream in a virtualized session with at
least one file edit and one expandable disclosure.
AI-08 also requires a successful recorded AI-07 preparation. Its current fixture commit, status, and
exact changed paths must equal AI-07's exit evidence. A generically clean fixture does not bypass this
precondition.

Generate and record all 50 seeded actions before starting the stream. Reserve an early position for the
session switch so the model cannot normally finish before that action.
Perform exactly those 50 actions and ensure the sequence contains at least one of every category:

- upward and downward wheel input
- `PageDown`, `Space`, and `Shift+Space` on the transcript
- the same keys while the composer is focused; settled inline-edit coverage belongs to AI-03 and AI-10
- sidebar width resize
- disclosure expansion and collapse
- file-card and diff expansion, focus, and collapse
- sticky click or jump-to-latest
- session switch away and back
- outer transcript movement after disclosure interaction

An unavailable or mis-targeted action does not count toward the 50. If the model settles before every required active-stream
action, restart the scenario with the same seed and a fresh realistic stream rather than completing the
sequence against settled content.

Scope disclosure, diff, file-card, and activity actions to message IDs, part IDs, and render keys from
the current marked turn. Count an action only after its pre/post samples prove the intended effect, such
as changed expansion state, correct focus owner, transcript movement, or measured
width. A successfully dispatched mouse or key event is not an executed action by itself.

Pass invariants:

- The transcript-scrolling keys move the transcript only when focus is outside editable controls.
- No prior owner later reverses the most recent direct user destination.
- Session switching never mixes messages, sticky previews, loading states, or streaming status.
- Focus remains usable and the composer accepts input after the sequence.
- The viewport has painted rows at all times and returns to a coherent latest state.
- No content form flickers during the sequence, including Thinking, todo updates, activity trays,
  inline edits, changed-file summaries, diffs, command output, streamed prose, and Worked state.

On failure, stop the random sequence. Save the exact action prefix, then replay only that prefix from
the scenario precondition with the same seed. Use delta debugging: remove contiguous halves of the
prefix until removing any remaining action makes the failure disappear.

## Extended Scenarios

Run these when the changed area, observed behavior, or user request calls for them.

| ID | Scenario | Required when |
| --- | --- | --- |
| `AI-09` | Async image load and remount | Attachments, row measurement, image preview, or sticky image behavior changed |
| `AI-10` | Inline edit, delete, and replacement | Inline editing, optimistic messages, append transitions, or navigation ownership changed |
| `AI-11` | Diff expansion and editor focus | File changes, diff previews, disclosure anchoring, or bottom follow changed |
| `AI-12` | Thinking visibility while offscreen | Thinking, activity grouping, settings invalidation, or width batching changed |
| `AI-13` | Parent/child agent streaming during history prepend | Subagents, session reconciliation, pagination, or attention state changed |
| `AI-14` | Theme, font, high contrast, and DPI reflow | Typography, CSS, icons, scrollbar geometry, or VS Code theme integration changed |
| `AI-15` | Abort, reconnect, and reload during streaming | Transport, abort, persistence, server lifecycle, or busy state changed |
| `AI-16` | Huge code, table, terminal, and nested scrollers | Markdown, tool cards, terminal attachments, or wheel ownership changed |
| `AI-17` | Duplicate delivery during send and streaming | Webview bridge startup, listener lifecycle, optimistic messages, or event delivery changed |
| `AI-18` | Multi-webview editor tabs and queue ownership | Editor chat tabs, cross-webview state, queue ownership, title routing, or inline-file settings changed |
| `AI-19` | Permission and queued-edit lifecycle | Permission modes, manual steering, editor hide/reveal, queued editing, or ownership transfer changed |

For each extended scenario, combine the named mutation with `AI-02` reflow, `AI-06` detached
streaming, the realistic `tmp/opencode` workflow when tools or edits are relevant, and the ownership
invariants relevant to the changed component.

### AI-17 Duplicate Delivery During Send And Streaming

Precondition: a dedicated Extension Development Host with a prepared run session open at the latest
message and Luna or Terra selected.

Run the frame-level duplicate oracle through the live controller:

```sh
npm run ai:live -- run --manifest <manifest-path> --launch <launch.json> --scenario AI-17
```

The controller reloads the Extension Development Host through the native command palette, reconnects
to the recreated Varro iframe, sends one marked prompt through native composer input, requests 21
unique tokens, and samples the real Varro DOM on every animation frame until the stream settles.
Use `--restart-count <1-10>` to perform consecutive workbench reloads before the single observed send
when investigating listener or state accumulation across restarts.

Pass invariants:

- The marked user prompt appears in exactly one user row in every sampled frame after it first appears.
- The response occupies exactly one assistant row in every sampled frame.
- Every required token appears, and no token appears more than once in any sampled frame.
- The stream enters busy state, settles, and does not modify the repository fixture.
- Canonical session history contains exactly one marked user and exactly one assistant whose
  `parentID` is that user. The assistant has `finish: stop`, a completion time, and no error.
- Canonical assistant text contains every requested token exactly once and in the requested order.

### AI-18 Multi-Webview Editor Tabs And Queue Ownership

This extended scenario covers unpublished multi-webview editor functionality. Run it through the live
controller:

```sh
npm run ai:live -- run --manifest <manifest-path> --launch <launch.json> --scenario AI-18 \
  --surface sidebar --view-id sidebar --model openai/gpt-5.6-luna
```

Precondition: AI-07 completed successfully and the fixture still has AI-07's exact recorded commit,
status, and changed paths. The prepared root session is openable in the sidebar. The controller creates
and inventories one child session for route testing. Cleanup must remove that run-created child and
verify its recorded ancestry.

The controller records its deterministic plan before acting, then performs these operations through the
real webviews and native VS Code workbench commands:

1. Select the sidebar by `surface=sidebar`, `viewId=sidebar`, and the prepared root route.
2. Select and verify the requested Luna or Terra model and permission mode in the sidebar.
3. Open the root in a chat editor, record its stable editor `viewId`, then route the child and root through
   that same editor. Verify the editor title and transcript route each time.
4. Start a real root stream. Queue marked turns from the sidebar and editor while that stream remains
   active, recording source view IDs, queue item IDs, displayed counts, and enqueue order.
5. Hide the editor with a native workbench command, verify ownership transfers to another ready view,
   reveal it through the real session UI, and bind the recreated iframe by its stable `viewId`.
6. Toggle Hide and Show File Diffs through the command palette and sample the current turn's
   actual file-change rendering before and after each command.
7. Reload the workbench, restore and rebind the editor by `viewId`, and sample marked rows for duplicate
   delivery. Close the editor while queued work remains and verify the final handoff.
8. Wait for ordered dispatch and settlement. Compare canonical messages with the recorded queue order,
   sample both session routes for leakage, verify queue counts, and focus the surviving composer.

Pass invariants:

- Sidebar and editor evidence names the requested `surface`, stable `viewId`, and session route. No target
  selection is ambiguous or based on target-list order.
- Opening, revealing, reload restoration, root title routing, and child title routing all use real editor
  panels and preserve the editor `viewId`.
- Model and permission mode remain synchronized across the sidebar and editor.
- At least two distinct view IDs enqueue during a real stream. Hidden and closed editor handoffs preserve
  every item and dispatch claim.
- Canonical marked users and linked assistants appear exactly once in recorded enqueue order. Displayed
  queue counts equal the recorded queue and reach zero after dispatch.
- Root content never appears in the child route, and child content never appears in the root route.
- Inline file changes hide and return on the exact current-turn file card.
- Reload sampling finds no duplicate marked user or assistant rows, and the surviving composer accepts
  focus and input.

### AI-19 Permission And Queued-Edit Lifecycle

Run the focused lifecycle controller with Luna or Terra:

```sh
npm run ai:live -- run --manifest <manifest-path> --launch <launch.json> --scenario AI-19 \
  --surface sidebar --view-id sidebar --model openai/gpt-5.6-luna
```

Precondition: AI-07 completed successfully and the fixture still matches AI-07's exact recorded state.

The controller opens the same root in the sidebar and an editor, changes permission mode from each
surface, starts a real stream, pauses and edits an editor-owned queue row, hides the editor, and sends
the transferred paused row manually as a steer from the sidebar. It then reveals the same editor by its
stable `viewId` and checks the composer and canonical session history.

Pass invariants:

- A sidebar permission change reaches the editor, and a later editor permission change reaches the
  sidebar.
- The queue row retains its exact ID, owner, paused state, and edit content through the hide handoff.
- Manual steer dispatch removes the paused transferred row and creates exactly one canonical user and
  one valid linked assistant.
- Revealing the same editor does not restore the removed queued edit as an ordinary composer draft.
- The model remains exact, no descendant session appears, and the repository fixture remains unchanged.

## Failure Oracle

Treat any of the following as a failure even if the final screen settles correctly:

- Any one-frame flicker, flash, disappearance/reappearance, duplicate projection, stale projection, or
  order swap in streamed content. This includes Thinking, todo items, active/retained/exiting tools,
  Explored/Worked summaries, inline file cards, diffs, command output, Markdown, and final response text.
- A tool-to-Explored, reasoning-to-text, edit-to-diff, or streaming-to-Worked handoff briefly collapses
  space and shifts surrounding content before restoring it.
- A marked row visibly jumps without matching direct input.
- Content reverses the direction of a mouse-wheel, keyboard, pointer-drag, or scrollbar input.
- A frame shows a blank viewport, overlapping rows, duplicate rows, or the wrong sticky prompt.
- Sticky navigation lands on the wrong card, overlaps the next prompt, or resumes after destination
  interaction.
- Streaming steals a detached viewport or fails to follow while genuinely bottom-pinned.
- A disclosure, image, diff, font, or width change leaves stale empty space or clips content.
- History loading repeats, stalls, skips markers, or makes the real top unreachable.
- Session switching leaks messages, activity, permissions, sticky state, or pending navigation.
- The webview freezes for more than two seconds during ordinary input, excluding a known model or
  network wait that leaves the UI responsive.

A visual suspicion is not yet a root cause. Preserve the observation time, marker, preceding actions,
and layout. Capture a screenshot when available, then replay before editing production code.
Flicker can exist for only one animation frame, so a settled screenshot or final DOM state cannot clear
a suspected failure. Sample consecutive animation frames across every tool start/completion, streamed
delta, reasoning visibility change, file edit, diff mount, activity grouping, and Worked transition.
Record which exact element disappeared, duplicated, changed order, or changed its viewport rectangle.
For resize and measurement suspicions, first prove that the same painted element moved. Text lookup on
an outer row, a first-intersecting-row heuristic, or movement of a neighboring card is insufficient
when the active anchor may be a visible assistant render item inside that row.

## Run Ledger

Create `artifacts/ai-fuzzy/<timestamp>-<seed>.md` from this template:

```md
# Varro AI Fuzzy Run

- Overall result: PASS | FAIL
- Overall result reason:
- Date:
- Tester/agent:
- Commit:
- Existing worktree changes:
- OS and VS Code version:
- Varro version:
- OpenCode version:
- Model/provider per scenario:
- Target surface, stable viewId, and session route per live scenario:
- Seed:
- Fixture path, baseline commit, and initial status:
- Run-created fixture paths and rollback verification:
- Window and webview dimensions:
- Zoom, theme, sidebar side, panel state:
- Session title/ID and prepared turn count:
- Run-created session IDs and deletion verification:
- Observed descendants and guarded cleanup verification:
- Observation method and optional screenshots:

## Preflight

| Command | Result | Duration/notes |
| --- | --- | --- |

## Scenarios

| ID | Result | Action sequence or seed derivation | Evidence | Notes |
| --- | --- | --- | --- | --- |

## Failures

### <failure title>

- First failing scenario/step:
- Visible marker and viewport offset:
- Expected:
- Actual:
- Minimal replay actions:
- Reproduction rate:
- Observation time and optional screenshot path:
- Related deterministic test:
- Suspected owner, not assumed root cause:

## Omissions And Blocks

- None.
```

Do not write `PASS` without evidence that the scenario reached its precondition. Record unavailable
attachments, insufficient history, missing controls, credentials, or model access as explicit blocks.
For AI-07 and AI-08, also record the realistic task, actual reasoning/tool/edit/test/diff content
observed, changed OpenCode paths, and frame-level flicker sampling points. Synthetic Markdown-only
streaming cannot satisfy those scenarios.
For AI-18, attach the full controller plan and evidence for target selection, root/child routing,
model/permission synchronization, queue source views and item IDs, hidden/closed handoffs, inline-file
toggle samples, reload duplicate samples, canonical delivery order, queue counts, leakage checks, and
final focus owner.
For AI-19, attach permission synchronization samples, the exact queue item and owner IDs, paused/edit
state samples, hide/reveal `viewId` evidence, manual-steer delivery, and the final composer draft check.
The overall result is `PASS` only when every scenario required by the request ran in the real Extension
Development Host and passed. Any `FAIL` or `BLOCKED` required scenario makes the overall result `FAIL`.

## Turning A Fuzzy Failure Into A Regression

1. Replay the exact seed, prepared transcript, dimensions, focus, and action prefix in the real editor.
2. Identify the first visible failing frame and the message marker that should have remained stable.
3. Determine the active scroll owner and the mutation: append, prepend, measurement, resize,
   disclosure, sticky navigation, edit, session replacement, or direct input.
4. Reproduce the same ordering with the smallest existing harness fixture. Prefer extending an
   existing scenario over creating a near-duplicate fixture.
5. Assert the same message ID and its viewport top across every relevant frame. Also assert viewport
   coverage and bounded mounted rows for virtualization failures.
6. Prove the new deterministic test fails against unchanged production code for the same reason.
7. Fix the invalid state or ownership handoff, rerun the deterministic regression, then rerun the
   original real-editor seed end to end.
8. Link the ledger and deterministic test in the final report. Do not commit ignored captures or
   credentials.

Likely deterministic homes include:

- `src/webview/components/MessageList.*.test.ts`
- `src/webview/components/message-list/virtualization.test.ts`
- `e2e/tests/scroll-auto-scroll.spec.ts`
- `e2e/tests/scroll-streaming.spec.ts`
- `e2e/tests/scroll-viewport-coverage.spec.ts`
- `e2e/tests/scroll-diff-preview.spec.ts`
- `e2e/tests/scroll-multi-agent.spec.ts`
- `e2e/tests/layout.spec.ts`
- `e2e/tests/settings.spec.ts`
- `e2e/tests/performance.spec.ts`

## Reporting

Lead with the overall `PASS` or `FAIL`, then failures ordered by severity. Include the exact marker, seed, dimensions, minimal action
prefix, reproduction rate, and artifact path. Then list passed and blocked scenarios and every command
run. State clearly whether verification happened in Playwright, the host-only sandbox, a real
Extension Development Host, or more than one environment.
