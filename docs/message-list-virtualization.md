# Message List Virtualization

This document defines the invariants and verification requirements for `MessageList` scrolling,
pagination, sticky prompts, inline editing, and virtual row measurement.

The message list is not a normal scrolling column. It combines variable-height rows, prefix-sum
virtualization, paginated history prepends, asynchronous media, sticky overlays, inline composer
relocation, and bottom-follow behavior. A change that works for one of those features can still
break another unless the shared invariants below remain true.

## Core Invariants

### Message Identity And Position

- Message IDs are stable identities. Array indexes are transient positions.
- Any `messageId -> index` lookup must react to structural message changes: append, prepend,
  removal, filtering, session switch, and history merge.
- A memo that derives indexes must directly read the reactive message collection or a structural
  version. An information-only version is not sufficient.
- `untrack` must not hide the collection dependency unless an explicit structural signal is read
  first.
- Prepending one history page changes every existing message index. Treat stale indexes after a
  prepend as a correctness bug, not a tolerable cache delay.
- A row-local render item may refine an anchor only while it remains in the captured message row.
  If grouping moves that item to another row during a prepend, preserve the captured message ID.

### Height Accounting

- `measuredHeights` is keyed by message ID and contains the current rendered block size for that
  message.
- `knownZeroHeightMessageIds` may override `measuredHeights` only while the complete row projection is
  known to render no message content, transition content, model-change chrome, dialog summary, or
  other row-local UI. The CSS row box and virtual prefix must agree on that zero.
- Removing a semantic zero-height classification makes any cached zero provisional. Delete the stale
  measurement, dirty the prefix from that row, and force bounded hydration so newly visible content
  cannot remain trapped behind a zero-height virtual range.
- `virtualMetrics.prefix[index]` must describe the same ordered ID list used by the renderer.
- Cached prefix entries may only be reused while both the ID order and all earlier effective heights
  remain valid.
- A row measurement correction above the visible anchor must preserve that anchor's viewport
  position.
- Content below the anchor may change `scrollHeight`, but it must not move the anchor.
- The trailing Thinking, empty-reserve, and Worked states share one bottom slot outside virtual row
  prefixes. Switching states must not briefly mount both the loading label and dialog summary.
- Asynchronous content must reserve its final layout space where practical. Images are the primary
  example: loading an image after its row remounts must not add hundreds of pixels to the row.
- A view setting that changes rendered row content must participate in height invalidation even when
  the affected row is unmounted. This includes thinking visibility, inline file previews, disclosure
  state, and any future lightweight rendering mode.
- An unmounted height invalidated by a view change becomes provisional. It must not remain marked as
  an exact measurement from the old view.
- Width reflow owns a stable visible message captured before the first changed-height batch is
  applied. Deferring prefix publication must not make later resize batches classify rows against an
  already-adjusted `scrollTop` and stale prefixes.
- Delayed, retained, and exiting render states are layout inputs. Their transitions must invalidate
  affected mounted and unmounted heights just like a user-controlled view setting.

### Coordinate Spaces

- Virtual prefixes are row-only coordinates. `prefix[0]` is the start of the first message, not the
  start of the scroll container or track.
- Container `scrollTop` includes flow content before the first message. Today that content is track
  top padding plus the optional history banner and its margins.
- Every range lookup, first-visible lookup, metric fallback, and metric-based navigation target must
  convert between container coordinates and row-only virtual coordinates explicitly.
- Derive the row origin from structural chrome. Do not infer it from a row whose measured height or
  prefix may already be stale.
- A row can be visible while `scrollTop` is greater than its row-only prefix if pre-message chrome is
  still in the viewport. Such a row is not "above the anchor" for height correction.

### Visible Position Is The User-Facing Truth

- `scrollTop` is an implementation coordinate, not the visual result.
- Prepending history can legitimately increase `scrollTop` by thousands of pixels while keeping the
  same message at the same screen position.
- Tests for visible jumps must track the same mounted row and compare its `getBoundingClientRect().top`
  before and after scrolling or measurement.
- A scrollbar-coordinate jump is not automatically a content jump. A stable `scrollTop` is not
  proof that content stayed stable either.

### Scroll Ownership

- At any moment, one subsystem should own programmatic scrolling: bottom-follow, sticky navigation,
  history anchoring, edit visibility, or a direct user gesture.
- Programmatic settling must be bounded and conditional. Do not repeatedly call `scrollIntoView()`
  when the target is already aligned.
- User interaction with the destination cancels navigation settling before editing or attachment
  actions change its geometry.
