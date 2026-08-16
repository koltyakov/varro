# AI Fuzzy Verification In VS Code

> [!IMPORTANT]
> An AI test run passes only when the requested scenarios run in a real, interactable VS Code
> Extension Development Host. If VS Code cannot be launched or controlled, GPT Luna cannot be used,
> required sessions cannot be prepared, or any real-editor scenario cannot reach its precondition, the
> **overall AI test result is `FAIL`**. Automated preflight results may still be reported as supporting
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
3. Use `openai/gpt-5.6-luna` for generated content and live streaming. If it is unavailable, use the
   available GPT Luna route and record the exact provider/model. Do not silently substitute a larger
   model because output length and timing are test inputs.
4. Use a fresh run seed and record it before taking any actions. Reuse the same seed when reproducing
   a failure.
5. Save a run ledger under `artifacts/ai-fuzzy/<timestamp>-<seed>.md`. `artifacts/` is intentionally
   ignored by Git.
6. Report failed invariants and reproduction steps first, followed by passes, blocked checks, model,
   VS Code version, viewport/layout, seed, and artifact paths.

If credentials, a GUI, or Luna are unavailable, continue with every feasible automated check and mark
the affected real-editor scenarios `BLOCKED`, but report the overall AI test as `FAIL`. Never turn a
blocked visual check into a pass or describe an automated-only run as a successful AI test.

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

1. Run `npm run ai:vscode` to build Varro and launch a persistent, isolated Extension Development
   Host. Use the printed profile path in the ledger. This avoids reusing a normal VS Code singleton and
   uses a short temporary profile path that stays below the macOS IPC socket-path limit. On macOS the
   host starts hidden in the background so launch and setup do not steal focus; reveal it only when the
   real-editor interactions are ready to begin. Alternatively, open this repository in VS Code and press
   `F5` to start **VS Code Extension Development** when the current environment can reliably control the
   resulting window.
2. Use a dedicated Extension Development Host window. Do not use a production Varro window that has
   unrelated sessions or settings.
3. Open the Varro view and explicitly select GPT Luna. Record the exact provider/model shown by Varro.
4. Start with the secondary sidebar between 430 and 500 CSS pixels wide and the window at least 800
   CSS pixels high. Record window size, zoom, sidebar side, panel visibility, theme, and font scaling.
5. Use a new Varro session titled `VFZ <seed>` unless the scenario requires reopening a prepared long
   session.
6. Observe the complete run directly in the tracked Extension Development Host. Record the scenario,
   step, marker, and preceding actions immediately when a suspected failure occurs and again after
   settling. Screenshots are optional supporting evidence, not pass preconditions.
   A marker is an exact painted DOM element whose own bounding rectangle intersects the viewport, not
   merely text found inside an intersecting message row. Capture and reuse that element's stable message
   ID plus render key or a uniquely identifying descendant. If Varro preserves a different visible
   render item during reflow, record both identities and do not infer a jump from movement of the
   containing row or an adjacent card.
7. Keep DevTools closed for the first pass because docking changes webview dimensions. Use it only for
   diagnosis or metric capture, and record that the run became instrumented.

The existing F5 host can preserve extension state. For cold-load checks, close the Extension
Development Host, start it again, and do not warm the target session by opening or scrolling it first.
For onboarding isolation, use `npm run test:vscode-sandbox`; that runner exits after host assertions and
is not the interactive geometry environment.

### When VS Code Is Blocked

Do not stop after noticing that no Extension Development Host is already running. Attempt recovery in
this order:

1. Run `npm run ai:vscode` and verify that a window titled `[Extension Development Host]` appears.
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
5. If credentials, GPT Luna, required prepared history, or another precondition needs user action, ask
   one concrete question describing the missing prerequisite and the available choices.
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
| Content mutation | stream text, complete tool, expand/collapse disclosure, toggle Thinking, open/close diff |
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

## Transcript Recipes

Prefix every generated prompt with a unique marker such as `[VFZ:<seed>:T07]`. Markers make visual
anchors and failed turns searchable after reload.

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

### Long Luna Stream

```text
[VFZ:<seed>:STREAM] Produce 80 numbered sections. Alternate a one-line section with a paragraph of
90-130 words, insert a 20-row markdown table after section 20, and insert fenced TypeScript and shell
blocks after section 40. Emit every section in order and end with VFZ-STREAM-END. Do not use tools.
```

### Tool And Activity Stream

```text
[VFZ:<seed>:TOOLS] Inspect this repository for message-list virtualization risks. Use several separate
read, grep, and test operations rather than one combined operation. Keep a todo list, explain findings
between operations, and finish with a concise report containing VFZ-TOOLS-END. Do not edit files.
```

### Long Session Preparation

