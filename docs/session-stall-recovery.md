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
configuration is edited. Older backends, attach-only connections, HTTP streams,
and other providers are not changed.

The subsequent recurrence used a reused server whose temporary config predated
the default. Reloading the editor does not relaunch that backend. Maintenance now
also reconciles the default for reused V2 servers whose live process, private
config owner, and current ownership lease all belong to this host. It checks the
effective provider policy and leaves explicit settings and unrelated runtime
configuration intact. The live backend version, not the installed executable's
version, gates the update. Atomic replacement prevents partial config reads.

Configuration reload is deferred until two global restart-blocker snapshots show
no running sessions, background work, pending questions, or permissions. Ownership
and connection generation are rechecked before reload. Failed/deferred attempts
remain retryable on maintenance and idle events, including reused connections
that deliberately suppress automatic CLI upgrades. No process restart is needed.
Send and steering-resume preflight also check the policy, so the first send after
editor reload does not have to wait for the five-minute maintenance interval.
Another active host's server is not claimed or rewritten. An already-running
provider exchange cannot acquire a new timeout; stop it explicitly before applying
the policy. Do not restart or modify production sessions to test this behavior.

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
consumes nor removes pending input and does not automatically resume it. Parked
steering now exposes **Resume steering** when the session is idle and no approval
blocks it. The host checks authoritative status/attention and normal prompt
admission before waking the first existing steering message by its original ID.
OpenCode 2.0.20 rejects an inbox PATCH to its already-current delivery, so this
uses idempotent prompt admission with `resume: true`. The existing content and
attachments are retained, no new user message is added, and queued prompts stay
parked. Failed resumes leave the prompt available for retry.

## Regression verification

Unit coverage lives in `open-code-process.test.ts`, `server.test.ts`,
`opencode-v2.test.ts`, `rest-proxy.test.ts`, `ChatInput.test.ts`,
`session-controls.test.ts`, and `session-event-handlers.test.ts`.
`opencode-v2.integration.test.ts` uses a separate database and local providers:
one accepts a WebSocket then sends no frames, exercising a 200 ms test policy
applied by reloading a backend that started without that timeout;
another holds a provider request while steering is enqueued and cancellation
preserves both interruption history and the pending prompt, then resumes that
same prompt without duplicating it or consuming parked queued input. These are backend
and reconciliation checks, not a real-editor visual verdict.
