# OpenCode compatibility testing

This harness installs published `opencode-ai` versions into isolated Docker images and probes the real server APIs used by Varro. It does not infer compatibility from SDK or CLI version numbers.

The probe covers server health, the `/api/event` SSE stream, bootstrap reads, permission/question queues, provider and workspace discovery, and session create/read/update/history/todo/diff/delete operations. It intentionally avoids prompts, authentication, upgrades, and MCP mutations because those require credentials or alter the tested installation.

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
