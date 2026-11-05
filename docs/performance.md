# Performance Principles

Varro spends CPU in four places: the extension host, the VS Code workbench renderer, the webview
renderer, and the GPU process. A change that saves work in one can move it to another. These
principles come from measured investigations; keep the correctness invariants in
[message-list virtualization](message-list-virtualization.md),
[permission lifecycle](permission-lifecycle.md), and [Windows startup](windows-startup.md) ahead of
any saving described here.

## Measure before changing

- Decide with work counts: style recalculations, layouts, mutation records, observer notifications,
  allocations, and bytes. Headless timings describe their fixture, not the editor.
- Compare against the baseline build on the same input: the same harness scenario or the same
  retained capture. For real-editor comparisons, build `HEAD` in a separate `git worktree` with a
  `node_modules` symlink and run the same driver from it. Never stash, reset, or rebuild over the
  user's working tree to get a baseline.
- Time a production-mode harness build (`vite build --mode e2e` with `e2e/harness/index.html` as input)
  and attribute CPU profiles with an unminified build. The dev server is not representative: it skips
  minification, including the CSS minifier.
- In the real editor, launch `ai:streaming run --observer off`, pause at a checkpoint, and run
  `scripts/ai-performance.mjs`. It reports frame-target counters and per-process CPU.
- Confirm findings in a realistic state. Deltas appended to a completed message in an idle session
  produced trailing-summary churn that a busy stream (`multi-agent-large-streaming`) never shows.
- A frame gap with no long task, while CDP evaluations keep answering, is a rendering pause in the
  host, not main-thread work. Replay the same capture before attributing it to Varro.
- Observer gaps record `heartbeats`, `server/event` `messages`, and `maxHeartbeatSpacingMs` from a
  50 ms timer running between observer start and stop. Spacing near 50 ms bounds any main-thread
  block inside that gap to about that length; it does not name the cause. Counts alone can hide a
  block followed by catch-up, and large spacing can also mean timer throttling. Blocks shorter than
  the timer interval stay invisible. This timer changes the instrumentation, so compare runs only
  with the same observer version, and use `--observer off` for work counts.
- Check `lifecycle` for a hidden interval: `hiddenFrames` cannot show one, because rAF rarely runs
  while hidden. `focused` is not reliable window-focus evidence in a CDP-driven host, where two
  stacked hosts both reported focus. Live captures share the observer's frame clock, offset by the
  controller round trips between starting the capture and the observer.
- The webview cannot see every hide. In VS Code 1.145, hiding the webview overlay stopped its rAF for
  the hide plus about 4 to 22 ms, while `visibilityState` stayed `visible`, timers and messages kept
  running, there were no long tasks, and workbench rAF continued. Probe the workbench's frames and the
  overlay's style before attributing such a gap to rendering below the workbench.
- Chromium's Viz can withhold BeginFrames for up to one second from a client with more than three
  undrawn frames or ten unacknowledged BeginFrames. To test that for a gap near 1,000 ms, record a
  browser-level trace with the `viz` category and read the `reason` of `SendBeginFrameDecision`.
- Chromium commits DOM changes on the same main frames that run rAF, so a timer around the streaming
  delta flush is not expected to paint any sooner, and it would add work while a hidden view could
  otherwise stay idle. Do not add one without painted-frame evidence that it helps.

## Animations and idle cost

- Any running main-thread CSS animation makes Chromium run style, prepaint, layerize, and commit on
  every frame, even with `steps()`. Steps reduce paints, not frames.
- Infinite indicators must animate only `transform` or `opacity`, or advance discrete steps through
  `src/webview/lib/stepped-animation-clock.ts`. The clock publishes root attributes that static CSS
  rules map to frames; the CSS animation remains the fallback. Update the clock's selector and the
  CSS step rules together.
- Do not loop `background-position`, `content`, `width`, `height`, or `mask-position` forever. While a
  session is busy, `document.getAnimations()` filtered to running animations should list only
  compositor-friendly animations and intentional smooth exceptions.

## Solid reactivity

- A memo that returns a fresh object, `Set`, or `Map` on every recompute notifies every observer even
  when the contents are equal. When inputs churn with scroll, measurement, or streaming text, add
  `equals` (`sameKeys`, `sameValues`, and `sameEntries` live in
  `src/webview/components/message-list/history-segments.ts`) or return stable references.
- Row props derived from global maps fan out to every mounted row. Prefer per-ID lookups behind memos
  with structural equality.
- Keep expensive derivations, such as regular expressions over prompt text, in their own memo. A
  compiled element's render effect reruns all of its bindings together.
- `class={...}` bindings write the attribute on every notification, even when the string is unchanged.
  A `MutationObserver` that counts same-value class writes exposes excess reruns.
