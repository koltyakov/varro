# Silent provider streams and cancellation reconciliation

The October 1, 2026 investigation found a saved OpenCode 2.0.20 execution with
about 26 minutes between its last completed tool and cancellation. No running
tool explained that interval. Cancellation was persisted as `interrupted`, but
the open transcript did not show it until reopening. Existing logs do not prove
the exact provider/network wait responsible for that production stall.

## Backend mitigation

The released source at `8d8a7bc844` has a 30-minute WebSocket no-data default:

- [`model-transport.ts`](https://github.com/anomalyco/opencode/blob/8d8a7bc844/packages/core/src/session/model-transport.ts)
  applies `Stream.timeoutOrElse` to received frames and closes failed sockets.
- [`model-resolver.ts`](https://github.com/anomalyco/opencode/blob/8d8a7bc844/packages/core/src/model-resolver.ts)
  and [`model-request.ts`](https://github.com/anomalyco/opencode/blob/8d8a7bc844/packages/core/src/session/model-request.ts)
  pass `providers.<id>.settings.chunkTimeout` to that transport.

Varro injects a five-minute OpenAI `chunkTimeout` for newly launched managed
OpenCode V2 servers from 2.0.20 onward. This bounds one silent WebSocket exchange,
not the whole execution or the backend's retry policy. Frames reset the bound;
legitimate reasoning with no frames for five minutes can also time out.

Explicit `timeout` or `chunkTimeout` settings suppress the default, including
legacy provider options, inherited inline configuration, global configuration,
ancestor configuration above the repository, and `.opencode` configuration.
Unreadable or malformed policies are not overwritten. No persistent user
configuration is edited. Older backends, attach-only connections, reused servers,
HTTP streams, and other providers are not changed. A fresh managed launch is
needed to apply the runtime default; do not restart a production server to test it.

## Transcript correction

- Preserve native execution interruption as `MessageAbortedError` before idle,
  with only one durable sequence advance.
- Pending inbox rows do not hide the preceding assistant from error handling.
  Delivered user rows remain boundaries, and child-session rows are never changed
  by their parent's interruption.
- Idle reconciliation refreshes pending delivery and cancellation even when
  native todo handoff succeeded.
- After each abort acknowledgement, refresh authoritative messages independently
  of SSE. A failed refresh is logged without undoing a successful stop.

Steering still waits for a safe provider-turn boundary. Cancellation neither
consumes nor removes pending input and does not automatically resume it.

## Regression verification

Unit coverage lives in `open-code-process.test.ts`, `opencode-v2.test.ts`,
`session-controls.test.ts`, and `session-event-handlers.test.ts`.
`opencode-v2.integration.test.ts` uses a separate database and local providers:
one accepts a WebSocket then sends no frames, exercising a 200 ms test policy;
another holds a provider request while steering is enqueued and cancellation
preserves both interruption history and the pending prompt. These are backend
and reconciliation checks, not a real-editor visual verdict.
