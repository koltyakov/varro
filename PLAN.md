# Migration Plan: Adopt opencode v2 (`session.next.*`) events

## Goal

Lean on the richer, durable opencode **v2 event stream** (`session.next.*`, served over
`/api/event`) to remove the "resync the whole session whenever something looks incomplete"
machinery and the message-guessing heuristics in the webview event handler. **v2 is the
sole transport** — the legacy `/event` route and its fallback path have been removed. The
only thing still consumed in "v1 shape" is the server's *projected* `message.*` events,
because those are the only render-ready source of message parts (see DECISIVE FINDING).

## Background / what's actually on the wire

- varro (webview) consumes events via the extension's `ServerEventBridge`, which forwards
  what the opencode **`/api/event` SSE route** emits.
- That route maps every event to `{ id, type, data, seq?, version? }`.
  - ✅ The **full `event.data` is delivered** — `assistantMessageID`, `textID`,
    `reasoningID`, `callID`, the complete `text` / tool `input` / tool `output`, `cost`,
    and `tokens`.
  - ✅ **`seq` is delivered** on synchronized events (absent on ephemeral `*.delta`
    fragments), enabling per-session gap detection → targeted resync.
- `/api/event` scopes by the `x-opencode-directory` header varro already sends; for local
  single-workspace use the connection and event `workspaceID` are both undefined, so they
  match. It emits **no heartbeat**, so the idle-timeout reconnect doubles as the liveness
  check on a quiet stream.
- varro's pinned `@opencode-ai/sdk` is exactly `1.17.4`, matching `tmp/opencode`, so the v2
  event data shapes in `tmp/opencode/packages/core/src/session/event.ts` are authoritative.

### DECISIVE FINDING: v1 `message.*` events are the server's projection of v2

`packages/core/src/session/projector.ts` consumes the v2 `session.next.*` events via
`events.project(...)`, runs them through `SessionMessageUpdater` (`message-updater.ts`),
and **emits the v1 `message.updated` / `message.part.updated` events as the render-ready
projection**. The v1 events are themselves `EventV2.define`d (in `core/src/v1/session.ts`)
and published on the same bus.

**Implication for varro:** rebuilding message parts from raw `session.next.*` events in the
webview would reimplement `message-updater.ts` client-side — the text/reasoning aggregation,
the tool state machine, usage accounting, compaction handling. That is an
**anti-simplification** and a correctness/maintenance hazard. So the correct way to
"migrate to v2" is **not** to replace the v1 content path. It is:

1. Use v2 **linkage fields** (`assistantMessageID`) to delete client-side guessing — pure
   win, no duplication. ✅ (Phase 1)
2. Use v2 **`seq`** to make resync *targeted* instead of *defensive*, while still rendering
   from the server-projected v1 parts. (Phase 4 — needs a transport change.)

Content-reconstruction phases (old Phase 2-text / 3 / 5) are therefore **dropped** below.

### Key v2 event facts (from `tmp/opencode/.../session/event.ts`)

- Events split into **Durable** (replayable, full-value boundaries) and **Ephemeral**
  (the `*.delta` fragments, live-only). Comment in source: *"Stream fragments are
  live-only; `Text.Ended` is the replayable full-value boundary."*
- `*.Ended` / `Tool.Called` / `Tool.Success` carry the **complete** value with a stable id:
  `Text.Ended{ assistantMessageID, textID, text }`,
  `Reasoning.Ended{ assistantMessageID, reasoningID, text }`,
  `Tool.Input.Ended{ assistantMessageID, callID, text }`,
  `Tool.Called{ assistantMessageID, callID, tool, input }`,
  `Tool.Success{ assistantMessageID, callID, structured, content, result }`.
- Every text/tool/reasoning/step event carries `assistantMessageID` explicitly.
- Every durable event carries `timestamp` (`Base.timestamp`).

---

## Phase 0 — Accurate event types (foundation, zero runtime change)

Extend `ServerEventPropertiesByName` in `src/shared/opencode-types.ts` to type the
message-linkage / full-value fields the wire already carries. Pure type additions, all
optional (server may omit on older builds). No behavior change.

- [x] Add `assistantMessageID?` + `textID?` to `session.next.text.{started,delta,ended}`
- [x] Add `assistantMessageID?` to `session.next.reasoning.{started,delta,ended}`
- [x] Add `assistantMessageID?` to `session.next.tool.{input.started,input.delta,input.ended,called,progress,success,failed}`
- [x] Add `assistantMessageID?` to `session.next.step.{started,ended,failed}`
- [x] Add `messageID?` to `session.next.{agent.switched,model.switched,synthetic,shell.started,compaction.started,compaction.ended}`
- [x] `npm run typecheck` clean

## Phase 1 — Attach reasoning to the exact message via `assistantMessageID`

Today reasoning parts are attached to `latestAssistantMessageForSession()` (a heuristic:
"last non-completed assistant message"). The v2 events name the owning message directly.

