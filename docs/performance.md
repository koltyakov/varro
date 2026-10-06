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

## Memory

- After scrolling a virtualized history repeatedly, a heap snapshot should contain no detached DOM and
  heap growth should level off. Treat steady per-cycle growth as a lead to investigate.

## Acceptance

- Report work counts, same-input baseline comparisons, and the environment that established each
  result: headless harness, retained editor replay, or live editor.
- Keep changes local, preserve the invariants above, and rerun the targeted e2e and AI checks.
