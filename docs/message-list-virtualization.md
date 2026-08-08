# Message List Virtualization

This document defines the invariants and verification requirements for `MessageList` range selection,
scrolling, pagination, sticky prompts, activity transitions, responsive resizing, inline editing,
post-message chrome, and virtual row measurement.

The message list is not a normal scrolling column. It combines variable-height rows, prefix-sum
virtualization, paginated history prepends, asynchronous media, sticky overlays, compact activity
transitions, responsive reflow, inline composer relocation, post-message flow chrome, and
bottom-follow behavior. A change that works for one of those features can still break another unless
the shared invariants below remain true.

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
- Parent history is not necessarily inserted at array index zero. Interleaved child-session rows may
  split the parent subsequence. Reconciliation must preserve the order, object identity, and part
  identity of retained parent and child entries.

### Virtual Range And Rendering

- The current range constants are centralized: `VIRTUALIZE_THRESHOLD` is 50 rows,
  `DEFAULT_ITEM_HEIGHT` is 160 px, and `OVERSCAN` is 9 rows. Changing one requires range-boundary,
  viewport-coverage, mount-count, and performance verification.
- Virtualization starts only after every row in the current window has an exact initial measurement.
  After bootstrap, it remains active while the list is above the threshold; appends and prepends use
  provisional heights rather than temporarily remounting the full transcript.
- Every unmeasured nonzero row uses the same aligned provisional height used to construct the prefix.
  Range lookup must skip zero-height runs at exact boundaries and must return physical coverage for a
  nonempty list.
- Effective row heights, prefix entries, placeholder heights, and spacer heights are whole CSS pixels.
  Fractional natural layout must receive a matching row-box correction so CSS geometry and virtual
  geometry cannot drift apart.
- `start/end` define the mounted overscan range. `coreStart/coreEnd` define the rows near the painted
  viewport. Off-core overscan rows remain real message rows; lightweight mode may suppress expensive
  presentation and animation but must not remove assistant parts or change identity.
- A distant history anchor may extend the mounted range beyond ordinary overscan. Only the viewport,
  forced rows, and pinned anchor require full content; the intervening gap may use prefix-sized inert
  placeholders.
- Retain pinned-gap placeholders through pin removal while direct input, pointer ownership, sticky
  navigation, or editing still owns geometry. A placeholder that enters the real viewport must hydrate
  immediately and must not become blank again when ownership ends.
- Never record an `.interactive-item-virtual-placeholder` block size as an exact content measurement.
  Rows required for sticky navigation, invalidated-height hydration, visible placeholder replacement,
  or cross-message activity ownership must bypass placeholder rendering.
- Ordinary overscan is not a placeholder. Anchor protection may create bounded placeholder shells,
  but fully rendered expensive content must remain bounded to viewport overscan, forced rows, and the
  pinned anchor.
- Visual adjacency uses the previous nonzero projected row, not the immediately preceding array entry.
  Render-empty rows must not break assistant-response spacing or cross-message activity continuation.
- Outer virtualization operates on message rows only. A mounted assistant row renders its complete
  part sequence; do not add inner paging or truncation that changes row semantics.
- Wheel and scroll hot paths must use prefix lookup and mounted-row maps rather than synchronously
  scanning or measuring the full transcript. Coalesce DOM geometry work to animation frames.

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
- Layout invalidation signatures describe rendered geometry, not arbitrary data changes. They must
  include preview mode, thinking visibility, disclosure ownership and expansion, activity transition
  state, and any other value that changes row projection without dirtying rows for information-only
  updates.
- A preference that synchronously removes content, such as `/thinking`, captures a visible anchor
  before mutating the preference. That explicit anchor remains available to every layout-signature
  invalidation caused by the same synchronous state change; one pass must not consume it and let a
  second pass restore a competing generic anchor.
- A resize batch is a pure width reflow only when every reported inline size changed or the container
  font changed. Concurrent streaming, expansion, or content mutation makes it a content resize and
  uses normal height-correction ownership.
- Width measurements may be deferred only while the mounted range still brackets the viewport.
  Publish pending metrics early if stale prefixes could leave uncovered space above or below the
  rendered range.
- Do not clear all offscreen height measurements during live resize. Keep them as provisional
  estimates while mounted rows reconcile. A structural ID change cancels the width owner before it can
  restore into a different ordered list.