- Inline editing may keep its panel visible, but edit visibility corrections must not reactivate
  sticky navigation or bottom-follow.
- Expanding a compact activity disclosure takes ownership from bottom-follow so the clicked summary
  stays fixed while its details grow below it.
- A structural anchor correction is allowed during a slow user gesture. It preserves the result of
  that gesture; it does not replace it. An intervening user-owned movement epoch cancels the queued
  correction.
- History ownership covers layout-driven movement only. Native keyboard scrolling, scrollbar
  movement, and trackpad momentum can continue after a prepend without another input event. Actual
  movement while input is still active immediately transfers ownership back to the user.
- A downward user movement during an append transition is a new lower bound. A later animation frame
  must never interpolate to a smaller `scrollTop` and visibly reverse the gesture.
- Width-resize anchoring is established before applying the first resize measurement. Wheel,
  keyboard, or scrollbar input publishes pending measurements and releases that resize anchor.
- A bottom-pinned activity exit may temporarily reserve the disappearing flow space and freeze its
  existing bottom target. The reserve is a bounded geometry owner, must not compete with bottom-follow,
  and yields immediately to direct user movement, session replacement, or transition cancellation.

The effective ownership order is:

| Owner | Starts from | Must yield to |
| --- | --- | --- |
| Direct user movement | wheel, keyboard, touch momentum, scrollbar drag | nothing except bounded geometry compensation for content above the anchor |
| Sticky navigation | sticky prompt activation | wheel, keyboard, pointer interaction, destination click, or a nested destination scroller |
| History anchoring | a page request at the upper boundary | actual user movement, session change, edit ownership, or explicit bottom follow |
| Edit visibility | entering inline edit | direct user movement, edit cancellation, or explicit bottom follow |
| Expansion anchoring | expanding a disclosure or diff | direct user movement or expiry of its bounded settle window |
| Activity exit reserve | a bottom-pinned compact activity begins exiting | direct user movement, session change, transition cancellation, or completion |
| Bottom follow | initial load, send, or explicit jump to latest | upward user movement, sticky navigation, editing, or expansion ownership |

### Animated Row Transitions

- A height animation publishes intermediate row heights. If it runs above a detached viewport, every
  frame must preserve the same visible anchor; checking only the final grouped layout is insufficient.
- Transition identity is part identity, not the current group owner or array position. Moving an
  activity part from running to retained, exiting, and grouped must not hide its source row before the
  exit completes.
- A bottom reserve compensates only for space actively disappearing from flow. It is inert structural
  chrome, does not become part of row-only virtual prefixes, and is removed when no exit remains.
- When bottom-pinned activity leaves flow, including a direct active-tray collapse into Explored,
  hand its disappearing height to the append reserve so the transcript stays fixed until subsequent
  streamed content consumes that space. Transfer the reserve before removing the final exiting row;
  a one-frame gap between those updates is a visible jump. Include row padding when the source row
  becomes semantically empty and its Explored summary is rendered by another row. Keep the original
  bottom target fixed; raising it with later `scrollTop` growth prevents streamed content from
  consuming the reserve.
- Timer, CSS animation, and cleanup paths must share a bounded completion contract. Cleanup must still
  run when the row unmounts, the session changes, or user input takes ownership.

### Sticky Prompts

- A sticky prompt is a derived overlay for a real user message. Its message ID must remain the sole
  navigation identity.
- Navigation aligns the real `.user-message-card`, not an estimated row position or attachment
  summary.
- The destination uses the same top gap as the sticky box.
- Terminal selections, image-only prompts, context-only prompts, and normal text prompts must all
  follow the same navigation path.
- Boundary prompt selection must consider all cached unloaded prompts in order and skip empty prompts.
  Prefetch must continue past an empty newest prompt until a previewable prompt or the beginning of
  history is reached.
- Wheel input consumed by a nested scroller inside the destination still cancels sticky settling.
  The outer transcript does not need to move for the user to have taken ownership.
- Sticky navigation and its loading owner belong to one message-window version. Cancellation releases
  that owner immediately, and an obsolete request cannot clear a newer owner's loading state.
- During an active stream without recent user movement, transient source-row geometry from virtual
  metric invalidation must not hide the current sticky prompt, even if layout correction briefly
  changes bottom-follow flags. Direct user movement and verified next-prompt collisions still take
  precedence.
- A stale sticky page may retry only while its session, window version, cursor boundary, and
  non-failed state remain current, using the same bounded policy as ordinary pagination.

### View Scoping

- Row-local actions and adjacency derive from the same visible message collection as the renderer.
  Hidden child-session messages must not change the visible parent's Retry action, latest plan action,
  model transition, or preceding file-event context.
