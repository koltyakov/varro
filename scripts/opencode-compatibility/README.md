# OpenCode compatibility testing

This harness installs published `opencode-ai` versions into isolated Docker images and probes the real server APIs used by Varro. It does not infer compatibility from SDK or CLI version numbers.

The probe covers server health, wrapped `/global/event` SSE payloads, bootstrap reads, config precedence, permission/question queues, provider and workspace discovery, and session create/read/update/history/todo/diff/prompt/fork/revert/unrevert/abort/delete operations. It also connects and disconnects a deterministic local MCP fixture, emits and verifies an MCP tool-list change event, and confirms paginated MCP tool discovery. Permission reply and question reply/reject routes use syntactically valid synthetic missing request IDs so the probe stays unauthenticated and does not depend on timing a real queued request. A successful reply must return the documented JSON boolean result. A route-specific missing-request response proves the route contract; an ambiguous `400` is recorded as advisory without changing compatibility. Generic 404/405/server errors and malformed successful responses fail compatibility because they do not prove the production route contract. Prompt admission uses `noReply`, so it records a user message without making a provider request or requiring credentials. The harness still avoids authentication and upgrades.

Run the automated floor check:

```sh
npm run test:compatibility
```

Scan a smaller release window without enforcing the source constant:

```sh
npm run compatibility:discover -- --count 8 --keep-images
```

Test explicit releases:

```sh
npm run compatibility:discover -- --versions 1.17.18,1.17.17,1.17.16
```

The detected floor is the oldest release in the newest contiguous required-check-compatible range when the sampled window contains an incompatible release. The declared floor is a support policy and may intentionally be newer than the oldest technically compatible release. Floor-check mode requires every sampled release from the declared floor through the declared ceiling to pass, and also samples the floor's immediate predecessor for discovery. Deep MCP lifecycle checks are required for the declared ceiling and advisory for historical samples; advisory failures are reported as compatibility caveats so release-specific MCP regressions remain visible without making a repaired historical hole redefine the supported API range.

The report also records and explicitly probes the OpenCode version declared by `@opencode-ai/sdk` in Varro's `package.json`. A successful floor check updates the tracked `verified.json` summary, and unit tests reject a manifest ceiling change until that release has passed the real Docker probe. This version records test coverage only. It does not cap runtime support or background updates.

## Dual-version adapter tests

```sh
npm run test:compatibility:adapters
```

This separate matrix installs the declared v1 floor, tested v1 SDK version, and tested v2 client version using their matching CLI packages. It exercises Varro's production transport, adapters, and process manager against real isolated servers. A local deterministic provider tests streaming and a read tool without external model credentials. V2 also gets real permission and form request/reply checks.

CLI installations and the generated verification report live under `artifacts/opencode-adapters/`. Each server gets a distinct database, configuration, state directory, and fixture repository under `artifacts/ai-test-data/`. The suite does not use production sessions. Native v2 form/permission cases are explicitly skipped for v1.

To test an existing binary directly:

```sh
VARRO_OPENCODE_TEST_BINARY=/absolute/path/to/opencode npm run test -- src/extension/opencode-v2.integration.test.ts src/extension/opencode-startup.integration.test.ts
```

## Real-editor v2 chat check

```sh
VARRO_OPENCODE_TEST_BINARY=/absolute/path/to/opencode2 npm run test:compatibility:ui
```

This launches a fresh VS Code development window and drives the actual Varro composer. It verifies a visible streamed reply, a visible failure before an assistant turn starts, an HTTP 401 with a Re-authenticate action, a subsequent reply from a working provider, reopening the transcript, and a complete window reload. Internal agent/model records must not become user bubbles.

The fixture uses local deterministic model endpoints and verifies that the server PID owns its separate database under `artifacts/ai-test-data/` before sending prompts. It deletes the sessions it created, checks cleanup, and closes its editor. Screenshots, native events, and the result are retained in the fixture directory. This command requires VS Code and POSIX `lsof`; use `VARRO_VSCODE_EXECUTABLE` to override the default macOS executable path.