- To find fan-out, instrument Solid's `writeSignal` in a scratch copy of an unminified build and log
  writes that reach many observers. Do not edit `node_modules` or sources for diagnosis.

## Layout and scrolling

- Budget one layout per frame. A forced read such as `scrollHeight` or `getBoundingClientRect()` is
  acceptable when it is the frame's only layout; avoid write, read, write sequences that add another.
- Do not measure every mounted row on each scroll or measurement notification. Coalesce geometry scans
  into one frame pass, following the sticky-prompt rules.

## CSS

- `build.cssTarget` must match the webview runtime. Older targets make the minifier wrap merged rules
  in `:is()`, which Chromium cannot index by class and which raises specificity above development
  builds.
- Rightmost `:is()` lists and `:has()` on row containers are tested against many elements. For hot
  rows, prefer classes toggled from state.
- Verify CSS build changes with a computed-style diff of every harness scenario between builds,
  including `::before` and `::after`. Screenshots alone miss specificity changes.
- Measure before adding build workarounds. Tailwind's `color-mix()` fallbacks duplicate some rules,
  but removing them showed no measurable style-recalculation saving.
- Keep row-only custom properties out of Markdown descendants. Resetting
  `--interactive-item-block-correction` at `.rendered-markdown` reduced a retained math remount's
  rounding style pass from 8,531 elements to 91. The row spacer and outer activity guides still
  inherit the real correction. Count affected elements, not just style passes: this avoids work
  within an existing pass without reducing its count.
- KaTeX's hidden MathML can defer offscreen layout only when VS Code supplies its accessibility
  signal and screen-reader mode is inactive. `content-visibility: auto` reduces the retained math
  remount's initial style work from about 8,477 to 6,576 elements and layout from 11,487 to 8,373
  dirty objects. It also omits offscreen MathML from Chromium's accessibility tree. Always disable
  it for `vscode-using-screen-reader` and standalone views. Real-editor mode changes must restore
  every formula's semantics without changing row geometry or scroll position.

## Webview transport

- VS Code serializes webview messages with a per-value JSON replacer in the extension host, then
  parses them on the workbench UI thread before cloning them into the webview. Large JSON payloads go
  as bytes through `encodeLargeApiResponse` in `src/extension/webview-session.ts`. Create them with
  `TextEncoder`; VS Code serializes Node `Buffer` values as JSON objects.
- Streaming deltas are already coalesced by `src/extension/server-event-bridge.ts`. Do not add
  per-event `postMessage` traffic.

## Bundles and startup

- A static import of a module matched by a `codeSplitting` group loads the whole group at startup.
  After building, check the entry's static imports with
  `grep -o 'from"./chunks/[^"]*"' dist/webview/webview.mjs`.
- Lazy catalogs use a distinct import query, as the agent-icon catalog does, so static imports of the
  same files stay with their importers.
- Extension bundle compile and evaluation cost is small. Measure it before splitting activation code.
- `webview.imports.json` lists only the entry's static imports, including transitive chunks. The host
  preloads those hashed URLs without changing their cache keys or evaluating them early. Keep lazy
  features out of the list. Measure transcript readiness as well as download completion; a smaller
  entry or earlier composer does not prove that restored history appears sooner.

## Memory

- Session reopening reuses bounded numeric row-height estimates to avoid mounting the whole loaded
  transcript for bootstrap. Keep estimates separate from exact mounted measurements, invalidate
  them with row layout changes, and scope them to the session's ordered message window and reset
  generation. The AI-08 remount comparison and native-action evidence are retained under
  `artifacts/ai-fuzzy/ai08-remount/`. Check transient mount counts, not just settled DOM size.
- Finalized Markdown caches share a 2 MiB byte budget, with at most 256 entries per cache. The entry
  cap must accommodate a 200-message history page: the old 100-entry cap evicted a large rendered
  response during native scrolling even with most of the byte budget free, adding a parse/sanitize
  pass to its remount. Keep the history-page reuse and shared-byte-budget regressions together.
- Streaming completion can cache its sanitized stable/tail HTML when the append validator proves
  the boundary independent. Never assemble a full-result cache entry across contextual HTML,
  reference definitions, or an unfinished code fence. Core/overscan changes only need a Markdown
  reparse when code or diagram rendering changes; code-free content keeps its existing HTML.
- After scrolling a virtualized history repeatedly, a heap snapshot should contain no detached DOM and
  heap growth should level off. Treat steady per-cycle growth as a lead to investigate.

## Acceptance

- Report work counts, same-input baseline comparisons, and the environment that established each
  result: headless harness, retained editor replay, or live editor.
- Keep changes local, preserve the invariants above, and rerun the targeted e2e and AI checks.