- All-tree messages may be used only by features that intentionally aggregate the tree, such as
  subagent dialog summaries and token statistics.
- Switching a view mode must preserve stable message IDs and invalidate only the heights whose
  rendered content can change.

### Pagination Progress

- A successful HTTP response is not necessarily visible pagination progress. Empty pages,
  duplicate-only pages, and stale invalidated responses can leave the DOM unchanged while a cursor
  still points to valid history.
- If a page advances the cursor without adding rows, ordinary pagination continues automatically.
  It must not require the user to leave the boundary and scroll back.
- If the initial window cannot overflow, an upward wheel at `scrollTop === 0` must still request
  history even though the browser cannot emit a scroll event.
- A bottom-following initial window with valid history must load through enough settled pages to
  fill the viewport. Provisional heights for compacted rows must not end that fill early.
- A stale response is retried only while the same session, generation, cursor boundary, and
  non-failed load remain current. Retry loops are bounded for responses that make no progress.
- Once a page adds rows and the list overflows, ordinary scroll pagination returns to one-page
  behavior. Full-history and direct navigation are the only paths that intentionally walk all pages.
- Prompt-boundary prefetch may share the matching in-flight cursor page with scroll pagination, but
  scroll pagination must not wait for prompt discovery to continue through later cursors.
- Parent-session pagination and resync replace only that session's message subsequence. Loaded child
  messages and active parent or child streaming state must survive the operation.

### Prompt Number Readiness

- Absolute prompt numbers are ready only when the prompt cursor is exhausted for the current message
  window version.
- A failed or invalidated prompt page leaves counters hidden. A later Alt hold retries the load.
- Resetting the active session's message window invalidates prior readiness even when the session ID
  does not change.
- A reset window is not ready while its replacement fetch is pending. An obsolete prompt request must
  not block a new request for the replacement window.

## Incident: Paginated Session Scroll Jumps

Session `ses_045a23ef2ffeXu328sxHwVSNwW` exposed two concrete defects.

### Stale Index Map

The initial window contained 50 messages. Loading older history prepended another 50 messages, then
the final page. `messageIndexById` was derived behind `messageInfoVersion`, which did not represent
structural message changes. Existing indexes therefore remained offset by 50 after the first page
and by 100 after the second.

Row-height corrections compared measured row positions against those stale indexes. Corrections for
rows above the visible message were skipped or applied to the wrong boundary. The exact paginated
session produced visible errors as large as 886 pixels.

The required rule is simple: index maps derive directly from the reactive ordered messages. Do not
manually guess which non-structural signal will invalidate them.

### Unreserved Image Height

Image message `msg_fbad00d87001m3yammtHDkoUp0` was measured at 273 pixels before its image loaded.
When the row remounted, the loaded image increased the row to 537 pixels. That 264-pixel change could
overwhelm a small upward wheel gesture.

Single-image messages now reserve the same fixed preview frame used by the image carousel before the
image loads.

## What Was Missed

### Approximate Fixtures Replaced The Real Reproduction

Generic 50-row fixtures and an all-at-once 129-message replay passed while the real extension path
still failed. The production path loads 200 messages and prepends older pages. Loading all messages at
once bypassed the structural transition that caused stale indexes.

Principle: reproduce the same data, pagination, viewport, and interaction order before changing the
implementation.

### The Wrong Metric Was Used

Early diagnostics treated large `scrollTop` changes as visible jumps. History anchoring often changes
`scrollTop` intentionally. The correct measurement is the viewport position of the same visible row.

Principle: define the user-visible invariant first, then instrument that invariant directly.

### Partial Fixes Were Declared Complete

Image reservation removed one deterministic jump but did not fix the repeated page-related jumps.
Sticky alignment and settling changes addressed symptoms around navigation without proving the
underlying virtual metrics were correct.

Principle: rerun the complete original reproduction after every candidate fix. Passing a targeted
fixture is supporting evidence, not completion.

### Multiple Scroll Owners Were Allowed To Compete

Repeated navigation settling could continue after the destination was clicked and editing began.
The geometry change from editor relocation then looked like more navigation drift.

Principle: programmatic scrolling requires explicit ownership and cancellation on user interaction.

## Required Debugging Workflow

1. Reproduce with the reported session or an exact serialized equivalent.
2. Match extension pagination: initial 200-message window and `before` page prepends.
3. Match the reported viewport width because wrapping and image preview height affect rows.
4. Identify the user-facing invariant and its owner before changing code.
5. Record, for every scroll step:
   - requested wheel delta
   - first visible message ID
   - that same row's viewport top before and after
   - `scrollTop`, `scrollHeight`, top spacer, and bottom spacer
   - mounted row IDs and measured heights
