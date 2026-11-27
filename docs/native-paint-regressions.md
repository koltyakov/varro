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

Use `--extension-root <built-worktree>` to run the same current driver and paint
oracles against a frozen baseline build. The selected worktree supplies the isolated
launcher and replay server. Results record its commit, working-tree status, webview
asset version and extension bundle hash. Build it first; this option never rebuilds
or modifies the selected source.
`firstDragWork` records target-scoped Chromium performance counters around the first
drag. Compare work counts only with the same driver and capture. Tracing, screenshots
and geometry probes add overhead, so these counts do not establish an uninstrumented
latency or streaming-performance pass.

Each invocation creates a new directory under `artifacts/ai-streaming/native-paint-*`.
An explicit `--output` must name a directory that does not exist. Captures and images can
contain private text; do not commit these artifacts.

## Checks and evidence

- **Cold body:** keep native workbench compositor frames from the initial grab through
  movement, the one-second destination hold, and another second after release. A verified
  bright baseline precedes the blank-body oracle. The body crop excludes scrollbar,
  sticky top chrome, and composer. Both solid bright and solid dark frames count as blank.
  Every blank frame stays in the result.
- **Retained text:** learn a glyph mask only from a painted paragraph before prepend.
  Compare the same message and exact paragraph text at fully visible bounds that are stable
  within each layout's DOM samples. The glyph search allows at most 2 CSS px of displacement
  around the matched bounds. Correct DOM text does not clear missing painted glyphs.
  The mask comparison penalizes extra bright pixels as well as missing glyphs.
  Both bracketing samples must record the actual opaque sticky top, shell and solid-gap
  rectangles. Text overlapping either footprint, including its 2 px comparison margin,
  is excluded and recorded as `sticky-occluded`, not reported as missing glyphs.
  Hit testing alone cannot establish exposure because the solid gap ignores pointer events.
  The translucent fade is not treated as opaque. Older captures without measured sticky
  coverage cannot establish retained-text eligibility and remain unverified.
  Record message IDs at the replay server, before the bootstrap proxy streams the page.
  Mark prepend when the oldest loaded message first changes to an ID from a completed page,
  even if that page was fetched before recording or the banner stays visible.
  Learn references only before the last sample that still showed the old loaded boundary.
  While the thumb is held at the same scroll offset, the DOM can report the new boundary before
  the screencast shows it. An exact match at the exposed old positions of every displaced
  witness, with no match at their new positions, identifies a whole old-layout frame. Record
  it separately and do not count it toward post-prepend coverage. After new positions are
  presented, later frames cannot fall back to the old layout. Missing pixels without that
  positive old-layout evidence still fail an eligible comparison.
  Missing pre-prepend references or no qualifying post-prepend frames cannot establish a pass.
  A glyph mismatch before prepend is retained in `prePrependMismatches` for diagnosis. Only
  comparisons after verified prepend decide the retained-text verdict.
  A pass requires comparisons in at least three distinct post-prepend compositor frames.
  Paragraph counts describe coverage within those frames and do not advance that threshold.
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
raster tasks, and timeline events. Verbose disabled-by-default invalidation categories are
excluded from the default budget; targeted investigations can supply explicit categories
to `startPaintTrace`. `trace-summary.json` retains event counts,
process names, and relevant events. The probe emits epoch-labelled timeline timestamps
to correlate trace clocks with frames and DOM samples.
If prepend first occurs in the generated re-grab, `compositor-prepend-trace.json` records
that interval separately. The trace buffer and exported file are capped at 512 MiB.
Export streams directly to a private no-overwrite file. Completion has a separate 60-second
deadline and stream export a 120-second deadline; stop is one-shot even after failure.
Completion/export durations and peak buffer usage are retained. `dataLoss` is reported,
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
