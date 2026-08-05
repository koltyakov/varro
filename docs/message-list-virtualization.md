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

### Height Accounting

- `measuredHeights` is keyed by message ID and contains the current rendered block size for that
  message.
- `virtualMetrics.prefix[index]` must describe the same ordered ID list used by the renderer.
- Cached prefix entries may only be reused while both the ID order and all earlier effective heights
  remain valid.
- A row measurement correction above the visible anchor must preserve that anchor's viewport
  position.
- Content below the anchor may change `scrollHeight`, but it must not move the anchor.
- Asynchronous content must reserve its final layout space where practical. Images are the primary
  example: loading an image after its row remounts must not add hundreds of pixels to the row.

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
- Switching compact file-edit pages takes ownership from bottom-follow and keeps the pager fixed
  while differently sized diffs replace each other above it.

### Sticky Prompts

- A sticky prompt is a derived overlay for a real user message. Its message ID must remain the sole
  navigation identity.
- Navigation aligns the real `.user-message-card`, not an estimated row position or attachment
  summary.
- The destination uses the same top gap as the sticky box.
- Terminal selections, image-only prompts, context-only prompts, and normal text prompts must all
  follow the same navigation path.

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
still failed. The production path loads 50 messages and prepends older pages. Loading all messages at
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
2. Match extension pagination: initial 50-message window and `before` page prepends.
3. Match the reported viewport width because wrapping and image preview height affect rows.
4. Record, for every scroll step:
   - requested wheel delta
   - first visible message ID
   - that same row's viewport top before and after
   - `scrollTop`, `scrollHeight`, top spacer, and bottom spacer
   - mounted row IDs and measured heights
5. Separate page insertion, row measurement, sticky navigation, and bottom-follow events.
6. Identify the first frame where the visible-row invariant fails.
7. Fix the state or geometry that becomes invalid on that frame.
8. Rerun the exact session from bottom to top.
9. Add a deterministic regression that fails for the demonstrated reason.
10. Run the broader scroll and layout suites.

## Required Regression Coverage

Changes to `MessageList`, `VirtualizedContent`, row measurement, message windowing, sticky prompts,
attachments, or inline editing should run at least:

```sh
npm run test -- src/webview/components/MessageList.test.ts
npm run test:e2e -- e2e/tests/scroll-auto-scroll.spec.ts
npm run test:e2e -- e2e/tests/layout.spec.ts
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
- unequal-height compact file-edit page switches

## Review Checklist

- Does every derived index react to message order changes?
- Does every cache state which ordered ID list produced it?
- Can asynchronous content change a mounted row's height after measurement?
- Is a visible anchor preserved when height changes occur above it?
- Is the test checking row viewport geometry rather than only `scrollTop`?
- Does the test use pagination if production uses pagination?
- Can another scroll owner run at the same time?
- Does user interaction cancel settling before changing layout?
- Was the original reported session or an exact equivalent rerun end to end?
