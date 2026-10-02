# Windows startup: engineering and AI refactoring notes

Read this before changing startup, health probes, transport authorization, credential
restoration, or webview bootstrap. These notes complement [server ownership](server-ownership.md),
[permission lifecycle](permission-lifecycle.md), and [message-list virtualization](message-list-virtualization.md).

## Why Windows needs an explicit contract

Windows listener inspection uses `netstat.exe` and PowerShell/CIM. Starting PowerShell
can cost hundreds of milliseconds or multiple seconds under load. Serial ownership
and account verification can expire each other's independent one-second caches;
logical API operations can also authorize again for each underlying wire request.
Concurrent callers already share in-flight inspection. Do not assume every concurrent
request launches its own PowerShell, or that warm isolated timing represents VS Code.

The native Windows inspector now keeps one read-only PowerShell helper per extension
host, compiling its Windows API bridge once. Warm reads use process handles and token
SIDs, not CIM/WMI. Concurrent executable/account reads share only the in-flight result;
the next read obtains a new observation. Handles are closed on every path, the process
must remain alive through observation, and creation ticks retain CIM's microsecond
precision for existing leases. Missing token evidence is never same-user proof.
The helper has a five-second request bound, is retired after 60 idle seconds, and exits
on stdin EOF when the host disappears. Failed native inspection falls back to fresh,
bounded CIM inspection rather than reusing old evidence.

Managed-launch confirmation also uses that helper for native parent-process reads.
It holds ancestor handles through verification, rejects parents created after their
children, and requires the exact launch PID plus the host birth identity. Restricted
or exited ancestry falls back to fresh bounded CIM inspection. Ambiguous listener
sets never select an arbitrary process as launch ownership proof.

The native helper integration test runs in a Node-environment Vitest project after
the parallel unit suite. This avoids making PowerShell startup and `Add-Type`
compete with jsdom workers on Windows CI without relaxing the production timeout.
Its suite fixture shares one helper and allows one retry only when cold startup
hits that five-second deadline. Assertion reads never retry and always obtain fresh
observations. Persistent startup failures still fail setup; deterministic unit tests
check the exact deadline, rejection of all pending reads, and restart without cached
or partial evidence. The native suite does not prove cold startup always fits five seconds.

Logical REST requests carry an internal admission ticket through their adapter wire
requests. For strict initial/foreign/unknown admission, its expiry is the **earlier
original** account/ownership verification expiry, not one second after both checks
finish. Complete same-user running connections reuse their generation-bound process
confirmation and issue tickets lasting at most one second without OS subprocesses.
Unrelated requests cannot reuse a ticket. Cancellation, failed admission, and stream
reconnect invalidate tickets. SSE always performs its own fresh reconnect check.

Routine ownership inspection of confirmed same-user connections now runs every thirty
seconds in the background. Missing or timed-out evidence does not revoke prior
confirmation, block REST, or become a server failure. Endpoint/registration changes,
observed process exit, PID/birth/account changes, reset, and reconnect require fresh
admission. This attachment confirmation never grants permission to stop a server;
restart, adoption, maintenance, and cleanup retain their independent identity checks.

Commit-message preparation has a separate bounded deadline from model generation.
Git history and server preparation run concurrently, and model selection is reused
when one-shot generation falls back to a helper session. Preparation timeout reports
the connection phase instead of misreporting a model-generation timeout.

VS Code SecretStorage is another asynchronous editor-host round trip. An unavailable
or slow credential vault must not gate startup when a verified private ownership lease
already supplied credentials. The lease remains the cross-window credential source;
SecretStorage is only a fallback for a matching credentialless lease. Never take
credentials from an unverified lease or a different launch owner.

Credential fallback reads have a five-second deadline and honor startup cancellation.
The redundant SecretStorage copy after a managed launch runs in the background with
the same bounded wait. Its owner-bound payload cannot change runtime connection state.
Health polling has a thirty-second elapsed-time budget, including endpoint probe time;
its cancellation reaches the underlying transport. Ownership confirmation and cleanup
still settle independently before another mutating launch is allowed.