- [x] `ensureReasoningPart` / `withReasoningMessage` accept an optional
      `assistantMessageID`; when present and that message is loaded, attach to it directly.
- [x] Fall back to the existing `latestAssistantMessageForSession` heuristic when the
      field is absent (older server) — preserves current behavior exactly.
- [x] Keep the resync-then-retry fallback when the named message isn't loaded yet.
- [x] Wire `assistantMessageID` through the three reasoning handlers (started/delta/ended).
- [x] Tests: existing reasoning tests still pass; added a test proving direct attachment to
      a non-latest message when `assistantMessageID` is supplied (49/49 pass).

## Phase 2 — reasoning.ended targeting ✅ (done in Phase 1)

- [x] `session.next.reasoning.ended` upserts full text via the Phase 1 `assistantMessageID`
      path. This is safe because reasoning text is owned by the v2 reasoning events (varro
      already created/streamed the part by `reasoningID`); it does not duplicate the
      projector.

## ~~Phase 3 — reconstruct tool parts from v2 events~~ — DROPPED (anti-simplification)

Would reimplement the server's tool state machine (`message-updater.ts`) in the webview.
Tool parts already arrive fully projected via v1 `message.part.updated`, and v2 tool
timestamps are already folded onto them by the existing `toolExecutionTimes` bridge. No win.

## Phase 4 — `seq`-based targeted resync ✅ (v2 is the sole transport)

Replace the *defensive* "resync the whole session whenever something looks incomplete"
behavior with *targeted* recovery driven by per-session `seq` gaps, while still rendering
from the server-projected `message.*` parts. `/api/event` is now the only event transport;
the legacy `/event` route, the opt-in setting, and the fallback path were all removed.

- [x] **Component A — seq plumbing.** `parseServerEvent` preserves `seq` when present
      (`protocol.ts`); `ServerEvent` gains an optional `seq`. `undefined` on ephemeral
      deltas. Tests (`protocol.test.ts`) cover sync events + raw v2 payloads.
- [x] **Component C — sole transport.** `OpenCodeTransport` subscribes to `/api/event`
      (constant `EVENT_STREAM_PATH`); `observeServerEvent` reads the v2 `data` payload.
      The `useV2EventStream` option, `OpenCodeServer` ctor arg, `extension.ts` getter, and
      `varro.experimental.useV2EventStream` setting are gone. Path test asserts `/api/event`.
- [x] **Component B — gap detection.** Per-session `lastSeqBySession` cursor + `noteSeq()`
      in `session-event-handlers.ts`. The generic progress loop resyncs only on a real seq
      gap; contiguous synchronized events skip the refetch, while events with no `seq`
      (ephemeral deltas) keep the defensive resync. `message.part.updated` /
      `message.part.delta` advance the cursor so gap detection stays accurate. Tests cover
      in-order (no resync), gap (resync), and ephemeral/no-seq (resync) paths.

**Known characteristics (acceptable, noted for future tuning):**

- `/api/event` scopes by the `x-opencode-directory` header; for multi-workspace / control-
  plane setups events may carry a `workspaceID` the connection does not, which the route
  filters on. Local single-workspace use (the common case) matches on `undefined`.
- `/api/event` emits no heartbeat, so a long-idle stream reconnects on the idle timer. The
  reconnect is graceful and gap detection repairs any events missed in the window.

Follow-ups (optional, not blocking):

- [ ] Extend gap-gated suppression to `message.part.updated`'s incomplete-part resync and
      `message.part.delta`'s missing-part queue.
- [ ] If idle reconnects prove noisy, add a heartbeat server-side or relax the idle timer.

## ~~Phase 5 — client-side part reconstruction~~ — DROPPED

Reconstructing parts from raw `session.next.*` events would reimplement the server projector
client-side. Out of scope by design: varro keeps consuming the projected `message.*` parts
(the only render-ready source), and the refetch machinery is trimmed by Phase 4's seq gap
detection instead.

---

## Verification per phase

- `npm run typecheck`
- `npm run test -- src/webview/hooks/session-event-handlers.test.ts`
- `npm run lint:check`
- Manual smoke (later phases): streaming text, reasoning, tool calls, child sessions,
  compaction, and reconnect all still render identically.

## Status

- Phase 0: ✅ complete (types extended)
- Phase 1: ✅ complete (reasoning attaches via `assistantMessageID`)
- Phase 2: ✅ complete (reasoning.ended covered by Phase 1)
- Phase 3: ❌ dropped — anti-simplification (would duplicate server projector)
- Phase 4: ✅ complete — `/api/event` is the sole transport; seq gap detection live
- Phase 5: ❌ dropped — would require reimplementing the server projector client-side

Full suite: 1864/1864 pass; typecheck + lint clean.

**Net:** v2 (`/api/event`) is now the only event transport. Synchronized events drive
per-session gap detection so we resync only when a durable event is actually missed; the
projected `message.*` events remain the render-ready source of parts (the one thing only
available in "v1 shape"). No opt-in setting and no legacy `/event` fallback remain.