- Host viewport resize and local container resize have different reserve semantics. A host resize
  releases synthetic bottom reserves; local panel growth or shrink reconciles and consumes reserves
  against the existing pinned bottom target.
- Scrollbar inset is layout geometry. Track padding, sticky chrome, and bottom overlays must use the
  same current `offsetWidth - clientWidth` inset.
- Disable native browser scroll anchoring whenever Varro owns measurement, history loading, activity
  exit, or edit geometry. Native anchoring and explicit anchor correction must not compensate the same
  mutation.

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
- Virtual prefixes and `totalHeight` include message rows only. Pending-action rows, the trailing
  status/summary slot, append reserve, and activity-exit reserve are post-message flow chrome. Bottom
  distance includes their actual container height, but range lookup does not.
- Jump-to-latest is an overlay outside the scroll track. It must not change row measurement,
  `scrollHeight`, or prefixes.

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
- Expansion ownership is bounded and yields to direct outer wheel, transcript-scrolling keyboard, touch,
  scrollbar, or pointer movement. A stale expansion owner must not suppress a later view-change anchor.
  Wheel events consumed by a nested scroller do not transfer outer expansion ownership.
- A structural anchor correction is allowed during a slow user gesture. It preserves the result of
  that gesture; it does not replace it. An intervening user-owned movement epoch cancels the queued
  correction.
- History ownership covers layout-driven movement only. Native keyboard scrolling, scrollbar
  movement, and trackpad momentum can continue after a prepend without another input event. Actual
  movement while input is still active immediately transfers ownership back to the user.
- Input intent without outer movement does not cancel history anchoring. An upward wheel at the
  physical top still needs the pending anchor while the page request runs.
- PageDown, Space, Shift+Space, Home, End, and arrow movement establish a user-owned destination once
  the browser moves the transcript. Later history, expansion, or resize compensation may account for
  content inserted above that destination but must not undo the native movement. Scrolling keys inside
  editable controls do not own the transcript.
- A downward user movement during an append transition is a new lower bound. A later animation frame
  must never interpolate to a smaller `scrollTop` and visibly reverse the gesture.
- Width-resize anchoring is established before applying the first resize measurement. Wheel,
  keyboard, or scrollbar input publishes pending measurements and releases that resize anchor.
- A bottom-pinned activity exit may temporarily reserve the disappearing flow space and freeze its
  existing bottom target. The reserve is a bounded geometry owner, must not compete with bottom-follow,
  and yields immediately to direct user movement, session replacement, or transition cancellation.
- Non-append insertion, removal, filtering, or view replacement may use a bounded structural owner.
  Capture before publishing the changed visible collection and restore after row reconciliation only
  when no stronger owner exists. Pure appends belong to bottom-follow or append-transition ownership.

The effective ownership order is:

| Owner | Starts from | Must yield to |
| --- | --- | --- |
| Direct user movement | wheel, keyboard, touch momentum, scrollbar drag | nothing except bounded geometry compensation for content above the anchor |
| Sticky navigation | sticky prompt activation | wheel, keyboard, pointer interaction, destination click, or a nested destination scroller |
| History anchoring | a page request at the upper boundary | actual user movement, session change, edit ownership, or explicit bottom follow |
| Edit visibility | entering inline edit | direct user movement, edit cancellation, or explicit bottom follow |
| Diff interaction | focusing or expanding diff content | direct movement, focus exit, collapse, or explicit bottom follow |
| Expansion anchoring | expanding a disclosure or diff | outer wheel, transcript keyboard, touch/scrollbar/pointer movement, or expiry |
| Structural reconciliation | non-append visible collection change | direct movement, stronger owner, session/order change, or bounded completion |
| Width resize | changed row inline size or container font | direct movement, structural change, navigation, or settled publication |
| Activity exit reserve | a bottom-pinned compact activity begins exiting | direct user movement, session change, transition cancellation, or completion |
| Bottom follow | initial load, send, or explicit jump to latest | upward user movement, sticky navigation, editing, or expansion ownership |

Direct input acquires ownership only when it can affect the transcript:

- Normalize wheel line and page units before classifying movement.
- Let nested scroll containers consume wheel movement they can handle.
- Ignore transcript-scrolling keys from inputs, textareas, selects, and editable composer content.
- Mouse pointer ownership begins from the scrollbar gutter or another explicit transcript interaction;
  touch owns the scroll surface.
