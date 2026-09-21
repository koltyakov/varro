# OpenCode v1 and v2 support

Research date: September 19, 2026. The implementation supports v1 from 1.16.0 and v2 from 2.0.5 through automatic extension-host adapters.

V2 is recommended for new installations; v1 remains supported. See the [usage guide](usage.md#choose-and-update-opencode) for installation, version selection, updates, and configuration compatibility. Current packages both install `opencode`. Varro also recognizes older or custom `opencode2` installations and prefers that name during automatic discovery.

## Implementation and verification

- `src/extension/opencode-connection.ts` detects protocol families and removes startup credentials before logging, including credentials split across process-output chunks.
- `open-code-process.ts` retains credentials in the private ownership lease for window handoff and reads registered local service credentials. CLI update lookup and recovery commands select the matching package family.
- `open-code-transport.ts` authenticates health, REST, and SSE requests and selects the adapter from validated server responses.
- `opencode-v2-adapter.ts`, `opencode-v2-projection.ts`, and `opencode-v2-events.ts` translate requests, transcript records, catalogs, permissions, forms, and events into the existing Varro contracts.
- `opencode-v2-session-state.ts` persists Varro-owned metadata and timestamp overrides that the released v2 API cannot patch. These annotations live under the user's XDG state directory in `varro/opencode-v2/`.
- Native v2 agent and permission configuration keys are preserved when Varro edits a file already using them. V1-format files retain their format.

Annotation updates and deletions share a per-session queue within each store instance. A failed
update does not block later deletion. Cancelled updates check their signal before reading, after
reading, and before replacing the annotation file, so cancellation while queued or preparing a write
does not commit that update.

`npm run test:compatibility:adapters` installs published binaries into isolated directories and tests the production adapters. Its latest matrix passed 54 checks across `opencode-ai@1.16.0`, `opencode-ai@1.18.31`, `@opencode/cli@2.0.5`, and `@opencode/cli@2.0.12`, with ten platform- or family-specific skips. The checks cover managed startup, credential recovery in a second window, restart, bootstrap, workspace path encoding, v2 configuration precedence, session updates, deterministic streamed model responses, actual fixture-only tool execution, message pagination, tail editing, helper generation, fork/revert, deletion, and native v2 permissions/forms. The generated report is `artifacts/opencode-adapters/verified.json`.

Fresh VS Code sandbox windows passed `v2-first-run` and the existing `healthy-first-run` scenario. These editor checks verify activation, ownership, health, and event-stream connection. `test:compatibility:ui` additionally exercises the actual composer, successful replies, pre-turn failures, HTTP 401 handling, recovery through a working provider, and reopening history. Full visual streaming performance remains a separate verification task.

V2 control records such as agent/model selection are excluded from the transcript while their selection context is preserved. A failed execution that never created an assistant turn gets a stable error row derived from the native failure record. Live errors retain the server's diagnostic message; reopened history without that live detail still shows the recorded failure. This prevents a provider authorization error from appearing as a silently unanswered prompt.

Run the v2 editor check after building:

```sh
VARRO_SANDBOX_V2_COMMAND=/absolute/path/to/opencode2 node scripts/vscode-sandbox/run.mjs v2-first-run
```

The editor profile is disposable, and its OpenCode database is isolated under `artifacts/ai-test-data/`.

The released v2 API has no session-sharing route or arbitrary single-message deletion. Varro disables sharing and implements inline-edit tail deletion through file-preserving staged revert and commit. V2 also has no LSP service. Metadata annotations are local to Varro; they are not synchronized to other OpenCode clients. Switching CLI families does not perform a data migration.

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
