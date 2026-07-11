# OpenCode compatibility testing

This harness installs published `opencode-ai` versions into isolated Docker images and probes the real server APIs used by Varro. It does not infer compatibility from SDK or CLI version numbers.

The probe covers server health, direct `/api/event` SSE payloads, bootstrap reads, config precedence, permission/question queues, provider and workspace discovery, and session create/read/update/history/todo/diff/prompt/fork/revert/unrevert/abort/delete operations. Permission/question reply routes use synthetic missing request IDs so the probe stays unauthenticated and does not depend on timing a real queued request. A successful reply must return the documented JSON boolean result. A route-specific missing-request response is advisory, and an ambiguous `400` is recorded as inconclusive without changing compatibility. Generic 404/405/server errors and malformed successful responses fail compatibility because they do not prove the production route contract. Prompt admission uses `noReply`, so it records a user message without making a provider request or requiring credentials. The harness still avoids authentication, upgrades, and MCP mutations.

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

The detected floor is the oldest release in the newest contiguous compatible range, with the immediately older tested release failing at least one required capability. Floor-check mode tests the newest release window plus the declared floor and its immediate predecessor, so the known boundary remains covered as new versions are published. If every sampled release passes, the result is deliberately reported as inconclusive and `--check-floor` fails; increase `--count` instead of guessing.

The report also records and explicitly probes `MAXIMUM_TESTED_OPENCODE_VERSION`. Varro may prompt for newer releases, but background updates do not cross that tested ceiling until the constant is advanced with a successful probe.