- Nested wheel input still cancels sticky settling because the user has interacted with the
  destination, even when it does not own the outer transcript.

### Bottom Follow, Editing, And Flow Chrome

- Programmatic scroll events that match the expected target do not disengage bottom follow. Layout
  drift without upward-user evidence does not disengage it either. A follow lock yields only to
  intentional upward movement or another explicit owner.
- Bottom follow remains active frame by frame while streaming or geometry is unsettled. It may stop
  only after track height, bottom target, and distance from bottom stabilize; stream observation
  requires consecutive stable frames.
- Detached follow reattaches only after genuine downward movement reaches the reattachment threshold.
  Zero-delta and resize-generated scroll events cannot reattach. Downward input at the physical bottom
  does not interrupt follow.
- Pure bottom-followed appends below the virtualization threshold may claim a one-time row entrance,
  except image rows. Once measurement is active, append rows publish final heights immediately and any
  reveal transition moves only the viewport. Remounting history must not replay entrance animation.
- The append reserve is general bottom-pinned flow geometry, not only activity-exit state. It may
  replace space lost from trays, todo collapse, external panels, or local container changes. Real
  appended growth consumes it while its original bottom target remains fixed.
- The trailing Thinking, loading, empty-reserve, and Worked states share one post-message slot. The
  slot may remain invisibly reserved while visible streaming text or tools replace its label. Debounce
  label reappearance and reserve release so short transitions do not collapse and regrow the bottom.
- While inline editing is active, the edited row top may not move above the sticky message-jump inset.
  Clamp native and wheel movement at that boundary and settle for bounded frames. Editing never
  re-enables bottom follow.
- Focused diff content owns local interaction geometry and pauses bottom follow. Resume only if follow
  was active before focus and no user movement superseded it. Expanding or collapsing a diff
  disengages follow before capturing disclosure geometry.

### Animated Row Transitions

- A compact activity part follows `delayed -> visible active -> retained -> exiting -> grouped`.
  Completion before the display delay skips the tray. Once shown, retain it for the minimum visible
  interval unless response text already provides the transition.
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
- The matching CSS animation is authoritative for visual completion. Re-pin the active tray after
  `assistant-active-activity-in` finishes. Keep an exiting item mounted until
  `assistant-active-activity-out` finishes; the timer is an idempotent bounded fallback with a grace
  interval, not an earlier competing completion path.
- Cancelled or rejected animation promises, unmount, and session replacement must still clear timers,
  transition state, and reserves exactly once.
- A running part outside the active trailing turn groups immediately rather than replaying tray
  transitions. A new running part contiguous with an expanded group joins that group directly without
  a one-frame duplicate tray.
- The active tray is a bounded nested scroller. Limit visible items, follow the newest item after DOM
  mutation and entrance completion, and show the focused expanded item. Its wheel movement must remain
  local while the tray can scroll.
- Off-core activity stays semantically present but does not run height-affecting tray entrance or exit
  animation. Pause indefinite cosmetic activity animation outside the virtual core.
- If an exiting tray item merely reveals another clipped item, freeze the bottom target for one frame
  without adding false reserve. A complete tray collapse reserves tray height, changed flow gaps, and
  source-row padding before projection changes.
- Animation identity is a one-time message/render-key claim, not current DOM position. Virtual remount,
  completed-history reopening, or appending to an existing file-edit stack must not replay a claimed
  entrance.

### Sticky Prompts

- Sticky selection uses current painted row geometry. Intersection-observer bounds and virtual metrics
  are fallbacks for anchoring or hydration, not proof of a row's current viewport position. Suppress
  sticky UI below the minimum supported viewport height.
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
- Coalesce sticky viewport position, viewport size, placeholder hydration, and geometry refresh into
  one animation-frame pass. The hot scroll path must not rescan and republish sticky state for every
  native event.
- Derive structural sticky inputs such as subagent session IDs outside that frame pass and reuse them
  until message structure changes. Prompt text and attachment parsing remain live so previews cannot
  become stale.
- Collision uses the full painted overlay, including solid/fade gap and safety buffer. During upward
  movement, hide predictively before the source enters and defer reappearance until the source clears
  the full release boundary or the gesture becomes idle.
