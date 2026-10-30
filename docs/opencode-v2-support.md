# OpenCode v1 and v2 support

Research date: September 19, 2026. The implementation supports v1 from 1.16.0 and v2 from 2.0.5 through automatic extension-host adapters.

V2 is recommended for new installations; v1 remains supported. See the [usage guide](usage.md#choose-and-update-opencode) for installation, version selection, updates, and configuration compatibility. Current packages both install `opencode`. Varro also recognizes older or custom `opencode2` installations and prefers that name during automatic discovery.

## Implementation and verification

- `src/extension/opencode-connection.ts` detects protocol families and removes startup credentials before logging, including credentials split across process-output chunks.
- `open-code-process.ts` retains credentials in the private ownership lease for window handoff and reads registered local service credentials. CLI update lookup and recovery commands select the matching package family.
- `open-code-transport.ts` authenticates health, REST, and SSE requests and selects the adapter from validated server responses.
- `opencode-v2-adapter.ts`, `opencode-v2-projection.ts`, and `opencode-v2-events.ts` translate requests, transcript records, catalogs, permissions, forms, and events into the existing Varro contracts.
- `opencode-v2-session-state.ts` persists Varro-owned metadata and legacy timestamp overrides under the user's XDG state directory in `varro/opencode-v2/`. Native metadata updates are available from 2.0.15, but Varro still uses local metadata annotations. Archive changes use the native API when the server advertises its archive field; older servers retain local archive annotations.
- Native v2 agent and permission configuration keys are preserved when Varro edits a file already using them. V1-format files retain their format.

Session-info statistics try the local SQLite database before fetching API histories.
For native v2 sessions, pause metadata comes from the same read-only snapshot and
Varro's local annotations, without a mandatory session-header API request. The
session catalog still comes from the API. `Varro: Show Output` reports each summary's
source and database fallback reasons, including missing paths, unsupported schemas,
worker errors/timeouts, and fork/revert histories that require API resolution.

Annotation updates and deletions share a per-session queue within each store instance. A failed
update does not block later deletion. Cancelled updates check their signal before reading, after
reading, and before replacing the annotation file, so cancellation while queued or preparing a write
does not commit that update.

`npm run test:compatibility:adapters` installs published binaries into isolated directories and tests the production adapters. The current tested versions are v1 `1.19.5` and v2 `2.2.2`, alongside the v1 `1.16.0` and v2 `2.0.5` support floors. Release-specific results are recorded below. The checks cover managed startup, credential recovery in a second window, restart, multi-window recovery after process exit, bootstrap, workspace path encoding, v2 configuration precedence, session updates, deterministic streamed model responses, actual fixture-only tool execution, message pagination, tail editing, helper generation, fork/revert, deletion, and native v2 permissions/forms. The generated report is `artifacts/opencode-adapters/verified.json`.

Fresh VS Code sandbox windows passed `v2-first-run` and the existing `healthy-first-run` scenario. These editor checks verify activation, ownership, health, and event-stream connection. `test:compatibility:ui` additionally exercises the actual composer, successful replies, pre-turn failures, HTTP 401 handling, recovery through a working provider, and reopening history. Full visual streaming performance remains a separate verification task.

V2 control records such as agent/model selection are excluded from the transcript while their selection context is preserved. A failed execution that never created an assistant turn gets a stable error row derived from the native failure record. Live errors retain the server's diagnostic message; reopened history without that live detail still shows the recorded failure. This prevents a provider authorization error from appearing as a silently unanswered prompt.

Run the v2 editor check after building:

```sh
VARRO_SANDBOX_V2_COMMAND=/absolute/path/to/opencode2 node scripts/vscode-sandbox/run.mjs v2-first-run
```

The editor profile is disposable, and its OpenCode database is isolated under `artifacts/ai-test-data/`.

The released v2 API has no session-sharing route or arbitrary single-message deletion. OpenCode has discontinued sharing across both families; Varro offers only local cleanup of existing v1 links. Varro implements inline-edit tail deletion through file-preserving staged revert and commit. V2 also has no LSP service. Metadata annotations are local to Varro; they are not synchronized to other OpenCode clients. Switching CLI families does not perform a data migration.

Stopping a background process directly uses `DELETE /api/shell/{id}`. The served v2.2.0
OpenAPI contract and published client expose no cancellation-reason or silent-stop option;
`reason=user` is not supported. The process stops, but a background shell job can emit a
synthetic `Shell.NotFoundError` completion notice and resume its owning agent. Varro does
not inject a steering prompt or interrupt unrelated session work to suppress that backend
continuation. Silent cancellation requires an upstream API and job-notification change.

The upstream removal path fails pending shell waiters with `Shell.NotFoundError`; the
background tool converts that failed job into a synthetic session input. Filtering that
input in Varro would only hide it, not prevent backend execution. An upstream fix must
carry an explicit user-cancellation outcome through shell/job removal and suppress its
background notification. Interrupting the entire session or racing to cancel the new
inbox item is not a safe substitute for cancelling one process.

### Configuration discovery and provider connection lifecycle

Project configuration reads now follow v2's documented discovery order through the filesystem
root, followed by `.opencode` files from farthest to nearest. When an inherited `.opencode`
config would override a direct local edit, Varro writes the override inside the workspace's
`.opencode` directory. New model-routing overrides retain the inherited native `agents` format.
V1 retains its existing Git-root discovery boundary. Released v2.0.5 and v2.0.10 fixtures verify
the ancestor and `.opencode` precedence described in the [v2 configuration guide](https://opencode.ai/v2/docs/config).

Startup Ask-agent detection now accepts both `agent` and native `agents` keys in the configuration
documents it reads. Provider dialogs also cancel pending authentication on unmount, reject duplicate
submissions, and prevent a cancelled request from re-enabling controls for a newer request.

Provider forms preserve visible scalar defaults and text placeholders. Boolean fields use Yes/No
choices; the adapter converts their answers and numeric answers from the dialog's strings into native
v2 values before evaluating hidden-field conditions. Both OAuth and API-key connections submit hidden
defaults. Invalid boolean, non-finite numeric, and fractional integer inputs fail before authentication
starts. Regression tests cover both connection paths, false and zero values, and default initialization
in the dialog.

OAuth authorization responses retain their attempt IDs through the dialog and completion request.
Pending attempts are checked against their provider and workspace, so overlapping connections in
separate chat views cannot complete or remove each other's attempts. Legacy callbacks without an
attempt ID are accepted only when there is one matching pending attempt.

Hidden provider fields retain their defaults and conditions in the dialog's form definition without
rendering controls. Visible fields can depend on those defaults, including conditional hidden fields.
Removing model-routing overrides from mixed-format files targets the original `small_model`, `agent`,
or `agents` property instead of inferring its location from unrelated native settings.

### Workspace path compatibility

Directory headers now use URI encoding, matching the published v1 SDK and the server's
header decoding. Raw Unicode and embedded newlines previously caused Fetch to reject the
request before it reached OpenCode. Encoding also preserves literal percent escapes in headers.

V1 additionally URI-decodes legacy directory queries after URL parsing. Varro protects literal
percent signs at the v1 transport boundary so a folder named `literal%2Fdirectory` does not
resolve to `literal/directory`. V2 location queries retain their normal URL encoding.
The released-server adapter tests cover exact workspace resolution for Japanese text, emoji,
and literal percent escapes. Unit tests also cover header construction with embedded newlines
and preservation of Windows separators and casing.

### 2.2.2 compatibility review

Reviewed v2.2.1 to v2.2.2, `3ebcf9a32c` through `098aa7fd6e`. The complete
upstream diff is retained in `artifacts/opencode-2.2.2-upstream.diff`. All 134
OpenAPI paths remain available. Session/message APIs, permission/form payloads,
`/api/event` SSE names and payloads, and `serve`/upgrade arguments remain compatible.
Generated schemas add safe-integer bounds, flatten equivalent unions, and deduplicate
references. Optional additions include session `time.busy`, attachment source metadata,
and experimental schedule conditions and outcomes. No HTTP adapter changes are required.
V1 `1.19.5` remains current, and both support floors remain unchanged.

The new `session_part` table allows assistant content to live outside message
envelopes. Local session summaries now defer to the API when the selected session
or a descendant has separately stored parts, avoiding incomplete context and tool
totals. Empty tables and unrelated sessions retain the local path. Fixture regressions
cover all four cases without modifying source rows. Usage-report token and cost fields
remain in message envelopes and need no adaptation.

Image generation is now available by default for connected image-capable providers
as `experimental_image_generate`. Image-job notices, media preservation on fork/import,
unattended schedule checks, persistent-terminal working-directory validation, Code Mode,
and provider usage-limit fixes remain server-owned behavior. App/TUI, quote/annotation,
question-dock, timeline-cache, and styling changes are optional parity work.

The 307 focused summary/adapter/transport/form/decision tests, 631
process/server/transport/database tests, and 189 additional v2 adapter/auth tests
pass. The separately stored-part fixtures first reproduced two incomplete local
summaries, then passed with the API fallback.
`npm run fmt`, `npm run typecheck`, `npm run typecheck:suggestions`, and
`npm run build` pass, with zero suggestion diagnostics. Focused lint passes for
the changed summary files. Initial repository-wide `npm run lint` and
`npm run lint:check` reported seven errors in concurrent, unrelated session-cleanup
and usage-report work. A final lint check after that work changed reports only
`eslint(no-unassigned-vars)` for `popup` in
`src/webview/components/chat-input/ChatTextAnnotation.tsx`. These unrelated files
are not changed by this bump. Evidence uses the `artifacts/opencode-2.2.2-` prefix.

The published-server adapter matrix passed all 151 applicable checks, with
53 family/platform skips and no leaked or recovered processes. The five
compatibility-summary tests passed afterward. Evidence is
`artifacts/opencode-2.2.2-adapters.log`,
`artifacts/opencode-adapters/run-Kh1PkE/`, and
`artifacts/opencode-2.2.2-summary-tests.log`.

| Published server | Passed | Skipped | Issues found | All cases complete |
| --- | ---: | ---: | --- | --- |
| v1.16.0 | 30 | 21 | None in tested cases | Yes, applicable automated cases |
| v1.19.5 | 31 | 20 | None in tested cases | Yes, applicable automated cases |
| v2.0.5 | 42 | 9 | None in tested cases | Yes, applicable automated cases |
| v2.2.2 | 48 | 3 | None in tested cases | Yes, applicable automated cases |

No further compatibility fixes are indicated by these checks. Resolve the
unrelated lint diagnostic before requiring a repository-wide lint pass.

The v1 dependency is unchanged, so the Docker v1 support-range matrix was not
rerun. Real-editor, visual streaming, live-account action parity, and native
Windows checks were not run for this bump.

### 2.2.1 compatibility review

Reviewed v2.2.0 to v2.2.1, `86976449c4` through `3ebcf9a32c`. The complete
upstream diff is retained in `artifacts/opencode-2.2.1-upstream.diff`.
All 130 existing OpenAPI paths retain their request and response contracts;
four new paths expose opt-in experimental schedules. Session/message/part shapes,
permission/form payloads, `/api/event` SSE names and payloads, and released
`serve`/upgrade arguments remain compatible. No Varro adapter behavior changes are required.
V1 `1.19.5` remains current, and both support floors remain unchanged.

The generated client groups experimental methods under `client.experimental`
and retains deprecated aliases. Varro uses HTTP paths directly, so this regrouping
does not affect its requests. The native-decision request type now uses the new
`ExperimentalGenerateDecisionsInput` name instead of its deprecated alias.
Configuration adds schedules, image generation, and a timezone; model variants
no longer override prompt-cache settings.
Provider catalog/authentication, context sizing, throttling, snapshot, and
Code Mode fixes remain server-owned behavior. Direct `@opencode/ai` provider
removals do not affect Varro's client dependency. Goal controls, schedules,
image-generation UI, and app/TUI changes are optional parity work.

The 486 focused adapter/transport/form/decision tests and 603 process/server unit
tests pass. `npm run lint`, `npm run fmt`, `npm run lint:check`,
`npm run typecheck`, `npm run typecheck:suggestions`, and `npm run build` pass.
The suggestion check reports zero diagnostics after the type rename. Evidence
uses the `artifacts/opencode-2.2.1-` prefix.

The published-server adapter matrix passed all 151 applicable checks, with
53 family/platform skips and no leaked or recovered processes. The five
compatibility-summary tests passed afterward. Evidence is
`artifacts/opencode-2.2.1-adapters.log`,
`artifacts/opencode-adapters/run-aKjjJm/`, and
`artifacts/opencode-2.2.1-summary-tests.log`.

| Published server | Passed | Skipped | Issues found | All cases complete |
| --- | ---: | ---: | --- | --- |
| v1.16.0 | 30 | 21 | None in tested cases | Yes, applicable automated cases |
| v1.19.5 | 31 | 20 | None in tested cases | Yes, applicable automated cases |
| v2.0.5 | 42 | 9 | None in tested cases | Yes, applicable automated cases |
| v2.2.1 | 48 | 3 | None in tested cases | Yes, applicable automated cases |

No further compatibility fixes are indicated by these checks.

The v1 dependency is unchanged, so the Docker v1 support-range matrix was not
rerun. Real-editor, visual streaming, live-account action parity, and native
Windows checks were not run for this bump.

### 1.19.5 compatibility review

Reviewed v1.19.4 to v1.19.5, `148842ef7c` through `810c0eba1a`, using a separate
clean upstream checkout because `tmp/opencode` contains unrelated work. The complete
diff is retained in `artifacts/opencode-1.19.5-upstream.diff`.

Consumed HTTP routes, `/global/event` SSE names and payloads, SDK/OpenAPI contracts,
session/message/part shapes, permissions/questions, configuration, and `serve`/upgrade
arguments remain compatible. The PTY connect authorization fix aligns authentication
with the selected route without changing its public path; Varro does not use that
connection route. Other changes update the GitLab provider, propagate failed TUI
worker requests, remove unused code, and revise upstream release tooling. No Varro
adapter changes are required. V2 remains at the latest published `2.2.0`, and both
support floors remain unchanged.

The published SDK package diff changes only its version field. Evidence is
`artifacts/opencode-1.19.5-sdk.diff`.

The Docker support-range matrix passed all 524 required checks across 14 releases,
including 43/43 on `1.19.5` and 37/37 on the `1.16.0` floor. Advisory checks passed
76/78 cases. The floor and the older `1.15.13` probe retain the known incomplete
MCP pagination result; neither is a required failure. Keep the support floor
unchanged and use a newer server when complete MCP pagination is needed. The
runner regenerated `scripts/opencode-compatibility/verified.json`; the five
compatibility-summary tests passed afterward. Evidence is
`artifacts/opencode-1.19.5-compatibility.log` and
`artifacts/opencode-1.19.5-summary-tests.log`.

The published-server adapter matrix passed 150 checks, failed one on the unchanged
v2.0.5 floor, and skipped 53 family/platform cases. No leaked processes were
recovered. The changed v1.19.5 server passed all 31 applicable checks.

| Published server | Passed | Skipped | Issues found | All cases complete |
| --- | ---: | ---: | --- | --- |
| v1.16.0 | 30 | 21 | None in tested cases | Yes, applicable automated cases |
| v1.19.5 | 31 | 20 | None in tested cases | Yes, applicable automated cases |
| v2.0.5 | 41 | 9 | One intermittent credential-port-replacement assertion failure | Yes, applicable automated cases attempted; one failed |
| v2.2.0 | 48 | 3 | None in tested cases | Yes, applicable automated cases |

The v2.0.5 failure expected an attach-only restart rejection but received the
existing endpoint. Retained diagnostics show an SSE failure changed the connection
to an error state immediately beforehand. `OpenCodeServer.restart()` intentionally
retries attachment for a non-running attach-only connection. This does not establish
that an unowned process was stopped. A single focused rerun passed. Add deterministic
coverage for the SSE-error/restart transition, separately checking running-state
rejection and error-state reattachment without granting lifecycle ownership. No
startup code was changed for this dependency bump.

Evidence is `artifacts/opencode-1.19.5-adapters.log`,
`artifacts/opencode-adapters/run-n5AWxU/`,
`artifacts/ai-test-data/startup-6ajQqv/`, and
`artifacts/opencode-1.19.5-v2-floor-recheck.log`. The initial matrix remains recorded
as failed rather than being replaced by the focused pass.

All 110 transport tests and the five compatibility-summary tests passed.
`npm run lint`, `npm run fmt`, `npm run lint:check`, `npm run typecheck`,
`npm run typecheck:suggestions`, and `npm run build` passed. Real-editor, visual
streaming, live-model action parity, and native Windows checks were not run.

### Changed-port credential preparation investigation

The follow-up investigation reproduced the v2.0.5 failure deterministically. This
was a Varro connection race, not a v2.0.5 contract change or merely a flaky assertion.
After credential-only discovery followed the replacement to a new port, background
`prepareForHealthyExistingServer()` called `refreshStartupRegistration()`. Its
saved-connection probe temporarily assigned the retired record's port to the shared
process manager before rediscovering the replacement. Concurrent SSE admission
could observe the temporary endpoint and throw `ManagedServerConnectionChangedError`.
The server then entered an error state, where `restart()` correctly retried
attachment instead of rejecting a running attach-only restart. This explains the
misleading downstream assertion; it did not demonstrate unauthorized process control.

Changed-port credential preparation now verifies the selected endpoint and private
record directly, without changing ports or claiming ownership. Same-port preparation
retains its existing process-identity recovery. Credential changes still reject
admission. The fix uses the existing bounded verification and in-flight coordination.

`open-code-process.test.ts` gates a credential probe while a fresh SSE-style
verification overlaps preparation. The unchanged-record case failed before the fix
with the endpoint-change error and passes afterward; a changed-password case still
rejects both verifications. `server.test.ts` separately verifies running-state restart
rejection and error-state reattachment, including forced requests, with no stop,
restart-ownership claim, process launch, or promotion to managed ownership. The
published startup scenario now checks healthy SSE before restart rejection and
compares the listener PID before and afterward, so a stream failure is reported at
its actual phase instead of as a restart mismatch.

Evidence uses the `artifacts/opencode-2.0.5-credential-race-` prefix, including
`red.log` for the pre-fix failure and `tests.log` for 813 passing process, server,
transport, admission, monitor, and process-inspection tests. The original failed
matrix and its evidence above remain historical results.

The 152 connection-bootstrap, session-selection, and session-send tests also pass.
`npm run lint`, `npm run fmt`, `npm run lint:check`, `npm run typecheck`,
`npm run typecheck:suggestions`, and `npm run build` pass. No real-editor visual,
live-model action-parity, or native Windows results are claimed for this investigation.

The full post-fix published-server matrix passed all 151 applicable checks, with
53 family/platform skips and no leaked or recovered processes. Evidence is
`artifacts/opencode-2.0.5-credential-race-adapters.log` and
`artifacts/opencode-adapters/run-3iB9sJ/`.

| Scope | Tested behavior | Issues found | All cases complete |
| --- | --- | --- | --- |
| Focused unit regressions | 965 passed | Endpoint race reproduced before fix; none remaining in tested cases | Yes |
| v1.16.0 adapters | 30 passed, 21 skipped | None in tested cases | Yes, applicable automated cases |
| v1.19.5 adapters | 31 passed, 20 skipped | None in tested cases | Yes, applicable automated cases |
| v2.0.5 adapters | 42 passed, 9 skipped | Previously intermittent case passes with healthy SSE and unchanged listener PID | Yes, applicable automated cases |
| v2.2.0 adapters | 48 passed, 3 skipped | None in tested cases | Yes, applicable automated cases |

No further product fixes are indicated by these checks. Keep the selected-endpoint
invariant and the deterministic overlap test when changing credential preparation.

### 2.2.0 compatibility review

Reviewed v2.1.4 to v2.2.0, `2a3e7c0f34` through `86976449c4`. The complete
upstream diff is retained in `artifacts/opencode-2.2.0-upstream.diff`. Consumed
session/message/inbox shapes, permission/form payloads, and SSE names remain
compatible. One-shot generation now also recognizes v2.2.0's exact selected-model
admission error, `404 Model not found: provider/model`, so unavailable base models
can still fall back to a location-scoped helper without duplicate generation.
Unrelated errors remain non-retryable. V1 `1.19.4` and both support floors remain
unchanged.

The OpenAPI document grows from 124 to 130 paths. It adds optional SSE type
filtering, chat-default model-type filtering, GUI plugin bundles, usage limits,
file watching, image/decision generation, and media-blob retrieval. Text generation
moves to `/api/experimental/generate/text`, retaining Varro's existing path as a
deprecated alias. The removed experimental voice-instructions route is not used
by Varro. Media references require a capability header that Varro does not send;
ordinary message/inbox reads still return inline attachments, including when the
server's opt-in blob storage is enabled.

Server-owned changes include integration-supplied configuration, prompt-cache
settings, catalog updates, compaction accounting, event ordering, and session
operations that no longer initialize inactive locations unnecessarily. CLI
`serve`/upgrade arguments remain compatible. Desktop/TUI and GUI plugin changes
are optional parity work.

The initial published-server matrix passed 148 checks and failed one on v2.2.0:
the unavailable-base-model case threw the new 404 error instead of offering the
helper fallback. It skipped 47 family/platform cases and leaked no processes.
Evidence is `artifacts/opencode-2.2.0-adapters.log` and
`artifacts/opencode-adapters/run-UKFnuB/`. Regression tests cover both released
admission errors and reject generic, mismatched-model, provider-status, and
implicit-model failures. Logs use the `artifacts/opencode-2.2.0-` prefix. The
lockfile also synchronizes the existing manifest edits to Varro's version and
oxfmt/oxlint versions.

After the fallback fix, the full published-server matrix passed all 149 applicable
checks, with 47 family/platform skips and no leaked or recovered processes.
Evidence is `artifacts/opencode-2.2.0-adapters-final.log` and
`artifacts/opencode-adapters/run-TR5aTg/`.

| Published server | Passed | Skipped | Issues found | All cases complete |
| --- | ---: | ---: | --- | --- |
| v1.16.0 | 30 | 19 | None in tested cases | Yes, applicable automated cases |
| v1.19.4 | 31 | 18 | None in tested cases | Yes, applicable automated cases |
| v2.0.5 | 42 | 7 | None in tested cases | Yes, applicable automated cases |
| v2.2.0 | 46 | 3 | Model-admission fallback mismatch fixed; none remaining in tested cases | Yes, applicable automated cases |

All 845 focused tests and five compatibility-summary tests passed after the fix.
`npm run lint`, `npm run fmt`, `npm run lint:check`, `npm run typecheck`,
`npm run typecheck:suggestions`, and `npm run build` passed. Both lint runs reported
eight enum-assignment warnings in unchanged test files with the existing oxlint
update. No further product fixes are indicated by these checks.

The v1 dependency is unchanged, so the Docker v1 support-range matrix was not
rerun. Real-editor, visual streaming, live-model action parity, and native Windows
checks were not run for this bump.

### 2.2.0 integration catch-ups

Varro now treats the native chat-model catalog as authoritative on 2.2.0+. Configuration fallback
cannot restore image/decision models, excluded models, unavailable providers, or override the
server's projected model limits. Older V2 keeps its configuration fallback but skips explicit
non-chat model types. Existing configured-provider source labels and explicit provider-deny filters
still apply before skipping configuration model fallback. Text generation prefers the advertised `/api/experimental/generate/text`
route, falling back to the legacy path only during discovery. A failed generation is never retried
through the alias.

Console/Go quota reads use `/api/experimental/usage/limits` with the workspace directory and a 1 MiB
response budget before any credential access. This also works in attach-only mode. Only route 404
allows legacy local adapters; malformed, signed-out, and other error responses do not switch
accounts. Projection keeps Go allowances separate from Console-wide budgets and uses the selected
model's spend for per-model budgets, including zero when the server omits that counter.
A location-specific 404 is an error, not a reason to read local credentials.

Native decision models are an explicit opt-in through `varro.chat.autoApproveDecisionModel` or the
Models view. The experimental section is temporarily hidden unless
`varro.debug.showNativeDecisionModels` is enabled. Hiding it does not disable a configured reviewer.
Varro discovers the experimental endpoint and decision catalog, submits evidence using
the server's base configuration and credentials, and reuses the legacy Jev questions and probability
gates. Native errors fall back to opted-in legacy Jev, then the chat judge; `ask` remains terminal.
No legacy credentials/settings are migrated. V1 and older-V2 fallbacks and support floors remain
unchanged. Media references, SSE filtering, file watching, and desktop GUI plugins remain deferred.

The first catch-up matrix found two adapter regressions: skipping configuration model fallback also
skipped configured-provider source labels and deny filtering. Both are fixed without restoring any
omitted models. A third failure was an overly strict test that omitted the signed-out endpoint's
workspace-location envelope. The targeted published v2.2.0 adapter rerun passed all 38 applicable
cases, with three platform/family skips. Evidence is
`artifacts/opencode-2.2.0-catchup-v2-recheck.log`.

The 1,135 focused unit/component regressions pass. `npm run lint`, `npm run fmt`,
`npm run lint:check`, `npm run typecheck`, `npm run typecheck:suggestions`, and `npm run build` pass.
Signed-in Console/Go accounts, live decision-model generation, real-editor visuals, and native
Windows behavior are not verified by these automated checks.

The final published-server matrix passed all 151 applicable checks with 53 family/platform skips
and no leaked or recovered processes. The five compatibility-summary tests passed afterward.
Evidence is `artifacts/opencode-2.2.0-catchup-adapters-final.log`,
`artifacts/opencode-adapters/run-7vmyey/`, and the other `artifacts/opencode-2.2.0-catchup-` logs.

| Published server | Passed | Skipped | Issues found | All cases complete |
| --- | ---: | ---: | --- | --- |
| v1.16.0 | 30 | 21 | None in tested cases | Yes, applicable automated cases |
| v1.19.4 | 31 | 20 | None in tested cases | Yes, applicable automated cases |
| v2.0.5 | 42 | 9 | None in tested cases | Yes, applicable automated cases |
| v2.2.0 | 48 | 3 | Source-label and deny-filter regressions fixed; none remaining in tested cases | Yes, applicable automated cases |

No further fixes are indicated by the automated results. Before claiming live-account coverage,
verify signed-in Console/Go limits and actual native reviewer responses in an isolated editor.

A local real-editor check subsequently verified the four catch-ups with the published 2.2.0 backend
and loopback chat, decision, and Console HTTP fixtures. No live account was used. Catalog filtering,
native text success/error behavior, Console/Go displays, native allow/ask/manual rejection/Off, and
the temporary debug visibility gate passed. This does not establish live-account or model-quality
coverage. Evidence and controller recovery details are in
`artifacts/ai-fuzzy/catchup-editor-20261027-a.md`.

### 2.1.4 compatibility review

Reviewed v2.1.3 to v2.1.4, `e965774fa` through `2a3e7c0f3`. All 121 existing
OpenAPI routes are unchanged. SSE names and payloads, session/message/inbox shapes, permissions/forms,
and managed `serve`/upgrade arguments remain compatible. No adapter changes are
required. V1 `1.19.4` is still the latest published v1 release; both support floors
remain unchanged.

V2 adds experimental client-hosted MCP connections, heap-dump diagnostics, and
opt-in background compaction. These additions require no Varro integration for
existing behavior. Server-owned fixes cover MCP elicitation event locations,
OAuth callbacks and timeouts, MCP startup/shutdown, compaction overflow recovery,
native agent-file detection, agent model selection, and imported v1 project
ownership. ChatGPT model filtering and context caps remain server-owned catalog
behavior. App/TUI changes are optional parity work.

The complete upstream diff is retained in `artifacts/opencode-2.1.4-upstream.diff`.
The development/CI Node pin remains `24.22.0`; supported Node floors are unchanged.

The published-server adapter matrix passed all 149 applicable checks, with 47
family/platform skips and no leaked or recovered processes. Evidence is
`artifacts/opencode-2.1.4-adapters.log` and
`artifacts/opencode-adapters/run-lva5LK/`.

| Published server | Passed | Skipped | Issues found | All cases complete |
| --- | ---: | ---: | --- | --- |
| v1.16.0 | 30 | 19 | None in tested cases | Yes, applicable automated cases |
| v1.19.4 | 31 | 18 | None in tested cases | Yes, applicable automated cases |
| v2.0.5 | 42 | 7 | None in tested cases | Yes, applicable automated cases |
| v2.1.4 | 46 | 3 | None in tested cases | Yes, applicable automated cases |

All 1,059 focused tests and five compatibility-summary tests passed.
`npm run lint`, `npm run fmt`, `npm run lint:check`, `npm run typecheck`,
`npm run typecheck:suggestions`, and `npm run build` passed. Logs use the
`artifacts/opencode-2.1.4-` prefix. The v1 dependency is unchanged, so the Docker
v1 support-range matrix was not rerun. Real-editor, visual streaming, live-model
action parity, and native Windows checks were not run for this bump.

The full `npm run test` run passed 10,603 tests, skipped 51, and failed one:
`src/extension/macos-tray.test.ts` could not discover a Unix socket created after
the publisher started. It expected one snapshot but received none. The failure
reproduced in isolated file and single-case runs on Node `24.22.1`; all 24 tray
tests passed with the same dependency tree on Node `24.22.0`. Evidence is
`artifacts/opencode-2.1.4-unit-tests.log`,
`artifacts/opencode-2.1.4-macos-tray-recheck.log`,
`artifacts/opencode-2.1.4-macos-tray-node-baseline.log`, and
`artifacts/opencode-2.1.4-macos-tray-volta-target.log`. This is a Node-version-linked
macOS discovery issue, not an OpenCode adapter failure. Next, compare a minimal
`fs.watch` reproduction on both Node versions and check whether the event is lost
or the publisher ignores it. Tray implementation changes are outside this bump.
The Node `24.22.1` pin was reverted to `24.22.0` because of this failure; the
OpenCode version update is retained.

### 2.1.3 and 1.19.4 compatibility review

Reviewed v2.1.2 to v2.1.3, `4b50f5cc` through `e965774f`, and v1.19.3 to
v1.19.4, `e3c4eb24` through `148842ef`. Consumed HTTP routes, SSE names and
envelopes, session/message/inbox shapes, permissions/forms, and managed
`serve`/upgrade arguments remain compatible. No adapter changes are required.
Support floors remain v2 `2.0.5` and v1 `1.16.0`.

V2 adds experimental voice-model discovery and hosted voice instruction updates,
which Varro does not consume. The OpenAPI document also adds the existing optional
`retryAfterMs` error field. Server-owned fixes cover provider `baseURL` precedence,
compaction output limits, title generation, legacy `apply_patch` permission
migration, unsupported agent colors, relative-directory migration, MCP resource
handling, and instruction deltas. The Windows shared-service default port changes
to `28894`; Varro discovers registered endpoints and passes its managed port
explicitly, so it does not depend on the old default. App/TUI highlighting,
scrolling, and styling changes remain optional parity work.

Both releases bundle Bun `1.4.4`. V1 otherwise changes packaging, native file-search
dependencies, and test setup without changing its HTTP API or generated SDK.
Complete upstream diffs are retained in `artifacts/opencode-2.1.3-upstream.diff`
and `artifacts/opencode-1.19.4-upstream.diff`.

The Docker support-range run passed all 519 required checks across 14 published
v1 releases, including 43/43 on `1.19.4` and 37/37 on the `1.16.0` floor. Advisory
checks passed 76/78; `1.16.0` and the below-floor `1.15.13` still fail the MCP
tool-discovery pagination advisory. No required-check boundary was found, so this
does not justify changing the support floor. The runner regenerated
`scripts/opencode-compatibility/verified.json`; all five shared summary tests
passed afterward. Evidence is `artifacts/opencode-1.19.4-compatibility.log`.

The published-server adapter matrix completed with 147 passed, two failed, and 47
family/platform skips. No processes leaked. V2.1.3 installed and ran as a native
macOS ARM64 binary.

| Published server | Passed | Skipped | Issues found | All cases complete |
| --- | ---: | ---: | --- | --- |
| v1.16.0 | 30 | 19 | None in tested cases | Yes, applicable automated cases |
| v1.19.4 | 31 | 18 | None in tested cases | Yes, applicable automated cases |
| v2.0.5 | 42 | 7 | None in tested cases | Yes, applicable automated cases |
| v2.1.3 | 44 | 3 | Two managed-restart failures; both passed one isolated rerun | Yes, applicable automated cases |

The original matrix exited with code 1. In the `configured` and `desktop-service`
cases, the SSE connection phase failed after inherited attachment, and managed restart then
reported `Cannot verify executable identity for managed OpenCode PID`. Cleanup
subsequently reported an ownership-lease mismatch, masking the earlier error in
the test output. Both cases passed one isolated rerun with no leaked processes.
The original run did not identify the cause; the follow-up below fixes a
deterministically reproduced shutdown race with the same identity error.

Evidence is `artifacts/opencode-2.1.3-adapters.log`,
`artifacts/opencode-adapters/run-YB2lgK/`,
`artifacts/opencode-2.1.3-startup-recheck.log`, and the original isolated fixtures
`artifacts/ai-test-data/startup-qPZmax/` and `startup-mD88xg/`. The original failed
result remains in the retained log and per-version run directory; the generated
`artifacts/opencode-adapters/verified.json` describes the latest matrix.

All 303 focused adapter, transcript, inbox, transport, message, and API-capability
tests passed. The five shared compatibility-summary tests also passed after both
published-server runs completed. `npm run lint`, `npm run fmt`,
`npm run lint:check`, `npm run typecheck`, `npm run typecheck:suggestions`, and
`npm run build` passed. Logs use the `artifacts/opencode-2.1.3-` prefix. Real-editor,
visual streaming, live-model action parity, and provider sign-in checks were not
run for this bump.

#### Follow-up restart fix

Owned shutdown can observe a listener PID just before the signalled process
exits, then fail to read its executable or birth identity. The post-signal wait
now accepts a fresh process-existence check confirming exit instead of reporting
failed identity verification. Pre-signal checks remain unchanged. Missing identity
on a still-live process still rejects cleanup, retains the lease, and never
authorizes escalation. Four regression cases cover both missing identities and
both exited/live outcomes. The exited cases fail before the fix and pass afterward;
evidence is `artifacts/opencode-2.1.3-stop-race-{baseline,fixed}.log`.

Startup-fixture cleanup now preserves the original scenario error alongside
cleanup failures rather than replacing it. Two unit cases cover preserving both
errors, completing later cleanup, and leaving a successfully cleaned-up scenario's
original failure intact.

All 799 focused lifecycle, transport, ownership, process-inspection, and cleanup
tests passed. `npm run lint`, `npm run fmt`, `npm run lint:check`,
`npm run typecheck`, `npm run typecheck:suggestions`, and `npm run build` passed.
Follow-up logs use the `artifacts/opencode-2.1.3-fix-` prefix.

Both formerly failing native v2.1.3 startup cases passed three consecutive
isolated repetitions, six checks total, with no recovered or leaked processes.
Evidence is `artifacts/opencode-2.1.3-fix-startup-repeats.json` and the corresponding
`startup-repeat-{1,2,3}.log` files.

The first follow-up matrix passed the v2.1.3 cases but exposed a separate
credential-only reconnection race on v2.0.5. Background ownership preparation
published a new registration object with unchanged credentials while SSE
verification was pending, which incorrectly rejected the connection as changed.
The failing attachment's actual error is retained in
`artifacts/ai-test-data/startup-1T40X3/failure.json`; its run is
`artifacts/opencode-2.1.3-fix-adapters.log`.

Credential publication now preserves registration identity when the endpoint,
record path, source, discovery mode, saved port, password, and effective username
are unchanged. It still revalidates enforced authentication. Changed evidence and
reset still invalidate pending checks, and attachment never gains lifecycle rights.
Two deterministic interleaving tests fail before this fix and pass afterward for
lease and credential-companion recovery; four safety cases reject concurrent
password, username, endpoint, and reset changes. Evidence is
`artifacts/opencode-2.1.3-credential-race-{baseline,fixed}.log`.

The final published-server matrix passed all 149 applicable checks, with 47
family/platform skips and no leaked or recovered processes. All five shared
summary tests passed after it completed. The formerly failing native v2.0.5
credential-only case also passed three consecutive isolated repetitions.

| Published server | Passed | Skipped | Issues found | All cases complete |
| --- | ---: | ---: | --- | --- |
| v1.16.0 | 30 | 19 | None in final tested cases | Yes, applicable automated cases |
| v1.19.4 | 31 | 18 | None in final tested cases | Yes, applicable automated cases |
| v2.0.5 | 42 | 7 | Credential-only race fixed | Yes, applicable automated cases |
| v2.1.3 | 46 | 3 | Post-signal shutdown race fixed | Yes, applicable automated cases |

Final evidence is `artifacts/opencode-2.1.3-fix-final-adapters.log`,
`artifacts/opencode-adapters/run-yKOWGj/`,
`artifacts/opencode-2.1.3-fix-credential-repeats.json`, and
`artifacts/opencode-2.1.3-fix-summary-tests.log`. No further product fixes are
indicated by these automated cases. Real-editor, visual streaming, live-model
action parity, and native Windows verification were not run for this follow-up.

The MCP pagination advisories require an upstream upgrade, not a Varro adapter
change. The published `1.16.0` implementation maps a single `listTools` response
directly to its tools and ignores `nextCursor`; the retained source is
`artifacts/opencode-1.16.0-mcp-source.ts`. Current tested versions pass that check.
The usage guide now explains the limitation and upgrade remedy. Historical
advisory results and support floors remain unchanged.

### 2.1.2 compatibility review

Reviewed v2.1.1 to v2.1.2, `133b1ebf` through `4b50f5cc`. Consumed local
HTTP routes, SSE names and envelopes, session/message/inbox shapes,
permissions/forms, and managed `serve`/upgrade arguments remain compatible.
Structured errors add optional `retryAfterMs` and the `provider.free-limit`
type. Varro's existing error projection preserves the message and HTTP status;
the new "Free usage limit reached" message matches its existing usage-limit
notice. The projection does not retain `retryAfterMs`, so a server-supplied reset
countdown and prompt recall remain optional UI parity work.

The follow-up review reproduced a model-picker bug against the published 2.1.2
server: configuration fallback restored free OpenCode/Go models omitted by the
native catalog with `OPENCODE_DISABLE_FREE_MODELS=true`. The adapter now treats
that catalog's exclusions as authoritative for `opencode` and `opencode-go` on
2.1.2 and later, using the version from validated transport health. It still
merges overrides into returned models and retains configuration fallback for
older servers and custom providers. The version is cleared on adapter reset.
Unit coverage checks both catalog routes, older/current versions, custom models,
returned-model overrides, and reset. The isolated released-server regression
failed before the fix and passed afterward; logs are
`artifacts/opencode-2.1.2-free-models-baseline.log` and
`artifacts/opencode-2.1.2-free-models-fixed.log`.

The release removes the legacy Console inference proxy. OpenCode Go quota polling
now calls `https://opencode.ai/inference/go/v1/usage`, the destination used by the
removed proxy. Its existing request/response regression checks the new URL, bearer
authentication, usage percentages, and reset times. Unauthenticated probes of both
URLs returned JSON 401 responses during review; authenticated live quota polling
was not verified.

Server-owned changes keep locations loaded during active sessions and background
jobs, add `experimental.location_idle_timeout`,
generate titles with lower reasoning variants, restore legacy Console credentials,
and fix Code Mode job ordering. Provider decoding, realtime requests, app/TUI
free-limit dialogs, Electron, Console, and release tooling need no further adaptation.

The tested v2 client is `2.1.2`; v1 remains `1.19.3`. Support floors remain
v2 `2.0.5` and v1 `1.16.0`. The unchanged v1 SDK does not require a new Docker
support-range run. The optional editor sandbox reads its expected version from
the selected binary.

All 305 focused Go quota, provider-limit, transport, v2 adapter, transcript, and
inbox tests passed. `npm run lint`, `npm run fmt`, `npm run lint:check`,
`npm run typecheck`, `npm run typecheck:suggestions`, and `npm run build` passed.
The first combined lint/format command reported an output-parser error; running
lint with retained output and formatting separately succeeded. Evidence is
`artifacts/opencode-2.1.2-focused-tests.log`,
`artifacts/opencode-2.1.2-lint.log`, `artifacts/opencode-2.1.2-lint-check.log`,
and `artifacts/opencode-2.1.2-build.log`.

The initial published-server adapter matrix passed all 148 applicable checks, with 44
family/platform skips and no leaked processes. V2.1.2 installed and ran as a
native macOS ARM64 binary. All five shared compatibility-summary tests passed
after the matrix completed.

Follow-up alignment validation passed 322 focused tests, the 924-test startup
checklist, and all 15 startup/MCP/reload/busy Playwright cases. `npm run lint`,
`npm run fmt`, `npm run lint:check`, `npm run typecheck`,
`npm run typecheck:suggestions`, and `npm run build` passed. Retained logs use the
`artifacts/opencode-2.1.2-alignment-` prefix. The startup and focused runs overlap
in transport coverage; their counts are not a count of unique tests.

| Published server | Passed | Skipped | Issues found | All cases complete |
| --- | ---: | ---: | --- | --- |
| v1.16.0 | 29 | 19 | One ownership-unavailable SSE startup failure; isolated rerun passed | Yes, applicable automated cases |
| v1.19.3 | 30 | 18 | One ownership-unavailable SSE startup failure; isolated rerun passed | Yes, applicable automated cases |
| v2.0.5 | 42 | 7 | None in tested cases | Yes, applicable automated cases |
| v2.1.2 | 46 | 3 | None in tested cases | Yes, applicable automated cases |

The table records the follow-up matrix, which exited with code 1: 147 passed,
two failed, and 47 skipped, with no leaked processes. Both V2 runs passed,
including the new free-model regression on 2.1.2. Both V1 failures occurred
during repeated ownership-unavailable reconnection after successful HTTP health
and session reads; each passed one isolated rerun. Their cause remains unresolved.
Recommended follow-up is to retain the attached window's status/error and SSE
admission diagnostics at the failing assertion, then reproduce repeated V1
credential-only reconnection. Current failure snapshots retain the stopped owner
status rather than the attached window's error.

Evidence is `artifacts/opencode-2.1.2-alignment-adapters.log`,
`artifacts/opencode-adapters/verified.json`, and
`artifacts/opencode-2.1.2-alignment-v1-{floor,current}-recheck.log`. Original failure
evidence is under `artifacts/ai-test-data/startup-PY9R01` and `startup-NGYDyp`.
All five shared compatibility-summary tests passed after the follow-up matrix.
The initial successful matrix remains in `artifacts/opencode-2.1.2-adapters.log`.
Real-editor, visual streaming, and live provider sign-in checks were not run for
this bump.

### 2.1.1 compatibility review

#### Optional archive and saved-permission support

Varro checks the connected server's OpenAPI request schemas rather than raising
the support floor. Archive writes map the common `time.archived` timestamp or
`null` restore into native `PATCH /api/session/{sessionID}` with `archived: true`
or `false`. The server owns the confirmed timestamp. Native `session.archived`
and `session.unarchived` events trigger a guarded session-header refresh without
starting transcript activity. Older V2 servers keep the local annotation path;
V1 transport behavior is unchanged.

On capable servers, native archive state, including an absent timestamp after
restore, takes precedence over an old local archive annotation. Legacy files
remain intact for older servers. Merely reading history never migrates archives
or patches production sessions; explicitly archiving a session publishes its
state to the server. The session list's age-based **Archive** section and the
Recycle Bin keep their existing meanings. The legacy include-archived list query
is not forwarded as native `archived=true`, which means archived-only and would
otherwise omit active sessions from usage reports.

The Permissions screen offers saved-allowance editing only when the server
advertises `PATCH /api/permission/saved/{id}` with action/resource fields.
Edits remain project-checked, apply only to user-managed saved allowances, and
leave session/project rules untouched. Native IDs keep edited scopes visible
across refreshes and edits from other clients. Unsupported servers retain their
existing list/remove behavior, and legacy restart-only allowances cannot be edited.
Conflicts and failed edits preserve the UI draft. No saved-permission event is
assumed; the screen refreshes on opening and after successful mutations.

Focused coverage lives in `opencode-api-capabilities.test.ts`,
`opencode-v2-archive.test.ts`, the REST proxy and permission-panel tests, and the
released-server archive/edit cases in `opencode-v2.integration.test.ts`.

Follow-up verification passed 1,060 focused tests, 13 permission E2E checks, and
all 148 applicable released-server adapter/startup checks across V1.16.0,
V1.19.3, V2.0.5, and V2.1.1, with 44 family/platform skips. V2.1.1 ran as a
native macOS ARM64 binary. The new archive fallback passed on V2.0.5, and native
archive/restore events and saved-permission editing passed on V2.1.1. Evidence is
`artifacts/archive-permissions-adapters-rerun.log` and
`artifacts/opencode-adapters/verified.json`. The first attempt hit its outer
two-minute command timeout; its two detached fixture servers were removed through
installation-scoped process cleanup before the longer rerun. Build, lint,
formatting, typecheck, suggestion checks, and compatibility-summary tests passed.

#### Release review

Reviewed v2.0.32 to v2.1.1, `843a6c51` through `133b1ebf`, including the
intentional 2.1 HTTP, event, and generated-client contract changes. Tool lifecycle
events now project `native` replay data into Varro's existing call/result fields,
with the pre-2.1 `state` and `resultState` fallback retained. Regression tests
cover called, successful, and failed tools on both shapes.

Text/reasoning and assistant replay fields also become `native`, but Varro does
not consume those opaque fields. Compaction no longer requires `recent`; the
server owns kept-message references and native replacement windows. Updated typed
fixtures retain the existing compaction divider and status checks. The removed
transitional `session.compacted` event was not consumed by the v2 adapter.

Key credentials drop `configuration` in favor of `metadata`. Varro already sends
typed answers through the unchanged integration connection endpoints, rather than
writing key credentials directly. Session archive filtering, saved-permission
editing, Gemini Live voice, and experimental todos add optional functionality;
this bump does not add those controls. Consumed request paths, SSE envelopes,
inbox operations, permission/form replies, and managed `serve` flags remain
compatible.

Server-owned changes improve compaction context and cache reuse, shell completion
ordering, retry handling, provider stream decoding, skill discovery, filesystem
access failures, and provider reasoning variants. Catalog refreshes and SDK plugin
updates are broadcast globally. Windows persistent terminals and app, desktop,
TUI, Console, documentation, and build-tooling changes need no further adaptation.

The tested v2 client is `2.1.1`; v1 remains `1.19.3`. Support floors remain
v2 `2.0.5` and v1 `1.16.0`. The unchanged v1 SDK does not require a new Docker
support-range run. Historical version observations remain unchanged, and the
optional editor sandbox reads its expected version from the selected binary.

All 10,378 unit tests and 270 script tests passed, with 48 and three skips
respectively. The final focused rerun passed all 346 adapter, transcript, inbox,
streaming-tool, and message-rendering tests. `npm run lint`, `npm run fmt`,
`npm run fmt:check`, `npm run lint:check`, `npm run typecheck`,
`npm run typecheck:suggestions`, and `npm run build` passed. All five shared
compatibility-summary tests passed after the final published-server reruns.

The adapter runner now writes an isolated manifest allowing only the exact CLI
version's install script. npm 12 otherwise leaves the CLI's non-executable
placeholder installed, producing `spawn ENOEXEC` before any contract check.
No global npm trust settings change.

The native matrix could not install `@opencode/cli-darwin-arm64@2.1.1`, which
was absent from npm on October 20, 2026 despite the CLI and client release being
published. A separate exact-version macOS x64 binary ran under Rosetta and
passed all 43 applicable checks, with three family/platform skips. The isolated
VS Code `v2-first-run` scenario also passed against that binary. This verifies
released-server behavior, not native ARM64 installation or execution. Retry the
native matrix once upstream publishes the missing package. The installation
failure stops the runner before it writes a new `verified.json`; use this run's
logs rather than the earlier report.

Across the completed per-version runs, all 145 applicable checks passed, with
39 family/platform skips:

| Published server | Passed | Skipped | Issues found | All cases complete |
| --- | ---: | ---: | --- | --- |
| v1.16.0 | 30 | 16 | None in tested cases | Yes, applicable automated cases |
| v1.19.3 | 31 | 15 | None in tested cases | Yes, applicable automated cases |
| v2.0.5 | 41 | 5 | Initial recovery assertion failed; focused and full reruns passed | Yes, applicable automated cases on rerun |
| v2.1.1, macOS x64 under Rosetta | 43 | 3 | None in tested cases | Yes, applicable automated cases |
| v2.1.1, native macOS ARM64 | Not run | Not run | Missing published platform package | No |

The initial v2.0.5 `credential-port-replacement` check expected an attach-only
restart rejection but received a successful connection URL. The single-case
rerun and the complete 41-check floor rerun passed without a product change.
If it recurs, record the attached server's status and pending preparation at the
restart boundary to distinguish reconnection from lifecycle ownership. Initial
evidence is `artifacts/ai-test-data/startup-ThkEWE/`; rerun logs are
`artifacts/opencode-2.1.1-floor-recovery-rerun.log` and
`artifacts/opencode-2.1.1-floor-adapters-rerun.log`.

Evidence is `artifacts/opencode-2.1.1-all-tests.log`,
`artifacts/opencode-2.1.1-script-tests.log`,
`artifacts/opencode-2.1.1-adapters-final.log`,
`artifacts/opencode-2.1.1-x64-adapters.log`, and
`artifacts/opencode-2.1.1-editor-startup.log`. Full visual streaming and live
provider sign-in checks were not run for this bump.

### 2.0.32 and 1.19.3 compatibility review

Reviewed the release diffs from v2.0.30 to v2.0.32, `f16ef9ad` through
`843a6c51`, and v1.19.2 to v1.19.3, `7901b7d3` through `e3c4eb24`.
Consumed HTTP routes, SSE names and envelopes, session/message/inbox shapes,
permissions/forms, and managed `serve`/upgrade arguments remain compatible.
No adapter changes are required for these releases.

V2 adds an experimental voice-session endpoint and optional model temperature,
reasoning-control, and release-date configuration fields. V1 adds configured
`reasoning_options`. Both families build reasoning variants on the server;
Varro already preserves the returned variants and model capabilities.
The new voice API is not used by Varro's existing dictation integration.

V2 also fixes provider-package reasoning mappings, configured model limits,
Bedrock routing/cache behavior, Gemini incomplete-response retries, unreadable
file substitutions, environment-value escaping, numeric MCP timeouts, cold
web-search provider activation, sanitized compaction exports, and concurrent
Windows snapshot writes. Managed services restore saved environment variables.
These are server-owned behaviors and need no local adaptation. App, desktop,
TUI, theme, Console, CI, and release-distribution changes are optional parity
or upstream tooling work.

Dependencies, lockfile, README, usage, and Docker examples now use v2 `2.0.32`
and v1 `1.19.3`. Support floors remain v2 `2.0.5` and v1 `1.16.0`.
Historical release observations and lower-bound fixtures remain unchanged.
The optional VS Code sandbox reads its expected version from the selected binary.

The Docker support-range run passed all 519 required checks across 14 v1 releases,
including 43/43 on `1.19.3` and 37/37 on the `1.16.0` floor. Advisory checks passed
76/78. The floor and below-floor `1.15.13` comparison retain the known MCP pagination
caveat: discovery returned only the first page. The support floor is unchanged.
The regenerated summary is `scripts/opencode-compatibility/verified.json`; full
evidence is `artifacts/opencode-compatibility.json` and
`artifacts/opencode-1.19.3-compatibility.log`.

Verification resumed after the separate native-form implementation finished.
The published-server fixture now sends keyed, typed native answers using the
original option value. It also verifies that a rejected legacy positional reply
leaves the form pending before a valid reply is acknowledged. No product-code
change was needed for the version bump.

All 10,093 unit tests and 252 script tests passed, with 48 and two skips respectively.
All five native-validator fixtures passed separately. `npm run lint`, `npm run fmt`,
`npm run fmt:check`, `npm run lint:check`, `npm run typecheck`,
`npm run typecheck:suggestions`, and `npm run build` passed on the completed
workspace. The five shared compatibility-summary tests passed after the Docker
run finished. Evidence is `artifacts/opencode-versions-completed-tests.log` and
`artifacts/opencode-versions-completed-build.log`. Real-editor and visual streaming
checks were not run for this bump.

The final published-server adapter matrix passed all 145 applicable checks,
with 39 family/platform skips and no leaked processes:

| Published server | Passed | Skipped |
| --- | ---: | ---: |
| v1.16.0 | 30 | 16 |
| v1.19.3 | 31 | 15 |
| v2.0.5 | 41 | 5 |
| v2.0.32 | 43 | 3 |

Evidence is `artifacts/opencode-adapters/verified.json` and
`artifacts/opencode-2.0.32-adapters-final.log`. The initial current-workspace run
overlapped the native-form work and failed its obsolete positional-answer fixture.
The isolated committed-source baseline and the final completed-workspace rerun
both passed; the fixture update above preserves the new mixed-version safety check.

### 2.0.30 and 1.19.2 compatibility review

Reviewed the complete release diffs from v2.0.29 to v2.0.30, `042d0832` through
`f16ef9ad`, and v1.19.0 to v1.19.2, `733b2c62` through `7901b7d3`.
Consumed HTTP routes, SSE names and envelopes, session/message/inbox shapes,
permissions/forms, and managed `serve` arguments remain compatible. The v2 client
removes the unused `session.share` TUI command. The v1 SDK declarations are unchanged.

OpenCode retired its sharing backend. V1 retains the share endpoints, but creation
fails and unshare only clears the local link. The source error is "Session sharing
has been discontinued"; the published HTTP handler returns a generic 500 instead.
Varro removes new-share actions for both families while retaining **Unshare
session** for existing v1 links. Header and session-list regressions cover cleanup,
feedback, unchanged activity timestamps, and the absence of new-share actions. The
published-server matrix checks v1's rejected creation and successful local cleanup.

V2 now loads configured local and remote instructions, honors Claude skill-discovery
disable flags, treats missing file substitutions as empty, and ignores empty provider
and model names. MCP requests include tool input in permission metadata; the existing
adapter preserves it. MCP capability negotiation, OAuth loopback handling, TinyFish
initialization, compaction output budgeting, Responses null namespaces, model-catalog
refreshes, and the built-in inference endpoint changes are server-owned behavior.
Windows managed-service default ports change, but Varro reads service configuration
and starts managed servers on explicit ports. V1 update discovery stays on npm's 1.x
package family; Varro already selects updates by family. App, desktop, TUI, Console,
schema publishing, and installer changes require no further Varro adaptation.

Dependencies, lockfile, README, usage, and Docker examples now use v2 `2.0.30` and
v1 `1.19.2`. Support floors remain v2 `2.0.5` and v1 `1.16.0`. Historical release
observations and lower-bound fixtures remain unchanged.

The Docker support-range run passed all 524 required checks across 14 v1 releases,
including 43/43 on `1.19.2` and 37/37 on the `1.16.0` floor. Advisory checks passed
76/78. The floor and the below-floor `1.15.13` comparison each retain the known MCP
pagination caveat: discovery returned only the first page. This does not change the
support floor. The generated summary is `scripts/opencode-compatibility/verified.json`;
full evidence is `artifacts/opencode-compatibility.json` and
`artifacts/opencode-1.19.2-compatibility.log`.

All 495 focused unit tests and five shared compatibility-summary tests passed.
The broader Vitest run also passed all 10,051 tests, with 48 skips. The enclosing
`npm run test` command reached its 120-second controller deadline during the later
Node script-test phase; `npm run test:scripts` then passed all 252 applicable script
tests, with two skips.
`npm run lint`, `npm run fmt`, `npm run fmt:check`, `npm run lint:check`,
`npm run typecheck`, `npm run typecheck:suggestions`, and `npm run build` passed.
Real-editor and visual streaming checks were not run for this bump.

The isolated published-server adapter matrix passed all 145 applicable checks,
with 39 family/platform skips and no leaked processes. The first run's only failure
was the new sharing regression expecting the source error text rather than the
published handler's generic HTTP 500. The corrected test also verifies no link was
stored and local cleanup succeeds. Its focused published-server rerun and the full
matrix rerun passed. No further product fix was needed.

| Published server | Passed | Skipped |
| --- | ---: | ---: |
| v1.16.0 | 30 | 16 |
| v1.19.2 | 31 | 15 |
| v2.0.5 | 41 | 5 |
| v2.0.30 | 43 | 3 |

Evidence is `artifacts/opencode-adapters/verified.json`,
`artifacts/opencode-2.0.30-adapters-rerun.log`, and
`artifacts/opencode-1.19.2-sharing-rerun.log`. The initial assertion failure is
retained in `artifacts/opencode-2.0.30-adapters.log`. Broader unit and script results
are in `artifacts/opencode-versions-all-tests.log` and
`artifacts/opencode-versions-script-tests.log`.

### 2.0.29 compatibility review

Reviewed v2.0.28 to v2.0.29, `c5aabae288` through `34d8ded0c5`.
Consumed HTTP routes, SSE names and envelopes, session/message/inbox shapes,
permissions/forms, and managed `serve` arguments remain compatible. The generated
client adds top-level `policies`; OpenAPI also catches up with the optional provider
request-encoding fields introduced in the previous release.

V2 now normalizes `experimental.policies` and migrated v1 provider lists into
top-level `policies`. Varro reads both keys, with native entries after legacy entries,
so a denied configured provider is not restored by the older-server catalog fallback.
This also removes its empty integration placeholder, which the initial published-server
regression caught even after configured model restoration had been blocked.
Provider disabling updates the native list when present and otherwise retains the
legacy key for compatibility with the v2 floor. Regression tests cover both formats,
mixed-format precedence, comment preservation, and concurrent-write rejection. The
published-server matrix includes a native-policy catalog regression on 2.0.29.

Managed settings now override user/project settings, with managed policies retaining
their higher authority. Automatic output-limit continuation and bounded incomplete
tool-input diagnostics are server-owned behavior and use existing message/tool events.
Plugin permission assertions and per-call Promise hook failures retain the native
permission and tool contracts. Migrated v1 npm configuration accepts built-in provider
routes. Desktop account management, remote pairing, question UI, media previews,
client-side usage helpers, TUI changes, Figma fixes, Console, and updater-service
changes require no additional Varro adaptation for this bump.

The tested v2 client is `2.0.29`; v1 remains `1.19.0`. Support floors remain v2 `2.0.5`
and v1 `1.16.0`. The unchanged v1 SDK does not require a new Docker support-range run.
README, usage, and Docker example references now use 2.0.29; historical release
observations remain unchanged.

All 973 focused adapter, configuration, transcript, inbox, generation, process,
transport, state, background-work, and server unit tests passed. `npm run lint`,
`npm run fmt`, `npm run lint:check`, `npm run typecheck`,
`npm run typecheck:suggestions`, and `npm run build` passed. Real-editor and visual
streaming checks were not run for this bump.

The isolated published-server matrix passed all 138 applicable checks, with 30
family/platform skips and no leaked adapter processes. All five shared compatibility
tests passed after the matrix finished. Evidence is
`artifacts/opencode-adapters/verified.json` and
`artifacts/opencode-2.0.29-adapters-rerun.log`. The initial failure is retained in
`artifacts/opencode-2.0.29-adapters.log`; the focused published-policy rerun also
passed in `artifacts/opencode-2.0.29-policy-rerun.log`.

| Published server | Passed | Skipped |
| --- | ---: | ---: |
| v1.16.0 | 30 | 12 |
| v1.19.0 | 30 | 12 |
| v2.0.5 | 38 | 4 |
| v2.0.29 | 40 | 2 |

The broader `npm run test` run passed 9,906 tests, skipped 44, and reported two
failures outside the focused OpenCode checks. The window-theme refresh expectation
at `src/extension/sidebar-provider.editor.test.ts:402` also fails in isolation.
It invokes only the last registered configuration listener, now the editor's remote-image
listener rather than the sidebar theme listener. Dispatching the configuration event to
all fixture listeners would test the intended VS Code behavior.
The development-compatibility test detects the existing Playwright 1.64.1 manifest
change against the CI image still pinned to 1.64.0; align the image with that separate
dependency update. Those files were left unchanged.
Evidence is `artifacts/opencode-2.0.29-unit-tests.log`.

### 2.0.28 compatibility review

Reviewed v2.0.27 to v2.0.28, `03cb9b9946` through `c5aabae288`.
Consumed HTTP routes, SSE names and envelopes, session/message/inbox shapes,
permissions/forms, and managed `serve` arguments are unchanged. Client and OpenAPI
add optional provider compatibility, cache-format, and request-encoding fields.
Varro preserves provider/model settings and does not need new compatibility types.

Provider changes add Gemini response continuation, fifteen-minute chunk timeouts,
ChatGPT request compression, provider-level cache compatibility, and fixes for
Azure startup and v1-format model options. OpenCode's built-in provider now uses
the inference endpoint. System configuration and macOS managed preferences load
below user/project defaults, with system policies retaining higher authority.
These are server-owned behaviors; Varro's project/user config edits remain compatible.

Promise plugin tool failures retain permission declines and question cancellation;
the edit tool preserves mixed line endings. Credential activation for plugins,
Windows ARM64 installation, WinGet upgrades, release highlights, Figma skills,
app unread state and per-project auto-accept, desktop/TUI rendering, and Console
changes require no Varro adaptation for this bump.

The tested v2 client is `2.0.28`; v1 remains `1.19.0`. Support floors remain v2 `2.0.5`
and v1 `1.16.0`. The unchanged v1 SDK does not require a new Docker support-range run.

All 937 focused adapter, transcript, inbox, generation, process, transport, state,
background-work, authentication, and server unit tests passed. Formatting, both
TypeScript checks, and build passed. `npm run lint` and `npm run lint:check` pass
with an unrelated `consistent-type-imports` warning at
`src/webview/components/ChatInput.test.ts:159`. That file was left unchanged.
Real-editor and visual streaming checks were not run for this dependency-only bump.

The isolated published-server matrix passed all 137 applicable checks, with 27
family/platform skips and no leaked adapter processes. All five shared compatibility
tests passed after the matrix finished. Evidence is
`artifacts/opencode-adapters/verified.json` and `artifacts/opencode-2.0.28-adapters.log`.

| Published server | Passed | Skipped |
| --- | ---: | ---: |
| v1.16.0 | 30 | 11 |
| v1.19.0 | 30 | 11 |
| v2.0.5 | 38 | 3 |
| v2.0.28 | 39 | 2 |

### 2.0.27 compatibility review

Reviewed v2.0.26 to v2.0.27, `8059cdcbdf` through `03cb9b9946`.
The release moves its client/protocol/schema packages to Effect 4.0.1. Schema identifiers
and generated references change, but consumed HTTP paths, SSE names and envelopes,
permissions/forms, prompt/inbox operations, and managed `serve` flags remain compatible.
Checked-in OpenAPI regeneration also includes the external-auth route already present
in 2.0.26; it is not a new runtime dependency.

Failed idle messages now persist the native execution error. Varro uses that error
before its live fallback, retaining the diagnostic and authorization status after reload.
Regression tests cover failures before the first assistant and between successful steps,
history and direct-message reads, and precedence over stale live context.

Project archival adds optional `time.archived` and an `archived=true` project-list query.
Varro does not consume the project inventory. Built-in Code Mode worktree tools retain
the generic tool and permission contracts. Provider changes fix Copilot routing and
interleaved reasoning, Vertex credentials and model routes, environment-key discovery,
and ChatGPT context limits. Subagent notifications now survive location eviction;
remote filesystem overrides and well-known configuration propagation are corrected.
Updater detection and timeouts change without changing Varro's family-specific upgrade
arguments. Remote pairing consent, embedded SDK plugin seeding, desktop/TUI rendering,
web installation, Console, documentation, and release-branch changes require no adaptation.

Model discovery and one-shot generation now wait for location plugins to activate.
The published-server test initially expected custom-model one-shot generation to return
the older unsupported-model fallback. It now verifies successful generation with exactly
one provider call and no helper session on 2.0.27, retaining the fallback assertions for
older releases. Varro's existing one-shot implementation needs no change.

The tested v2 client is `2.0.27`; v1 remains `1.19.0`. Support floors remain v2 `2.0.5`
and v1 `1.16.0`. The unchanged v1 SDK does not require a new Docker support-range run.

All 863 focused adapter, transcript, inbox, one-shot, process, transport, state, and
server unit tests passed. The isolated published-2.0.27 custom-model generation
regression passed, and all five shared compatibility tests passed after the initial
matrix finished. Formatting, both TypeScript checks, build, and the isolated VS Code
`v2-first-run` scenario passed. Lint passed before concurrent webview edits; subsequent
`npm run lint` and `npm run lint:check` report an unrelated `no-unknown-parameters`
diagnostic at `src/webview/App.tsx:38`. Scoped lint on the three changed extension files
passes. That webview work was left unchanged.

### 1.19.0 compatibility review

Reviewed v1.18.35 to v1.19.0, `63be8f95d8` through `dfb56f76c7`.
Public HTTP routes, generated SDK/OpenAPI shapes, session/message records,
permissions/questions, and managed `serve` output consumed by Varro remain compatible.
No adapter changes are required. PTY connection preflight now validates origin and
consumes tickets before looking up the process; Varro does not use that route.

V1's TUI replaces automatic installation with update notices and an explicit `/update`
dialog. The `autoupdate` shape is unchanged, but `true` and `"notify"` now both mean
notice-only. TUI update checks no longer emit global installation SSE events. Varro
checks the registry itself and retains its own `varro.server.autoUpdate` behavior.
The new `opencode upgrade --major` explicitly replaces v1 with v2; Varro never passes
that flag and continues upgrading within the installed family.

Provider fixes accept interleaved Copilot opaque reasoning values, concatenate their
reasoning text for replay, and forward OpenAI's `ultrafast` service tier. These retain
Varro's consumed message/part contracts. Console inference routing, model/pricing
catalogs, localization, TUI styling, and the upstream v1 release-branch split require
no local adaptation.

The tested v1 SDK is `1.19.0`; the v2 client is already current at `2.0.26`.
Support floors remain v1 `1.16.0` and v2 `2.0.5`.

The Docker support-range run passed all 524 required checks across 14 releases,
including 43/43 on 1.19.0 and 37/37 on the 1.16.0 floor. Advisory checks passed
76/78; the floor and below-floor 1.15.13 each retain the MCP pagination caveat.
No required-check boundary was found; the declared support floor is unchanged.
The run regenerated `scripts/opencode-compatibility/verified.json`.

All 542 focused process, transport, adapter, and shared compatibility unit tests
passed. `npm run lint`, `npm run fmt`, `npm run lint:check`, `npm run typecheck`,
`npm run typecheck:suggestions`, and `npm run build` passed.

The released-server adapter matrix did not pass overall. The new v1 release passed
all 28 applicable checks. Known recovery failures remain on the support floors and
the unchanged v2 release. The initial v2.0.26 run exceeded the matrix runner's
180-second deadline; a separate startup rerun completed in 200 seconds.

| Scope | Tested behavior | Issues found | All cases complete |
| --- | --- | --- | --- |
| v1.19.0 | 28 passed, 11 platform/family skips | None found | Yes, all applicable automated checks |
| v1.16.0 | 27 passed, 1 failed, 11 skips | Follower authentication after owner replacement | No, later recovery phases were not reached |
| v2.0.5 | 33 passed, 3 failed, 3 skips | Replacement ownership, reboot recovery, multi-window ownership | No, later recovery phases were not reached |
| v2.0.26 | Initial contract: 26 passed, 1 failed, 2 skips; separate startup rerun: 9 passed, 1 failed | Multi-window ownership; initial steering assertion failed but passed alone | No, later multi-window recovery phases were not reached |

Recommended follow-up diagnostics:

- High priority: v1.16.0 restarts the owner, but the follower reports authentication
  failure instead of reattaching. Inspect credential refresh and lease-generation
  ordering, then rerun killed-server and owner-restart recovery. Evidence is
  `artifacts/ai-test-data/multi-window-nBt0WB/failure.json`.
- Medium priority: v2.0.5 replacement recovery reports `unmanaged` instead of
  `current-host`; both v2 releases report `unmanaged` instead of `other-host` after
  multi-window recovery despite healthy event streams. Inspect authenticated
  endpoint fallback and credential-backed registration identity. Evidence is in
  `artifacts/ai-test-data/startup-I2AHLp/failure.json`,
  `artifacts/ai-test-data/multi-window-4JoC9P/failure.json`, and
  `artifacts/ai-test-data/multi-window-xYNyev/failure.json`.
- High priority: v2.0.5 simulated reboot fails its healthy-start assertion. Capture
  startup probes, lease identity, and credential restoration before changing logic.
  Evidence is `artifacts/ai-test-data/startup-EswAcN/failure.json`.
- The initial v2.0.26 stalled-turn steering assertion failed, but its isolated rerun
  passed. The timed-out run did not retain the full assertion details. Capture native
  inbox admission and resume ordering on another reproduction before assigning a
  new cause. Evidence is `artifacts/opencode-1.19.0-v2-steering-rerun.log`.
- The matrix runner's 180-second per-version deadline is shorter than the completed
  v2 startup suite. Record timeout/error details in its report and use a suite-aware
  bound, or run contract and startup checks separately. Do not count the timeout as
  another product failure.

Complete matrix logs are under `artifacts/opencode-adapters/run-COhYuE/`; the startup
rerun is `artifacts/opencode-1.19.0-v2-startup-rerun.log`. No live provider sign-in or
real-editor visual/performance checks were run for this bump.

### Recovery and steering follow-up

The recovery failures above were reproduced and fixed after the version bump.
They were not all missed by tests: the opt-in published-server matrix caught them,
but ordinary unit runs skip those files without `VARRO_OPENCODE_TEST_BINARY`.

- Recovering registered windows now enter the existing launch claim before probing
  the endpoint. Previously, followers could probe between listener startup and
  replacement lease/credential publication. V1 rejected stale credentials; v2
  could fall back to credential-only attachment and lose lifecycle ownership.
  The earlier unit recovery fixtures replaced `startOperation` with an immediate
  success, so they tested retry scheduling without exercising this race. A new
  deferred-claim regression exercises real startup and forbids early probes.
- Replacement ownership recovery now falls back to `/api/status` when `/api/info`
  is unavailable on v2.0.5. Its earlier unit fixture always returned a modern info
  response. The reboot fixture also now selects the floor's actual health route;
  that assertion was a test-controller failure, not a reboot product failure.
- Resume steering uses the native steer-scoped `interrupt?resume=true` wake instead
  of re-admitting the pending prompt. Normal prompt wakes also drain queued input.
  The old unit test proved request shape, not queue semantics; the released-server
  check could pass during a short interval before the queue drained. It now waits
  for completion and samples after 0, 75, and 250 ms on each supported family.
- The adapter runner's outer deadline is now 900 seconds, enough for the serial
  startup and contract budgets. Reports retain exit code, signal, and spawn errors
  instead of leaving truncated output indistinguishable from an assertion failure.

The complete released-server rerun passed all 137 applicable checks:

| Scope | Tested behavior | Issues found | All cases complete |
| --- | --- | --- | --- |
| v1.16.0 | 30 passed, 11 family/platform skips | None after fixes | Yes, applicable automated cases |
| v1.19.0 | 30 passed, 11 family/platform skips | None after fixes | Yes, applicable automated cases |
| v2.0.5 | 38 passed, 3 family/platform skips | None after fixes | Yes, applicable automated cases |
| v2.0.26 | 39 passed, 2 family/platform skips | None after fixes | Yes, applicable automated cases |
| Live VS Code v1.19.0 and v2.0.26 | Targeted queue, steer, stop, follow-up, and reload checks | None in verified actions | No, full action/layout matrix not run |

All 804 focused unit checks and five rest-proxy steering checks passed. Lint,
formatting, lint check, both TypeScript checks, build, and diff checks passed.
Isolated VS Code sandbox checks passed
healthy startup, crash recovery, and released v2 startup. The live checks used
`openai/gpt-6.1-sol` through the OpenAI subscription in separate databases and the
clean `tmp/opencode` fixture. V1 required `OPENCODE_DISABLE_PROJECT_CONFIG=true`
on its test server to skip the fixture's unresolved custom-tool plugin imports.
Native UI and canonical history agree on the successful queue edit/removal and
steering sequences. This is not a full visual performance or action-matrix pass.

Evidence: `artifacts/opencode-adapters/run-M0Ymhj/` and
`artifacts/ai-fuzzy/2026-10-12-recovery-19190.md`. Keep the published-server matrix
as a version-bump gate; ordinary mocked unit runs cannot establish native wake
semantics or released CLI compatibility.

### 2.0.26 compatibility review

Reviewed v2.0.25 to v2.0.26, `62e087ff7b` through `8059cdcbdf`.
Public HTTP routes, generated client/protocol/schema declarations, consumed SSE payloads,
session/message records, permissions/forms, and managed `serve` output remain compatible.
No adapter changes are required.

Vertex adds a Google Cloud Application Default Credentials connection method with editable
project and location fields. Varro's existing external-auth flow already supports its typed
form and server-acknowledged completion. Explicit project/location settings now take precedence
over an ambient Vertex API key. Live Google Cloud sign-in is not verified by this bump.

Runtime changes overlap snapshot capture with provider requests while preserving step-start
ordering, recover corrupt indexes, isolate concurrent captures, pack snapshot objects without
pruning them, and batch large restores and untracked-file diffs. These retain the consumed
snapshot and diff contracts. Model catalog updates need no local adaptation. Shared-service
remote access now persists a random subdomain; Varro does not manage that setting. TUI links,
activity disclosure, release tooling, and Console documentation are optional parity work.

The tested v2 client is `2.0.26`; v1 remains current at `1.18.35`.
Support floors remain v2 `2.0.5` and v1 `1.16.0`. The unchanged v1 SDK does not require a new
Docker support-range run. The sandbox reads its expected v2 version from the selected binary.

All 925 focused adapter, inbox, transcript, provider-dialog, startup/server, state, and transport
unit tests passed, followed by all five shared compatibility tests after the matrix finished.
`npm run lint`, `npm run fmt`, `npm run lint:check`, `npm run typecheck`,
`npm run typecheck:suggestions`, and `npm run build` passed. The isolated VS Code
`v2-first-run` scenario passed against the published 2.0.26 CLI.

`npm run test:compatibility:adapters` passed 120 checks, failed seven, and skipped 25
platform- or family-specific checks. This is not an overall compatibility pass.

| Scope | Tested behavior | Issues found | All cases complete |
| --- | --- | --- | --- |
| v2.0.26 | 34 passed, 2 failed, 2 skipped | Multi-window ownership and stalled-turn steering | No, later recovery phases were not reached |
| v1.16.0 and v1.18.35 | 27 passed, 1 failed, 10 skipped each | Follower authentication after owner replacement | No, later recovery phases were not reached |
| v2.0.5 | 32 passed, 3 failed, 3 skipped | Replacement ownership, reboot recovery, multi-window ownership | No, later recovery phases were not reached |
| VS Code v2.0.26 startup | Activation, managed ownership, health, event-stream connection passed | None found | Yes, the startup scenario |

Focused comparisons against the previous 2.0.25 CLI reproduced both current-release failure
signatures. Logs are `artifacts/opencode-2.0.25-recovery-steering.log` and
`artifacts/opencode-2.0.26-recovery-steering.log`. The latter also exposed an overly narrow
abort-history assertion: cancelling before step creation can yield the already-supported
`MessageAbortedError` interrupted-idle projection instead of a native assistant's `aborted`
error. The assertion now accepts those two valid forms. The complete 2.0.26 adapter-contract
rerun then passed 26 checks, failed the unchanged queued-prompt assertion, and skipped two;
see `artifacts/opencode-2.0.26-contract-rerun.log`.

Recommended follow-up diagnostics for the evidenced issues:

- High priority: both v1 releases restart the owner but leave the follower in an authentication
  error instead of reattaching. Inspect follower credential refresh and lease-generation ordering,
  then rerun killed-server and owner-restart recovery. Evidence is in
  `artifacts/ai-test-data/multi-window-3oAei3/failure.json` and
  `artifacts/ai-test-data/multi-window-h7arGK/failure.json`.
- Medium priority: v2.0.26 and v2.0.5 reconnect with healthy event streams, but the follower reports
  `unmanaged` instead of `other-host`. V2.0.5 replacement recovery also reports `unmanaged` instead
  of `current-host`. Managed lifecycle identity is lost despite successful HTTP reconnection.
  Inspect authenticated endpoint fallback and credential-backed registration identity checks;
  verify owner/follower identity through replacement and restart. Evidence is in
  `artifacts/ai-test-data/multi-window-3YYYaT/failure.json`,
  `artifacts/ai-test-data/multi-window-ypLMqV/failure.json`, and
  `artifacts/ai-test-data/startup-pJpFON/failure.json`.
- High priority: v2.0.5 simulated reboot recovery fails its healthy-start assertion. Capture startup
  probes, lease identity, and credential restoration before changing recovery logic, then rerun
  the reboot scenario. Evidence is `artifacts/ai-test-data/startup-qrWfNR/failure.json`.
- High priority: v2.0.26 steering resume admits three user messages instead of two, consuming the
  prompt expected to remain queued. The previous 2.0.25 CLI reproduces this too. Trace native
  inbox admission and resume ordering, then verify the queued prompt remains pending after the
  steering reply. Evidence is in the comparison and contract-rerun logs above.

Complete matrix logs are under `artifacts/opencode-adapters/run-3LLgcz/`.
Live Google Cloud sign-in and full visual streaming performance remain unverified by this bump.

### 2.0.25 compatibility review

Reviewed v2.0.24 to v2.0.25, `bd55d4895f` through `62e087ff7b`.
The release adds external credential references and a `/api/integration/:integrationID/connect/external`
route. Azure CLI authentication moves from OAuth to this method; AWS named profiles use it too.
Varro now exposes external methods, submits their typed form answers, and finishes only after
the server acknowledges the connection. It does not open a browser or request an OAuth callback.
Custom string fields remain editable even when the server supplies suggested values, so newly
created AWS profiles and Azure resources can be entered.

Consumed SSE envelopes, session/message records, permission/form reply routes, and managed
`serve` output remain compatible. Experimental policy actions replace `permission` with
`tool.use` and add `integration.use`; Varro's provider-disable rules still use the unchanged
`provider.use` action. Server-native agent defaults no longer ask about external directories.
Varro continues to project the server's rules without overriding them.

Runtime fixes reject incomplete tool arguments without executing repaired input, preserve
interrupted reasoning safely on follow-up turns, update session timestamps at step boundaries,
refresh AWS SSO credentials, retain remote configuration during refresh failures, and improve
ChatGPT cache-affinity headers. File reads gain streaming and range support, and PTY connections
validate origin and location before upgrading. Client service-ensure decisions are refactored;
Varro only uses service discovery and retains its own managed startup. Remote pairing, plugin
runtime packaging, Office previews, desktop, TUI, and GUI changes need no Varro adaptation.

The tested v2 client is `2.0.25`; v1 remains current at `1.18.35`.
Support floors remain v2 `2.0.5` and v1 `1.16.0`. The unchanged v1 SDK does not require a new
Docker support-range run. External credential coverage uses deterministic adapter and dialog
fixtures; live Azure/AWS accounts were not used.

All 851 focused adapter, provider-dialog, credential-store, startup/server, state, and transport
unit tests passed. Lint, lint check, formatting, both TypeScript checks, and the build passed.
The isolated VS Code `v2-first-run` scenario passed against the published 2.0.25 CLI, including
activation, managed ownership, health, and event-stream connection.

The released-server matrix passed 122 checks, failed five, and skipped 25 platform- or
family-specific checks. All 36 applicable checks passed on v2.0.25, with two skips.
The five shared compatibility unit tests passed after the matrix finished.

| Scope | Tested behavior | Issues found | All cases complete |
| --- | --- | --- | --- |
| v2.0.25 | 36 passed, 2 skipped | None found | Yes, all applicable automated checks |
| v1.16.0 and v1.18.35 | 27 passed, 1 failed, 10 skipped each | Follower authentication after owner replacement | No, later recovery phases were not reached |
| v2.0.5 | 32 passed, 3 failed, 3 skipped | Replacement ownership, reboot recovery, multi-window ownership | No, later recovery phases were not reached |

These are previously documented recovery failure signatures, not new HTTP-contract changes:

- Both v1 releases restart the owner successfully but leave the follower in an authentication
  error instead of quietly reattaching. This blocks that window's conversation access.
  Inspect follower credential refresh and lease-generation ordering, then rerun killed-server
  and owner-restart recovery. Evidence is in `artifacts/ai-test-data/multi-window-AwRdmo/failure.json`
  and `artifacts/ai-test-data/multi-window-qkwy07/failure.json`.
- V2.0.5 replacement recovery reports `unmanaged` instead of `current-host`; multi-window
  recovery reports `unmanaged` instead of `other-host`. Healthy event streams reconnect, but
  managed lifecycle operations lose their ownership identity. Inspect authenticated floor-endpoint
  fallback and credential-backed registration identity checks. Evidence is in
  `artifacts/ai-test-data/startup-uIMYF0/failure.json` and
  `artifacts/ai-test-data/multi-window-RNd6kM/failure.json`.
- V2.0.5 simulated reboot recovery fails its healthy-start assertion. Capture the startup
  probe, lease identity, and credential-restoration phases before changing recovery logic.
  Evidence is in `artifacts/ai-test-data/startup-wuXBnK/failure.json`.

Complete matrix logs are under `artifacts/opencode-adapters/run-ZrPK6E/`.
Live Azure/AWS sign-in and full visual streaming performance remain unverified by this bump.

### 1.18.35 compatibility review

Reviewed v1.18.34 to v1.18.35, `82ea3a3a63` through `63be8f95d8`.
The complete release diff leaves public HTTP routes, SSE names and payloads,
generated SDK declarations, configuration, permissions, questions, session/message
records, and managed startup contracts consumed by Varro unchanged. No adapter
changes are required.

Runtime changes update xAI to support images in tool results and omit image formats
that xAI rejects, while retaining PNG, JPEG, and WebP. The GitLab provider is updated
to 6.19.0. Console, stats, marketing, and CI changes do not require Varro adaptations.

The tested v1 SDK is `1.18.35`; the v2 client remains at the latest published
`2.0.24`. Support floors remain v1 `1.16.0` and v2 `2.0.5`.

The Docker support-range run passed required checks on all 14 releases, including
38/38 on 1.18.35 and 37/37 on the 1.16.0 floor. The floor and the below-floor
1.15.13 probe each failed the advisory MCP pagination check. The run regenerated
`scripts/opencode-compatibility/verified.json`; all five shared compatibility
tests passed afterward.

The adapter matrix passed 27 checks on each v1 release, 31 on v2.0.5, and 35 on
v2.0.24, but did not pass overall:

- V1.16.0 and v1.18.35 each failed multi-window recovery after the owned server
  was killed. The follower reported an authentication failure. Inspect follower
  credential refresh during owner replacement. Evidence is in
  `artifacts/ai-test-data/multi-window-hTeu9Q/` and
  `artifacts/ai-test-data/multi-window-xddJOr/`.
- V2.0.5 failed replacement ownership, simulated reboot recovery, multi-window
  ownership, and stalled-turn steering. Inspect lease identity and startup recovery
  using `artifacts/ai-test-data/startup-Us9AGF/`,
  `artifacts/ai-test-data/startup-zy3zNm/`, and
  `artifacts/ai-test-data/multi-window-Tpq1Ph/`. Trace inbox admission for the
  steering failure, which admitted three user messages instead of two.
- V2.0.24 failed multi-window ownership after the owned server was killed,
  reporting `unmanaged` instead of `other-host`. Inspect replacement registration
  and lease identity using `artifacts/ai-test-data/multi-window-dMovpF/`.

These results do not establish whether the failures are regressions from the
v1 SDK bump. Later recovery phases were not reached after the early failures.
Complete logs are under `artifacts/opencode-adapters/run-F6e4nj/`.

### 2.0.24 compatibility review

Reviewed v2.0.23 to v2.0.24, `9e96aacd64` through `bd55d4895f`.
Public HTTP routes, generated request clients, protocol/schema declarations,
SSE names and payloads, session/message records, permissions, and forms consumed
by Varro are unchanged. The client shares service-probe and startup-attempt
bookkeeping between its Promise and Effect implementations; Varro owns its
transport and managed startup and does not call those helpers. No adapter changes
are required.

Runtime changes harden portable Bash and PowerShell permission scanning, stop
instruction discovery at case-variant Windows project roots, preserve subagent
text-block boundaries, report MCP OAuth token-exchange failures in the callback,
and filter non-text models from the catalog and default selection. Provider
updates add native Vercel AI Gateway routing, GitLab Duo reasoning variants,
Azure completions-shaped routing, and AI SDK v6 provider installation defaults.
ChatGPT subscription discovery temporarily uses a bundled model allowlist instead
of its remote model catalog; legacy OpenAI OAuth methods are relabeled Codex.
These changes need no Varro adaptation. ACP, GUI, TUI, and styling changes are
optional parity work.

The tested v2 client is `2.0.24`; v1 remains at `1.18.34`.
Support floors remain v2 `2.0.5` and v1 `1.16.0`.
The unchanged v1 SDK does not require a new Docker support-range run.

The adapter matrix passed 23 checks on each v1 release, 28 on v2.0.5, and
29 on v2.0.24. Each release failed one check:

- Both unchanged v1 releases fail multi-window recovery after the owned server is
  killed. The owner restarts successfully, but the follower reports an authentication
  failure instead of quietly reattaching. No consent prompt appears. Inspect follower
  credential refresh and lease-generation ordering during owner replacement; rerun
  the multi-window check after a targeted fix. Evidence is in
  `artifacts/ai-test-data/multi-window-FwdPwL/failure.json` and
  `artifacts/ai-test-data/multi-window-kwTKTM/failure.json`. Later owner-restart and
  ownerless-recovery phases were not reached on v1.
- V2.0.5 retains the replacement-server ownership failure: healthy recovery reports
  `unmanaged` instead of `current-host`. Inspect authenticated floor-endpoint fallback
  and credential-backed registration identity checks. Evidence is in
  `artifacts/ai-test-data/startup-YU4yav/`.
- V2.0.24 passes all managed startup and multi-window recovery checks but retains
  the stalled-turn steering failure observed on v2.0.23: three user messages enter
  the transcript instead of two, admitting a queued prompt that should remain parked.
  Trace native inbox admission and resume ordering, then verify the queued item stays
  pending after steering resumes. This is the same previously recorded failure
  signature, not a new consumed-contract change.

The complete matrix logs are under `artifacts/opencode-adapters/run-AjZS5C/`.

The isolated VS Code `v2-first-run` startup scenario passed against the published
2.0.24 CLI, including activation, managed ownership, health, and event-stream connection.
All 197 focused adapter/auth/state and compatibility unit tests and 682
startup/server/admission/transport unit tests passed. Formatting, both TypeScript
checks, and the build passed. Lint and lint check passed with an existing `no-shadow`
warning in `e2e/tests/picker-opening.spec.ts`.
The five shared compatibility tests also passed after the adapter matrix finished.

### 2.0.23 compatibility review

Reviewed v2.0.22 to v2.0.23, `d259ae7163` through `9e96aacd64`.
The API adds optional persistent-terminal capabilities to server info, a VCS
initialization route, and structured `LocationNotFoundError` 404 responses for
missing workspace directories. Existing successful HTTP responses, consumed
SSE payloads, session/message records, permissions, and forms remain compatible.
Removed legacy question declarations and the session-event attachment re-export
are not consumed by Varro. No adapter changes are required.

Runtime changes improve shared-service startup/replacement and terminal handoff,
Homebrew update selection, Windows installer shell selection, formatter config
merging, skill invocation controls, and transient MCP connection/catalog retries.
Summary compaction now honors its configured agent model. Native Cohere, Venice,
and Google Interactions providers and refreshed model metadata need no Varro
adaptation. ACP and GUI extension changes are optional parity work.

The tested v2 client is `2.0.23`; v1 remains at `1.18.34`.
Support floors remain v2 `2.0.5` and v1 `1.16.0`.
The unchanged v1 SDK does not require a new Docker support-range run.

The adapter matrix passed 23 checks on each v1 release, 27 on v2.0.5, and
28 on v2.0.23. V2.0.5 retains the replacement-server ownership failure,
reporting `unmanaged` instead of `current-host`. V2.0.23 passes all three
managed startup scenarios, including replacement recovery, but retains the
stalled-turn steering failure: three user messages enter the transcript instead
of two, admitting a queued prompt that should remain parked. These failure
signatures were already observed in the previous release review. Capture
credential restoration and registration-selection diagnostics for the floor
ownership issue; trace native inbox admission and resume ordering for steering.
The complete matrix logs are under `artifacts/opencode-adapters/run-tQO2du/`.
Focused steering reruns reproduced the same failure on both v2.0.22 and
v2.0.23. Their logs are `artifacts/opencode-2.0.22-steering.log` and
`artifacts/opencode-2.0.23-steering.log`; the bump introduces no new failure
signature in this check.
All 126 focused adapter unit tests and five shared compatibility tests passed.
Lint, formatting, both TypeScript checks, and the build passed.

### 2.0.22 compatibility review

Reviewed v2.0.21 to v2.0.22, `dd2af0e5fc` through `d259ae7163`.
Session creation adds an optional native `parentID` and a missing-parent 404.
Varro retains local parent annotations across its supported v2 range; adopting
native child creation is optional parity work. Provider configuration now accepts
partial model capabilities and `headerTimeout`/`chunkTimeout` values of `false`.
Worktree errors add `_tag` while retaining `name` and `data`. The removed
`ide.installed` event was unused. Existing HTTP routes, consumed SSE payloads,
session/message records, permissions, forms, service discovery, and managed
`serve` startup remain compatible. No adapter changes are required.

Runtime updates default provider header and chunk timeouts to five minutes and
cap automatic timeout retries at three. Azure deployment discovery, Alibaba and
DigitalOcean prompt caching, Bedrock tool images, Claude capability defaults,
MCP disconnection diagnostics, and provider rejection details improve without
changing Varro's integration. CLI upgrade locking and periodic TUI update checks,
ACP forms/workspace support, and the GUI extension refactor require no adaptation.

The tested v2 client is `2.0.22`; v1 remains at `1.18.34`.
Support floors remain v2 `2.0.5` and v1 `1.16.0`.

The adapter matrix passed 23 checks on each v1 release and 27 on each v2 release.
V2.0.5 retained its replacement-server ownership failure, reporting `unmanaged`
instead of `current-host`. V2.0.22 failed replacement-server recovery with a
30-second health timeout and the stalled-turn steering check with three admitted
user messages instead of two. A full v2.0.22 rerun passed the steering check but
retained the startup failure; focused reruns reproduced both failures against
both v2.0.22 and the previous v2.0.21 CLI. These are not specific to this release
bump, but they remain unresolved compatibility issues. For startup, capture
credential restoration, registration selection, and health-probe phase logs;
for steering, trace native inbox admission and resume ordering before changing
the adapter. Logs are retained under `artifacts/opencode-release-review/`.
The five focused compatibility unit tests passed. The unchanged v1 SDK does not
require a new Docker support-range run.

### 2.0.21 and 1.18.34 compatibility review

Reviewed v2.0.20 to v2.0.21, `8d8a7bc844` through `dd2af0e5fc`, and
v1.18.33 to v1.18.34, `90e65205f6` through `82ea3a3a63`.
V2 adds an optional cancellation message to the form DELETE query and cancelled
form state. Omitting it retains the existing question-dismissal behavior.
HTTP routes, SSE names and payloads, session/message records, permissions,
configuration, and managed `serve`/upgrade behavior consumed by Varro remain
compatible. V1's SDK and HTTP contracts are unchanged. No adapter changes are
required.

Both families add namespaced session identity headers to provider requests.
V2 also fixes ancestor-instruction duplication, OpenRouter cache breakpoints,
Cloudflare AI Gateway native routing, context-overflow classification, and
forward-compatible GPT/GLM capability defaults. Browser tools now require an
attached desktop browser; plugin session removal and non-interactive question
feedback do not change Varro's HTTP integration. V1 adds macOS CLI signing and
fixes Windows plugin-name display. ACP, browser comments, read grouping,
session links, Console, stats, and styling changes require no Varro adaptation.

The tested v2 client is `2.0.21`; the tested v1 SDK is `1.18.34`.
Support floors remain v2 `2.0.5` and v1 `1.16.0`.

The replacement-server startup fixture now probes `/api/status` on v2.0.5;
its previous `/api/info` readiness check could never succeed on that release.
Ordinary production health fallback already supports both endpoints. The rerun
exposed a separate v2.0.5 ownership-recovery failure: the replacement attaches as
`unmanaged` instead of `current-host`. Credential-backed replacement recovery
still probes only `/api/info`; supporting `/api/status` there needs a targeted
follow-up that preserves its identity and authentication checks.

V2.0.5 also failed the stalled-turn steering test because three user messages
entered the transcript instead of two after steering resumed. Diagnose its inbox
admission/resume behavior before changing the adapter. Both cases pass on
v2.0.21. The floor remains unchanged, but this run is not a full v2.0.5
compatibility pass.

The v1 Docker matrix passed all 519 required checks across 14 releases, including
43/43 on 1.18.34. Of 78 advisory checks, 76 passed; 1.16.0 and the below-floor
1.15.13 probe retain the MCP pagination caveat. The regenerated verification
summary and all five focused compatibility unit tests passed.

### 2.0.20 compatibility review

Reviewed v2.0.19 to v2.0.20, `f02c30eb55` through `8d8a7bc844`.
The API adds credential list/create routes, optional connection authentication
status, and optional provider response bodies on structured errors. Existing
HTTP routes, SSE names, session/message records, forms, and configuration keys
consumed by Varro remain compatible. Varro already reads diagnostic messages
and refreshes catalogs on integration updates. No adapter changes are required.

Runtime changes add ChatGPT token-sharing authentication, improve Console SSO
and expired-credential diagnostics, restrict database file permissions, and
apply rejection feedback to parallel permission requests. Provider updates
cover cache controls, Bedrock thinking signatures, Mistral reasoning streaming,
and Cloudflare Workers AI variants. CLI credential import/export and optional
shared-service disabling do not change Varro's managed `serve` startup.
Dedicated connection-status UI and token-sharing dialogs are optional parity work.

The tested v2 client is `2.0.20`; v1 remains at `1.18.33`.
Support floors remain v2 `2.0.5` and v1 `1.16.0`.

### 2.0.19 compatibility review

Reviewed v2.0.18 to v2.0.19, `39021dfd67` through `f02c30eb55`.
The client, protocol, schema, HTTP routes, and SSE contracts are unchanged.
Session/message records, permissions, forms, and configuration keys consumed by
Varro remain compatible. No adapter changes are required.

Compaction now sizes requests against the model window and retries oversized
requests with shorter history. Native compaction no longer falls back to a local
summary. The default buffer becomes 10% of the window, with a 16,000-token minimum
for windows of at least 32,000 tokens; explicit buffer settings still apply.
Provider updates improve cache affinity for child and forked sessions, Gemini
tool-call replay, Cloudflare configuration, and xAI reasoning variants. Shell
tools receive agent and session environment variables. CLI authentication, TUI,
and AI media changes require no Varro adaptation.

The tested v2 client is `2.0.19`; v1 remains at `1.18.33`.
Support floors remain v2 `2.0.5` and v1 `1.16.0`.

### 1.18.33 compatibility review

Reviewed v1.18.32 to v1.18.33, `fe3f3a41f7` through `90e65205f6`.
The SDK, HTTP routes, SSE events, session/message records, and permission/question
contracts are unchanged. No Varro adapter changes are required.

Runtime updates add GPT-6 Sol and Luna to Codex model selection, adjust Gemini
and Gemma reasoning variants, apply provider timeouts to Cloudflare AI Gateway,
and update the GitLab provider. Browser launches now accept only HTTP and HTTPS
URLs, MCP browser-launch failures are detected on Windows, and `debug config`
redacts credentials. Varro reads configuration through the HTTP API, which is
unchanged. Console, stats, TUI, and documentation changes require no adaptation.

The tested v1 SDK is `1.18.33`; the latest v2 client remains `2.0.18`.
Support floors remain v1 `1.16.0` and v2 `2.0.5`.

The v1 Docker matrix passed all 524 required checks across 14 releases, including
43/43 on 1.18.33. Of 78 advisory checks, 76 passed; 1.16.0 and the below-floor
1.15.13 probe retain the MCP pagination caveat. The regenerated verification
summary and all five focused compatibility unit tests passed.

### 2.0.18 compatibility review

Reviewed v2.0.16 to v2.0.18, `ac2426e103` through `39021dfd67`.
The client and protocol add pairing endpoints, and shell records gain an optional
`signal` field. Existing Basic authentication remains supported; unauthorized
responses now include a structured error body. Varro checks HTTP status codes and
requires no transport or adapter changes for these additions.

Session, message, permission, form, configuration, and SSE contracts consumed by
Varro remain compatible. The runtime now flushes pending text and reasoning deltas
before subsequent block starts, restores legacy media compaction checkpoints,
updates provider variants and model metadata, and improves shell output notices.
New pairing UI, TUI queue controls, and AI media APIs require no Varro adaptation.
The tested v2 client is `2.0.18`; v1 remains at `1.18.32`, with support floors
unchanged at v2 `2.0.5` and v1 `1.16.0`.

### 2.0.15 compatibility review

Reviewed v2.0.14 to v2.0.15, `8864eb507e` through `a25d304201`.
The API adds optional metadata to session updates, the `session.metadata.updated`
event, and project `time.active`. These additions require no adapter change.
Varro continues to store its metadata overrides locally across the supported v2 range;
adopting native metadata updates is separate compatibility work for older servers.

The Promise client now preserves base URL path prefixes and throws declared API
errors as `Error` instances. Varro uses its own HTTP transport and the unchanged
client service-discovery API. Existing HTTP routes, SSE envelopes, transcript records,
configuration, model catalogs, and permission/form contracts remain compatible.

Runtime changes normalize AI SDK text and reasoning boundaries, fix Kimi reasoning
replay and bare-null provider SSE frames, simplify shell output notices, and improve
Windows CLI upgrades. The AI package's media and video-generation APIs, CodeMode
language additions, and upstream app/TUI changes require no Varro adaptation.
V1's latest published CLI and SDK remain `1.18.32`; support floors remain v2 `2.0.5`
and v1 `1.16.0`.

### 2.0.14 and 1.18.32 compatibility review

Reviewed v2.0.12 to v2.0.13, `6f655dcbab` through `be4e5a6d06`.
The 2.0.13 API adds `method: "key" | "oauth"` to credential connection
records. Varro reads their type and ID and accepts the additional field. HTTP
routes, SSE envelopes, session/message records, and permission/form contracts
consumed by Varro require no adaptation.

V2 also updates server-side Console policy enforcement, AI SDK HTTP hooks,
subagent prompt-cache affinity, MCP OAuth behavior, and CLI upgrade diagnostics.
The web-shell authentication change retains authentication on API routes.
Desktop pairing, provider sign-in presentation, and TUI tabs
do not require changes to Varro's adapters.

Reviewed v2.0.13 to v2.0.14, `be4e5a6d06` through `8864eb507e`.
Client, protocol, schema, server, and CLI source contracts are unchanged.
The release refreshes model metadata, fixes desktop IPC serialization and the
TUI project list, and adds Console API documentation. No adapter change is required.

Reviewed v1.18.31 to v1.18.32, `a74c472ffb` through `fe3f3a41f7`. The SDK and
HTTP contracts are unchanged. Runtime fixes cover Bedrock tool-result image
support, Node package resolution, and filesystem search imports. The runtime
support floors remain v2 `2.0.5` and v1 `1.16.0`.

The v1 Docker matrix passed all 524 required checks across 14 releases, including
43/43 on 1.18.32. Of 78 advisory checks, 76 passed; 1.16.0 and the below-floor
1.15.13 probe still have the MCP pagination caveat. No required-check failure
boundary was found, and the declared support floor is unchanged.

### 2.0.12 compatibility review

Reviewed v2.0.11 to v2.0.12, `991b727eb8` through `6f655dcbab`, and the preceding
v2.0.10 to v2.0.11 range to catch up the implementation notes. The client, protocol, schema,
and server packages change only their version numbers across these releases. The HTTP routes,
SSE envelopes, configuration shapes, and session/message, permission, and form contracts
consumed by Varro are unchanged. No adapter change is required.

Upstream restores Anthropic thinking-budget variants, refreshes model metadata, forwards
Promise-tool cancellation, and reports fatal CLI startup causes on stderr. Varro already
preserves the server's variants and reads both startup output streams. The preceding release
also fixes provider WebSocket fallback and error decoding, honors session permissions during
skill and MCP discovery, and adds Vite+ installation support to the CLI updater. These changes
run in OpenCode and use Varro's existing integration.

Rich artifact tabs and browser previews, desktop startup optimizations, and TUI presentation
changes are optional UI parity work. V1's latest published CLI and SDK remain at `1.18.31`.
The runtime support floors remain v2 `2.0.5` and v1 `1.16.0`.

### 2.0.10 compatibility review

Configured model prices now use the same normalization as native catalog prices, including
single-price objects, tier arrays, and omitted cache rates. Partial configured limits preserve
resolved limits instead of replacing them. The adapter bootstrap check verifies that config-only
providers remain available for model selection; the `connected` list represents integration
connections and is not an availability check. Published-server fixtures also verify configured
model prices and limits.

Reviewed the v2.0.8 to v2.0.10 release range, `c076066c33` through `cb6d95b7ef`.
The HTTP routes, session/message contracts, permission/form contracts, and SSE envelopes used by
Varro are unchanged. Provider transport and compaction policies move into `settings`; compaction
now uses `{ type: "summary" }` or `{ type: "native" }`. Varro already preserves model settings and
does not consume the removed top-level policy fields, so no adapter change is required. Other
changes include tool-input repair, bounded completed-job retention, client service polling, and
Homebrew CLI updates. V1's latest published CLI and SDK remain at `1.18.31`.

### 2.0.8 compatibility review

The v2.0.7 to v2.0.8 release diff does not change the HTTP routes, event payloads,
permissions and questions, or session, message, and part contracts consumed by Varro. Its generated
client change expands an experimental configuration policy action, while its other client and core
changes affect upstream UI tool reconciliation and attachment error labels. No Varro adapter change is
required.

### 2.0.7 compatibility fixes

- Default-mode sends preserve session-scoped Always approvals. V2 replaces session permission rules,
  so the previous pre-send empty-rule update erased saved allowances. Explicit mode changes still
  apply their rule updates. The released permission engine does honor session rules; the older
  `tmp/opencode` checkout did not represent that released behavior.
- V2's `The user declined this tool call` error uses Varro's permission-rejected presentation and
  remains outside compact completed-work groups.
- Step-start events use the 2.0.7 `started` timestamp for provider-request timing, with the event
  timestamp as a fallback for older releases.
- Hidden authentication fields are omitted from interactive prompts and their defaults are submitted
  unless the caller supplies a value. Inactive conditional defaults remain omitted.

The v2.0.6 to v2.0.7 release diff also adds permission policy enforcement, waits for plugin activation
before listing integrations, and removes server-side update polling. These use existing Varro APIs.
The new experimental filesystem-write route and ACP/UI changes do not require adapter changes.

V2.0.7 still interrupts a turn when a tool permission is rejected or a question is skipped. Its config
normalizer explicitly drops v1's `experimental.continue_loop_on_deny` option. Varro preserves that
server outcome. The earlier v1 immediate-rename overwrite remains a server-title-generation race
observation, not a verified Varro regression. Neither behavior is changed by this compatibility patch.
The earlier AI-07 attempts exhausted the running-tool window during smooth return; all six reached
the bottom afterward. This was incomplete live coverage, not an observed stuck-scroll defect or a
backend compatibility failure. AI-08 was not executed because its AI-07 prerequisite did not pass.
The controller now distinguishes a late successful return from failure to reach the bottom, and
`scroll-return-tool-completion.spec.ts` checks tool completion during native return at 540 and 1,768 px.
These browser regressions do not certify the separate full real-editor visual/performance suite.

## Importing v1 conversations into v2

After switching from v1 to v2, the session list can still show conversations loaded from v1. Opening one of them loads it from v2. If v2 reports that the session was not found, Varro imports a copy automatically. The conversation must belong to an open workspace folder. Varro reads a consistent, read-only snapshot and imports a separate conversation titled `<original title> (v1 copy)`.

The copy receives new session and message IDs. Same-workspace child sessions and their references are copied together. Text, reasoning, completed tool results, model identities, and embedded image attachments are converted to v2 history. Original message records and session metadata are retained in import metadata, including v1-only parts. External attachment references remain references. Unfinished historical tools become interrupted results rather than active operations. Import does not execute recorded tools or start a model request; the user can send a new message after the copy opens. New copies use the destination server's permission defaults.

The source v1 sessions, timestamps, and messages remain unchanged. The importer uses `OPENCODE_DB` when configured, otherwise the standard local OpenCode database. Reads are bounded to 32 MiB, 100 sessions, 10,000 messages per session, and 100,000 parts per session. A failed multi-session import removes its successfully created copies and reports any cleanup failure.

Real VS Code verification on OpenCode 2.0.6 now covers creating and reopening conversations, full window reload, recycle/restore/permanent deletion, stale-catalog 404 recovery, importing a v1 parent and child, continuing the imported conversation, and reopening/reloading that copy. The fixture verifies that importing causes no provider requests and that original v1 rows remain identical. Run with:

```sh
VARRO_OPENCODE_TEST_BINARY=/absolute/path/to/opencode2 npm run test:compatibility:ui
```

V2 omits the legacy session `version` property; Varro supplies the protocol-family marker for its recycle-bin snapshots. Without that normalization, valid v2 sessions failed the snapshot validator and deletion misleadingly reported `404 Session not found`.

## Historical research

The remaining sections record the original startup investigation and implementation plan. They describe the pre-adapter failure and design requirements, not current limitations unless repeated in the implementation notes above.

### Findings

- The installed `/Users/andrew/.bun/bin/opencode2` reports `opencode v2.0.6`.
- Published `@opencode/cli` and `@opencode/client` report `2.0.6`.
- Published `opencode-ai` and `@opencode-ai/sdk` still report `1.18.31`.
- The [migration guide](https://opencode.ai/v2/docs/migrate-v1/) explicitly identifies the server API as a breaking change. Supported v1 configuration remains accepted, but this does not promise v1 HTTP compatibility.
- `tmp/opencode` was clean and current on upstream `dev`, commit `5a8335857b0ebec44ef6aa1d52b339cf25c329ca`. Its CLI and protocol can differ from the released binary. Treat those sources as architectural references, not the released contract.
- The 2.0.6 API uses `/api/info`; Varro also probes the 2.0.5 `/api/status` endpoint to preserve the supported v2 floor.

### Reproduced startup failure on v2.0.5

An isolated copy of the installed binary was launched with a fresh HOME, XDG directories, explicit database path, empty workspace, and ephemeral loopback port. The probe performed HTTP GETs and opened an event subscription. It did not use production sessions or provider credentials.

| Request | Without credentials | With the generated Basic credentials |
| --- | --- | --- |
| `/global/health` | 401 | 200, web-app HTML |
| `/api/status` | 401 | 200, JSON with version, PID, URLs |
| `/api/info` | 401 | 404 |
| `/api/health` | 401 | 404 |
| `/agent` | 401 | 200, web-app HTML |
| `/api/agent` | 401 | 200, `{ location, data }` |
| `/session` | 401 | 200, web-app HTML |
| `/api/session` | 401 | 200, `{ data, cursor }` |
| `/global/event` | Not probed | 200, web-app HTML |
| `/api/event` | Not probed | SSE containing `{ id, type: "server.connected", data: {} }` |

The authenticated `/openapi.json` lists 111 paths. The local evidence is in `tmp/v2-api-probe-q0M2WV/results.json` and `tmp/v2-api-probe-q0M2WV/openapi.json`; the reproducible probe is `tmp/opencode-v2-probe.mjs` and uses the installed binary's absolute path.

Before the adapters, Varro sent unauthenticated health, REST, and SSE requests in `src/extension/open-code-transport.ts`. `src/shared/opencode-endpoints.ts` selected `/global/health` and `/global/event`. The health loop in `src/extension/server.ts` collapsed failed probes into a timeout even though the server had started successfully.

Credentials alone will not fix the integration. The released server does not supply the tested v1 contracts. HTTP 200 alone is especially misleading because unknown non-API routes serve HTML.

### Required compatibility design

Keep one Varro UI and two extension-host protocol adapters. Select the adapter once per server connection and normalize both protocols into Varro-owned data and events before they reach session state, event batching, and the webview.

1. Preserve the existing v1 support floor of 1.16.0 and its test coverage. Add a separately recorded v2 tested range. A single `version >= 1.16.0` comparison cannot establish protocol support.
2. Respect `varro.server.command`, including custom binary names. Detect the CLI family for launch preparation, then validate the actual running server's identity and response schema. An existing server can differ from the configured CLI.
3. For managed v2 launches, acquire the generated credential before authenticated probes. The released binary prints it during startup. If using that channel, buffer across stdout chunks and redact before any logging, diagnostic retention, or error formatting. Verify the supported credential-discovery mechanism separately for adopted and externally managed servers. Do not assume the current dev branch's `service password` command exists in 2.0.5.
4. Authenticate health, ordinary requests, and SSE consistently. Keep credentials in the extension host and bind them to the server identity. Preserve credentials across legitimate ownership handoff and reconnect without forwarding them to the webview or unrelated origins.
5. Distinguish authentication failure, unsupported API, malformed response, process exit, and timeout. Validate JSON schemas and SSE content types rather than accepting successful HTTP status alone.
6. Use `@opencode/client` for v2 contract types and evaluate its generated client against Varro's cancellation, byte limits, directory scoping, and stream handling before adopting its runtime. Updating `@opencode-ai/sdk` alone does not add released v2 support.

The adapter should expose semantic operations where contracts differ. Avoid growing a global string-replacement table for v1 paths. `OpenCodeServer.request()` is a useful transition boundary, but some operations need multiple calls and stateful projections.

### Contract work

| Area | Required adaptation |
| --- | --- |
| Startup | v1 health versus released v2 `/api/status`; authentication and server ownership |
| Sessions | Unwrap v2 `data`, resolve `location`, preserve metadata and ancestry, translate body cursors into Varro pagination |
| Messages | Project the v2 discriminated message union into stable Varro transcript identities; v1 `{ info, parts }` assumptions do not directly apply |
| Prompt submission | v1 `prompt_async` and parts versus v2 `prompt` with text and attachments; account for separate agent/model switching and durable inbox admission |
| Queuing | Preserve Varro queue behavior while explicitly choosing v2 delivery semantics; distinguish admitted input from a visible user message and active execution |
| Streaming | Decode `/api/event` native envelopes and project incremental changes into the same state model used for history; verify replay, ordering, deduplication, and snapshot reconciliation |
| Stop and compaction | Map v1 abort/summarize behavior to v2 interrupt/compact semantics |
| Fork and revert | Preserve boundaries and ancestry across v2 fork and staged/committed revert operations |
| Permissions | Map action/resource/effect rules and session-owned reply routes; the released request uses `decision`, and successful replies return 204 |
| Questions | Adapt v2 session forms, pending snapshots, replies, and cancellation |
| Models and authentication | Separate v2 model/provider catalogs and integration/credential flows; normalize model capabilities, variants, and prices |
| Workspace services | Audit MCP, files, VCS, commands, skills, and config read/write contracts individually |
| Updates | Detect the installed package family; v2 must not use the hard-coded `opencode-ai` update target |

Primary Varro integration points are `src/extension/open-code-process.ts`, `src/extension/open-code-transport.ts`, `src/extension/server.ts`, `src/extension/rest-proxy.ts`, `src/extension/server-event-bridge.ts`, and the shared protocol, compatibility, and install modules. Hidden helper sessions, automatic permission judging, exports, trash, and model-selection persistence also consume server behavior and need coverage.

### Backward compatibility requirements

- Users keep the same Varro interface and settings when choosing either supported CLI family. No manual API-version switch should be necessary.
- Keep version-specific behavior in the host adapters. Shared UI code consumes normalized models and declared capabilities.
- Preserve stable message/part IDs across history loading, live updates, reconnects, and pagination. Follow `docs/message-list-virtualization.md`.
- Preserve Default, Auto, and Full access semantics. A pending permission retains an actionable fallback until server acknowledgement or authoritative reconciliation. Follow `docs/permission-lifecycle.md`.
- Continue accepting supported v1-format configuration. Do not rewrite shared user config to native-v2-only shapes as part of connection setup.
- API compatibility does not imply shared database compatibility. Verify v1 history visibility and v2 migration using imported copies, preserving original data. Never claim that switching binaries provides bidirectional session synchronization without evidence.
- Missing backend features must be represented explicitly rather than returning fake success or silently dropping operations. The migration guide says v2 does not run LSP services, for example; editor-supplied diagnostics should be assessed separately.

### Implementation and verification order

1. Add connection identity, authentication, adapter selection, and precise startup errors. Cover v1, v2, HTML fallback, 401, restart, existing-server attachment, and ownership handoff.
2. Normalize discovery, sessions, messages, and pagination. Run the same Varro-facing contract assertions against both real backends.
3. Implement prompt admission, streaming, tool states, interruption, child sessions, and reconnect recovery. Check stable identity and visible scroll anchors.
4. Implement permissions/forms, configuration, provider authentication, MCP, fork/revert, helper sessions, and other consumed operations. Test acknowledgement and failure behavior, not just route existence.
5. Extend `scripts/opencode-compatibility` to install both CLI package families and record separate support ranges. Its current probe targets `opencode-ai`, unauthenticated requests, and v1 response contracts.
6. Verify full chat and tool flows in isolated real VS Code hosts for both families. Include v1-to-v2 and v2-to-v1 binary selection, reload, server restart, histories, and pending approvals.

The original read-only probe established the startup incompatibility. The adapter and editor checks above now cover the implemented flows. Migration of production data and full visual streaming/replay performance have not been tested by this work.