Virtualization starts above 50 message rows. Create at least 32 user/assistant turns with the varied
height recipe for ordinary virtualization. A real cold pagination run needs more than the production
200-message initial window. Prepare at least 110 completed turns in one session, preferably 210 turns
to cross two full boundaries. Compact outputs are acceptable except every tenth turn, which must use
a tall form.

Preparation may be performed before the timed run. Record the session ID or exact title, turn count,
model, and whether the history has ever been opened. Do not describe a 32-turn transcript as a
pagination test.

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
3. Use the visible prompt-number navigation behavior to visit each target, including an unloaded old
   target when the UI offers it.
4. During one settle, click or wheel at the destination to cancel programmatic ownership.
5. Navigate back to the newest selected prompt.

Pass invariants:

- Every target resolves to the prompt with the matching stable marker and badge.
- Loading remains visibly associated with the requested target and cannot be cleared by an obsolete
  request.
- Final alignment is to the real prompt card and remains stable for two seconds.
- User input cancels settling immediately and is not reversed by a later frame.

If the current UI exposes prompt numbers but no direct numbered navigation action, mark the direct
navigation step `BLOCKED`, verify badge stability and sticky click navigation, and record the missing
interaction rather than inventing one.

### AI-05 Cold Scroll To Real Top

Precondition: a prepared session with more than 200 messages. The target Extension Development Host
has just started, and this session has not been opened in that host run.

1. Open the session and wait at the latest message without scrolling upward.
2. Begin direct observation, then use only desktop pixel-wheel events between 32 and 96 pixels upward.
   OS mouse automation or CDP mouse-wheel dispatch to the exact Varro webview is valid; touch events and
   direct scroll-position mutation are not.
3. At each history boundary, keep one marked row under observation through loading and insertion.
4. Continue through every boundary until the real first prompt and history-start state are visible.
5. Scroll down one viewport, close the session, reopen it, and repeat the first boundary with the same
   action seed.

Pass invariants:

- The observed marker preserves its viewport position while older pages prepend. A scrollbar
  coordinate change by itself is allowed.
- Every request boundary makes progress without requiring a scroll away and back.
- No blank viewport, stale placeholder, full-list flash, repeated page, or skipped marker appears.
- The first prompt is reachable and the history banner disappears at the true beginning.
- The replay follows the same marker order, even if response latency differs.

### AI-06 Luna Streaming And Bottom Follow

Precondition: the 32-turn session is at the bottom.

1. Send the long Luna stream recipe and make no input for the first 20 visible sections.
2. Wheel upward beyond one viewport while Luna is still streaming and record a visible marker offset.
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

### AI-07 Activity, Tools, And Sticky Streaming

Precondition: the session is virtualized and the latest user prompt can become sticky.

1. Send the tool and activity recipe using Luna.
2. Keep the source prompt just above the viewport while reasoning text and tool cards appear.
3. Expand the active tray or disclosure, scroll its nested content, and then move the outer transcript.
4. Let at least two tool operations complete while detached from the bottom.
5. Return to the bottom before the final tool completes and observe the transition into Explored or
   Worked.

Pass invariants:

- The sticky prompt remains the same marked prompt throughout unrelated activity height changes.
- Active items do not duplicate, disappear before completion, or replay entrance animation after a
  virtual remount.
- Nested wheel movement stays local while possible; outer movement immediately takes ownership when
  requested.
- A detached visible marker remains fixed through completion and grouping.
- At the bottom, disappearing activity space is replaced without a one-frame jump and releases after
  streamed content consumes it.

### AI-08 Seeded Mixed-Ownership Fuzz

Precondition: an active Luna stream in a virtualized session with at least one expandable disclosure.

Perform 50 seeded actions. Ensure the generated sequence contains at least one of every category:

- upward and downward wheel input
- `PageDown`, `Space`, and `Shift+Space` on the transcript
- the same keys while the composer or inline editor is focused
- sidebar width resize
- disclosure expansion and collapse
- sticky click or jump-to-latest
- session switch away and back
- outer transcript movement after nested scrolling

Pass invariants:

- The transcript-scrolling keys move the transcript only when focus is outside editable controls.
- No prior owner later reverses the most recent direct user destination.
- Session switching never mixes messages, sticky previews, loading states, or streaming status.
- Focus remains usable and the composer accepts input after the sequence.
- The viewport has painted rows at all times and returns to a coherent latest state.

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

For each extended scenario, combine the named mutation with `AI-02` reflow, `AI-06` detached
streaming, and the ownership invariants relevant to the changed component.

## Failure Oracle

Treat any of the following as a failure even if the final screen settles correctly:

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
- Model/provider:
- Seed:
- Window and webview dimensions:
- Zoom, theme, sidebar side, panel state:
- Session title/ID and prepared turn count:
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