6. Separate page insertion, row measurement, view invalidation, sticky navigation, and bottom-follow
   events.
7. Identify the first frame where the visible-row invariant fails.
8. Encode that frame and interaction order as a deterministic regression.
9. Run the new regression against unchanged production code and record the expected failure.
10. Only after step 9, fix the state or geometry that becomes invalid on that frame.
11. Rerun the exact session from bottom to top, including every async settle frame.
12. Run the broader unit, scroll, streaming, layout, and performance suites.

A production fix must not be written first and justified by a passing test afterward. If the problem
is browser-only, add a Playwright reproduction or a deterministic unit harness for the same event
ordering, prove it fails, then change production code. A test that fails for a different reason is not
a valid reproduction.

## Regression Preservation Rule

- Do not weaken, delete, or replace an established geometry assertion to make a new implementation
  pass unless the user-visible contract intentionally changed.
- Add the smallest new fixture that reproduces the missing transition. Keep existing fixtures for
  already-correct behavior.
- Assert both sides of ownership handoffs: the old owner stops and the new owner's visible position
  remains stable.
- Sample every animation frame for width reflow, navigation settling, append transitions, and history
  settling, compact activity transitions, and synthetic reserve release. A final settled assertion can
  miss a one-frame jump.
- Assert the same row ID before and after a transition. "Some row is visible" proves coverage, not
  stability.
- Preserve bounded DOM row counts while adding anchor protection. Rendering the full transcript is
  not an acceptable scroll fix.

## Required Regression Coverage

Changes to `MessageList`, `VirtualizedContent`, row measurement, message windowing, sticky prompts,
attachments, or inline editing should run at least:

```sh
npm run test -- src/webview/components/MessageList.test.ts
npm run test -- src/webview/hooks/useOpenCode.sessionState.test.ts
npm run test:e2e -- e2e/tests/scroll-auto-scroll.spec.ts
npm run test:e2e -- e2e/tests/layout.spec.ts
npm run test:e2e -- e2e/tests/performance.spec.ts
npm run lint:check
npm run typecheck
```

Relevant browser regressions must cover:

- heterogeneous row heights after paginated history prepends
- upward wheel scrolling without same-row viewport jumps
- image space before and after loading
- sticky navigation to text, terminal, and image messages
- edit entry while the source row is partially hidden
- cancellation of navigation settling when the destination is clicked
- bottom-follow remaining disengaged during manual upward scrolling
- one-way width narrowing while the same detached row remains at the same viewport top
- structural insertion and removal above the viewport during slow wheel input
- native movement after a prepend but before its settle frame
- downward input during append animation without reverse movement on the next frame
- pre-message chrome when classifying the first visible row
- non-scrollable initial windows and cursor-only pagination progress
- active parent and child streaming state during parent pagination
- offscreen height invalidation for every view mode that changes rendered content
- semantic zero-height rows gaining message content, model-change chrome, or dialog summaries
- running activity moving through retained and exiting states into a group owned by another message
- detached anchors and bottom-pinned content across every activity-exit frame and reserve release
- hidden child messages not affecting visible parent row actions
- empty boundary prompts, nested destination scrollers, prompt-load failures, and same-session window
  resets

## Review Checklist

- Does every derived index react to message order changes?
- Does every cache state which ordered ID list produced it?
- Are container and row-only coordinates converted at every virtual lookup?
- Can asynchronous content change a mounted row's height after measurement?
- Can a view setting change an unmounted row while leaving its old height marked exact?
- Can a semantic zero-height row gain any row-local chrome without clearing its cached zero and forcing
  hydration?
- Is a visible anchor preserved when height changes occur above it?
- Was a width anchor captured before the first changed measurement was applied?
- Is the test checking row viewport geometry rather than only `scrollTop`?
- Does the test sample intermediate frames rather than only the settled result?
- Does the test use pagination if production uses pagination?
- Can an empty, duplicate, stale, or non-scrollable page leave valid history unreachable?
- Does a session-local response preserve other loaded sessions and their streaming state?
- Can another scroll owner run at the same time?
- Does a compact activity transition preserve part visibility and release any bottom reserve on every
  completion, cancellation, and user-ownership path?
- Can native movement continue without another wheel or key event after ownership was assigned?
- Does user interaction cancel settling before changing layout?
- Are visible row actions derived from the rendered thread rather than hidden tree messages?
- Was the original reported session or an exact equivalent rerun end to end?