The October 2026 investigation also found a false connection-failure path: a slow
obsolete health endpoint prevented fallback to a responsive `/api/info`, while the
webview stayed behind a full-screen loader after the server was already running.
The local-database session-summary optimization did not fix that readiness barrier.

## Startup flow to preserve

1. Verify/reuse the existing registration and its private lease credentials before
   considering discovery or a new process. Reuse must not imply permission to stop it.
2. Use SecretStorage only when the verified matching lease lacks a password. Keep
   owner/username/password validation and credential confinement to the endpoint.
3. Verify health, including API family and supported version. Remember the successful
   endpoint for this URL. OpenCode V2 normally uses `/api/info`; `/api/status` can be
   obsolete. Forget the preference when the URL changes.
4. Admit the listener/account before requests or SSE. Ownership and account checks
   may run concurrently, but **both must succeed before any protected HTTP traffic**.
    Preserve fresh reconnect checks, in-flight deduplication, and one-second strict
    admission/ticket limits. Running same-user connection reuse requires complete
    PID/birth/account evidence and independent background monitoring, not PID-only trust.
5. Begin SSE before publishing running state, so initial snapshots cannot get ahead
   of event subscription. Running transport state is not yet webview readiness.
6. Bootstrap essential data: session catalog, routing catalogs, pending questions,
   pending permissions, status hydration, restored view/history, and interrupted
   recovery. Keep session-selection, visible-anchor, and generation ownership intact.
7. Publish connection initialization, then refresh optional compatibility/provider-auth
   details, workspace overview statuses, MCP/LSP status, and recycle-bin contents in
   the background. Background failures are logged, not connection failures, and must
   not put a restored chat back behind the loader.

Startup session selection starts MCP reconciliation but does not wait for it to
finish before exposing restored history (`waitForMcpSync: false`). Ordinary selection
keeps its existing wait. Send and interrupted-continue paths still reconcile MCPs
before dispatch, so faster display must not send with stale MCP configuration.

Essential snapshot readiness is separate from permission automation completion.
Known automatic requests retain their bounded owner; unknown ancestry is visible
while classification continues. Pending automatic requests also block interrupted
recovery even when their prompt is hidden. Snapshot mutation guards and reply
acknowledgement still decide when a request is resolved.

Session, routing, and question loads share applicable in-flight reads. Required-load
failure does not mean readiness and does not release the routing send gate. Initial
SSE reconciliation waits for active bootstrap rather than superseding its snapshots.
Status fetching overlaps essential snapshots, and its generation-bound result is
reused for hydration/restoration with the original event-versus-snapshot timestamp.
The optional default-model lookup has a one-second cancellable budget and no retry;
a late response cannot overwrite the selected model. Startup errors offer initialization
retry without restarting a healthy server or clearing unrelated errors.

Native todo hydration has a one-second cancellable read budget, with message-derived
todos as its fallback. Selection resets and native events invalidate older native reads;
a late success or failure cannot overwrite newer todo state or prolong transcript hydration.

Optional V2 generation timing has a two-second budget covering annotation reads,
request admission, and durable-log retrieval. Queued annotation writes do not gate
history projection. Caller cancellation still rejects the history request, and an
expired timing read cannot apply a late durable-log result.

Provider quota refresh has a twelve-second whole-operation budget, including provider
catalogs and credential discovery. Expired reads abandon only their own cached snapshot
so a later refresh can retry; late adapter results cannot replace the returned fallback.
Codex HTTP calls combine that cancellation with their existing request deadlines.

Ask-agent and stream-timeout maintenance can run before sends. Their read-only
preparation has a two-second budget per repair, with cancellation checks before any
subsequent mutation. Stream-timeout reload verification has its own two-second read
budget. Do not race an owned config write, ownership acquisition, reload, or restart
against these optional deadlines. Keep global busy/attention checks fail-closed,
including inaccessible loaded Windows/UNC locations; a path error is not proof that
a pending request is resolved or that restarting is safe. V2 restart preflight uses
the server's loaded-location list rather than statting historical session paths.
Global active status and observed attention remain blockers for historical paths.