- Metric navigation may move far enough to hydrate a destination, but final alignment always uses the
  mounted `.user-message-card`. Continue until mounted geometry and measurement versions are stable
  for consecutive frames, subject to a bounded attempt limit. Finish any width-resize owner first.
- While a sticky jump is pending, its preview and loading state remain authoritative even if ordinary
  sticky selection changes. An unloaded boundary preview may stay mounted during prompt refresh until
  live geometry proves it should hide or its owner becomes obsolete.
- Width resize may defer ordinary sticky refresh, but live mounted geometry can immediately hide an
  overlay already proven stale. Deferred publication must not preserve a known collision.

### View Scoping

- Row-local actions and adjacency derive from the same visible message collection as the renderer.
  Hidden child-session messages must not change the visible parent's Retry action, latest plan action,
  model transition, or preceding file-event context.
- All-tree messages may be used only by features that intentionally aggregate the tree, such as
  subagent dialog summaries and token statistics.
- Switching a view mode must preserve stable message IDs and invalidate only the heights whose
  rendered content can change.
- Inline file-edit retention is a session-view layout input. Edits from the active or awaiting trailing
  turn remain inline, including when that turn completes while open. Reopening may compact them, and
  the transition invalidates every affected owner row.
- Activity-summary labels are width-dependent geometry. Read all affected widths before applying
  compact labels, replace labels deterministically, and let outer row measurement observe the result.
- Assistant read mode belongs in a portal outside the message track. Opening it must not change source
  row height or virtual prefixes.

### Structural Reconciliation And History

- A generic structural owner covers non-append insertion, removal, filtering, and visible-view
  replacement. It captures a mounted anchor before publishing the new collection and restores after
  reconciliation only while session identity and the user-ownership epoch remain current.
- History anchoring starts before the request can mutate the reactive collection. Keep the old
  viewport anchor mounted and align it during every relevant child-list mutation and animation frame
  until inserted rows and exact measurements settle. Final correction after the request continuation
  is too late if estimated geometry can paint first.
- Mutation observers and pre-paint frame loops are bounded owners. Disconnect observers and cancel
  scheduled frames on success, error, session/window replacement, invalidation, or ownership transfer.
- The pinned history range uses placeholders for its distant gap, but the captured anchor and normal
  viewport range remain full content. Exact measurements replace provisional prefix values while the
  anchor stays fixed.
- If neither the mounted history anchor nor its metric fallback can restore, preserve the prior
  viewport with the nonnegative change in `scrollHeight`. Never apply a negative fallback delta.
- Expansion may refresh an in-flight history anchor and advance its ownership epoch. Entering edit
  transfers that pending history anchor to the edited row instead of leaving the old viewport target
  active.
- History requests are deduplicated per session, active generation, and message-window version.
  Loading state is released only by the exact owner that acquired it. Switching A to B and back to A
  must not reuse A's obsolete request or anchor.

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
- Parent history insertion must preserve retained child entry and part references, not only equal IDs.
- Ordinary boundary loading uses the production page size and cursor order. Historical incidents may
  describe older page sizes; do not copy those counts into current fixtures.

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
the final page. This is a historical configuration; current production verification uses 200-message
windows. `messageIndexById` was derived behind `messageInfoVersion`, which did not represent structural
message changes. Existing indexes therefore remained offset by 50 after the first page and by 100
after the second.

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

### Reactive History Mutation Painted Before Async Settling

A history response can update the reactive message collection and DOM before the awaiting pagination
function resumes. A correction performed only after the promise continuation allows provisional
prefix geometry to paint first.

Principle: history alignment begins before the request and observes each reconciliation mutation until
the owner settles or is cancelled.

### Seeded Expanded Fixtures Bypassed Ownership

Loading an already-expanded fixture verified one final layout but bypassed real disclosure click
capture, expansion ownership, animation, and the later handoff to `/thinking`.

Principle: setting regressions that depend on disclosure state must open the real control before
changing the setting.

### One View Change Started Competing Anchor Passes

Hiding Thinking changed both thinking and compact-activity layout signatures. The Thinking pass
restored its pre-mutation anchor, then the compact-activity pass restored a stale generic anchor and
undid the correction in the same frame.

Principle: an explicit pre-mutation view anchor belongs to the complete synchronous state-change turn.
Every resulting layout-signature pass must share it before it is released.

### Expansion Ownership Outlived Direct Movement

