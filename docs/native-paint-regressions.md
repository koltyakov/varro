# Native paint regressions

Run these checks in an isolated VS Code host, with no model or production database:

```sh
npm run test:native-paint
```

The default capture is generated, contains paginated history and multi-file edit metadata,
and never executes its recorded tools. The command builds the current worktree. To replay
an existing capture read-only against an already-built extension:

```sh
node scripts/ai-native-paint.mjs --capture <capture.json> --checkpoint <event-count>
```

Each invocation creates a new directory under `artifacts/ai-streaming/native-paint-*`.
An explicit `--output` must name a directory that does not exist. Captures and images can
contain private text; do not commit these artifacts.

## Checks and evidence

- **Cold body:** keep native workbench compositor frames from the initial grab through
  movement, the one-second destination hold, and another second after release. A verified
  bright baseline precedes the blank-body oracle. The body crop excludes scrollbar,
  sticky top chrome, and composer. Every blank frame stays in the result.
- **Retained text:** learn a glyph mask only from a painted paragraph before prepend.
  Compare the same message and exact paragraph text at stable, fully visible bounds, with at most
  2 CSS px displacement. Correct DOM text does not clear missing painted glyphs.
  Record DOM replacements but never learn a replacement glyph mask after prepend.
  Missing pre-prepend references or no qualifying post-prepend frames cannot establish a pass.
- **Top targeting:** distinguish reaching the currently loaded top from complete history.
  Use actual replay-server pagination response headers, cursor exhaustion, and the first
  message's viewport position. Numeric history compensation is valid. Allow at most one
  separately named `pagination-regrab`, using fresh thumb geometry after the first action.
  Its result never replaces the original paint results.

The generated driver pauses above the history trigger to acquire a native painted text
reference. If prepend did not occur in the first grab, its separately labelled re-grab
can arm that reference with a native wheel movement before the grab. These generated-only
preconditions do not alter retained-capture input cadence or erase earlier cold failures.

`result.json` records each check as `PASS`, `FAIL`, or `BLOCKED`. An earlier failed paint
stays failed even if later coverage is incomplete. A nonzero exit also covers incomplete
checks and controller errors; it does not by itself prove a product defect. Consult the
individual results and `errors`. `frames.json` indexes native images by compositor timestamp;
`dom-evidence.json` contains application-world identities, geometry, events, and mutations.

The pixel checks currently require dark-theme, unscaled 1:1 native images. Text comparisons
only cover stable bracketing DOM bounds; moving or clipped text remains outside their
automatic coverage. Expanded diff previews have a separate recorded gate. A missing diff
gate does not turn a text-only cold-scroll check into diff coverage. Review the images,
especially any reported failures, before assigning a visual verdict.

## Compositor attribution

`compositor-trace.json` is a browser-level Chrome trace spanning only the first drag and
prepend, not image export or the optional re-grab. It includes input, timeline, `cc`, `viz`,
raster tasks, and paint invalidation categories. `trace-summary.json` retains event counts,
process names, and relevant events. The probe emits epoch-labelled timeline timestamps
to correlate trace clocks with frames and DOM samples.
If prepend first occurs in the generated re-grab, `compositor-prepend-trace.json` records
that interval separately. The trace buffer is capped at 512 MiB; `dataLoss` is reported,
and a lossy trace cannot support conclusions based on absent events.

Check exposed range coverage before blaming raster:

1. At the first native movement, compare the compositor's position with the previous
   mounted rows and virtual spacers. A destination outside that window is a range deficit.
2. Locate application scroll delivery, DOM publication, paint, commit, activation,
   raster tasks, and frame submission for the webview renderer, not just the workbench.
3. For prepend, compare retained paragraph identity and bounds with paint invalidation
   and compositor frames. Raster tasks alone do not prove that a particular glyph tile
   was valid or presented.

Tracing and geometry probes add work. These runs are correctness/attribution evidence,
not performance passes. Never infer an exact display-list or raster cause solely from
event counts. The runner owns host cleanup even on failure; `editor/run.json` and
`editor/server-result.json` retain cleanup and canonical delivery results.

Unit tests for the fixture, failure-preserving oracles, and trace summary:

```sh
node --test scripts/ai-native-paint.test.mjs
```
