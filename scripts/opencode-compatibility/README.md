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