A real disclosure click armed expansion anchoring, but downward outer movement did not release it.
The stale owner could then suppress a later Thinking anchor even after the expanded group was
offscreen.

Principle: expansion ownership yields immediately to outer wheel, transcript keyboard, touch,
scrollbar, or pointer movement.

### Nominal Duration Was Not Animation Completion

A timeout matching a stylesheet duration can fire before a delayed, paused, or rescheduled CSS
animation visually completes.

Principle: the named animation's completion is authoritative; timers provide idempotent bounded
fallback cleanup.

### Idle Placeholder Release Could Expose Blank Rows

Pinned history placeholders protected performance, but an idle-only release policy could leave an
inert shell visible while pointer ownership delayed normal hydration.

Principle: any placeholder entering the viewport hydrates before paint even while ordinary release is
blocked, and its metric-derived height is never accepted as content measurement.

### Warm Pagination Missed Repeated Boundary Frames

A warmed cache, direct jump to top, or all-at-once fixture does not reproduce a cold traversal through
multiple deferred cursor boundaries.

Principle: walk every current production boundary with user-sized movement, sample every insertion
frame, verify request order, and preserve bounded rendering through the real beginning of history.

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
   - core range, mounted overscan, pinned index/gap, and placeholder IDs
   - active scroll owner, user-ownership epoch, pending view/resize anchors, and synthetic reserves
6. Separate page insertion, row measurement, view invalidation, sticky navigation, and bottom-follow
   events.
7. For a view setting, record every layout-signature pass caused by the same state change and the
   anchor selected by each pass.
8. Identify the first frame where the visible-row invariant fails.
9. Encode that frame and interaction order as a deterministic regression.
10. Run the new regression against unchanged production code and record the expected failure.
11. Only after step 10, fix the state or geometry that becomes invalid on that frame.
12. Rerun the exact session from bottom to top, including every async settle frame.
13. Reproduce container-specific timing in an actual isolated VS Code Extension Development Host when
    browser fixtures cannot match webview layout or animation ordering.
14. Run the broader unit, scroll, streaming, layout, and performance suites.

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
- Exercise the production interaction that establishes ownership. A pre-expanded fixture is not a
  substitute for a real disclosure click; a direct `scrollTop` assignment is not a substitute when
  native PageDown, Space, touch, or wheel ordering is the reported trigger.
- For named CSS transitions, test actual animation completion and the fallback path. The nominal timer
  duration alone is not a valid visual-completion assertion.
- Assert the same row ID before and after a transition. "Some row is visible" proves coverage, not
  stability.
- Preserve bounded DOM row counts while adding anchor protection. Rendering the full transcript is
  not an acceptable scroll fix.

## Required Regression Coverage

Changes to `MessageList`, `VirtualizedContent`, row measurement, message windowing, sticky prompts,
attachments, or inline editing should run at least:

```sh
npm run test -- src/webview/components/MessageList.test.ts
npm run test -- src/webview/components/message-list/virtualization.test.ts
npm run test -- src/webview/hooks/useOpenCode.sessionState.test.ts
npm run test:e2e -- e2e/tests/scroll-auto-scroll.spec.ts
npm run test:e2e -- e2e/tests/scroll-viewport-coverage.spec.ts
npm run test:e2e -- e2e/tests/layout.spec.ts
npm run test:e2e -- e2e/tests/settings.spec.ts
npm run test:e2e -- e2e/tests/performance.spec.ts
npm run lint:check
npm run typecheck
```

Also run the suites that own the changed contract:

| Changed area | Additional suites |
| --- | --- |
| Parent/child history reconciliation | `src/webview/lib/state-messages.optimistic.test.ts`, `src/webview/perf/state.perf.test.ts` |
| Width batching or mount bounds | `src/webview/perf/message-list-virtualization.perf.test.ts`, `e2e/tests/performance.spec.ts` |
| Diff, sticky, width, and pagination interaction | `e2e/tests/scroll-diff-preview.spec.ts` |
| Thinking or disclosure visibility | `e2e/tests/settings.spec.ts` |
| Activity tray lifecycle or reserves | `e2e/tests/layout.spec.ts`, `e2e/tests/scroll-streaming.spec.ts`, `e2e/tests/scroll-auto-scroll.spec.ts` |
| Placeholder/range coverage | `e2e/tests/scroll-viewport-coverage.spec.ts` |