## Recovery and security invariants

- Each health probe is bounded. A probe timeout/network/parsing failure may try the
  next health endpoint, but an explicit authentication rejection must not be bypassed
  by trying an unauthenticated fallback. Caller cancellation stops the sequence.
- Webview health recovery has at most three attempts with 500 ms gaps. Only transient
  unhealthy/network failures retry; consent, identity, authentication, and unsupported
  version errors do not. Check the connection generation before/after every await.
  Never restart a healthy shared server merely to recover webview initialization.
- Report the failing phase: connection, startup data, or view restoration. On success,
  clear startup-prefixed errors only; do not erase an unrelated send/tool error.
- Preserve PID birth-identity checks, executable comparisons, account/SID checks,
  unknown/different-user consent, listener ambiguity handling, and private-file checks.
  A missing observation is not same-user or ownership proof. PID-only caching is unsafe.
- If replacing inspections with a shared coherent snapshot later, include port, PID,
  process creation identity, executable, listener SID, host SID, and observation age.
  Invalidate on endpoint/reset/reconnect and retain post-observation PID-reuse checks.
  A new cache must not mask a listener replacement or skip confirmation reinspection.
- Keep drive-letter normalization and workspace authorization on the V2 path. Windows
  can use unscoped server session reads followed by local workspace projection; do not
  remove that projection or replace local summaries with N per-session API reads.

## Regression checklist for agents

Run the standard lint, format, typecheck, and suggestion checks plus these unit files:

```sh
npm run test -- src/extension/open-code-process.test.ts src/extension/open-code-transport.test.ts src/extension/server.test.ts src/extension/server-connection-admission.test.ts src/extension/process-inspection.test.ts src/webview/hooks/connection-bootstrap.test.ts src/webview/hooks/session-selection.test.ts src/webview/hooks/session-send.test.ts
npm run test:e2e -- e2e/tests/server-status.spec.ts e2e/tests/mcp.spec.ts e2e/tests/reload-persistence.spec.ts e2e/tests/busy.spec.ts
```

Keep coverage for a never-resolving vault with valid private credentials, matching
credentialless vault restoration, health fallback after timeout, remembered health
endpoint/URL reset, authentication rejection, cancellation, bounded retries, stale
generation suppression, optional loaders that never settle, essential snapshot gating,
startup error cleanup without losing unrelated errors, and MCP reconciliation at send.
Fresh ownership/account admission failure must result in **zero protected HTTP
requests**. Inconclusive background inspection of a previously confirmed connection
must not block its requests or be reported as an actual server failure.

For performance validation, separately time registration, credential lookup, health,
account admission, SSE attachment, essential bootstrap, status hydration, restored
history, and optional refresh. Report cold/warm runs and Node/VS Code versions. Use
read-only health or disposable fixtures for microbenchmarks. Do not equate the first
summary log with UI readiness or blame antivirus without measuring it.

Host diagnostic exports retain redacted `startup-phase` durations with attempt and
generation IDs, platform, architecture, and runtime version. Webview startup phases
are logged separately using the renderer's clock. Renderer performance entries
`varro.transcript.hydration-start`, `varro.transcript.ready`, and
`varro.transcript.hydration` observe the existing transcript-positioning hold. They
do not shorten that hold or prove OS-displayed paint; retain native visual checks.

For real-editor/AI verification follow [AI test workflow](ai-test-workflow.md) and use
isolated editor/database fixtures. Never restart the user's production server, mutate
existing sessions, or change security settings to benchmark startup. Host-only unit
or fixture timings are not a visual/performance pass. If Vitest fork workers fail to
start on Windows, a bounded recovery with `--pool=threads --maxWorkers=1` is acceptable;
report that recovery and remaining failures rather than hiding them.
