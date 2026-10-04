# Syntax highlighting worker

Highlight.js runs in one lazy dedicated worker per webview. Markdown fences, user code,
and diff lines share the client in `src/webview/lib/code-highlighter.ts`.
`syntax-highlighter.ts` belongs exclusively to the worker's production bundle.

## Rendering contract

- Code paints as escaped plaintext or an already-cached result. Streaming never waits
  for highlighting. Unclosed fences and lightweight Markdown retain plaintext.
- Generated pending code carries `data-highlight-lang`. Markdown's existing raw-HTML
  attribute stripping prevents source HTML from supplying that private marker.
- Worker responses are checked for exact source-text equality and contain only text
  and spans with Highlight.js token, scope-modifier, or embedded-language classes.
  Markdown, user code, and diffs use the same output boundary.
- A response updates only code token children. It does not reparse or sanitize the
  surrounding Markdown, replace copy controls, or publish a global rendering version.
- Bindings own element/source/language identity and unsubscribe on replacement or
  disposal. Detached or changed elements cannot receive stale highlighting.
- Stable-prefix appends subscribe only newly appended code. Tail changes do not rescan
  the stable prefix. Streaming HTML stays independent of asynchronous token results.
- Cached composite Markdown may retain pending markers. Remounts subscribe those
  blocks again and reuse the completed token cache. Composite blocks already containing
  completed highlighting omit the pending marker.

## Limits and lifecycle

The worker preserves the existing 20,000-character block and 1,000-character line
limits and the same 36 Highlight.js language registrations and aliases.

- At most 512 outstanding distinct jobs and 2 MiB of estimated UTF-8 input keys.
- One executing job; active streaming and opened diff jobs precede history jobs.
- Returned HTML is limited to 512,000 characters. Dispatch pauses at 2 MiB of queued
  result strings, with at most one in-flight result beyond that threshold.
- Result validation and consumer updates share a 4 ms per-frame scheduling budget.
  A single validation or DOM insertion is synchronous and can exceed that budget.
- Startup has a 10-second deadline; execution has a 2-second deadline. Timeout or worker
  failure terminates the worker. Canceling a subscription alone cannot interrupt a
  running synchronous matcher.
- Three worker failures disable new worker attempts for that view. A bounded set of
  16 unsuccessful inputs prevents immediate retries after remount.
- An idle worker terminates after 30 seconds. View disposal cancels queued commits,
  aborts startup, and terminates the worker, including late startup completions.
- Completed token HTML shares the existing aggregate 2 MiB Markdown string-cache
  budget. No worker-side result cache duplicates it. This logical budget excludes
  DOM, JavaScript runtime overhead, active consumers, and in-flight messages.

## Packaging

Vite produces a self-contained IIFE worker asset. Production fetches that local asset,
creates a blob worker, and revokes the blob URL. Development uses Vite's module-worker
URL. The production CSP permits `worker-src blob:` and connections to the webview's
extension-resource origin. No WASM or general eval permission is required.

Verify production changes in an isolated VS Code host as well as the browser harness.
The retained comparison and command results are under
`artifacts/highlight-worker-20261003/`. Unit tests use an asynchronous worker double
because jsdom does not implement Worker; browser and editor checks use actual workers.

## Before and after

Five alternating baseline/worker pairs per workload used the same production builds,
486 x 794 webview, and generated 98,949-character document with 48 TypeScript fences.
Each run waited for every code block to finish highlighting. These are workload-specific
medians, not expected improvements for every session.

| Metric | Before | Worker |
| --- | ---: | ---: |
| Streaming main-thread task time | 2,100 ms | 1,882 ms |
| Streaming worst frame gap per run | 208 ms | 75 ms |
| Stream marker arrival to next frame, p95 per run | 146 ms | 137 ms |
| Cold completed-content main-thread task time | 351 ms | 289 ms |
| Cold completed-content worst frame gap per run | 175 ms | 42 ms |
| Cold content readable in the DOM | 43 ms | 45 ms |
| Cold content fully highlighted in the DOM | 189 ms | 169 ms |

The cold case delivers a completed message into a fresh view; it does not time database
reads or a full paginated history opening. Separate native session reopens exercised the
completed-content and cached remount paths. Fully cached reopen timings varied, so this
change is not a universal history-opening speedup.

Reported Chromium-process CPU was roughly unchanged. Summed process RSS was too broad
and variable to establish a memory saving. A two-view lifecycle check observed one
highlight worker in the sidebar, two after opening an editor, one after closing it,
and zero after idle shutdown. A separate sampled profile found Highlight.js execution
on the baseline main thread and none on the worker build's main thread.

Code text, code heights, and viewport dimensions matched across all 20 primary runs.
Full methods, distributions, coverage limits, command results, and screenshots are in
`artifacts/highlight-worker-20261003/README.md` and `comparison.json`.