Tool-card rendering tests are supporting coverage only. They do not replace activity entrance, exit,
reserve, or anchoring tests.

Relevant browser regressions must cover:

- heterogeneous row heights after paginated history prepends
- a cold newest-page window slowly crossing every deferred cursor boundary to the real top
- request page size, cursor order, request count, banner removal, viewport coverage, and bounded mounts
- upward wheel scrolling without same-row viewport jumps
- image space before and after loading
- sticky navigation to text, terminal, and image messages
- edit entry while the source row is partially hidden
- cancellation of navigation settling when the destination is clicked
- bottom-follow remaining disengaged during manual upward scrolling
- one-way width narrowing while the same detached row remains at the same viewport top
- structural insertion and removal above the viewport during slow wheel input
- native movement after a prepend but before its settle frame
- native PageDown, Space, and Shift+Space movement while history or width settling is pending
- downward input during append animation without reverse movement on the next frame
- pre-message chrome when classifying the first visible row
- non-scrollable initial windows and cursor-only pagination progress
- active parent and child streaming state during parent pagination
- offscreen height invalidation for every view mode that changes rendered content
- Thinking hidden after opening the real disclosure, moving it offscreen, and capturing a
  non-clampable mid-transcript anchor
- semantic zero-height rows gaining message content, model-change chrome, or dialog summaries
- running activity moving through retained and exiting states into a group owned by another message
- detached anchors and bottom-pinned content across every activity-exit frame and reserve release
- active-tray entrance completion keeping the newest item visible, and exit completion waiting for the
  named CSS animation with bounded fallback
- pinned-gap placeholders retained during input, hydrated when visible, and never measured as content
- width narrowing and widening as one transaction, including font reflow, bounded mounts, bottom
  follow, and direct user detachment
- hidden child messages not affecting visible parent row actions
- empty boundary prompts, nested destination scrollers, prompt-load failures, and same-session window
  resets

## Review Checklist

- Does every derived index react to message order changes?
- Does every cache state which ordered ID list produced it?
- Did virtualization bootstrap from exact current-window measurements without remounting the full
  transcript during later appends or prepends?
- Do core range, overscan, pinned rows, and pinned-gap placeholders retain their distinct semantics?
- Can a visible placeholder remain blank, or can its virtual height be promoted to an exact content
  measurement?
- Are container and row-only coordinates converted at every virtual lookup?
- Can asynchronous content change a mounted row's height after measurement?
- Can a view setting change an unmounted row while leaving its old height marked exact?
- Can a semantic zero-height row gain any row-local chrome without clearing its cached zero and forcing
  hydration?
- Is a visible anchor preserved when height changes occur above it?
- Was a width anchor captured before the first changed measurement was applied?
- Is width publication deferred only while the mounted range still covers the viewport, and does
  direct input release the width transaction?
- Is the test checking row viewport geometry rather than only `scrollTop`?
- Does the test sample intermediate frames rather than only the settled result?
- Does the test use pagination if production uses pagination?
- Does history alignment begin before reactive DOM mutation and clean its observer/frame loop on every
  cancellation path?
- Does parent pagination preserve interleaved child entry and part identity?
- Can an empty, duplicate, stale, or non-scrollable page leave valid history unreachable?
- Does a session-local response preserve other loaded sessions and their streaming state?
- Can another scroll owner run at the same time?
- Does direct transcript movement release stale expansion ownership before a later setting or resize
  captures geometry?
- Can one preference change start multiple layout-signature passes, and do all of them share the same
  explicit pre-mutation anchor?
- Does a compact activity transition preserve part visibility and release any bottom reserve on every
  completion, cancellation, and user-ownership path?
- Does visual activity completion follow the matching CSS animation with an idempotent fallback?
- Does the bounded active tray keep the newest item visible after entrance completion without leaking
  nested scroll ownership?
- Can native movement continue without another wheel or key event after ownership was assigned?
- Are PageDown, Space, and Shift+Space excluded from transcript ownership inside editable controls?
- Are post-message flow chrome and jump-to-latest excluded from row prefixes and row measurement?
- Does user interaction cancel settling before changing layout?
- Are visible row actions derived from the rendered thread rather than hidden tree messages?
- Was the original reported session or an exact equivalent rerun end to end?
